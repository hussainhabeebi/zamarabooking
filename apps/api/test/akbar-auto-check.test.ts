// Automatic Akbar status checks (lib/akbar-auto-check.ts) and the ticket-number e-ticket update
// (akbar-booking-runner updateIssuedTickets). Real PostgreSQL engine (PGlite) with the repository's
// migrations; Akbar is never called (the refresh is a recorded fake), no email is sent.
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@zamrabooking/db/schema";
import { akbarAutoCheck, AUTO_CHECK_MAX_PER_RUN, AUTO_CHECK_WINDOW_MS, runAkbarAutoChecks } from "../src/lib/akbar-auto-check.js";
import { updateIssuedTickets } from "../src/lib/akbar-booking-runner.js";

const MIGRATIONS = new URL("../../../packages/db/drizzle/migrations/", import.meta.url);
let pg: PGlite;
let db: any;
const T = "tenant-auto-check";
const NOW = new Date("2026-11-20T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function memoryKv(init: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  };
}
let env: any;
let sent: any[];

before(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8").replace(/CREATE EXTENSION[^;]*;/gi, ""));
  }
  db = drizzle(pg, { schema });
  await pg.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Auto check', 'auto-check')`, [T]);
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM booking_passengers; DELETE FROM bookings;`);
  sent = [];
  env = {
    TENANT_CACHE_KV: memoryKv({ [`admin_settings:${T}:integration:akbar`]: { enabled: true, apiBooking: "AUTO", environment: "PRODUCTION" } }),
    SESSIONS_KV: memoryKv(), FARE_CACHE_KV: memoryKv(),
    DOCUMENTS_R2: { async put() {} },
    NOTIFY_QUEUE: { async send(m: unknown) { sent.push(m); } },
  };
});

type Over = { status?: string; outcome?: string; paidHoursAgo?: number | null; tickets?: string[]; departsInHours?: number; resolution?: unknown; createdHoursAgo?: number };
async function addBooking(o: Over = {}) {
  const id = crypto.randomUUID();
  const legs = [{ leg: 0, state: o.outcome === "TICKETED" ? "SUCCESS" : "PENDING", transactionId: 263533337, ...(o.paidHoursAgo === null ? {} : { paymentSentAt: hoursAgo(o.paidHoursAgo ?? 1) }) }];
  const flightData = { akbarBooking: { legs, startedAt: hoursAgo(2), runs: 1, outcome: o.outcome ?? "TICKETED" }, offline: { supplier: "AKBAR", ...(o.resolution ? { resolution: o.resolution } : {}) } };
  await pg.query(`INSERT INTO bookings (id, tenant_id, channel, status, trip_type, cabin_class, origin, destination, departure_date, flight_data, adult_count,
      base_fare, taxes, markup, total_amount, currency, supplier, pnr, ticket_numbers, contact_email, contact_phone, created_at)
    VALUES ($1, $2, 'B2C_WEB', $3, 'ONEWAY', 'ECONOMY', 'COK', 'DXB', $4, $5::jsonb, 1, 11045, 0, 0, 11045, 'INR', 'AKBAR', $6, $7, 'guest@example.com', '+919999999999', $8)`,
    [id, T, o.status ?? "TICKETED", new Date(NOW.getTime() + (o.departsInHours ?? 72) * 3600_000).toISOString(), JSON.stringify(flightData),
      (o.status ?? "TICKETED") === "TICKETED" ? "56SPZN" : null, o.tickets ?? [], hoursAgo(o.createdHoursAgo ?? 2)]);
  const [row] = (await pg.query<any>(`SELECT * FROM bookings WHERE id = $1`, [id])).rows;
  return { id, row: { ...row, departureDate: new Date(row.departure_date), ticketNumbers: row.ticket_numbers, flightData: row.flight_data } };
}

// ── Which bookings are checked ───────────────────────────────────────────────

test("checked: PNR without ticket numbers, and paid on Akbar but not yet confirmed", async () => {
  const awaitingTickets = await addBooking({ status: "TICKETED", outcome: "TICKETED", tickets: [] });
  const awaitingPnr = await addBooking({ status: "CONFIRMED", outcome: "PENDING" });
  const partial = await addBooking({ status: "CONFIRMED", outcome: "PARTIAL" });
  assert.deepEqual(akbarAutoCheck({ ...awaitingTickets.row, supplier: "AKBAR" }, NOW), { reason: "AWAITING_TICKETS", expired: false });
  assert.deepEqual(akbarAutoCheck({ ...awaitingPnr.row, supplier: "AKBAR" }, NOW), { reason: "AWAITING_PNR", expired: false });
  assert.deepEqual(akbarAutoCheck({ ...partial.row, supplier: "AKBAR" }, NOW), { reason: "AWAITING_PNR", expired: false });
});

test("not checked: has tickets, nothing paid on Akbar, failed before payment, departed, refunded, other suppliers", async () => {
  const cases: [string, Over, string?][] = [
    ["has ticket numbers", { tickets: ["0989450709308"] }],
    ["StartPay never sent (e.g. balance refused)", { status: "CONFIRMED", outcome: "PENDING", paidHoursAgo: null }],
    ["stopped before payment", { status: "CONFIRMED", outcome: "FAILED_BEFORE_PAYMENT", paidHoursAgo: null }],
    ["Akbar reported Failed (final)", { status: "CONFIRMED", outcome: "FAILED" }],
    ["already departed", { tickets: [], departsInHours: -1 }],
    ["refund started", { status: "CONFIRMED", outcome: "PENDING", resolution: { type: "REFUND" } }],
    ["other supplier", { tickets: [] }, "MANUAL"],
  ];
  for (const [name, o, supplier] of cases) {
    const b = await addBooking(o);
    assert.equal(akbarAutoCheck({ ...b.row, supplier: supplier ?? "AKBAR" }, NOW), null, name);
  }
});

test("after 24 hours from StartPay the booking is 'expired' (one warning, no more checks)", async () => {
  const b = await addBooking({ tickets: [], paidHoursAgo: 25 });
  assert.deepEqual(akbarAutoCheck({ ...b.row, supplier: "AKBAR" }, NOW), { reason: "AWAITING_TICKETS", expired: true });
  assert.equal(AUTO_CHECK_WINDOW_MS, 24 * 3600_000);
});

// ── The hourly run ───────────────────────────────────────────────────────────

const fakeRefresh = (calls: string[], outcome = "TICKETED") => async (_e: any, _d: any, id: string) => {
  calls.push(id);
  return { ok: true, outcome, state: { legs: [{ tickets: ["0989450709308"] }] } } as any;
};
const events = (id: string) => JSON.parse(env.TENANT_CACHE_KV.store.get(`booking_events:${id}`) ?? "[]").map((e: any) => e.message as string);

test("the hourly run refreshes only the bookings that need it, holding the booking lock", async () => {
  const a = await addBooking({ tickets: [] });
  const b = await addBooking({ status: "CONFIRMED", outcome: "PENDING" });
  await addBooking({ tickets: ["0989450709308"] });
  await addBooking({ status: "CONFIRMED", outcome: "FAILED_BEFORE_PAYMENT", paidHoursAgo: null });
  const calls: string[] = [];
  const locksDuring: boolean[] = [];
  const r = await runAkbarAutoChecks(env, db, NOW, async (e, d, id, u) => {
    locksDuring.push([...env.TENANT_CACHE_KV.store.keys()].some((k: string) => k.includes(id) && /lock/.test(k)));
    return fakeRefresh(calls)(e, d, id);
  });
  assert.deepEqual(calls.sort(), [a.id, b.id].sort());
  assert.ok(locksDuring.every(Boolean), "lock held during each refresh");
  assert.ok(![...env.TENANT_CACHE_KV.store.keys()].some((k: string) => /lock/.test(k)), "locks released");
  assert.deepEqual(r, { checked: 2, ticketed: 2, warned: 0, skipped: 0 });
  assert.ok(events(a.id).some((m: string) => /Automatic Akbar status check \(waiting for ticket numbers\)/.test(m)));
  assert.ok(events(b.id).some((m: string) => /waiting for Akbar's confirmation/.test(m)));
});

test("a booking staff or the payment queue is working on is skipped this hour", async () => {
  const a = await addBooking({ tickets: [] });
  const keyBefore = new Set(env.TENANT_CACHE_KV.store.keys());
  // Take the same lock the Admin button and the queue take.
  const { acquireBookingLock } = await import("../src/lib/booking-recovery.js");
  assert.equal(await acquireBookingLock(env, a.id), true);
  const lockKey = [...env.TENANT_CACHE_KV.store.keys()].find((k: string) => !keyBefore.has(k));
  const calls: string[] = [];
  const r = await runAkbarAutoChecks(env, db, NOW, fakeRefresh(calls));
  assert.deepEqual(calls, []);
  assert.equal(r.skipped, 1);
  assert.ok(env.TENANT_CACHE_KV.store.has(lockKey), "someone else's lock is left alone");
});

test("Akbar API booking OFF: no automatic Akbar calls", async () => {
  await addBooking({ tickets: [] });
  env.TENANT_CACHE_KV.store.set(`admin_settings:${T}:integration:akbar`, JSON.stringify({ enabled: true, apiBooking: "OFF", environment: "PRODUCTION" }));
  const calls: string[] = [];
  const r = await runAkbarAutoChecks(env, db, NOW, fakeRefresh(calls));
  assert.deepEqual(calls, []);
  assert.equal(r.skipped, 1);
});

test("at most AUTO_CHECK_MAX_PER_RUN checks per run; the rest wait for the next hour", async () => {
  for (let i = 0; i < AUTO_CHECK_MAX_PER_RUN + 3; i++) await addBooking({ tickets: [] });
  const calls: string[] = [];
  const r = await runAkbarAutoChecks(env, db, NOW, fakeRefresh(calls));
  assert.equal(calls.length, AUTO_CHECK_MAX_PER_RUN);
  assert.equal(r.skipped, 3);
});

test("after 24 hours: one warning for staff, no Akbar call, not repeated", async () => {
  const b = await addBooking({ tickets: [], paidHoursAgo: 30 });
  const calls: string[] = [];
  assert.equal((await runAkbarAutoChecks(env, db, NOW, fakeRefresh(calls))).warned, 1);
  assert.equal((await runAkbarAutoChecks(env, db, NOW, fakeRefresh(calls))).warned, 0);
  assert.deepEqual(calls, []);
  const warnings = events(b.id).filter((m: string) => /automatic checks stopped/.test(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hasn't issued ticket numbers 24 hours after the PNR/);
});

test("a refresh that throws is logged and the lock is released", async () => {
  const b = await addBooking({ tickets: [] });
  const r = await runAkbarAutoChecks(env, db, NOW, async () => { throw new Error("Akbar timed out"); });
  assert.equal(r.checked, 1);
  assert.ok(events(b.id).some((m: string) => /Automatic Akbar status check failed: Akbar timed out/.test(m)));
  assert.ok(![...env.TENANT_CACHE_KV.store.keys()].some((k: string) => /lock/.test(k)));
});

// ── Ticket numbers arriving after the e-ticket ───────────────────────────────

test("ticket numbers arriving later: stored, e-ticket rebuilt, the customer emailed the update once", async () => {
  const b = await addBooking({ tickets: [] });
  await pg.query(`INSERT INTO booking_passengers (booking_id, passenger_type, first_name, last_name) VALUES ($1, 'ADULT', 'Aarav', 'Sharma')`, [b.id]);
  const state = { legs: [{ leg: 0, state: "SUCCESS", pnrs: ["56SPZN"], tickets: ["0989450709308"] }], startedAt: "", runs: 2, outcome: "TICKETED" } as any;
  await updateIssuedTickets(env, db, b.id, state, 1, null);
  const [row] = (await pg.query<any>(`SELECT status, pnr, ticket_numbers FROM bookings WHERE id = $1`, [b.id])).rows;
  assert.deepEqual({ ...row }, { status: "TICKETED", pnr: "56SPZN", ticket_numbers: ["0989450709308"] });
  assert.deepEqual(sent.map((m) => [m.type, m.update]), [["NOTIFY_BOOKING_CONFIRMATION", "TICKET_NUMBERS"]]);
  assert.ok(events(b.id).some((m: string) => /Ticket numbers received from Akbar — updated e-ticket emailed/.test(m)));
  // Same tickets again (next hourly run / staff click): nothing sent.
  await updateIssuedTickets(env, db, b.id, state, 1, null);
  assert.equal(sent.length, 1);
  // Corrected later (tickets already existed): stored, no customer email.
  await updateIssuedTickets(env, db, b.id, { ...state, legs: [{ ...state.legs[0], tickets: ["0989450709309"] }] }, 1, null);
  assert.equal(sent.length, 1);
});
