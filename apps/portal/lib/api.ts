// Agency portal API client. Calls the FlyPoomas API directly with the agent's
// login token (cookie "poomas_token", set at sign-in).

export const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
export const TENANT = "poomas";

export function getToken(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)poomas_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export function setToken(token: string) {
  document.cookie = `poomas_token=${encodeURIComponent(token)}; Path=/; Max-Age=86400; SameSite=Lax; Secure`;
}

export function signOut() {
  document.cookie = "poomas_token=; Path=/; Max-Age=0; SameSite=Lax; Secure";
  window.location.assign("/login");
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public data?: unknown) { super(message); }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown; auth?: boolean } = {}): Promise<T> {
  const { json, auth = true, headers, ...rest } = init;
  const isForm = typeof FormData !== "undefined" && rest.body instanceof FormData;
  const token = auth ? getToken() : "";
  const res = await fetch(`${API}${path}`, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), method: rest.method ?? "POST" } : {}),
    headers: {
      "x-tenant-slug": TENANT,
      ...(json !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? await res.json().catch(() => ({})) : await res.text();
  if (res.status === 401 && auth && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    signOut();
    throw new ApiError("Please sign in again.", 401);
  }
  if (!res.ok) {
    const d = data as { error?: string; message?: string; errorCode?: string; code?: string };
    const msg = typeof data === "string" ? data.slice(0, 200) : d.error ?? d.message ?? `Something went wrong (${res.status})`;
    throw new ApiError(msg, res.status, d?.errorCode ?? d?.code, data);
  }
  return data as T;
}

// Opens an authenticated file (CSV, attachment) in a new tab / download.
export async function openFile(path: string, filename?: string) {
  const res = await fetch(`${API}${path}`, { headers: { "x-tenant-slug": TENANT, Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError(`Couldn't open the file (${res.status})`, res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename; else a.target = "_blank";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function money(n: number | string | null | undefined, currency = "INR") {
  const v = Number(n ?? 0);
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v); }
  catch { return `${currency} ${v.toFixed(2)}`; }
}

export const fmtDate = (s?: string | null, withTime = false) => {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return withTime
    ? d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

export const fmtTime = (s?: string | null) => {
  if (!s) return "--:--";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
};

export const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  HELD: { label: "On hold", cls: "b-amber" }, PAYMENT_PENDING: { label: "Payment pending", cls: "b-amber" },
  PAYMENT_FAILED: { label: "Failed", cls: "b-red" }, CONFIRMED: { label: "Confirmed", cls: "b-green" },
  TICKETED: { label: "Ticketed", cls: "b-green" }, CANCELLED: { label: "Cancelled", cls: "b-grey" },
  REFUND_PENDING: { label: "Refund pending", cls: "b-blue" }, REFUNDED: { label: "Refunded", cls: "b-grey" },
  PENDING: { label: "Pending approval", cls: "b-amber" }, APPROVED: { label: "Approved", cls: "b-green" },
  SUSPENDED: { label: "Suspended", cls: "b-red" }, REJECTED: { label: "Rejected", cls: "b-grey" },
  OPEN: { label: "Open", cls: "b-blue" }, IN_PROGRESS: { label: "In progress", cls: "b-amber" }, QUOTED: { label: "Quoted", cls: "b-blue" },
  DONE: { label: "Done", cls: "b-green" }, CLOSED: { label: "Closed", cls: "b-grey" },
};

export type Role = "AGENT_ADMIN" | "AGENT_STAFF" | "AGENT_ACCOUNTANT";

export interface Me {
  agent: { id: string; businessName: string; ownerName: string; email: string; phone: string; whatsapp: string | null; region: string; currency: string; status: string; iataCode: string | null; parentAgentId: string | null; parentName: string | null; createdAt: string; agentNumber?: string | null };
  settings: {
    displayName?: string; logoUrl?: string | null; brandColor?: string; contactPhone?: string; contactEmail?: string; address?: string; gstNumber?: string;
    slug?: string; miniSite?: boolean; ownMarkup?: { type: "FLAT" | "PERCENTAGE"; value: number }; frozen?: boolean; frozenReason?: string;
  };
  user: { id: string; role: Role; name: string; email: string };
  credit: { balance: number; creditLimit: number; available: number; creditUsed: number; dueAt: string | null; overdue: boolean };
  tier: { name: string; commissionPercent: number; sales: number; next: { name: string; needed: number } | null };
  program: { creditDays: number; tiers: { name: string; minMonthlySales: number; commissionPercent: number }[] };
  onboarding: Onboarding | null;
}

export interface Onboarding {
  enforce: boolean;
  required: { type: string; label: string; status: "MISSING" | "UPLOADED" | "VERIFIED" }[];
  kycDone: boolean;
  mou: { required: boolean; version: string; accepted: boolean; acceptedAt: string | null; acceptedBy: string | null };
  complete: boolean;
}

let meCache: Promise<Me> | null = null;
export function loadMe(fresh = false): Promise<Me> {
  if (!meCache || fresh) meCache = api<Me>("/api/agent/me").catch((e) => { meCache = null; throw e; });
  return meCache;
}

export const REQUEST_TYPES: { type: string; label: string; icon: string; hint: string }[] = [
  { type: "VISA", label: "Visa", icon: "🛂", hint: "UAE, Saudi, Oman, Schengen… upload passport & photo" },
  { type: "UMRAH", label: "Umrah", icon: "🕋", hint: "Umrah packages with visa, hotel and transport" },
  { type: "PACKAGE", label: "Holiday package", icon: "🏝️", hint: "Tours, honeymoon and family holidays" },
  { type: "HOTEL", label: "Hotel", icon: "🏨", hint: "Hotel booking at your selling price" },
  { type: "INSURANCE", label: "Travel insurance", icon: "🛡️", hint: "TripSafe travel insurance" },
  { type: "BUS", label: "Bus", icon: "🚌", hint: "Bus tickets within India" },
  { type: "GROUP", label: "Group booking (10+)", icon: "👥", hint: "Group fares for 10 or more travellers" },
  { type: "CHARTER", label: "Charter", icon: "🛩️", hint: "Private jet and charter flights" },
  { type: "AMENDMENT", label: "Booking change", icon: "✏️", hint: "Date change, name correction, add baggage, reissue" },
  { type: "OFFLINE_BOOKING", label: "Offline booking", icon: "📥", hint: "Register a ticket booked elsewhere" },
  { type: "SUPPORT", label: "Support", icon: "🛟", hint: "Anything else — our team replies within hours" },
];

export const requestLabel = (t: string) => REQUEST_TYPES.find((r) => r.type === t)?.label ?? (t === "DEPOSIT" ? "Deposit" : t === "LEAD" ? "Customer enquiry" : t);

// Fares the agent marked "+ Quote" in search (browser only).
export const QUOTE_DRAFT = "agent_quote_draft";
