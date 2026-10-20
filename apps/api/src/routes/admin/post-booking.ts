// Admin: cancellations (TripJack amendments) and customer support requests.
//
// GET  /api/admin/cancellations?status=          list
// POST /api/admin/cancellations/:id/refresh      re-check status with TripJack now
// POST /api/admin/cancellations/:id/resolve      manual override (see actions below)
// GET  /api/admin/support-requests?status=       list
// PATCH /api/admin/support-requests/:id          { status?, adminNote? }

import { emailCancellation } from "../../lib/transactional-emails.js";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { bookingAmendments, bookings, payments, supportRequests, users } from "@poomas/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { settleRefund, syncCancellation } from "../../lib/trips.js";

export const cancellationsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

cancellationsAdminRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const rows = await c.get("db").select({
    id: bookingAmendments.id, status: bookingAmendments.status, supplierStatus: bookingAmendments.supplierStatus,
    supplierAmendmentId: bookingAmendments.supplierAmendmentId, amountPaid: bookingAmendments.amountPaid,
    supplierCharges: bookingAmendments.supplierCharges, refundAmount: bookingAmendments.refundAmount,
    currency: bookingAmendments.currency, refundMethod: bookingAmendments.refundMethod, refundedAt: bookingAmendments.refundedAt,
    refundStatus: bookingAmendments.refundStatus, refundReference: bookingAmendments.refundReference, refundError: bookingAmendments.refundError,
    adminNote: bookingAmendments.adminNote, createdAt: bookingAmendments.createdAt, lastCheckedAt: bookingAmendments.lastCheckedAt,
    bookingId: bookings.id, pnr: bookings.pnr, origin: bookings.origin, destination: bookings.destination,
    departureDate: bookings.departureDate, contactEmail: bookings.contactEmail, customerName: users.name,
  })
    .from(bookingAmendments)
    .innerJoin(bookings, eq(bookings.id, bookingAmendments.bookingId))
    .leftJoin(users, eq(users.id, bookingAmendments.userId))
    .where(and(eq(bookingAmendments.tenantId, c.get("tenantId")), status ? eq(bookingAmendments.status, status) : undefined))
    .orderBy(desc(bookingAmendments.createdAt))
    .limit(200);
  return c.json({ cancellations: rows });
});

async function loadAmendment(c: any, id: string) {
  const [a] = await c.get("db").select().from(bookingAmendments)
    .where(and(eq(bookingAmendments.id, id), eq(bookingAmendments.tenantId, c.get("tenantId")))).limit(1);
  if (!a) throw new HTTPException(404, { message: "Cancellation not found" });
  return a as typeof bookingAmendments.$inferSelect;
}

cancellationsAdminRoutes.post("/:id/refresh", async (c) => {
  const a = await loadAmendment(c, c.req.param("id"));
  const updated = await syncCancellation(c, { ...a, lastCheckedAt: null });
  return c.json({ cancellation: updated });
});

// MARK_SUCCESS           TripJack confirmed outside the API: cancel booking and refund to the original payment method
// MARK_REJECTED          TripJack rejected: booking stays as it is
// RETRY_REFUND           retry a refund the payment provider rejected (FAILED)
// MARK_REFUNDED_MANUALLY refund was paid outside POOMAS (e.g. from the Nomod dashboard)
cancellationsAdminRoutes.post("/:id/resolve", zValidator("json", z.object({
  action:       z.enum(["MARK_SUCCESS", "MARK_REJECTED", "RETRY_REFUND", "MARK_REFUNDED_MANUALLY"]),
  refundAmount: z.number().min(0).optional(),
  note:         z.string().trim().min(3).max(500),
})), async (c) => {
  const db = c.get("db");
  const a = await loadAmendment(c, c.req.param("id"));
  const { action, refundAmount, note } = c.req.valid("json");
  const adminNote = `${new Date().toISOString().slice(0, 16)} ${action}: ${note}`;

  if (action === "MARK_REJECTED") {
    const [u] = await db.update(bookingAmendments).set({ status: "REJECTED", adminNote, updatedAt: new Date() })
      .where(and(eq(bookingAmendments.id, a.id), inArray(bookingAmendments.status, ["SUBMITTED", "PROCESSING"]))).returning();
    if (!u) throw new HTTPException(409, { message: `Can't reject a ${a.status} cancellation` });
    c.executionCtx.waitUntil(emailCancellation(c.env, db, u, "REJECTED"));
    return c.json({ cancellation: u });
  }

  if (action === "RETRY_REFUND") {
    const u = await settleRefund(db, c.env, a, { retryFailed: true });
    if (!u) throw new HTTPException(409, { message: "Only a successful cancellation with a pending or failed refund can be retried" });
    return c.json({ cancellation: u });
  }

  if (action === "MARK_REFUNDED_MANUALLY") {
    // Not while PROCESSING: an automatic refund may be mid-flight.
    const [u] = await db.update(bookingAmendments).set({
      refundStatus: "DONE", refundedAt: new Date(), refundReference: `manual: ${note}`.slice(0, 200), refundError: null, adminNote,
      ...(refundAmount !== undefined ? { refundAmount: refundAmount.toFixed(2) } : {}), updatedAt: new Date(),
    }).where(and(eq(bookingAmendments.id, a.id), eq(bookingAmendments.status, "SUCCESS"),
      inArray(bookingAmendments.refundStatus, ["PENDING", "FAILED", "MANUAL_REQUIRED"]))).returning();
    if (!u) throw new HTTPException(409, { message: "Only a successful cancellation whose refund isn't done or in progress can be marked as refunded" });
    const amount = Number(u.refundAmount ?? 0);
    await db.update(payments)
      .set({ status: amount >= Number(u.amountPaid) ? "REFUNDED" : "PARTIAL_REFUND", refundedAmount: amount.toFixed(2), refundGatewayRef: u.refundReference, refundCompletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(payments.bookingId, a.bookingId), eq(payments.status, "SUCCESS")));
    await db.update(bookings).set({ status: "REFUNDED", updatedAt: new Date() }).where(eq(bookings.id, a.bookingId));
    if (amount > 0) c.executionCtx.waitUntil(emailCancellation(c.env, db, u, "REFUNDED"));
    return c.json({ cancellation: u });
  }

  // MARK_SUCCESS
  if (refundAmount === undefined) throw new HTTPException(400, { message: "Enter the refund amount confirmed by TripJack" });
  if (refundAmount > Number(a.amountPaid)) throw new HTTPException(400, { message: "Refund can't exceed the amount paid" });
  const [u] = await db.update(bookingAmendments).set({
    status: "SUCCESS", refundAmount: refundAmount.toFixed(2), adminNote, updatedAt: new Date(),
  }).where(and(eq(bookingAmendments.id, a.id), inArray(bookingAmendments.status, ["SUBMITTED", "PROCESSING"]))).returning();
  if (!u) throw new HTTPException(409, { message: `Can't mark a ${a.status} cancellation as successful` });
  await db.update(bookings).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(bookings.id, a.bookingId));
  await emailCancellation(c.env, db, u, "CONFIRMED");
  const settled = await settleRefund(db, c.env, u);
  return c.json({ cancellation: settled ?? u, refundStatus: settled?.refundStatus ?? u.refundStatus });
});

export const supportAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

supportAdminRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const rows = await c.get("db").select({
    id: supportRequests.id, type: supportRequests.type, message: supportRequests.message, status: supportRequests.status,
    adminNote: supportRequests.adminNote, contactEmail: supportRequests.contactEmail, contactPhone: supportRequests.contactPhone,
    createdAt: supportRequests.createdAt, updatedAt: supportRequests.updatedAt,
    bookingId: supportRequests.bookingId, pnr: bookings.pnr, origin: bookings.origin, destination: bookings.destination,
    departureDate: bookings.departureDate, customerName: users.name,
  })
    .from(supportRequests)
    .leftJoin(bookings, eq(bookings.id, supportRequests.bookingId))
    .leftJoin(users, eq(users.id, supportRequests.userId))
    .where(and(eq(supportRequests.tenantId, c.get("tenantId")), status ? eq(supportRequests.status, status) : undefined))
    .orderBy(desc(supportRequests.createdAt))
    .limit(200);
  return c.json({ requests: rows });
});

supportAdminRoutes.patch("/:id", zValidator("json", z.object({
  status:    z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  adminNote: z.string().trim().max(2000).optional(),
})), async (c) => {
  const body = c.req.valid("json");
  const [row] = await c.get("db").update(supportRequests)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(supportRequests.id, c.req.param("id")), eq(supportRequests.tenantId, c.get("tenantId"))))
    .returning();
  if (!row) throw new HTTPException(404, { message: "Request not found" });
  return c.json({ request: row });
});
