// Admin: cancel an Akbar API booking, and track the Akbar deposit refund and the customer refund.
// Rules and status model: lib/akbar-cancellation.ts, docs/akbar-cancellation.md.
// Full admins only (SUPER_ADMIN, TENANT_ADMIN); settings changes SUPER_ADMIN only.
//
// GET  /api/admin/akbar-cancellation/settings
// PUT  /api/admin/akbar-cancellation/settings                       SUPER_ADMIN
// GET  /api/admin/akbar-cancellation/bookings/:id                   panel: transactions, eligibility, cancellations
// POST /api/admin/akbar-cancellation/bookings/:id/preview           { transactionId } → RetrieveBooking (read-only) + what would be sent
// POST /api/admin/akbar-cancellation/bookings/:id/submit            { transactionId, paxIds, planHash, requestId, reason, confirmPnr }
// POST /api/admin/akbar-cancellation/cancellations/:aid/check-status   RetrieveBooking (read-only)
// POST /api/admin/akbar-cancellation/cancellations/:aid/action      staff verification / deposit / customer refund actions
// POST /api/admin/akbar-cancellation/cancellations/:aid/get-refund  GetRefund — UAT account only, when switched on

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { bookingAmendments, bookings } from "@zamrabooking/db/schema";
import { AKBAR_CANCEL_PATHS, type AkbarCancelPath, type AkbarCancelRequest } from "@zamrabooking/suppliers";
import type { Env, Variables } from "../../types.js";
import { akbarClient, getAkbarSettings, getAkbarToken } from "../../lib/flight-sources.js";
import { collectExchanges, persistExchanges } from "../../lib/api-exchanges.js";
import { acquireBookingLock, logBookingEvent, releaseBookingLock } from "../../lib/booking-recovery.js";
import {
  AKBAR_CANCELLATION, akbarCancelEligibility, akbarCancelTargets, akbarCancellationsOf, akbarGetRefundAllowed,
  applyAkbarCancellationAction, checkAkbarCancellationStatus, getAkbarCancellationConfig, previewAkbarCancellation,
  recordOf, runAkbarGetRefund, saveAkbarCancellationConfig, submitAkbarCancellation, type AkbarCancelDeps,
} from "../../lib/akbar-cancellation.js";

type C = { env: Env; get: <K extends keyof Variables>(k: K) => Variables[K]; executionCtx: { waitUntil(p: Promise<unknown>): void } };

export const akbarCancellationAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const FULL_ADMINS = ["SUPER_ADMIN", "TENANT_ADMIN"];
akbarCancellationAdminRoutes.use("*", async (c, next) => {
  if (!FULL_ADMINS.includes(c.get("userRole") ?? "")) throw new HTTPException(403, { message: "Only admins can cancel Akbar bookings." });
  return next();
});

async function loadBooking(c: C, id: string) {
  const role = c.get("userRole");
  const [b] = await c.get("db").select().from(bookings)
    .where(role === "SUPER_ADMIN" ? eq(bookings.id, id) : and(eq(bookings.id, id), eq(bookings.tenantId, c.get("tenantId"))))
    .limit(1);
  if (!b) throw new HTTPException(404, { message: "Booking not found" });
  return b;
}

async function loadAmendment(c: C, id: string) {
  const role = c.get("userRole");
  const [a] = await c.get("db").select().from(bookingAmendments)
    .where(role === "SUPER_ADMIN" ? eq(bookingAmendments.id, id) : and(eq(bookingAmendments.id, id), eq(bookingAmendments.tenantId, c.get("tenantId"))))
    .limit(1);
  if (!a || a.type !== AKBAR_CANCELLATION) throw new HTTPException(404, { message: "Akbar cancellation not found" });
  return a;
}

// Akbar calls for one booking: every request / response stored (Admin → API logs), token reused.
async function akbarDeps(c: C, tenantId: string, bookingId: string) {
  const settings = await getAkbarSettings(c.env, tenantId);
  const collector = collectExchanges();
  const client = akbarClient(c.env, { ...settings, recorder: collector.recorder } as typeof settings);
  let tokenPromise: ReturnType<typeof getAkbarToken> | null = null;
  const token = () => (tokenPromise ??= getAkbarToken(c.env, tenantId, client));
  const deps: AkbarCancelDeps = {
    db: c.get("db"),
    retrieve: async (transactionId) => client.retrieveBooking(transactionId, await token()),
    cancel: async (request: AkbarCancelRequest, path: AkbarCancelPath) => client.cancel(request, await token(), path),
    event: (level, message, detail) => logBookingEvent(c.env, bookingId, "CANCEL", level, message, detail),
  };
  const persist = () => persistExchanges(c.env, c.get("db"), tenantId, collector.exchanges, { bookingId }).catch((err) => console.error("[akbar-cancel] logs", err));
  return { settings, client, token, deps, persist };
}

// What Admin shows for a cancellation (no Akbar credentials are ever stored in it).
function view(a: typeof bookingAmendments.$inferSelect) {
  const r = recordOf(a);
  return {
    id: a.id, status: a.status, createdAt: a.createdAt, updatedAt: a.updatedAt, lastCheckedAt: a.lastCheckedAt,
    akbarCode: a.supplierStatus, cancellationId: a.supplierAmendmentId, adminNote: a.adminNote,
    amountPaid: a.amountPaid, currency: a.currency,
    customerRefund: { status: a.refundStatus, method: a.refundMethod, amount: a.refundAmount, reference: a.refundReference, error: a.refundError, refundedAt: a.refundedAt },
    record: r,
  };
}

akbarCancellationAdminRoutes.get("/settings", async (c) => {
  const [cfg, akbar] = await Promise.all([getAkbarCancellationConfig(c.env, c.get("tenantId")), getAkbarSettings(c.env, c.get("tenantId"))]);
  return c.json({ settings: cfg, environment: akbar.environment, cancelPaths: AKBAR_CANCEL_PATHS, canEdit: c.get("userRole") === "SUPER_ADMIN" });
});

akbarCancellationAdminRoutes.put("/settings", zValidator("json", z.object({
  liveCancellationEnabled: z.boolean(),
  cancelPath: z.enum(AKBAR_CANCEL_PATHS),
  tuiSource: z.enum(["ITINERARY", "RETRIEVE_BOOKING"]),
  ticketField: z.enum(["EMPTY", "TICKET_NUMBER"]),
  partialPassengerCancellation: z.boolean(),
  getRefundUatEnabled: z.boolean(),
})), async (c) => {
  if (c.get("userRole") !== "SUPER_ADMIN") throw new HTTPException(403, { message: "Only a super admin can change Akbar cancellation settings." });
  const tenantId = c.get("tenantId");
  const before = await getAkbarCancellationConfig(c.env, tenantId);
  const saved = await saveAkbarCancellationConfig(c.env, tenantId, c.req.valid("json"), c.get("userId") ?? null);
  const { auditLogs } = await import("@zamrabooking/db/schema");
  await c.get("db").insert(auditLogs).values({ tenantId, userId: c.get("userId") ?? null, action: "AKBAR_CANCELLATION_SETTINGS", entity: "Tenant", entityId: tenantId, before, after: saved, metadata: {} }).catch(() => {});
  return c.json({ settings: saved });
});

akbarCancellationAdminRoutes.get("/bookings/:id", async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  const db = c.get("db");
  const [cfg, akbar, amendments] = await Promise.all([
    getAkbarCancellationConfig(c.env, b.tenantId), getAkbarSettings(c.env, b.tenantId), db.select().from(bookingAmendments).where(eq(bookingAmendments.bookingId, b.id)),
  ]);
  const targets = akbarCancelTargets(b.flightData as Record<string, any>).map((t) => {
    const e = akbarCancelEligibility(b, amendments, t.transactionId);
    return { ...t, eligible: e.ok, reason: e.ok ? null : e.reason };
  });
  return c.json({
    supplier: b.supplier, bookingStatus: b.status, environment: akbar.environment,
    settings: cfg, getRefund: akbarGetRefundAllowed(akbar.environment, cfg),
    targets, cancellations: (await akbarCancellationsOf(db, b.id)).map(view),
    note: targets.length ? null : "No Akbar transaction was ticketed through the API on this booking: cancel it on Akbar's portal.",
  });
});

akbarCancellationAdminRoutes.post("/bookings/:id/preview", zValidator("json", z.object({ transactionId: z.number().int().positive() })), async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  const db = c.get("db");
  const cfg = await getAkbarCancellationConfig(c.env, b.tenantId);
  const amendments = await db.select().from(bookingAmendments).where(eq(bookingAmendments.bookingId, b.id));
  const { deps, persist } = await akbarDeps(c, b.tenantId, b.id);
  try {
    const p = await previewAkbarCancellation(deps, cfg, b, amendments, c.req.valid("json").transactionId);
    if (!p.ok) return c.json({ ok: false, error: "error" in p ? p.error : "Not available" }, ("status" in p ? p.status : 409) as 409);
    await logBookingEvent(c.env, b.id, "CANCEL", "info", `Akbar cancellation reviewed by staff (transaction ${p.transactionId}) — RetrieveBooking only, nothing cancelled`, { userId: c.get("userId") ?? null });
    return c.json({ ...p, liveCancellationEnabled: cfg.liveCancellationEnabled, bookingPnr: b.pnr });
  } finally { await persist(); }
});

akbarCancellationAdminRoutes.post("/bookings/:id/submit", zValidator("json", z.object({
  transactionId: z.number().int().positive(),
  paxIds: z.array(z.number().int().positive()).min(1).max(20),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  requestId: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
  confirmPnr: z.string().trim().min(5).max(20),
})), async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  const body = c.req.valid("json");
  const cfg = await getAkbarCancellationConfig(c.env, b.tenantId);
  if (!(await acquireBookingLock(c.env, b.id))) return c.json({ ok: false, error: "Another action is running on this booking — wait and reload. Nothing was sent." }, 409);
  const { deps, persist } = await akbarDeps(c, b.tenantId, b.id);
  try {
    const r = await submitAkbarCancellation(deps, cfg, { booking: b, ...body, userId: c.get("userId") ?? null });
    if (!r.ok) return c.json({ ok: false, error: r.error }, r.status as 400);
    return c.json({ ok: true, status: r.status, message: r.message, duplicate: r.duplicate ?? false, bookingCancelled: r.bookingCancelled ?? false, cancellation: view(r.amendment) });
  } finally {
    await persist();
    await releaseBookingLock(c.env, b.id);
  }
});

akbarCancellationAdminRoutes.post("/cancellations/:aid/check-status", async (c) => {
  const a = await loadAmendment(c, c.req.param("aid"));
  const { deps, persist } = await akbarDeps(c, a.tenantId, a.bookingId);
  try {
    const r = await checkAkbarCancellationStatus(deps, a, c.get("userId") ?? null);
    return c.json({ ok: r.ok, error: r.error ?? null, cancellation: view(r.amendment) }, r.ok ? 200 : r.error?.startsWith("Checked") ? 429 : 502);
  } finally { await persist(); }
});

const note = z.string().trim().min(3).max(500);
const money = z.number().min(0).max(10_000_000);
const currency = z.string().trim().regex(/^[A-Z]{3}$/).default("INR");
akbarCancellationAdminRoutes.post("/cancellations/:aid/action", zValidator("json", z.discriminatedUnion("action", [
  z.object({ action: z.literal("WITHDRAW_REQUEST"), note }),
  z.object({ action: z.literal("VERIFIED_CANCELLED"), note, cancellationId: z.string().trim().max(64).optional() }),
  z.object({ action: z.literal("VERIFIED_PENDING"), note }),
  z.object({ action: z.literal("VERIFIED_NOT_CANCELLED"), note }),
  z.object({ action: z.literal("RECORD_SUPPLIER_REFUND"), note, amount: money, currency, source: z.enum(["AKBAR_PORTAL", "AKBAR_STATEMENT", "AKBAR_EMAIL", "GETREFUND_UAT"]) }),
  z.object({ action: z.literal("MARK_DEPOSIT_CREDITED"), note, amount: money, currency, reference: z.string().trim().min(3).max(200) }),
  z.object({ action: z.literal("MARK_DEPOSIT_REFUND_FAILED"), note }),
  z.object({ action: z.literal("REFUND_CUSTOMER"), note, amount: money }),
  z.object({ action: z.literal("RETRY_CUSTOMER_REFUND"), note }),
  z.object({ action: z.literal("CUSTOMER_REFUNDED_MANUALLY"), note, amount: money, reference: z.string().trim().min(3).max(200) }),
])), async (c) => {
  const a = await loadAmendment(c, c.req.param("aid"));
  const act = c.req.valid("json");
  if (!(await acquireBookingLock(c.env, a.bookingId))) return c.json({ ok: false, error: "Another action is running on this booking — wait and reload." }, 409);
  try {
    const r = await applyAkbarCancellationAction(c.get("db"), c.env, a, act, c.get("userId") ?? null);
    if (!r.ok) return c.json({ ok: false, error: r.error }, r.status as 409);
    await logBookingEvent(c.env, a.bookingId, act.action.includes("REFUND") || act.action.includes("DEPOSIT") ? "REFUND" : "CANCEL", "info",
      `Akbar cancellation: ${act.action.toLowerCase().replace(/_/g, " ")} by staff — ${act.note}`, { amendmentId: a.id, userId: c.get("userId") ?? null });
    return c.json({ ok: true, message: r.message, cancellation: view(r.amendment) });
  } finally { await releaseBookingLock(c.env, a.bookingId); }
});

akbarCancellationAdminRoutes.post("/cancellations/:aid/get-refund", async (c) => {
  const a = await loadAmendment(c, c.req.param("aid"));
  const cfg = await getAkbarCancellationConfig(c.env, a.tenantId);
  const { settings, client, token, persist } = await akbarDeps(c, a.tenantId, a.bookingId);
  const allowed = akbarGetRefundAllowed(settings.environment, cfg);
  if (!allowed.ok) return c.json({ ok: false, error: allowed.reason }, 403);
  try {
    const r = await runAkbarGetRefund(c.get("db"), a, async (p) => client.getRefund(p, await token()), c.get("userId") ?? null);
    return c.json({ ok: r.ok, error: r.error ?? null, details: r.details ?? null, cancellation: r.amendment ? view(r.amendment) : null }, r.ok ? 200 : 502);
  } finally { await persist(); }
});
