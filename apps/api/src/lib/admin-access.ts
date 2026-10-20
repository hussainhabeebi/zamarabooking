// Admin panel access: full admins (SUPER_ADMIN, legacy TENANT_ADMIN) and STAFF
// users who may open only the sections ticked for them. Every /api/admin call
// is checked here against the user's current row (cached for a minute), so a
// deactivated or demoted user loses access right away, not when the 24 h
// token expires.

import { eq } from "drizzle-orm";
import { users } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";

type Db = Variables["db"];

export const ADMIN_ROLES = ["SUPER_ADMIN", "TENANT_ADMIN", "STAFF"] as const;

// Sections staff can be given, with the admin API paths (under /api/admin) they open.
export const STAFF_SECTIONS = [
  { key: "bookings",         label: "Bookings, cancellations & TripSafe", paths: ["/bookings", "/cancellations", "/tripsafe"] },
  { key: "agents",           label: "Agencies & Leadvyne agencies",       paths: ["/agents", "/leadvyne-agents", "/agent-program/agents", "/agent-program/documents", "/agent-program/analytics", "/agent-program/audit"] },
  { key: "agent_requests",   label: "Agent requests",                      paths: ["/agent-program/requests"] },
  { key: "wallet_recharges", label: "Wallet recharges (approve deposits)", paths: ["/agent-program/recharges"] },
  { key: "customer_wallets", label: "Customer wallets",                    paths: ["/customer-wallets"] },
  { key: "support",          label: "Customer support",                    paths: ["/support-requests"] },
  { key: "finance",          label: "Finance reports",                     paths: ["/finance"] },
  { key: "logs",             label: "API logs",                            paths: ["/supplier-logs"] },
] as const;
export type StaffSection = (typeof STAFF_SECTIONS)[number]["key"];
export const STAFF_SECTION_KEYS = STAFF_SECTIONS.map((s) => s.key) as StaffSection[];

// Which section an admin API path belongs to; null = full admins only
// (settings, integrations, suppliers, tenants, API keys, users, programme config…).
export function sectionFor(path: string): StaffSection | null {
  const p = path.replace(/^\/api\/admin/, "") || "/";
  // Crediting / rejecting a deposit is a wallet-recharge action, and the
  // receipt files are needed there too.
  if (/^\/agent-program\/requests\/[^/]+\/(approve-deposit|reject-deposit)$/.test(p)) return "wallet_recharges";
  let best: { key: StaffSection; len: number } | null = null;
  for (const s of STAFF_SECTIONS) {
    for (const prefix of s.paths) {
      if ((p === prefix || p.startsWith(prefix + "/") || p.startsWith(prefix + "?")) && (!best || prefix.length > best.len)) best = { key: s.key, len: prefix.length };
    }
  }
  return best?.key ?? null;
}

// Paths any signed-in admin user may call (their own profile and the menu).
export const OPEN_PATHS = ["/me"];

export function staffCanOpen(path: string, permissions: string[]): boolean {
  const p = path.replace(/^\/api\/admin/, "") || "/";
  if (OPEN_PATHS.includes(p)) return true;
  // Deposit receipts: whoever handles requests or recharges may open them.
  if (/^\/agent-program\/requests\/[^/]+\/file$/.test(p)) return permissions.includes("agent_requests") || permissions.includes("wallet_recharges");
  const s = sectionFor(p);
  return !!s && permissions.includes(s);
}

export interface AdminUser { id: string; role: string; isActive: boolean; permissions: string[]; name: string | null; email: string | null }

const cacheKey = (userId: string) => `admin_user:${userId}`;

export async function loadAdminUser(env: Env, db: Db, userId: string): Promise<AdminUser | null> {
  try {
    const hit = await env.SESSIONS_KV.get(cacheKey(userId), "json") as AdminUser | null;
    if (hit) return hit;
  } catch {}
  const [u] = await db.select({ id: users.id, role: users.role, isActive: users.isActive, permissions: users.adminPermissions, name: users.name, email: users.email })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return null;
  const out: AdminUser = { ...u, permissions: Array.isArray(u.permissions) ? u.permissions : [] };
  try { await env.SESSIONS_KV.put(cacheKey(userId), JSON.stringify(out), { expirationTtl: 60 }); } catch {}
  return out;
}

export async function forgetAdminUser(env: Env, userId: string) {
  try { await env.SESSIONS_KV.delete(cacheKey(userId)); } catch {}
}

// Where password links point: ADMIN_URL, or the admin site the request came
// from when it is a FlyPoomas address (never an arbitrary origin).
export function adminUrl(env: Env, origin?: string | null) {
  if (origin && (/^https:\/\/([a-z0-9-]+\.)*flypoomas\.com$/i.test(origin) || /^http:\/\/localhost:\d+$/.test(origin))) return origin;
  return (env.ADMIN_URL ?? "https://admin.flypoomas.com").replace(/\/$/, "");
}

// Readable one-off password: two 4-letter words, three digits and a capital.
export function tempPassword() {
  const A = "abcdefghjkmnpqrstuvwxyz", D = "23456789";
  const r = crypto.getRandomValues(new Uint32Array(12));
  const pick = (set: string, i: number) => set[r[i] % set.length];
  const part = (o: number) => Array.from({ length: 4 }, (_, i) => pick(A, o + i)).join("");
  return `${part(0)}-${part(4)}-${pick(D, 8)}${pick(D, 9)}${pick(D, 10)}${pick(A, 11).toUpperCase()}`;
}
