// Simulated staging API for testing scripts/phonepe-sandbox-acceptance.mjs offline.
// MOCK_BREAK=<name> makes one behavior wrong so the script must report FAIL.
const brk = process.env.MOCK_BREAK ?? "";
const order = { orderId: "ZPmockorder", state: "PENDING", paymentState: "PENDING", refunds: new Map(), reserved: 0, refunded: 0 };
const amount = 200;
const json = (data, status = 200) => Response.json(data, { status });
let claims = "PHONEPE";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(init.body) : null;
  const h = init.headers ?? {};
  if (url.pathname === "/health") return json({ status: "ok", env: brk === "health" ? "production" : "staging" });
  if (url.pathname === "/api/payments/checkout") {
    if (body.gateway !== claims)
      return brk === "claims" ? json({ paymentUrl: "https://pay.nomod.com/mock" }) : json({ error: "A different payment gateway is reserved for this booking" }, 409);
    return json({ orderId: brk === "idempotency" ? `ZP${Math.random()}` : order.orderId, state: "PENDING", paymentUrl: "https://mercury-uat.phonepe.com/transact/mock", supplierConfirmed: false });
  }
  if (url.pathname === "/api/payments/phonepe/reconcile") {
    order.paymentState = process.env.MOCK_OUTCOME ?? "COMPLETED";
    return json({ orderId: order.orderId, state: order.paymentState, paymentUrl: null, supplierConfirmed: false, paymentState: order.paymentState });
  }
  if (url.pathname.startsWith("/api/payments/")) {
    const status = order.paymentState === "FAILED" ? "FAILED" : order.refunded >= amount ? "REFUNDED" : order.refunded > 0 ? "PARTIAL_REFUND" : "SUCCESS";
    return json({ payment: { gateway: "PHONEPE", status }, booking: { status: brk === "supplier" ? "CONFIRMED" : "PAYMENT_PENDING", pnr: null } });
  }
  if (url.pathname === "/api/admin/settings/phonepe/refunds") {
    if (!String(h.Authorization ?? "").startsWith("Bearer ")) return json({ error: "auth" }, 401);
    const existing = order.refunds.get(body.requestId);
    if (existing && brk !== "replay") return json(existing);
    if (order.reserved + body.amountMinor > amount && brk !== "overrefund") return json({ error: "REFUND_LIMIT_EXCEEDED" }, 503);
    order.reserved += body.amountMinor;
    const r = { merchantRefundId: `ZR${order.refunds.size}${Math.random()}`, amountMinor: body.amountMinor, state: "PENDING" };
    order.refunds.set(body.requestId, r);
    return json(r);
  }
  const m = url.pathname.match(/^\/api\/admin\/settings\/phonepe\/refunds\/([^/]+)\/reconcile$/);
  if (m) {
    const r = [...order.refunds.values()].find((x) => x.merchantRefundId === decodeURIComponent(m[1]));
    if (r.state !== "COMPLETED") order.refunded += r.amountMinor;
    r.state = "COMPLETED";
    return json(r);
  }
  if (url.pathname === "/webhooks/phonepe") {
    if (!h.Authorization) return json({ error: "Invalid webhook authorization" }, brk === "webhook" ? 200 : 401);
    return json({ error: "Webhook merchant mismatch" }, 400);
  }
  return json({ error: "not found" }, 404);
};
// The webhook step waits 15 s for queued reads; keep tests fast.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.min(ms, 5), ...a);
