// Browser-side helpers for signed-in customer and guest ("find my booking") calls.

export const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const GUEST_TOKEN_KEY = "poomas_trip_token";

export function readCustomerToken(): string {
  try {
    const m = document.cookie.match(/(?:^|;\s*)poomas_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  } catch { return ""; }
}

export function signOut() {
  document.cookie = "poomas_token=; Path=/; Max-Age=0; SameSite=Lax; Secure";
}

export function readGuestToken(): string {
  try { return sessionStorage.getItem(GUEST_TOKEN_KEY) ?? ""; } catch { return ""; }
}
export function saveGuestToken(token: string) {
  try { sessionStorage.setItem(GUEST_TOKEN_KEY, token); } catch {}
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message); }
}

// auth "customer" sends the sign-in token, "guest" the trip token.
export async function apiCall<T = any>(path: string, init: RequestInit & { auth?: "customer" | "guest" } = {}): Promise<T> {
  const { auth: authMode = "customer", ...rest } = init;
  const auth: Record<string, string> = authMode === "guest"
    ? { "X-Trip-Token": readGuestToken() }
    : { Authorization: `Bearer ${readCustomerToken()}` };
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas", ...auth, ...(rest.headers ?? {}) },
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const message = (isJson && (data as any)?.error) || (res.status === 401 || res.status === 403 ? "Please sign in again." : `Something went wrong (${res.status})`);
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

// Opens the e-ticket HTML (fetched with auth) in a new tab where it can be printed / saved as PDF.
export async function openETicket(path: string, mode: "customer" | "guest") {
  const win = window.open("", "_blank");
  try {
    const html = await apiCall<string>(path, { auth: mode, headers: { Accept: "text/html" } });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    if (win) win.location.href = url; else window.location.href = url;
  } catch (err) {
    win?.close();
    throw err;
  }
}

export const inr = (n: number, currency = "INR") => {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n); }
  catch { return `${currency} ${n.toFixed(2)}`; }
};

export const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  TICKETED:        { label: "Ticketed",           color: "#166534", bg: "#dcfce7" },
  CONFIRMED:       { label: "Confirmed",          color: "#166534", bg: "#dcfce7" },
  PAYMENT_PENDING: { label: "Awaiting payment",   color: "#92400e", bg: "#fef3c7" },
  HELD:            { label: "On hold",            color: "#92400e", bg: "#fef3c7" },
  PAYMENT_FAILED:  { label: "Not completed",      color: "#991b1b", bg: "#fee2e2" },
  CANCELLED:       { label: "Cancelled",          color: "#475569", bg: "#f1f5f9" },
  REFUND_PENDING:  { label: "Refund pending",     color: "#92400e", bg: "#fef3c7" },
  REFUNDED:        { label: "Cancelled · refunded", color: "#475569", bg: "#f1f5f9" },
};

// Fetches a document with auth and saves it as a file (e.g. the itinerary).
export async function downloadFile(path: string, mode: "customer" | "guest", filename: string) {
  const html = await apiCall<string>(path, { auth: mode, headers: { Accept: "text/html" } });
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
