// Admin panel users (full admins and staff).
//
// GET   /api/admin/me                          — the signed-in admin user, role and sections (any admin user)
// GET   /api/admin/users                       — list admin users                       (full admins)
// POST  /api/admin/users                       — add an admin or staff user, emailed invite or temporary password
// PATCH /api/admin/users/:id                   — name, role, sections, active
// POST  /api/admin/users/:id/password-reset    — email a reset link or set a temporary password
//
// Public: /api/auth/staff/forgot, /api/auth/staff/password/:token (GET, POST)

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { users } from "@poomas/db/schema";
import type { Env, Variables } from "../../types.js";
import {
  ADMIN_ROLES, adminUrl, forgetAdminUser, loadAdminUser, STAFF_SECTION_KEYS, STAFF_SECTIONS, tempPassword,
} from "../../lib/admin-access.js";
import { emailShell, escapeHtml, notifyCustomer } from "../../lib/customer-notify.js";
import { audit } from "../../lib/agent-program.js";
import { pbkdf2HashPassword } from "../auth.js";

type Db = Variables["db"];
type Ctx = { env: Env; get: (k: any) => any; req: { header(n: string): string | undefined }; json: any };

export const adminUsersRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
export const adminMeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
export const staffPasswordRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: "Admin (full access)", TENANT_ADMIN: "Admin (limited)", STAFF: "Staff" };

function requireFullAdmin(c: { get: (k: any) => any }) {
  if (c.get("userRole") !== "SUPER_ADMIN") throw new HTTPException(403, { message: "Only full admins can manage users" });
}

adminMeRoutes.get("/", async (c) => {
  const role = c.get("userRole");
  const userId = c.get("userId");
  const u = userId ? await loadAdminUser(c.env, c.get("db"), userId) : null;
  const sections = role === "STAFF" ? (u?.permissions ?? []) : STAFF_SECTION_KEYS;
  return c.json({
    user: u ? { id: u.id, name: u.name, email: u.email } : { id: null, name: "Service", email: null },
    role, roleLabel: ROLE_LABEL[role ?? ""] ?? role, fullAccess: role !== "STAFF", sections,
    canManageUsers: role === "SUPER_ADMIN",
  });
});

adminUsersRoutes.get("/", async (c) => {
  requireFullAdmin(c);
  const rows = await c.get("db").select({
    id: users.id, name: users.name, email: users.email, phone: users.phone, role: users.role, isActive: users.isActive,
    permissions: users.adminPermissions, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt, hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
  }).from(users).where(and(eq(users.tenantId, c.get("tenantId")), inArray(users.role, [...ADMIN_ROLES]))).orderBy(asc(users.createdAt));
  return c.json({ users: rows, sections: STAFF_SECTIONS.map(({ key, label }) => ({ key, label })), me: c.get("userId") ?? null });
});

const TOKEN_TTL = { invite: 7 * 86_400, reset: 3600 } as const;

async function sendPasswordLink(c: Ctx, db: Db, tenantId: string, u: { id: string; email: string; name: string | null }, kind: "invite" | "reset", origin?: string | null) {
  const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await c.env.SESSIONS_KV.put(`staff_pw:${token}`, JSON.stringify({ tenantId, userId: u.id, kind }), { expirationTtl: TOKEN_TTL[kind] });
  const link = `${adminUrl(c.env, origin)}/set-password?token=${token}`;
  const invite = kind === "invite";
  await notifyCustomer(c.env, db, tenantId, {
    email: u.email, category: "auth",
    subject: invite ? "You've been added to the FlyPoomas admin panel" : "Reset your FlyPoomas admin password",
    html: emailShell(invite ? "Welcome to FlyPoomas admin" : "Reset your password",
      `<p>Hi ${escapeHtml(u.name || "there")}, ${invite ? "you've been given access to the FlyPoomas admin panel. Choose your password to sign in. The link works for 7 days." : "use the button below to choose a new admin password. The link works for 1 hour. If you didn't ask for this, ignore this email."}</p>`,
      { label: invite ? "Set your password" : "Choose a new password", href: link }),
    whatsapp: "",
  });
  return link;
}

const permissionsSchema = z.array(z.enum(STAFF_SECTION_KEYS as [string, ...string[]])).max(STAFF_SECTION_KEYS.length);

adminUsersRoutes.post("/", zValidator("json", z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(20).optional(),
  role: z.enum(["SUPER_ADMIN", "STAFF"]),
  permissions: permissionsSchema.default([]),
  delivery: z.enum(["invite", "temporary"]).default("invite"),
  origin: z.string().max(200).optional(),
}), (r, c) => { if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the form" }, 400); }), async (c) => {
  requireFullAdmin(c);
  const b = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  if (b.role === "STAFF" && !b.permissions.length) return c.json({ error: "Tick at least one section for staff" }, 400);
  const [taken] = await db.select({ id: users.id, role: users.role }).from(users)
    .where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${b.email}`)).limit(1);
  if (taken) return c.json({ error: (ADMIN_ROLES as readonly string[]).includes(taken.role) ? "This person is already an admin user." : "This email is already used by a customer or agency login. Use a different email." }, 409);
  const temporary = b.delivery === "temporary" ? tempPassword() : null;
  const [u] = await db.insert(users).values({
    tenantId, name: b.name, email: b.email, phone: b.phone || null, role: b.role, isActive: true, emailVerified: false,
    adminPermissions: b.role === "STAFF" ? b.permissions : [],
    ...(temporary ? { passwordHash: await pbkdf2HashPassword(temporary) } : {}),
  }).returning({ id: users.id, email: users.email, name: users.name });
  const link = temporary ? null : await sendPasswordLink(c as unknown as Ctx, db, tenantId, { id: u.id, email: u.email!, name: u.name }, "invite", b.origin);
  await audit(db, { tenantId, userId: c.get("userId"), action: "ADMIN_USER_ADDED", entity: "User", entityId: u.id, after: { email: b.email, role: b.role, permissions: b.permissions } });
  return c.json({ id: u.id, email: u.email, link, temporaryPassword: temporary }, 201);
});

adminUsersRoutes.patch("/:id", zValidator("json", z.object({
  name: z.string().trim().min(2).max(100).optional(),
  role: z.enum(["SUPER_ADMIN", "STAFF"]).optional(),
  permissions: permissionsSchema.optional(),
  isActive: z.boolean().optional(),
})), async (c) => {
  requireFullAdmin(c);
  const b = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");
  const [u] = await db.select().from(users).where(and(eq(users.id, id), eq(users.tenantId, tenantId), inArray(users.role, [...ADMIN_ROLES]))).limit(1);
  if (!u) return c.json({ error: "Admin user not found" }, 404);
  const self = id === c.get("userId");
  if (self && (b.isActive === false || (b.role && b.role !== u.role))) return c.json({ error: "You can't deactivate yourself or change your own role." }, 400);
  const nextRole = b.role ?? u.role;
  const nextActive = b.isActive ?? u.isActive;
  const nextPerms = b.permissions ?? (u.adminPermissions as string[]);
  if (nextRole === "STAFF" && !nextPerms.length) return c.json({ error: "Tick at least one section for staff" }, 400);
  // Keep at least one active full admin.
  if (u.role === "SUPER_ADMIN" && u.isActive && (nextRole !== "SUPER_ADMIN" || !nextActive)) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, "SUPER_ADMIN"), eq(users.isActive, true)));
    if (n <= 1) return c.json({ error: "There must be at least one active full admin." }, 400);
  }
  await db.update(users).set({
    ...(b.name ? { name: b.name } : {}), role: nextRole as typeof u.role, isActive: nextActive,
    adminPermissions: nextRole === "STAFF" ? nextPerms : [], updatedAt: new Date(),
  }).where(eq(users.id, id));
  await forgetAdminUser(c.env, id);
  if (!nextActive) await c.env.SESSIONS_KV.delete(`session:${id}`).catch(() => {});
  await audit(db, { tenantId, userId: c.get("userId"), action: "ADMIN_USER_UPDATED", entity: "User", entityId: id,
    before: { role: u.role, isActive: u.isActive, permissions: u.adminPermissions }, after: { role: nextRole, isActive: nextActive, permissions: nextRole === "STAFF" ? nextPerms : [] } });
  return c.json({ ok: true });
});

adminUsersRoutes.post("/:id/password-reset", zValidator("json", z.object({ mode: z.enum(["link", "temporary"]), origin: z.string().max(200).optional() })), async (c) => {
  requireFullAdmin(c);
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [u] = await db.select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive }).from(users)
    .where(and(eq(users.id, c.req.param("id")), eq(users.tenantId, tenantId), inArray(users.role, [...ADMIN_ROLES]))).limit(1);
  if (!u || !u.email) return c.json({ error: "Admin user not found" }, 404);
  if (!u.isActive) return c.json({ error: "Activate this user first." }, 400);
  const { mode, origin } = c.req.valid("json");
  if (mode === "link") {
    const link = await sendPasswordLink(c as unknown as Ctx, db, tenantId, { id: u.id, email: u.email, name: u.name }, "reset", origin);
    await audit(db, { tenantId, userId: c.get("userId"), action: "ADMIN_PASSWORD_RESET_SENT", entity: "User", entityId: u.id });
    return c.json({ ok: true, email: u.email, link });
  }
  const temporary = tempPassword();
  await db.update(users).set({ passwordHash: await pbkdf2HashPassword(temporary), updatedAt: new Date() }).where(eq(users.id, u.id));
  await audit(db, { tenantId, userId: c.get("userId"), action: "ADMIN_PASSWORD_SET_BY_ADMIN", entity: "User", entityId: u.id });
  return c.json({ ok: true, email: u.email, temporaryPassword: temporary });
});

// ── Public: staff choose / reset their password ──────────────────────────────

staffPasswordRoutes.post("/forgot", zValidator("json", z.object({ email: z.string().trim().toLowerCase().email(), origin: z.string().max(200).optional() })), async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const { email, origin } = c.req.valid("json");
  const limitKey = `staff_rl:${tenantId}:${c.req.header("cf-connecting-ip") ?? "x"}:${new Date().toISOString().slice(0, 13)}`;
  const used = Number(await c.env.SESSIONS_KV.get(limitKey).catch(() => null) ?? 0);
  if (used >= 10) return c.json({ error: "Too many requests. Try again in an hour." }, 429);
  await c.env.SESSIONS_KV.put(limitKey, String(used + 1), { expirationTtl: 3600 }).catch(() => {});
  const [u] = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive }).from(users)
    .where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${email}`)).limit(1);
  if (u?.isActive && u.email && (ADMIN_ROLES as readonly string[]).includes(u.role)) {
    c.executionCtx.waitUntil(sendPasswordLink(c as unknown as Ctx, db, tenantId, { id: u.id, email: u.email, name: u.name }, "reset", origin).catch((err) => console.error("[staff-reset]", err)));
  }
  return c.json({ ok: true, message: "If this email has admin access, we've sent a reset link. Check your inbox (and spam)." });
});

staffPasswordRoutes.get("/password/:token", async (c) => {
  const t = await c.env.SESSIONS_KV.get(`staff_pw:${c.req.param("token")}`, "json") as { tenantId: string; userId: string; kind: string } | null;
  if (!t || t.tenantId !== c.get("tenantId")) return c.json({ error: "This link has expired. Ask an admin for a new one, or use Forgot password." }, 404);
  const [u] = await c.get("db").select({ email: users.email, name: users.name }).from(users).where(eq(users.id, t.userId)).limit(1);
  return c.json({ email: u?.email ?? "", name: u?.name ?? "", kind: t.kind });
});

staffPasswordRoutes.post("/password/:token", zValidator("json", z.object({ password: z.string().min(10, "Use at least 10 characters").max(200) }), (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Choose a stronger password" }, 400);
}), async (c) => {
  const db = c.get("db");
  const k = `staff_pw:${c.req.param("token")}`;
  const t = await c.env.SESSIONS_KV.get(k, "json") as { tenantId: string; userId: string } | null;
  if (!t || t.tenantId !== c.get("tenantId")) return c.json({ error: "This link has expired. Ask an admin for a new one, or use Forgot password." }, 404);
  await c.env.SESSIONS_KV.delete(k);   // one use only
  const [u] = await db.update(users).set({ passwordHash: await pbkdf2HashPassword(c.req.valid("json").password), emailVerified: true, updatedAt: new Date() })
    .where(and(eq(users.id, t.userId), eq(users.tenantId, t.tenantId), inArray(users.role, [...ADMIN_ROLES]), eq(users.isActive, true)))
    .returning({ id: users.id, email: users.email });
  if (!u) return c.json({ error: "This admin login is no longer active." }, 404);
  await forgetAdminUser(c.env, u.id);
  await audit(db, { tenantId: t.tenantId, userId: u.id, action: "ADMIN_PASSWORD_SET", entity: "User", entityId: u.id });
  return c.json({ ok: true, email: u.email });
});
