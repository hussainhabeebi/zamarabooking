// POST /api/whatsapp/send     — send message to WhatsApp via Leadvyne
// POST /api/whatsapp/template — send template message (for e-ticket / booking confirmation)
// GET  /api/whatsapp/status   — check connection status with Leadvyne

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Env, Variables } from "../types.js";

export const whatsappRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Leadvyne client helpers ────────────────────────────────────────────────────

interface LeadvyneConfig {
  apiKey:    string;
  apiSecret: string;
  baseUrl:   string;
  instanceId: string;
}

async function getLeadvyneConfig(env: Env, tenantId: string): Promise<LeadvyneConfig> {
  let saved: any = null;
  try {
    const raw = await env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:whatsapp`);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }

  const apiKey = saved?.leadvyne?.apiKey || env.LEADVYNE_API_KEY;
  const instanceId = saved?.leadvyne?.instanceId || env.LEADVYNE_INSTANCE_ID;
  if (!apiKey || !instanceId) {
    throw new HTTPException(503, { message: "WhatsApp gateway not configured" });
  }

  return {
    apiKey,
    apiSecret: saved?.leadvyne?.apiSecret || env.LEADVYNE_API_SECRET || "",
    baseUrl: (saved?.leadvyne?.baseUrl || env.LEADVYNE_BASE_URL || "https://api.leadvyne.com").replace(/\/$/, ""),
    instanceId,
  };
}

async function leadvyneFetch(cfg: LeadvyneConfig, path: string, body?: unknown) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method:  body ? "POST" : "GET",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${cfg.apiKey}`,
      "X-Instance-ID": cfg.instanceId,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HTTPException(502, { message: `Leadvyne error ${res.status}: ${text}` });
  }
  return res.json();
}

// ── Routes ─────────────────────────────────────────────────────────────────────

const sendSchema = z.object({
  to:      z.string().min(8),  // E.164 phone, e.g. "971501234567"
  message: z.string().min(1).max(4096),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(["image", "document", "audio", "video"]).optional(),
});

whatsappRoutes.post("/send", zValidator("json", sendSchema), async (c) => {
  const { to, message, mediaUrl, mediaType } = c.req.valid("json");
  const cfg = await getLeadvyneConfig(c.env, c.get("tenantId"));

  const payload: Record<string, unknown> = { to, message };
  if (mediaUrl) {
    payload.media = { url: mediaUrl, type: mediaType ?? "document" };
  }

  const result = await leadvyneFetch(cfg, "/v1/messages/send", payload);
  return c.json(result);
});

const templateSchema = z.object({
  to:           z.string().min(8),
  templateName: z.string(),
  language:     z.string().default("en"),
  components:   z.array(z.object({
    type:       z.string(),
    parameters: z.array(z.record(z.unknown())),
  })).optional(),
});

whatsappRoutes.post("/template", zValidator("json", templateSchema), async (c) => {
  const body = c.req.valid("json");
  const cfg  = await getLeadvyneConfig(c.env, c.get("tenantId"));

  const result = await leadvyneFetch(cfg, "/v1/messages/template", {
    to:           body.to,
    templateName: body.templateName,
    language:     body.language,
    components:   body.components ?? [],
  });
  return c.json(result);
});

whatsappRoutes.get("/status", async (c) => {
  try {
    const cfg    = await getLeadvyneConfig(c.env, c.get("tenantId"));
    const result = await leadvyneFetch(cfg, "/v1/instance/status");
    return c.json({ configured: true, ...result as object });
  } catch (err: any) {
    if (err.status === 503) return c.json({ configured: false, error: err.message });
    return c.json({ configured: true, error: err.message, status: "error" });
  }
});
