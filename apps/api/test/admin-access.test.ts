import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminUrl, sectionFor, staffCanOpen, tempPassword } from "../src/lib/admin-access.js";
import { adminRoutes } from "../src/routes/admin/index.js";

test("admin API paths map to staff sections; settings stay admin-only", () => {
  assert.equal(sectionFor("/api/admin/bookings"), "bookings");
  assert.equal(sectionFor("/api/admin/bookings/abc/refund"), "bookings");
  assert.equal(sectionFor("/api/admin/cancellations"), "bookings");
  assert.equal(sectionFor("/api/admin/agents/123"), "agents");
  assert.equal(sectionFor("/api/admin/leadvyne-agents"), "agents");
  assert.equal(sectionFor("/api/admin/agent-program/agents/1/credit"), "agents");
  assert.equal(sectionFor("/api/admin/agent-program/requests/9"), "agent_requests");
  assert.equal(sectionFor("/api/admin/agent-program/requests/9/approve-deposit"), "wallet_recharges");
  assert.equal(sectionFor("/api/admin/agent-program/recharges"), "wallet_recharges");
  for (const p of ["/api/admin/settings/payments", "/api/admin/integrations/tripjack", "/api/admin/users", "/api/admin/api-keys",
    "/api/admin/agent-program/config", "/api/admin/agent-program/bank-accounts", "/api/admin/agent-program/onboarding", "/api/admin/tenants", "/api/admin/dashboard"]) {
    assert.equal(sectionFor(p), null, p);
  }
  assert.equal(sectionFor("/api/admin/agentsX"), null);                     // prefix must end at a path boundary
});

test("staff open only their sections (plus /me and receipts for request handlers)", () => {
  const perms = ["agent_requests"];
  assert.equal(staffCanOpen("/api/admin/me", []), true);
  assert.equal(staffCanOpen("/api/admin/agent-program/requests", perms), true);
  assert.equal(staffCanOpen("/api/admin/agent-program/requests/9/file", perms), true);
  assert.equal(staffCanOpen("/api/admin/agent-program/requests/9/approve-deposit", perms), false);
  assert.equal(staffCanOpen("/api/admin/agent-program/requests/9/file", ["wallet_recharges"]), true);
  assert.equal(staffCanOpen("/api/admin/bookings", perms), false);
  assert.equal(staffCanOpen("/api/admin/settings/payments", ["bookings", "agents", "finance"]), false);
});

test("password links only point at FlyPoomas addresses", () => {
  const env: any = {};
  assert.equal(adminUrl(env, "https://admin.flypoomas.com"), "https://admin.flypoomas.com");
  assert.equal(adminUrl(env, "https://evil.example.com"), "https://admin.flypoomas.com");
  assert.equal(adminUrl(env, "https://flypoomas.com.evil.io"), "https://admin.flypoomas.com");
  assert.equal(adminUrl({ ADMIN_URL: "https://ops.example.org/" } as any, null), "https://ops.example.org");
  assert.match(tempPassword(), /^[a-z]{4}-[a-z]{4}-\d{3}[A-Z]$/);
});

test("admin middleware: live role from the user row, staff limited, deactivated users out", async () => {
  const rows: Record<string, any> = {
    staff: { id: "staff", role: "STAFF", isActive: true, permissions: ["bookings"], name: "S", email: "s@x" },
    gone: { id: "gone", role: "SUPER_ADMIN", isActive: false, permissions: [], name: "G", email: "g@x" },
    agent: { id: "agent", role: "AGENT_ADMIN", isActive: true, permissions: [], name: "A", email: "a@x" },
  };
  const kv = new Map<string, string>(Object.entries(rows).map(([id, r]) => [`admin_user:${id}`, JSON.stringify(r)]));
  const env: any = { SESSIONS_KV: { get: async (k: string, t?: string) => { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async () => {}, delete: async () => {} } };
  const app = new Hono<any>();
  app.use("*", async (c, n) => { c.set("tenantId", "t1"); c.set("userId", c.req.header("x-user") || undefined); c.set("userRole", c.req.header("x-role") || "SUPER_ADMIN"); await n(); });
  app.route("/api/admin", adminRoutes);
  app.onError((e: any, c) => c.json({ error: e.message }, e.status ?? 500));
  const call = (path: string, user: string, role = "SUPER_ADMIN") => app.fetch(new Request("http://x" + path, { headers: { "x-user": user, "x-role": role } }), env, { waitUntil() {}, passThroughOnException() {} } as any);

  let res = await call("/api/admin/settings/payments", "staff", "SUPER_ADMIN");   // token claims admin; the row says STAFF
  assert.equal(res.status, 403);
  assert.match((await res.json() as any).error, /don't have access/);
  res = await call("/api/admin/me", "staff");
  assert.equal(res.status, 200);
  const me = await res.json() as any;
  assert.equal(me.role, "STAFF");
  assert.deepEqual(me.sections, ["bookings"]);
  assert.equal(me.canManageUsers, false);
  res = await call("/api/admin/users", "staff");
  assert.equal(res.status, 403);
  res = await call("/api/admin/me", "gone");
  assert.equal(res.status, 401);
  res = await call("/api/admin/me", "agent", "AGENT_ADMIN");
  assert.equal(res.status, 403);
});
