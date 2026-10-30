import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Env, Variables } from "../../types.js";
import { phonePeReadiness } from "../../lib/phonepe/config.js";
import { phonePeService } from "../../lib/phonepe/http.js";
import { desc, eq } from "drizzle-orm";
import { payments, phonepeOrders } from "@zamrabooking/db/schema";
import { digest, PhonePeClient, PhonePeError } from "../../lib/phonepe/client.js";
export const phonePeAdminRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();
phonePeAdminRoutes.onError((e, c) =>
  c.json(
    {
      error:
        e instanceof PhonePeError
          ? e.message
          : "PhonePe settings operation unavailable",
    },
    503,
  ),
);
phonePeAdminRoutes.use("*", async (c, next) => {
  if (!["SUPER_ADMIN", "TENANT_ADMIN"].includes(c.get("userRole") ?? ""))
    return c.json({ error: "Full admin access required" }, 403);
  return next();
});
// Staging-only connection diagnostic: requests a PhonePe SANDBOX OAuth token with
// the stored secrets and discards it. No order, payment, refund, database, KV or
// queue access; works while the release gates are off. Only the exact
// ADMIN_SERVICE_TOKEN may call it (not admin user sessions), and the response
// carries no token, credential or provider body: ok, environment, time, error code.
const sameSecret = async (given: string, expected: string) => {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
phonePeAdminRoutes.post("/connection-test", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const expected = c.env.ADMIN_SERVICE_TOKEN;
  if (!expected || !auth.startsWith("Bearer ") || !(await sameSecret(auth.slice(7), expected)))
    return c.json({ ok: false, error: "SERVICE_TOKEN_REQUIRED" }, 403);
  if (c.env.ENVIRONMENT === "production" || c.env.PHONEPE_ENVIRONMENT !== "sandbox")
    return c.json({ ok: false, error: "STAGING_SANDBOX_ONLY" }, 404);
  const checkedAt = new Date().toISOString();
  try {
    await new PhonePeClient({
      tenantId: c.env.PHONEPE_TENANT_ID ?? "",
      environment: "sandbox",
      clientId: c.env.PHONEPE_CLIENT_ID ?? "",
      clientSecret: c.env.PHONEPE_CLIENT_SECRET ?? "",
      clientVersion: c.env.PHONEPE_CLIENT_VERSION ?? "",
    }).verifyAuthentication();
    return c.json({ ok: true, environment: "sandbox", checkedAt });
  } catch (e) {
    const error = e instanceof PhonePeError ? e.code : "UNEXPECTED_ERROR";
    const httpStatus = e instanceof PhonePeError && e.httpStatus ? { httpStatus: e.httpStatus } : {};
    return c.json({ ok: false, environment: "sandbox", checkedAt, error, ...httpStatus }, error === "CREDENTIALS_MISSING" ? 503 : 502);
  }
});
phonePeAdminRoutes.get("/", async (c) =>
  c.json(await phonePeReadiness(c.env, c.get("tenantId"))),
);
phonePeAdminRoutes.put(
  "/",
  zValidator("json", z.object({ enabled: z.boolean() }).strict()),
  async (c) => {
    const r = await phonePeReadiness(c.env, c.get("tenantId"));
    if (c.req.valid("json").enabled && !r.gatesReady)
      return c.json(
        {
          error:
            "Schema, merchant activation and release approval gates have not passed",
        },
        409,
      );
    await c.env.TENANT_CACHE_KV.put(
      `admin_settings:${c.get("tenantId")}:phonepe`,
      JSON.stringify(c.req.valid("json")),
    );
    return c.json({ ok: true });
  },
);
// Read-only ledger view for Admin reconciliation (no provider call, no secrets).
phonePeAdminRoutes.get("/orders", async (c) => {
  if (c.env.PHONEPE_SCHEMA_READY !== "true") return c.json({ orders: [] });
  const rows = await c.get("db")
    .select({ o: phonepeOrders, status: payments.status, refunded: payments.refundedAmount })
    .from(phonepeOrders)
    .innerJoin(payments, eq(payments.id, phonepeOrders.paymentId))
    .where(eq(phonepeOrders.tenantId, c.get("tenantId")))
    .orderBy(desc(phonepeOrders.updatedAt))
    .limit(50);
  return c.json({
    orders: rows.map(({ o, status, refunded }) => ({
      merchantOrderId: o.merchantOrderId, bookingId: o.bookingId, environment: o.environment,
      amountMinor: o.amountMinor, refundedMinor: Math.round(Number(refunded ?? 0) * 100), state: o.state,
      ledgerStatus: status, transactionId: o.transactionId,
      updatedAt: o.updatedAt.toISOString(), supplierConfirmed: false,
    })),
  });
});
phonePeAdminRoutes.post(
  "/refunds",
  zValidator(
    "json",
    z
      .object({
        merchantOrderId: z.string().min(1).max(63),
        requestId: z.string().uuid(),
        amountMinor: z.number().int().min(100).max(2147483647),
      })
      .strict(),
  ),
  async (c) => {
    const b = c.req.valid("json");
    const s = await phonePeService(c);
    return c.json(
      await s.refund(b.merchantOrderId, b.requestId, b.amountMinor),
    );
  },
);
phonePeAdminRoutes.post("/refunds/:id/reconcile", async (c) =>
  c.json(
    await (await phonePeService(c, true)).reconcileRefund(c.req.param("id")),
  ),
);
