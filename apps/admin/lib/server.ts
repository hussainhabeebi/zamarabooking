export const SERVER_API =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "https://api.flypoomas.com";

export const SERVER_TOKEN = process.env.ADMIN_SERVICE_TOKEN ?? "";

// Headers for server-side admin API calls: the signed-in admin's own token, so
// the API applies their role and staff sections. The service token is used
// only when there is no login cookie (e.g. Cloudflare Access sign-in).
export async function serverAuthHeaders(): Promise<Record<string, string>> {
  let token = "";
  try {
    const { cookies } = await import("next/headers");
    const raw = (await cookies()).get("poomas_admin_token")?.value;
    if (raw) token = decodeURIComponent(raw);
  } catch {}
  return { Authorization: `Bearer ${token || SERVER_TOKEN || process.env.ADMIN_API_TOKEN || ""}`, "x-tenant-slug": "poomas" };
}
