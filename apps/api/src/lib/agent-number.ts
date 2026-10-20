// FlyPoomas agent numbers (FPA10001 …) and agency activity tracking.
//
// Every agency gets an agent number. Leadvyne Live Agency stores it per client
// and sends it with searches and checkout links (header X-FP-Agent or body
// agentNumber), so FlyPoomas knows the agency's currency and can count its
// searches, checkout links and bookings.

import { and, eq, isNull, sql } from "drizzle-orm";
import { agentActivityDaily, agents } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";
import type { DisplayCurrency } from "./fx.js";

type Db = Variables["db"];

export const AGENT_NUMBER_RE = /^FPA\d{5,7}$/;

export function normalizeAgentNumber(v: unknown): string | null {
  const s = String(v ?? "").toUpperCase().replace(/[\s-]/g, "");
  return AGENT_NUMBER_RE.test(s) ? s : null;
}

// Country (ISO 3166-1 alpha-2) → the agency's currency.
const COUNTRY_CURRENCY: Record<string, DisplayCurrency> = {
  IN: "INR", AE: "AED", SA: "SAR", QA: "QAR", OM: "OMR", KW: "KWD", BH: "BHD",
};
export const currencyForCountry = (cc: string): DisplayCurrency => COUNTRY_CURRENCY[cc.toUpperCase()] ?? "USD";
// Wallets only hold INR, AED or USD: GCC currencies keep their wallet in AED.
export const walletCurrencyFor = (c: DisplayCurrency): "INR" | "AED" | "USD" => (c === "INR" || c === "USD" ? c : "AED");
export const regionForCountry = (cc: string): "INDIA" | "GCC" => (cc.toUpperCase() === "IN" ? "INDIA" : "GCC");

export function agentCurrency(a: { currency: string; settings?: unknown }): string {
  const s = (a.settings ?? {}) as { displayCurrency?: string };
  return s.displayCurrency || a.currency;
}

// Gives the agency the next free number (no-op if it already has one).
export async function assignAgentNumber(db: Db, tenantId: string, agentId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ top }] = await db.select({ top: sql<number>`coalesce(max(substring(${agents.agentNumber} from 4)::int), 10000)` })
      .from(agents).where(and(eq(agents.tenantId, tenantId), sql`${agents.agentNumber} ~ '^FPA[0-9]+$'`));
    const next = `FPA${Number(top) + 1 + attempt}`;
    try {
      const [row] = await db.update(agents).set({ agentNumber: next })
        .where(and(eq(agents.id, agentId), isNull(agents.agentNumber))).returning({ n: agents.agentNumber });
      if (row) return row.n;
      const [cur] = await db.select({ n: agents.agentNumber }).from(agents).where(eq(agents.id, agentId)).limit(1);
      return cur?.n ?? null;
    } catch (err: any) {
      if (String(err?.code ?? err?.cause?.code) !== "23505") throw err;   // taken at the same moment: try the next one
    }
  }
  return null;
}

export interface ResolvedAgent { id: string; number: string; businessName: string; currency: string; status: string }

const cacheKey = (tenantId: string, n: string) => `agent_no:${tenantId}:${n}`;

export async function resolveAgentNumber(env: Env, db: Db, tenantId: string, raw: unknown): Promise<ResolvedAgent | null> {
  const n = normalizeAgentNumber(raw);
  if (!n) return null;
  try {
    const hit = await env.TENANT_CACHE_KV.get(cacheKey(tenantId, n), "json") as ResolvedAgent | { none: true } | null;
    if (hit) return "none" in hit ? null : hit;
  } catch {}
  const [a] = await db.select({ id: agents.id, businessName: agents.businessName, currency: agents.currency, settings: agents.settings, status: agents.status })
    .from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.agentNumber, n))).limit(1);
  const out = a ? { id: a.id, number: n, businessName: a.businessName, currency: agentCurrency(a), status: a.status } : null;
  try { await env.TENANT_CACHE_KV.put(cacheKey(tenantId, n), JSON.stringify(out ?? { none: true }), { expirationTtl: out ? 600 : 120 }); } catch {}
  return out;
}

export async function forgetAgentNumber(env: Env, tenantId: string, n: string | null | undefined) {
  if (n) { try { await env.TENANT_CACHE_KV.delete(cacheKey(tenantId, n)); } catch {} }
}

// Agent number sent by Leadvyne: header X-FP-Agent, or agentNumber in the body.
export function agentNumberFrom(c: { req: { header(n: string): string | undefined } }, body?: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  return normalizeAgentNumber(c.req.header("X-FP-Agent") ?? b.agentNumber ?? b.agent_number ?? null);
}

// +1 search or checkout link for today (UTC).
export async function trackAgentActivity(db: Db, tenantId: string, agentId: string, field: "searches" | "checkouts") {
  const day = new Date().toISOString().slice(0, 10);
  await db.insert(agentActivityDaily).values({ agentId, tenantId, day, searches: field === "searches" ? 1 : 0, checkouts: field === "checkouts" ? 1 : 0 })
    .onConflictDoUpdate({
      target: [agentActivityDaily.agentId, agentActivityDaily.day],
      set: field === "searches" ? { searches: sql`${agentActivityDaily.searches} + 1` } : { checkouts: sql`${agentActivityDaily.checkouts} + 1` },
    });
}
