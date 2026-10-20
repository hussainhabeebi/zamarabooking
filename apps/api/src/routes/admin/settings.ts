// GET  /api/admin/settings/payments   — get payment gateway config
// PUT  /api/admin/settings/payments   — save payment gateway config (Razorpay + NoMod)
// GET  /api/admin/settings/whatsapp   — get Leadvyne / WhatsApp config
// PUT  /api/admin/settings/whatsapp   — save Leadvyne config
// GET  /api/admin/settings/eticket    — get e-ticket delivery config
// PUT  /api/admin/settings/eticket    — save e-ticket delivery config
// GET  /api/admin/settings/fx         — exchange rates: automatic, manual, effective
// PUT  /api/admin/settings/fx         — save mode (auto/manual), margin %, manual rates
// POST /api/admin/settings/fx/refresh — fetch live rates now
// GET  /api/admin/settings/email      — Resend email settings (key masked) + status
// PUT  /api/admin/settings/email      — save sender, reply-to, ops copy, optional API key
// POST /api/admin/settings/email/test — send a test email
// GET  /api/admin/settings/email/logs — recent emails (sent / failed / skipped)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env, Variables } from "../../types.js";
import { RAZORPAY_ENABLED } from "../../lib/payment-gateway.js";
import { DEFAULT_EMAIL_SETTINGS, emailLayout, getEmailSettings, resendKey, saveEmailSettings, sendMail } from "../../lib/email.js";
import { emailLogs } from "@poomas/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { FOREIGN_CURRENCIES, getFx, getFxSettings, readAutoRates, refreshAutoRates, saveFxSettings, type FxSettings } from "../../lib/fx.js";

export const settingsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const SETTINGS_TTL = 60 * 60 * 24 * 365;  // 1 year

function settingsKey(tenantId: string, section: string) {
  return `admin_settings:${tenantId}:${section}`;
}

async function getSettings<T>(env: Env, tenantId: string, section: string): Promise<T | null> {
  const raw = await env.TENANT_CACHE_KV.get(settingsKey(tenantId, section));
  return raw ? JSON.parse(raw) as T : null;
}

async function saveSettings(env: Env, tenantId: string, section: string, data: unknown) {
  await env.TENANT_CACHE_KV.put(settingsKey(tenantId, section), JSON.stringify(data), {
    expirationTtl: SETTINGS_TTL,
  });
}

// ── Payment settings ──────────────────────────────────────────────────────────

const paymentsSchema = z.object({
  razorpay: z.object({
    enabled:    z.boolean(),
    keyId:      z.string().optional(),
    keySecret:  z.string().optional(),
    webhookSecret: z.string().optional(),
  }).optional(),
  nomod: z.object({
    enabled:       z.boolean(),
    apiKey:        z.string().optional(),
    apiSecret:     z.string().optional(),
    webhookSecret: z.string().optional(),
    environment:   z.enum(["sandbox", "production"]).default("production"),
    allowTabby:    z.boolean().default(true),
    allowTamara:   z.boolean().default(true),
    // INR per 1 AED, used to charge AED to customers who choose AED. Empty/null = AED payment off.
    aedRate:       z.number().positive().max(1000).nullable().optional(),
  }).optional(),
  defaultGateway: z.enum(["RAZORPAY", "NOMOD"]).default("NOMOD"),
});

settingsAdminRoutes.get("/payments", async (c) => {
  const tenantId = c.get("tenantId");
  const saved = await getSettings<any>(c.env, tenantId, "payments");
  if (!saved) {
    return c.json({
      razorpay: { enabled: false, keyId: "", keySecret: "", webhookSecret: "", configured: false },
      nomod: { enabled: false, apiKey: "", apiSecret: "", webhookSecret: "", environment: "production", allowTabby: true, allowTamara: true, configured: false },
      defaultGateway: "NOMOD",
    });
  }

  // Never send stored secret values back to the browser.
  return c.json({
    ...saved,
    razorpay: {
      ...saved.razorpay,
      keySecret: "",
      webhookSecret: "",
      configured: Boolean(saved.razorpay?.keyId && saved.razorpay?.keySecret),
    },
    nomod: {
      ...saved.nomod,
      apiKey: "",
      apiSecret: "",
      webhookSecret: "",
      allowTabby: saved.nomod?.allowTabby ?? true,
      allowTamara: saved.nomod?.allowTamara ?? true,
      configured: Boolean(saved.nomod?.apiKey),
    },
  });
});

settingsAdminRoutes.put("/payments", zValidator("json", paymentsSchema), async (c) => {
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");

  // Mask secrets when persisting — only update if non-empty
  const existing = await getSettings<typeof body>(c.env, tenantId, "payments") ?? {};
  const merged   = {
    ...existing,
    ...body,
    razorpay: body.razorpay ? {
      ...(existing as any)?.razorpay,
      enabled:       body.razorpay.enabled,
      keyId:         body.razorpay.keyId      || (existing as any)?.razorpay?.keyId,
      keySecret:     body.razorpay.keySecret  || (existing as any)?.razorpay?.keySecret,
      webhookSecret: body.razorpay.webhookSecret || (existing as any)?.razorpay?.webhookSecret,
    } : (existing as any)?.razorpay,
    nomod: body.nomod ? {
      ...(existing as any)?.nomod,
      enabled:       body.nomod.enabled,
      apiKey:        body.nomod.apiKey        || (existing as any)?.nomod?.apiKey,
      apiSecret:     body.nomod.apiSecret     || (existing as any)?.nomod?.apiSecret,
      webhookSecret: body.nomod.webhookSecret || (existing as any)?.nomod?.webhookSecret,
      environment:   body.nomod.environment,
      allowTabby:    body.nomod.allowTabby,
      allowTamara:   body.nomod.allowTamara,
      aedRate:       body.nomod.aedRate === undefined ? (existing as any)?.nomod?.aedRate ?? null : body.nomod.aedRate,
    } : (existing as any)?.nomod,
  };
  // Nomod is the only gateway accepting new payments.
  if (!RAZORPAY_ENABLED) {
    merged.defaultGateway = "NOMOD";
    if (merged.razorpay) merged.razorpay = { ...merged.razorpay, enabled: false };
  }

  await saveSettings(c.env, tenantId, "payments", merged);
  return c.json({ ok: true });
});

// Validate the stored Nomod key without exposing it to the admin browser.
settingsAdminRoutes.post("/payments/test-nomod", async (c) => {
  const tenantId = c.get("tenantId");
  const saved = await getSettings<any>(c.env, tenantId, "payments");
  const apiKey = saved?.nomod?.apiKey || c.env.NOMOD_API_KEY;
  if (!saved?.nomod?.enabled || !apiKey) {
    return c.json({ ok: false, message: "Enable Nomod and save an API key first" }, 400);
  }

  const res = await fetch("https://api.nomod.com/v1/links", {
    headers: { "X-API-KEY": apiKey },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const raw = await res.text();
    return c.json({ ok: false, message: raw.slice(0, 180) || `Nomod returned HTTP ${res.status}` }, 502);
  }
  return c.json({ ok: true, mode: apiKey.startsWith("sk_test_") ? "test" : "live" });
});

// ── WhatsApp / Leadvyne settings ──────────────────────────────────────────────

const whatsappSchema = z.object({
  enabled:    z.boolean(),
  provider:   z.enum(["LEADVYNE", "WABA_DIRECT"]).default("LEADVYNE"),
  leadvyne: z.object({
    apiKey:     z.string().optional(),
    apiSecret:  z.string().optional(),
    instanceId: z.string().optional(),
    baseUrl:    z.string().url().optional(),
  }).optional(),
  defaultCountryCode: z.string().default("91"),
  eticketTemplate:    z.string().default("poomas_eticket_v1"),
  bookingConfirmTemplate: z.string().default("poomas_booking_confirm_v1"),
  webhookSecret: z.string().optional(),
});

settingsAdminRoutes.get("/whatsapp", async (c) => {
  const tenantId = c.get("tenantId");
  const saved    = await getSettings(c.env, tenantId, "whatsapp");
  return c.json(saved ?? {
    enabled:  false,
    provider: "LEADVYNE",
    leadvyne: {},
    defaultCountryCode: "91",
    eticketTemplate:    "poomas_eticket_v1",
    bookingConfirmTemplate: "poomas_booking_confirm_v1",
  });
});

settingsAdminRoutes.put("/whatsapp", zValidator("json", whatsappSchema), async (c) => {
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");
  const existing = await getSettings<any>(c.env, tenantId, "whatsapp") ?? {};

  const merged = {
    ...existing,
    ...body,
    leadvyne: body.leadvyne ? {
      ...existing?.leadvyne,
      apiKey:     body.leadvyne.apiKey     || existing?.leadvyne?.apiKey,
      apiSecret:  body.leadvyne.apiSecret  || existing?.leadvyne?.apiSecret,
      instanceId: body.leadvyne.instanceId || existing?.leadvyne?.instanceId,
      baseUrl:    body.leadvyne.baseUrl    || existing?.leadvyne?.baseUrl,
    } : existing?.leadvyne,
  };

  await saveSettings(c.env, tenantId, "whatsapp", merged);
  return c.json({ ok: true });
});

// ── E-ticket delivery settings ────────────────────────────────────────────────

const eticketSchema = z.object({
  autoSendOnConfirm:  z.boolean().default(true),
  channels:           z.array(z.enum(["WHATSAPP", "EMAIL"])).default(["WHATSAPP", "EMAIL"]),
  emailFrom:          z.string().optional(),
  emailFromName:      z.string().optional(),
  includeItinerary:   z.boolean().default(true),
  includeBaggage:     z.boolean().default(true),
  includeCheckinLink: z.boolean().default(false),
});

settingsAdminRoutes.get("/eticket", async (c) => {
  const tenantId = c.get("tenantId");
  const saved    = await getSettings(c.env, tenantId, "eticket");
  return c.json(saved ?? {
    autoSendOnConfirm:  true,
    channels:           ["WHATSAPP", "EMAIL"],
    emailFrom:          "tickets@flypoomas.com",
    emailFromName:      "POOMAS Flights",
    includeItinerary:   true,
    includeBaggage:     true,
    includeCheckinLink: false,
  });
});

settingsAdminRoutes.put("/eticket", zValidator("json", eticketSchema), async (c) => {
  const tenantId = c.get("tenantId");
  await saveSettings(c.env, tenantId, "eticket", c.req.valid("json"));
  return c.json({ ok: true });
});

// ── Exchange rates (automatic exchange-rate tool) ─────────────────────────────

async function fxOverview(c: any) {
  const tenantId = c.get("tenantId");
  const [settings, auto, fx] = await Promise.all([getFxSettings(c.env, tenantId), readAutoRates(c.env), getFx(c.env, tenantId)]);
  return { settings, auto, effective: fx.rates, sources: fx.sources, currencies: FOREIGN_CURRENCIES };
}

settingsAdminRoutes.get("/fx", async (c) => c.json(await fxOverview(c)));

const fxSchema = z.object({
  mode:      z.enum(["auto", "manual"]),
  marginPct: z.number().min(0).max(10),
  manual:    z.record(z.string(), z.number().positive().max(1000).nullable()).default({}),
});

settingsAdminRoutes.put("/fx", zValidator("json", fxSchema), async (c) => {
  const body = c.req.valid("json");
  const manual: FxSettings["manual"] = {};
  for (const cur of FOREIGN_CURRENCIES) {
    const v = body.manual[cur];
    if (v) manual[cur] = v;
  }
  await saveFxSettings(c.env, c.get("tenantId"), { mode: body.mode, marginPct: body.marginPct, manual });
  return c.json({ ok: true, ...(await fxOverview(c)) });
});

// force: accept a move of more than 10% since the last rates (after checking it is real).
settingsAdminRoutes.post("/fx/refresh", async (c) => {
  const force = c.req.query("force") === "1";
  const r = await refreshAutoRates(c.env, fetch, Date.now(), force);
  return c.json({ ...r, ...(await fxOverview(c)) }, r.ok ? 200 : 502);
});

// ── Email (Resend) ────────────────────────────────────────────────────────────

const maskKey = (k: string) => (k ? `${k.slice(0, 5)}${"•".repeat(Math.max(0, Math.min(16, k.length - 9)))}${k.slice(-4)}` : "");

settingsAdminRoutes.get("/email", async (c) => {
  const tenantId = c.get("tenantId");
  const s = await getEmailSettings(c.env, tenantId);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [stats] = await c.get("db").select({
    sent: sql<number>`count(*) filter (where ${emailLogs.status} = 'SENT')::int`,
    failed: sql<number>`count(*) filter (where ${emailLogs.status} = 'FAILED')::int`,
    skipped: sql<number>`count(*) filter (where ${emailLogs.status} = 'SKIPPED')::int`,
  }).from(emailLogs).where(and(eq(emailLogs.tenantId, tenantId), gte(emailLogs.createdAt, since))).catch(() => [{ sent: 0, failed: 0, skipped: 0 }]);
  return c.json({
    settings: { ...s, apiKey: "" },
    apiKeyMasked: maskKey(s.apiKey),
    keySource: s.apiKey ? "admin" : c.env.RESEND_API_KEY ? "secret" : "none",
    defaultFrom: c.env.EMAIL_FROM || "bookings@flypoomas.com",
    last7Days: stats ?? { sent: 0, failed: 0, skipped: 0 },
  });
});

settingsAdminRoutes.put("/email", zValidator("json", z.object({
  enabled: z.boolean(),
  apiKey: z.string().trim().max(200).optional(),         // empty = keep; "-" = remove
  fromName: z.string().trim().min(1).max(60),
  fromEmail: z.union([z.literal(""), z.string().trim().email()]),
  replyTo: z.union([z.literal(""), z.string().trim().email()]),
  bccOps: z.union([z.literal(""), z.string().trim().email()]),
}), (r, c) => { if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the email settings" }, 400); }), async (c) => {
  const tenantId = c.get("tenantId");
  const b = c.req.valid("json");
  const existing = await getEmailSettings(c.env, tenantId);
  if (b.apiKey && b.apiKey !== "-" && !/^re_[A-Za-z0-9_]{10,}$/.test(b.apiKey)) return c.json({ error: "That doesn't look like a Resend API key (it starts with re_)." }, 400);
  const apiKey = b.apiKey === "-" ? "" : b.apiKey || existing.apiKey;
  await saveEmailSettings(c.env, tenantId, { ...DEFAULT_EMAIL_SETTINGS, ...b, apiKey });
  return c.json({ ok: true });
});

settingsAdminRoutes.post("/email/test", zValidator("json", z.object({ to: z.string().trim().email() })), async (c) => {
  const tenantId = c.get("tenantId");
  const s = await getEmailSettings(c.env, tenantId);
  if (!resendKey(c.env, s)) return c.json({ ok: false, error: "No Resend API key: add it here or set the RESEND_API_KEY secret on the API worker." }, 400);
  const r = await sendMail(c.env, c.get("db"), tenantId, {
    to: c.req.valid("json").to, category: "test", subject: "FlyPoomas test email",
    html: emailLayout({
      title: "Email is working ✅",
      body: "<p>This test was sent from Admin → Settings → Email through Resend. Booking confirmations, password resets and other notifications use the same sender.</p>",
      rows: [["Sent at", new Date().toUTCString()]],
      cta: { label: "Open FlyPoomas", href: "https://flypoomas.com" },
    }),
  });
  return c.json(r, r.ok ? 200 : 502);
});

settingsAdminRoutes.get("/email/logs", async (c) => {
  const status = c.req.query("status");
  const rows = await c.get("db").select().from(emailLogs)
    .where(and(eq(emailLogs.tenantId, c.get("tenantId")), status ? eq(emailLogs.status, status) : undefined))
    .orderBy(desc(emailLogs.createdAt)).limit(100);
  return c.json({ logs: rows });
});
