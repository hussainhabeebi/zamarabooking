import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Env, Variables } from "../../types.js";
import { phonePeReadiness } from "../../lib/phonepe/config.js";
import { phonePeService } from "../../lib/phonepe/http.js";
import { PhonePeD1Store, phonePeLedgerStatus } from "../../lib/phonepe/store.js";
import { PhonePeError } from "../../lib/phonepe/client.js";
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
// Read-only D1 ledger view for Admin reconciliation (no provider call, no secrets).
phonePeAdminRoutes.get("/orders", async (c) => {
  if (c.env.PHONEPE_SCHEMA_READY !== "true" || !c.env.PHONEPE_DB) return c.json({ orders: [] });
  const orders = await new PhonePeD1Store(c.env.PHONEPE_DB).recentOrders(c.get("tenantId"));
  return c.json({
    orders: orders.map((o) => ({
      merchantOrderId: o.merchantOrderId, bookingId: o.bookingId, environment: o.environment,
      amountMinor: o.amountMinor, refundedMinor: o.refundedMinor, state: o.state,
      ledgerStatus: phonePeLedgerStatus(o), transactionId: o.transactionId,
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
