// Akbar API bookings: cancellation by staff in Admin, and refund / deposit tracking.
// Akbar's documents and what is still unconfirmed: packages/suppliers/src/akbar/cancellation.ts.
// The full workflow: docs/akbar-cancellation.md.
//
// Safety rules this file enforces:
//   - Nothing runs by itself. A cancellation is sent only when an admin (SUPER_ADMIN / TENANT_ADMIN)
//     confirms it, and only while "Live cancellation" is switched on in Admin (off by default).
//   - What is sent is exactly what the admin reviewed: RetrieveBooking is read again at submit, and the
//     request is refused if Akbar's booking (PNRs, passengers, tickets, TUI) changed since the review.
//   - One cancellation per Akbar transaction: claimed on the booking row in one conditional UPDATE, so two
//     clicks / two admins / a repeated request can never send two cancellations. The same request id
//     returns the first result.
//   - Never retried. A timeout, network error, HTTP error or a response code whose meaning Akbar has not
//     documented becomes MANUAL_VERIFICATION_REQUIRED: staff check Akbar's portal and record the answer.
//     Only Code 1903 ("Auto Cancellation Success", with a CancellationID, for the same transaction) is CANCELLED.
//   - Passengers: Akbar has not confirmed partial cancellation, so all passengers of the transaction must be
//     selected unless an admin explicitly allows partial cancellation. A selection is never widened.
//   - Cancelled ≠ refunded. The Akbar deposit refund (REFUND_PENDING → REFUNDED / REFUND_FAILED) is marked by
//     staff from Akbar's statement; the customer refund is a separate staff action using the existing refund
//     engine (lib/trips.ts settleRefund). Neither happens automatically.
//   - GetRefund may change state (not documented): it can only be called on the UAT account, when switched on.
//   - The original booking, payment, PNR and ticket data are never changed; only the booking status moves to
//     CANCELLED once every Akbar transaction of the booking is fully cancelled.
//   - Group fare / manual fare bookings are not Akbar API bookings and are never eligible.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, bookingAmendments, bookings } from "@zamrabooking/db/schema";
import {
  AKBAR_CANCEL_PATHS, AKBAR_CANCEL_PATH_DEFAULT, AKBAR_CANCEL_TYPE, AKBAR_IS_FULL_REFUND,
  akbarCallNotSent, akbarCancelPlan, akbarCancelResult, akbarGetRefundBody, akbarRefundDetails,
  type AkbarCancelPath, type AkbarCancelPlan, type AkbarCancelRequest, type AkbarRefundDetails,
} from "@zamrabooking/suppliers";
import type { Env, Variables } from "../types.js";
import { settleRefund } from "./trips.js";

type Db = Variables["db"];
type Booking = typeof bookings.$inferSelect;
type Amendment = typeof bookingAmendments.$inferSelect;

export const AKBAR_CANCELLATION = "AKBAR_CANCELLATION";

// ── Status model ──────────────────────────────────────────────────────────────
// Cancellation (booking_amendments.status):
export const CANCEL_STATUS = {
  REQUESTED:  "CANCELLATION_REQUESTED",        // confirmed by an admin, not sent to Akbar yet
  PROCESSING: "CANCELLATION_PROCESSING",       // being sent to Akbar right now
  CANCELLED:  "CANCELLED",                     // Akbar confirmed (Code 1903), or staff verified on Akbar's portal
  PENDING:    "CANCELLATION_PENDING",          // staff verified Akbar is still working on it
  FAILED:     "CANCELLATION_FAILED",           // certainly not cancelled (never sent / withdrawn / verified not cancelled)
  MANUAL:     "MANUAL_VERIFICATION_REQUIRED",  // outcome unknown: check Akbar's portal before doing anything else
} as const;
export type AkbarCancelStatus = (typeof CANCEL_STATUS)[keyof typeof CANCEL_STATUS];
// Akbar deposit refund (quote.supplierRefund.status), only once CANCELLED:
export type SupplierRefundStatus = "NOT_APPLICABLE" | "REFUND_PENDING" | "REFUNDED" | "REFUND_FAILED";
// Customer refund: booking_amendments.refundStatus — NOT_STARTED until staff start it, then the existing
// refund engine's PENDING → PROCESSING → DONE | FAILED | MANUAL_REQUIRED.
export const CUSTOMER_REFUND_NOT_STARTED = "NOT_STARTED";

// Every status except FAILED holds the transaction: no second cancellation can be requested.
const HOLDING: string[] = [CANCEL_STATUS.REQUESTED, CANCEL_STATUS.PROCESSING, CANCEL_STATUS.CANCELLED, CANCEL_STATUS.PENDING, CANCEL_STATUS.MANUAL];
// A send that never came back (Worker stopped mid-call) is treated as unknown after this long.
export const PROCESSING_STUCK_MS = 2 * 60_000;
const STATUS_CHECK_MIN_GAP_MS = 20_000;

// ── Configuration (Admin → booking → Akbar cancellation → Settings; SUPER_ADMIN) ───
// The undocumented points that can be set without a code change. Values Akbar has not shown us
// (CancelType, Isfullrefund) are not settings.
export interface AkbarCancellationConfig {
  liveCancellationEnabled: boolean;              // off: nothing can be sent to Akbar's Cancel
  cancelPath: AkbarCancelPath;                   // which documented spelling of the Cancel path
  tuiSource: "ITINERARY" | "RETRIEVE_BOOKING";   // TUI sent: the booking's own (CreateItinerary) or RetrieveBooking's
  ticketField: "EMPTY" | "TICKET_NUMBER";        // Pax.Ticket: "" as in Akbar's sample, or the ticket number
  partialPassengerCancellation: boolean;         // allow cancelling some passengers of a transaction
  getRefundUatEnabled: boolean;                  // allow GetRefund on the UAT account (never on production)
  updatedBy?: string | null;
  updatedAt?: string | null;
}
export const DEFAULT_AKBAR_CANCELLATION_CONFIG: AkbarCancellationConfig = {
  liveCancellationEnabled: false, cancelPath: AKBAR_CANCEL_PATH_DEFAULT, tuiSource: "ITINERARY", ticketField: "EMPTY",
  partialPassengerCancellation: false, getRefundUatEnabled: false, updatedBy: null, updatedAt: null,
};
const configKey = (tenantId: string) => `admin_settings:${tenantId}:integration:akbar-cancellation`;

export function normalizeAkbarCancellationConfig(v: unknown): AkbarCancellationConfig {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_AKBAR_CANCELLATION_CONFIG;
  return {
    liveCancellationEnabled: s.liveCancellationEnabled === true,
    cancelPath: (AKBAR_CANCEL_PATHS as readonly unknown[]).includes(s.cancelPath) ? s.cancelPath as AkbarCancelPath : d.cancelPath,
    tuiSource: s.tuiSource === "RETRIEVE_BOOKING" ? "RETRIEVE_BOOKING" : "ITINERARY",
    ticketField: s.ticketField === "TICKET_NUMBER" ? "TICKET_NUMBER" : "EMPTY",
    partialPassengerCancellation: s.partialPassengerCancellation === true,
    getRefundUatEnabled: s.getRefundUatEnabled === true,
    updatedBy: typeof s.updatedBy === "string" ? s.updatedBy : null,
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : null,
  };
}
export async function getAkbarCancellationConfig(env: Pick<Env, "TENANT_CACHE_KV">, tenantId: string): Promise<AkbarCancellationConfig> {
  const saved = await env.TENANT_CACHE_KV.get(configKey(tenantId), "json").catch(() => null);
  return normalizeAkbarCancellationConfig(saved);
}
export async function saveAkbarCancellationConfig(env: Pick<Env, "TENANT_CACHE_KV">, tenantId: string, input: unknown, userId: string | null) {
  const cfg = { ...normalizeAkbarCancellationConfig(input), updatedBy: userId, updatedAt: new Date().toISOString() };
  await env.TENANT_CACHE_KV.put(configKey(tenantId), JSON.stringify(cfg));
  return cfg;
}

// ── What can be cancelled ─────────────────────────────────────────────────────

export interface AkbarCancelTarget {
  transactionId: number;
  legs: number[];               // booking legs on this Akbar transaction (one for both legs of an RT / RS round trip)
  itineraryTui: string;         // CreateItinerary TUI: the booking's own TUI
  pnrs: string[]; tickets: string[];
}

// Akbar transactions this booking was ticketed on through the API (StartPay sent, Akbar confirmed).
// Bookings ticketed by staff on Akbar's portal have no transaction here: they are cancelled on the portal.
export function akbarCancelTargets(fd: Record<string, any> | null | undefined): AkbarCancelTarget[] {
  const legs = Array.isArray(fd?.akbarBooking?.legs) ? fd!.akbarBooking.legs as Record<string, any>[] : [];
  const out = new Map<number, AkbarCancelTarget>();
  for (const l of legs) {
    const tx = Number(l?.transactionId);
    if (!Number.isSafeInteger(tx) || tx <= 0 || !l?.paymentSentAt || l?.state !== "SUCCESS") continue;
    const t = out.get(tx) ?? { transactionId: tx, legs: [], itineraryTui: "", pnrs: [], tickets: [] };
    t.legs.push(Number(l.leg));
    if (!t.itineraryTui && typeof l.itineraryTui === "string") t.itineraryTui = l.itineraryTui;
    for (const p of l.pnrs ?? []) if (!t.pnrs.includes(p)) t.pnrs.push(p);
    for (const k of l.tickets ?? []) if (!t.tickets.includes(k)) t.tickets.push(k);
    out.set(tx, t);
  }
  return [...out.values()];
}

export interface AkbarCancelRecord {
  kind: "AKBAR_CANCELLATION"; version: 1;
  transactionId: number; legs: number[];
  bookingPnr: string | null; supplierBookingRef: string | null;
  originalTui: string;            // the booking's own TUI (CreateItinerary)
  requestTui: string;             // the TUI sent with Cancel
  requestId: string;              // idempotency key from Admin (one per confirmation screen)
  planHash: string;
  partial: boolean;
  selectedPaxIds: number[]; allPaxIds: number[];
  passengers: { id: number; name: string; type: string; tickets: string[] }[];
  segments: { crsPnr: string; route: string; pax: { id: number; ticket: string; ticketStatus: string }[] }[];
  settings: { cancelPath: string; tuiSource: string; ticketField: string; cancelType: string; isFullRefund: boolean };
  reason: string;
  requestedBy: string | null; requestedAt: string;
  confirmedBy: string | null; confirmedAt: string;
  request?: unknown;              // the Cancel body as sent (ClientID blanked)
  sentAt?: string;
  response?: { receivedAt: string; code: string; messages: string[]; cancellationId: string; tui: string; transactionId: number | null; meaning: string };
  error?: { at: string; message: string; httpStatus: number | null; notSent: boolean; snippet: string | null };
  supplierRefund: {
    status: SupplierRefundStatus;
    expectedAmount?: number | null; currency?: string | null; source?: string | null;
    creditedAmount?: number | null; reference?: string | null;
    verifiedBy?: string | null; verifiedAt?: string | null; note?: string | null;
    getRefund?: { at: string; by: string | null; request: unknown; details: AkbarRefundDetails | null; error?: string } | null;
  };
  statusChecks: { at: string; by: string | null; ok: boolean; bookingStatus?: string; tickets?: { paxId: number; ticket: string; status: string; crsPnr: string }[]; error?: string }[];
  history: { at: string; by: string | null; event: string; from?: string; to?: string; note?: string }[];
}

export const recordOf = (a: Pick<Amendment, "quote">): AkbarCancelRecord | null => {
  const q = a.quote as AkbarCancelRecord | null;
  return q && q.kind === "AKBAR_CANCELLATION" ? q : null;
};

type Check = { ok: true } | { ok: false; reason: string };

export function holdsTransaction(a: Pick<Amendment, "type" | "status" | "quote">, transactionId: number) {
  return a.type === AKBAR_CANCELLATION && HOLDING.includes(a.status) && recordOf(a)?.transactionId === transactionId;
}

// Can a cancellation be requested for this transaction now?
export function akbarCancelEligibility(b: Booking, amendments: Amendment[], transactionId: number, now = new Date()): Check & { target?: AkbarCancelTarget } {
  const fd = (b.flightData ?? {}) as Record<string, any>;
  if (b.supplier !== "AKBAR") return { ok: false, reason: "Only Akbar API bookings can be cancelled here." };
  if (fd.offline?.groupFare) return { ok: false, reason: "Group fare bookings keep their manual cancellation process." };
  if (!["CONFIRMED", "TICKETED"].includes(b.status)) return { ok: false, reason: `This booking is ${b.status}.` };
  if (fd.offline?.resolution) return { ok: false, reason: "This booking was resolved as a failed Akbar booking (refund / rebooking)." };
  if (b.departureDate && new Date(b.departureDate).getTime() < now.getTime()) return { ok: false, reason: "The flight has already departed." };
  const target = akbarCancelTargets(fd).find((t) => t.transactionId === transactionId);
  if (!target) return { ok: false, reason: "No Akbar API transaction with this ID was ticketed on this booking. Bookings ticketed on Akbar's portal are cancelled on the portal." };
  if (amendments.some((a) => holdsTransaction(a, transactionId)) || fd.akbarCancellation?.[String(transactionId)]) {
    return { ok: false, reason: "A cancellation already exists for this Akbar transaction — see its status below." };
  }
  return { ok: true, target };
}

// ── Building the request ──────────────────────────────────────────────────────

export function cancelRequestTui(cfg: AkbarCancellationConfig, target: AkbarCancelTarget, plan: AkbarCancelPlan): { tui: string; problem?: string } {
  const tui = cfg.tuiSource === "RETRIEVE_BOOKING" ? plan.retrieveTui : target.itineraryTui;
  return tui ? { tui } : { tui: "", problem: cfg.tuiSource === "RETRIEVE_BOOKING" ? "RetrieveBooking returned no TUI." : "The booking has no stored Akbar TUI (CreateItinerary)." };
}

export function buildCancelRequest(plan: AkbarCancelPlan, selectedPaxIds: number[], cfg: AkbarCancellationConfig, tui: string):
  { request: AkbarCancelRequest | null; partial: boolean; problems: string[] } {
  const problems = [...plan.problems];
  const all = plan.passengers.map((p) => p.id);
  const selected = [...new Set(selectedPaxIds)];
  if (!selected.length) problems.push("Select at least one passenger.");
  const unknown = selected.filter((id) => !all.includes(id));
  if (unknown.length) problems.push(`Passenger(s) ${unknown.join(", ")} are not on this Akbar booking.`);
  const partial = selected.length < all.length;
  if (partial && !cfg.partialPassengerCancellation) {
    problems.push("Akbar has not confirmed that some passengers can be cancelled on their own: select every passenger, or cancel on Akbar's portal.");
  }
  if (!tui) problems.push("No TUI to send.");
  const segments = plan.segments.map((s) => ({
    trip: s.trip, journey: s.journey, crsPnr: s.crsPnr,
    pax: s.pax.filter((p) => selected.includes(p.id)).map((p) => {
      if (cfg.ticketField === "TICKET_NUMBER" && !p.ticket) problems.push(`No ticket number for passenger ${p.id} on ${s.crsPnr || "a segment"}.`);
      return { id: p.id, ticket: cfg.ticketField === "TICKET_NUMBER" ? p.ticket : "" };
    }),
  })).filter((s) => s.pax.length);
  if (!segments.length) problems.push("Nothing to cancel.");
  const unique = [...new Set(problems)];
  return { request: unique.length ? null : { transactionId: plan.transactionId, tui, remarks: "", clientIp: "", segments }, partial, problems: unique };
}

// Fingerprint of what the admin reviewed: transaction, TUI, every segment / passenger / ticket.
export async function akbarPlanHash(plan: AkbarCancelPlan, tui: string): Promise<string> {
  const canonical = JSON.stringify({
    t: plan.transactionId, tui,
    s: plan.segments.map((s) => [s.trip, s.journey, s.segment, s.crsPnr, s.pax.map((p) => [p.id, p.ticket, p.ticketStatus])]),
    p: plan.passengers.map((p) => p.id),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Database steps (each one statement, so concurrent callers can't both win) ──────

async function claimTransaction(db: Db, bookingId: string, transactionId: number, amendmentId: string, at: string): Promise<boolean> {
  const key = String(transactionId);
  const claim = JSON.stringify({ amendmentId, at });
  const rows = await db.update(bookings).set({
    flightData: sql`jsonb_set(coalesce(${bookings.flightData}, '{}'::jsonb), '{akbarCancellation}', coalesce(${bookings.flightData}->'akbarCancellation', '{}'::jsonb) || jsonb_build_object(${key}::text, ${claim}::jsonb))`,
    updatedAt: new Date(),
  }).where(and(
    eq(bookings.id, bookingId), inArray(bookings.status, ["CONFIRMED", "TICKETED"]),
    sql`(${bookings.flightData}->'akbarCancellation'->${key}::text) IS NULL`,
  )).returning({ id: bookings.id });
  return rows.length > 0;
}

// Only when the transaction is certainly not cancelled (FAILED): a new request may then be made.
async function releaseClaim(db: Db, bookingId: string, transactionId: number, amendmentId: string) {
  const key = String(transactionId);
  await db.update(bookings).set({ flightData: sql`${bookings.flightData} #- ARRAY['akbarCancellation', ${key}::text]` })
    .where(and(eq(bookings.id, bookingId), sql`${bookings.flightData}->'akbarCancellation'->${key}::text->>'amendmentId' = ${amendmentId}`));
}

type HistoryEntry = AkbarCancelRecord["history"][number];

// Moves an amendment from one of `from` (and, optionally, a supplier refund status) to the next state.
async function transition(db: Db, a: Amendment, opts: {
  from: string[]; to?: string; supplierRefundFrom?: SupplierRefundStatus[]; customerRefundFrom?: string[];
  set?: Partial<typeof bookingAmendments.$inferInsert>; patch?: Partial<AkbarCancelRecord>; history: HistoryEntry;
}): Promise<Amendment | null> {
  const patch = JSON.stringify(opts.patch ?? {});
  const entry = JSON.stringify([opts.history]);
  const [row] = await db.update(bookingAmendments).set({
    ...(opts.set ?? {}),
    ...(opts.to ? { status: opts.to } : {}),
    quote: sql`jsonb_set(coalesce(${bookingAmendments.quote}, '{}'::jsonb) || ${patch}::jsonb, '{history}', coalesce(${bookingAmendments.quote}->'history', '[]'::jsonb) || ${entry}::jsonb)`,
    updatedAt: new Date(),
  }).where(and(
    eq(bookingAmendments.id, a.id), eq(bookingAmendments.type, AKBAR_CANCELLATION), inArray(bookingAmendments.status, opts.from),
    ...(opts.supplierRefundFrom ? [sql`(${bookingAmendments.quote}->'supplierRefund'->>'status') IN (${sql.join(opts.supplierRefundFrom.map((s) => sql`${s}`), sql`, `)})`] : []),
    ...(opts.customerRefundFrom ? [inArray(bookingAmendments.refundStatus, opts.customerRefundFrom)] : []),
  )).returning();
  return (row as Amendment | undefined) ?? null;
}

async function audit(db: Db, tenantId: string, userId: string | null, action: string, bookingId: string, before: unknown, after: unknown, metadata: Record<string, unknown>) {
  await db.insert(auditLogs).values({ tenantId, userId, action, entity: "Booking", entityId: bookingId, before, after, metadata }).catch((err: unknown) => console.error("[audit]", err));
}

// Booking status → CANCELLED once every Akbar transaction of the booking is fully cancelled.
async function closeBookingIfFullyCancelled(db: Db, bookingId: string): Promise<boolean> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b || !["CONFIRMED", "TICKETED"].includes(b.status)) return false;
  const targets = akbarCancelTargets(b.flightData as Record<string, any>);
  if (!targets.length) return false;
  const rows = await db.select().from(bookingAmendments).where(and(eq(bookingAmendments.bookingId, bookingId), eq(bookingAmendments.type, AKBAR_CANCELLATION)));
  const done = targets.every((t) => rows.some((a) => a.status === CANCEL_STATUS.CANCELLED && recordOf(a)?.transactionId === t.transactionId && !recordOf(a)?.partial));
  if (!done) return false;
  const [u] = await db.update(bookings).set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), inArray(bookings.status, ["CONFIRMED", "TICKETED"]))).returning({ id: bookings.id });
  return Boolean(u);
}

// ── Akbar calls (injected, so tests use mocks and nothing real is ever called) ──────

export interface AkbarCancelDeps {
  db: Db;
  retrieve(transactionId: number): Promise<unknown>;                       // RetrieveBooking (read-only)
  cancel(request: AkbarCancelRequest, path: AkbarCancelPath): Promise<unknown>;
  event?(level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>): Promise<void>;
  now?(): Date;
}

export interface Preview {
  ok: boolean;
  transactionId: number;
  pnrs: string[]; route: string;
  akbarStatus: string;
  passengers: AkbarCancelPlan["passengers"];
  segments: { crsPnr: string; route: string; pax: { id: number; ticket: string; ticketStatus: string }[] }[];
  tui: string; tuiSource: string;
  planHash: string;
  partialAllowed: boolean;
  problems: string[];
  requestPreview: unknown;        // the body that would be sent for all passengers (ClientID left out)
}

// Confirmation screen: RetrieveBooking now (read-only), and exactly what would be sent.
export async function previewAkbarCancellation(deps: AkbarCancelDeps, cfg: AkbarCancellationConfig, b: Booking, amendments: Amendment[], transactionId: number): Promise<Preview | { ok: false; error: string; status: number }> {
  const check = akbarCancelEligibility(b, amendments, transactionId, deps.now?.());
  if (!check.ok) return { ok: false, error: check.reason, status: 409 };
  let raw: unknown;
  try { raw = await deps.retrieve(transactionId); }
  catch (err) { return { ok: false, error: `RetrieveBooking failed: ${err instanceof Error ? err.message : String(err)}`, status: 502 }; }
  const plan = akbarCancelPlan(raw, transactionId);
  const { tui, problem } = cancelRequestTui(cfg, check.target!, plan);
  const all = buildCancelRequest(plan, plan.passengers.map((p) => p.id), cfg, tui);
  return {
    ok: true, transactionId, pnrs: plan.pnrs, route: `${b.origin}-${b.destination}`, akbarStatus: plan.bookingStatus,
    passengers: plan.passengers, segments: plan.segments.map(({ crsPnr, route, pax }) => ({ crsPnr, route, pax })),
    tui, tuiSource: cfg.tuiSource, planHash: await akbarPlanHash(plan, tui),
    partialAllowed: cfg.partialPassengerCancellation,
    problems: [...new Set([...(problem ? [problem] : []), ...all.problems])],
    requestPreview: all.request ? requestForLog(all.request, cfg.cancelPath) : null,
  };
}

const requestForLog = (r: AkbarCancelRequest, path: string) => ({
  path, ClientID: "(from the Akbar token)", ClientIP: r.clientIp ?? "", Remarks: r.remarks ?? "", TUI: r.tui, TransactionID: r.transactionId,
  Trips: "(Trips[].Journey[].Segments[] { CRSPNR, Pax[] { ID, Ticket } })",
  Segments: r.segments.map((s) => ({ CRSPNR: s.crsPnr, Pax: s.pax.map((p) => ({ ID: p.id, Ticket: p.ticket })) })),
  Isfullrefund: AKBAR_IS_FULL_REFUND, CancelType: AKBAR_CANCEL_TYPE,
});

export interface SubmitInput {
  booking: Booking; transactionId: number; paxIds: number[]; planHash: string; requestId: string;
  reason: string; confirmPnr: string; userId: string | null;
}
export type SubmitResult =
  | { ok: true; status: AkbarCancelStatus; amendment: Amendment; message: string; duplicate?: boolean; bookingCancelled?: boolean }
  | { ok: false; status: number; error: string; amendment?: Amendment };

// Admin confirmed: record the request, send it once, and record what Akbar answered.
// The caller holds the booking lock.
export async function submitAkbarCancellation(deps: AkbarCancelDeps, cfg: AkbarCancellationConfig, input: SubmitInput): Promise<SubmitResult> {
  const { db } = deps;
  const now = () => (deps.now?.() ?? new Date());
  const b = input.booking;
  const event = (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => deps.event?.(level, message, detail).catch(() => {});

  // Same confirmation sent twice (double click, network retry): the first result.
  const existing = await db.select().from(bookingAmendments).where(and(
    eq(bookingAmendments.bookingId, b.id), eq(bookingAmendments.type, AKBAR_CANCELLATION),
    sql`${bookingAmendments.quote}->>'requestId' = ${input.requestId}`,
  )).limit(1);
  if (existing[0]) return { ok: true, status: existing[0].status as AkbarCancelStatus, amendment: existing[0], duplicate: true, message: "This cancellation request was already recorded — showing its result." };

  if (!cfg.liveCancellationEnabled) return { ok: false, status: 403, error: "Live Akbar cancellation is switched off (Akbar cancellation settings). Nothing was sent to Akbar." };
  const amendments = await db.select().from(bookingAmendments).where(eq(bookingAmendments.bookingId, b.id));
  const check = akbarCancelEligibility(b, amendments, input.transactionId, now());
  if (!check.ok) return { ok: false, status: 409, error: check.reason };
  const target = check.target!;

  // Read Akbar's booking again: what is sent must be what the admin reviewed.
  let raw: unknown;
  try { raw = await deps.retrieve(input.transactionId); }
  catch (err) { return { ok: false, status: 502, error: `RetrieveBooking failed, nothing was sent: ${err instanceof Error ? err.message : String(err)}` }; }
  const plan = akbarCancelPlan(raw, input.transactionId);
  const { tui, problem } = cancelRequestTui(cfg, target, plan);
  if (problem) return { ok: false, status: 409, error: `${problem} Nothing was sent.` };
  if (await akbarPlanHash(plan, tui) !== input.planHash) {
    return { ok: false, status: 409, error: "Akbar's booking changed since you reviewed it (passengers, tickets, PNR or TUI). Review the cancellation again. Nothing was sent." };
  }
  const pnrOk = [...plan.pnrs, ...(b.pnr ? b.pnr.split("/") : [])].map((p) => p.trim().toUpperCase()).includes(input.confirmPnr.trim().toUpperCase());
  if (!pnrOk) return { ok: false, status: 400, error: "Type the PNR shown on the confirmation screen to confirm. Nothing was sent." };
  const built = buildCancelRequest(plan, input.paxIds, cfg, tui);
  if (!built.request) return { ok: false, status: 400, error: `${built.problems.join(" ")} Nothing was sent.` };
  const request = built.request;

  // Claim the transaction, then record the request (CANCELLATION_REQUESTED).
  const amendmentId = crypto.randomUUID();
  const at = now().toISOString();
  if (!(await claimTransaction(db, b.id, input.transactionId, amendmentId, at))) {
    return { ok: false, status: 409, error: "Another cancellation for this Akbar transaction was just started — reload. Nothing was sent." };
  }
  const selected = [...new Set(input.paxIds)];
  const record: AkbarCancelRecord = {
    kind: "AKBAR_CANCELLATION", version: 1, transactionId: input.transactionId, legs: target.legs,
    bookingPnr: b.pnr ?? null, supplierBookingRef: b.supplierBookingRef ?? null,
    originalTui: target.itineraryTui, requestTui: tui, requestId: input.requestId, planHash: input.planHash, partial: built.partial,
    selectedPaxIds: selected, allPaxIds: plan.passengers.map((p) => p.id),
    passengers: plan.passengers, segments: plan.segments.map(({ crsPnr, route, pax }) => ({ crsPnr, route, pax })),
    settings: { cancelPath: cfg.cancelPath, tuiSource: cfg.tuiSource, ticketField: cfg.ticketField, cancelType: AKBAR_CANCEL_TYPE, isFullRefund: AKBAR_IS_FULL_REFUND },
    reason: input.reason, requestedBy: input.userId, requestedAt: at, confirmedBy: input.userId, confirmedAt: at,
    request: requestForLog(request, cfg.cancelPath),
    supplierRefund: { status: "NOT_APPLICABLE" }, statusChecks: [],
    history: [{ at, by: input.userId, event: "REQUESTED", to: CANCEL_STATUS.REQUESTED, note: input.reason }],
  };
  let amendment: Amendment;
  try {
    [amendment] = await db.insert(bookingAmendments).values({
      id: amendmentId, tenantId: b.tenantId, bookingId: b.id, userId: b.userId, type: AKBAR_CANCELLATION, status: CANCEL_STATUS.REQUESTED,
      supplier: "AKBAR", amountPaid: String(b.totalAmount), currency: b.currency, refundStatus: CUSTOMER_REFUND_NOT_STARTED,
      quote: record, adminNote: `${at.slice(0, 16)} REQUESTED: ${input.reason}`,
    }).returning() as Amendment[];
  } catch (err) {
    await releaseClaim(db, b.id, input.transactionId, amendmentId);
    throw err;
  }
  await audit(db, b.tenantId, input.userId, "AKBAR_CANCELLATION_REQUESTED", b.id, { status: b.status, pnr: b.pnr },
    { amendmentId, transactionId: input.transactionId, selectedPaxIds: selected, partial: built.partial }, { reason: input.reason, requestId: input.requestId });

  // CANCELLATION_REQUESTED → CANCELLATION_PROCESSING, then the one and only send.
  const sentAt = now().toISOString();
  const processing = await transition(db, amendment, {
    from: [CANCEL_STATUS.REQUESTED], to: CANCEL_STATUS.PROCESSING, patch: { sentAt },
    history: { at: sentAt, by: input.userId, event: "SENT", from: CANCEL_STATUS.REQUESTED, to: CANCEL_STATUS.PROCESSING },
  });
  if (!processing) return { ok: false, status: 409, error: "The request changed before it was sent — reload.", amendment };
  await event("info", `Akbar cancellation sent for transaction ${input.transactionId} (${selected.length} passenger(s))`, { amendmentId, transactionId: input.transactionId });

  let answer: unknown;
  try {
    answer = await deps.cancel(request, cfg.cancelPath);
  } catch (err) {
    const e = err as { message?: string; statusCode?: number; responseSnippet?: string };
    const notSent = akbarCallNotSent(err);
    const atErr = now().toISOString();
    const error = { at: atErr, message: String(e?.message ?? err), httpStatus: typeof e?.statusCode === "number" ? e.statusCode : null, notSent, snippet: typeof e?.responseSnippet === "string" ? e.responseSnippet.slice(0, 1000) : null };
    const to = notSent ? CANCEL_STATUS.FAILED : CANCEL_STATUS.MANUAL;
    const u = await transition(db, processing, {
      from: [CANCEL_STATUS.PROCESSING], to, patch: { error },
      set: { supplierStatus: error.httpStatus ? `HTTP_${error.httpStatus}` : "NO_RESPONSE", lastSupplierResponse: { error }, lastCheckedAt: new Date() },
      history: { at: atErr, by: null, event: notSent ? "NOT_SENT" : "NO_CLEAR_ANSWER", from: CANCEL_STATUS.PROCESSING, to, note: error.message },
    }) ?? processing;
    if (notSent) await releaseClaim(db, b.id, input.transactionId, amendmentId);
    await event(notSent ? "error" : "warn", notSent
      ? `Akbar cancellation NOT sent (${error.message}) — nothing was cancelled; it can be requested again`
      : `Akbar cancellation: no clear answer (${error.message}) — check the transaction on Akbar's portal before doing anything else`, { amendmentId });
    await audit(db, b.tenantId, input.userId, "AKBAR_CANCELLATION_RESULT", b.id, null, { amendmentId, status: to }, { error });
    return { ok: true, status: to, amendment: u, message: notSent
      ? `Not sent to Akbar: ${error.message}. Nothing was cancelled.`
      : `Akbar did not give a clear answer (${error.message}). The booking may or may not be cancelled — check Akbar's portal, then record what you find. Do not cancel again.` };
  }

  const result = akbarCancelResult(answer, input.transactionId);
  const atRes = now().toISOString();
  const response = { receivedAt: atRes, code: result.code, messages: result.messages, cancellationId: result.cancellationId, tui: result.tui, transactionId: result.transactionId,
    meaning: result.kind === "CONFIRMED" ? "Code 1903: Auto Cancellation Success (documented)" : result.reason };
  const to = result.kind === "CONFIRMED" ? CANCEL_STATUS.CANCELLED : CANCEL_STATUS.MANUAL;
  const u = await transition(db, processing, {
    from: [CANCEL_STATUS.PROCESSING], to,
    patch: { response, ...(to === CANCEL_STATUS.CANCELLED ? { supplierRefund: { status: "REFUND_PENDING" as const } } : {}) },
    set: { supplierStatus: result.code || null, supplierAmendmentId: result.cancellationId || null, lastSupplierResponse: answer as object, lastCheckedAt: new Date() },
    history: { at: atRes, by: null, event: result.kind === "CONFIRMED" ? "AKBAR_CONFIRMED" : "AKBAR_UNKNOWN_ANSWER", from: CANCEL_STATUS.PROCESSING, to, note: response.meaning },
  }) ?? processing;
  const bookingCancelled = to === CANCEL_STATUS.CANCELLED ? await closeBookingIfFullyCancelled(db, b.id) : false;
  await event(to === CANCEL_STATUS.CANCELLED ? "info" : "warn", to === CANCEL_STATUS.CANCELLED
    ? `Akbar confirmed the cancellation (Code 1903, CancellationID ${result.cancellationId})${bookingCancelled ? " — booking CANCELLED" : ""}. Akbar deposit refund: pending until verified; customer refund: not started`
    : `Akbar answered but the outcome is not documented (${response.meaning}) — check Akbar's portal`, { amendmentId, code: result.code, cancellationId: result.cancellationId });
  await audit(db, b.tenantId, input.userId, "AKBAR_CANCELLATION_RESULT", b.id, { status: b.status }, { amendmentId, status: to, bookingCancelled }, { response });
  return {
    ok: true, status: to, amendment: u, bookingCancelled,
    message: to === CANCEL_STATUS.CANCELLED
      ? `Akbar confirmed the cancellation (CancellationID ${result.cancellationId}).${bookingCancelled ? " The booking is now CANCELLED." : ""} No refund has been made: track the Akbar deposit refund and refund the customer separately.`
      : `Akbar answered, but not with a documented success (${response.meaning}). Check Akbar's portal and record the result. Do not cancel again.`,
  };
}

// ── Check latest status (RetrieveBooking, read-only) ──────────────────────────
// Akbar has not documented how RetrieveBooking shows a cancellation, so its statuses are stored and
// shown as Akbar wrote them and never change our status. The only change: a send that never came
// back (still PROCESSING after PROCESSING_STUCK_MS) becomes MANUAL_VERIFICATION_REQUIRED.
export async function checkAkbarCancellationStatus(deps: AkbarCancelDeps, a: Amendment, userId: string | null): Promise<{ ok: boolean; amendment: Amendment; error?: string }> {
  const rec = recordOf(a);
  if (!rec) return { ok: false, amendment: a, error: "Not an Akbar cancellation." };
  const now = deps.now?.() ?? new Date();
  if (a.lastCheckedAt && now.getTime() - new Date(a.lastCheckedAt).getTime() < STATUS_CHECK_MIN_GAP_MS) {
    return { ok: false, amendment: a, error: "Checked a few seconds ago — wait a moment and try again." };
  }
  let current = a;
  if (a.status === CANCEL_STATUS.PROCESSING && rec.sentAt && now.getTime() - new Date(rec.sentAt).getTime() > PROCESSING_STUCK_MS) {
    current = await transition(deps.db, a, {
      from: [CANCEL_STATUS.PROCESSING], to: CANCEL_STATUS.MANUAL,
      history: { at: now.toISOString(), by: userId, event: "NO_ANSWER_RECORDED", from: CANCEL_STATUS.PROCESSING, to: CANCEL_STATUS.MANUAL, note: "The send never recorded an answer." },
    }) ?? a;
  }
  let check: AkbarCancelRecord["statusChecks"][number];
  let raw: unknown = null;
  try {
    raw = await deps.retrieve(rec.transactionId);
    const plan = akbarCancelPlan(raw, rec.transactionId);
    check = { at: now.toISOString(), by: userId, ok: true, bookingStatus: plan.bookingStatus,
      tickets: plan.segments.flatMap((s) => s.pax.map((p) => ({ paxId: p.id, ticket: p.ticket, status: p.ticketStatus, crsPnr: s.crsPnr }))) };
  } catch (err) {
    check = { at: now.toISOString(), by: userId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const checks = [...(recordOf(current)?.statusChecks ?? []), check].slice(-20);
  const [u] = await deps.db.update(bookingAmendments).set({
    quote: sql`coalesce(${bookingAmendments.quote}, '{}'::jsonb) || ${JSON.stringify({ statusChecks: checks })}::jsonb`,
    lastCheckedAt: now, updatedAt: now, ...(raw ? { lastSupplierResponse: raw as object } : {}),
  }).where(eq(bookingAmendments.id, a.id)).returning();
  return { ok: check.ok, amendment: (u as Amendment) ?? current, ...(check.ok ? {} : { error: `RetrieveBooking failed: ${check.error}` }) };
}

// ── Staff actions after the send ──────────────────────────────────────────────

export type AkbarCancelAction =
  | { action: "WITHDRAW_REQUEST"; note: string }
  | { action: "VERIFIED_CANCELLED"; note: string; cancellationId?: string }
  | { action: "VERIFIED_PENDING"; note: string }
  | { action: "VERIFIED_NOT_CANCELLED"; note: string }
  | { action: "RECORD_SUPPLIER_REFUND"; note: string; amount: number; currency: string; source: "AKBAR_PORTAL" | "AKBAR_STATEMENT" | "AKBAR_EMAIL" | "GETREFUND_UAT" }
  | { action: "MARK_DEPOSIT_CREDITED"; note: string; amount: number; currency: string; reference: string }
  | { action: "MARK_DEPOSIT_REFUND_FAILED"; note: string }
  | { action: "REFUND_CUSTOMER"; note: string; amount: number }
  | { action: "RETRY_CUSTOMER_REFUND"; note: string }
  | { action: "CUSTOMER_REFUNDED_MANUALLY"; note: string; amount: number; reference: string };

export type ActionResult = { ok: true; amendment: Amendment; message: string } | { ok: false; status: number; error: string };

const conflict = (error: string): ActionResult => ({ ok: false, status: 409, error });

export async function applyAkbarCancellationAction(db: Db, env: Env, a: Amendment, act: AkbarCancelAction, userId: string | null, nowDate = new Date()): Promise<ActionResult> {
  const rec = recordOf(a);
  if (!rec || a.type !== AKBAR_CANCELLATION) return { ok: false, status: 400, error: "Not an Akbar cancellation." };
  const at = nowDate.toISOString();
  const h = (event: string, from?: string, to?: string): HistoryEntry => ({ at, by: userId, event, ...(from ? { from } : {}), ...(to ? { to } : {}), note: act.note });
  const sr = rec.supplierRefund ?? { status: "NOT_APPLICABLE" as const };
  const note = `${at.slice(0, 16)} ${act.action}: ${act.note}`.slice(0, 1000);
  let u: Amendment | null = null;
  let message = "";

  switch (act.action) {
    case "WITHDRAW_REQUEST":
      // Only before it was sent: a REQUESTED cancellation never reached Akbar.
      u = await transition(db, a, { from: [CANCEL_STATUS.REQUESTED], to: CANCEL_STATUS.FAILED, set: { adminNote: note }, history: h("WITHDRAWN", a.status, CANCEL_STATUS.FAILED) });
      if (!u) return conflict("Only a request that was not sent yet can be withdrawn.");
      await releaseClaim(db, a.bookingId, rec.transactionId, a.id);
      message = "Request withdrawn — nothing was sent to Akbar.";
      break;
    case "VERIFIED_CANCELLED":
      u = await transition(db, a, {
        from: [CANCEL_STATUS.MANUAL, CANCEL_STATUS.PENDING], to: CANCEL_STATUS.CANCELLED,
        patch: { supplierRefund: { ...sr, status: "REFUND_PENDING" } },
        set: { adminNote: note, ...(act.cancellationId ? { supplierAmendmentId: act.cancellationId.slice(0, 64) } : {}) },
        history: h("VERIFIED_CANCELLED_ON_AKBAR", a.status, CANCEL_STATUS.CANCELLED),
      });
      if (!u) return conflict("Only a cancellation waiting for verification (or pending at Akbar) can be marked cancelled.");
      message = (await closeBookingIfFullyCancelled(db, a.bookingId)) ? "Marked cancelled — the booking is now CANCELLED. Track the Akbar deposit refund next." : "Marked cancelled. Track the Akbar deposit refund next.";
      break;
    case "VERIFIED_PENDING":
      u = await transition(db, a, { from: [CANCEL_STATUS.MANUAL], to: CANCEL_STATUS.PENDING, set: { adminNote: note }, history: h("VERIFIED_PENDING_AT_AKBAR", a.status, CANCEL_STATUS.PENDING) });
      if (!u) return conflict("Only a cancellation waiting for verification can be marked pending.");
      message = "Marked as pending at Akbar — check again later.";
      break;
    case "VERIFIED_NOT_CANCELLED":
      u = await transition(db, a, { from: [CANCEL_STATUS.MANUAL, CANCEL_STATUS.PENDING], to: CANCEL_STATUS.FAILED, set: { adminNote: note }, history: h("VERIFIED_NOT_CANCELLED", a.status, CANCEL_STATUS.FAILED) });
      if (!u) return conflict("Only a cancellation waiting for verification (or pending) can be marked not cancelled.");
      await releaseClaim(db, a.bookingId, rec.transactionId, a.id);
      message = "Marked as not cancelled on Akbar. The booking is unchanged; a new cancellation can be requested.";
      break;
    case "RECORD_SUPPLIER_REFUND":
      if (!(act.amount >= 0)) return { ok: false, status: 400, error: "Enter the refund amount Akbar shows." };
      u = await transition(db, a, {
        from: [CANCEL_STATUS.CANCELLED], supplierRefundFrom: ["REFUND_PENDING"],
        patch: { supplierRefund: { ...sr, status: "REFUND_PENDING", expectedAmount: act.amount, currency: act.currency, source: act.source, note: act.note } },
        set: { adminNote: note }, history: h("SUPPLIER_REFUND_AMOUNT_RECORDED"),
      });
      if (!u) return conflict("The Akbar refund amount can be recorded only while the deposit refund is pending.");
      message = "Akbar refund amount recorded. The deposit refund stays pending until you verify the credit on Akbar's statement.";
      break;
    case "MARK_DEPOSIT_CREDITED":
      if (!(act.amount >= 0) || !act.reference.trim()) return { ok: false, status: 400, error: "Enter the amount credited and the Akbar statement / ledger reference." };
      u = await transition(db, a, {
        from: [CANCEL_STATUS.CANCELLED], supplierRefundFrom: ["REFUND_PENDING", "REFUND_FAILED"],
        patch: { supplierRefund: { ...sr, status: "REFUNDED", creditedAmount: act.amount, currency: act.currency, reference: act.reference.trim().slice(0, 200), verifiedBy: userId, verifiedAt: at, note: act.note } },
        set: { adminNote: note }, history: h("AKBAR_DEPOSIT_CREDIT_VERIFIED", sr.status, "REFUNDED"),
      });
      if (!u) return conflict("Only a cancelled booking whose Akbar deposit refund is pending or failed can be marked credited.");
      message = "Akbar deposit credit verified.";
      break;
    case "MARK_DEPOSIT_REFUND_FAILED":
      u = await transition(db, a, {
        from: [CANCEL_STATUS.CANCELLED], supplierRefundFrom: ["REFUND_PENDING"],
        patch: { supplierRefund: { ...sr, status: "REFUND_FAILED", note: act.note } },
        set: { adminNote: note }, history: h("AKBAR_DEPOSIT_REFUND_FAILED", sr.status, "REFUND_FAILED"),
      });
      if (!u) return conflict("Only a pending Akbar deposit refund can be marked failed.");
      message = "Akbar deposit refund marked failed — follow up with Akbar.";
      break;
    case "REFUND_CUSTOMER": {
      const [b] = await db.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, a.bookingId)).limit(1);
      if (b?.status !== "CANCELLED") return conflict("The customer can be refunded here only when the whole booking is cancelled. For a partial cancellation, refund outside ZamraBooking and record it with \"Customer refunded manually\".");
      if (!(act.amount > 0) || act.amount > Number(a.amountPaid) + 0.001) return { ok: false, status: 400, error: `Enter a refund above 0 and no more than the amount paid (${Number(a.amountPaid).toFixed(2)}).` };
      const claimed = await transition(db, a, {
        from: [CANCEL_STATUS.CANCELLED], customerRefundFrom: [CUSTOMER_REFUND_NOT_STARTED],
        set: { refundAmount: act.amount.toFixed(2), refundStatus: "PENDING", adminNote: note }, history: h("CUSTOMER_REFUND_STARTED"),
      });
      if (!claimed) return conflict("A customer refund was already started for this cancellation.");
      u = (await settleRefund(db, env, claimed)) ?? claimed;
      message = u.refundStatus === "DONE" ? `Customer refunded via ${u.refundMethod} (${u.refundReference ?? ""}).` : `Customer refund ${u.refundStatus}${u.refundError ? `: ${u.refundError}` : ""}.`;
      break;
    }
    case "RETRY_CUSTOMER_REFUND": {
      if (a.status !== CANCEL_STATUS.CANCELLED || a.refundStatus !== "FAILED") return conflict("Only a failed customer refund can be retried.");
      u = await settleRefund(db, env, a, { retryFailed: true });
      if (!u) return conflict("The refund changed — reload.");
      message = `Customer refund ${u.refundStatus}.`;
      break;
    }
    case "CUSTOMER_REFUNDED_MANUALLY": {
      if (!(act.amount >= 0) || act.amount > Number(a.amountPaid) + 0.001 || !act.reference.trim()) return { ok: false, status: 400, error: "Enter the amount refunded (no more than the amount paid) and a reference." };
      u = await transition(db, a, {
        from: [CANCEL_STATUS.CANCELLED], customerRefundFrom: [CUSTOMER_REFUND_NOT_STARTED, "PENDING", "FAILED", "MANUAL_REQUIRED"],
        set: { refundStatus: "DONE", refundedAt: nowDate, refundAmount: act.amount.toFixed(2), refundMethod: "MANUAL", refundReference: `manual: ${act.reference.trim()}`.slice(0, 200), refundError: null, adminNote: note },
        history: h("CUSTOMER_REFUNDED_MANUALLY"),
      });
      if (!u) return conflict("Only a cancelled booking whose customer refund isn't done or in progress can be marked refunded.");
      message = "Customer refund recorded as paid manually.";
      break;
    }
  }
  await audit(db, a.tenantId, userId, `AKBAR_CANCELLATION_${act.action}`, a.bookingId,
    { status: a.status, supplierRefund: sr.status, customerRefund: a.refundStatus },
    { status: u!.status, supplierRefund: recordOf(u!)?.supplierRefund?.status, customerRefund: u!.refundStatus },
    { ...act, amendmentId: a.id });
  return { ok: true, amendment: u!, message };
}

// ── GetRefund (UAT only) ──────────────────────────────────────────────────────
// Akbar has not said whether GetRefund only reads or also changes the booking, so it is never called on
// the production account. On UAT it can be switched on to learn its behaviour on test bookings.
export function akbarGetRefundAllowed(environment: string, cfg: AkbarCancellationConfig): Check {
  if (environment !== "UAT") return { ok: false, reason: "GetRefund is disabled on the live Akbar account until Akbar confirms it does not change the booking." };
  if (!cfg.getRefundUatEnabled) return { ok: false, reason: "GetRefund is switched off (Akbar cancellation settings)." };
  return { ok: true };
}

export async function runAkbarGetRefund(db: Db, a: Amendment, call: (p: { tui: string; transactionId: number }) => Promise<unknown>, userId: string | null, now = new Date()) {
  const rec = recordOf(a);
  if (!rec) return { ok: false as const, error: "Not an Akbar cancellation." };
  const params = { tui: rec.requestTui, transactionId: rec.transactionId };
  let details: AkbarRefundDetails | null = null;
  let error: string | undefined;
  let raw: unknown = null;
  try { raw = await call(params); details = akbarRefundDetails(raw, rec.transactionId); }
  catch (err) { error = err instanceof Error ? err.message : String(err); }
  const getRefund = { at: now.toISOString(), by: userId, request: akbarGetRefundBody(params), details, ...(error ? { error } : {}) };
  const sr = rec.supplierRefund ?? { status: "NOT_APPLICABLE" as const };
  const u = await transition(db, a, {
    from: Object.values(CANCEL_STATUS), patch: { supplierRefund: { ...sr, getRefund } },
    set: raw ? { lastSupplierResponse: raw as object } : {},
    history: { at: now.toISOString(), by: userId, event: error ? "GETREFUND_FAILED" : "GETREFUND_UAT", note: error ?? (details ? `Code ${details.code}` : "") },
  });
  return { ok: !error, amendment: u ?? a, details, error };
}

// Latest Akbar cancellations of a booking (Admin panel).
export async function akbarCancellationsOf(db: Db, bookingId: string) {
  return db.select().from(bookingAmendments)
    .where(and(eq(bookingAmendments.bookingId, bookingId), eq(bookingAmendments.type, AKBAR_CANCELLATION)))
    .orderBy(desc(bookingAmendments.createdAt)) as Promise<Amendment[]>;
}
