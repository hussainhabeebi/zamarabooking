import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { searchFares, type SupplierConfig, type PlatformCredentials, type SupplierDiagnostic } from "@poomas/suppliers";
import type { Env, Variables } from "../types.js";
import { logSupplierCall } from "../lib/supplier-logger.js";
import { DISPLAY_CURRENCIES, getFx, type ForeignCurrency } from "../lib/fx.js";
import { agentNumberFrom, resolveAgentNumber, trackAgentActivity, type ResolvedAgent } from "../lib/agent-number.js";
import { collectExchanges, persistExchanges, persistInBackground } from "../lib/api-exchanges.js";
import { recordFareObservation, sendFareAlerts } from "../lib/fare-insights.js";
import { optionalAgentId } from "../lib/agent-markup.js";
import { agentPricing, rulesFor } from "../lib/agent-program.js";

const searchSchema = z.object({
  origin:        z.string().length(3).toUpperCase(),
  destination:   z.string().length(3).toUpperCase(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  adults:        z.number().int().min(1).max(9).default(1),
  children:      z.number().int().min(0).max(9).default(0),
  infants:       z.number().int().min(0).max(4).default(0),
  cabinClass:    z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]).default("ECONOMY"),
  tripType:      z.enum(["ONEWAY", "ROUNDTRIP", "MULTICITY"]).default("ONEWAY"),
  currency:      z.enum(DISPLAY_CURRENCIES).optional(),
  // Leadvyne Live Agency: the agency's FlyPoomas agent number (or header X-FP-Agent).
  agentNumber:   z.string().max(20).optional(),
  // Multi-city legs (2–6); round trips can use returnDate instead.
  legs: z.array(z.object({
    origin:        z.string().length(3).toUpperCase(),
    destination:   z.string().length(3).toUpperCase(),
    departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })).min(2).max(6).optional(),
  // TripJack passenger fare type (Student / Senior Citizen fares).
  fareType:      z.enum(["REGULAR", "STUDENT", "SENIOR_CITIZEN"]).default("REGULAR"),
}).superRefine((p, ctx) => {
  if (p.tripType === "ROUNDTRIP" && !p.returnDate && !p.legs) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["returnDate"], message: "returnDate is required for a round trip" });
  if (p.tripType === "MULTICITY" && !p.legs) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs"], message: "legs are required for multi-city" });
  if (p.infants > p.adults) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["infants"], message: "Infants cannot exceed adults" });
  // 9 seats max; lap infants don't take a seat (limited to one per adult above).
  if (p.adults + p.children > 9) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["adults"], message: "Adults and children cannot exceed 9" });
});

const SERP_TRIAL_TTL = 60 * 60 * 24;

interface TripjackAdminConfig {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

async function tripjackAdminConfig(env: Env, tenantId: string): Promise<TripjackAdminConfig | null> {
  try {
    return await env.TENANT_CACHE_KV.get(
      `admin_settings:${tenantId}:integration:tripjack`,
      "json",
    ) as TripjackAdminConfig | null;
  } catch (err) {
    console.error("[search] TripJack admin configuration unavailable; using existing credentials", err);
    return null;
  }
}

function platformCredentialsFromEnv(env: Env): PlatformCredentials {
  return {
    // RIYA, DUFFEL and GOOGLE_SERP are temporarily disabled — credentials intentionally excluded
    ...((env.TRIPJACK_API_KEY || env.TRIPJACK_PROXY_KEY) && env.TRIPJACK_API_BASE_URL
      ? { TRIPJACK: { apiKey: env.TRIPJACK_API_KEY, baseUrl: env.TRIPJACK_API_BASE_URL, proxyKey: env.TRIPJACK_PROXY_KEY } }
      : {}),
  };
}

const TRIPJACK_SEARCH_TIMEOUT_MS = 28_000;

const TEMPORARILY_DISABLED_SUPPLIERS = new Set<string>(["RIYA", "DUFFEL", "GOOGLE_SERP"]);

function supplierConfigsForTenant(tenant: Variables["tenant"], platformCredentials: PlatformCredentials): SupplierConfig[] {
  const supplierConfigs: SupplierConfig[] = tenant.supplierConfigs
    .filter((sc) => !TEMPORARILY_DISABLED_SUPPLIERS.has(sc.supplier))
    .map((sc) => ({
      name:        sc.supplier as "RIYA" | "TRIPJACK" | "GOOGLE_SERP" | "DUFFEL",
      isEnabled:   sc.isEnabled,
      priority:    sc.priority,
      credentials: sc.credentials,
      timeoutMs:   sc.timeoutMs,
      maxRetries:  sc.maxRetries,
    }));

  const configuredNames = new Set(supplierConfigs.map((s) => s.name));
  const defaults: Array<{ name: SupplierConfig["name"]; priority: number; timeoutMs: number }> = [
    { name: "TRIPJACK", priority: 20, timeoutMs: 15000 },
    // RIYA, DUFFEL and GOOGLE_SERP temporarily disabled
  ];

  for (const def of defaults) {
    if (!configuredNames.has(def.name) && platformCredentials[def.name]) {
      supplierConfigs.push({
        name: def.name,
        isEnabled: true,
        priority: def.priority,
        credentials: null,
        timeoutMs: def.timeoutMs,
        maxRetries: 0,
      });
    }
  }

  // Suppress connection errors for suppliers enabled in the DB but with no credentials
  // available — neither a platform secret nor tenant-DB credentials. Prevents noise from
  // suppliers that are enabled in the tenant row but not actually deployed.
  for (const config of supplierConfigs) {
    if (config.isEnabled && !platformCredentials[config.name] && !config.credentials) {
      config.isEnabled = false;
    }
  }

  return supplierConfigs;
}

export async function resolveFlightSuppliers(env: Env, tenant: Variables["tenant"], tenantId: string) {
  const platformCredentials = platformCredentialsFromEnv(env);
  const savedTripjack = await tripjackAdminConfig(env, tenantId);
  const tripjackApiKey = savedTripjack?.apiKey || env.TRIPJACK_API_KEY;
  const tripjackBaseUrl = env.TRIPJACK_API_BASE_URL || savedTripjack?.baseUrl;
  if ((tripjackApiKey || env.TRIPJACK_PROXY_KEY) && tripjackBaseUrl) {
    platformCredentials.TRIPJACK = {
      apiKey: tripjackApiKey,
      baseUrl: tripjackBaseUrl,
      omsBaseUrl: env.TRIPJACK_OMS_BASE_URL || undefined,
      proxyKey: env.TRIPJACK_PROXY_KEY,
    };
  }
  const supplierConfigs = supplierConfigsForTenant(tenant, platformCredentials);

  // TripJack is the primary supplier for this deployment. A configured Worker
  // secret activates an existing tenant row unless Admin explicitly saved the
  // flight-search toggle as disabled.
  if (!savedTripjack && platformCredentials.TRIPJACK) {
    const tripjackConfig = supplierConfigs.find((s) => s.name === "TRIPJACK");
    if (tripjackConfig) tripjackConfig.isEnabled = true;
  }

  // The Admin flight-search toggle is authoritative when a TripJack integration
  // has been saved. Its credentials override only TripJack, leaving every other
  // supplier's existing DB/secret resolution unchanged.
  if (savedTripjack) {
    const tripjackConfig = supplierConfigs.find((s) => s.name === "TRIPJACK");
    if (tripjackConfig) {
      tripjackConfig.isEnabled = savedTripjack.enabled === true;
      if ((savedTripjack.apiKey || env.TRIPJACK_PROXY_KEY) && tripjackBaseUrl) {
        tripjackConfig.credentials = {
          ...(tripjackConfig.credentials ?? {}),
          ...(savedTripjack.apiKey ? { apiKey: savedTripjack.apiKey } : {}),
          baseUrl: tripjackBaseUrl,
          proxyKey: env.TRIPJACK_PROXY_KEY,
        };
      }
    } else if (savedTripjack.enabled && (savedTripjack.apiKey || env.TRIPJACK_PROXY_KEY) && tripjackBaseUrl) {
      supplierConfigs.push({
        name: "TRIPJACK",
        isEnabled: true,
        priority: 20,
        credentials: {
          ...(savedTripjack.apiKey ? { apiKey: savedTripjack.apiKey } : {}),
          baseUrl: tripjackBaseUrl,
          proxyKey: env.TRIPJACK_PROXY_KEY,
        },
        timeoutMs: 15000,
        maxRetries: 0,
      });
    }
  }

  // TripJack international searches regularly take 15–25s and the gateway allows
  // 45s, so never cut TripJack off earlier than this, whatever the DB row says.
  for (const config of supplierConfigs) {
    if (config.name === "TRIPJACK") config.timeoutMs = Math.max(config.timeoutMs || 0, TRIPJACK_SEARCH_TIMEOUT_MS);
  }

  return { platformCredentials, supplierConfigs };
}

type LoggableSupplier = "TRIPJACK" | "RIYA" | "DUFFEL" | "GOOGLE_SERP";

// Writes failed / empty flight searches to supplier_api_logs so they show up in
// Admin → Supplier Logs. Successful searches are not logged to keep volume low.
function logSearchOutcome(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  tenantId: string,
  searchId: string,
  params: z.infer<typeof searchSchema> & { currency?: string },
  enabledSuppliers: string[],
  diagnostics: Record<string, SupplierDiagnostic>,
) {
  const db = c.get("db");
  const requestSummary = {
    origin: params.origin, destination: params.destination, departureDate: params.departureDate,
    returnDate: params.returnDate, tripType: params.tripType, cabinClass: params.cabinClass,
    pax: { adults: params.adults, children: params.children, infants: params.infants },
    currency: params.currency, enabledSuppliers,
  };
  const writes: Promise<void>[] = [];

  if (enabledSuppliers.length === 0) {
    writes.push(logSupplierCall(db, {
      tenantId, supplier: "TRIPJACK", endpoint: "flight-search", level: "ERROR", requestId: searchId,
      requestSummary, errorCode: "NO_SUPPLIER_ENABLED",
      errorMessage: "No flight supplier is enabled for this tenant (check Admin → Integrations TripJack toggle and TRIPJACK_API_BASE_URL / API key / proxy key secrets).",
    }));
  }

  for (const [supplier, d] of Object.entries(diagnostics)) {
    if (d.ok && d.fareCount > 0) continue;
    writes.push(logSupplierCall(db, {
      tenantId,
      supplier:        supplier as LoggableSupplier,
      endpoint:        "flight-search",
      level:           d.ok ? "WARN" : "ERROR",
      httpStatus:      d.httpStatus,
      requestId:       searchId,
      requestSummary:  { ...requestSummary, ...(d.endpoint ? { upstreamPath: d.endpoint } : {}) },
      responseSnippet: d.responseSnippet,
      errorCode:       d.ok ? "NO_RESULTS" : d.errorCode,
      errorMessage:    d.ok ? "Supplier responded successfully but returned 0 flights for this route/date." : d.errorMessage,
      durationMs:      d.durationMs,
    }));
  }

  if (writes.length) c.executionCtx.waitUntil(Promise.all(writes));
}

export const searchRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

searchRoutes.post("/", zValidator("json", searchSchema), async (c) => {
  const { agentNumber, ...params } = c.req.valid("json");
  const tenantId = c.get("tenantId");
  const searchId = crypto.randomUUID();
  try {
    const leadAgent = await resolveLeadAgent(c, agentNumber);
    const res = await runSearch(c, params, searchId);
    return leadAgent ? await withAgentCurrency(c, res, leadAgent) : res;
  } catch (err) {
    // Unexpected crash (config/KV/DB/code bug) — surface it in Admin logs, not just Worker logs.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[search] ${searchId} failed:`, err);
    c.executionCtx.waitUntil(logSupplierCall(c.get("db"), {
      tenantId, supplier: "TRIPJACK", endpoint: "flight-search", level: "ERROR", requestId: searchId,
      requestSummary: { origin: params.origin, destination: params.destination, departureDate: params.departureDate },
      errorCode: "SEARCH_CRASHED", errorMessage: message,
      responseSnippet: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
    }));
    return c.json({ error: "Flight search failed", searchId }, 500);
  }
});

// Leadvyne Live Agency traffic: count the search for the agency and add prices in its currency.
async function resolveLeadAgent(c: Context<{ Bindings: Env; Variables: Variables }>, bodyNumber?: string) {
  const n = agentNumberFrom(c, { agentNumber: bodyNumber });
  if (!n) return null;
  try {
    const agent = await resolveAgentNumber(c.env, c.get("db"), c.get("tenantId"), n);
    if (agent && agent.status === "APPROVED") {
      c.executionCtx.waitUntil(trackAgentActivity(c.get("db"), c.get("tenantId"), agent.id, "searches").catch((err) => console.error("[agent-activity]", err)));
    }
    return agent;
  } catch (err) {
    console.error("[search] agent number lookup failed", err);   // never blocks the search
    return null;
  }
}

export async function withAgentCurrency(c: Context<{ Bindings: Env; Variables: Variables }>, res: Response, agent: ResolvedAgent) {
  if (!res.ok) return res;
  const data = await res.json() as { fares?: { totalFare?: number; displayPrice?: number; currency?: string }[] };
  const fx = await getFx(c.env, c.get("tenantId"), c.executionCtx);
  const cur = agent.currency;
  const rate = cur === "INR" ? 1 : fx.rates[cur as ForeignCurrency] ?? null;
  const decimals = ["OMR", "KWD", "BHD"].includes(cur) ? 3 : 2;
  const conv = (inr: number) => rate ? Math.ceil((inr / rate) * 10 ** decimals - 1e-9) / 10 ** decimals : null;
  return c.json({
    ...data,
    agent: { number: agent.number, businessName: agent.businessName, currency: cur, status: agent.status },
    agentCurrency: { code: cur, inrPerUnit: rate, available: Boolean(rate) },
    fares: (data.fares ?? []).map((f) => {
      const inr = Number(f.displayPrice ?? f.totalFare ?? 0);
      const amount = (f.currency ?? "INR") === "INR" ? conv(inr) : null;
      return amount === null ? f : { ...f, agentPrice: { amount, currency: cur } };
    }),
  }, res.status as 200);
}

async function runSearch(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  params: z.infer<typeof searchSchema>,
  searchId: string,
) {
  const tenant = c.get("tenant");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(c.env, tenant, tenantId);
  const sessionId = c.get("userId") ?? c.req.header("X-Session-ID") ?? null;
  let currency = params.currency as string | undefined;

  // Session preferences are optional. KV trouble must never block live supplier search.
  if (!currency && sessionId) {
    try {
      const prefs = await c.env.SESSIONS_KV.get(`session_prefs:${tenantId}:${sessionId}`, "json") as { currency?: string } | null;
      currency = prefs?.currency;
    } catch (err) {
      console.error("[search] session preference KV unavailable", err);
    }
  }
  currency = currency ?? (tenant.defaultCurrency as string);
  // GCC display currencies (SAR, QAR…) are converted on the website from the INR fares: search in INR.
  if (!["INR", "AED", "USD"].includes(currency)) currency = "INR";
  const searchCurrency = currency as "INR" | "AED" | "USD";

  const availableSuppliers = supplierConfigs.filter((s) => s.isEnabled).map((s) => s.name);
  const credentialAvailability = {
    RIYA:        false,  // temporarily disabled
    TRIPJACK:    Boolean(platformCredentials.TRIPJACK || supplierConfigs.find((s) => s.name === "TRIPJACK")?.credentials),
    DUFFEL:      false,  // temporarily disabled
    GOOGLE_SERP: false,  // temporarily disabled
  };

  const trialKey = sessionId ? `serp_trials:${tenantId}:${sessionId}` : null;
  if (trialKey && supplierConfigs.some((s) => s.name === "GOOGLE_SERP" && s.isEnabled)) {
    c.executionCtx.waitUntil((async () => {
      try {
        const raw = await c.env.SESSIONS_KV.get(trialKey);
        const count = raw ? parseInt(raw, 10) : 0;
        await c.env.SESSIONS_KV.put(trialKey, String(count + 1), { expirationTtl: SERP_TRIAL_TTL });
      } catch (err) {
        console.error("[search] SERP analytics KV unavailable", err);
      }
    })());
  }

  // Agency callers get their own net / selling prices — added per request, never cached.
  const agentId = await optionalAgentId(c);

  const cacheKey = `fares:${tenantId}:${JSON.stringify({ ...params, currency })}`;
  try {
    const cached = await c.env.FARE_CACHE_KV.get(cacheKey, "json") as {
      fares?: unknown[];
      supplierErrors?: Record<string, string>;
    } | null;
    if (cached && Array.isArray(cached.fares) && cached.fares.length > 0 && !cached.supplierErrors) {
      // Keep the original live search's id so a booking links to its TripJack logs.
      return c.json({
        ...cached, fromCache: true, searchId: (cached as { searchId?: string }).searchId ?? searchId,
        ...(agentId ? { fares: await agentFares(c, tenantId, agentId, cached.fares as AgentFare[]) } : {}),
      });
    }
  } catch (err) {
    console.error("[search] fare cache read unavailable; continuing live", err);
  }

  // Capture the raw TripJack exchange(s) for this search (certification logs).
  const collector = collectExchanges();
  const result = await searchFares(
    {
      ...params, currency: searchCurrency,
      legs: params.legs?.map((l) => ({ origin: l.origin, destination: l.destination, date: l.departureDate })),
    },
    supplierConfigs.map((s) => s.name === "TRIPJACK" && s.credentials ? { ...s, credentials: { ...s.credentials, recorder: collector.recorder } } : s),
    { platformCredentials: { ...platformCredentials, ...(platformCredentials.TRIPJACK ? { TRIPJACK: { ...platformCredentials.TRIPJACK, recorder: collector.recorder } as typeof platformCredentials.TRIPJACK } : {}) } },
  );
  persistInBackground(c, persistExchanges(c.env, db, tenantId, collector.exchanges, { searchId }));

  // Markup is optional for availability. If DB/schema/rule loading fails, return the
  // supplier fare unchanged rather than converting a healthy flight search into HTTP 500.
  let pricedFares = result.fares.map((fare) => ({ ...fare, displayPrice: fare.totalFare, markup: undefined }));
  try {
    const { applyMarkup } = await import("../lib/markup.js");
    const { markupRules } = await import("@poomas/db/schema");
    const { eq } = await import("drizzle-orm");
    const rules = await db.select().from(markupRules).where(eq(markupRules.tenantId, tenantId));
    pricedFares = result.fares.map((fare) => ({
      ...fare,
      // Company-wide rules only: agency rules apply to that agency's own searches.
      displayPrice: applyMarkup(fare, rulesFor(rules, null)),
      markup: undefined,
    }));
  } catch (err) {
    console.error("[search] markup unavailable; returning raw supplier prices", err);
  }

  logSearchOutcome(c, tenantId, searchId, { ...params, currency: searchCurrency }, availableSuppliers, result.diagnostics ?? {});

  const hasErrors = Object.keys(result.errors).length > 0;
  const response = {
    searchId,
    fares: pricedFares,
    usedSuppliers: result.usedSuppliers,
    availableSuppliers,
    credentialAvailability,
    isIndicative: result.isIndicative,
    ...(hasErrors ? { supplierErrors: result.errors } : {}),
    disclaimer: result.isIndicative
      ? "Some results are indicative Google Flights fares and cannot be booked directly. Contact an agent to confirm availability and price."
      : undefined,
  };

  // Cache is an optimization only. Never fail the customer request because KV failed.
  c.executionCtx.waitUntil((async () => {
    try {
      if (pricedFares.length > 0 && !hasErrors) {
        await c.env.FARE_CACHE_KV.put(cacheKey, JSON.stringify(response), { expirationTtl: 300 });
      } else {
        await c.env.FARE_CACHE_KV.delete(cacheKey);
      }
    } catch (err) {
      console.error("[search] fare cache write unavailable", err);
    }
  })());

  // Price calendar + fare alerts learn from every live search (best effort).
  if (pricedFares.length > 0) {
    c.executionCtx.waitUntil((async () => {
      try {
        // Keyed by the fares' own currency (TripJack prices in INR even for an AED search):
        // the website converts calendar prices to the visitor's currency.
        const fareCurrency = String(pricedFares[0]?.currency ?? currency);
        const due = await recordFareObservation(c.env.FARE_CACHE_KV, tenantId, { ...params, currency: fareCurrency }, pricedFares);
        if (due.length) await sendFareAlerts(c.env, db, due);
      } catch (err) {
        console.error("[search] price calendar / fare alert update failed", err);
      }
    })());
  }

  return c.json(agentId ? { ...response, fares: await agentFares(c, tenantId, agentId, response.fares as AgentFare[]) } : response);
}

type AgentFare = { totalFare: number; displayPrice?: number; airline?: string; origin?: string; destination?: string; cabinClass?: string; supplier?: string };

// Agency view of a result set: company price (including rules for this agency),
// plus parents' markups = NET (what the agency pays); plus its own markup = SELLING.
async function agentFares(c: Context<{ Bindings: Env; Variables: Variables }>, tenantId: string, agentId: string, fares: AgentFare[]) {
  try {
    const db = c.get("db");
    const { applyMarkup } = await import("../lib/markup.js");
    const { markupRules } = await import("@poomas/db/schema");
    const { eq } = await import("drizzle-orm");
    const rules = await db.select().from(markupRules).where(eq(markupRules.tenantId, tenantId));
    const ownRules = rules.some((r) => r.agentId === agentId);
    const pricing = await agentPricing(c.env, db, tenantId, agentId);
    return fares.map((f) => {
      const company = ownRules ? applyMarkup(f as never, rulesFor(rules, agentId)) : (f.displayPrice ?? f.totalFare);
      const p = pricing.price(company);
      return { ...f, displayPrice: p.net, netPrice: p.net, sellingPrice: p.selling, agentMarkup: Math.round((p.net - company) * 100) / 100 };
    });
  } catch (err) {
    console.error("[search] agent pricing unavailable; showing company prices", err);
    return fares;
  }
}

// Display/payment conversion rate (INR per 1 AED) set by admin; null = AED payment off.
// Display / payment rates (INR per 1 unit) from the automatic exchange-rate tool.
searchRoutes.get("/fx", async (c) => {
  const fx = await getFx(c.env, c.get("tenantId"), c.executionCtx);
  return c.json({ base: "INR", unit: "INR per 1 unit", rates: fx.rates, updatedAt: fx.autoUpdatedAt }, 200, { "Cache-Control": "no-store" });
});

// Safe operational status: exposes only booleans/names, never secret values.
searchRoutes.get("/status", async (c) => {
  const tenant = c.get("tenant");
  return c.json({
    tenant: tenant.slug,
    enabledSuppliers: tenant.supplierConfigs.filter((s) => s.isEnabled).map((s) => s.supplier),
    platformSecrets: {
      RIYA:        false,  // temporarily disabled
      TRIPJACK:    Boolean(c.env.TRIPJACK_API_BASE_URL && (c.env.TRIPJACK_API_KEY || c.env.TRIPJACK_PROXY_KEY)),
      DUFFEL:      false,  // temporarily disabled
      GOOGLE_SERP: false,  // temporarily disabled
    },
  });
});

// Review availability; a failed check does not establish that a fare expired.
searchRoutes.post("/validate-fare", async (c) => {
  const { fareId, supplier } = await c.req.json<{ fareId: string; supplier: string }>();
  if (!fareId || !supplier) return c.json({ error: "fareId and supplier required" }, 400);

  if (supplier === "TRIPJACK") {
    const { TripjackClient } = await import("@poomas/suppliers");
    const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(c.env, c.get("tenant"), c.get("tenantId"));
    const config = supplierConfigs.find((s) => s.name === "TRIPJACK");
    if (!config?.isEnabled) return c.json({ valid: false, reason: "unavailable" });
    const creds = { ...(platformCredentials.TRIPJACK ?? {}), ...(config.credentials ?? {}) };
    const client = new TripjackClient(creds);
    try {
      const result = await client.validateFare(fareId);
      return c.json({ valid: true, bookingId: result.bookingId });
    } catch (err: any) {
      if (err?.code === "FARE_EXPIRED") {
        return c.json({ valid: false, reason: "expired", requestId: err.requestId }, 200);
      }
      return c.json({ valid: false, reason: "unavailable", requestId: err?.requestId, message: "We couldn't verify this fare right now." }, 200);
    }
  }

  // Other suppliers — treat as always valid (they don't expire the same way)
  return c.json({ valid: true });
});

// Debug endpoint — returns the raw TripJack search response for a given route.
// Restricted to admin/internal use; exposes no payment or PII data.
searchRoutes.get("/debug-tripjack", async (c) => {
  const origin      = (c.req.query("origin")      ?? "").toUpperCase();
  const destination = (c.req.query("destination")  ?? "").toUpperCase();
  const date        = c.req.query("date") ?? new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  if (!origin || !destination) return c.json({ error: "origin and destination required" }, 400);

  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(c.env, c.get("tenant"), c.get("tenantId"));
  const config = supplierConfigs.find((s) => s.name === "TRIPJACK");
  if (!config?.isEnabled) return c.json({ error: "TRIPJACK not enabled", credentialAvailability: platformCredentials.TRIPJACK });

  const { TripjackClient } = await import("@poomas/suppliers");
  const creds = { ...(platformCredentials.TRIPJACK ?? {}), ...(config.credentials ?? {}) };
  const resolvedBaseUrl = (creds.baseUrl as string | undefined)?.replace(/\/+$/, "") ?? "(not set)";
  const usingGateway    = Boolean(creds.proxyKey);
  const client = new TripjackClient(creds);
  try {
    // Use client.search() so path selection mirrors production exactly.
    const raw = await (client as any).search({ origin, destination, departureDate: date, adults: 1, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: "INR" }) as Record<string, unknown>;
    const response    = (raw.data ?? raw.result ?? raw) as Record<string, unknown>;
    const tripInfos   = (response.searchResult as any)?.tripInfos ?? null;
    const keys        = tripInfos ? Object.keys(tripInfos) : null;
    const counts: Record<string, number> = {};
    if (tripInfos) {
      for (const k of Object.keys(tripInfos)) counts[k] = Array.isArray(tripInfos[k]) ? (tripInfos[k] as unknown[]).length : -1;
    }
    return c.json({
      resolvedBaseUrl,
      usingGateway,
      status:          response.status,
      tripInfoKeys:    keys,
      tripInfoCounts:  counts,
      hasSearchResult: !!response.searchResult,
      firstTrip:       tripInfos ? (Object.values(tripInfos).find(Array.isArray) as unknown[] | undefined)?.[0] ?? null : null,
    });
  } catch (err: any) {
    return c.json({ resolvedBaseUrl, usingGateway, error: err.message ?? String(err), stack: err.stack?.slice(0, 500) }, 200);
  }
});

searchRoutes.get("/fare-rules/:fareId", async (c) => {
  const { fareId } = c.req.param();
  const supplier = (c.req.query("supplier") ?? "TRIPJACK").toUpperCase();
  if (supplier !== "TRIPJACK") return c.json({ fareRules: [] });
  const tenantId = c.get("tenantId");
  // Cancellation / date-change rules for one fare option (cached 30 min).
  const cacheKey = `fare_rules:${tenantId}:${fareId}`;
  const cached = await c.env.FARE_CACHE_KV.get(cacheKey, "json").catch(() => null);
  if (cached) return c.json({ fareRules: cached, cached: true });
  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(c.env, c.get("tenant"), tenantId);
  const config = supplierConfigs.find((s) => s.name === "TRIPJACK");
  if (!config?.isEnabled) return c.json({ fareRules: [], error: "Fare rules aren't available right now." });
  const { TripjackClient, parseTripjackFareRules } = await import("@poomas/suppliers");
  try {
    const client = new TripjackClient({ ...(platformCredentials.TRIPJACK ?? {}), ...(config.credentials ?? {}) });
    const rules = parseTripjackFareRules(await client.fareRules(fareId));
    if (rules.length) c.executionCtx.waitUntil(c.env.FARE_CACHE_KV.put(cacheKey, JSON.stringify(rules), { expirationTtl: 1800 }).catch(() => {}));
    return c.json({ fareRules: rules });
  } catch (err) {
    console.error("[fare-rules]", err);
    return c.json({ fareRules: [], error: "The airline's fare rules couldn't be loaded. Check them before booking." });
  }
});
