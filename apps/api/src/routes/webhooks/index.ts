import { Hono } from "hono";
import type { Env, Variables } from "../../types.js";
import { razorpayWebhook }  from "./razorpay.js";
import { nomodWebhook }     from "./nomod.js";
import { leadvyneWebhook }  from "./leadvyne.js";

export const webhookRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Payment gateway webhooks — signature-verified, not JWT-authenticated
webhookRoutes.post("/razorpay",  razorpayWebhook);
webhookRoutes.post("/nomod",     nomodWebhook);
webhookRoutes.post("/leadvyne",  leadvyneWebhook);

// Booking engine → Leadvyne notification passthrough
webhookRoutes.post("/notify/whatsapp", async (c) => {
  const signature = c.req.header("X-Signature");
  const body      = await c.req.json() as { tenantId: string; event: string; payload: unknown };

  // Derive tenant from the payload tenantId (this is a machine-to-machine call)
  // Verify HMAC-SHA256 signature against the webhook secret stored in leadvyne_configs
  // Route to the correct Leadvyne WhatsApp number for this tenant

  // TODO: verify signature + route to correct Chatwoot inbox

  await c.env.NOTIFY_QUEUE.send(body);

  return c.json({ ok: true });
});
