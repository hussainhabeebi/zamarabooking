import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { tenantApiKeys } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";

export type PartnerApiScope = "search" | "booking" | "eticket" | "webhook";

async function hashApiKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawKey),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function suppliedApiKey(authorization?: string, xApiKey?: string): string | null {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || xApiKey?.trim() || null;
}

export function requirePartnerScope(
  requiredScope: PartnerApiScope,
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const rawKey = suppliedApiKey(
      c.req.header("Authorization"),
      c.req.header("X-API-Key"),
    );

    if (!rawKey || !rawKey.startsWith("pmsk_")) {
      c.header("WWW-Authenticate", 'Bearer realm="FlyPoomas Partner API"');
      return c.json({ error: "PARTNER_AUTHENTICATION_REQUIRED" }, 401);
    }

    const keyHash = await hashApiKey(rawKey);
    const db = c.get("db");
    const tenantId = c.get("tenantId");

    const [apiKey] = await db
      .select({
        id: tenantApiKeys.id,
        name: tenantApiKeys.name,
        scopes: tenantApiKeys.scopes,
        isActive: tenantApiKeys.isActive,
        expiresAt: tenantApiKeys.expiresAt,
      })
      .from(tenantApiKeys)
      .where(and(
        eq(tenantApiKeys.tenantId, tenantId),
        eq(tenantApiKeys.keyHash, keyHash),
      ))
      .limit(1);

    if (!apiKey || !apiKey.isActive) {
      return c.json({ error: "PARTNER_API_KEY_INVALID" }, 401);
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: "PARTNER_API_KEY_EXPIRED" }, 401);
    }

    if (!apiKey.scopes.includes(requiredScope)) {
      return c.json({
        error: "PARTNER_SCOPE_REQUIRED",
        requiredScope,
      }, 403);
    }

    c.set("partnerApiKeyId", apiKey.id);
    c.set("partnerName", apiKey.name);

    await db
      .update(tenantApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(tenantApiKeys.id, apiKey.id));

    await next();
  };
}
