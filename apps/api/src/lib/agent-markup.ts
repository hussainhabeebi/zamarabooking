// Per-agent markup for B2B sub-accounts. A parent agent sets it for each of
// their sub-agents; it is added on top of the normal price in that
// sub-agent's search results (their selling price). Stored in KV:
//   agent_markup:<tenant>:<agentId> → { type: FLAT | PERCENTAGE, value, setBy, updatedAt }

import type { Context } from "hono";
import { jwtVerify } from "jose";
import type { Env, Variables } from "../types.js";

export interface AgentMarkup { type: "FLAT" | "PERCENTAGE"; value: number; setBy: string; updatedAt: string }

const key = (tenantId: string, agentId: string) => `agent_markup:${tenantId}:${agentId}`;

export async function getAgentMarkup(env: Env, tenantId: string, agentId: string) {
  return await env.TENANT_CACHE_KV.get(key(tenantId, agentId), "json").catch(() => null) as AgentMarkup | null;
}

export async function setAgentMarkup(env: Env, tenantId: string, agentId: string, m: AgentMarkup | null) {
  if (!m || m.value <= 0) await env.TENANT_CACHE_KV.delete(key(tenantId, agentId));
  else await env.TENANT_CACHE_KV.put(key(tenantId, agentId), JSON.stringify(m));
}

export function markupAmount(m: AgentMarkup, price: number) {
  const raw = m.type === "FLAT" ? m.value : (price * m.value) / 100;
  return Math.max(0, Math.round(raw * 100) / 100);
}

export function withAgentMarkup<T extends { displayPrice?: number; totalFare: number }>(fares: T[], m: AgentMarkup | null) {
  if (!m) return fares;
  return fares.map((f) => {
    const base = typeof f.displayPrice === "number" ? f.displayPrice : f.totalFare;
    const add = markupAmount(m, base);
    return { ...f, displayPrice: Math.round((base + add) * 100) / 100, agentMarkup: add };
  });
}

// Agent id from an agent's Bearer token on public routes (search); null otherwise.
export async function optionalAgentId(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | null> {
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(auth.slice(7), new TextEncoder().encode(c.env.JWT_SECRET)) as {
      payload: { agentId?: string; tenantId?: string };
    };
    return payload.agentId && payload.tenantId === c.get("tenantId") ? payload.agentId : null;
  } catch {
    return null;
  }
}

// Agency id + staff user id from an agent's Bearer token; null for everyone else.
export async function optionalAgent(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<{ agentId: string; userId: string | null } | null> {
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(auth.slice(7), new TextEncoder().encode(c.env.JWT_SECRET)) as {
      payload: { agentId?: string; tenantId?: string; userId?: string };
    };
    return payload.agentId && payload.tenantId === c.get("tenantId") ? { agentId: payload.agentId, userId: payload.userId ?? null } : null;
  } catch {
    return null;
  }
}
