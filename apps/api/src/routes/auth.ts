import { Hono } from "hono";
import { emailCustomerWelcome } from "../lib/transactional-emails.js";
import { emailLayout, sendMail } from "../lib/email.js";
import { escapeHtml, WEB_URL } from "../lib/customer-notify.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { SignJWT } from "jose";
import { users, userSessions } from "@poomas/db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { socialAuthRoutes } from "./social-auth.js";

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
authRoutes.route("/social", socialAuthRoutes);

const loginSchema = z.object({
  email:    z.string().email().optional(),
  phone:    z.string().min(8).optional(),
  password: z.string().optional(),
  otp:      z.string().length(6).optional(),
}).refine((d) => d.email || d.phone, "email or phone required");

// Issue a JWT scoped to the resolved tenant (tenant_id from domain, not from request body)
const registerSchema = z.object({
  name:     z.string().min(2).max(100),
  email:    z.string().email(),
  password: z.string().min(8),
  phone:    z.string().min(8).optional(),
});

authRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
  const body     = c.req.valid("json");
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  // Check duplicate email within tenant
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, body.email), eq(users.tenantId, tenantId)))
    .limit(1);

  if (existing) {
    throw new HTTPException(409, { message: "Email already registered" });
  }

  const passwordHash = await pbkdf2HashPassword(body.password);

  await db.insert(users).values({
    tenantId,
    name:         body.name,
    email:        body.email,
    phone:        body.phone ?? null,
    passwordHash,
    role:         "AGENT_ADMIN",
    isActive:     true,
    emailVerified: false,
  });

  return c.json({ ok: true }, 201);
});

// Customer (B2C) self sign-up. Returns the same scoped customer token as social sign-in.
const customerRegisterSchema = z.object({
  name:     z.string().trim().min(2).max(100),
  email:    z.string().trim().toLowerCase().email(),
  phone:    z.string().trim().min(8).max(20).optional(),
  password: z.string().min(8).max(200),
});

authRoutes.post("/customer/register", zValidator("json", customerRegisterSchema), async (c) => {
  const body     = c.req.valid("json");
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [existing] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.email, body.email), eq(users.tenantId, tenantId))).limit(1);
  if (existing) throw new HTTPException(409, { message: "An account with this email already exists. Please sign in." });
  if (body.phone) {
    const [phoneTaken] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.phone, body.phone), eq(users.tenantId, tenantId))).limit(1);
    if (phoneTaken) throw new HTTPException(409, { message: "This phone number is already registered. Please sign in." });
  }

  const [user] = await db.insert(users).values({
    tenantId,
    name:          body.name,
    email:         body.email,
    phone:         body.phone ?? null,
    passwordHash:  await pbkdf2HashPassword(body.password),
    role:          "CUSTOMER",
    isActive:      true,
    emailVerified: false,
  }).onConflictDoNothing().returning();
  if (!user) throw new HTTPException(409, { message: "An account with this email already exists. Please sign in." });
  if (user.email) c.executionCtx.waitUntil(emailCustomerWelcome(c.env, db, tenantId, { id: user.id, email: user.email, name: user.name }).catch(() => {}));

  return c.json({ ...(await issueCustomerToken(c.env, db, user.id, tenantId)), customer: { name: user.name, email: user.email } }, 201);
});

// ── Customer password reset (flypoomas.com) ──────────────────────────────────
// Same reply whether or not the email exists; one-hour, one-use link.
authRoutes.post("/customer/forgot", zValidator("json", z.object({ email: z.string().trim().toLowerCase().email() })), async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const { email } = c.req.valid("json");
  const limitKey = `cust_rl:${tenantId}:${c.req.header("cf-connecting-ip") ?? "x"}:${new Date().toISOString().slice(0, 13)}`;
  const used = Number(await c.env.SESSIONS_KV.get(limitKey).catch(() => null) ?? 0);
  if (used >= 10) throw new HTTPException(429, { message: "Too many requests. Try again in an hour." });
  await c.env.SESSIONS_KV.put(limitKey, String(used + 1), { expirationTtl: 3600 }).catch(() => {});
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive }).from(users)
    .where(and(eq(sql`lower(${users.email})`, email), eq(users.tenantId, tenantId))).limit(1);
  if (user?.isActive && user.email && user.role === "CUSTOMER") {
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await c.env.SESSIONS_KV.put(`cust_pwreset:${token}`, JSON.stringify({ tenantId, userId: user.id }), { expirationTtl: 3600 });
    const link = `${WEB_URL}/reset-password?token=${token}`;
    c.executionCtx.waitUntil(sendMail(c.env, db, tenantId, {
      to: user.email, category: "auth", subject: "Reset your FlyPoomas password",
      html: emailLayout({
        title: "Reset your password",
        body: `<p>Hi ${escapeHtml(user.name || "there")}, use the button below to choose a new password for your FlyPoomas account. The link works for 1 hour.</p><p>If you didn't ask for this, you can ignore this email — your password stays the same.</p>`,
        cta: { label: "Choose a new password", href: link },
      }),
    }).then(() => undefined));
  }
  return c.json({ ok: true, message: "If an account exists for this email, we've sent a reset link. Check your inbox (and spam)." });
});

authRoutes.get("/customer/reset/:token", async (c) => {
  const t = await c.env.SESSIONS_KV.get(`cust_pwreset:${c.req.param("token")}`, "json") as { tenantId: string; userId: string } | null;
  if (!t || t.tenantId !== c.get("tenantId")) throw new HTTPException(404, { message: "This reset link has expired. Ask for a new one." });
  const [u] = await c.get("db").select({ email: users.email }).from(users).where(eq(users.id, t.userId)).limit(1);
  return c.json({ email: u?.email ?? "" });
});

authRoutes.post("/customer/reset/:token", zValidator("json", z.object({ password: z.string().min(8, "Use at least 8 characters").max(200) }), (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Choose a stronger password" }, 400);
}), async (c) => {
  const db = c.get("db");
  const key = `cust_pwreset:${c.req.param("token")}`;
  const t = await c.env.SESSIONS_KV.get(key, "json") as { tenantId: string; userId: string } | null;
  if (!t || t.tenantId !== c.get("tenantId")) throw new HTTPException(404, { message: "This reset link has expired. Ask for a new one." });
  await c.env.SESSIONS_KV.delete(key);   // one use only
  const [u] = await db.update(users).set({ passwordHash: await pbkdf2HashPassword(c.req.valid("json").password), emailVerified: true, updatedAt: new Date() })
    .where(and(eq(users.id, t.userId), eq(users.tenantId, t.tenantId), eq(users.role, "CUSTOMER"), eq(users.isActive, true)))
    .returning({ id: users.id, email: users.email });
  if (!u) throw new HTTPException(404, { message: "This account is no longer active." });
  // Signs out other devices (customer sessions are checked on every request) and signs in here.
  return c.json({ ...(await issueCustomerToken(c.env, db, u.id, t.tenantId)), email: u.email });
});

async function issueCustomerToken(env: Env, db: Variables["db"], userId: string, tenantId: string) {
  const sessionId = crypto.randomUUID();
  const token = await new SignJWT({ userId, tenantId, role: "CUSTOMER", scope: "customer-profile", sessionId })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("24h")
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  await env.SESSIONS_KV.put(`session:${userId}`, JSON.stringify({ userId, tenantId, role: "CUSTOMER", sessionId }), { expirationTtl: 86400 });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return { token, expiresIn: 86400, role: "CUSTOMER" as const };
}

authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
  const body     = c.req.valid("json");
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const whereClause = body.email
    ? and(eq(sql`lower(${users.email})`, body.email.trim().toLowerCase()), eq(users.tenantId, tenantId))
    : and(eq(users.phone, body.phone!),  eq(users.tenantId, tenantId));

  const [user] = await db.select().from(users).where(whereClause).limit(1);

  if (!user || !user.isActive) {
    throw new HTTPException(401, { message: "Invalid credentials" });
  }

  // Verify password (argon2id stored as $argon2id$...) or OTP
  if (body.password && user.passwordHash) {
    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) throw new HTTPException(401, { message: "Invalid credentials" });
  } else if (body.otp) {
    const otpKey = `otp:${tenantId}:${user.id}`;
    const stored = await c.env.SESSIONS_KV.get(otpKey);
    if (!stored || stored !== body.otp) {
      throw new HTTPException(401, { message: "Invalid or expired OTP" });
    }
    await c.env.SESSIONS_KV.delete(otpKey);
  } else {
    throw new HTTPException(401, { message: "Password or OTP required" });
  }

  // Customers get the scoped customer token (profile + wallet only), not a staff token.
  if (user.role === "CUSTOMER") {
    return c.json(await issueCustomerToken(c.env, db, user.id, tenantId));
  }

  const secret = new TextEncoder().encode(c.env.JWT_SECRET);
  const token  = await new SignJWT({
    userId:   user.id,
    tenantId: user.tenantId,
    role:     user.role,
    agentId:  user.agentId ?? undefined,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret);

  // Store session in KV (fast lookup + revocation support)
  await c.env.SESSIONS_KV.put(`session:${user.id}`, JSON.stringify({
    userId: user.id, tenantId, role: user.role,
  }), { expirationTtl: 86400 });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  return c.json({ token, expiresIn: 86400, role: user.role });
});

authRoutes.post("/logout", async (c) => {
  const auth = c.req.header("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    // Invalidate session from KV
    const { jwtVerify } = await import("jose");
    try {
      const secret  = new TextEncoder().encode(c.env.JWT_SECRET);
      const { payload } = await jwtVerify(auth.slice(7), secret) as { payload: { userId: string } };
      await c.env.SESSIONS_KV.delete(`session:${payload.userId}`);
    } catch {}
  }
  return c.json({ ok: true });
});

// One-time admin password initialisation — only works if PLATFORM_ADMIN_PASSWORD is set in env.
// Creates the admin user if they don't exist yet, or sets their password if they have none.
authRoutes.post("/admin-init", async (c) => {
  const adminEmail    = c.env.PLATFORM_ADMIN_EMAIL    ?? "admin@flypoomas.com";
  const adminPassword = c.env.PLATFORM_ADMIN_PASSWORD ?? "";

  if (!adminPassword) {
    throw new HTTPException(400, { message: "PLATFORM_ADMIN_PASSWORD not set in Cloudflare env" });
  }

  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.email, adminEmail), eq(users.tenantId, tenantId)))
    .limit(1);

  const passwordHash = await pbkdf2HashPassword(adminPassword);

  if (!user) {
    // User doesn't exist yet — create a fresh SUPER_ADMIN account
    await db.insert(users).values({
      tenantId,
      email:         adminEmail,
      name:          "POOMAS Admin",
      role:          "SUPER_ADMIN",
      passwordHash,
      isActive:      true,
      emailVerified: true,
    });
    return c.json({ ok: true, message: "Admin user created. You can now log in." });
  }

  if (user.passwordHash) {
    throw new HTTPException(409, { message: "Password already set — use login instead" });
  }

  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

  return c.json({ ok: true, message: "Admin password set. You can now log in." });
});

// OTP request (sends via WhatsApp/SMS — returns success regardless to prevent enumeration)
const otpSchema = z.object({ phone: z.string().min(8) });
authRoutes.post("/otp/request", zValidator("json", otpSchema), async (c) => {
  const { phone } = c.req.valid("json");
  const db        = c.get("db");
  const tenantId  = c.get("tenantId");

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, phone), eq(users.tenantId, tenantId)))
    .limit(1);

  if (user) {
    const otp    = Math.floor(100000 + Math.random() * 900000).toString();
    const otpKey = `otp:${tenantId}:${user.id}`;
    await c.env.SESSIONS_KV.put(otpKey, otp, { expirationTtl: 600 }); // 10 min TTL

    // Queue OTP delivery via NOTIFY_QUEUE
    await c.env.NOTIFY_QUEUE.send({
      type:    "NOTIFY_OTP",
      phone,
      otp,
      tenantId,
    });
  }

  // Always return 200 to prevent account enumeration
  return c.json({ ok: true, message: "OTP sent if account exists" });
});

export async function pbkdf2HashPassword(password: string): Promise<string> {
  const iterations = 100_000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hash(password, salt, iterations);
  return `pbkdf2:sha256:${iterations}:${bytesToHex(salt)}:${hash}`;
}

// Password hashing/verification using Web Crypto (PBKDF2 — no native argon2 on CF Workers)
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Hash format: pbkdf2:sha256:<iterations>:<salt_hex>:<hash_hex>
  const parts = hash.split(":");
  if (parts.length !== 5 || parts[0] !== "pbkdf2") return false;

  const [, , iters, saltHex, storedHash] = parts;
  const salt = hexToBytes(saltHex);
  const computed = await pbkdf2Hash(password, salt, Number(iters));

  return timingSafeEqual(computed, storedHash);
}

async function pbkdf2Hash(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key, 256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
