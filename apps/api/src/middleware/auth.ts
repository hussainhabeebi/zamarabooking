import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { jwtVerify, type JWTPayload } from "jose";
import type { Env, Variables } from "../types.js";
import { verifyToken } from "../routes/checkout.js";

const BEARER_PREFIX = "Bearer ";
const API_KEY_PREFIX = "pmsk_";

interface PoomasJWTPayload extends JWTPayload {
  userId:   string;
  tenantId: string;
  role:     string;
  agentId?: string;
}

// Handles both:
//   1. JWT Bearer tokens (issued to users/agents via /api/auth/login)
//   2. API keys (prefixed pmsk_... , issued to Leadvyne / integrations)
export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const apiKeyHeader = c.req.header("X-API-Key") ?? "";
  const checkoutToken = c.req.header("X-Checkout-Token") ?? "";

  if (apiKeyHeader.startsWith(API_KEY_PREFIX)) {
    return verifyApiKey(c, apiKeyHeader, next);
  }

  if (authHeader.startsWith(BEARER_PREFIX)) {
    return verifyJWT(c, authHeader.slice(BEARER_PREFIX.length), next);
  }

  if (checkoutToken) {
    try {
      const payload = await verifyToken(checkoutToken, c.env.JWT_SECRET);
      if (payload.tenantId !== c.get("tenantId") || typeof payload.sub !== "string") {
        throw new Error("Checkout token scope mismatch");
      }
      c.set("userRole", "CHECKOUT");
      c.set("checkoutBookingId", payload.sub);
      return next();
    } catch {
      throw new HTTPException(401, { message: "Invalid or expired checkout session" });
    }
  }

  throw new HTTPException(401, { message: "Authentication required" });
};

async function verifyJWT(c: Parameters<MiddlewareHandler>[0], token: string, next: () => Promise<void>) {
  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jwtVerify<PoomasJWTPayload>(token, secret);

    // JWT's tenantId must match the resolved tenant from the domain
    // This prevents a token from one tenant being used against another
    const resolvedTenantId = c.get("tenantId");
    if (payload.tenantId !== resolvedTenantId) {
      throw new HTTPException(403, { message: "Token tenant mismatch" });
    }

    // Checkout social identities can access only their saved traveller profile.
    // They must not inherit the broader agent routes accepted by legacy tokens.
    if (payload.scope === "customer-profile" && !c.req.path.startsWith("/api/profile/")) {
      throw new HTTPException(403, { message: "Customer token cannot access this operation" });
    }
    if (payload.scope === "customer-profile") {
      const session = await c.env.SESSIONS_KV.get(`session:${payload.userId}`, "json") as { sessionId?: string; tenantId?: string } | null;
      if (!payload.sessionId || session?.sessionId !== payload.sessionId || session?.tenantId !== resolvedTenantId) {
        throw new HTTPException(401, { message: "Customer session has ended. Please sign in again." });
      }
    }

    c.set("userId",   payload.userId);
    c.set("userRole", payload.role);
    if (payload.agentId) c.set("agentId", payload.agentId);

    return next();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }
}

async function verifyApiKey(c: Parameters<MiddlewareHandler>[0], rawKey: string, next: () => Promise<void>) {
  // API keys are tenant-scoped — looked up by prefix + hash
  const db = c.get("db");
  const { tenantApiKeys } = await import("@poomas/db/schema");
  const { eq, and } = await import("drizzle-orm");

  const prefix = rawKey.slice(0, 12);  // "pmsk_" + 7 chars
  const rows = await db
    .select()
    .from(tenantApiKeys)
    .where(
      and(
        eq(tenantApiKeys.keyPrefix, prefix),
        eq(tenantApiKeys.tenantId,  c.get("tenantId")),
        eq(tenantApiKeys.isActive,  true),
      ),
    )
    .limit(1);

  if (!rows[0]) {
    throw new HTTPException(401, { message: "Invalid API key" });
  }

  const apiKey = rows[0];

  // Constant-time hash comparison (argon2/bcrypt — simplified here as TODO for actual impl)
  const isValid = await verifyKeyHash(rawKey, apiKey.keyHash);
  if (!isValid) {
    throw new HTTPException(401, { message: "Invalid API key" });
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    throw new HTTPException(401, { message: "API key expired" });
  }

  // API key tokens are treated as AGENT_ADMIN role for Leadvyne integrations
  c.set("userRole", "AGENT_ADMIN");

  // Update last-used async (don't block the request)
  c.executionCtx.waitUntil(
    db.update(tenantApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(tenantApiKeys.id, apiKey.id)),
  );

  return next();
}

async function verifyKeyHash(rawKey: string, storedHash: string): Promise<boolean> {
  const buf      = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  const computed = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computed === storedHash;
}

// Role guard factory — use inside route handlers
export function requireRole(...roles: string[]) {
  return (role: string | undefined) => {
    if (!role || !roles.includes(role)) {
      throw new HTTPException(403, { message: "Insufficient permissions" });
    }
  };
}
