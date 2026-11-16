// Akbar cancellation + refund tracking (packages/suppliers/src/akbar/cancellation.ts,
// lib/akbar-cancellation.ts, routes/admin/akbar-cancellation.ts). Real PostgreSQL (PGlite, in memory) with
// the repository's own migrations. Akbar is NEVER called: every Akbar answer here is a mock — Akbar's own
// documented samples, plus pending / rejected / timeout / unknown-code cases.
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import * as schema from "@zamrabooking/db/schema";
import {
  AkbarClient, AkbarError, akbarCallNotSent, akbarCancelPlan, akbarCancelResult, akbarRefundDetails,
  type AkbarCancelRequest,
} from "@zamrabooking/suppliers";
import {
  CANCEL_STATUS, DEFAULT_AKBAR_CANCELLATION_CONFIG, akbarCancelEligibility, akbarGetRefundAllowed, akbarPlanHash,
  applyAkbarCancellationAction, buildCancelRequest, cancelRequestTui, checkAkbarCancellationStatus,
  normalizeAkbarCancellationConfig, previewAkbarCancellation, recordOf, submitAkbarCancellation,
  type AkbarCancelDeps, type AkbarCancellationConfig,
} from "../src/lib/akbar-cancellation.js";
import { supplierActionBlocked } from "../src/lib/akbar-failed-booking.js";
import { akbarCancellationAdminRoutes } from "../src/routes/admin/akbar-cancellation.js";
import { cancellationsAdminRoutes } from "../src/routes/admin/post-booking.js";

const MIGRATIONS = new URL("../../../packages/db/drizzle/migrations/", import.meta.url);
const migrationSql = (f: string) => readFileSync(new URL(f, MIGRATIONS), "utf8").replace(/CREATE EXTENSION[^;]*;/gi, "");

let pg: PGlite;
let db: any;
const T = "tenant-akbar-cancel-test";
const TX = 240036938;
const ITIN_TUI = "bdfcbf47-265e-4482-9251-b840c9b7ba75|89641032-08b5-4609-89b4-1529789aa185|20241119184642";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async list() { return { keys: [], list_complete: true }; },
  };
}
let env: any;

before(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(migrationSql(f));
  db = drizzle(pg, { schema });
  await pg.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Akbar cancel test', 'akbar-cancel-test')`, [T]);
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM wallet_transactions; DELETE FROM booking_amendments; DELETE FROM payments; DELETE FROM booking_passengers; DELETE FROM bookings; DELETE FROM audit_logs;`);
  env = { TENANT_CACHE_KV: memoryKv(), FARE_CACHE_KV: memoryKv(), SESSIONS_KV: memoryKv(), ENVIRONMENT: "test" };
});

// ── Akbar answers (mocks) ─────────────────────────────────────────────────────

// RetrieveBooking in the UAT certification shape: Pax[].ID linked to TicketInfo[].PaxID.
function retrieve(pax: { id: number; ticket: string; first?: string; last?: string }[], over: Record<string, unknown> = {}) {
  return {
    Code: "200", Msg: ["Success"], TransactionID: TX, TUI: "retrieve-tui|x|20261116", Status: "TO0",
    Pax: pax.map((p, i) => ({ ID: p.id, PaxID: i + 1, ...(p.first ? { FName: p.first, LName: p.last, Title: "Mr" } : {}) })),
    Trips: [{ Journey: [{ Segments: [{ Flight: { CRSPNR: "WP6SJY", APNR: "WP6SJY", DepartureCode: "COK", ArrivalCode: "DXB",
      TicketInfo: pax.map((p) => ({ PaxID: p.id, TicketNo: p.ticket, Status: "TO0" })) } }] }] }],
    ...over,
  };
}
const ONE = [{ id: 27693, ticket: "0987654321001", first: "Asha", last: "Nair" }];
const TWO = [...ONE, { id: 27694, ticket: "0987654321002", first: "Ravi", last: "Nair" }];

// Akbar's Cancel document response.
const DOC_SUCCESS = { TUI: "bdfcbf47-265e-4482-9251-b840c9b7ba75|8182b8c6-d1f6-4216-b3e1-9cd3efb8de39|20241119184651", TransactionID: TX, CancellationID: 240003849, Code: "1903", Msg: ["Auto Cancellation Success"] };

function mockAkbar(opts: { retrieve?: unknown | (() => unknown); cancel?: unknown | ((r: AkbarCancelRequest) => unknown); delayMs?: number } = {}) {
  const calls = { retrieve: 0, cancel: [] as { request: AkbarCancelRequest; path: string }[] };
  const deps: AkbarCancelDeps = {
    db,
    retrieve: async () => { calls.retrieve++; const r = opts.retrieve ?? retrieve(ONE); return typeof r === "function" ? (r as () => unknown)() : r; },
    cancel: async (request, path) => {
      calls.cancel.push({ request, path });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const c = opts.cancel ?? DOC_SUCCESS;
      return typeof c === "function" ? (c as (r: AkbarCancelRequest) => unknown)(request) : c;
    },
    event: async () => {},
  };
  return { calls, deps };
}

const ON: AkbarCancellationConfig = { ...DEFAULT_AKBAR_CANCELLATION_CONFIG, liveCancellationEnabled: true };

// ── Bookings ──────────────────────────────────────────────────────────────────

const future = (days: number) => new Date(Date.now() + days * 86_400_000);

async function addBooking(over: { id?: string; status?: string; supplier?: string; departure?: Date; flightData?: Record<string, unknown>; userId?: string | null } = {}) {
  const id = over.id ?? crypto.randomUUID();
  const fd = over.flightData ?? {
    offline: { ticketing: "ISSUED" },
    akbarBooking: { runs: 1, startedAt: "2026-11-01T00:00:00Z", outcome: "TICKETED", legs: [
      { leg: 0, state: "SUCCESS", transactionId: TX, itineraryTui: ITIN_TUI, paymentSentAt: "2026-11-01T00:01:00Z", status: "Success", pnrs: ["WP6SJY"], tickets: ["0987654321001"] },
    ] },
  };
  await pg.query(`INSERT INTO bookings (id, tenant_id, channel, status, trip_type, cabin_class, origin, destination, departure_date, flight_data, adult_count, base_fare, taxes, markup, total_amount, currency, supplier, contact_email, contact_phone, pnr, ticket_numbers, supplier_booking_ref, user_id)
    VALUES ($1, $2, 'B2C_WEB', $3, 'ONEWAY', 'ECONOMY', 'COK', 'DXB', $4, $5::jsonb, 1, 9000, 1000, 400, 10400, 'INR', $6, 'a@example.com', '9999999999', 'WP6SJY', ARRAY['0987654321001'], $7, $8)`,
    [id, T, over.status ?? "TICKETED", over.departure ?? future(20), JSON.stringify(fd), over.supplier ?? "AKBAR", String(TX), over.userId ?? null]);
  return id;
}
const bookingRow = async (id: string) => (await db.select().from(schema.bookings).where((await import("drizzle-orm")).eq(schema.bookings.id, id)))[0];
const amendmentsOf = async (id: string) => (await pg.query<any>(`SELECT * FROM booking_amendments WHERE booking_id = $1 ORDER BY created_at`, [id])).rows;

async function prepared(bookingId: string, deps: AkbarCancelDeps, cfg = ON) {
  const b = await bookingRow(bookingId);
  const p = await previewAkbarCancellation(deps, cfg, b, [], TX);
  assert.ok(p.ok, JSON.stringify(p));
  return { b, p: p as Extract<typeof p, { planHash: string }> };
}

async function submit(bookingId: string, deps: AkbarCancelDeps, over: Partial<{ paxIds: number[]; planHash: string; requestId: string; confirmPnr: string }> = {}, cfg = ON) {
  const { b, p } = await prepared(bookingId, deps, cfg);
  return submitAkbarCancellation(deps, cfg, {
    booking: await bookingRow(bookingId), transactionId: TX, paxIds: over.paxIds ?? p.passengers.map((x) => x.id), planHash: over.planHash ?? p.planHash,
    requestId: over.requestId ?? crypto.randomUUID(), reason: "Customer asked to cancel", confirmPnr: over.confirmPnr ?? "WP6SJY", userId: null,
  }).then((r) => ({ r, b }));
}

// ── Akbar's documents: request and response handling ──────────────────────────

test("RetrieveBooking → passengers, tickets and segments to cancel; nothing guessed when data is missing", () => {
  const plan = akbarCancelPlan(retrieve(TWO), TX);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.pnrs, ["WP6SJY"]);
  assert.deepEqual(plan.passengers.map((p) => [p.id, p.name, p.tickets]), [[27693, "Mr Asha Nair", ["0987654321001"]], [27694, "Mr Ravi Nair", ["0987654321002"]]]);
  assert.equal(plan.segments[0].route, "COK-DXB");

  // No TicketInfo: which passenger is on which segment is unknown → refused, not assumed.
  const noTickets = akbarCancelPlan({ ...retrieve(ONE), Trips: [{ Journey: [{ Segments: [{ Flight: { CRSPNR: "WP6SJY" } }] }] }] }, TX);
  assert.ok(noTickets.problems.some((p) => /lists no passengers/.test(p)));
  // Another transaction's answer → refused.
  assert.ok(akbarCancelPlan(retrieve(ONE, { TransactionID: 1 }), TX).problems.some((p) => /not 240036938/.test(p)));
  // No CRSPNR → refused.
  const noPnr = retrieve(ONE); (noPnr.Trips[0].Journey[0].Segments[0].Flight as any).CRSPNR = "";
  assert.ok(akbarCancelPlan(noPnr, TX).problems.some((p) => /no CRSPNR/.test(p)));
});

test("Cancel answer: only Akbar's documented 1903 (with CancellationID, same transaction) counts as cancelled", () => {
  const ok = akbarCancelResult(DOC_SUCCESS, TX);
  assert.equal(ok.kind, "CONFIRMED");
  assert.equal(ok.cancellationId, "240003849");
  for (const [answer, why] of [
    [{ ...DOC_SUCCESS, Code: "1904", Msg: ["Cancellation in progress"] }, /Code 1904.*not documented/],
    [{ ...DOC_SUCCESS, Code: "200" }, /Code 200/],
    [{ ...DOC_SUCCESS, TransactionID: 1 }, /transaction 1 instead/],
    [{ ...DOC_SUCCESS, CancellationID: 0 }, /no CancellationID/],
    [{ Msg: ["Something"] }, /no Code/],
    [null, /no Code/],
  ] as const) {
    const r = akbarCancelResult(answer, TX);
    assert.equal(r.kind, "UNKNOWN");
    assert.match((r as any).reason, why);
  }
});

test("a failed call counts as 'not sent' only when our gateway refused it before forwarding", () => {
  const gw = (status: number, error: string) => new AkbarError("x", status, "/Flights/Cancel", JSON.stringify({ error, requestId: "r" }));
  assert.equal(akbarCallNotSent(gw(404, "UNSUPPORTED_AKBAR_ROUTE")), true);
  assert.equal(akbarCallNotSent(gw(401, "GATEWAY_AUTHENTICATION_FAILED")), true);
  assert.equal(akbarCallNotSent(gw(429, "GATEWAY_RATE_LIMITED")), true);
  assert.equal(akbarCallNotSent(new AkbarError("Akbar: AKBAR_GATEWAY_KEY is not set on the Worker")), true);
  // After the gateway forwarded it, or from Akbar itself: uncertain.
  assert.equal(akbarCallNotSent(gw(504, "AKBAR_TIMEOUT")), false);
  assert.equal(akbarCallNotSent(gw(502, "AKBAR_GATEWAY_FAILURE")), false);
  assert.equal(akbarCallNotSent(new AkbarError("Akbar /Flights/Cancel timed out after 60s", 504, "/Flights/Cancel")), false);
  assert.equal(akbarCallNotSent(new AkbarError("failed", 400, "/Flights/Cancel", '{"Code":"400","Msg":["Invalid"]}')), false);
  assert.equal(akbarCallNotSent(new TypeError("fetch failed")), false);
});

test("GetRefund answer (Akbar's sample): amounts per line as written, transaction mismatch flagged, no totals invented", () => {
  const doc = { TUI: "c5201985|3fd8e2c8|20260115104800", transactionID: 254268843, Code: "200", Msg: ["Success"], Trips: [{ destOrgin: "HSR-CCU", travelType: "O", refundable: true, fuId: "1,2",
    Itineraries: [{ from: "HSR", to: "CCU", travelType: "O", tripType: "D", paxtype: "A", atoCharge: 60.0, providerCharge: "1100.0", refundAmount: 8230.0, netAmount: 9390.0, cancellationCharge: 1160.0, rafCharge: 0.0, stfCharge: 0.0, K3Charge: 55.0, VATONATOCancelCharges: 0.0 }] }] };
  const d = akbarRefundDetails(doc, 250702203);
  assert.equal(d.ok, true);
  assert.equal(d.transactionIdMatches, false);     // the document's own sample answers for another transaction
  assert.deepEqual(d.trips[0].lines[0], { from: "HSR", to: "CCU", travelType: "O", tripType: "D", paxType: "A", cancellationCharge: 1160, providerCharge: 1100, atoCharge: 60, k3Charge: 55, rafCharge: 0, stfCharge: 0, vatOnAtoCancelCharges: 0, netAmount: 9390, refundAmount: 8230 });
  assert.equal("total" in d, false);
});

test("client: Cancel goes to the configured documented path only; GetRefund to /Flights/GetRefund", async () => {
  const seen: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { seen.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(DOC_SUCCESS), { status: 200 }); }) as unknown as typeof fetch;
  const client = new AkbarClient({ utilsUrl: "https://utils.test", flightsUrl: "https://flights.test", merchantId: "m", apiKey: "k", clientId: "cid", password: "p", agentCode: "a", browserKey: "b" } as any, fetchImpl);
  const req: AkbarCancelRequest = { transactionId: TX, tui: ITIN_TUI, segments: [{ trip: 0, journey: 0, crsPnr: "WP6SJY", pax: [{ id: 27693, ticket: "" }] }] };
  await client.cancel(req, { token: "jwt", clientId: "cid" } as any);
  await client.cancel(req, { token: "jwt", clientId: "cid" } as any, "/Flights//Flights/Cancel");
  await assert.rejects(client.cancel(req, { token: "jwt", clientId: "cid" } as any, "/Flights/CancelAll" as any), /not one of the documented paths/);
  await client.getRefund({ tui: "t", transactionId: TX }, { token: "jwt", clientId: "cid" } as any);
  assert.deepEqual(seen.map((s) => s.url), ["https://flights.test/Flights/Cancel", "https://flights.test/Flights//Flights/Cancel", "https://flights.test/Flights/GetRefund"]);
  assert.deepEqual(seen[0].body, { ClientID: "cid", ClientIP: "", Remarks: "", TUI: ITIN_TUI, TransactionID: TX, Trips: [{ Journey: [{ Segments: [{ CRSPNR: "WP6SJY", Pax: [{ ID: 27693, Ticket: "" }] }] }] }], Isfullrefund: false, CancelType: "R" });
  assert.deepEqual(seen[2].body, { TUI: "t", TransactionId: TX, CancelType: "R" });
});

// ── Settings ──────────────────────────────────────────────────────────────────

test("settings: live cancellation off by default; only documented values can be set", () => {
  assert.equal(DEFAULT_AKBAR_CANCELLATION_CONFIG.liveCancellationEnabled, false);
  assert.equal(DEFAULT_AKBAR_CANCELLATION_CONFIG.partialPassengerCancellation, false);
  assert.equal(DEFAULT_AKBAR_CANCELLATION_CONFIG.getRefundUatEnabled, false);
  const n = normalizeAkbarCancellationConfig({ liveCancellationEnabled: "yes", cancelPath: "/Flights/Delete", tuiSource: "X", ticketField: "Y", cancelType: "F", Isfullrefund: true });
  assert.deepEqual({ ...n, updatedAt: null }, { ...DEFAULT_AKBAR_CANCELLATION_CONFIG, updatedAt: null });
  assert.equal("cancelType" in n, false);
});

test("GetRefund is never allowed on the production Akbar account", () => {
  assert.equal(akbarGetRefundAllowed("PRODUCTION", { ...ON, getRefundUatEnabled: true }).ok, false);
  assert.equal(akbarGetRefundAllowed("UAT", ON).ok, false);
  assert.equal(akbarGetRefundAllowed("UAT", { ...ON, getRefundUatEnabled: true }).ok, true);
});

// ── Eligibility ───────────────────────────────────────────────────────────────

test("only Akbar API-ticketed, not departed, non-group bookings are eligible", async () => {
  const ok = await bookingRow(await addBooking());
  assert.equal(akbarCancelEligibility(ok, [], TX).ok, true);
  assert.match((akbarCancelEligibility(ok, [], 999) as any).reason, /No Akbar API transaction/);
  assert.match((akbarCancelEligibility(await bookingRow(await addBooking({ supplier: "MANUAL" })), [], TX) as any).reason, /Only Akbar/);
  assert.match((akbarCancelEligibility(await bookingRow(await addBooking({ flightData: { offline: { groupFare: { manualFareId: "g" } } } })), [], TX) as any).reason, /Group fare/);
  assert.match((akbarCancelEligibility(await bookingRow(await addBooking({ departure: new Date(Date.now() - 3600_000) })), [], TX) as any).reason, /departed/);
  assert.match((akbarCancelEligibility(await bookingRow(await addBooking({ status: "PAYMENT_PENDING" })), [], TX) as any).reason, /PAYMENT_PENDING/);
  // Ticketed by staff on Akbar's portal (no API transaction): cancel on the portal.
  assert.equal(akbarCancelEligibility(await bookingRow(await addBooking({ flightData: { offline: { ticketing: "ISSUED" } } })), [], TX).ok, false);
});

// ── Submitting ────────────────────────────────────────────────────────────────

test("live cancellation switched off: nothing recorded, nothing sent", async () => {
  const id = await addBooking();
  const { calls, deps } = mockAkbar();
  const { r } = await submit(id, deps, {}, DEFAULT_AKBAR_CANCELLATION_CONFIG);
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 403);
  assert.equal(calls.cancel.length, 0);
  assert.equal((await amendmentsOf(id)).length, 0);
});

test("success (Akbar's documented answer): CANCELLED, booking CANCELLED, nothing refunded, original data kept", async () => {
  const id = await addBooking();
  await pg.query(`INSERT INTO payments (booking_id, gateway, amount, currency, status, gateway_order_id) VALUES ($1, 'PHONEPE', 10400, 'INR', 'SUCCESS', 'ord-1')`, [id]);
  const before = await bookingRow(id);
  const { calls, deps } = mockAkbar();
  const { r } = await submit(id, deps);
  assert.equal(r.ok, true);
  assert.equal((r as any).status, CANCEL_STATUS.CANCELLED);
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.cancel[0].path, "/Flights/Cancel");
  assert.deepEqual(calls.cancel[0].request, { transactionId: TX, tui: ITIN_TUI, remarks: "", clientIp: "", segments: [{ trip: 0, journey: 0, crsPnr: "WP6SJY", pax: [{ id: 27693, ticket: "" }] }] });

  const [a] = await amendmentsOf(id);
  assert.equal(a.type, "AKBAR_CANCELLATION");
  assert.equal(a.status, "CANCELLED");
  assert.equal(a.supplier_amendment_id, "240003849");
  assert.equal(a.supplier_status, "1903");
  assert.equal(a.refund_status, "NOT_STARTED");                    // customer refund: not started
  assert.equal(a.quote.supplierRefund.status, "REFUND_PENDING");    // Akbar deposit refund: not verified
  assert.equal(a.quote.originalTui, ITIN_TUI);
  assert.equal(a.quote.requestTui, ITIN_TUI);
  assert.deepEqual(a.quote.history.map((h: any) => h.event), ["REQUESTED", "SENT", "AKBAR_CONFIRMED"]);
  assert.equal(a.quote.response.cancellationId, "240003849");
  assert.equal(JSON.stringify(a.quote).includes("cid"), false);   // no ClientID / credentials stored

  const after = await bookingRow(id);
  assert.equal(after.status, "CANCELLED");
  assert.equal(after.pnr, before.pnr);
  assert.deepEqual(after.ticketNumbers, before.ticketNumbers);
  assert.equal(after.supplierBookingRef, before.supplierBookingRef);
  assert.deepEqual((after.flightData as any).akbarBooking, (before.flightData as any).akbarBooking);
  const pay = (await pg.query<any>(`SELECT status, refunded_amount FROM payments WHERE booking_id = $1`, [id])).rows[0];
  assert.deepEqual(pay, { status: "SUCCESS", refunded_amount: null });   // payment untouched
  // No further Akbar run / ticket issue on this booking.
  assert.match(supplierActionBlocked(after.flightData as any, "issue-ticket") ?? "", /Akbar cancellation exists/);
});

for (const [label, cancel, expected] of [
  ["pending / unknown code", { ...DOC_SUCCESS, Code: "1905", Msg: ["Cancellation request queued"], CancellationID: 0 }, "MANUAL_VERIFICATION_REQUIRED"],
  ["rejection (HTTP 400 from Akbar)", () => { throw new AkbarError("Akbar /Flights/Cancel failed (HTTP 400)", 400, "/Flights/Cancel", '{"Code":"400","Msg":["Ticket already cancelled"]}'); }, "MANUAL_VERIFICATION_REQUIRED"],
  ["timeout", () => { throw new AkbarError("Akbar /Flights/Cancel timed out after 60s", 504, "/Flights/Cancel"); }, "MANUAL_VERIFICATION_REQUIRED"],
  ["network error", () => { throw new TypeError("fetch failed"); }, "MANUAL_VERIFICATION_REQUIRED"],
] as const) {
  test(`${label}: MANUAL_VERIFICATION_REQUIRED, never retried, booking unchanged, no second request`, async () => {
    const id = await addBooking();
    const { calls, deps } = mockAkbar({ cancel });
    const { r } = await submit(id, deps);
    assert.equal(r.ok, true);
    assert.equal((r as any).status, expected);
    assert.match((r as any).message, /Do not cancel again/);
    assert.equal(calls.cancel.length, 1);
    assert.equal((await bookingRow(id)).status, "TICKETED");
    const [a] = await amendmentsOf(id);
    assert.equal(a.status, expected);
    assert.equal(a.quote.supplierRefund.status, "NOT_APPLICABLE");
    // A second cancellation is refused while this one is unresolved.
    const again = await submitAkbarCancellation(deps, ON, { booking: await bookingRow(id), transactionId: TX, paxIds: [27693], planHash: a.quote.planHash, requestId: crypto.randomUUID(), reason: "again please", confirmPnr: "WP6SJY", userId: null });
    assert.equal(again.ok, false);
    assert.equal(calls.cancel.length, 1);
  });
}

test("refused by our gateway before forwarding: CANCELLATION_FAILED, nothing cancelled, a new request is allowed", async () => {
  const id = await addBooking();
  let first = true;
  const { calls, deps } = mockAkbar({ cancel: () => {
    if (first) { first = false; throw new AkbarError("Akbar /Flights/Cancel failed (HTTP 404)", 404, "/Flights/Cancel", '{"error":"UNSUPPORTED_AKBAR_ROUTE","requestId":"r"}'); }
    return DOC_SUCCESS;
  } });
  const { r } = await submit(id, deps);
  assert.equal((r as any).status, CANCEL_STATUS.FAILED);
  assert.match((r as any).message, /Not sent to Akbar/);
  assert.equal((await bookingRow(id)).status, "TICKETED");
  assert.equal(((await bookingRow(id)).flightData as any).akbarCancellation?.[String(TX)], undefined);
  const { r: r2 } = await submit(id, deps);
  assert.equal((r2 as any).status, CANCEL_STATUS.CANCELLED);
  assert.equal(calls.cancel.length, 2);
});

test("the same confirmation sent twice returns the first result and sends once", async () => {
  const id = await addBooking();
  const { calls, deps } = mockAkbar();
  const requestId = crypto.randomUUID();
  const { r } = await submit(id, deps, { requestId });
  const r2 = await submitAkbarCancellation(deps, ON, { booking: await bookingRow(id), transactionId: TX, paxIds: [27693], planHash: "0".repeat(64), requestId, reason: "double click", confirmPnr: "WP6SJY", userId: null });
  assert.equal(r.ok && r2.ok, true);
  assert.equal((r2 as any).duplicate, true);
  assert.equal((r2 as any).amendment.id, (r as any).amendment.id);
  assert.equal(calls.cancel.length, 1);
});

test("concurrent cancellation attempts (two admins at once): exactly one is sent", async () => {
  const id = await addBooking();
  const { calls, deps } = mockAkbar({ delayMs: 20 });
  const { p } = await prepared(id, deps);
  const attempt = async () => submitAkbarCancellation(deps, ON, { booking: await bookingRow(id), transactionId: TX, paxIds: [27693], planHash: p.planHash, requestId: crypto.randomUUID(), reason: "Customer asked", confirmPnr: "WP6SJY", userId: null });
  const results = await Promise.all([attempt(), attempt(), attempt(), attempt()]);
  assert.equal(calls.cancel.length, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await amendmentsOf(id)).length, 1);
});

test("multi-passenger booking: every passenger by default; one passenger alone is refused (never widened) unless partial is allowed", async () => {
  const id = await addBooking();
  const { calls, deps } = mockAkbar({ retrieve: retrieve(TWO) });
  // One of two selected, partial not confirmed by Akbar → refused, nothing sent.
  const { r } = await submit(id, deps, { paxIds: [27694] });
  assert.equal(r.ok, false);
  assert.match((r as any).error, /select every passenger/);
  assert.equal(calls.cancel.length, 0);
  assert.equal((await amendmentsOf(id)).length, 0);

  // Partial allowed by an admin: ONLY the selected passenger is sent; the booking stays ticketed.
  const partial = { ...ON, partialPassengerCancellation: true };
  const { r: r2 } = await submit(id, deps, { paxIds: [27694] }, partial);
  assert.equal((r2 as any).status, CANCEL_STATUS.CANCELLED);
  assert.deepEqual(calls.cancel[0].request.segments[0].pax, [{ id: 27694, ticket: "" }]);
  assert.equal((await bookingRow(id)).status, "TICKETED");
  assert.equal((await amendmentsOf(id))[0].quote.partial, true);
});

test("multi-passenger booking, all selected: both passengers in one request; ticket numbers only when configured", async () => {
  const id = await addBooking();
  const { calls, deps } = mockAkbar({ retrieve: retrieve(TWO) });
  const cfg = { ...ON, ticketField: "TICKET_NUMBER" as const };
  const { r } = await submit(id, deps, {}, cfg);
  assert.equal((r as any).status, CANCEL_STATUS.CANCELLED);
  assert.deepEqual(calls.cancel[0].request.segments[0].pax, [{ id: 27693, ticket: "0987654321001" }, { id: 27694, ticket: "0987654321002" }]);
});

test("Akbar's booking changed after the review, or the PNR isn't typed: refused, nothing sent", async () => {
  const id = await addBooking();
  let n = 0;
  const { calls, deps } = mockAkbar({ retrieve: () => (n++ === 0 ? retrieve(ONE) : retrieve([{ ...ONE[0], ticket: "0987654321999" }])) });
  const { r } = await submit(id, deps);
  assert.equal(r.ok, false);
  assert.match((r as any).error, /changed since you reviewed/);
  const { deps: deps2, calls: calls2 } = mockAkbar();
  const { r: r2 } = await submit(id, deps2, { confirmPnr: "ABCDEF" });
  assert.equal(r2.ok, false);
  assert.match((r2 as any).error, /Type the PNR/);
  assert.equal(calls.cancel.length + calls2.cancel.length, 0);
});

test("TUI: the booking's own TUI by default; RetrieveBooking's only when configured; missing TUI refused", async () => {
  const plan = akbarCancelPlan(retrieve(ONE), TX);
  const target = { transactionId: TX, legs: [0], itineraryTui: ITIN_TUI, pnrs: [], tickets: [] };
  assert.equal(cancelRequestTui(ON, target, plan).tui, ITIN_TUI);
  assert.equal(cancelRequestTui({ ...ON, tuiSource: "RETRIEVE_BOOKING" }, target, plan).tui, "retrieve-tui|x|20261116");
  assert.ok(cancelRequestTui(ON, { ...target, itineraryTui: "" }, plan).problem);
  assert.equal(buildCancelRequest(plan, [27693], ON, "").request, null);
  assert.notEqual(await akbarPlanHash(plan, "a"), await akbarPlanHash(plan, "b"));
});

// ── After the send: verification, status checks, deposit and customer refunds ────

async function manualCase() {
  const id = await addBooking();
  const { deps } = mockAkbar({ cancel: () => { throw new AkbarError("timed out", 504, "/Flights/Cancel"); } });
  await submit(id, deps);
  const [row] = await db.select().from(schema.bookingAmendments).where((await import("drizzle-orm")).eq(schema.bookingAmendments.bookingId, id));
  return { id, a: row, deps };
}
const reload = async (aid: string) => (await db.select().from(schema.bookingAmendments).where((await import("drizzle-orm")).eq(schema.bookingAmendments.id, aid)))[0];

test("manual verification: confirmed on Akbar's portal → CANCELLED; confirmed not cancelled → FAILED and re-requestable", async () => {
  let { id, a } = await manualCase();
  let r = await applyAkbarCancellationAction(db, env, a, { action: "VERIFIED_PENDING", note: "Akbar portal shows in progress" }, null);
  assert.equal(r.ok && r.amendment.status, "CANCELLATION_PENDING");
  r = await applyAkbarCancellationAction(db, env, await reload(a.id), { action: "VERIFIED_CANCELLED", note: "Portal shows cancelled", cancellationId: "240003850" }, null);
  assert.equal(r.ok && r.amendment.status, "CANCELLED");
  assert.equal((await reload(a.id)).supplierAmendmentId, "240003850");
  assert.equal(recordOf(await reload(a.id))!.supplierRefund.status, "REFUND_PENDING");
  assert.equal((await bookingRow(id)).status, "CANCELLED");
  // Can't be "verified" twice.
  assert.equal((await applyAkbarCancellationAction(db, env, await reload(a.id), { action: "VERIFIED_NOT_CANCELLED", note: "oops" }, null)).ok, false);

  ({ id, a } = await manualCase());
  r = await applyAkbarCancellationAction(db, env, a, { action: "VERIFIED_NOT_CANCELLED", note: "Portal shows ticket still active" }, null);
  assert.equal(r.ok && r.amendment.status, "CANCELLATION_FAILED");
  assert.equal((await bookingRow(id)).status, "TICKETED");
  assert.equal(akbarCancelEligibility(await bookingRow(id), [await reload(a.id)], TX).ok, true);
});

test("check latest status: RetrieveBooking stored as Akbar wrote it, status unchanged; a send with no answer becomes manual", async () => {
  const { a } = await manualCase();
  const { deps } = mockAkbar({ retrieve: retrieve([{ ...ONE[0] }], { Status: "XX9" }) });
  await pg.query(`UPDATE booking_amendments SET last_checked_at = now() - interval '1 minute' WHERE id = $1`, [a.id]);
  const r = await checkAkbarCancellationStatus(deps, await reload(a.id), null);
  assert.equal(r.ok, true);
  assert.equal(r.amendment.status, "MANUAL_VERIFICATION_REQUIRED");
  assert.equal(recordOf(r.amendment)!.statusChecks.at(-1)!.bookingStatus, "XX9");
  // Too soon again.
  assert.equal((await checkAkbarCancellationStatus(deps, r.amendment, null)).ok, false);

  // Stuck PROCESSING (the Worker stopped mid-send): after 2 minutes → manual verification.
  await pg.query(`UPDATE booking_amendments SET status = 'CANCELLATION_PROCESSING', last_checked_at = NULL, quote = quote || '{"sentAt":"2026-01-01T00:00:00Z"}'::jsonb WHERE id = $1`, [a.id]);
  const stuck = await checkAkbarCancellationStatus(deps, await reload(a.id), null);
  assert.equal(stuck.amendment.status, "MANUAL_VERIFICATION_REQUIRED");
});

test("withdraw: only a request that was never sent", async () => {
  const id = await addBooking();
  const { a } = await manualCase();
  assert.equal((await applyAkbarCancellationAction(db, env, a, { action: "WITHDRAW_REQUEST", note: "changed mind" }, null)).ok, false);
  await pg.query(`UPDATE booking_amendments SET status = 'CANCELLATION_REQUESTED' WHERE id = $1`, [a.id]);
  const r = await applyAkbarCancellationAction(db, env, await reload(a.id), { action: "WITHDRAW_REQUEST", note: "changed mind" }, null);
  assert.equal(r.ok && r.amendment.status, "CANCELLATION_FAILED");
  void id;
});

test("Akbar deposit refund: pending until staff verify the credit; failure and delayed credit recorded; never automatic", async () => {
  const id = await addBooking();
  const { deps } = mockAkbar();
  await submit(id, deps);
  let [a] = await db.select().from(schema.bookingAmendments).where((await import("drizzle-orm")).eq(schema.bookingAmendments.bookingId, id));
  assert.equal(recordOf(a)!.supplierRefund.status, "REFUND_PENDING");
  let r = await applyAkbarCancellationAction(db, env, a, { action: "RECORD_SUPPLIER_REFUND", note: "Akbar portal refund details", amount: 8230, currency: "INR", source: "AKBAR_PORTAL" }, null);
  assert.equal(r.ok, true);
  assert.equal(recordOf(await reload(a.id))!.supplierRefund.status, "REFUND_PENDING");   // amount known ≠ credited
  assert.equal(recordOf(await reload(a.id))!.supplierRefund.expectedAmount, 8230);
  r = await applyAkbarCancellationAction(db, env, await reload(a.id), { action: "MARK_DEPOSIT_REFUND_FAILED", note: "Not on statement after 10 days" }, null);
  assert.equal(recordOf((r as any).amendment)!.supplierRefund.status, "REFUND_FAILED");
  // Delayed credit arrives later.
  r = await applyAkbarCancellationAction(db, env, await reload(a.id), { action: "MARK_DEPOSIT_CREDITED", note: "Credited", amount: 8230, currency: "INR", reference: "AKB-LEDGER-77" }, null);
  a = await reload(a.id);
  assert.equal(recordOf(a)!.supplierRefund.status, "REFUNDED");
  assert.equal(recordOf(a)!.supplierRefund.reference, "AKB-LEDGER-77");
  assert.equal(a.refundStatus, "NOT_STARTED");     // the customer refund is separate
  // Not before a cancellation is confirmed.
  const { a: manual } = await manualCase();
  assert.equal((await applyAkbarCancellationAction(db, env, manual, { action: "MARK_DEPOSIT_CREDITED", note: "x", amount: 1, currency: "INR", reference: "abc" }, null)).ok, false);
});

test("customer refund: separate staff action, once; a provider failure stays visible; manual completion recorded", async () => {
  const id = await addBooking();
  await pg.query(`INSERT INTO payments (booking_id, gateway, amount, currency, status, gateway_payment_id) VALUES ($1, 'NOMOD', 10400, 'INR', 'SUCCESS', 'charge-1')`, [id]);
  const { deps } = mockAkbar();
  await submit(id, deps);
  const [a] = await db.select().from(schema.bookingAmendments).where((await import("drizzle-orm")).eq(schema.bookingAmendments.bookingId, id));
  assert.equal((await applyAkbarCancellationAction(db, env, a, { action: "REFUND_CUSTOMER", note: "too much", amount: 99999 }, null)).ok, false);
  // No Nomod key configured here: the refund engine can't pay it → MANUAL_REQUIRED (no network call).
  const r = await applyAkbarCancellationAction(db, env, a, { action: "REFUND_CUSTOMER", note: "Refund after charges", amount: 8000 }, null);
  assert.equal(r.ok, true);
  assert.equal((r as any).amendment.refundStatus, "MANUAL_REQUIRED");
  assert.equal((await applyAkbarCancellationAction(db, env, await reload(a.id), { action: "REFUND_CUSTOMER", note: "again", amount: 8000 }, null)).ok, false);
  const m = await applyAkbarCancellationAction(db, env, await reload(a.id), { action: "CUSTOMER_REFUNDED_MANUALLY", note: "Paid from Nomod dashboard", amount: 8000, reference: "nomod-rf-1" }, null);
  assert.equal(m.ok && m.amendment.refundStatus, "DONE");
  const audit = (await pg.query<any>(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`, [id])).rows.map((x) => x.action);
  assert.ok(audit.includes("AKBAR_CANCELLATION_REQUESTED") && audit.includes("AKBAR_CANCELLATION_RESULT") && audit.includes("AKBAR_CANCELLATION_REFUND_CUSTOMER"));
});

// ── Admin API ─────────────────────────────────────────────────────────────────

function adminApp(role: string) {
  const a = new Hono<any>();
  a.use("*", async (c, next) => { c.set("db", db); c.set("tenantId", T); c.set("userRole", role); c.set("userId", null); await next(); });
  a.route("/api/admin/akbar-cancellation", akbarCancellationAdminRoutes);
  a.route("/api/admin/cancellations", cancellationsAdminRoutes);
  return (path: string, init?: RequestInit) => a.request(path, init, env, { waitUntil() {}, passThroughOnException() {} } as never);
}

test("Admin API: staff can't cancel; settings super admin only; generic TripJack actions refuse Akbar cancellations", async () => {
  const id = await addBooking();
  assert.equal((await adminApp("STAFF")(`/api/admin/akbar-cancellation/bookings/${id}`)).status, 403);
  const tenantAdmin = adminApp("TENANT_ADMIN");
  const panel = await (await tenantAdmin(`/api/admin/akbar-cancellation/bookings/${id}`)).json() as any;
  assert.equal(panel.settings.liveCancellationEnabled, false);
  assert.equal(panel.targets[0].transactionId, TX);
  assert.equal(panel.targets[0].eligible, true);
  const body = JSON.stringify({ liveCancellationEnabled: true, cancelPath: "/Flights/Cancel", tuiSource: "ITINERARY", ticketField: "EMPTY", partialPassengerCancellation: false, getRefundUatEnabled: false });
  assert.equal((await tenantAdmin(`/api/admin/akbar-cancellation/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body })).status, 403);
  assert.equal((await adminApp("SUPER_ADMIN")(`/api/admin/akbar-cancellation/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body })).status, 200);
  assert.equal((await adminApp("SUPER_ADMIN")(`/api/admin/akbar-cancellation/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: body.replace("/Flights/Cancel", "/Flights/Void") })).status, 400);

  const { deps } = mockAkbar({ cancel: () => { throw new AkbarError("timed out", 504, "/Flights/Cancel"); } });
  await submit(id, deps);
  const [a] = await amendmentsOf(id);
  const generic = await tenantAdmin(`/api/admin/cancellations/${a.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "MARK_SUCCESS", refundAmount: 1, note: "nope" }) });
  assert.equal(generic.status, 409);
  const refresh = await tenantAdmin(`/api/admin/cancellations/${a.id}/refresh`, { method: "POST" });
  assert.equal(refresh.status, 409);
  // GetRefund on a production account: refused before any call.
  env.TENANT_CACHE_KV.store.set(`admin_settings:${T}:integration:akbar`, JSON.stringify({ environment: "PRODUCTION" }));
  const gr = await tenantAdmin(`/api/admin/akbar-cancellation/cancellations/${a.id}/get-refund`, { method: "POST" });
  assert.equal(gr.status, 403);
});
