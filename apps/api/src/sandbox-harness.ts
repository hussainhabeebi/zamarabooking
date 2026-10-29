// D1-only PhonePe SANDBOX harness (Worker `zamra-phonepe-sandbox`).
//
// Exercises the production PhonePe code (PhonePeService, PhonePeClient,
// PhonePeD1Store, phonePeWebhook, reconcilePhonePe and the release gates) against
// the PhonePe sandbox, using synthetic bookings kept in the staging D1 database
// instead of Neon. It has no Neon, supplier, email or production bindings and
// refuses to run unless configured as the sandbox harness. Never mounted by the
// production API (src/index.ts).
import { Hono } from "hono";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import type { Env, Variables } from "./types.js";
import { digest, PhonePeError } from "./lib/phonepe/client.js";
import { phonePeClient, phonePeReadiness, phonePeReturnOrigin } from "./lib/phonepe/config.js";
import { PhonePeService } from "./lib/phonepe/service.js";
import {
  claimCheckoutGateway,
  claimLegacyGateway,
  PhonePeD1Store,
  phonePeLedgerStatus,
} from "./lib/phonepe/store.js";
import { phonePeWebhook } from "./routes/webhooks/phonepe.js";
import { reconcilePhonePe, type PhonePeReconcileMsg } from "./queue-consumer.js";

export const HARNESS_ENVIRONMENT = "phonepe-sandbox-harness";
type HarnessEnv = Env & { HARNESS_TOKEN?: string };
type Ctx = { Bindings: HarnessEnv; Variables: Variables };

/** Synthetic bookings for the harness only; never created in production D1. */
const BOOKINGS_DDL = `CREATE TABLE IF NOT EXISTS sandbox_bookings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 100 AND amount_minor <= 100000),
  currency TEXT NOT NULL CHECK (currency = 'INR'),
  status TEXT NOT NULL DEFAULT 'PAYMENT_PENDING',
  created_at INTEGER NOT NULL
)`;
type SandboxBooking = { id: string; tenant_id: string; amount_minor: number; currency: string; status: string };

export function harnessRefusal(env: HarnessEnv) {
  if (env.ENVIRONMENT !== HARNESS_ENVIRONMENT) return "not the sandbox harness";
  if (env.PHONEPE_ENVIRONMENT !== "sandbox") return "PhonePe environment must be sandbox";
  if (env.PHONEPE_PRODUCTION_APPROVED === "true") return "production approval flag is not allowed here";
  if (!env.PHONEPE_TENANT_ID?.startsWith("phonepe-sandbox")) return "synthetic sandbox tenant required";
  if (!env.PHONEPE_DB) return "PHONEPE_DB binding missing";
  if (!env.HARNESS_TOKEN || env.HARNESS_TOKEN.length < 32) return "HARNESS_TOKEN secret (32+ chars) missing";
  return null;
}
async function sameSecret(given: string, expected: string) {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function booking(db: D1Database, tenant: string, id: string) {
  await db.prepare(BOOKINGS_DDL).run();
  return db.prepare("SELECT * FROM sandbox_bookings WHERE tenant_id = ?1 AND id = ?2").bind(tenant, id).first<SandboxBooking>();
}
const orderId = async (tenant: string, bookingId: string) => `ZP${(await digest(`${tenant}\0${bookingId}`)).slice(0, 40)}`;
async function service(env: HarnessEnv, tenant: string, reconcile = false) {
  const r = await phonePeReadiness(env, tenant);
  return new PhonePeService(new PhonePeD1Store(env.PHONEPE_DB!), await phonePeClient(env, tenant, reconcile), tenant, r.environment);
}

export const harness = new Hono<Ctx>();
harness.onError((e, c) =>
  c.json({ error: e instanceof PhonePeError ? e.code : "Harness operation failed" }, e instanceof PhonePeError ? 409 : 500),
);
harness.use("*", async (c, next) => {
  const refusal = harnessRefusal(c.env);
  if (refusal) return c.json({ error: `Sandbox harness disabled: ${refusal}` }, 503);
  c.set("tenantId", c.env.PHONEPE_TENANT_ID!);
  // The webhook queues status reads; the harness runs them after responding with
  // the same reconcilePhonePe used by the API's queue consumer.
  const ctx = c.executionCtx as ExecutionContext;
  c.env = { ...c.env, BOOKING_QUEUE: { send: async (m: PhonePeReconcileMsg) => ctx.waitUntil(reconcilePhonePe(c.env, m)) } } as never;
  return next();
});

// Public: webhook (PhonePe SHA authentication inside) and the return page.
harness.post("/webhooks/phonepe", (c) => phonePeWebhook(c as never));
harness.get("/return", (c) =>
  c.html("<!doctype html><title>PhonePe sandbox return</title><p>Returned from PhonePe sandbox. The result is only confirmed by the authenticated status check, not by this page.</p>"),
);
harness.get("/health", async (c) => {
  const r = await phonePeReadiness(c.env, c.get("tenantId"));
  return c.json({ env: HARNESS_ENVIRONMENT, phonePeEnvironment: r.environment, configured: r.configured, gatesReady: r.gatesReady, enabled: r.enabled, ledger: "D1" });
});

// Everything else requires the harness token.
harness.use("*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !(await sameSecret(auth.slice(7), c.env.HARNESS_TOKEN!)))
    return c.json({ error: "Harness token required" }, 401);
  return next();
});

harness.put("/settings/phonepe", async (c) => {
  const { enabled } = await c.req.json<{ enabled?: unknown }>();
  if (typeof enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
  const r = await phonePeReadiness(c.env, c.get("tenantId"));
  if (enabled && !r.gatesReady) return c.json({ error: "Release gates have not passed" }, 409);
  await c.env.TENANT_CACHE_KV.put(`admin_settings:${c.get("tenantId")}:phonepe`, JSON.stringify({ enabled }));
  return c.json({ ok: true, enabled });
});

harness.post("/bookings", async (c) => {
  const { amountMinor = 200 } = await c.req.json<{ amountMinor?: number }>().catch(() => ({} as { amountMinor?: number }));
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 100 || amountMinor > 100000)
    return c.json({ error: "amountMinor must be 100–100000 paise (₹1–₹1000)" }, 400);
  const db = c.env.PHONEPE_DB!;
  await db.prepare(BOOKINGS_DDL).run();
  const id = `sbx-${crypto.randomUUID()}`;
  await db.prepare("INSERT INTO sandbox_bookings (id, tenant_id, amount_minor, currency, created_at) VALUES (?1, ?2, ?3, 'INR', ?4)")
    .bind(id, c.get("tenantId"), amountMinor, Date.now()).run();
  return c.json({ bookingId: id, amountMinor, currency: "INR", status: "PAYMENT_PENDING", synthetic: true });
});

harness.post("/bookings/:id/checkout", async (c) => {
  const tenant = c.get("tenantId");
  const b = await booking(c.env.PHONEPE_DB!, tenant, c.req.param("id"));
  if (!b) return c.json({ error: "Synthetic booking not found" }, 404);
  const s = await service(c.env, tenant); // Gates and Admin opt-in first.
  if (b.status !== "PAYMENT_PENDING") return c.json({ error: "Booking not payable" }, 409);
  await claimCheckoutGateway(c.env.PHONEPE_DB!, tenant, b.id, "PHONEPE");
  const origin = phonePeReturnOrigin(c.env);
  if (!origin) throw new PhonePeError("RETURN_ORIGIN_REQUIRED");
  return c.json(await s.checkout({ id: b.id, totalAmount: (b.amount_minor / 100).toFixed(2), currency: "INR" }, `${origin}/return?bookingId=${encodeURIComponent(b.id)}`));
});

// One-gateway-per-booking check for Nomod/Razorpay/wallet without calling them.
harness.post("/bookings/:id/claim/:gateway", async (c) => {
  const gateway = c.req.param("gateway");
  if (!["NOMOD", "RAZORPAY", "WALLET"].includes(gateway)) return c.json({ error: "gateway must be NOMOD, RAZORPAY or WALLET" }, 400);
  const b = await booking(c.env.PHONEPE_DB!, c.get("tenantId"), c.req.param("id"));
  if (!b) return c.json({ error: "Synthetic booking not found" }, 404);
  await claimLegacyGateway(c.env, c.get("tenantId"), b.id, gateway as "NOMOD");
  return c.json({ claimed: gateway });
});

harness.post("/bookings/:id/reconcile", async (c) => {
  const tenant = c.get("tenantId");
  const s = await service(c.env, tenant, true);
  return c.json(await s.reconcile(await orderId(tenant, c.req.param("id"))));
});

harness.get("/bookings/:id", async (c) => {
  const tenant = c.get("tenantId");
  const db = c.env.PHONEPE_DB!;
  const b = await booking(db, tenant, c.req.param("id"));
  if (!b) return c.json({ error: "Synthetic booking not found" }, 404);
  const store = new PhonePeD1Store(db);
  const o = await store.bookingOrder(tenant, b.id);
  const claim = await db.prepare("SELECT gateway FROM payment_checkout_claims WHERE tenant_id = ?1 AND booking_id = ?2").bind(tenant, b.id).first<{ gateway: string }>();
  const { results: refunds } = await db.prepare("SELECT merchant_refund_id, amount_minor, state, provider_refund_id FROM phonepe_refunds WHERE tenant_id = ?1 AND merchant_order_id = ?2").bind(tenant, o?.merchantOrderId ?? "").all();
  return c.json({
    booking: { id: b.id, status: b.status, amountMinor: b.amount_minor, synthetic: true },
    claim: claim?.gateway ?? null,
    order: o && { merchantOrderId: o.merchantOrderId, state: o.state, ledgerStatus: phonePeLedgerStatus(o), amountMinor: o.amountMinor, refundReservedMinor: o.refundReservedMinor, refundedMinor: o.refundedMinor, transactionId: o.transactionId },
    refunds,
  });
});

harness.post("/refunds", async (c) => {
  const { bookingId, requestId, amountMinor } = await c.req.json<{ bookingId?: string; requestId?: string; amountMinor?: number }>();
  if (typeof bookingId !== "string" || typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId) || !Number.isSafeInteger(amountMinor))
    return c.json({ error: "bookingId, requestId (UUID) and integer amountMinor required" }, 400);
  const tenant = c.get("tenantId");
  return c.json(await (await service(c.env, tenant)).refund(await orderId(tenant, bookingId), requestId, amountMinor!));
});
harness.post("/refunds/:id/reconcile", async (c) =>
  c.json(await (await service(c.env, c.get("tenantId"), true)).reconcileRefund(c.req.param("id"))),
);

export default {
  fetch: (req: Request, env: HarnessEnv, ctx: ExecutionContext) => harness.fetch(req, env, ctx),
};
