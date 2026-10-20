import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const slug = extractTenantSlug(host);

  // First visit: pick the display currency from the visitor's country (Cloudflare
  // geo header). A currency the visitor or their account chose is never replaced.
  const geoCurrency = request.cookies.get("fp_cur") ? null : currencyForCountry(request.headers.get("cf-ipcountry"));
  if (geoCurrency) request.cookies.set("fp_cur", geoCurrency);   // so this very render uses it

  const res = geoCurrency ? NextResponse.next({ request: { headers: request.headers } }) : NextResponse.next();
  if (geoCurrency) {
    res.cookies.set("fp_cur", geoCurrency, { maxAge: 60 * 60 * 24 * 365, sameSite: "lax", path: "/" });
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
  if (host.endsWith(".flypoomas.com")) {
    return host.split(".")[0];
  }
  if (host === "flypoomas.com" || host === "www.flypoomas.com") {
    return "poomas";
  }
  return host;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
