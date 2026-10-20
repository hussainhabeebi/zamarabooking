import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { DEFAULT_ONBOARDING, onboardingStatus, renderMou, sha256Hex, signatureBlock } from "../src/lib/agent-onboarding.js";
import { DEFAULT_PROGRAM } from "../src/lib/agent-program.js";
import { agentPublicRoutes } from "../src/routes/agent-portal.js";

const agent = {
  id: "ag1", businessName: "Aiingo <Travels>", ownerName: "Hussain", email: "h@aiingo.com", phone: "+971500000001",
  region: "GCC", currency: "AED", agentNumber: "FPA10010", iataCode: null, creditLimit: "25000", settings: { address: "Dubai" },
};
const cfg = { ...DEFAULT_ONBOARDING, company: { ...DEFAULT_ONBOARDING.company, legalName: "Poomas Travel LLC", signatory: "Habeeb" }, extraClauses: "Monthly sales review\n\n" };

test("the MOU is generated from the agency's details, escaped, with configurable law", () => {
  const m = renderMou({ cfg, tenant: { name: "FlyPoomas" }, agent, program: DEFAULT_PROGRAM, date: new Date("2026-10-03T00:00:00Z") });
  assert.equal(m.ref, "MOU-FPA10010-v1");
  assert.match(m.html, /Aiingo &lt;Travels&gt;/);                          // agency text is escaped
  assert.doesNotMatch(m.html, /<Travels>/);
  assert.match(m.html, /FPA10010/);
  assert.match(m.html, /credit limit of <b>AED\s?25,000<\/b>/);
  assert.match(m.html, /within <b>15 days<\/b>/);
  assert.match(m.html, /the laws of the United Arab Emirates/);
  assert.match(m.html, /Additional term 1\.<\/b> Monthly sales review/);
  assert.match(m.html, /VAT will be applied/);
  const india = renderMou({ cfg: { ...cfg, governingLaw: { INDIA: "the laws of India, courts of Mumbai", GCC: "x" } }, tenant: { name: "F" }, agent: { ...agent, region: "INDIA" }, program: DEFAULT_PROGRAM });
  assert.match(india.html, /courts of Mumbai/);
  assert.match(india.html, /GST and TDS/);
});

test("signature block records who accepted and the document fingerprint", async () => {
  const m = renderMou({ cfg, tenant: { name: "FlyPoomas" }, agent, program: DEFAULT_PROGRAM });
  const hash = await sha256Hex(m.html);
  assert.equal(hash.length, 64);
  assert.equal(await sha256Hex(m.html), hash);                               // stable for the same text
  const sig = signatureBlock({ company: m.company, cfg, agentName: agent.businessName, acceptance: {
    version: "1", acceptedAt: "2026-10-03T10:00:00Z", name: "Hussain H", designation: "Partner", userId: "u", email: null, ip: "1.2.3.4", userAgent: null, hash, r2Key: "k",
  } });
  assert.match(sig, /Hussain H/);
  assert.match(sig, /Habeeb/);
  assert.match(sig, new RegExp(hash));
  assert.match(sig, /1\.2\.3\.4/);
});

test("onboarding is complete only with every required document and a signed MOU", async () => {
  const docs = [{ docType: "TRADE_LICENSE", verifiedAt: null }];
  const db: any = { select: () => ({ from: () => ({ where: async () => docs }) }) };
  const env: any = { TENANT_CACHE_KV: { get: async () => null } };
  let s = await onboardingStatus(env, db, "t1", agent);
  assert.deepEqual(s.required.map((r) => [r.type, r.status]), [["TRADE_LICENSE", "UPLOADED"], ["EMIRATES_ID", "MISSING"]]);
  assert.equal(s.kycDone, false);
  assert.equal(s.complete, false);
  docs.push({ docType: "EMIRATES_ID", verifiedAt: new Date() as any });
  s = await onboardingStatus(env, db, "t1", agent);
  assert.equal(s.kycDone, true);
  assert.equal(s.complete, false);                                           // MOU not signed
  s = await onboardingStatus(env, db, "t1", { ...agent, settings: { mou: { version: "1", acceptedAt: "x", name: "H" } } });
  assert.equal(s.complete, true);
  s = await onboardingStatus(env, db, "t1", { ...agent, settings: { mou: { version: "0", acceptedAt: "x", name: "H" } } });
  assert.equal(s.mou.accepted, false);                                       // older MOU version: sign again
});

test("forgot password answers the same whether or not the email exists", async () => {
  const kv = new Map<string, string>();
  const env: any = { SESSIONS_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } } };
  const db: any = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
  const app = new Hono<any>();
  app.use("*", async (c, n) => { c.set("tenantId", "t1"); c.set("db", db); await n(); });
  app.route("/api/agent-public", agentPublicRoutes);
  const res = await app.fetch(new Request("http://x/api/agent-public/password/forgot", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nobody@example.com" }),
  }), env, { waitUntil() {}, passThroughOnException() {} } as any);
  assert.equal(res.status, 200);
  assert.match((await res.json() as any).message, /If this email has an agency login/);
  const bad = await app.fetch(new Request("http://x/api/agent-public/password/reset/nope"), env, { waitUntil() {}, passThroughOnException() {} } as any);
  assert.equal(bad.status, 404);
});
