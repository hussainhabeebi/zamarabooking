// Recent flight searches (last 4), shown under the search form with "Search again".
//   Signed in: kept with the account (/api/profile/recent-searches). A guest's searches made in this
//              browser are moved to the account the first time the customer is signed in.
//   Guest:     kept in this browser (localStorage).
// A search is recorded when its results page opens; "Search again" runs a new live search.

import { API, readCustomerToken } from "./customer-api";
import { readPrefCurrency } from "./currency-pref";

export type TripTypeParam = "ONEWAY" | "ROUNDTRIP" | "MULTICITY";
export interface RecentLeg { origin: string; destination: string; departureDate: string }
export interface RecentSearch {
  tripType: TripTypeParam;
  origin: string; destination: string; departureDate: string;
  returnDate?: string;
  legs?: RecentLeg[];
  adults: number; children: number; infants: number;
  cabinClass: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  fareType?: "STUDENT" | "SENIOR_CITIZEN";
  searchedAt: string;
}

export const RECENT_SEARCH_LIMIT = 4;
export const RECENT_SEARCHES_EVENT = "zamrabooking:recent-searches";
const LOCAL_KEY = "zamra_recent_searches";
const CABINS = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"] as const;
const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const int = (v: string | null | undefined, fallback: number) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : fallback; };

export const recentSearchKey = (s: RecentSearch) => JSON.stringify([
  s.tripType, s.origin, s.destination, s.departureDate, s.returnDate ?? "",
  (s.legs ?? []).map((l) => `${l.origin}-${l.destination}-${l.departureDate}`), s.adults, s.children, s.infants, s.cabinClass, s.fareType ?? "",
]);

// New first (the newest copy of a repeated search wins), then the older ones; the last 4 are kept.
export function mergeRecentSearches(added: RecentSearch[], saved: RecentSearch[]): RecentSearch[] {
  const out: RecentSearch[] = [];
  const seen = new Set<string>();
  for (const s of [...[...added].sort((a, b) => b.searchedAt.localeCompare(a.searchedAt)), ...saved]) {
    const k = recentSearchKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= RECENT_SEARCH_LIMIT) break;
  }
  return out;
}

// A results page URL → the search it ran (null when the URL isn't a complete flight search).
export function searchFromParams(q: URLSearchParams, now = new Date()): RecentSearch | null {
  const up = (k: string) => (q.get(k) ?? "").trim().toUpperCase();
  const tripType: TripTypeParam = up("tripType") === "MULTICITY" ? "MULTICITY" : up("tripType") === "ROUNDTRIP" ? "ROUNDTRIP" : "ONEWAY";
  const legs = tripType === "MULTICITY"
    ? (q.get("legs") ?? "").split(",").map((l) => /^([A-Z]{3})-([A-Z]{3})-(\d{4}-\d{2}-\d{2})$/.exec(l.trim().toUpperCase()))
      .filter((m): m is RegExpExecArray => !!m).map((m) => ({ origin: m[1], destination: m[2], departureDate: m[3] }))
    : undefined;
  if (tripType === "MULTICITY" && (!legs || legs.length < 2 || legs.length > 6)) return null;
  const origin = legs ? legs[0].origin : up("origin");
  const destination = legs ? legs[legs.length - 1].destination : up("destination");
  const departureDate = legs ? legs[0].departureDate : (q.get("departureDate") ?? "");
  const returnDate = tripType === "ROUNDTRIP" ? q.get("returnDate") ?? "" : "";
  if (!IATA.test(origin) || !IATA.test(destination) || !DAY.test(departureDate)) return null;
  if (tripType === "ROUNDTRIP" && !DAY.test(returnDate)) return null;
  const adults = Math.min(9, Math.max(1, int(q.get("adults"), 1)));
  const children = Math.min(9, Math.max(0, int(q.get("children"), 0)));
  const infants = Math.min(4, Math.max(0, int(q.get("infants"), 0)));
  const cabin = up("cabinClass");
  const fare = up("fareType");
  return {
    tripType, origin, destination, departureDate,
    ...(tripType === "ROUNDTRIP" ? { returnDate } : {}),
    ...(legs ? { legs } : {}),
    adults, children, infants,
    cabinClass: (CABINS as readonly string[]).includes(cabin) ? cabin as RecentSearch["cabinClass"] : "ECONOMY",
    ...(fare === "STUDENT" || fare === "SENIOR_CITIZEN" ? { fareType: fare } : {}),
    searchedAt: now.toISOString(),
  };
}

// The results page for a search, in the same form the search form builds it.
export function searchUrl(s: RecentSearch, currency = readPrefCurrency() ?? "INR"): string {
  const params = new URLSearchParams({
    origin: s.origin, destination: s.destination, departureDate: s.departureDate,
    adults: String(s.adults), children: String(s.children), infants: String(s.infants),
    cabinClass: s.cabinClass, tripType: s.tripType, currency,
    ...(s.fareType ? { fareType: s.fareType } : {}),
    ...(s.tripType === "ROUNDTRIP" && s.returnDate ? { returnDate: s.returnDate } : {}),
    ...(s.tripType === "MULTICITY" && s.legs ? { legs: s.legs.map((l) => `${l.origin}-${l.destination}-${l.departureDate}`).join(",") } : {}),
  });
  return `${s.tripType === "ONEWAY" ? "/search" : "/search/journey"}?${params.toString()}`;
}

// A date in the past can't be searched again as it was.
export const searchDatePassed = (s: RecentSearch, today = new Date().toISOString().slice(0, 10)) => s.departureDate < today;

function valid(s: any): s is RecentSearch {
  return s && typeof s === "object" && IATA.test(s.origin) && IATA.test(s.destination) && DAY.test(s.departureDate)
    && ["ONEWAY", "ROUNDTRIP", "MULTICITY"].includes(s.tripType) && Number.isInteger(s.adults) && typeof s.searchedAt === "string";
}

function readLocal(): RecentSearch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(valid).slice(0, RECENT_SEARCH_LIMIT) : [];
  } catch { return []; }
}
function writeLocal(list: RecentSearch[]) {
  try { list.length ? localStorage.setItem(LOCAL_KEY, JSON.stringify(list)) : localStorage.removeItem(LOCAL_KEY); } catch {}
}
const changed = () => { try { window.dispatchEvent(new Event(RECENT_SEARCHES_EVENT)); } catch {} };

async function account(method: "GET" | "POST" | "DELETE", token: string, body?: unknown): Promise<RecentSearch[] | null> {
  try {
    const res = await fetch(`${API}/api/profile/recent-searches`, {
      method, cache: "no-store",
      headers: { "Content-Type": "application/json", "x-tenant-slug": "zamra", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) return null;
    const d = await res.json() as { searches?: unknown };
    return Array.isArray(d.searches) ? d.searches.filter(valid) : [];
  } catch { return null; }
}

// Newest first. Signed in: the account's list (this browser's guest searches are moved onto it).
export async function loadRecentSearches(): Promise<RecentSearch[]> {
  const token = readCustomerToken();
  if (!token) return readLocal();
  const local = readLocal();
  const list = local.length ? await account("POST", token, { searches: local }) : await account("GET", token);
  if (list === null) return local;          // account not reachable (or not a customer login): keep the browser's
  if (local.length) writeLocal([]);
  return list;
}

export async function recordRecentSearch(s: RecentSearch): Promise<void> {
  const token = readCustomerToken();
  if (!token || (await account("POST", token, { searches: [s] })) === null) {
    writeLocal(mergeRecentSearches([s], readLocal()));
  }
  changed();
}

export async function clearRecentSearches(): Promise<void> {
  const token = readCustomerToken();
  writeLocal([]);
  if (token) await account("DELETE", token);
  changed();
}

// "COK → DOH", "COK ⇄ DOH", "COK → BOM → DEL"
export function routeLabel(s: RecentSearch): string {
  if (s.tripType === "MULTICITY" && s.legs?.length) return [s.legs[0].origin, ...s.legs.map((l) => l.destination)].join(" → ");
  return `${s.origin} ${s.tripType === "ROUNDTRIP" ? "⇄" : "→"} ${s.destination}`;
}
export function paxLabel(s: RecentSearch): string {
  const n = s.adults + s.children + s.infants;
  return `${n} traveller${n === 1 ? "" : "s"}`;
}
export const tripLabel = (s: RecentSearch) => s.tripType === "ROUNDTRIP" ? "Round trip" : s.tripType === "MULTICITY" ? `Multi-city · ${s.legs?.length ?? 2} flights` : "One way";
export function dateLabel(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : d;
}
