import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { VISITOR_COOKIE, VISITOR_MAX_AGE, VISIT_DAY_COOKIE, isBot, isPrefetch, isUuid, istDay, optedOut, serverTracking } from "./app/lib/visitor";

export function middleware(request: NextRequest, event?: NextFetchEvent) {
  const host = request.headers.get("host") ?? "";
  const slug = extractTenantSlug(host);
  const get = (n: string) => request.headers.get(n);

  // First visit: pick the display currency from the visitor's country (Cloudflare
  // geo header). A currency the visitor or their account chose is never replaced.
  const geoCurrency = request.cookies.get("fp_cur") ? null : currencyForCountry(request.headers.get("cf-ipcountry"));
  if (geoCurrency) request.cookies.set("fp_cur", geoCurrency);   // so this very render uses it

  // Search tracking (app/lib/visitor.ts): a random browser id, so this very render's search can use it.
  // None for bots or browsers that ask not to be tracked.
  const track = !optedOut(get) && !isBot(get("user-agent"));
  const newVisitor = track && !isUuid(request.cookies.get(VISITOR_COOKIE)?.value) ? crypto.randomUUID() : null;
  if (newVisitor) request.cookies.set(VISITOR_COOKIE, newVisitor);

  const res = geoCurrency || newVisitor ? NextResponse.next({ request: { headers: request.headers } }) : NextResponse.next();
  if (geoCurrency) {
    res.cookies.set("fp_cur", geoCurrency, { maxAge: 60 * 60 * 24 * 365, sameSite: "lax", path: "/" });
  }
  if (newVisitor) {
    res.cookies.set(VISITOR_COOKIE, newVisitor, { maxAge: VISITOR_MAX_AGE, sameSite: "lax", secure: true, path: "/" });
  }
  res.headers.set("x-tenant-slug", slug);
  res.headers.set("x-tenant-host", host);

  // Set a stable session cookie for SERP trial tracking
  if (!request.cookies.get("sid")) {
    res.cookies.set("sid", crypto.randomUUID(), {
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  }

  // One visit record per browser per India day (the API ignores it while tracking is off).
  const today = istDay();
  if (track && event && request.method === "GET" && !isPrefetch(get) && (get("accept") ?? "").includes("text/html")
      && request.cookies.get(VISIT_DAY_COOKIE)?.value !== today) {
    res.cookies.set(VISIT_DAY_COOKIE, today, { maxAge: 60 * 60 * 48, sameSite: "lax", secure: true, path: "/" });
    const api = process.env.NEXT_PUBLIC_API_URL ?? "https://api.zamrabooking.com";
    const tracking = serverTracking(get, (n) => request.cookies.get(n)?.value);
    try {
      event.waitUntil(fetch(`${api}/api/analytics/visit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug, "User-Agent": "zamra-web" },
        body: JSON.stringify({ path: request.nextUrl.pathname, tracking }),
        signal: AbortSignal.timeout(5_000),
      }).then(() => undefined, () => undefined));
    } catch { /* never affects the page */ }
  }

  return res;
}

const COUNTRY_CURRENCY: Record<string, string> = {
  IN: "INR", AE: "AED", SA: "SAR", QA: "QAR", OM: "OMR", KW: "KWD", BH: "BHD",
};

// Unknown / Tor / missing country → no cookie (the site default, INR, applies).
function currencyForCountry(country: string | null): string | null {
  const cc = (country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === "XX" || cc === "T1") return null;
  return COUNTRY_CURRENCY[cc] ?? "USD";
}

function extractTenantSlug(host: string): string {
  if (host.endsWith(".zamrabooking.com")) {
    return host.split(".")[0];
  }
  if (host === "zamrabooking.com" || host === "www.zamrabooking.com") {
    return "zamra";
  }
  return host;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
