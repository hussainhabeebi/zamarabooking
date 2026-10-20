const API    = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const TENANT = "poomas";

// Server-side: prefer explicit API_BASE_URL (no "NEXT_PUBLIC_" needed in RSC),
// fall back to the shared public URL so it works without extra Vercel config.
export const SERVER_API = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
export const SERVER_TOKEN = process.env.ADMIN_SERVICE_TOKEN ?? "";

export function getAuthToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)poomas_admin_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken();
  return {
    "Content-Type":  "application/json",
    "x-tenant-slug": TENANT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export { API, TENANT };
