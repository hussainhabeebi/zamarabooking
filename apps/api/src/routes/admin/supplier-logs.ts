import { Hono } from "hono";
import { supplierApiLogs, supplierExchanges } from "@poomas/db/schema";
import { eq, and, desc, gte, inArray, like, lte, or, asc } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { buildZip } from "../../lib/zip.js";
import { certificationRequest, tripjackHost } from "../../lib/certification.js";
import { tripjackEnvironment } from "../../lib/hotels.js";
import type { Env, Variables } from "../../types.js";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

export const supplierLogsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

supplierLogsAdminRoutes.get("/", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const role     = c.get("userRole");

  const level    = c.req.query("level");
  const supplier = c.req.query("supplier");
  const endpoint = c.req.query("endpoint");
  const from     = c.req.query("from");
  const to       = c.req.query("to");
  const filterTenantId = c.req.query("tenantId");  // SUPER_ADMIN can filter by any tenant
  const limit    = Math.min(parseInt(c.req.query("limit") ?? "100"), 500);
  const offset   = parseInt(c.req.query("offset") ?? "0");

  // SUPER_ADMIN sees all tenants unless a specific tenantId filter is passed.
  // TENANT_ADMIN is always restricted to their own tenant.
  const conditions: ReturnType<typeof eq>[] = [];
  if (role !== "SUPER_ADMIN") {
    conditions.push(eq(supplierApiLogs.tenantId, tenantId));
  } else if (filterTenantId) {
    conditions.push(eq(supplierApiLogs.tenantId, filterTenantId));
  }

  if (level)    conditions.push(eq(supplierApiLogs.level, level));
  if (supplier) conditions.push(eq(supplierApiLogs.supplier, supplier as "TRIPJACK"));
  if (endpoint) conditions.push(eq(supplierApiLogs.endpoint, endpoint));
  // scope=hotel: every hotel call (TripJack hotel endpoints and rejected hotel requests).
  if (c.req.query("scope") === "hotel") {
    conditions.push(or(like(supplierApiLogs.endpoint, "/hms/%"), like(supplierApiLogs.endpoint, "%/hotel%"), like(supplierApiLogs.endpoint, "hotel %"))!);
  }
  if (from)     conditions.push(gte(supplierApiLogs.createdAt, new Date(from)));
  if (to)       conditions.push(lte(supplierApiLogs.createdAt, new Date(to)));

  try {
    const rows = await db
      .select()
      .from(supplierApiLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(supplierApiLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ logs: rows, limit, offset });
  } catch (err) {
    console.error("[admin-supplier-logs] query failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Failed to query supplier logs", details: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /api/admin/supplier-logs/export — download TripJack API logs as JSON (UAT submission)
supplierLogsAdminRoutes.get("/export", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const role     = c.get("userRole");
  const supplier = (c.req.query("supplier") ?? "TRIPJACK") as "TRIPJACK" | "RIYA";
  const from     = c.req.query("from");
  const to       = c.req.query("to");
  const filterTenantId = c.req.query("tenantId");

  const conditions: ReturnType<typeof eq>[] = [
    eq(supplierApiLogs.supplier, supplier),
  ];
  if (role !== "SUPER_ADMIN") {
    conditions.push(eq(supplierApiLogs.tenantId, tenantId));
  } else if (filterTenantId) {
    conditions.push(eq(supplierApiLogs.tenantId, filterTenantId));
  }
  if (from) conditions.push(gte(supplierApiLogs.createdAt, new Date(from)));
  if (to)   conditions.push(lte(supplierApiLogs.createdAt, new Date(to)));

  const rows = await db
    .select()
    .from(supplierApiLogs)
    .where(and(...conditions))
    .orderBy(desc(supplierApiLogs.createdAt))
    .limit(500);

  const filename = `${supplier.toLowerCase()}-logs-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), supplier, count: rows.length, logs: rows }, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});


// ── Raw request / response files (supplier_exchanges + R2) ──────────────────
// scope: hotel | flight | tripsafe. Requests are shown as TripJack received them
// (TripJack URL, apikey; never our gateway secret); responses exactly as received.

const HOTEL_SCOPE = () => or(like(supplierExchanges.endpoint, "/hms/%"), like(supplierExchanges.endpoint, "/oms/v3/hotel/%"), like(supplierExchanges.endpoint, "/oms/v1/hotel/%"))!;
const scopeFilter = (scope?: string) => scope === "hotel" ? HOTEL_SCOPE()
  : scope === "tripsafe" ? like(supplierExchanges.endpoint, "/insurance/%")
  : scope === "flight" ? or(like(supplierExchanges.endpoint, "/fms/%"), like(supplierExchanges.endpoint, "/oms/v1/air%"), like(supplierExchanges.endpoint, "/oms/v1/booking-details"), like(supplierExchanges.endpoint, "/air-%"), like(supplierExchanges.endpoint, "/v1/air/%"))!
  : undefined;

// TripJack host each call actually went to (the gateway forwards by path).
function hostFor(endpoint: string, env: "UAT" | "PRODUCTION") {
  if (endpoint.startsWith("/hms/")) return env === "PRODUCTION" ? "https://hms-search.tripjack.com" : "https://apitest-hms.tripjack.com";
  if (endpoint.startsWith("/oms/v3/hotel/") || endpoint.startsWith("/oms/v1/hotel/")) return env === "PRODUCTION" ? "https://hms-booker.tripjack.com" : "https://apitest-hotel-booker.tripjack.com";
  return tripjackHost(env);
}

// "/hms/v3/hotel/listing" → "HotelListing"
const serviceName = (endpoint: string) => endpoint.replace(/^\/(hms|oms|fms)\/v\d+\//, "").split(/[^a-zA-Z0-9]+/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("") || "Call";

supplierLogsAdminRoutes.get("/exchanges", async (c) => {
  const db = c.get("db");
  const scope = c.req.query("scope");
  const onlyErrors = c.req.query("errors") === "1";
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100") || 100, 300);
  const conditions = [eq(supplierExchanges.tenantId, c.get("tenantId"))];
  const sf = scopeFilter(scope);
  if (sf) conditions.push(sf as any);
  const rows = await db.select({
    id: supplierExchanges.id, endpoint: supplierExchanges.endpoint, httpStatus: supplierExchanges.httpStatus,
    durationMs: supplierExchanges.durationMs, error: supplierExchanges.error, bookingId: supplierExchanges.bookingId,
    searchId: supplierExchanges.searchId, requestId: supplierExchanges.requestId, startedAt: supplierExchanges.startedAt,
    responseKey: supplierExchanges.responseKey,
  }).from(supplierExchanges).where(and(...conditions)).orderBy(desc(supplierExchanges.startedAt)).limit(onlyErrors ? 500 : limit);
  const list = rows
    .filter((x) => !onlyErrors || x.error || !x.httpStatus || x.httpStatus >= 400)
    .slice(0, limit)
    .map(({ responseKey, ...x }) => ({ ...x, service: serviceName(x.endpoint), hasResponse: Boolean(responseKey) }));
  return c.json({ exchanges: list });
});

async function exchangeFile(c: any, id: string, part: "request" | "response") {
  const [x] = await c.get("db").select().from(supplierExchanges)
    .where(and(eq(supplierExchanges.id, id), eq(supplierExchanges.tenantId, c.get("tenantId")))).limit(1);
  const key = part === "request" ? x?.requestKey : x?.responseKey;
  if (!x || !key) return null;
  const obj = await c.env.DOCUMENTS_R2.get(key);
  if (!obj) return null;
  const name = `${serviceName(x.endpoint)}${part === "request" ? "Request" : "Response"}.${key.endsWith(".txt") ? "txt" : "json"}`;
  if (part === "request") {
    let stored: Record<string, any> = {};
    try { stored = JSON.parse(await obj.text()); } catch { /* keep empty */ }
    const env = await tripjackEnvironment(c.env, c.get("tenantId"));
    const req = certificationRequest(stored, hostFor(x.endpoint, env));
    // Keep any query string (e.g. city sync cursor); a GET has no body.
    const query = (() => { try { return new URL(String(stored.url)).search; } catch { return ""; } })();
    const body = stored.method === "GET"
      ? { url: `${req.url}${query}`, method: "GET", headers: { ...(req.headers.apikey ? { apikey: req.headers.apikey } : {}) } }
      : req;
    return { name, data: new TextEncoder().encode(JSON.stringify(body, null, 2)), date: x.startedAt as Date };
  }
  return { name, data: new Uint8Array(await obj.arrayBuffer()), date: x.startedAt as Date };
}

supplierLogsAdminRoutes.get("/exchanges.zip", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
  if (!ids.length) throw new HTTPException(400, { message: "Pass ?ids=" });
  const files: { name: string; data: Uint8Array; date: Date }[] = [];
  const used = new Map<string, number>();
  const rows = await c.get("db").select({ id: supplierExchanges.id }).from(supplierExchanges)
    .where(and(eq(supplierExchanges.tenantId, c.get("tenantId")), inArray(supplierExchanges.id, ids))).orderBy(asc(supplierExchanges.startedAt));
  for (const { id } of rows) {
    for (const part of ["request", "response"] as const) {
      const f = await exchangeFile(c, id, part);
      if (!f) continue;
      // Repeated services get _2, _3 … (e.g. several listing batches).
      const n = (used.get(f.name) ?? 0) + 1;
      used.set(f.name, n);
      files.push({ ...f, name: n > 1 ? f.name.replace(/(\.\w+)$/, `_${n}$1`) : f.name });
    }
  }
  if (!files.length) throw new HTTPException(404, { message: "No log files found" });
  return new Response(buildZip(files), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${c.req.query("name")?.replace(/[^A-Za-z0-9-]+/g, "") || "api-logs"}.zip"`,
    "Cache-Control": "private, no-store",
  } });
});

supplierLogsAdminRoutes.get("/exchanges/:id/:part", async (c) => {
  const part = c.req.param("part");
  if (part !== "request" && part !== "response") throw new HTTPException(400, { message: "part must be request or response" });
  const f = await exchangeFile(c, c.req.param("id"), part);
  if (!f) throw new HTTPException(404, { message: "Log file not found" });
  return new Response(f.data, { headers: {
    "Content-Type": f.name.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/json",
    "Content-Disposition": `attachment; filename="${f.name}"`, "Cache-Control": "private, no-store",
  } });
});
