// GET    /api/admin/api-keys        — list API keys for this tenant (hashes never returned)
// POST   /api/admin/api-keys        — create a new API key (returns full key ONCE)
// DELETE /api/admin/api-keys/:id    — revoke a key
// PATCH  /api/admin/api-keys/:id    — rename or toggle active

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { tenantApiKeys } from "@poomas/db/schema";
import { eq, and } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";

export const apiKeysAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const KEY_PREFIX = "pmsk_";

// Generate a cryptographically random API key
function generateApiKey(): string {
  const bytes  = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex    = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${KEY_PREFIX}${hex}`;
}

// Simple HMAC-SHA256 hash of the raw key (production should use argon2/bcrypt via a DO)
async function hashKey(rawKey: string): Promise<string> {
  const enc  = new TextEncoder();
  const data = enc.encode(rawKey);
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VALID_SCOPES = ["search", "booking", "eticket", "webhook"] as const;
type Scope = typeof VALID_SCOPES[number];

// ── List ──────────────────────────────────────────────────────────────────────

apiKeysAdminRoutes.get("/", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const keys = await db
    .select({
      id:         tenantApiKeys.id,
      name:       tenantApiKeys.name,
      keyPrefix:  tenantApiKeys.keyPrefix,
      scopes:     tenantApiKeys.scopes,
      isActive:   tenantApiKeys.isActive,
      lastUsedAt: tenantApiKeys.lastUsedAt,
      expiresAt:  tenantApiKeys.expiresAt,
      createdAt:  tenantApiKeys.createdAt,
    })
    .from(tenantApiKeys)
    .where(eq(tenantApiKeys.tenantId, tenantId))
    .orderBy(tenantApiKeys.createdAt);

  return c.json(keys);
});

// ── Create ────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  name:      z.string().min(1).max(80),
  scopes:    z.array(z.enum(VALID_SCOPES)).default(["search"]),
  expiresAt: z.string().datetime().optional(),  // ISO8601 or omit for never-expires
});

apiKeysAdminRoutes.post("/", zValidator("json", createSchema), async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");

  const rawKey   = generateApiKey();
  const keyHash  = await hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);   // "pmsk_" + 7 chars

  const [created] = await db.insert(tenantApiKeys).values({
    tenantId,
    name:      body.name,
    keyHash,
    keyPrefix,
    scopes:    body.scopes,
    isActive:  true,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
  }).returning({
    id:        tenantApiKeys.id,
    name:      tenantApiKeys.name,
    keyPrefix: tenantApiKeys.keyPrefix,
    scopes:    tenantApiKeys.scopes,
    expiresAt: tenantApiKeys.expiresAt,
    createdAt: tenantApiKeys.createdAt,
  });

  // rawKey is returned ONLY this once — it cannot be retrieved again
  return c.json({ ...created, key: rawKey, warning: "Copy this key now — it will not be shown again." }, 201);
});

// ── Revoke ────────────────────────────────────────────────────────────────────

apiKeysAdminRoutes.delete("/:id", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const id       = c.req.param("id");

  const [key] = await db
    .select({ id: tenantApiKeys.id })
    .from(tenantApiKeys)
    .where(and(eq(tenantApiKeys.id, id), eq(tenantApiKeys.tenantId, tenantId)))
    .limit(1);

  if (!key) throw new HTTPException(404, { message: "API key not found" });

  await db.update(tenantApiKeys)
    .set({ isActive: false, revokedAt: new Date() })
    .where(eq(tenantApiKeys.id, id));

  return c.json({ ok: true });
});

// ── Update (rename / toggle) ──────────────────────────────────────────────────

const updateSchema = z.object({
  name:     z.string().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
});

apiKeysAdminRoutes.patch("/:id", zValidator("json", updateSchema), async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const id       = c.req.param("id");
  const body     = c.req.valid("json");

  const [key] = await db
    .select({ id: tenantApiKeys.id })
    .from(tenantApiKeys)
    .where(and(eq(tenantApiKeys.id, id), eq(tenantApiKeys.tenantId, tenantId)))
    .limit(1);

  if (!key) throw new HTTPException(404, { message: "API key not found" });

  await db.update(tenantApiKeys)
    .set({
      ...(body.name     !== undefined ? { name:     body.name }     : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    })
    .where(eq(tenantApiKeys.id, id));

  return c.json({ ok: true });
});
