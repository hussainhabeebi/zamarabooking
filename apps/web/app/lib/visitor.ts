// Customer search tracking (Phase 1, docs/search-analytics.md) — the website side.
//
//   zb_vid  a random id for this browser (12 months). Not linked to a name, email or phone; the API
//           stores only a keyed hash of it. Not set when the browser sends Global Privacy Control or
//           Do Not Track, and never for bots.
//   zb_vd   the India day of this browser's last visit record (one visit record per day).
//
// The API records nothing unless Admin → Analytics → "Search tracking" is on.

export const VISITOR_COOKIE = "zb_vid";
export const VISIT_DAY_COOKIE = "zb_vd";
export const VISITOR_MAX_AGE = 60 * 60 * 24 * 365;

type Get = (name: string) => string | null | undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** The browser asked not to be tracked (Global Privacy Control / Do Not Track). */
export const optedOut = (get: Get) => get("sec-gpc") === "1" || get("dnt") === "1";

// Same lists as apps/api/src/lib/search-analytics.ts.
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|bingpreview|facebookexternalhit|facebot|whatsapp|telegrambot|skypeuripreview|embedly|preview|headless|lighthouse|pagespeed|python-|curl\/|wget|httpclient|go-http|java\/|okhttp|axios|node-fetch|uptime|monitor|pingdom|semrush|ahrefs|mj12/i;
export const isBot = (ua: string | null | undefined) => !ua || BOT_RE.test(ua);
export function deviceClass(ua: string | null | undefined): "mobile" | "tablet" | "desktop" | null {
  if (!ua) return null;
  if (/iPad|Tablet|Kindle|Silk|PlayBook|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/i.test(ua)) return "mobile";
  return "desktop";
}

/** A Next.js prefetch (link hover / router.prefetch), not a page the visitor opened. */
export const isPrefetch = (get: Get) =>
  get("next-router-prefetch") === "1" || /prefetch/i.test(`${get("purpose") ?? ""} ${get("sec-purpose") ?? ""} ${get("x-purpose") ?? ""}`);

/** Calendar day in India time. */
export const istDay = (at: Date = new Date()) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * What the website adds to an API request made for a visitor's page, as the JSON body field
 * `tracking` (the API's routes ignore it; only the analytics code reads it). A body field, not
 * headers, so the website keeps working whether or not the API with tracking is live yet.
 * The customer's login goes here as `customer` — never in Authorization, so search prices and
 * agency pricing can't change because of it.
 */
export type Tracking = { client: "web"; visitor?: string; customer?: string; device?: string; country?: string; bot?: true; prefetch?: true };

export function serverTracking(get: Get, cookie: Get): Tracking {
  const ua = get("user-agent");
  const t: Tracking = { client: "web", device: deviceClass(ua) ?? "desktop" };
  if (isBot(ua)) t.bot = true;
  if (isPrefetch(get)) t.prefetch = true;
  const country = get("cf-ipcountry");
  if (country && /^[A-Za-z]{2}$/.test(country)) t.country = country.toUpperCase();
  const visitor = cookie(VISITOR_COOKIE);
  if (!optedOut(get) && isUuid(visitor)) t.visitor = visitor;
  const token = cookie("zamra_token");
  if (token) t.customer = decodeURIComponent(token);
  return t;
}

/** The same, for requests the browser makes itself (journey results, booking page). */
export function browserTracking(): Tracking {
  const t: Tracking = { client: "web" };
  try {
    const read = (name: string) => document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
    const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true || navigator.doNotTrack === "1";
    const visitor = read(VISITOR_COOKIE);
    if (!gpc && isUuid(visitor)) t.visitor = visitor;
    const token = read("zamra_token");
    if (token) t.customer = decodeURIComponent(token);
  } catch { /* no document: nothing to add */ }
  return t;
}
