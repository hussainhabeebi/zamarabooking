// Akbar Travels (Benzy B2B Revamp) certification pack for one booking.
//
// Every Akbar call of the booking and of the search it came from, in the order made,
// numbered so polls and retries stay visible:
//
//   01-Signature-Request.json / 01-Signature-Response.json
//   02-ExpressSearch-Request.json / …
//   …  SmartPricer, GetSPricer, GetTravelCheckList, SSR, SeatLayout,
//      CreateItinerary, StartPay, GetItineraryStatus, RetrieveBooking
//   BookingSummary.json   steps covered, steps missing, Akbar's TransactionID / PNR / tickets
//
// Requests show Akbar's own URL (not our gateway), headers without the gateway key, and the
// Bearer token, Password, ApiKey and Key blanked. Responses are the bytes Akbar returned
// (the Signature token was already blanked when the call was recorded).
// Only real recorded calls are packed; nothing is generated.

import { bookingPassengers, supplierExchanges, type bookings } from "@zamrabooking/db/schema";
import { and, asc, desc, eq, gte, lte, or } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { getAkbarSettings } from "./flight-sources.js";
import type { PackFile } from "./certification.js";

type Booking = typeof bookings.$inferSelect;
type Db = Variables["db"];
type Exchange = typeof supplierExchanges.$inferSelect;

const enc = new TextEncoder();

// Akbar's certification order (WebSettings: {UtilsURL}/Utils/WebSettings, after ExpressSearch).
export const AKBAR_STEPS = [
  "Signature", "ExpressSearch", "GetExpSearch", "WebSettings", "SmartPricer", "GetSPricer", "GetTravelCheckList",
  "FareRule", "FlightInfo", "SeatLayout", "SSR", "CreateItinerary", "StartPay", "GetItineraryStatus", "RetrieveBooking", "Cancel",
] as const;
// Akbar's 13 certification steps.
export const AKBAR_REQUIRED_STEPS = ["Signature", "ExpressSearch", "GetExpSearch", "WebSettings", "SmartPricer", "GetSPricer", "GetTravelCheckList", "SeatLayout", "SSR", "CreateItinerary", "StartPay", "GetItineraryStatus", "RetrieveBooking"];

const BY_LOWER = new Map(AKBAR_STEPS.map((s) => [s.toLowerCase(), s]));
export function akbarStep(endpoint: string): string {
  const last = endpoint.split("/").filter(Boolean).pop() ?? "Call";
  return BY_LOWER.get(last.toLowerCase()) ?? last;
}

const SECRET_KEYS = new Set(["Password", "ApiKey", "Key", "Token", "token"]);
const blank = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (k, x) => (SECRET_KEYS.has(k) && typeof x === "string" && x ? "••••" : x)));

// Gateway URL → Akbar URL: …/utils/<path> → utilsUrl<path>, …/flights/<path> → flightsUrl<path>.
export function akbarUrl(stored: string, hosts: { utilsUrl: string; flightsUrl: string }) {
  let path = "";
  try { path = new URL(stored).pathname; } catch { return stored; }
  const gw = path.match(/^\/(utils|flights)(\/(?:Utils|flights|Flights|Payment)\/.+)$/);
  if (gw) return `${(gw[1] === "utils" ? hosts.utilsUrl : hosts.flightsUrl).replace(/\/+$/, "")}${gw[2]}`;
  return stored;
}

export function akbarCertificationRequest(stored: Record<string, any>, hosts: { utilsUrl: string; flightsUrl: string }) {
  const headers = Object.fromEntries(Object.entries((stored?.headers ?? {}) as Record<string, string>)
    .filter(([k]) => k.toLowerCase() !== "x-zamra-gateway-key")
    .map(([k, v]) => [k, k.toLowerCase() === "authorization" && v ? "Bearer ••••" : v]));
  return { url: akbarUrl(String(stored?.url ?? ""), hosts), method: stored?.method ?? "POST", headers, body: blank(stored?.body), sentAt: stored?.sentAt };
}

async function exchangesFor(db: Db, b: Booking): Promise<Exchange[]> {
  const searchId = (b.flightData as Record<string, unknown> | null)?.searchId;
  const rows = await db.select().from(supplierExchanges).where(and(
    eq(supplierExchanges.supplier, "AKBAR"),
    typeof searchId === "string" ? or(eq(supplierExchanges.bookingId, b.id), eq(supplierExchanges.searchId, searchId))! : eq(supplierExchanges.bookingId, b.id),
  )).orderBy(asc(supplierExchanges.startedAt));
  if (!rows.some((x) => akbarStep(x.endpoint) === "Signature")) {
    // The 48-hour token is cached, so the Signature call that issued it is usually an earlier
    // one: the tenant's latest Signature before the first call of this booking.
    const firstAt = rows[0]?.startedAt ?? b.createdAt;
    const [sig] = await db.select().from(supplierExchanges).where(and(
      eq(supplierExchanges.tenantId, b.tenantId), eq(supplierExchanges.supplier, "AKBAR"), eq(supplierExchanges.endpoint, "/Utils/Signature"),
      gte(supplierExchanges.startedAt, new Date(firstAt.getTime() - 48 * 3600_000)), lte(supplierExchanges.startedAt, firstAt),
    )).orderBy(desc(supplierExchanges.startedAt)).limit(1);
    if (sig) rows.unshift(sig);
  }
  return rows;
}

// SeatLayout and SSR are read-only lookups made only on UAT, for Akbar's certification logs
// (akbar-booking-runner: lookups = environment === "UAT"). A PRODUCTION booking never calls them.
export const AKBAR_UAT_ONLY_STEPS = ["SeatLayout", "SSR"];

// The Akbar environment a booking ran on, from its event log
// ("Akbar API booking started (after payment, PRODUCTION, 1 leg)"). null = not recorded.
export function akbarBookingEnvironment(events: { message?: string }[] | null | undefined): "UAT" | "PRODUCTION" | null {
  for (const e of events ?? []) {
    const m = /Akbar API booking started \([^)]*\b(UAT|PRODUCTION)\b/.exec(String(e?.message ?? ""));
    if (m) return m[1] as "UAT" | "PRODUCTION";
  }
  return null;
}

// Which certification steps this booking's logs contain. On PRODUCTION, a UAT-only step that
// wasn't called is "notUsed" (shown greyed out in Admin), not missing.
export function akbarCoverageOf(have: Set<string>, environment: "UAT" | "PRODUCTION" | null) {
  return AKBAR_REQUIRED_STEPS.map((service) => {
    const logged = have.has(service);
    return { service, logged, ...(!logged && environment === "PRODUCTION" && AKBAR_UAT_ONLY_STEPS.includes(service) ? { notUsed: true } : {}) };
  });
}

export async function akbarCertificationCoverage(db: Db, b: Booking, environment: "UAT" | "PRODUCTION" | null = null) {
  const have = new Set((await exchangesFor(db, b)).filter((x) => x.requestKey && x.responseKey).map((x) => akbarStep(x.endpoint)));
  return akbarCoverageOf(have, environment);
}

// Search TUI of a leg, from the fare reference saved at checkout.
function searchTuiOf(fd: Record<string, any>, leg: number): string | null {
  const off = fd?.offline ?? {};
  const ref = Array.isArray(off.legs) && off.legs.length ? off.legs[leg]?.sourceRef : leg === 0 ? off.sourceRef : null;
  return typeof ref?.tui === "string" && ref.tui ? ref.tui : null;
}

export async function akbarCertificationPack(env: Env, db: Db, b: Booking, folder = ""): Promise<PackFile[]> {
  const settings = await getAkbarSettings(env, b.tenantId);
  const all = await exchangesFor(db, b);
  const files: PackFile[] = [];
  const width = String(all.length).length < 2 ? 2 : String(all.length).length;
  for (const [i, x] of all.entries()) {
    const step = akbarStep(x.endpoint);
    const n = String(i + 1).padStart(width, "0");
    const req = x.requestKey ? await env.DOCUMENTS_R2.get(x.requestKey) : null;
    if (req) {
      let stored: Record<string, any> = {};
      try { stored = JSON.parse(await req.text()); } catch { /* keep empty */ }
      files.push({ name: `${folder}${n}-${step}-Request.json`, data: enc.encode(JSON.stringify(akbarCertificationRequest(stored, settings), null, 2)), date: x.startedAt });
    }
    const res = x.responseKey ? await env.DOCUMENTS_R2.get(x.responseKey) : null;
    if (res) files.push({ name: `${folder}${n}-${step}-Response.${x.responseKey!.endsWith(".txt") ? "txt" : "json"}`, data: new Uint8Array(await res.arrayBuffer()), date: x.startedAt });
    else if (x.error) files.push({ name: `${folder}${n}-${step}-Error.json`, data: enc.encode(JSON.stringify({ httpStatus: x.httpStatus, error: x.error }, null, 2)), date: x.startedAt });
  }

  const logged = new Set(all.filter((x) => x.requestKey && x.responseKey).map((x) => akbarStep(x.endpoint)));
  const missing = AKBAR_REQUIRED_STEPS.filter((s) => !logged.has(s));
  const pax = await db.select().from(bookingPassengers).where(eq(bookingPassengers.bookingId, b.id));
  const fd = (b.flightData ?? {}) as Record<string, any>;
  const state = fd.akbarBooking as { legs?: any[]; outcome?: string } | undefined;
  const summary = {
    supplier: "Akbar Travels (Benzy B2B Revamp Flight API)",
    environment: settings.environment,
    zamraBookingId: b.id,
    status: b.status,
    tripType: b.tripType,
    sector: `${b.origin}-${b.destination}`,
    departureDate: b.departureDate,
    passengers: pax.map((p) => `${p.firstName} ${p.lastName} (${p.passengerType})`),
    akbar: {
      outcome: state?.outcome ?? null,
      // Exactly as Akbar returned them; empty when Akbar returned none.
      searchId: typeof fd.searchId === "string" ? fd.searchId : null,
      legs: (state?.legs ?? []).map((l) => ({
        leg: l.leg + 1, state: l.state,
        searchTui: searchTuiOf(fd, l.leg), pricingTui: l.pricedTui ?? null, itineraryTui: l.itineraryTui ?? null,
        transactionId: l.transactionId ?? null, pnrs: l.pnrs ?? [], tickets: l.tickets ?? [],
        ...(l.errorCode ? { errorCode: l.errorCode, message: l.message } : {}),
      })),
    },
    steps: [...new Set(all.map((x) => akbarStep(x.endpoint)))],
    calls: all.length,
    ...(missing.length ? { missingSteps: missing, note: `Not in the logs yet: ${missing.join(", ")}` } : {}),
    notes: [
      "Secrets (Password, ApiKey, Key, Bearer token, gateway key) are blanked; responses are unmodified.",
    ],
    createdAt: b.createdAt,
  };
  return [{ name: `${folder}BookingSummary.json`, data: enc.encode(JSON.stringify(summary, null, 2)), date: b.createdAt }, ...files];
}
