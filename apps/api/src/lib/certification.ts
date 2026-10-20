// TripJack UAT certification pack for one booking.
//
// TripJack log rules: JSON for every request / response, a separate file for
// each, the API key included, response logs unmodified, real passenger names.
// File names follow TripJack's sample set:
//
//   SearchRequest.json         { url, method, headers: { apikey, Content-Type }, body }
//   SearchResponse.json        exactly the bytes TripJack returned
//   ReviewRequest.json / ReviewResponse.json
//   BookingRequest.json / BookingResponse.json
//   BookingDetailRequest.json / BookingDetailResponse.json
//   (+ SeatMap / FareRule / ConfirmBooking … when those services were used)
//   BookingSummary.json        which certification case this booking covers,
//                              and any required service that is missing
//
// Requests are shown as sent to TripJack: the Poomas gateway URL is replaced by
// TripJack's endpoint and our internal gateway secret is never included.

import { bookingPassengers, supplierExchanges, type bookings } from "@poomas/db/schema";
import { and, asc, desc, eq, gte, lte, or } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { passengerNameProblem } from "./passenger-names.js";

type Booking = typeof bookings.$inferSelect;
type Db = Variables["db"];
export type PackFile = { name: string; data: Uint8Array; date: Date };

const enc = new TextEncoder();

// Gateway alias paths → TripJack paths (mirrors apps/tripjack-gateway ROUTES).
const PATH_ALIASES: Record<string, string> = {
  "/air-search-all/v2": "/fms/v1/air-search-all",
  "/air-fare-detail/v2": "/fms/v2/farerule",
  "/air-book/v2": "/oms/v1/air/book",
  "/air-booking-detail/v2": "/oms/v1/booking-details",
  "/air-cancel/v2": "/oms/v1/air/amendment/submit-amendment",
  "/v1/air/search": "/fms/v1/air-search-all",
  "/v1/air/fare-detail": "/fms/v2/farerule",
  "/v1/air/review": "/fms/v1/review",
  "/v1/air/book": "/oms/v1/air/book",
  "/v1/air/booking-detail": "/oms/v1/booking-details",
  "/v1/air/cancel": "/oms/v1/air/amendment/submit-amendment",
};

// TripJack service name per path (file names: <Name>Request.json / <Name>Response.json).
const STEP_NAMES: Record<string, string> = {
  "/fms/v1/air-search-all": "Search",
  "/fms/v2/farerule": "FareRule",
  "/fms/v1/review": "Review",
  "/fms/v1/seat": "SeatMap",
  "/oms/v1/air/book/fare-validate": "FareValidate",
  "/oms/v1/air/fare-validate": "ConfirmFare",
  "/oms/v1/air/book": "Booking",
  "/oms/v1/air/confirm-book": "ConfirmBooking",
  "/oms/v1/booking-details": "BookingDetail",
  "/oms/v1/air/unhold": "ReleasePnr",
  "/oms/v1/air/amendment/amendment-charges": "AmendmentCharges",
  "/oms/v1/air/amendment/submit-amendment": "SubmitAmendment",
  "/oms/v1/air/amendment/amendment-details": "AmendmentDetail",
};

// Services every certified booking must show, in TripJack's order.
const REQUIRED_STEPS = ["Search", "Review", "Booking", "BookingDetail"];
const STEP_ORDER = ["Search", "FareRule", "Review", "SeatMap", "FareValidate", "Booking", "ConfirmFare", "ConfirmBooking", "BookingDetail", "ReleasePnr", "AmendmentCharges", "SubmitAmendment", "AmendmentDetail"];

const stepOf = (endpoint: string) => {
  const path = tripjackPath(endpoint);
  return STEP_NAMES[path] ?? path.replace(/^\//, "").split(/[^a-zA-Z0-9]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
};

export function tripjackHost(environment: "UAT" | "PRODUCTION") {
  return environment === "PRODUCTION" ? "https://tripjack.com" : "https://apitest.tripjack.com";
}

export function tripjackPath(endpoint: string) {
  return PATH_ALIASES[endpoint] ?? endpoint;
}

// The request as TripJack received it (the gateway forwards body + apikey unchanged).
export function certificationRequest(stored: Record<string, any>, host: string) {
  const headers = (stored?.headers ?? {}) as Record<string, string>;
  const apikey = headers.apikey ?? headers.apiKey ?? headers.APIKEY;
  const path = tripjackPath(new URL(String(stored?.url ?? "http://x/")).pathname);
  return {
    url: `${host}${path}`,
    method: stored?.method ?? "POST",
    headers: { ...(apikey ? { apikey } : {}), "Content-Type": "application/json" },
    body: stored?.body ?? null,
  };
}

function exchangeFilter(b: Booking) {
  const searchId = (b.flightData as Record<string, unknown> | null)?.searchId;
  return typeof searchId === "string"
    ? or(eq(supplierExchanges.bookingId, b.id), eq(supplierExchanges.searchId, searchId))
    : eq(supplierExchanges.bookingId, b.id);
}

export async function certificationSummary(db: Db, b: Booking) {
  const pax = await db.select().from(bookingPassengers).where(eq(bookingPassengers.bookingId, b.id));
  const fd = (b.flightData ?? {}) as Record<string, any>;
  const tj = (fd.tripjack ?? {}) as Record<string, any>;
  const segments = Array.isArray(tj.segments) ? tj.segments : [];
  const extras = Array.isArray(tj.pax) ? tj.pax : [];
  const counts = { ADULT: 0, CHILD: 0, INFANT: 0 } as Record<string, number>;
  for (const p of pax) counts[p.passengerType] = (counts[p.passengerType] ?? 0) + 1;
  const fareIdentifiers: string[] = Array.isArray(tj.fareIdentifiers) ? tj.fareIdentifiers : [];
  const nameProblems = pax.flatMap((p) => [passengerNameProblem(p.firstName, "First name"), passengerNameProblem(p.lastName, "Last name")]).filter(Boolean);
  return {
    poomasBookingId: b.id,
    tripjackBookingId: b.supplierBookingRef,
    pnr: b.pnr,
    ticketNumbers: b.ticketNumbers,
    status: b.status,
    tripType: b.tripType,
    sector: `${b.origin}-${b.destination}`,
    departureDate: b.departureDate,
    segments: segments.map((s: any) => `${s.origin}-${s.destination} ${s.airline ?? ""}${s.flightNumber ?? ""} ${s.departureTime ?? ""}`.trim()),
    flightType: segments.length ? (segments.length > (b.tripType === "ONEWAY" ? 1 : 2) ? "Connecting" : "Direct") : undefined,
    passengers: { adults: counts.ADULT, children: counts.CHILD, infants: counts.INFANT,
      names: pax.map((p) => `${p.firstName} ${p.lastName} (${p.passengerType})`) },
    namesAreReal: nameProblems.length === 0,
    ...(nameProblems.length ? { nameProblems } : {}),
    bookingTypes: {
      publishedFare: fareIdentifiers.includes("PUBLISHED") || !fareIdentifiers.length,
      specialReturn: fareIdentifiers.includes("SPECIAL_RETURN"),
      studentOrSeniorCitizen: fareIdentifiers.some((f) => f === "STUDENT" || f === "SENIOR_CITIZEN") || extras.some((x: any) => x.documentId),
      withPassport: pax.some((p) => p.passportNumber),
      withGst: Boolean(tj.gstInfo || b.gstNumber),
      withSsr: extras.some((x: any) => x.ssr?.baggage?.length || x.ssr?.meal?.length),
      withSeat: extras.some((x: any) => x.ssr?.seat?.length),
      ssrAmount: tj.ssrAmount ?? 0,
      ...(tj.seatAmount ? { seatAmount: tj.seatAmount } : {}),
    },
    fareIdentifiers,
    createdAt: b.createdAt,
  };
}

type Exchange = typeof supplierExchanges.$inferSelect;

// Bookings that reached checkout without the search reference: find the search
// whose response offered this booking's fare (within the 2 hours before it).
async function fallbackSearch(env: Env, db: Db, b: Booking): Promise<Exchange | null> {
  const fareIds: string[] = [
    ...(((b.flightData as any)?.tripjack?.priceIds ?? []) as string[]),
    (b.flightData as any)?.id,
  ].filter((x): x is string => typeof x === "string" && x.length > 3);
  if (!fareIds.length) return null;
  const candidates = await db.select().from(supplierExchanges).where(and(
    eq(supplierExchanges.tenantId, b.tenantId),
    or(eq(supplierExchanges.endpoint, "/air-search-all/v2"), eq(supplierExchanges.endpoint, "/fms/v1/air-search-all")),
    gte(supplierExchanges.startedAt, new Date(b.createdAt.getTime() - 2 * 3600_000)),
    lte(supplierExchanges.startedAt, b.createdAt),
  )).orderBy(desc(supplierExchanges.startedAt)).limit(25);
  for (const x of candidates) {
    if (!x.responseKey) continue;
    const text = await (await env.DOCUMENTS_R2.get(x.responseKey))?.text();
    if (text && fareIds.some((id) => text.includes(id))) return x;
  }
  return null;
}

// Builds the files for one booking (optionally under a folder): the final call
// of each TripJack service, named like TripJack's sample (SearchRequest.json …).
export async function certificationPack(env: Env, db: Db, b: Booking, environment: "UAT" | "PRODUCTION", folder = ""): Promise<PackFile[]> {
  const host = tripjackHost(environment);
  const all = await db.select().from(supplierExchanges).where(exchangeFilter(b)).orderBy(asc(supplierExchanges.startedAt));
  if (!all.some((x) => stepOf(x.endpoint) === "Search")) {
    const search = await fallbackSearch(env, db, b).catch(() => null);
    if (search) all.unshift(search);
  }
  // Keep the last call of each service: the review / booking TripJack actually
  // used, and the final booking-details poll (PNR / ticket status). Every call
  // stays available individually in Admin.
  const last = new Map<string, Exchange>();
  for (const x of all) if (x.requestKey) last.set(stepOf(x.endpoint), x);
  const steps = [...last.keys()].sort((a, c) => (STEP_ORDER.indexOf(a) + 1 || 99) - (STEP_ORDER.indexOf(c) + 1 || 99));
  const missing = REQUIRED_STEPS.filter((s) => !last.has(s) || !last.get(s)!.responseKey);

  const files: PackFile[] = [];
  for (const step of steps) {
    const x = last.get(step)!;
    const obj = await env.DOCUMENTS_R2.get(x.requestKey);
    if (obj) {
      let stored: Record<string, any> = {};
      try { stored = JSON.parse(await obj.text()); } catch { /* keep empty */ }
      files.push({ name: `${folder}${step}Request.json`, data: enc.encode(JSON.stringify(certificationRequest(stored, host), null, 2)), date: x.startedAt });
    }
    if (x.responseKey) {
      const res = await env.DOCUMENTS_R2.get(x.responseKey);
      // Unmodified: the exact bytes TripJack returned.
      if (res) files.push({ name: `${folder}${step}Response.${x.responseKey.endsWith(".txt") ? "txt" : "json"}`, data: new Uint8Array(await res.arrayBuffer()), date: x.startedAt });
    }
  }
  const summary = {
    ...await certificationSummary(db, b),
    services: steps,
    ...(missing.length ? { missingServices: missing, note: `Not in the logs yet: ${missing.join(", ")}` } : {}),
  };
  return [{ name: `${folder}BookingSummary.json`, data: enc.encode(JSON.stringify(summary, null, 2)), date: b.createdAt }, ...files];
}

// TripJack-style file name for one logged call, e.g. SearchRequest.json.
export function certificationFileName(endpoint: string, part: "request" | "response", storageKey: string) {
  return `${stepOf(endpoint)}${part === "request" ? "Request" : "Response"}.${storageKey.endsWith(".txt") ? "txt" : "json"}`;
}

// Which of TripJack's required services (Search, Review, Booking, BookingDetail)
// are in this booking's logs, with a request and a response.
export async function certificationCoverage(env: Env, db: Db, b: Booking, exchanges: Exchange[]) {
  const have = new Set(exchanges.filter((x) => x.requestKey && x.responseKey).map((x) => stepOf(x.endpoint)));
  if (!have.has("Search") && b.supplier === "TRIPJACK" && await fallbackSearch(env, db, b).catch(() => null)) have.add("Search");
  return REQUIRED_STEPS.map((service) => ({ service, logged: have.has(service) }));
}

// TripJack's certification folder layout:
//   oneway/DEL-BOM-1A-DIRECT/, oneway/BOM-SIN-2A-2C-CONNECTING/, roundtrip/…
// Passenger counts that are zero are left out.
export function tripFolderName(b: Booking) {
  return b.tripType === "ROUNDTRIP" ? "roundtrip" : b.tripType === "MULTICITY" ? "multicity" : "oneway";
}

export function caseName(b: Booking) {
  const clean = (v: string) => v.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  const fd = (b.flightData ?? {}) as Record<string, any>;
  const segments: any[] = Array.isArray(fd.tripjack?.segments) ? fd.tripjack.segments : Array.isArray(fd.segments) ? fd.segments : [];
  let connecting: boolean;
  if (segments.length) {
    if (b.tripType === "MULTICITY") {
      const legs = Array.isArray(fd.legs) ? fd.legs.length : Array.isArray(fd.tripjack?.priceIds) ? fd.tripjack.priceIds.length : 1;
      connecting = segments.length > Math.max(legs, 1);
    } else {
      const outbound = segments.filter((s) => !s?.isReturn).length;
      const inbound = segments.length - outbound;
      connecting = b.tripType === "ROUNDTRIP" && inbound === 0 ? segments.length > 2 : outbound > 1 || inbound > 1;
    }
  } else {
    connecting = Number(fd.stops ?? 0) > 0;
  }
  const pax = [[b.adultCount, "A"], [b.childCount, "C"], [b.infantCount, "I"]]
    .filter(([n]) => Number(n) > 0).map(([n, t]) => `${n}${t}`);
  return [clean(b.origin), clean(b.destination), ...pax, connecting ? "CONNECTING" : "DIRECT"].join("-");
}

// Folder for one booking in a multi-booking ZIP; a repeated case gets "-2", "-3" …
export function packFolderName(b: Booking, used: Map<string, number>) {
  const base = `${tripFolderName(b)}/${caseName(b)}`;
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return `${base}${n > 1 ? `-${n}` : ""}/`;
}
