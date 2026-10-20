import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { bankAccountSchema, visibleAccounts, type BankAccount } from "../src/lib/bank-accounts.js";
import { agentPortalRoutes } from "../src/routes/agent-portal.js";

const acct = (over: Partial<BankAccount>): BankAccount => ({
  ...bankAccountSchema.parse({ label: "ENBD · AED", bankName: "Emirates NBD", accountName: "Poomas Travel LLC", accountNumber: "1015123456789", currency: "AED" }),
  id: "a1", createdAt: "", updatedAt: "", ...over,
});

test("agencies see active bank accounts, their wallet currency first", () => {
  const list = [acct({ id: "inr", currency: "INR" }), acct({ id: "off", active: false }), acct({ id: "aed" })];
  const shown = visibleAccounts(list, "AED");
  assert.deepEqual(shown.map((a) => a.id), ["aed", "inr"]);
  assert.equal("active" in shown[0], false);
  assert.throws(() => bankAccountSchema.parse({ label: "x", bankName: "Bank", accountName: "A", accountNumber: "1", currency: "AED" }));
});

test("bank-transfer recharge needs a screenshot and one of the listed accounts", async () => {
  const kv = new Map<string, string>([["admin_settings:t1:bank_accounts", JSON.stringify([acct({ id: "aed" })])]]);
  const env = { TENANT_CACHE_KV: { get: async (k: string, t?: string) => { const v = kv.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; } } };
  const app = new Hono<any>();
  app.use("*", async (c, n) => { c.set("tenantId", "t1"); c.set("agentId", "ag1"); c.set("userRole", "AGENT_ADMIN"); await n(); });
  app.route("/api/agent", agentPortalRoutes);
  app.onError((err: any, c) => c.json({ error: err.message }, err.status ?? 500));
  const post = (fields: Record<string, string>, file?: File) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (file) form.append("receipt", file);
    return app.fetch(new Request("http://x/api/agent/deposits", { method: "POST", body: form }), env, { waitUntil() {}, passThroughOnException() {} } as any);
  };
  const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

  let res = await post({ amount: "5000", method: "BANK_TRANSFER", reference: "FT1" });
  assert.equal(res.status, 400);
  assert.match((await res.json() as any).error, /screenshot/);

  res = await post({ amount: "5000", method: "BANK_TRANSFER" }, new File(["x"], "a.exe", { type: "application/x-msdownload" }));
  assert.match((await res.json() as any).error, /photo, screenshot or PDF/);

  res = await post({ amount: "5000", method: "BANK_TRANSFER" }, png);
  assert.equal(res.status, 400);
  assert.match((await res.json() as any).error, /bank account you paid into/);

  res = await post({ amount: "5000", method: "BANK_TRANSFER", bankAccountId: "nope" }, png);
  assert.match((await res.json() as any).error, /listed bank accounts/);

  res = await post({ amount: "0", method: "BANK_TRANSFER", bankAccountId: "aed" }, png);
  assert.match((await res.json() as any).error, /amount/);
});
