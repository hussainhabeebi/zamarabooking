import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const path      = new URL(request.url).pathname;
  const loginPath = "/login";

  if (path === loginPath || path === "/forgot-password" || path === "/set-password") return NextResponse.next();

  // Allow Cloudflare Access JWT (zero-trust tunnel) — takes precedence
  const cfJwt = request.headers.get("CF-Access-Jwt-Assertion");
  if (cfJwt) return NextResponse.next();

  // Fall back to cookie-based auth (works in both dev and production
  // when CF Access is not configured)
  const token = request.cookies.get("poomas_admin_token")?.value;
  if (!token) {
    return NextResponse.redirect(new URL(loginPath, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|logo.png|logo.svg).*)"],
};
