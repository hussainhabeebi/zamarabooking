// Currency conversion. TripJack prices are in INR; customers can see prices in
// INR, the GCC currencies or USD, and pay in INR or AED.
//
// Rates are "INR per 1 unit" of the other currency. They come from the
// automatic exchange-rate tool: live market rates fetched from public FX feeds
// every few hours (cron + refresh on read when stale), checked for sanity, and
// stored in KV. Admin can add a margin (%) on top and keep manual rates, which
// are used only when automatic rates are unavailable (or when Admin switches
// to manual mode). No usable rate means that currency is not offered — never guessed.

export type PayCurrency = "INR" | "AED";
export const GCC_CURRENCIES = ["AED", "SAR", "QAR", "OMR", "KWD", "BHD"] as const;
export const DISPLAY_CURRENCIES = ["INR", ...GCC_CURRENCIES, "USD"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];
export type ForeignCurrency = Exclude<DisplayCurrency, "INR">;
export const FOREIGN_CURRENCIES = DISPLAY_CURRENCIES.filter((c) => c !== "INR") as ForeignCurrency[];

export interface FxSettings {
  mode: "auto" | "manual";
  marginPct: number;                                   // customer pays this much more than the market rate
  manual: Partial<Record<ForeignCurrency, number>>;    // INR per 1 unit
}
export interface AutoRates {
  inrPer: Partial<Record<ForeignCurrency, number>>;
  source: string;
  fetchedAt: string;
}
export interface FxView {
  base: "INR";
  rates: Record<ForeignCurrency, number | null>;       // effective INR per 1 unit (margin applied)
  sources: Record<ForeignCurrency, "auto" | "manual" | null>;
  mode: FxSettings["mode"];
  marginPct: number;
  autoUpdatedAt: string | null;
  autoSource: string | null;
}

interface Kv {
  get(k: string): Promise<string | null>;
  put?(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>;
}
type FxEnv = { TENANT_CACHE_KV: Kv };

export const AUTO_RATES_KEY = "fx_auto:INR";
const settingsKey = (tenantId: string) => `admin_settings:${tenantId}:fx`;
const REFRESH_AFTER_MS = 6 * 3600_000;          // refresh on read when older than this
const MAX_AGE_MS = 7 * 24 * 3600_000;           // older automatic rates are not used
const MAX_JUMP = 0.1;                           // reject a feed that moves a rate >10% at once

// Wide plausibility bands (INR per 1 unit) against a broken or hijacked feed.
const BANDS: Record<ForeignCurrency, [number, number]> = {
  AED: [12, 60], SAR: [12, 60], QAR: [12, 60], OMR: [120, 600], KWD: [140, 700], BHD: [120, 600], USD: [45, 220],
};

export const DEFAULT_FX_SETTINGS: FxSettings = { mode: "auto", marginPct: 0, manual: {} };

const isForeign = (c: string): c is ForeignCurrency => (FOREIGN_CURRENCIES as string[]).includes(c);

// ── Feeds ────────────────────────────────────────────────────────────────────

// Each returns "units of X per 1 INR" by currency code.
const FEEDS: { name: string; url: string; parse: (d: any) => Record<string, number> | null }[] = [
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/INR",
    parse: (d) => (d?.result === "success" && d?.base_code === "INR" && d?.rates ? d.rates : null),
  },
  {
    name: "fawazahmed0/currency-api",
    url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/inr.json",
    parse: (d) => (d?.inr ? Object.fromEntries(Object.entries(d.inr).map(([k, v]) => [k.toUpperCase(), Number(v)])) : null),
  },
  {
    name: "currency-api.pages.dev",
    url: "https://latest.currency-api.pages.dev/v1/currencies/inr.json",
    parse: (d) => (d?.inr ? Object.fromEntries(Object.entries(d.inr).map(([k, v]) => [k.toUpperCase(), Number(v)])) : null),
  },
];

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// Converts a feed's "X per INR" into checked "INR per X". Null if anything is off.
export function toInrPer(perInr: Record<string, number>, previous?: AutoRates | null, now = Date.now()): AutoRates["inrPer"] | null {
  const out: AutoRates["inrPer"] = {};
  const prevFresh = previous && now - Date.parse(previous.fetchedAt) < MAX_AGE_MS ? previous : null;
  for (const c of FOREIGN_CURRENCIES) {
    const v = Number(perInr[c]);
    if (!Number.isFinite(v) || v <= 0) return null;
    const inr = round4(1 / v);
    const [lo, hi] = BANDS[c];
    if (inr < lo || inr > hi) return null;
    const prev = prevFresh?.inrPer[c];
    if (prev && Math.abs(inr - prev) / prev > MAX_JUMP) return null;
    out[c] = inr;
  }
  return out;
}

export async function readAutoRates(env: FxEnv): Promise<AutoRates | null> {
  try {
    const raw = await env.TENANT_CACHE_KV.get(AUTO_RATES_KEY);
    const d = raw ? JSON.parse(raw) as AutoRates : null;
    return d?.inrPer && d.fetchedAt ? d : null;
  } catch { return null; }
}

// Fetches live rates (first feed that passes the checks wins) and stores them.
export async function refreshAutoRates(env: FxEnv, fetchImpl: typeof fetch = fetch, now = Date.now(), force = false): Promise<{ ok: true; rates: AutoRates } | { ok: false; error: string }> {
  const previous = await readAutoRates(env);
  const errors: string[] = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetchImpl(feed.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) { errors.push(`${feed.name}: HTTP ${res.status}`); continue; }
      const parsed = feed.parse(await res.json());
      const inrPer = parsed ? toInrPer(parsed, force ? null : previous, now) : null;
      if (!inrPer) { errors.push(`${feed.name}: rates missing or failed the sanity check`); continue; }
      const rates: AutoRates = { inrPer, source: feed.name, fetchedAt: new Date(now).toISOString() };
      await env.TENANT_CACHE_KV.put?.(AUTO_RATES_KEY, JSON.stringify(rates));
      return { ok: true, rates };
    } catch (err) {
      errors.push(`${feed.name}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  console.error("[fx] automatic exchange rates not updated", errors);
  return { ok: false, error: errors.join("; ") };
}

// ── Settings and effective rates ─────────────────────────────────────────────

export async function getFxSettings(env: FxEnv, tenantId: string): Promise<FxSettings> {
  let saved: Partial<FxSettings> | null = null;
  let legacyAed: number | null = null;
  try {
    const raw = await env.TENANT_CACHE_KV.get(settingsKey(tenantId));
    saved = raw ? JSON.parse(raw) : null;
  } catch {}
  try {
    // The earlier manual AED rate (Settings → Payment Gateways → Nomod) stays as the AED fallback.
    const raw = await env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:payments`);
    const r = raw ? Number(JSON.parse(raw)?.nomod?.aedRate) : NaN;
    legacyAed = Number.isFinite(r) && r > 0 ? r : null;
  } catch {}
  const manual: FxSettings["manual"] = {};
  for (const [c, v] of Object.entries(saved?.manual ?? {})) {
    if (isForeign(c) && Number.isFinite(Number(v)) && Number(v) > 0) manual[c] = Number(v);
  }
  if (!manual.AED && legacyAed) manual.AED = legacyAed;
  const margin = Number(saved?.marginPct);
  return {
    mode: saved?.mode === "manual" ? "manual" : "auto",
    marginPct: Number.isFinite(margin) && margin >= 0 && margin <= 10 ? margin : 0,
    manual,
  };
}

export async function saveFxSettings(env: FxEnv, tenantId: string, s: FxSettings) {
  await env.TENANT_CACHE_KV.put?.(settingsKey(tenantId), JSON.stringify(s));
}

export function effectiveRates(settings: FxSettings, auto: AutoRates | null, now = Date.now()): Pick<FxView, "rates" | "sources"> {
  const autoOk = auto && now - Date.parse(auto.fetchedAt) < MAX_AGE_MS ? auto : null;
  const rates = {} as FxView["rates"];
  const sources = {} as FxView["sources"];
  for (const c of FOREIGN_CURRENCIES) {
    const a = autoOk?.inrPer[c];
    // Margin: fewer rupees per unit → the customer pays a little more in their currency.
    const fromAuto = a ? round4(a / (1 + settings.marginPct / 100)) : null;
    const fromManual = settings.manual[c] ?? null;
    const [first, second] = settings.mode === "manual"
      ? [[fromManual, "manual"], [fromAuto, "auto"]] as const
      : [[fromAuto, "auto"], [fromManual, "manual"]] as const;
    const pick = first[0] ? first : second[0] ? second : null;
    rates[c] = pick ? pick[0] : null;
    sources[c] = pick ? pick[1] : null;
  }
  return { rates, sources };
}

type Waiter = { waitUntil(p: Promise<unknown>): void };

// Effective rates for a tenant. Stale automatic rates are refreshed in the background.
export async function getFx(env: FxEnv, tenantId: string, ctx?: Waiter): Promise<FxView> {
  const [settings, auto] = await Promise.all([getFxSettings(env, tenantId), readAutoRates(env)]);
  if (ctx && env.TENANT_CACHE_KV.put && (!auto || Date.now() - Date.parse(auto.fetchedAt) > REFRESH_AFTER_MS)) {
    ctx.waitUntil(refreshAutoRates(env).catch(() => {}));
  }
  return {
    base: "INR",
    ...effectiveRates(settings, auto),
    mode: settings.mode,
    marginPct: settings.marginPct,
    autoUpdatedAt: auto?.fetchedAt ?? null,
    autoSource: auto?.source ?? null,
  };
}

// INR per 1 AED for AED payments (automatic rate, manual fallback).
export async function getAedRate(env: FxEnv, tenantId: string, ctx?: Waiter): Promise<number | null> {
  try {
    return (await getFx(env, tenantId, ctx)).rates.AED;
  } catch {
    return null;
  }
}

// Converts an amount from `from` into `to`. Rounds UP to the next fils/paisa so
// the conversion never under-collects. Returns null when no rate is available.
export function convertAmount(amount: number, from: string, to: string, aedRate: number | null): number | null {
  if (from === to) return Math.round(amount * 100) / 100;
  if (from === "INR" && to === "AED" && aedRate) return Math.ceil((amount / aedRate) * 100 - 1e-9) / 100;
  return null;
}
