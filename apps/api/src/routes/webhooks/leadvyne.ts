// POST /webhooks/leadvyne — inbound messages from Leadvyne WhatsApp gateway
// Leadvyne sends HMAC-SHA256 signed payloads when a user sends a message

import type { Handler } from "hono";
import type { Env, Variables } from "../../types.js";

export const leadvyneWebhook: Handler<{ Bindings: Env; Variables: Variables }> = async (c) => {
  const rawBody   = await c.req.text();
  const signature = c.req.header("X-Leadvyne-Signature") ?? "";

  if (c.env.LEADVYNE_WEBHOOK_SECRET && signature) {
    const secret   = new TextEncoder().encode(c.env.LEADVYNE_WEBHOOK_SECRET);
    const data     = new TextEncoder().encode(rawBody);
    const key      = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(Buffer.from(signature.replace("sha256=", ""), "hex"));
    const valid    = await crypto.subtle.verify("HMAC", key, sigBytes, data);
    if (!valid) return c.json({ error: "Invalid signature" }, 400);
  }

  const event = JSON.parse(rawBody) as {
    event:       string;
    instanceId:  string;
    from:        string;
    messageId:   string;
    timestamp:   number;
    type:        "text" | "image" | "document" | "audio" | "button";
    text?:       string;
    media?:      { url: string; mimeType: string; caption?: string };
    button?:     { id: string; title: string };
  };

  // Forward to notification queue for the bot to consume
  await c.env.NOTIFY_QUEUE.send({
    type:      "WHATSAPP_INBOUND",
    from:      event.from,
    messageId: event.messageId,
    text:      event.text,
    media:     event.media,
    button:    event.button,
    timestamp: event.timestamp,
  });

  return c.json({ ok: true });
};
