import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { chainShares, creditStatus, DEFAULT_PROGRAM, rulesFor, sellingPrice, tierFor, type AgentNode } from "../src/lib/agent-program.js";
import { applyMarkup } from "../src/lib/markup.js";
import { cleanTicket } from "../src/lib/ticket-scan.js";
import { agentPortalRoutes } from "../src/routes/agent-portal.js";

const node = (id: string, parentAgentId: string | null): AgentNode => ({ id, parentAgentId, status: "APPROVED", businessName: id });
const m = (type: "FLAT" | "PERCENTAGE", value: number) => ({ type, value, setBy: "", updatedAt: "" });

test("pricing chain: each parent's markup is added on top of the price it buys at", () => {
  // grandchild → child → top. Top sets 2% on child; child sets ₹300 on grandchild.
  const chain = [node("grandchild", "child"), node("child", "top"), node("top", null)];
  const markups = new Map([["child", m("PERCENTAGE", 2)], ["grandchild", m("FLAT", 300)]]);
  const shares = chainShares(chain, markups, 10_000);
  assert.deepEqual(shares, [
    { beneficiaryAgentId: "top", fromAgentId: "child", amount: 200 },
    { beneficiaryAgentId: "child", fromAgentId: "grandchild", amount: 300 },
  ]);
  // A top-level agency has no parent markup.
  assert.deepEqual(chainShares([node("top", null)], markups, 10_000), []);
});

test("selling price adds the agency's own markup (display only)", () => {
  assert.equal(sellingPrice(10_000), 10_000);
  assert.equal(sellingPrice(10_000, { type: "FLAT", value: 499 }), 10_499);
  assert.equal(sellingPrice(10_000, { type: "PERCENTAGE", value: 5 }), 10_500);
  assert.equal(sellingPrice(10_000, { type: "FLAT", value: 0 }), 10_000);
});

test("agency markup rules never leak to the public or other agencies", () => {
  const rules = [{ id: "all", agentId: null }, { id: "a1", agentId: "agent-1" }, { id: "a2", agentId: "agent-2" }];
  assert.deepEqual(rulesFor(rules, null).map((r) => r.id), ["all"]);
  assert.deepEqual(rulesFor(rules, "agent-1").map((r) => r.id), ["all", "a1"]);
});

test("a markup rule allocated to an agent wins over the default rules", () => {
  const fare = { totalFare: 1000, airline: "6E", origin: "COK", destination: "DXB", cabinClass: "ECONOMY", supplier: "TRIPJACK" } as never;
  const rule = (agentId: string | null, value: string, priority: number) =>
    ({ agentId, markupType: "FLAT", markupValue: value, priority, isActive: true });
  const rules = [rule(null, "250", 50), rule("agent-1", "100", 0), rule("agent-2", "999", 0)];
  assert.equal(applyMarkup(fare, rulesFor(rules, null)), 1250);
  assert.equal(applyMarkup(fare, rulesFor(rules, "agent-1")), 1100);
  assert.equal(applyMarkup(fare, rulesFor(rules, "agent-3")), 1250);
});

test("tiers follow monthly sales", () => {
  const t0 = tierFor(DEFAULT_PROGRAM, 100_000);
  assert.equal(t0.name, "Silver");
  assert.deepEqual(t0.next, { name: "Gold", needed: 400_000 });
  assert.equal(tierFor(DEFAULT_PROGRAM, 750_000).name, "Gold");
  const top = tierFor(DEFAULT_PROGRAM, 5_000_000);
  assert.equal(top.name, "Platinum");
  assert.equal(top.next, null);
});

test("credit status: available = balance + limit; overdue after the credit period", () => {
  const now = Date.parse("2030-01-20T00:00:00Z");
  const w = { balance: "-12000", creditLimit: "50000" };
  const fresh = creditStatus(w, { creditUsedSince: "2030-01-10T00:00:00Z" }, DEFAULT_PROGRAM, now);
  assert.equal(fresh.available, 38_000);
  assert.equal(fresh.creditUsed, 12_000);
  assert.equal(fresh.overdue, false);                      // due 25 Jan (15 days)
  const late = creditStatus(w, { creditUsedSince: "2029-12-30T00:00:00Z" }, DEFAULT_PROGRAM, now);
  assert.equal(late.overdue, true);
  const positive = creditStatus({ balance: "500", creditLimit: "0" }, { creditUsedSince: "2029-01-01T00:00:00Z" }, DEFAULT_PROGRAM, now);
  assert.equal(positive.overdue, false);                   // nothing owed → never overdue
  assert.equal(positive.dueAt, null);
});

test("ticket reader output is cleaned and validated", () => {
  const t = cleanTicket({
    pnr: " abc12d ", airline: "Emirates", totalAmount: 41234.5, currency: "INR",
    passengers: [{ name: "  ASHA   NAIR ", type: "ADULT", ticketNumber: "176-2345678901" }, { name: "X", type: "WHO", ticketNumber: null }],
    segments: [{ from: "cok", to: "DXB", flightNumber: "EK 531", departure: "2030-01-05T04:25", arrival: null, cabin: "Economy", baggage: "30 kg" }, { from: "??", to: "DXB" }],
  });
  assert.equal(t.pnr, "ABC12D");
  assert.deepEqual(t.passengers, [{ name: "ASHA NAIR", type: "ADULT", ticketNumber: "176-2345678901" }]);
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].from, "COK");
  assert.equal(t.totalAmount, 41234.5);
  assert.equal(cleanTicket({ pnr: "TOOLONGPNR1" }).pnr, null);
});

test("agency routes reject non-agency logins", async () => {
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("tenantId", "t1"); c.set("userRole", "CUSTOMER"); c.set("userId", "u1"); await next(); });
  app.route("/api/agent", agentPortalRoutes);
  const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
  app.onError((err: any, c) => c.json({ error: err.message }, err.status ?? 500));
  const res = await app.fetch(new Request("http://x/api/agent/me"), {}, ctx);
  assert.equal(res.status, 403);
});
