// Fare tools for the customer site (public, no login):
//
//   GET  /api/fares/calendar?origin=COK&destination=DXB&month=2026-10&currency=INR
//        cheapest fare per adult seen per day (from recent searches)
//   POST /api/fares/alerts       { origin, destination, date, currency, targetPrice, email?, phone? }
//   GET  /api/fares/alerts/:id/stop   one-click unsubscribe (link in the alert message)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env, Variables } from "../types.js";
import { createAlert, deleteAlert, getAlert, readCalendar } from "../lib/fare-insights.js";
import { escapeHtml, money, WEB_URL } from "../lib/customer-notify.js";

export const fareRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const iata = z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());
const currency = z.enum(["INR", "AED", "USD"]).default("INR");

fareRoutes.get("/calendar", zValidator("query", z.object({
  origin: iata, destination: iata,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  currency,
})), async (c) => {
  const q = c.req.valid("query");
  const days = await readCalendar(c.env.FARE_CACHE_KV, c.get("tenantId"), q.origin, q.destination, q.month, q.currency);
  const today = new Date().toISOString().slice(0, 10);
  return c.json({ ...q, days: days.filter((d) => d.date >= today) }, 200, { "Cache-Control": "public, max-age=120" });
});

const alertSchema = z.object({
  origin: iata, destination: iata,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency,
  targetPrice: z.number().positive().max(10_000_000),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{8,20}$/, "Enter a WhatsApp number with country code").optional(),
}).superRefine((a, ctx) => {
  if (!a.email && !a.phone) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "Add an email or a WhatsApp number" });
  if (a.origin === a.destination) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destination"], message: "Choose two different airports" });
  const d = new Date(`${a.date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== a.date) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "Invalid date" });
  else if (a.date < new Date().toISOString().slice(0, 10)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "That date has passed" });
  else if (d.getTime() - Date.now() > 330 * 86_400_000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "Alerts are available up to 11 months ahead" });
});

fareRoutes.post("/alerts", zValidator("json", alertSchema, (result, c) => {
  if (!result.success) return c.json({ error: result.error.issues[0]?.message ?? "Check the alert details" }, 400);
}), async (c) => {
  const a = c.req.valid("json");
  const tenantId = c.get("tenantId");
  // 10 alerts per visitor per hour.
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
  const rlKey = `falert_rl:${tenantId}:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const used = Number(await c.env.FARE_CACHE_KV.get(rlKey).catch(() => null) ?? 0);
  if (used >= 10) return c.json({ error: "Too many alerts — please try again later." }, 429);
  c.executionCtx.waitUntil(c.env.FARE_CACHE_KV.put(rlKey, String(used + 1), { expirationTtl: 3700 }).catch(() => {}));

  const phone = a.phone ? (a.phone.replace(/[^\d+]/g, "").startsWith("+") ? a.phone.replace(/[^\d+]/g, "") : `+${a.phone.replace(/\D/g, "").length === 10 ? "91" : ""}${a.phone.replace(/\D/g, "")}`) : null;
  const alert = await createAlert(c.env.FARE_CACHE_KV, {
    tenantId, origin: a.origin, destination: a.destination, date: a.date, currency: a.currency,
    targetPrice: Math.round(a.targetPrice), email: a.email ?? null, phone,
  });
  if (alert === "ROUTE_FULL") return c.json({ error: "Too many alerts on this flight already — please try another date." }, 409);
  return c.json({
    alert: { id: alert.id, origin: alert.origin, destination: alert.destination, date: alert.date, currency: alert.currency, targetPrice: alert.targetPrice },
    message: `We'll message you when ${alert.origin} → ${alert.destination} on ${alert.date} drops to ${money(alert.targetPrice, alert.currency)} or less per adult.`,
  }, 201);
});

fareRoutes.get("/alerts/:id/stop", async (c) => {
  const alert = await getAlert(c.env.FARE_CACHE_KV, c.get("tenantId"), c.req.param("id"));
  if (alert) await deleteAlert(c.env.FARE_CACHE_KV, alert);
  const text = alert
    ? `Your price alert for ${alert.origin} → ${alert.destination} on ${alert.date} is stopped.`
    : "This price alert has already ended.";
  return c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Price alert stopped</title>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#0f172a">
<h2 style="color:#E31E24">Price alert stopped</h2><p>${escapeHtml(text)}</p>
<p><a href="${WEB_URL}" style="color:#E31E24;font-weight:bold">Search flights on FlyPoomas →</a></p></body>`);
});
