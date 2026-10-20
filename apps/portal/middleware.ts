import { NextResponse, type NextRequest } from "next/server";

// Pages anyone can open: sign-in, agency sign-up, invitations, shared quotes
// (/q/…), agency mini-sites (/a/…) and PWA files.
const PUBLIC_PATHS = ["/login", "/register", "/accept-invite", "/forgot-password", "/reset-password", "/q/", "/a/", "/api", "/manifest.webmanifest", "/sw.js"];

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const path = new URL(request.url).pathname;

  const slug = host.endsWith(".flypoomas.com") ? host.split(".")[0] : host;

  const res = NextResponse.next();
  res.headers.set("x-tenant-slug", slug);

  if (path === "/" ) return NextResponse.redirect(new URL("/dashboard", request.url));
  if (PUBLIC_PATHS.some((p) => path.startsWith(p))) return res;

  const token = request.cookies.get("poomas_token")?.value;
  if (!token) {
    const login = new URL("/login", request.url);
    if (path !== "/dashboard") login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo\\.png|logo\\.svg).*)"],
};
