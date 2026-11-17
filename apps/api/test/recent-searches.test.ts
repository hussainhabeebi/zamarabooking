// /api/profile/recent-searches: a signed-in customer's last 10 flight searches, kept in SESSIONS_KV.
// In-memory KV; no supplier calls.
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { RECENT_SEARCH_LIMIT, mergeRecentSearches, recentSearchRoutes, recentSearchSchema } from "../src/routes/recent-searches.js";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string, type?: string) { const v = store.get(k) ?? null; return v && type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  };
}

function api(env: any, user: { userId?: string | null; role?: string; tenantId?: string } = { userId: "u1", role: "CUSTOMER" }) {
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("tenantId", user.tenantId ?? "t1"); c.set("userId", user.userId ?? null); c.set("userRole", user.role); await next(); });
  app.route("/api/profile/recent-searches", recentSearchRoutes);
  return (method: string, body?: unknown) => app.request("/api/profile/recent-searches", {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }, env);
}

const at = (n: number) => new Date(Date.UTC(2026, 10, 17, 10, n)).toISOString();
const s = (over: Record<string, unknown> = {}) => ({ tripType: "ONEWAY", origin: "cok", destination: "DOH", departureDate: "2026-11-24", adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", searchedAt: at(0), ...over });

test("guests and non-customer logins can't use the account list", async () => {
  const env = { SESSIONS_KV: memoryKv() };
  assert.equal((await api(env, { userId: null })("GET")).status, 401);
  assert.equal((await api(env, { userId: "a1", role: "AGENT_ADMIN" })("GET")).status, 401);
});

test("add, list newest first, de-duplicate, keep 10, clear", async () => {
  const env = { SESSIONS_KV: memoryKv() };
  const call = api(env);
  assert.deepEqual(await (await call("GET")).json(), { searches: [] });
  const first = await (await call("POST", { searches: [s()] })).json() as any;
  assert.equal(first.searches[0].origin, "COK");                 // upper-cased
  const dests = ["DXB", "BOM", "DEL", "BLR", "MAA", "HYD", "CCU", "AUH", "SHJ", "MCT", "RUH"];
  for (const [i, d] of dests.entries()) await call("POST", { searches: [s({ destination: d, searchedAt: at(i + 1) })] });
  let list = (await (await call("GET")).json() as any).searches;
  assert.equal(list.length, RECENT_SEARCH_LIMIT);
  assert.equal(list[0].destination, "RUH");
  assert.ok(!list.some((x: any) => x.destination === "DOH"));    // oldest dropped
  await call("POST", { searches: [s({ destination: "MAA", searchedAt: at(40) })] });
  list = (await (await call("GET")).json() as any).searches;
  assert.equal(list[0].destination, "MAA");
  assert.equal(list.filter((x: any) => x.destination === "MAA").length, 1);
  assert.equal((await call("DELETE")).status, 200);
  assert.deepEqual(await (await call("GET")).json(), { searches: [] });
});

test("each customer (and tenant) has their own list", async () => {
  const env = { SESSIONS_KV: memoryKv() };
  await api(env, { userId: "u1", role: "CUSTOMER" })("POST", { searches: [s()] });
  assert.equal(((await (await api(env, { userId: "u2", role: "CUSTOMER" })("GET")).json()) as any).searches.length, 0);
  assert.equal(((await (await api(env, { userId: "u1", role: "CUSTOMER", tenantId: "t2" })("GET")).json()) as any).searches.length, 0);
  assert.equal(((await (await api(env)("GET")).json()) as any).searches.length, 1);
});

test("only valid searches are accepted; fields the trip type doesn't use are dropped", async () => {
  const call = api({ SESSIONS_KV: memoryKv() });
  for (const bad of [s({ origin: "COCHIN" }), s({ departureDate: "24/11/2026" }), s({ adults: 0 }), s({ tripType: "ROUNDTRIP_X" }), s({ searchedAt: "yesterday" })]) {
    assert.equal((await call("POST", { searches: [bad] })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call("POST", { searches: Array.from({ length: 11 }, (_, i) => s({ searchedAt: at(i) })) })).status, 400);
  const p = recentSearchSchema.parse(s({ returnDate: "2026-12-01", legs: [{ origin: "COK", destination: "BOM", departureDate: "2026-12-01" }, { origin: "BOM", destination: "DEL", departureDate: "2026-12-02" }] }));
  assert.equal(p.returnDate, undefined);
  assert.equal(p.legs, undefined);
  const rt = recentSearchSchema.parse(s({ tripType: "ROUNDTRIP", returnDate: "2026-12-01" }));
  assert.equal(rt.returnDate, "2026-12-01");
});

test("a damaged stored list is ignored, not an error", async () => {
  const env = { SESSIONS_KV: memoryKv() };
  env.SESSIONS_KV.store.set("recent_searches:t1:u1", JSON.stringify([{ nonsense: true }, s({ origin: "COK" })]));
  const list = ((await (await api(env)("GET")).json()) as any).searches;
  assert.equal(list.length, 1);
});

test("merge: newest of a batch first, then the saved list", () => {
  const parse = (o: Record<string, unknown>) => recentSearchSchema.parse(s(o));
  const out = mergeRecentSearches([parse({ destination: "DXB", searchedAt: at(1) }), parse({ destination: "BOM", searchedAt: at(5) })], [parse({})]);
  assert.deepEqual(out.map((x) => x.destination), ["BOM", "DXB", "DOH"]);
});
