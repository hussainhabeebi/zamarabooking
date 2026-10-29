#!/usr/bin/env node
// PhonePe SANDBOX acceptance against the isolated staging API (zamra-api-staging).
// Run on your own machine. Secrets are read from the environment and never printed
// or written. Refuses production hosts and any API whose /health is not "staging".
//
//   STAGING_API_URL         https://zamra-api-staging.<account>.workers.dev
//   STAGING_JWT_SECRET      the staging Worker's JWT_SECRET (signs a checkout token)
//   STAGING_ADMIN_TOKEN     staging Admin bearer token (refund steps only)
//   STAGING_WEBHOOK_USERNAME / STAGING_WEBHOOK_PASSWORD  (webhook step only)
//   TENANT_ID               zamra tenant id on the Neon staging branch
//
//   node scripts/phonepe-sandbox-acceptance.mjs preflight
//   node scripts/phonepe-sandbox-acceptance.mjs pay <bookingId>       (complete payment in the browser)
//   node scripts/phonepe-sandbox-acceptance.mjs fail <bookingId>      (cancel payment in the browser)
//   node scripts/phonepe-sandbox-acceptance.mjs refund <bookingId>
//   node scripts/phonepe-sandbox-acceptance.mjs webhook <bookingId>
//
// Results are appended to phonepe-sandbox-report.json (ids, states, pass/fail only).
import { appendFileSync } from "node:fs";

const env = process.env;
const [step, bookingId] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ step, bookingId: bookingId ?? null, name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const die = (message) => {
  console.error(`Refusing: ${message}`);
  process.exit(2);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = (env.STAGING_API_URL ?? "").replace(/\/$/, "");
let host = "";
try {
  const u = new URL(api);
  if (u.protocol !== "https:") die("STAGING_API_URL must be HTTPS");
  host = u.hostname;
} catch {
  die("set STAGING_API_URL to the staging API (https://…workers.dev)");
}
if (host === "zamrabooking.com" || host.endsWith(".zamrabooking.com")) die("production hosts are never used by this script");
if (!env.TENANT_ID) die("set TENANT_ID");
if (step !== "preflight" && !/^[A-Za-z0-9-]{8,100}$/.test(bookingId ?? "")) die("pass a staging test booking id");

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-tenant-slug": "zamra", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "error",
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function checkoutToken() {
  if (!env.STAGING_JWT_SECRET) die("set STAGING_JWT_SECRET (staging only)");
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: bookingId, tenantId: env.TENANT_ID, iat: now, exp: now + 3600 }))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STAGING_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))}`;
}
const admin = () => {
  if (!env.STAGING_ADMIN_TOKEN) die("set STAGING_ADMIN_TOKEN for refund steps");
  return { Authorization: `Bearer ${env.STAGING_ADMIN_TOKEN}` };
};

async function guardStaging() {
  const health = await call("/health");
  if (health.data?.env !== "staging") die(`API /health reports env=${JSON.stringify(health.data?.env)}, expected "staging"`);
  check("staging API health", true, "env=staging");
}
async function reconcile(token) {
  return call("/api/payments/phonepe/reconcile", { method: "POST", headers: { "X-Checkout-Token": token }, body: { bookingId } });
}
async function waitForFinal(token, minutes = 10) {
  for (let i = 0; i < minutes * 12; i++) {
    const r = await reconcile(token);
    if (["COMPLETED", "FAILED"].includes(r.data?.paymentState)) return r.data;
    await sleep(5000);
  }
  return null;
}
async function status(token) {
  return (await call(`/api/payments/${encodeURIComponent(bookingId)}`, { headers: { "X-Checkout-Token": token } })).data;
}

async function checkoutFlow(expect) {
  await guardStaging();
  const token = await checkoutToken();
  const first = await call("/api/payments/checkout", { method: "POST", headers: { "X-Checkout-Token": token }, body: { bookingId, gateway: "PHONEPE", currency: "INR" } });
  check("PhonePe sandbox checkout created", first.status === 200 && first.data?.orderId, `HTTP ${first.status} ${first.data?.state ?? first.data?.error ?? ""}`);
  if (first.status !== 200) return;
  const url = first.data.paymentUrl ? new URL(first.data.paymentUrl) : null;
  check("hosted checkout is a PhonePe HTTPS URL", url?.protocol === "https:" && url.hostname.endsWith(".phonepe.com"), url?.hostname ?? "no URL");
  const again = await call("/api/payments/checkout", { method: "POST", headers: { "X-Checkout-Token": token }, body: { bookingId, gateway: "PHONEPE", currency: "INR" } });
  check("repeat checkout reuses the same merchant order", again.data?.orderId === first.data.orderId, again.data?.orderId ?? again.data?.error);
  const other = await call("/api/payments/checkout", { method: "POST", headers: { "X-Checkout-Token": token }, body: { bookingId, gateway: "NOMOD", currency: "INR" } });
  check("second gateway (Nomod) refused for this booking", other.status === 409, `HTTP ${other.status}`);
  console.log(`\nOpen this sandbox page and ${expect === "COMPLETED" ? "COMPLETE" : "CANCEL / FAIL"} the payment (test instruments only):\n${first.data.paymentUrl}\n`);
  const final = await waitForFinal(token);
  check(`reconciled payment state is ${expect}`, final?.paymentState === expect, final?.paymentState ?? "timed out after 10 minutes");
  const s = await status(token);
  const expectedLedger = expect === "COMPLETED" ? "SUCCESS" : "FAILED";
  check(`payment status endpoint shows ${expectedLedger} from D1`, s?.payment?.gateway === "PHONEPE" && s?.payment?.status === expectedLedger, `${s?.payment?.gateway}:${s?.payment?.status}`);
  check("supplier booking NOT confirmed automatically", s?.booking?.status === "PAYMENT_PENDING" && !s?.booking?.pnr, `booking ${s?.booking?.status}`);
  const after = await call("/api/payments/checkout", { method: "POST", headers: { "X-Checkout-Token": token }, body: { bookingId, gateway: "NOMOD", currency: "INR" } });
  check("other gateway still refused after the PhonePe outcome", after.status === 409, `HTTP ${after.status}`);
}

async function refundFlow() {
  await guardStaging();
  const token = await checkoutToken();
  const r = await reconcile(token);
  const orderId = r.data?.orderId;
  check("paid PhonePe order found", r.data?.paymentState === "COMPLETED" && orderId, r.data?.paymentState ?? r.data?.error);
  if (!orderId) return;
  const refund = (requestId, amountMinor) =>
    call("/api/admin/settings/phonepe/refunds", { method: "POST", headers: admin(), body: { merchantOrderId: orderId, requestId, amountMinor } });
  const reqA = crypto.randomUUID();
  const a = await refund(reqA, 100);
  check("partial refund ₹1 accepted", a.status === 200 && a.data?.merchantRefundId, `HTTP ${a.status} ${a.data?.state ?? a.data?.error ?? ""}`);
  const replay = await refund(reqA, 100);
  check("replayed refund request returns the same refund (no second debit)", replay.data?.merchantRefundId === a.data?.merchantRefundId, replay.data?.merchantRefundId ?? replay.data?.error);
  const over = await refund(crypto.randomUUID(), 200);
  check("over-refund beyond captured amount refused", over.status !== 200, `HTTP ${over.status} ${over.data?.error ?? ""}`);
  const done = async (id) => {
    for (let i = 0; i < 60; i++) {
      const x = await call(`/api/admin/settings/phonepe/refunds/${encodeURIComponent(id)}/reconcile`, { method: "POST", headers: admin() });
      if (["COMPLETED", "FAILED"].includes(x.data?.state)) return x.data.state;
      await sleep(10000);
    }
    return "timed out after 10 minutes";
  };
  if (a.data?.merchantRefundId) check("partial refund reconciled COMPLETED", (await done(a.data.merchantRefundId)) === "COMPLETED");
  check("ledger shows PARTIAL_REFUND", (await status(token))?.payment?.status === "PARTIAL_REFUND");
  const b = await refund(crypto.randomUUID(), 100);
  check("remaining ₹1 refund accepted", b.status === 200 && b.data?.merchantRefundId, `HTTP ${b.status}`);
  if (b.data?.merchantRefundId) check("second refund reconciled COMPLETED", (await done(b.data.merchantRefundId)) === "COMPLETED");
  check("ledger shows REFUNDED", (await status(token))?.payment?.status === "REFUNDED");
}

async function webhookFlow() {
  await guardStaging();
  if (!env.STAGING_WEBHOOK_USERNAME || !env.STAGING_WEBHOOK_PASSWORD) die("set STAGING_WEBHOOK_USERNAME and STAGING_WEBHOOK_PASSWORD");
  const token = await checkoutToken();
  const before = await reconcile(token);
  const orderId = before.data?.orderId;
  check("PhonePe order found", orderId, before.data?.error);
  if (!orderId) return;
  const ledgerBefore = (await status(token))?.payment?.status;
  // A deliberately wrong state/amount: the API must only queue a status read.
  const forged = JSON.stringify({ event: "checkout.order.failed", payload: { merchantId: "unknown-merchant-check", merchantOrderId: orderId, state: "FAILED", amount: 1 } });
  const unauth = await call("/webhooks/phonepe", { method: "POST", body: forged, headers: { "x-tenant-slug": "zamra" } });
  check("unauthenticated webhook rejected", unauth.status === 401, `HTTP ${unauth.status}`);
  const sha = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.STAGING_WEBHOOK_USERNAME}:${env.STAGING_WEBHOOK_PASSWORD}`))).toString("hex");
  const wrongMerchant = await call("/webhooks/phonepe", { method: "POST", body: forged, headers: { Authorization: sha } });
  check("authenticated webhook for another merchant rejected", wrongMerchant.status === 400, `HTTP ${wrongMerchant.status}`);
  await sleep(15000);
  const ledgerAfter = (await status(token))?.payment?.status;
  check("ledger unchanged by forged webhook content", ledgerAfter === ledgerBefore, `${ledgerBefore} → ${ledgerAfter}`);
  console.log("\nGenuine webhook delivery: check the PhonePe sandbox dashboard webhook log for this order (HTTP 200), and that the order reached its state without the reconcile step.");
}

const flows = { preflight: guardStaging, pay: () => checkoutFlow("COMPLETED"), fail: () => checkoutFlow("FAILED"), refund: refundFlow, webhook: webhookFlow };
if (!flows[step]) die(`unknown step; use one of: ${Object.keys(flows).join(", ")}`);
try {
  await flows[step]();
} finally {
  if (results.length) appendFileSync("phonepe-sandbox-report.json", `${JSON.stringify({ at: new Date().toISOString(), host, results })}\n`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
