// Admin → Flight Sources: Akbar Travels and Poomas API settings (full admins),
// and the manual fares price table + Google Sheet sync (also staff with the
// "manual_fares" section). See lib/flight-sources.ts.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { manualFares } from "@zamrabooking/db/schema";
import { PoomasAdapter } from "@zamrabooking/suppliers";
import type { Env, Variables } from "../../types.js";
import {
  getAkbarSettings, getManualSettings, getPoomasSettings, saveAkbarSettings, saveManualSettings, savePoomasSettings,
  SHEET_COLUMNS, sheetCsvUrl, syncManualFaresSheet, validateManualFare,
} from "../../lib/flight-sources.js";

export const flightSourcesAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const mask = (v: string) => (!v ? "" : v.length > 8 ? `${v.slice(0, 4)}${"•".repeat(Math.min(v.length - 8, 12))}${v.slice(-4)}` : "•".repeat(v.length));

const fullAdminOnly = (role: string | undefined) => {
  if (role !== "SUPER_ADMIN" && role !== "TENANT_ADMIN") throw new HTTPException(403, { message: "Only admins can change supplier settings." });
};

flightSourcesAdminRoutes.get("/", async (c) => {
  const tenantId = c.get("tenantId");
  const [akbar, poomas, manual] = await Promise.all([
    getAkbarSettings(c.env, tenantId), getPoomasSettings(c.env, tenantId), getManualSettings(c.env, tenantId),
  ]);
  return c.json({
    akbar: { ...akbar, enabled: false, password: mask(akbar.password), apiKey: mask(akbar.apiKey), connected: false, searchStatus: "DISABLED", bookingEnabled: false, ticketingEnabled: false, paymentEnabled: false, health: "NOT_VERIFIED", mode: "MOCK_ONLY" },
    poomas: { ...poomas, apiKey: mask(poomas.apiKey) },
    manual,
    sheetColumns: SHEET_COLUMNS,
  });
});

// Secrets left blank (or still masked) keep their saved value.
const keep = (next: string | undefined, saved: string) => (next && !next.includes("•") ? next.trim() : saved);

flightSourcesAdminRoutes.put("/akbar", zValidator("json", z.object({
  enabled:     z.literal(false),
  priority:    z.number().int().min(1).max(1000).optional(),
  environment: z.enum(["UAT", "PRODUCTION"]),
  baseUrl:     z.string().trim().url().or(z.literal("")),
  username:    z.string().trim().max(200),
  password:    z.string().max(500).optional(),
  agencyCode:  z.string().trim().max(100),
  apiKey:      z.string().max(500).optional(),
})), async (c) => {
  fullAdminOnly(c.get("userRole"));
  const body = c.req.valid("json");
  const saved = await getAkbarSettings(c.env, c.get("tenantId"));
  await saveAkbarSettings(c.env, c.get("tenantId"), {
    ...body, password: keep(body.password, saved.password), apiKey: keep(body.apiKey, saved.apiKey),
  });
  return c.json({ ok: true });
});

flightSourcesAdminRoutes.put("/poomas", zValidator("json", z.object({
  enabled: z.boolean(),
  apiKey:  z.string().max(500).optional(),
  baseUrl: z.string().trim().url(),
})), async (c) => {
  fullAdminOnly(c.get("userRole"));
  const body = c.req.valid("json");
  const saved = await getPoomasSettings(c.env, c.get("tenantId"));
  const apiKey = keep(body.apiKey, saved.apiKey);
  if (body.enabled && !apiKey) return c.json({ error: "Add the Poomas API key before turning Poomas on." }, 400);
  await savePoomasSettings(c.env, c.get("tenantId"), { enabled: body.enabled, apiKey, baseUrl: body.baseUrl.replace(/\/+$/, "") });
  return c.json({ ok: true });
});

// Runs one live Poomas search with the saved key, to check the connection.
flightSourcesAdminRoutes.post("/poomas/test", zValidator("json", z.object({
  origin:        z.string().length(3).toUpperCase(),
  destination:   z.string().length(3).toUpperCase(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})), async (c) => {
  fullAdminOnly(c.get("userRole"));
  const p = c.req.valid("json");
  const s = await getPoomasSettings(c.env, c.get("tenantId"));
  if (!s.apiKey) return c.json({ ok: false, error: "Save the Poomas API key first." }, 400);
  const started = Date.now();
  try {
    const fares = await new PoomasAdapter({ apiKey: s.apiKey, baseUrl: s.baseUrl }).search({
      ...p, adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR",
    });
    const cheapest = fares.reduce<number | null>((min, f) => (min === null || f.totalFare < min ? f.totalFare : min), null);
    return c.json({ ok: true, fares: fares.length, cheapest, durationMs: Date.now() - started });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started });
  }
});

flightSourcesAdminRoutes.put("/manual", zValidator("json", z.object({
  enabled:  z.boolean(),
  sheetUrl: z.string().trim().max(1000),
  autoSync: z.boolean(),
})), async (c) => {
  fullAdminOnly(c.get("userRole"));
  const body = c.req.valid("json");
  if (body.sheetUrl && !sheetCsvUrl(body.sheetUrl)) return c.json({ error: "The sheet link must be an https:// Google Sheets link." }, 400);
  const saved = await getManualSettings(c.env, c.get("tenantId"));
  await saveManualSettings(c.env, c.get("tenantId"), { ...saved, ...body });
  return c.json({ ok: true });
});

flightSourcesAdminRoutes.post("/manual/sync", async (c) => {
  const result = await syncManualFaresSheet(c.env, c.get("db"), c.get("tenantId"));
  return c.json(result, result.ok ? 200 : 422);
});

// ── Manual fares table ───────────────────────────────────────────────────────

flightSourcesAdminRoutes.get("/manual/fares", async (c) => {
  const q = (k: string) => c.req.query(k)?.trim() || undefined;
  const from = q("from") ?? new Date().toISOString().slice(0, 10);
  const conditions = [eq(manualFares.tenantId, c.get("tenantId")), gte(manualFares.travelDate, from)];
  const to = q("to");
  if (to) conditions.push(lte(manualFares.travelDate, to));
  if (q("origin")) conditions.push(eq(manualFares.origin, q("origin")!.toUpperCase()));
  if (q("destination")) conditions.push(eq(manualFares.destination, q("destination")!.toUpperCase()));
  if (q("source") === "ADMIN" || q("source") === "SHEET") conditions.push(eq(manualFares.source, q("source")!));
  const rows = await c.get("db").select().from(manualFares).where(and(...conditions))
    .orderBy(asc(manualFares.travelDate), asc(manualFares.origin), asc(manualFares.destination), asc(manualFares.departureTime))
    .limit(500);
  return c.json({ fares: rows });
});

// The Admin form sends the same fields as the sheet columns.
const fareBody = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const fieldReader = (body: z.infer<typeof fareBody>) => (col: string) => {
  const v = body[col];
  return v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
};

flightSourcesAdminRoutes.post("/manual/fares", zValidator("json", fareBody), async (c) => {
  const fare = validateManualFare(fieldReader(c.req.valid("json")));
  if (typeof fare === "string") return c.json({ error: fare }, 400);
  const [row] = await c.get("db").insert(manualFares).values({ ...fare, tenantId: c.get("tenantId") }).returning();
  return c.json({ fare: row }, 201);
});

flightSourcesAdminRoutes.put("/manual/fares/:id", zValidator("json", fareBody), async (c) => {
  const fare = validateManualFare(fieldReader(c.req.valid("json")));
  if (typeof fare === "string") return c.json({ error: fare }, 400);
  const { source: _source, ...changes } = fare;
  const [row] = await c.get("db").update(manualFares).set({ ...changes, updatedAt: new Date() })
    .where(and(eq(manualFares.id, c.req.param("id")), eq(manualFares.tenantId, c.get("tenantId")))).returning();
  if (!row) return c.json({ error: "Fare not found" }, 404);
  return c.json({ fare: row });
});

flightSourcesAdminRoutes.delete("/manual/fares/:id", async (c) => {
  const [row] = await c.get("db").delete(manualFares)
    .where(and(eq(manualFares.id, c.req.param("id")), eq(manualFares.tenantId, c.get("tenantId")))).returning({ id: manualFares.id });
  if (!row) return c.json({ error: "Fare not found" }, 404);
  return c.json({ ok: true });
});
