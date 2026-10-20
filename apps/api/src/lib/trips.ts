// Post-booking helpers: load a trip, read the live TripJack itinerary, and run
// cancellations (quote → submit → status sync → wallet refund).
//
// TripJack's amendment responses are parsed defensively: if charges can't be
// read, the customer is not offered self-service cancellation, and no refund is
// ever paid until TripJack reports the amendment as successful.

import { emailCancellation } from "./transactional-emails.js";
import type { Context } from "hono";
import { TripjackClient, type ExchangeRecorder } from "@poomas/suppliers";
import { persistExchanges, persistInBackground } from "./api-exchanges.js";
import { bookings, bookingPassengers, payments, bookingAmendments } from "@poomas/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { resolveFlightSuppliers } from "../routes/search.js";
import { creditWallet, getOrCreateCustomerWallet, roundMoney } from "./customer-wallet.js";
import { refundNomodCharge, resolveNomodApiKey } from "./payment-gateway.js";
import { logSupplierCall } from "./supplier-logger.js";
import { describeError, errorDetail, logBookingEvent } from "./booking-recovery.js";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Booking = typeof bookings.$inferSelect;
type Amendment = typeof bookingAmendments.$inferSelect;

const ITINERARY_TTL = 300;           // seconds the live itinerary is cached in KV
const STATUS_RECHECK_MS = 60_000;    // min gap between TripJack amendment status checks
export const QUOTE_TTL = 600;        // a cancellation quote is valid for 10 minutes

// With a bookingId, every raw request/response is stored against that booking
// (certification logs).
export async function tripjackClientFor(c: Ctx, bookingId?: string) {
  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(c.env, c.get("tenant"), c.get("tenantId"));
  const cfg = supplierConfigs.find((s) => s.name === "TRIPJACK");
  const recorder: ExchangeRecorder | undefined = bookingId
    ? (x) => persistInBackground(c, persistExchanges(c.env, c.get("db"), c.get("tenantId"), [x], { bookingId }))
    : undefined;
  return new TripjackClient({ ...(platformCredentials.TRIPJACK ?? {}), ...(cfg?.credentials ?? {}), recorder });
}

export async function loadTrip(db: Variables["db"], tenantId: string, bookingId: string) {
  const [booking] = await db.select().from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId))).limit(1);
  if (!booking) return null;
  const [passengers, paymentRows, amendments] = await Promise.all([
    db.select({
      id: bookingPassengers.id, type: bookingPassengers.passengerType,
      firstName: bookingPassengers.firstName, lastName: bookingPassengers.lastName,
    }).from(bookingPassengers).where(eq(bookingPassengers.bookingId, bookingId)),
    db.select({
      id: payments.id, gateway: payments.gateway, gatewayPaymentId: payments.gatewayPaymentId, amount: payments.amount,
      currency: payments.currency, status: payments.status, createdAt: payments.createdAt,
    }).from(payments).where(eq(payments.bookingId, bookingId)),
    db.select().from(bookingAmendments).where(eq(bookingAmendments.bookingId, bookingId)).orderBy(desc(bookingAmendments.createdAt)),
  ]);
  return { booking, passengers, payments: paymentRows, amendments };
}

// ── Itinerary ────────────────────────────────────────────────────────────────

export interface Segment {
  airline: string; airlineName: string; flightNumber: string;
  from: { code: string; city?: string; name?: string; terminal?: string };
  to:   { code: string; city?: string; name?: string; terminal?: string };
  departure: string; arrival: string; durationMin?: number; cabinBaggage?: string; checkedBaggage?: string;
}
export interface Itinerary {
  supplierStatus?: string;
  pnr?: string;
  segments: Segment[];
  travellers: { name: string; type?: string; pnr?: string; ticketNumber?: string }[];
}

// `fresh` skips the KV cache (used for downloads, so ticket numbers issued a
// moment ago are included).
export async function liveItinerary(c: Ctx, booking: Booking, opts: { fresh?: boolean; source?: string } = {}): Promise<Itinerary | null> {
  if (booking.supplier !== "TRIPJACK" || !booking.supplierBookingRef || !["CONFIRMED", "TICKETED", "CANCELLED", "REFUNDED"].includes(booking.status)) {
    return null;
  }
  const key = `trip_itin:${booking.id}`;
  if (!opts.fresh) {
    try {
      const cached = await c.env.SESSIONS_KV.get(key, "json") as Itinerary | null;
      if (cached) return cached;
    } catch {}
  }
  let client: TripjackClient;
  try {
    client = await tripjackClientFor(c, booking.id);
  } catch (err) {
    await logBookingEvent(c.env, booking.id, "SUPPLIER_CONFIG", "error",
      "Customer page could not read booking details: TripJack is not configured (key / base URL / toggle in Admin → Integrations)",
      { source: opts.source ?? "customer page", ...errorDetail(err) });
    return null;
  }
  try {
    const raw = await client.pnrStatus(booking.supplierBookingRef) as any;
    const itin = parseBookingDetails(raw);
    if (!itin.segments.length) {
      const root = raw?.data ?? raw?.result ?? raw ?? {};
      await logBookingEvent(c.env, booking.id, "BOOKING_DETAILS", "warn",
        `TripJack booking-details returned no flight segments for ${booking.supplierBookingRef} (order status ${root?.order?.status ?? "missing"})`,
        { source: opts.source ?? "customer page", supplierBookingId: booking.supplierBookingRef,
          orderStatus: root?.order?.status ?? null, statusMessage: root?.order?.statusMessage ?? root?.status?.statusMessage ?? null,
          apiStatus: root?.status ?? null, errors: root?.errors ?? null,
          supplierResponse: JSON.stringify(raw ?? null).slice(0, 1500) });
      return itin;
    }
    try { await c.env.SESSIONS_KV.put(key, JSON.stringify(itin), { expirationTtl: ITINERARY_TTL }); } catch {}
    return itin;
  } catch (err) {
    console.error(`[trips] booking-details failed for ${booking.id}`, err);
    await logBookingEvent(c.env, booking.id, "BOOKING_DETAILS", "error",
      `TripJack booking-details lookup failed for ${booking.supplierBookingRef}: ${describeError(err)}`,
      { source: opts.source ?? "customer page", supplierBookingId: booking.supplierBookingRef, ...errorDetail(err) });
    return null;
  }
}

export function parseBookingDetails(raw: any): Itinerary {
  const root = raw?.data ?? raw?.result ?? raw ?? {};
  const air = root.itemInfos?.AIR ?? root;
  const tripInfos: any[] = Array.isArray(air.tripInfos) ? air.tripInfos : [];
  const segments: Segment[] = tripInfos.flatMap((t) => (Array.isArray(t?.sI) ? t.sI : [])).map((s: any) => ({
    airline:      String(s?.fD?.aI?.code ?? ""),
    airlineName:  String(s?.fD?.aI?.name ?? ""),
    flightNumber: `${s?.fD?.aI?.code ?? ""} ${s?.fD?.fN ?? ""}`.trim(),
    from: { code: String(s?.da?.code ?? ""), city: s?.da?.city, name: s?.da?.name, terminal: s?.da?.terminal },
    to:   { code: String(s?.aa?.code ?? ""), city: s?.aa?.city, name: s?.aa?.name, terminal: s?.aa?.terminal },
    departure: String(s?.dt ?? ""),
    arrival:   String(s?.at ?? ""),
    durationMin: typeof s?.duration === "number" ? s.duration : undefined,
    cabinBaggage:   s?.bI?.tI?.[0]?.fd?.bI?.cB,
    checkedBaggage: s?.bI?.tI?.[0]?.fd?.bI?.iB,
  }));
  const travellerInfos: any[] = Array.isArray(air.travellerInfos) ? air.travellerInfos : Array.isArray(root.travellerInfos) ? root.travellerInfos : [];
  const travellers = travellerInfos.map((t) => ({
    name: `${t?.ti ?? ""} ${t?.fN ?? ""} ${t?.lN ?? ""}`.replace(/\s+/g, " ").trim(),
    type: t?.pt,
    pnr: firstValue(t?.pnrDetails),
    ticketNumber: firstValue(t?.ticketNumberDetails),
  }));
  return {
    supplierStatus: root.order?.status ?? root.status?.statusMessage,
    pnr: travellers.find((t) => t.pnr)?.pnr,
    segments,
    travellers,
  };
}

function firstValue(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const first = Object.values(v as Record<string, unknown>)[0];
  return typeof first === "string" && first ? first : undefined;
}

// ── Cancellation ─────────────────────────────────────────────────────────────

export function cancellationBlocker(booking: Booking, amendments: Amendment[]): string | null {
  if (booking.supplier !== "TRIPJACK") return "Online cancellation is available for TripJack bookings only.";
  if (!["CONFIRMED", "TICKETED"].includes(booking.status)) return `This booking is ${booking.status.toLowerCase().replace("_", " ")}.`;
  if (!booking.supplierBookingRef) return "This booking has no airline reference yet.";
  if (booking.departureDate && booking.departureDate.getTime() < Date.now()) return "This flight has already departed.";
  if (amendments.some((a) => a.type === "CANCELLATION" && ["SUBMITTED", "PROCESSING", "SUCCESS"].includes(a.status))) {
    return "A cancellation is already in progress for this booking.";
  }
  return null;
}

export interface CancellationQuote {
  bookingId: string;
  currency: string;
  amountPaid: number;       // customer paid (fare + service fee)
  serviceFee: number;       // our markup, non-refundable
  supplierFare: number;     // what TripJack was paid
  supplierCharges: number;  // airline + TripJack cancellation charges
  refundAmount: number;     // what the customer gets back
  refundMethod: RefundMethod;
  refundTo: string;         // human description of where the refund goes
  createdAt: string;
}

// Reads per-pax-type charges from an amendment-charges response and scales them
// by the booking's passenger counts. Returns null when nothing usable is found.
export function parseCancellationCharges(raw: any, booking: Pick<Booking, "adultCount" | "childCount" | "infantCount">) {
  const root = raw?.data ?? raw?.result ?? raw ?? {};
  const topCharges = num(root.totalAmendmentCharges ?? root.amendmentCharges);
  const topRefund = num(root.totalRefundAmount ?? root.refundableAmount ?? root.refundAmount);
  if (topCharges !== null && topRefund !== null) return { charges: topCharges, refund: topRefund };

  const counts: Record<string, number> = { ADULT: booking.adultCount ?? 1, CHILD: booking.childCount ?? 0, INFANT: booking.infantCount ?? 0 };
  let charges = 0, refund = 0, found = false;
  for (const trip of Array.isArray(root.trips) ? root.trips : []) {
    const info = trip?.amendmentInfo ?? {};
    for (const [paxType, v] of Object.entries(info as Record<string, any>)) {
      const n = counts[paxType] ?? 0;
      const ch = num(v?.amendmentCharges), rf = num(v?.refundAmount);
      if (ch === null || rf === null || n === 0) continue;
      charges += ch * n; refund += rf * n; found = true;
    }
  }
  return found ? { charges: roundMoney(charges), refund: roundMoney(refund) } : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function buildQuote(booking: Booking, parsed: { charges: number; refund: number }, refundMethod: RefundMethod): CancellationQuote {
  const amountPaid = Number(booking.totalAmount);
  const serviceFee = Number(booking.markup ?? 0);
  const supplierFare = roundMoney(amountPaid - serviceFee);
  // Never refund more than TripJack was paid, nor a negative amount.
  const refundAmount = roundMoney(Math.min(Math.max(parsed.refund, 0), supplierFare));
  return {
    bookingId: booking.id, currency: booking.currency, amountPaid, serviceFee, supplierFare,
    supplierCharges: roundMoney(parsed.charges), refundAmount, refundMethod, refundTo: REFUND_METHOD_LABEL[refundMethod],
    createdAt: new Date().toISOString(),
  };
}

export function mapAmendmentStatus(raw: any): { status: "PROCESSING" | "SUCCESS" | "REJECTED"; supplierStatus: string; refund: number | null } {
  const root = raw?.data ?? raw?.result ?? raw ?? {};
  const s = String(root.amendmentStatus ?? root.status?.statusMessage ?? root.status ?? "").toUpperCase();
  const status = /SUCCESS|PROCESSED|COMPLETE/.test(s) ? "SUCCESS" : /REJECT|FAIL|CANCELLED|ABORT/.test(s) ? "REJECTED" : "PROCESSING";
  return { status, supplierStatus: s || "UNKNOWN", refund: num(root.refundableAmount ?? root.refundAmount ?? root.totalRefundAmount) };
}

// Re-checks a submitted cancellation with TripJack (at most once a minute) and
// settles the refund when it succeeds. Safe to call from any page view.
export async function syncCancellation(c: Ctx, amendment: Amendment): Promise<Amendment> {
  if (!["SUBMITTED", "PROCESSING"].includes(amendment.status) || !amendment.supplierAmendmentId) {
    return amendment.status === "SUCCESS" && amendment.refundStatus === "PENDING" ? (await settleRefund(c.get("db"), c.env, amendment)) ?? amendment : amendment;
  }
  if (amendment.lastCheckedAt && Date.now() - amendment.lastCheckedAt.getTime() < STATUS_RECHECK_MS) return amendment;

  const db = c.get("db");
  let raw: any;
  try {
    raw = await (await tripjackClientFor(c, amendment.bookingId)).amendmentDetails(amendment.supplierAmendmentId);
  } catch (err) {
    console.error(`[cancel] amendment-details failed for ${amendment.id}`, err);
    await db.update(bookingAmendments).set({ lastCheckedAt: new Date() }).where(eq(bookingAmendments.id, amendment.id));
    return amendment;
  }
  const mapped = mapAmendmentStatus(raw);
  const refundAmount = mapped.refund !== null
    ? roundMoney(Math.min(mapped.refund, Number(amendment.amountPaid)))
    : amendment.refundAmount !== null ? Number(amendment.refundAmount) : null;

  const [updated] = await db.update(bookingAmendments).set({
    status: mapped.status, supplierStatus: mapped.supplierStatus, lastSupplierResponse: raw,
    ...(refundAmount !== null ? { refundAmount: refundAmount.toFixed(2) } : {}),
    lastCheckedAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(bookingAmendments.id, amendment.id), eq(bookingAmendments.status, amendment.status))).returning();
  if (!updated) return amendment;  // someone else moved it on

  if (mapped.status === "SUCCESS") {
    await db.update(bookings).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(bookings.id, amendment.bookingId));
    await emailCancellation(c.env, db, updated, "CONFIRMED");
    return (await settleRefund(db, c.env, updated)) ?? updated;
  }
  if (mapped.status === "REJECTED") await emailCancellation(c.env, db, updated, "REJECTED");
  return updated;
}

type RefundMethod = "WALLET" | "AGENT_WALLET" | "NOMOD" | "MANUAL";

// The refund goes back to how the booking was paid.
export function originalRefundMethod(paid: { gateway: string; gatewayPaymentId?: string | null } | undefined, hasCustomer: boolean): RefundMethod {
  if (paid?.gateway === "WALLET" && paid.gatewayPaymentId?.startsWith("agentwallet_")) return "AGENT_WALLET";
  if (paid?.gateway === "WALLET" && hasCustomer) return "WALLET";
  if (paid?.gateway === "NOMOD" && paid.gatewayPaymentId) return "NOMOD";
  return "MANUAL";
}

export const REFUND_METHOD_LABEL: Record<RefundMethod, string> = {
  WALLET: "your POOMAS wallet (instant)",
  AGENT_WALLET: "your agency wallet (instant)",
  NOMOD:  "your original card / payment method (usually 5–10 working days)",
  MANUAL: "your original payment method (our team will process it)",
};

// Refunds a successful cancellation to the original payment method, once.
// PENDING → PROCESSING (atomic claim) → DONE | FAILED | MANUAL_REQUIRED.
// `retryFailed` lets an admin retry a FAILED refund; MANUAL_REQUIRED is never retried
// automatically because the provider may already have paid it.
export async function settleRefund(
  db: Variables["db"],
  env: Env,
  amendment: Amendment,
  opts: { retryFailed?: boolean } = {},
): Promise<Amendment | null> {
  const allowed = opts.retryFailed ? ["PENDING", "FAILED"] : ["PENDING"];
  if (amendment.status !== "SUCCESS" || !allowed.includes(amendment.refundStatus)) return null;

  const [booking] = await db.select({ userId: bookings.userId, agentId: bookings.agentId }).from(bookings).where(eq(bookings.id, amendment.bookingId)).limit(1);
  const [paid] = await db.select({ gateway: payments.gateway, gatewayPaymentId: payments.gatewayPaymentId, amount: payments.amount, currency: payments.currency })
    .from(payments).where(and(eq(payments.bookingId, amendment.bookingId), eq(payments.status, "SUCCESS"))).limit(1);
  const method = originalRefundMethod(paid, Boolean(booking?.userId));

  const [claimed] = await db.update(bookingAmendments)
    .set({ refundStatus: "PROCESSING", refundMethod: method, refundError: null, updatedAt: new Date() })
    .where(and(eq(bookingAmendments.id, amendment.id), eq(bookingAmendments.status, "SUCCESS"), inArray(bookingAmendments.refundStatus, allowed)))
    .returning();
  if (!claimed) return null;

  const amount = roundMoney(Math.min(Number(claimed.refundAmount ?? 0), Number(claimed.amountPaid)));
  const finish = async (fields: Partial<typeof bookingAmendments.$inferInsert>) => {
    const [row] = await db.update(bookingAmendments).set({ ...fields, updatedAt: new Date() }).where(eq(bookingAmendments.id, claimed.id)).returning();
    return row;
  };
  const done = async (reference: string) => {
    const paidTotal = Number(claimed.amountPaid);
    await db.update(payments)
      .set({ status: amount >= paidTotal ? "REFUNDED" : "PARTIAL_REFUND", refundedAmount: amount.toFixed(2), refundGatewayRef: reference, refundCompletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(payments.bookingId, claimed.bookingId), eq(payments.status, "SUCCESS")));
    await db.update(bookings).set({ status: "REFUNDED", updatedAt: new Date() }).where(eq(bookings.id, claimed.bookingId));
    const row = await finish({ refundStatus: "DONE", refundReference: reference, refundedAt: new Date() });
    // Wallet refunds are instant (the "cancelled" email already says so); card refunds get their own email.
    if (row && amount > 0 && claimed.refundMethod === "NOMOD") await emailCancellation(env, db, row, "REFUNDED");
    return row;
  };

  if (amount <= 0) return done("no-refund-due");

  if (method === "WALLET") {
    const wallet = await getOrCreateCustomerWallet(db, claimed.tenantId, booking!.userId!);
    await creditWallet(db, wallet.id, amount, "REFUND_CREDIT", {
      bookingId: claimed.bookingId, note: `Cancellation refund for booking ${claimed.bookingId.slice(0, 8)}`,
    });
    return done(`wallet:${wallet.id}`);
  }

  if (method === "AGENT_WALLET" && booking?.agentId) {
    const { agentWallet, creditAgentWallet } = await import("./agent-program.js");
    const wallet = await agentWallet(db, claimed.tenantId, booking.agentId);
    if (!wallet) return finish({ refundStatus: "MANUAL_REQUIRED", refundError: "Agency wallet not found." });
    await creditAgentWallet(db, wallet.id, amount, "REFUND_CREDIT", {
      bookingId: claimed.bookingId, note: `Cancellation refund for booking ${claimed.bookingId.slice(0, 8)}`,
    });
    return done(`agent-wallet:${wallet.id}`);
  }

  if (method === "NOMOD") {
    const apiKey = await resolveNomodApiKey(env, claimed.tenantId);
    if (!apiKey) return finish({ refundStatus: "MANUAL_REQUIRED", refundError: "Nomod API key is not configured; refund from the Nomod dashboard." });
    // The charge may be in another currency (e.g. AED): refund the same share of what was actually charged.
    const chargeAmount = roundMoney(amount * Number(paid!.amount) / Number(claimed.amountPaid));
    const outcome = await refundNomodCharge(apiKey, paid!.gatewayPaymentId!, chargeAmount, `Cancellation of booking ${claimed.bookingId.slice(0, 8)}`);
    if (outcome.ok) return done(`nomod:${outcome.refundId}${paid!.currency !== claimed.currency ? ` (${paid!.currency} ${chargeAmount.toFixed(2)})` : ""}`);
    console.error(`[refund] Nomod refund for ${claimed.bookingId}:`, outcome.error);
    return outcome.definite
      ? finish({ refundStatus: "FAILED", refundError: `Nomod HTTP ${outcome.httpStatus}: ${outcome.error}` })
      : finish({ refundStatus: "MANUAL_REQUIRED", refundError: `No response from Nomod (${outcome.error}). Check the Nomod dashboard before retrying.` });
  }

  return finish({ refundStatus: "MANUAL_REQUIRED", refundError: `Paid via ${paid?.gateway ?? "unknown"}: refund manually to the original payment method.` });
}

export function logCancellationCall(c: Ctx, entry: { endpoint: string; level: "INFO" | "WARN" | "ERROR"; bookingId: string; summary?: Record<string, unknown>; snippet?: unknown; errorMessage?: string; errorCode?: string }) {
  const work = logSupplierCall(c.get("db"), {
    tenantId: c.get("tenantId"), supplier: "TRIPJACK", endpoint: entry.endpoint, level: entry.level,
    requestId: entry.bookingId, requestSummary: { bookingId: entry.bookingId, ...(entry.summary ?? {}) },
    responseSnippet: entry.snippet === undefined ? undefined : JSON.stringify(entry.snippet).slice(0, 800),
    errorCode: entry.errorCode, errorMessage: entry.errorMessage,
  });
  try { c.executionCtx.waitUntil(work); } catch { void work; }
}

// Public-facing trip view (never includes internal supplier payloads).
export function publicTrip(trip: NonNullable<Awaited<ReturnType<typeof loadTrip>>>, itinerary: Itinerary | null) {
  const b = trip.booking;
  return {
    id: b.id, status: b.status, pnr: b.pnr ?? itinerary?.pnr ?? null,
    origin: b.origin, destination: b.destination, departureDate: b.departureDate,
    tripType: b.tripType, cabinClass: b.cabinClass, currency: b.currency,
    totalAmount: Number(b.totalAmount), serviceFee: Number(b.markup ?? 0),
    contactEmail: b.contactEmail, contactPhone: b.contactPhone, createdAt: b.createdAt,
    passengers: trip.passengers,
    payments: trip.payments.map(({ gatewayPaymentId: _internal, ...p }) => ({ ...p, amount: Number(p.amount) })),
    cancellations: trip.amendments.filter((a) => a.type === "CANCELLATION").map((a) => ({
      id: a.id, status: a.status, supplierCharges: a.supplierCharges === null ? null : Number(a.supplierCharges),
      refundAmount: a.refundAmount === null ? null : Number(a.refundAmount), refundMethod: a.refundMethod,
      refundStatus: a.refundStatus, refundedAt: a.refundedAt, createdAt: a.createdAt,
    })),
    itinerary,
    eticketAvailable: ["CONFIRMED", "TICKETED"].includes(b.status),
  };
}
