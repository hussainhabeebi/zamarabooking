import { timingSafeEqual } from "node:crypto";

export const ROUTES = new Map([
  // Canonical Poomas v1 alias paths
  ["/v1/air/search", "/fms/v1/air-search-all"],
  ["/v1/air/fare-detail", "/fms/v2/farerule"],
  ["/v1/air/review", "/fms/v1/review"],
  ["/v1/air/book", "/oms/v1/air/book"],
  ["/v1/air/booking-detail", "/oms/v1/booking-details"],
  ["/v1/air/cancel", "/oms/v1/air/amendment/submit-amendment"],
  // TripJack native paths — forwarded 1:1 to the upstream
  ["/air-search-all/v2", "/fms/v1/air-search-all"],
  ["/fms/v1/review", "/fms/v1/review"],
  ["/fms/v2/farerule", "/fms/v2/farerule"],
  ["/oms/v1/air/book", "/oms/v1/air/book"],
  ["/oms/v1/booking-details", "/oms/v1/booking-details"],
  ["/oms/v1/air/amendment/submit-amendment", "/oms/v1/air/amendment/submit-amendment"],
  ["/oms/v1/air/amendment/amendment-charges", "/oms/v1/air/amendment/amendment-charges"],
  ["/oms/v1/air/amendment/amendment-details", "/oms/v1/air/amendment/amendment-details"],
  // Flights v2: seat map, fare validation, hold confirm / release.
  ["/fms/v1/seat", "/fms/v1/seat"],
  ["/oms/v1/air/book/fare-validate", "/oms/v1/air/book/fare-validate"],
  ["/oms/v1/air/fare-validate", "/oms/v1/air/fare-validate"],
  ["/oms/v1/air/confirm-book", "/oms/v1/air/confirm-book"],
  ["/oms/v1/air/unhold", "/oms/v1/air/unhold"],
  // Legacy paths kept for backwards compatibility
  ["/air-fare-detail/v2", "/fms/v2/farerule"],
  ["/air-book/v2", "/oms/v1/air/book"],
  ["/air-booking-detail/v2", "/oms/v1/booking-details"],
  ["/air-cancel/v2", "/oms/v1/air/amendment/submit-amendment"],
  // Hotel routes
  ["/hotel-search/v1", "/hotel-search/v1"],
  ["/hotel-prebook/v1", "/hotel-prebook/v1"],
  ["/hotel-book/v1", "/hotel-book/v1"],
  ["/hotel-booking-detail/v1", "/hotel-booking-detail/v1"],
  ["/hotel-cancel/v1", "/hotel-cancel/v1"],
]);

// TripJack Hotel API v3 lives on separate hosts: search / content on "hms"
// (apitest-hms / hms-search) and booking on "booker" (apitest-hotel-booker /
// hms-booker). Flight ROUTES above are unchanged and keep using `upstream`.
export const HOTEL_ROUTES = [
  { path: "/hms/v3/hotel/listing",                       upstream: "hms",    method: "POST" },
  { path: "/hms/v3/hotel/pricing",                       upstream: "hms",    method: "POST" },
  { path: "/hms/v3/hotel/review",                        upstream: "hms",    method: "POST" },
  { path: "/hms/v3/hotel/static-detail",                 upstream: "hms",    method: "POST" },
  { path: "/hms/v3/nationality-info",                    upstream: "hms",    method: "GET" },
  { path: "/hms/v3/content/fetch-hotel-mapping",         upstream: "hms",    method: "POST" },
  { path: "/hms/v3/content/fetch-hotel-content",         upstream: "hms",    method: "POST" },
  { path: "/hms/v3/content/fetch-countries",             upstream: "hms",    method: "GET" },
  { path: "/hms/v3/content/fetch-city-regionIds",        upstream: "hms",    method: "GET" },
  { path: "/hms/v3/content/fetch-hotel-mapping-sync",    upstream: "hms",    method: "POST" },
  { path: "/hms/v3/content/fetch-deleted-hotel-mapping", upstream: "hms",    method: "POST" },
  { path: "/oms/v3/hotel/book",                          upstream: "booker", method: "POST" },
  { path: "/oms/v3/hotel/confirm-book",                  upstream: "booker", method: "POST" },
  { path: "/oms/v3/hotel/booking-details",               upstream: "booker", method: "POST" },
  { path: "/oms/v1/hotel/bookings",                      upstream: "booker", method: "POST" },
  { path: "/oms/v3/hotel/cancel-booking/",               upstream: "booker", method: "POST", prefix: true },
  { path: "/ums/v1/user-detail",                         upstream: "main",   method: "GET" },
  // TripSafe (insurance) API v2 — TripJack main host.
  { path: "/insurance/v2/search",                        upstream: "main",   method: "POST" },
  { path: "/insurance/v2/booking",                       upstream: "main",   method: "POST" },
  { path: "/insurance/v2/booking/",                      upstream: "main",   method: "GET", prefix: true },
  { path: "/insurance/v2/amendment/raise",               upstream: "main",   method: "POST" },
  { path: "/insurance/v2/amendment/confirm",             upstream: "main",   method: "POST" },
  // UAT documents nationality-info on the flight host; keep it reachable there too.
  { path: "/tj-main/hms/v3/nationality-info", upstreamPath: "/hms/v3/nationality-info", upstream: "main", method: "GET" },
];

// Resolves an incoming gateway path to { upstreamPath, upstream, method }.
export function resolveRoute(pathname) {
  const flight = ROUTES.get(pathname);
  if (flight) return { upstreamPath: flight, upstream: "main", method: "POST" };
  for (const route of HOTEL_ROUTES) {
    if (route.prefix ? pathname.startsWith(route.path) && pathname.length > route.path.length
      && /^[A-Za-z0-9_-]+$/.test(pathname.slice(route.path.length)) : pathname === route.path) {
      return { upstreamPath: route.upstreamPath ?? pathname, upstream: route.upstream, method: route.method };
    }
  }
  return null;
}

function httpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url;
}

export function loadConfig(env = process.env) {
  const required = ["POOMAS_GATEWAY_KEY"];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

  const upstream = new URL(env.TRIPJACK_UPSTREAM ?? "https://apitest.tripjack.com");
  if (upstream.protocol !== "https:") throw new Error("TRIPJACK_UPSTREAM must use HTTPS");

  return {
    port: Number(env.PORT ?? 3000),
    upstream,
    hmsUpstream: httpsUrl(env.TRIPJACK_HMS_UPSTREAM ?? "https://apitest-hms.tripjack.com", "TRIPJACK_HMS_UPSTREAM"),
    hotelBookerUpstream: httpsUrl(env.TRIPJACK_HOTEL_BOOKER_UPSTREAM ?? "https://apitest-hotel-booker.tripjack.com", "TRIPJACK_HOTEL_BOOKER_UPSTREAM"),
    // Optional fallback for self-hosted callers. Cloudflare normally supplies
    // the TripJack key per request after authenticating to this gateway.
    tripjackApiKey: env.TRIPJACK_API_KEY ?? "",
    gatewayKey: env.POOMAS_GATEWAY_KEY,
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 45000),
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 2_097_152),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
    circuitFailureThreshold: Number(env.CIRCUIT_FAILURE_THRESHOLD ?? 5),
    circuitResetMs: Number(env.CIRCUIT_RESET_MS ?? 30000),
  };
}

export function secretsEqual(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function upstreamUrl(upstream, pathname, search = "") {
  const url = new URL(pathname, `${upstream.origin}/`);
  if (search) url.search = search;
  return url.toString();
}

export function upstreamFor(config, name) {
  return name === "hms" ? config.hmsUpstream : name === "booker" ? config.hotelBookerUpstream : config.upstream;
}
