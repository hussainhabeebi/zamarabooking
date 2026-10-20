import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env, Variables } from "./types.js";
import { resolveTenant } from "./middleware/tenant.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/ratelimit.js";
import { searchRoutes }        from "./routes/search.js";
import { hotelRoutes }         from "./routes/hotel.js";
import { insuranceRoutes }     from "./routes/insurance.js";
import { aiRoutes }            from "./routes/ai.js";
import { fareRoutes }          from "./routes/fares.js";
import { agentPortalRoutes, agentPublicRoutes } from "./routes/agent-portal.js";
import { sweepFareAlerts }     from "./lib/fare-alert-sweep.js";
import { bookingRoutes }       from "./routes/booking.js";
import { duffelSandboxRoutes } from "./routes/duffel-sandbox.js";
import { bookDirectRoutes }    from "./routes/book.js";
import { integrationRoutes }   from "./routes/integrations.js";
import { agentRoutes }         from "./routes/agents.js";
import { walletRoutes }        from "./routes/wallet.js";
import { authRoutes }          from "./routes/auth.js";
import { adminRoutes }         from "./routes/admin/index.js";
import { webhookRoutes }       from "./routes/webhooks/index.js";
import { TenantRateLimiter }   from "./lib/rate-limiter.js";
import { handleBookingQueue, handleNotifyQueue } from "./queue-consumer.js";
import { paymentRoutes }       from "./routes/payments.js";
import { eticketRoutes }       from "./routes/eticket.js";
import { refreshAutoRates } from "./lib/fx.js";
import { staffPasswordRoutes } from "./routes/admin/users.js";
import { sessionRoutes }       from "./routes/session.js";
import { checkoutRoutes }      from "./routes/checkout.js";
import { whatsappRoutes }      from "./routes/whatsapp.js";
import { partnerRoutes }       from "./routes/partner.js";
import { profileRoutes }       from "./routes/profile.js";
import { customerWalletRoutes } from "./routes/customer-wallet.js";
import { customerTripRoutes, guestTripRoutes } from "./routes/trips.js";
import { customerAccountRoutes, customerSupportRoutes, createGuestSupportRequest } from "./routes/customer-account.js";

export { TenantRateLimiter };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", cors({origin:(origin)=>origin,credentials:true,allowMethods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"],allowHeaders:["Content-Type","Authorization","X-Tenant-ID","X-API-Key","x-tenant-slug","X-Session-ID","X-Channel","X-POOMAS-INTEGRATION-KEY","X-Checkout-Token","X-Trip-Token","X-FP-Agent"],exposeHeaders:["Content-Disposition"]}));
app.get("/health",(c)=>c.json({status:"ok",env:c.env.ENVIRONMENT,worker:"poomas-api",timestamp:new Date().toISOString()}));
app.use("*", resolveTenant);
app.use("/api/*", rateLimitMiddleware);

// ── Public routes (no auth) ────────────────────────────────────
app.route("/api/auth",           authRoutes);
app.route("/api/auth/staff",     staffPasswordRoutes);   // admin staff: forgot / set password (public)
app.route("/webhooks",           webhookRoutes);
app.route("/api/search",         searchRoutes);
app.route("/api/hotels",         hotelRoutes);
app.route("/api/insurance",      insuranceRoutes);
app.route("/api/ai",             aiRoutes);
app.route("/api/fares",          fareRoutes);
app.route("/api/agent-public",   agentPublicRoutes);
app.route("/api/duffel-sandbox", duffelSandboxRoutes);
app.route("/api/book",           bookDirectRoutes);
app.route("/api/integrations",   integrationRoutes);
app.route("/api/partner/v1",    partnerRoutes);
// Guest "find my booking" — authorised by a short-lived signed trip token.
app.route("/api/trips",          guestTripRoutes);
app.post("/api/trips/support",   createGuestSupportRequest);

// Checkout token verification — validated by the signed JWT token itself
app.route("/api/checkout",       checkoutRoutes);

// ── Authenticated routes ───────────────────────────────────────
app.use("/api/bookings/*", authMiddleware);
app.use("/api/payments/*", authMiddleware);
app.use("/api/eticket/*",  authMiddleware);
app.use("/api/agents/*",   authMiddleware);
app.use("/api/agent/*",    authMiddleware);
app.use("/api/wallet/*",   authMiddleware);
app.use("/api/session/*",  authMiddleware);
// Admin service-token bypass: if ADMIN_SERVICE_TOKEN is set and matches the
// Authorization header, skip JWT verification and grant SUPER_ADMIN access.
app.use("/api/admin/*", async (c, next) => {
  const serviceToken = c.env.ADMIN_SERVICE_TOKEN;
  if (serviceToken) {
    const auth = c.req.header("Authorization") ?? "";
    if (auth === `Bearer ${serviceToken}`) {
      c.set("userRole", "SUPER_ADMIN");
      return next();
    }
  }
  return authMiddleware(c, next);
});
app.use("/api/profile/*", authMiddleware);
app.use("/api/whatsapp/*", authMiddleware);

app.route("/api/session",  sessionRoutes);
app.route("/api/bookings", bookingRoutes);
app.route("/api/payments", paymentRoutes);
app.route("/api/eticket",  eticketRoutes);
app.route("/api/agents",   agentRoutes);
app.route("/api/agent/trips", customerTripRoutes);   // agency portal: same trip routes, agency-scoped
app.route("/api/agent",    agentPortalRoutes);
app.route("/api/wallet",   walletRoutes);
app.route("/api/whatsapp", whatsappRoutes);
app.route("/api/admin",    adminRoutes);
app.route("/api/profile/wallet", customerWalletRoutes);
app.route("/api/profile/trips",   customerTripRoutes);
app.route("/api/profile/account", customerAccountRoutes);
app.route("/api/profile/support", customerSupportRoutes);
app.route("/api/profile",  profileRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  const status = "status" in err ? (err as { status: number }).status : 500;

  // Sanitize SupplierError: expose only the human-readable body, not the supplier name or HTTP code
  if ((err as any).name === "SupplierError") {
    const body: string = (err as any).body ?? "Something went wrong — please try again";
    const isExpired = /(?:fare|price|booking session)\s+(?:has\s+|is\s+)?expired|fare\s+(?:is\s+)?no longer available|sold[ -]?out/i.test(body);
    return c.json(
      { error: body, errorCode: isExpired ? "FARE_EXPIRED" : "SUPPLIER_ERROR" },
      (status >= 400 && status < 600 ? status : 502) as 400 | 422 | 500 | 502,
    );
  }

  return c.json({ error: err.message ?? "Internal server error" }, status as 400 | 500);
});

export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    if (batch.queue === "poomas-bookings") {
      await handleBookingQueue(batch as MessageBatch<never>, env);
    } else if (batch.queue === "poomas-notifications") {
      await handleNotifyQueue(batch as MessageBatch<never>, env);
    }
  },
  // Cron (wrangler.toml [triggers]): re-check routes with fare alerts.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepFareAlerts(env).then((r) => console.info("[fare-alert-sweep]", r)).catch((err) => console.error("[fare-alert-sweep]", err)));
    // Automatic exchange rates (INR ↔ GCC currencies, USD) for prices and AED payments.
    ctx.waitUntil(refreshAutoRates(env).then((r) => console.info("[fx] auto rates", r.ok ? r.rates.source : r.error)).catch((err) => console.error("[fx]", err)));
  },
};
