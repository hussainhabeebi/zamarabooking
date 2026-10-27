import { timingSafeEqual } from "node:crypto";

// Akbar Travels (Benzy B2B) calls the Worker may send, by gateway prefix.
//   /utils/<path>   → AKBAR_UTILS_UPSTREAM   (Signature)
//   /flights/<path> → AKBAR_FLIGHTS_UPSTREAM (search, pricing, booking, utils on the flights host)
export const ROUTES = {
  utils: new Set(["/Utils/Signature"]),
  flights: new Set([
    "/flights/ExpressSearch",
    "/flights/GetExpSearch",
    "/flights/SmartPricer",
    "/flights/GetSPricer",
    "/Flights/FlightInfo",
    "/flights/FareRule",
    "/flights/ssr",
    "/flights/SeatLayout",
    "/flights/CreateItinerary",
    "/flights/cancel",
    "/Payment/StartPay",
    "/Payment/GetItineraryStatus",
    "/Utils/RetrieveBooking",
    "/Utils/GetTravelCheckList",
  ]),
};

// "/flights/flights/ExpressSearch" → { upstream: "flights", upstreamPath: "/flights/ExpressSearch" }
export function resolveRoute(pathname) {
  const match = pathname.match(/^\/(utils|flights)(\/.+)$/);
  if (!match) return null;
  const [, upstream, upstreamPath] = match;
  return ROUTES[upstream].has(upstreamPath) ? { upstream, upstreamPath } : null;
}

function httpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url;
}

export function loadConfig(env = process.env) {
  if (!env.ZAMRA_GATEWAY_KEY) throw new Error("Missing required environment variables: ZAMRA_GATEWAY_KEY");
  return {
    port: Number(env.PORT ?? 3000),
    // Test hosts by default; set Akbar's live hosts in Coolify for production.
    utilsUpstream: httpsUrl(env.AKBAR_UTILS_UPSTREAM ?? "https://b2bapiutils.benzyinfotech.com", "AKBAR_UTILS_UPSTREAM"),
    flightsUpstream: httpsUrl(env.AKBAR_FLIGHTS_UPSTREAM ?? "https://b2bapiflights.benzyinfotech.com", "AKBAR_FLIGHTS_UPSTREAM"),
    gatewayKey: env.ZAMRA_GATEWAY_KEY,
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 55000),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 2_097_152),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 300),
  };
}

export function secretsEqual(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function upstreamUrl(config, route) {
  const base = route.upstream === "utils" ? config.utilsUpstream : config.flightsUpstream;
  return new URL(route.upstreamPath, `${base.origin}/`).toString();
}
