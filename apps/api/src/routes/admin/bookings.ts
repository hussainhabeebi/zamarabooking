import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  bookings, bookingPassengers, payments, bookingAmendments, supportRequests,
  walletTransactions, supplierExchanges, users, tenants,
} from "@zamrabooking/db/schema";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { isOfflineSupplier } from "../../lib/flight-sources.js";
import { issueOfflineTicket } from "../../lib/offline-ticket.js";
import { eq, and, asc, desc, or } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { tripjackClientFor, parseBookingDetails } from "../../lib/trips.js";
import { buildZip } from "../../lib/zip.js";
import { caseName, certificationCoverage, certificationFileName, certificationPack, certificationRequest, packFolderName, tripFolderName, tripjackHost } from "../../lib/certification.js";
import { tripjackEnvironment } from "../../lib/hotels.js";
import {
  describeError, errorDetail, explainMissingPnr, isTestBooking, logBookingEvent, paidBookingMessage,
  readBookingError, readBookingEvents, readQueueReceipt,
} from "../../lib/booking-recovery.js";
import { processPaidBooking } from "../../queue-consumer.js";
import { akbarCertificationCoverage, akbarCertificationPack, akbarCertificationRequest, akbarStep } from "../../lib/akbar-certification.js";
import { getAkbarSettings } from "../../lib/flight-sources.js";
import { bookOnAkbar, refreshAkbar } from "../../lib/akbar-booking-runner.js";
import { acquireBookingLock, releaseBookingLock } from "../../lib/booking-recovery.js";

export const bookingsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// TENANT_ADMIN sees only their tenant's bookings
// SUPER_ADMIN sees all bookings; optionally filtered by ?tenantId=
bookingsAdminRoutes.get("/", async (c) => {
  const db             = c.get("db");
  const role           = c.get("userRole");
  const filterTenantId = role === "SUPER_ADMIN"
    ? c.req.query("tenantId")   // optional for SUPER_ADMIN
    : c.get("tenantId");        // mandatory for TENANT_ADMIN

  const status  = c.req.query("status");
  const pnr     = c.req.query("pnr");
  const limit   = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset  = parseInt(c.req.query("offset") ?? "0");

  const conditions = [];
  if (filterTenantId) conditions.push(eq(bookings.tenantId, filterTenantId));
  if (status)         conditions.push(eq(bookings.status, status as "CONFIRMED"));
  if (pnr)            conditions.push(eq(bookings.pnr, pnr));

  const rows = await db
    .select()
    .from(bookings)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bookings.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ bookings: rows, total: rows.length });
});

// Force status override (admin only, audit-logged)
bookingsAdminRoutes.patch("/:id/status", async (c) => {
  const { status, note } = await c.req.json() as { status: string; note: string };
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  await db.update(bookings)
    .set({ status: status as "CONFIRMED", updatedAt: new Date() })
    .where(and(eq(bookings.id, c.req.param("id")), eq(bookings.tenantId, tenantId)));

  // TODO: write to audit_logs
  return c.json({ ok: true });
});

// ── Booking detail + raw supplier logs ───────────────────────────────────────

async function loadBooking(c: any, id: string) {
  const role = c.get("userRole");
  const [b] = await c.get("db").select().from(bookings)
    .where(role === "SUPER_ADMIN" ? eq(bookings.id, id) : and(eq(bookings.id, id), eq(bookings.tenantId, c.get("tenantId"))))
    .limit(1);
  if (!b) throw new HTTPException(404, { message: "Booking not found" });
  return b as typeof bookings.$inferSelect;
}

// Exchanges for the booking itself plus the search it was booked from.
function exchangeFilter(b: typeof bookings.$inferSelect) {
  const searchId = (b.flightData as Record<string, unknown> | null)?.searchId;
  return typeof searchId === "string"
    ? or(eq(supplierExchanges.bookingId, b.id), eq(supplierExchanges.searchId, searchId))
    : eq(supplierExchanges.bookingId, b.id);
}

// TripJack certification logs for several bookings: one folder per booking with
// a summary plus numbered request / response JSON files (see lib/certification).
bookingsAdminRoutes.get("/certification.zip", async (c) => {
  const db = c.get("db");
  const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
  if (!ids.length) throw new HTTPException(400, { message: "Pass ?ids=<bookingId>,<bookingId>…" });
  const environment = await tripjackEnvironment(c.env, c.get("tenantId"));
  const files: { name: string; data: Uint8Array; date: Date }[] = [];
  // oneway/DEL-BOM-1A-DIRECT/SearchRequest.json … (TripJack's folder layout)
  const used = new Map<string, number>();
  for (const id of ids) {
    const b = await loadBooking(c, id);
    files.push(...await (b.supplier === "AKBAR"
      ? akbarCertificationPack(c.env, db, b, `akbar/${packFolderName(b, used)}`)
      : certificationPack(c.env, db, b, environment, packFolderName(b, used))));
  }
  return new Response(buildZip(files), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="tripjack-certification-${environment.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.zip"`,
    "Cache-Control": "private, no-store",
  } });
});

bookingsAdminRoutes.get("/:id", async (c) => {
  const db = c.get("db");
  const b = await loadBooking(c, c.req.param("id"));
  const [passengers, paymentRows, amendments, support, walletTx, exchanges, customer] = await Promise.all([
    db.select().from(bookingPassengers).where(eq(bookingPassengers.bookingId, b.id)),
    db.select().from(payments).where(eq(payments.bookingId, b.id)).orderBy(asc(payments.createdAt)),
    db.select().from(bookingAmendments).where(eq(bookingAmendments.bookingId, b.id)).orderBy(desc(bookingAmendments.createdAt)),
    db.select().from(supportRequests).where(eq(supportRequests.bookingId, b.id)).orderBy(desc(supportRequests.createdAt)),
    db.select().from(walletTransactions).where(eq(walletTransactions.bookingId, b.id)).orderBy(asc(walletTransactions.createdAt)),
    db.select().from(supplierExchanges).where(exchangeFilter(b)).orderBy(asc(supplierExchanges.startedAt)),
    b.userId ? db.select({ id: users.id, name: users.name, email: users.email, phone: users.phone }).from(users).where(eq(users.id, b.userId)).limit(1) : Promise.resolve([]),
  ]);
  const waiting = ["PAYMENT_PENDING", "PAYMENT_FAILED"].includes(b.status);
  const queueError = waiting ? await readBookingError(c.env, b.id) : null;
  const paidOrder = paymentRows.find((p) => p.status === "SUCCESS")?.gatewayOrderId;
  const queueReceipt = waiting && paidOrder ? await readQueueReceipt(c.env, paidOrder) : null;
  const paymentConfirmed = Boolean(paidOrder);
  return c.json({
    booking: b, queueError, queueReceipt, paymentConfirmed, events: await readBookingEvents(c.env, b.id), customer: customer[0] ?? null, passengers, payments: paymentRows, cancellations: amendments,
    supportRequests: support, walletTransactions: walletTx,
    exchanges: exchanges.map((x) => ({ ...x, requestKey: undefined, responseKey: undefined, hasResponse: Boolean(x.responseKey) })),
    ...(b.supplier === "TRIPJACK" ? { certification: await certificationCoverage(c.env, db, b, exchanges).catch(() => null) } : {}),
    ...(b.supplier === "AKBAR" ? { certification: await akbarCertificationCoverage(db, b).catch(() => null) } : {}),
  });
});

// One log file exactly as stored: part = "request" | "response".
bookingsAdminRoutes.get("/:id/exchanges/:exchangeId/:part", async (c) => {
  const db = c.get("db");
  const b = await loadBooking(c, c.req.param("id"));
  const part = c.req.param("part");
  if (part !== "request" && part !== "response") throw new HTTPException(400, { message: "part must be request or response" });
  const [x] = await db.select().from(supplierExchanges)
    .where(and(eq(supplierExchanges.id, c.req.param("exchangeId")), exchangeFilter(b)!)).limit(1);
  const key = part === "request" ? x?.requestKey : x?.responseKey;
  if (!x || !key) throw new HTTPException(404, { message: "Log file not found" });
  const obj = await c.env.DOCUMENTS_R2.get(key);
  if (!obj) throw new HTTPException(404, { message: "Log file missing from storage" });
  if (x.supplier === "AKBAR") {
    // Akbar: Akbar's URL, secrets blanked, response unmodified (lib/akbar-certification.ts).
    const akbarName = `${akbarStep(x.endpoint)}-${part === "request" ? "Request" : "Response"}.${key.endsWith(".txt") ? "txt" : "json"}`;
    const data = part === "request"
      ? JSON.stringify(akbarCertificationRequest(await obj.json().catch(() => ({})) as Record<string, any>, await getAkbarSettings(c.env, b.tenantId)), null, 2)
      : obj.body;
    return new Response(data, { headers: {
      "Content-Type": key.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/json", "Content-Disposition": `attachment; filename="${akbarName}"`, "Cache-Control": "private, no-store",
    } });
  }
  const name = certificationFileName(x.endpoint, part, key);
  if (part === "request") {
    // As TripJack received it: TripJack URL, apikey header, body — no gateway secret.
    let stored: Record<string, any> = {};
    try { stored = JSON.parse(await obj.text()); } catch { /* empty */ }
    const host = tripjackHost(await tripjackEnvironment(c.env, c.get("tenantId")));
    return new Response(JSON.stringify(certificationRequest(stored, host), null, 2), { headers: {
      "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store",
    } });
  }
  return new Response(obj.body, { headers: {
    "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store",
  } });
});

// TripJack certification pack for this booking: summary + numbered request /
// response JSON files (responses unchanged; requests as TripJack received them).
bookingsAdminRoutes.get("/:id/exchanges.zip", async (c) => {
  const db = c.get("db");
  const b = await loadBooking(c, c.req.param("id"));
  const name = caseName(b);
  const files = b.supplier === "AKBAR"
    ? await akbarCertificationPack(c.env, db, b, `${tripFolderName(b)}/${name}/`)
    : await certificationPack(c.env, db, b, await tripjackEnvironment(c.env, c.get("tenantId")), `${tripFolderName(b)}/${name}/`);
  if (files.length <= 1) throw new HTTPException(404, { message: "No API logs stored for this booking yet" });
  return new Response(buildZip(files), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${tripFolderName(b)}-${name}.zip"`,
    "Cache-Control": "private, no-store",
  } });
});

// Calls TripJack booking-details now (logged against the booking) and returns the parsed result.
// Re-run the airline booking for a paid booking stuck in PAYMENT_PENDING
// (e.g. the background job could not reach TripJack). Safe to repeat: the
// job skips bookings that are already confirmed or ticketed.
bookingsAdminRoutes.post("/:id/retry-booking", async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  if (b.status !== "PAYMENT_PENDING") throw new HTTPException(400, { message: `Booking is ${b.status} — only paid bookings waiting for the airline can be retried` });
  const message = await paidBookingMessage(c.get("db"), b.id);
  if (!message) throw new HTTPException(400, { message: "No successful payment found for this booking — the payment has not been confirmed by the gateway" });

  // Book directly (not via the queue) so the result or error comes straight back.
  try {
    await processPaidBooking(c.env, message);
  } catch (err) {
    return c.json({ ok: false, error: describeError(err) }, 502);
  }
  const after = await loadBooking(c, b.id);
  if (after.status === "PAYMENT_PENDING") {
    return c.json({ ok: false, error: (await readBookingError(c.env, b.id))?.message ?? "Booking is already being processed — check again in a minute" }, 409);
  }
  return c.json({ ok: true, status: after.status, pnr: after.pnr });
});

bookingsAdminRoutes.post("/:id/refresh-details", async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  if (b.supplier !== "TRIPJACK" || !b.supplierBookingRef) throw new HTTPException(400, { message: "No TripJack booking reference on this booking" });
  const client = await tripjackClientFor(c as any, b.id);
  try {
    const raw = await client.pnrStatus(b.supplierBookingRef);
    const details = parseBookingDetails(raw);
    const root = ((raw as any)?.data ?? (raw as any)?.result ?? raw ?? {}) as any;
    const tickets = details.travellers.map((t) => t.ticketNumber ?? "");
    const allTicketed = tickets.length > 0 && tickets.every(Boolean);
    const reason = explainMissingPnr({
      status: String(details.supplierStatus ?? ""),
      statusMessage: root?.order?.statusMessage ?? root?.status?.statusMessage,
      pnr: details.pnr ?? "",
      passengers: tickets.map((ticketNumber) => ({ ticketNumber })),
    });
    // Save what TripJack now reports so the booking, itinerary and e-ticket catch up.
    if (details.pnr || tickets.some(Boolean)) {
      await c.get("db").update(bookings).set({
        ...(details.pnr ? { pnr: details.pnr } : {}),
        ...(tickets.some(Boolean) ? { ticketNumbers: tickets } : {}),
        ...(["CONFIRMED", "PAYMENT_PENDING"].includes(b.status) && allTicketed ? { status: "TICKETED" as const } : {}),
        updatedAt: new Date(),
      }).where(eq(bookings.id, b.id));
    }
    await logBookingEvent(c.env, b.id, details.pnr && allTicketed ? "TICKET" : "BOOKING_DETAILS",
      (details.pnr && allTicketed) || isTestBooking(details.pnr) ? "info" : "warn", `Admin booking-details check: ${reason}`,
      { orderStatus: details.supplierStatus ?? null, pnr: details.pnr ?? null,
        tickets: details.travellers.map((t) => ({ name: t.name, ticketNumber: t.ticketNumber ?? null })) });
    return c.json({ ok: true, details, reason });
  } catch (err) {
    await logBookingEvent(c.env, b.id, "BOOKING_DETAILS", "error",
      `Admin booking-details check failed: ${describeError(err)}`, errorDetail(err));
    return c.json({ ok: false, error: describeError(err) }, 502);
  }
});

// Akbar API booking for a paid Akbar booking (Admin, MANUAL or AUTO mode): SmartPricer →
// GetSPricer → GetTravelCheckList → CreateItinerary → StartPay → GetItineraryStatus →
// RetrieveBooking. Uses the booking lock; StartPay is never sent twice (lib/akbar-booking.ts).
bookingsAdminRoutes.post("/:id/akbar/book", async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  if (b.supplier !== "AKBAR") throw new HTTPException(400, { message: "Only Akbar bookings can be booked on the Akbar API." });
  if (!(await acquireBookingLock(c.env, b.id))) return c.json({ ok: false, error: "Another run is already booking this seat." }, 409);
  try {
    const r = await bookOnAkbar(c.env, c.get("db"), b.id, { trigger: "ADMIN", userId: c.get("userId") ?? null });
    return c.json(r, r.ok || r.outcome ? 200 : 400);
  } finally {
    await releaseBookingLock(c.env, b.id);
  }
});

// GetItineraryStatus + RetrieveBooking for Akbar legs already paid. Read-only on Akbar.
bookingsAdminRoutes.post("/:id/akbar/refresh", async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  if (b.supplier !== "AKBAR") throw new HTTPException(400, { message: "Not an Akbar booking." });
  if (!(await acquireBookingLock(c.env, b.id))) return c.json({ ok: false, error: "Another run is already working on this booking." }, 409);
  try {
    const r = await refreshAkbar(c.env, c.get("db"), b.id, c.get("userId") ?? null);
    return c.json(r, r.ok || r.outcome ? 200 : 400);
  } finally {
    await releaseBookingLock(c.env, b.id);
  }
});

// Poomas / manual fares: staff issued the ticket themselves (on Poomas or with the
// airline) and enter the PNR here. Saves it, builds the e-ticket and sends it to
// the customer. Can be repeated to correct a PNR or ticket numbers (the e-ticket is
// rebuilt; the confirmation email goes out once per booking).
bookingsAdminRoutes.post("/:id/issue-ticket", zValidator("json", z.object({
  pnr:           z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5,8}$/, "The PNR is 5–8 letters and digits"),
  ticketNumbers: z.array(z.string().trim().max(30)).max(18).default([]),
  supplierRef:   z.string().trim().max(100).optional(),
})), async (c) => {
  const b = await loadBooking(c, c.req.param("id"));
  if (!isOfflineSupplier(b.supplier)) throw new HTTPException(400, { message: "Only Poomas, Akbar and manual fare bookings are ticketed here." });
  if (b.status !== "CONFIRMED" && b.status !== "TICKETED") {
    throw new HTTPException(400, { message: b.status === "PAYMENT_PENDING" ? "The customer hasn't paid for this booking yet." : `This booking is ${b.status}.` });
  }
  const { pnr, supplierRef } = c.req.valid("json");
  const ticketNumbers = c.req.valid("json").ticketNumbers.filter(Boolean);
  const { firstIssue } = await issueOfflineTicket(c.env, c.get("db"), b, { pnr, ticketNumbers, supplierRef, issuedBy: c.get("userId") ?? null, source: "staff" });
  return c.json({ ok: true, pnr, ticketNumbers, emailed: firstIssue });
});
