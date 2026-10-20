import type { Context } from "hono";
import { jwtVerify } from "jose";
import type { Env, Variables } from "../types.js";

// Returns the signed-in customer's user id for public routes (e.g. /api/book)
// that also serve guests. Any invalid, expired or ended session means "guest".
export async function optionalCustomerId(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | null> {
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(auth.slice(7), new TextEncoder().encode(c.env.JWT_SECRET)) as {
      payload: { userId?: string; tenantId?: string; role?: string; sessionId?: string };
    };
    if (payload.role !== "CUSTOMER" || payload.tenantId !== c.get("tenantId") || !payload.userId) return null;
    const session = await c.env.SESSIONS_KV.get(`session:${payload.userId}`, "json") as { sessionId?: string } | null;
    if (!payload.sessionId || session?.sessionId !== payload.sessionId) return null;
    return payload.userId;
  } catch {
    return null;
  }
}
