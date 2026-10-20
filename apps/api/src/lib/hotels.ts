// TripJack Hotel API v3 service: credentials, nationality IDs, city → hotel ID
// resolution (v3 search takes hotel IDs, not cities), static content caching
// and the search orchestration used by /api/hotels.

import {
  TripjackHotelV3Client, validHotelId, normalizeContent, normalizeOption,
  type HotelV3Content, type HotelV3Option, type HotelV3Room,
} from "@poomas/suppliers";
import type { Env } from "../types.js";
import type { ExchangeRecorder } from "@poomas/suppliers";
import { collectExchanges, persistExchanges, persistInBackground } from "./api-exchanges.js";

// ── Credentials / environment ───────────────────────────────────────────────

interface TripjackSaved { apiKey?: string; environment?: "UAT" | "PRODUCTION" }

async function savedTripjack(env: Env, tenantId: string): Promise<TripjackSaved | null> {
  try {
    return await env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:integration:tripjack`, "json") as TripjackSaved | null;
  } catch {
    return null;
  }
}

export async function hotelClient(env: Env, tenantId: string, recorder?: ExchangeRecorder) {
  const saved = await savedTripjack(env, tenantId);
  return new TripjackHotelV3Client({
    apiKey:   saved?.apiKey || env.TRIPJACK_API_KEY,
    baseUrl:  env.TRIPJACK_API_BASE_URL,   // the Poomas TripJack gateway
    proxyKey: env.TRIPJACK_PROXY_KEY,
    ...(recorder ? { recorder } : {}),
  });
}

// Records every raw TripJack hotel request / response made while handling a
// request (Admin → API logs → hotel calls), linked to the search's
// correlationId or the TripJack booking ID. Use as middleware on hotel routes.
export const hotelExchanges = async (c: any, next: () => Promise<void>) => {
  const collector = collectExchanges();
  c.set("hotelExchanges", collector);
  c.set("hotelRequestId", `hotel-${crypto.randomUUID()}`);
  await next();
  if (!collector.exchanges.length) return;
  let body: any = null;
  if (c.req.method === "POST") { try { body = await c.req.json(); } catch { /* no JSON body */ } }
  const pathBooking = /\/bookings\/([A-Za-z0-9_-]+)/.exec(c.req.path)?.[1];
  persistInBackground(c, persistExchanges(c.env, c.get("db"), c.get("tenantId"), collector.exchanges, {
    bookingId: body?.bookingId ?? pathBooking ?? null,
    searchId:  body?.correlationId ?? null,
    requestId: c.get("hotelRequestId"),
  }));
};

export const hotelRecorder = (c: any): ExchangeRecorder | undefined => c.get("hotelExchanges")?.recorder;

export async function tripjackEnvironment(env: Env, tenantId: string): Promise<"UAT" | "PRODUCTION"> {
  return (await savedTripjack(env, tenantId))?.environment === "PRODUCTION" ? "PRODUCTION" : "UAT";
}

// ── Nationality (ISO2 → TripJack countryId) ─────────────────────────────────

const NATIONALITY_KEY = "hotel_v3:nationalities";

export async function nationalityId(env: Env, client: TripjackHotelV3Client, iso2: string): Promise<string> {
  const code = iso2.toUpperCase();
  if (/^\d+$/.test(code)) return code;   // already a TripJack countryId
  let map = await env.FARE_CACHE_KV.get(NATIONALITY_KEY, "json").catch(() => null) as Record<string, string> | null;
  if (!map) {
    const res = await client.nationalities();
    map = Object.fromEntries((res.nationalityInfos ?? []).map((n) => [String(n.code).toUpperCase(), String(n.countryId)]));
    if (Object.keys(map).length) {
      await env.FARE_CACHE_KV.put(NATIONALITY_KEY, JSON.stringify(map), { expirationTtl: 7 * 86400 }).catch(() => {});
    }
  }
  const id = map[code];
  if (!id) throw Object.assign(new Error(`Nationality ${code} is not supported by TripJack hotels`), { code: "NATIONALITY_UNSUPPORTED" });
  return id;
}

// ── City index (TripJack city region IDs) ───────────────────────────────────
// Built by Admin → Integrations → "Sync hotel cities" (paged; stored in R2).

const CITY_INDEX_KEY = "hotel-static/city-regions.json";
const CITY_INDEX_PARTIAL_KEY = "hotel-static/city-regions.partial.json";
const PAGES_PER_SYNC_CALL = 8;

interface CityIndex {
  builtAt:  string;
  count:    number;
  cities:   Record<string, [number, string][]>;   // CITY NAME → [regionId, COUNTRY NAME][]
}

interface PartialCityIndex extends CityIndex { cursor?: string; pages: number }

export async function cityIndexStatus(env: Env) {
  const [done, partial] = await Promise.all([
    env.DOCUMENTS_R2.head(CITY_INDEX_KEY),
    env.DOCUMENTS_R2.get(CITY_INDEX_PARTIAL_KEY),
  ]);
  const p = partial ? await partial.json() as PartialCityIndex : null;
  return {
    ready:       Boolean(done),
    builtAt:     done?.customMetadata?.builtAt ?? null,
    cities:      done ? Number(done.customMetadata?.count ?? 0) : 0,
    inProgress:  Boolean(p),
    pagesDone:   p?.pages ?? 0,
    regionsSoFar: p?.count ?? 0,
  };
}

// Processes a few pages per call so each request stays well within Worker limits.
export async function syncCityIndex(env: Env, client: TripjackHotelV3Client, restart = false) {
  let state: PartialCityIndex | null = null;
  if (!restart) {
    const obj = await env.DOCUMENTS_R2.get(CITY_INDEX_PARTIAL_KEY);
    state = obj ? await obj.json() as PartialCityIndex : null;
  }
  state ??= { builtAt: "", count: 0, cities: {}, pages: 0 };

  let hasMore = true;
  for (let i = 0; i < PAGES_PER_SYNC_CALL && hasMore; i++) {
    const page = await client.cityRegionIds(2000, state.cursor);
    for (const r of page.hotelCityRegionIds ?? []) {
      const name = String(r.cityName ?? "").toUpperCase().trim();
      if (!name) continue;
      (state.cities[name] ??= []).push([Number(r.cityRegionId), String(r.countryName ?? "").toUpperCase()]);
      state.count += 1;
    }
    state.pages += 1;
    state.cursor = page.nextCursor ?? undefined;
    hasMore = Boolean(page.hasMore && page.nextCursor);
  }

  if (hasMore) {
    await env.DOCUMENTS_R2.put(CITY_INDEX_PARTIAL_KEY, JSON.stringify(state));
    return { done: false, pages: state.pages, regions: state.count };
  }
  const index: CityIndex = { builtAt: new Date().toISOString(), count: state.count, cities: state.cities };
  await env.DOCUMENTS_R2.put(CITY_INDEX_KEY, JSON.stringify(index), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { builtAt: index.builtAt, count: String(Object.keys(index.cities).length) },
  });
  await env.DOCUMENTS_R2.delete(CITY_INDEX_PARTIAL_KEY);
  return { done: true, pages: state.pages, regions: state.count, cities: Object.keys(index.cities).length };
}

// Website city codes → city names (the Hotels page sends these).
const CITY_CODES: Record<string, { city: string; country: string }> = {
  DXB: { city: "Dubai", country: "AE" }, AUH: { city: "Abu Dhabi", country: "AE" }, SHJ: { city: "Sharjah", country: "AE" },
  DOH: { city: "Doha", country: "QA" }, BOM: { city: "Mumbai", country: "IN" }, DEL: { city: "New Delhi", country: "IN" },
  CCJ: { city: "Kozhikode", country: "IN" }, COK: { city: "Kochi", country: "IN" }, BLR: { city: "Bengaluru", country: "IN" },
  HYD: { city: "Hyderabad", country: "IN" }, MAA: { city: "Chennai", country: "IN" }, GOI: { city: "Goa", country: "IN" },
  AMD: { city: "Ahmedabad", country: "IN" }, CCU: { city: "Kolkata", country: "IN" }, TRV: { city: "Trivandrum", country: "IN" },
  MCT: { city: "Muscat", country: "OM" }, RUH: { city: "Riyadh", country: "SA" }, JED: { city: "Jeddah", country: "SA" },
  KWI: { city: "Kuwait City", country: "KW" }, BAH: { city: "Bahrain", country: "BH" }, LHR: { city: "London", country: "GB" },
  CDG: { city: "Paris", country: "FR" }, SIN: { city: "Singapore", country: "SG" }, BKK: { city: "Bangkok", country: "TH" },
  KUL: { city: "Kuala Lumpur", country: "MY" }, NRT: { city: "Tokyo", country: "JP" }, JFK: { city: "New York", country: "US" },
  SYD: { city: "Sydney", country: "AU" },
};

const COUNTRY_NAMES: Record<string, string[]> = {
  AE: ["UNITED ARAB EMIRATES"], QA: ["QATAR"], IN: ["INDIA"], OM: ["OMAN"], SA: ["SAUDI ARABIA"], KW: ["KUWAIT"],
  BH: ["BAHRAIN"], GB: ["UNITED KINGDOM"], FR: ["FRANCE"], SG: ["SINGAPORE"], TH: ["THAILAND"], MY: ["MALAYSIA"],
  JP: ["JAPAN"], US: ["UNITED STATES", "UNITED STATES OF AMERICA"], AU: ["AUSTRALIA"],
};

const CITY_ALIASES: Record<string, string[]> = {
  "NEW DELHI": ["NEW DELHI", "DELHI"], KOZHIKODE: ["KOZHIKODE", "CALICUT"], BENGALURU: ["BENGALURU", "BANGALORE"],
  TRIVANDRUM: ["THIRUVANANTHAPURAM", "TRIVANDRUM"], KOCHI: ["KOCHI", "COCHIN"], MUMBAI: ["MUMBAI", "BOMBAY"],
  CHENNAI: ["CHENNAI", "MADRAS"], KOLKATA: ["KOLKATA", "CALCUTTA"], BAHRAIN: ["MANAMA"], "KUWAIT CITY": ["KUWAIT CITY", "KUWAIT"],
  GOA: ["GOA", "PANAJI", "CALANGUTE", "CANDOLIM", "BAGA", "MARGAO"], "NEW YORK": ["NEW YORK", "NEW YORK CITY"],
};

export function cityFromInput(input: { cityCode?: string; cityName?: string; countryCode?: string }) {
  const byCode = input.cityCode ? CITY_CODES[input.cityCode.toUpperCase()] : undefined;
  const city = (input.cityName || byCode?.city || input.cityCode || "").trim();
  return { city, country: (input.countryCode || byCode?.country || "").toUpperCase() };
}

export async function resolveRegionIds(env: Env, city: string, countryIso2: string): Promise<string[]> {
  const cacheKey = `hotel_v3:regions:${city.toUpperCase()}:${countryIso2}`;
  const cached = await env.FARE_CACHE_KV.get(cacheKey, "json").catch(() => null) as string[] | null;
  if (cached?.length) return cached;

  const obj = await env.DOCUMENTS_R2.get(CITY_INDEX_KEY);
  if (!obj) {
    throw Object.assign(new Error("The TripJack hotel city list has not been synced yet — run Admin → Integrations → Sync hotel cities"),
      { code: "CITY_INDEX_MISSING" });
  }
  const index = await obj.json() as CityIndex;
  const names = CITY_ALIASES[city.toUpperCase()] ?? [city.toUpperCase()];
  const countries = COUNTRY_NAMES[countryIso2] ?? [];
  const matches = names.flatMap((n) => index.cities[n] ?? []);
  const inCountry = countries.length ? matches.filter(([, c]) => countries.includes(c)) : matches;
  const ids = [...new Set((inCountry.length ? inCountry : matches).map(([id]) => String(id)))];
  if (!ids.length) {
    throw Object.assign(new Error(`TripJack has no hotel region for "${city}"${countryIso2 ? ` (${countryIso2})` : ""}`), { code: "CITY_NOT_FOUND" });
  }
  await env.FARE_CACHE_KV.put(cacheKey, JSON.stringify(ids), { expirationTtl: 30 * 86400 }).catch(() => {});
  return ids;
}

export async function hotelIdsForRegions(env: Env, client: TripjackHotelV3Client, regionIds: string[]): Promise<string[]> {
  const cacheKey = `hotel_v3:hids:${regionIds.slice().sort().join(",")}`;
  const cached = await env.FARE_CACHE_KV.get(cacheKey, "json").catch(() => null) as string[] | null;
  if (cached) return cached;
  const res = await client.hotelMapping({ regionIds, page: 0, size: 2000 });
  const hids = (res.hotels ?? []).map((h) => String(h.tjHotelId)).filter(Boolean);
  await env.FARE_CACHE_KV.put(cacheKey, JSON.stringify(hids), { expirationTtl: 86400 }).catch(() => {});
  return hids;
}

// Static content (images, stars, address) — cached per hotel for 7 days.
export async function hotelContent(env: Env, client: TripjackHotelV3Client, hids: string[]): Promise<Record<string, HotelV3Content>> {
  const out: Record<string, HotelV3Content> = {};
  const cached = await Promise.all(hids.map((h) => env.FARE_CACHE_KV.get(`hotel_v3:content:${h}`, "json").catch(() => null)));
  const missing: string[] = [];
  hids.forEach((h, i) => { if (cached[i]) out[h] = cached[i] as HotelV3Content; else missing.push(h); });
  for (let i = 0; i < missing.length; i += 100) {
    try {
      const res = await client.hotelContent(missing.slice(i, i + 100));
      for (const raw of res.hotels ?? []) {
        const c = normalizeContent(raw);
        if (!c.tjHotelId) continue;
        out[c.tjHotelId] = c;
        await env.FARE_CACHE_KV.put(`hotel_v3:content:${c.tjHotelId}`, JSON.stringify(c), { expirationTtl: 7 * 86400 }).catch(() => {});
      }
    } catch (err) {
      console.error("[hotels] static content failed", err);   // listing still works without images
    }
  }
  return out;
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface HotelSearchInput {
  cityCode?:    string;
  cityName?:    string;
  countryCode?: string;
  hids?:        string[];
  checkIn:      string;
  checkOut:     string;
  rooms:        HotelV3Room[];
  nationality:  string;   // ISO2 or TripJack countryId
  currency:     string;
}

export const SEARCH_TTL_MS = 14 * 60 * 1000;   // TripJack searchId lives ~15 minutes
const LISTING_BATCH = 100;
const MAX_LISTING_BATCHES = 3;

export function nightsBetween(checkIn: string, checkOut: string) {
  return Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000));
}

export function cheapest(options: HotelV3Option[]) {
  return options.slice().sort((a, b) => a.pricing.totalPrice - b.pricing.totalPrice)[0];
}

export async function searchHotels(env: Env, client: TripjackHotelV3Client, input: HotelSearchInput) {
  const correlationId = crypto.randomUUID().replace(/-/g, "");
  const { city, country } = cityFromInput(input);
  const hids = input.hids?.length
    ? input.hids
    : await hotelIdsForRegions(env, client, await resolveRegionIds(env, city, country));
  if (!hids.length) return { correlationId, hotels: [], totalCandidates: 0, city };

  const nationality = await nationalityId(env, client, input.nationality);
  const batches: string[][] = [];
  for (let i = 0; i < hids.length && batches.length < MAX_LISTING_BATCHES; i += LISTING_BATCH) batches.push(hids.slice(i, i + LISTING_BATCH));

  const settled = await Promise.allSettled(batches.map((batch) => client.listing({
    checkIn: input.checkIn, checkOut: input.checkOut, rooms: input.rooms, currency: input.currency,
    correlationId, nationality, hids: batch, timeoutMs: 13000,
  })));
  const listed = settled.flatMap((r) => r.status === "fulfilled" ? r.value.hotels ?? [] : []);
  if (!listed.length) {
    const firstError = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (firstError) throw firstError.reason;
  }

  const withOptions = listed.filter((h) => validHotelId(h.hotelId) && Array.isArray(h.options) && h.options.length);
  const content = await hotelContent(env, client, withOptions.map((h) => h.hotelId));
  const nights = nightsBetween(input.checkIn, input.checkOut);

  const hotels = withOptions.map((h) => {
    const hid = h.hotelId;
    const options = h.options.map(normalizeOption);
    const best = cheapest(options);
    const info = content[hid];
    return {
      id:           best.optionId,
      hid,
      hotelCode:    hid,
      correlationId,
      name:         info?.name || h.name,
      starRating:   info?.starRating ?? 0,
      address:      info?.address ?? "",
      countryCode:  (info?.countryCode || "").toUpperCase(),
      cityCode:     input.cityCode ?? city,
      checkIn:      input.checkIn,
      checkOut:     input.checkOut,
      nights,
      rooms:        input.rooms.length,
      roomType:     [...new Set(best.roomInfo.map((r) => r.name))].join(" / "),
      mealPlan:     best.mealBasis,
      isRefundable: best.cancellation.isRefundable,
      baseFare:     best.pricing.basePrice,
      taxes:        best.pricing.taxes + best.pricing.mf + best.pricing.mft,
      totalFare:    best.pricing.totalPrice,
      strikethrough: best.pricing.strikethrough,
      currency:     best.pricing.currency || input.currency,
      images:       info?.images ?? [],
      amenities:    info?.amenities ?? [],
      pricing:      best.pricing,
      compliance:   best.compliance,
      optionCount:  options.length,
    };
  }).sort((a, b) => a.totalFare - b.totalFare);

  return { correlationId, hotels, totalCandidates: hids.length, city, nationality };
}
