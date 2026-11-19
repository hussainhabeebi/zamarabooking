// Confirmed baggage for Akbar search results, before pricing (docs/akbar-search-baggage.md).
//
// Akbar (Nov 2026): SSR can be called with the ExpressSearch result's Index before SmartPricer; free
// SSR is the recommended source of baggage (AKB-SPCL included); only availability counts towards the
// 100:1 look-to-book ratio. Akbar asked for our hit count per minute, so SSR is strictly limited:
//
//   OFF by default            Admin switch (admin_settings:<tenant>:integration:akbar-search-baggage)
//   asked for, not automatic  the website asks only for the fares a customer is looking at (a few
//                             cards, or the card whose "Baggage & details" is opened)
//   search first              fares whose ExpressSearch baggage is already confirmed are never asked
//   cached                    per exact fare (search TUI + Index) for the life of the search, and per
//                             fare product (airline, flights, times, fare type, booking class, cabin,
//                             passenger types) for a few hours — never across fare options or flights
//   account-wide limit        at most `perMinute` SSR calls a minute for the tenant (Durable Object);
//                             over it → BUSY (nothing queued, the page keeps "Allowance not confirmed")
//   small and short           at most `maxPerRequest` fares per call, `concurrency` at a time, a short
//                             timeout; any failure → UNKNOWN, never an error for the page
//
// Pricing, booking and the booking run's own SSR call are not changed.

import type { NormalizedFare } from "@zamrabooking/suppliers";
import { AkbarClient, akbarSsrBaggage, type SsrBaggageResult, type StructuredBaggage } from "@zamrabooking/suppliers";
import type { Env, Variables } from "../types.js";
import { getAkbarSettings, getAkbarToken, lookupOfflineFare, type Pax } from "./flight-sources.js";
import { collectExchanges, persistExchanges } from "./api-exchanges.js";

type Db = Variables["db"];

export interface SearchBaggageSettings {
  enabled: boolean;
  perMinute: number;          // SSR calls a minute for the whole tenant
  maxPerRequest: number;      // fares one page request may ask about
  concurrency: number;        // SSR calls at the same time within one request
  productCacheHours: number;  // reuse a confirmed allowance for the same fare product
  timeoutMs: number;
  source: "LV" | "CF";        // the SSR request's Source (the booking run sends "LV")
  updatedAt?: string;
  updatedBy?: string | null;
}
export const DEFAULT_SEARCH_BAGGAGE: SearchBaggageSettings = {
  enabled: false, perMinute: 30, maxPerRequest: 6, concurrency: 2, productCacheHours: 6, timeoutMs: 6000, source: "LV",
};
const LIMITS = { perMinute: [1, 120], maxPerRequest: [1, 10], concurrency: [1, 4], productCacheHours: [0, 24], timeoutMs: [2000, 15000] } as const;
const settingsKey = (tenantId: string) => `admin_settings:${tenantId}:integration:akbar-search-baggage`;

export async function getSearchBaggageSettings(env: Pick<Env, "TENANT_CACHE_KV">, tenantId: string): Promise<SearchBaggageSettings> {
  const saved = await env.TENANT_CACHE_KV.get(settingsKey(tenantId), "json").catch(() => null) as Partial<SearchBaggageSettings> | null;
  return normalizeSettings({ ...DEFAULT_SEARCH_BAGGAGE, ...(saved ?? {}) });
}

export function normalizeSettings(s: Partial<SearchBaggageSettings>): SearchBaggageSettings {
  const clamp = (k: keyof typeof LIMITS, v: unknown) => {
    const [lo, hi] = LIMITS[k];
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULT_SEARCH_BAGGAGE[k];
  };
  return {
    enabled: s.enabled === true,
    perMinute: clamp("perMinute", s.perMinute), maxPerRequest: clamp("maxPerRequest", s.maxPerRequest),
    concurrency: clamp("concurrency", s.concurrency), productCacheHours: clamp("productCacheHours", s.productCacheHours),
    timeoutMs: clamp("timeoutMs", s.timeoutMs), source: s.source === "CF" ? "CF" : "LV",
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}), ...(s.updatedBy !== undefined ? { updatedBy: s.updatedBy ?? null } : {}),
  };
}

export async function saveSearchBaggageSettings(env: Pick<Env, "TENANT_CACHE_KV">, tenantId: string, input: Partial<SearchBaggageSettings>, userId: string | null) {
  const current = await getSearchBaggageSettings(env, tenantId);
  const next = normalizeSettings({ ...current, ...input, updatedAt: new Date().toISOString(), updatedBy: userId });
  await env.TENANT_CACHE_KV.put(settingsKey(tenantId), JSON.stringify(next));
  return next;
}

// ── What the page gets back for each fare ─────────────────────────────────────────

export type FareBaggageStatus =
  | "SEARCH"      // the search result already had a confirmed allowance: nothing asked
  | "CONFIRMED"   // Akbar's free SSR (or a cached copy of it) confirmed it
  | "VARIES"      // the flights of this fare have different allowances: shown per flight
  | "UNKNOWN"     // Akbar gave nothing reliable
  | "BUSY"        // the per-minute limit was reached: not asked now
  | "EXPIRED"     // the search is no longer remembered (search again)
  | "INVALID";    // not an Akbar fare id
export interface FareBaggage {
  status: FareBaggageStatus;
  source?: "SEARCH" | "SSR" | "CACHE";
  baggage?: StructuredBaggage;
  child?: StructuredBaggage;
  infant?: StructuredBaggage;
  segments?: { airline: string; checked: string; cabin: string; checkedStatus: string; cabinStatus: string }[];
}

const known = (b?: { checkedStatus?: string; cabinStatus?: string }) =>
  !!b && (b.checkedStatus === "INCLUDED" || b.checkedStatus === "NONE") && (b.cabinStatus === "INCLUDED" || b.cabinStatus === "NONE");

const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

/** Everything that decides a fare's included baggage — never the price, never another fare option. */
export function productKeyParts(f: NormalizedFare, pax: Pax) {
  const raw = (f.raw ?? {}) as { carriers?: string[]; provider?: string; fareType?: string; side?: string };
  return [
    "AKBAR", raw.provider ?? "", (raw.carriers ?? []).map((c) => c.toUpperCase()).sort().join("+"), f.airline, f.flightNumber,
    f.origin, f.destination, f.departureTime, f.arrivalTime, String(f.stops),
    (f.stopDetails ?? []).map((s) => s.airport).join("-"), f.fareIdentifier ?? "", f.fareClass ?? "", f.cabinClass,
    raw.fareType ?? "ON", raw.side ?? "", `A${pax.adults > 0 ? 1 : 0}C${pax.children > 0 ? 1 : 0}I${pax.infants > 0 ? 1 : 0}`,
  ];
}

const shape = (r: SsrBaggageResult): FareBaggage => r.status === "CONFIRMED"
  ? { status: "CONFIRMED", source: "SSR", baggage: r.adult, ...(r.child ? { child: r.child } : {}), ...(r.infant ? { infant: r.infant } : {}) }
  : r.status === "VARIES"
    ? { status: "VARIES", source: "SSR", segments: r.segments.map((s) => ({ airline: s.airline, ...(s.byPtc.ADT as StructuredBaggage) })) }
    : { status: "UNKNOWN" };

export interface SearchBaggageDeps {
  // The per-minute check (Durable Object); true = allowed.
  allow: (count: number) => Promise<boolean>;
  ssr: (trip: { tui: string; orderId: number | string; index: string }) => Promise<unknown>;
  log?: (exchangesDone: () => Promise<void>) => void;
}

export async function searchBaggage(env: Env, db: Db, tenantId: string, fareIds: string[], pax: Pax, settings: SearchBaggageSettings, deps: SearchBaggageDeps): Promise<Record<string, FareBaggage>> {
  const out: Record<string, FareBaggage> = {};
  const ids = [...new Set(fareIds)].slice(0, settings.maxPerRequest);
  const todo: { id: string; fare: NormalizedFare; tui: string; index: string; orderId: number | string; exactKey: string; productKey: string }[] = [];

  for (const id of ids) {
    if (!id.startsWith("AK|")) { out[id] = { status: "INVALID" }; continue; }
    const found = await lookupOfflineFare(env, db, tenantId, "AKBAR", id, pax).catch(() => ({ reason: "NOT_FOUND" as const }));
    if (!("fare" in found)) { out[id] = { status: "EXPIRED" }; continue; }
    const fare = found.fare;
    if (known(fare.baggage)) { out[id] = { status: "SEARCH", source: "SEARCH", baggage: fare.baggage as StructuredBaggage }; continue; }
    const raw = (fare.raw ?? {}) as { tui?: string; index?: string; orderId?: number | string | null; carriers?: string[] };
    if (!raw.tui || !raw.index) { out[id] = { status: "UNKNOWN" }; continue; }
    const exactKey = `ssrbag:x:${tenantId}:${await sha(`${raw.tui}|${raw.index}|${raw.orderId ?? 1}`)}`;
    const productKey = `ssrbag:p:${tenantId}:${await sha(productKeyParts(fare, pax).join("|"))}`;
    const cached = (await env.FARE_CACHE_KV.get(exactKey, "json").catch(() => null)) as FareBaggage | null
      ?? (settings.productCacheHours > 0 ? (await env.FARE_CACHE_KV.get(productKey, "json").catch(() => null)) as FareBaggage | null : null);
    if (cached) { out[id] = { ...cached, source: "CACHE" }; continue; }
    todo.push({ id, fare, tui: raw.tui, index: raw.index, orderId: raw.orderId ?? 1, exactKey, productKey });
  }

  // One at a time per slot, `concurrency` slots; each call first takes one unit of the minute's budget.
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const t = todo[next++];
      if (!(await deps.allow(1).catch(() => false))) { out[t.id] = { status: "BUSY" }; continue; }
      let result: FareBaggage;
      try {
        const data = await deps.ssr({ tui: t.tui, orderId: t.orderId, index: t.index });
        const carriers = ((t.fare.raw ?? {}) as { carriers?: string[] }).carriers ?? [t.fare.airline];
        result = shape(akbarSsrBaggage(data, { carriers, index: t.index }));
      } catch {
        result = { status: "UNKNOWN" };
      }
      out[t.id] = result;
      // Remember the answer for this exact fare while the search lives (also UNKNOWN: not asked again);
      // confirmed allowances also for the fare product.
      await env.FARE_CACHE_KV.put(t.exactKey, JSON.stringify(result), { expirationTtl: 30 * 60 }).catch(() => {});
      if (result.status === "CONFIRMED" && settings.productCacheHours > 0) {
        await env.FARE_CACHE_KV.put(t.productKey, JSON.stringify(result), { expirationTtl: settings.productCacheHours * 3600 }).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, todo.length) }, worker));
  return out;
}

/** The real dependencies: the tenant's Durable Object limit and Akbar's SSR (logged to API logs). */
export async function liveSearchBaggage(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, db: Db, tenantId: string, fareIds: string[], pax: Pax, settings: SearchBaggageSettings) {
  const akbar = await getAkbarSettings(c.env, tenantId);
  if (!akbar.enabled) return null;
  const collector = collectExchanges();
  // Same client as the search (lib/flight-sources.ts akbarClient), with every call recorded for API logs.
  const client = new AkbarClient({ ...akbar, gatewayKey: c.env.AKBAR_GATEWAY_KEY, recorder: collector.recorder });
  const limiter = c.env.TENANT_RATE_LIMITER?.get(c.env.TENANT_RATE_LIMITER.idFromName(tenantId));
  const results = await searchBaggage(c.env, db, tenantId, fareIds, pax, settings, {
    allow: async () => {
      if (!limiter) return false;   // no limiter → no SSR calls (never unlimited)
      const r = await limiter.fetch(new Request("https://internal/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, action: "akbar-ssr", limit: settings.perMinute }),
      }));
      return r.ok && ((await r.json()) as { allowed?: boolean }).allowed === true;
    },
    ssr: async (trip) => {
      const token = await getAkbarToken(c.env, tenantId, client);
      return client.ssr(trip, false, token, { source: settings.source, timeoutMs: settings.timeoutMs });
    },
  });
  if (collector.exchanges.length) {
    c.executionCtx.waitUntil(persistExchanges(c.env, db, tenantId, collector.exchanges, { requestId: `search-baggage-${crypto.randomUUID()}` }).catch(() => {}));
  }
  return results;
}
