// B2B agency portal API.
//
// Public  /api/agent-public/*  agency sign-up, invite acceptance, shared quotes,
//                              agency mini-site (branding, prices, lead form), logos.
// Agency  /api/agent/*         (agent login) profile & branding, dashboard, team,
//                              wallet & statements, booking payment, deposits,
//                              service requests & support threads, KYC documents,
//                              saved travellers, quotes, offline ticket import.
// Trips   /api/agent/trips/*   the My Trips routes, scoped to the agency tree.

import { emailAgencyRegistered } from "../lib/transactional-emails.js";
import { assignAgentNumber, resolveAgentNumber } from "../lib/agent-number.js";
import { getBankAccounts, visibleAccounts } from "../lib/bank-accounts.js";
import {
  DOC_LABEL, DOC_TYPES, getOnboarding, onboardingStatus, printablePage, renderMou, sha256Hex, signatureBlock, type MouAcceptance,
} from "../lib/agent-onboarding.js";
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { SignJWT } from "jose";
import {
  agentDocuments, agentQuotes, agentRequestMessages, agentRequests, agentTravellers, agents, bookings, payments,
  users, walletAccounts, walletTransactions, markupRules, tenants,
} from "@poomas/db/schema";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@poomas/db";
import type { Env, Variables } from "../types.js";
import { pbkdf2HashPassword } from "./auth.js";
import {
  agentPricing, agentTier, agentWallet, assertAgentCanBook, AgentBlocked, audit, creditStatus, debitAgentWallet,
  descendantIds, getProgram, maybeLowBalanceAlert, monthlySales, rulesFor, settingsOf, updateSettings, type AgentSettings,
} from "../lib/agent-program.js";
import { emailShell, escapeHtml, money, notifyCustomer } from "../lib/customer-notify.js";
import { scanTicket } from "../lib/ticket-scan.js";
import { ScanError } from "../lib/document-scan.js";
import { roundMoney } from "../lib/customer-wallet.js";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const portalUrl = (env: Pick<Env, "PORTAL_URL">) => (env.PORTAL_URL || "https://portal.flypoomas.com").replace(/\/+$/, "");
const AGENT_ROLES = ["AGENT_ADMIN", "AGENT_STAFF", "AGENT_ACCOUNTANT"] as const;
const FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"];
const MAX_FILE = 8 * 1024 * 1024;

export const REQUEST_TYPES = ["DEPOSIT", "VISA", "PACKAGE", "UMRAH", "HOTEL", "INSURANCE", "BUS", "GROUP", "CHARTER", "AMENDMENT", "OFFLINE_BOOKING", "SUPPORT", "LEAD"] as const;
export const REQUEST_STATUSES = ["OPEN", "IN_PROGRESS", "QUOTED", "APPROVED", "REJECTED", "DONE", "CLOSED"] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function issueStaffToken(env: Env, db: Db, user: { id: string; tenantId: string; role: string; agentId: string | null }) {
  const token = await new SignJWT({ userId: user.id, tenantId: user.tenantId, role: user.role, agentId: user.agentId ?? undefined })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("24h")
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  await env.SESSIONS_KV.put(`session:${user.id}`, JSON.stringify({ userId: user.id, tenantId: user.tenantId, role: user.role }), { expirationTtl: 86400 });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return { token, expiresIn: 86400, role: user.role };
}

function randomToken(bytes = 24) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function saveUpload(env: Env, prefix: string, file: File) {
  if (!FILE_TYPES.includes(file.type)) throw new HTTPException(415, { message: "Upload a PDF, JPG, PNG, WEBP or HEIC file" });
  if (file.size > MAX_FILE) throw new HTTPException(413, { message: "Files must be under 8 MB" });
  const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
  const key = `${prefix}/${crypto.randomUUID()}-${safe}`;
  await env.DOCUMENTS_R2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  return { key, name: file.name.slice(0, 120), type: file.type, size: file.size };
}

async function filesFrom(c: Ctx, field = "files") {
  const form = await c.req.formData();
  return { form, files: form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0).slice(0, 10) };
}

const ip = (c: Ctx) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;

async function rateLimited(c: Ctx, name: string, limit: number) {
  const key = `agent_rl:${name}:${c.get("tenantId")}:${ip(c) ?? "x"}:${new Date().toISOString().slice(0, 13)}`;
  const used = Number(await c.env.SESSIONS_KV.get(key).catch(() => null) ?? 0);
  if (used >= limit) return true;
  c.executionCtx.waitUntil(c.env.SESSIONS_KV.put(key, String(used + 1), { expirationTtl: 3700 }).catch(() => {}));
  return false;
}

export function logoUrl(agentId: string, s: AgentSettings) {
  return s.logoKey ? `https://api.flypoomas.com/api/agent-public/logo/${agentId}?v=${encodeURIComponent(s.logoKey.slice(-12))}` : null;
}

export function publicBranding(a: { id: string; businessName: string; phone: string; email: string; whatsapp: string | null; settings: unknown }) {
  const s = settingsOf(a);
  return {
    agentId: a.id, name: s.displayName || a.businessName, logoUrl: logoUrl(a.id, s), color: s.brandColor || "#E31E24",
    phone: s.contactPhone || a.whatsapp || a.phone, email: s.contactEmail || a.email, address: s.address ?? null,
  };
}

// ── Public routes ────────────────────────────────────────────────────────────

export const agentPublicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  ownerName:    z.string().trim().min(2).max(100),
  email:        z.string().trim().toLowerCase().email(),
  phone:        z.string().trim().min(8).max(20),
  whatsapp:     z.string().trim().min(8).max(20).optional(),
  region:       z.enum(["INDIA", "GCC"]),
  currency:     z.enum(["INR", "AED", "USD"]),
  iataCode:     z.string().trim().max(20).optional(),
  gstNumber:    z.string().trim().max(20).optional(),
  address:      z.string().trim().max(300).optional(),
  password:     z.string().min(8).max(200),
});

// Agency self sign-up: agency (PENDING) + wallet + admin login, signed in straight away.
agentPublicRoutes.post("/register", zValidator("json", registerSchema, (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the form" }, 400);
}), async (c) => {
  const b = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  if (await rateLimited(c, "register", 10)) return c.json({ error: "Too many sign-ups from this network. Try again later." }, 429);
  const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${b.email}`)).limit(1);
  const [takenAgent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.email, b.email))).limit(1);
  if (taken || takenAgent) return c.json({ error: "This email is already registered. Please sign in." }, 409);

  const [agent] = await db.insert(agents).values({
    tenantId, businessName: b.businessName, ownerName: b.ownerName, email: b.email, phone: b.phone, whatsapp: b.whatsapp ?? null,
    region: b.region, currency: b.currency, iataCode: b.iataCode || null, status: "PENDING",
    settings: { ...(b.gstNumber ? { gstNumber: b.gstNumber.toUpperCase() } : {}), ...(b.address ? { address: b.address } : {}) },
  }).returning();
  await db.insert(walletAccounts).values({ tenantId, agentId: agent.id, currency: b.currency }).onConflictDoNothing();
  await assignAgentNumber(db, tenantId, agent.id).catch((err) => console.error("[agent-number]", err));
  c.executionCtx.waitUntil(emailAgencyRegistered(c.env, db, { id: agent.id, tenantId, email: agent.email, businessName: agent.businessName, ownerName: agent.ownerName }).catch(() => {}));
  const [user] = await db.insert(users).values({
    tenantId, name: b.ownerName, email: b.email, phone: b.phone, passwordHash: await pbkdf2HashPassword(b.password),
    role: "AGENT_ADMIN", agentId: agent.id, isActive: true, emailVerified: false,
  }).returning();
  await audit(db, { tenantId, userId: user.id, action: "AGENT_REGISTERED", entity: "Agent", entityId: agent.id, after: { businessName: agent.businessName }, ip: ip(c) });
  return c.json({ ...(await issueStaffToken(c.env, db, { id: user.id, tenantId, role: user.role, agentId: agent.id })), agentId: agent.id, status: agent.status }, 201);
});

// Leadvyne Live Agency onboarding form: confirm an agent number and show the agency's currency.
agentPublicRoutes.get("/agent-number/:number", async (c) => {
  if (await rateLimited(c, "agentno", 60)) return c.json({ error: "Too many checks. Try again later." }, 429);
  const agent = await resolveAgentNumber(c.env, c.get("db"), c.get("tenantId"), c.req.param("number"));
  if (!agent || agent.status !== "APPROVED") return c.json({ valid: false }, 404);
  return c.json({ valid: true, agentNumber: agent.number, businessName: agent.businessName, currency: agent.currency });
});

// ── Password reset (agency logins) ────────────────────────────────────────────
// Always answers the same way so the form can't be used to find which emails exist.
const RESET_TTL = 60 * 60;
export async function sendAgentPasswordReset(env: Env, db: Db, tenantId: string, userId: string, email: string, name: string | null) {
  const token = randomToken();
  await env.SESSIONS_KV.put(`agent_pwreset:${token}`, JSON.stringify({ tenantId, userId }), { expirationTtl: RESET_TTL });
  const link = `${portalUrl(env)}/reset-password?token=${token}`;
  await notifyCustomer(env, db, tenantId, {
    email, category: "auth", subject: "Reset your FlyPoomas agent portal password",
    html: emailShell("Reset your password", `<p>Hi ${escapeHtml(name || "there")}, use the button below to choose a new password for the FlyPoomas agent portal. The link works for 1 hour. If you didn't ask for this, ignore this email.</p>`, { label: "Choose a new password", href: link }),
    whatsapp: "",
  });
  return link;
}

agentPublicRoutes.post("/password/forgot", zValidator("json", z.object({ email: z.string().trim().toLowerCase().email() })), async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  if (await rateLimited(c, "pwforgot", 10)) return c.json({ error: "Too many requests. Try again in an hour." }, 429);
  const { email } = c.req.valid("json");
  const reply = c.json({ ok: true, message: "If this email has an agency login, we've sent a reset link. Check your inbox (and spam)." });
  const [u] = await db.select({ id: users.id, name: users.name, role: users.role, isActive: users.isActive }).from(users)
    .where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${email}`)).limit(1);
  if (u) {
    if (u.isActive && (AGENT_ROLES as readonly string[]).includes(u.role)) {
      c.executionCtx.waitUntil(sendAgentPasswordReset(c.env, db, tenantId, u.id, email, u.name).catch((err) => console.error("[pw-reset]", err)));
    }
    return reply;
  }
  // An agency created by FlyPoomas that never set up its login: send a fresh invitation.
  const [a] = await db.select({ id: agents.id, businessName: agents.businessName, ownerName: agents.ownerName, status: agents.status }).from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.email, email))).limit(1);
  if (a && a.status !== "REJECTED") {
    c.executionCtx.waitUntil(createInvite(c.env, db, { tenantId, agentId: a.id, email, name: a.ownerName, role: "AGENT_ADMIN", invitedBy: null }, a.businessName).catch((err) => console.error("[pw-invite]", err)));
  }
  return reply;
});

agentPublicRoutes.get("/password/reset/:token", async (c) => {
  const t = await c.env.SESSIONS_KV.get(`agent_pwreset:${c.req.param("token")}`, "json") as { tenantId: string; userId: string } | null;
  if (!t || t.tenantId !== c.get("tenantId")) return c.json({ error: "This reset link has expired. Ask for a new one." }, 404);
  const [u] = await c.get("db").select({ email: users.email }).from(users).where(eq(users.id, t.userId)).limit(1);
  return c.json({ email: u?.email ?? "" });
});

agentPublicRoutes.post("/password/reset/:token", zValidator("json", z.object({ password: z.string().min(8, "Use at least 8 characters").max(200) }), (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Choose a stronger password" }, 400);
}), async (c) => {
  const db = c.get("db");
  const k = `agent_pwreset:${c.req.param("token")}`;
  const t = await c.env.SESSIONS_KV.get(k, "json") as { tenantId: string; userId: string } | null;
  if (!t || t.tenantId !== c.get("tenantId")) return c.json({ error: "This reset link has expired. Ask for a new one." }, 404);
  await c.env.SESSIONS_KV.delete(k);   // one use only
  const [u] = await db.update(users).set({ passwordHash: await pbkdf2HashPassword(c.req.valid("json").password), emailVerified: true, updatedAt: new Date() })
    .where(and(eq(users.id, t.userId), eq(users.tenantId, t.tenantId))).returning({ id: users.id, email: users.email, agentId: users.agentId });
  if (!u) return c.json({ error: "This login no longer exists." }, 404);
  await c.env.SESSIONS_KV.delete(`session:${u.id}`).catch(() => {});
  await audit(db, { tenantId: t.tenantId, userId: u.id, action: "AGENT_PASSWORD_RESET", entity: "User", entityId: u.id, after: { via: "email link" }, ip: ip(c) });
  return c.json({ ok: true, email: u.email });
});

interface Invite { tenantId: string; agentId: string; email: string; name: string; role: (typeof AGENT_ROLES)[number]; invitedBy: string | null }

agentPublicRoutes.get("/invite/:token", async (c) => {
  const inv = await c.env.SESSIONS_KV.get(`agent_invite:${c.req.param("token")}`, "json") as Invite | null;
  if (!inv || inv.tenantId !== c.get("tenantId")) return c.json({ error: "This invitation has expired. Ask your agency to send a new one." }, 404);
  const [a] = await c.get("db").select({ businessName: agents.businessName }).from(agents).where(eq(agents.id, inv.agentId)).limit(1);
  return c.json({ email: inv.email, name: inv.name, role: inv.role, businessName: a?.businessName ?? "" });
});

agentPublicRoutes.post("/invite/:token/accept", zValidator("json", z.object({
  name: z.string().trim().min(2).max(100), password: z.string().min(8).max(200), phone: z.string().trim().max(20).optional(),
})), async (c) => {
  const db = c.get("db");
  const key = `agent_invite:${c.req.param("token")}`;
  const inv = await c.env.SESSIONS_KV.get(key, "json") as Invite | null;
  if (!inv || inv.tenantId !== c.get("tenantId")) return c.json({ error: "This invitation has expired. Ask your agency to send a new one." }, 404);
  const b = c.req.valid("json");
  const [existing] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, inv.tenantId), sql`lower(${users.email}) = ${inv.email}`)).limit(1);
  if (existing) return c.json({ error: "This email already has a login. Please sign in." }, 409);
  const [user] = await db.insert(users).values({
    tenantId: inv.tenantId, name: b.name, email: inv.email, phone: b.phone || null, passwordHash: await pbkdf2HashPassword(b.password),
    role: inv.role, agentId: inv.agentId, isActive: true, emailVerified: true,
  }).returning();
  await c.env.SESSIONS_KV.delete(key);
  await audit(db, { tenantId: inv.tenantId, userId: user.id, action: "AGENT_USER_JOINED", entity: "Agent", entityId: inv.agentId, after: { email: inv.email, role: inv.role }, ip: ip(c) });
  return c.json(await issueStaffToken(c.env, db, { id: user.id, tenantId: inv.tenantId, role: user.role, agentId: inv.agentId }), 201);
});

agentPublicRoutes.get("/logo/:agentId", async (c) => {
  const [a] = await c.get("db").select({ settings: agents.settings }).from(agents).where(eq(agents.id, c.req.param("agentId"))).limit(1);
  const key = settingsOf(a).logoKey;
  const obj = key ? await c.env.PUBLIC_ASSETS_R2.get(key) : null;
  if (!obj) return c.json({ error: "No logo" }, 404);
  return new Response(obj.body as unknown as BodyInit, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "image/png", "Cache-Control": "public, max-age=86400" } });
});

agentPublicRoutes.get("/quote/:token", async (c) => {
  const db = c.get("db");
  const [q] = await db.select().from(agentQuotes).where(and(eq(agentQuotes.token, c.req.param("token")), eq(agentQuotes.tenantId, c.get("tenantId")))).limit(1);
  if (!q) return c.json({ error: "Quote not found" }, 404);
  const [a] = await db.select().from(agents).where(eq(agents.id, q.agentId)).limit(1);
  if (!q.viewedAt) c.executionCtx.waitUntil(db.update(agentQuotes).set({ viewedAt: new Date() }).where(eq(agentQuotes.id, q.id)).then(() => {}));
  return c.json({
    quote: { customerName: q.customerName, options: q.options, note: q.note, currency: q.currency, expiresAt: q.expiresAt, createdAt: q.createdAt, expired: q.expiresAt.getTime() < Date.now() },
    agency: a ? publicBranding(a) : null,
  });
});

async function siteAgent(db: Db, tenantId: string, slug: string) {
  const [a] = await db.select().from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.status, "APPROVED"), sql`${agents.settings}->>'slug' = ${slug.toLowerCase()}`)).limit(1);
  return a && settingsOf(a).miniSite !== false ? a : null;
}

agentPublicRoutes.get("/site/:slug", async (c) => {
  const a = await siteAgent(c.get("db"), c.get("tenantId"), c.req.param("slug"));
  if (!a) return c.json({ error: "Agency page not found" }, 404);
  return c.json({ agency: { ...publicBranding(a), currency: a.currency } });
});

// Selling prices for fares found by the public search, as this agency would quote them.
agentPublicRoutes.post("/site/:slug/prices", zValidator("json", z.object({
  fares: z.array(z.object({
    id: z.string(), totalFare: z.number().positive(), displayPrice: z.number().positive().optional(),
    airline: z.string().optional(), origin: z.string().optional(), destination: z.string().optional(), supplier: z.string().optional(),
  })).max(200),
})), async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const a = await siteAgent(db, tenantId, c.req.param("slug"));
  if (!a) return c.json({ error: "Agency page not found" }, 404);
  const { applyMarkup } = await import("../lib/markup.js");
  const rules = await db.select().from(markupRules).where(eq(markupRules.tenantId, tenantId));
  const pricing = await agentPricing(c.env, db, tenantId, a.id);
  const prices = c.req.valid("json").fares.map((f) => {
    const company = applyMarkup({ ...f, cabinClass: "ECONOMY" } as never, rulesFor(rules, a.id));
    return { id: f.id, price: pricing.price(company).selling };
  });
  return c.json({ prices });
});

agentPublicRoutes.post("/site/:slug/lead", zValidator("json", z.object({
  name: z.string().trim().min(2).max(100), phone: z.string().trim().min(7).max(20), email: z.string().trim().email().optional(),
  message: z.string().trim().max(1000).optional(),
  trip: z.object({
    origin: z.string().max(3).optional(), destination: z.string().max(3).optional(), date: z.string().max(10).optional(),
    adults: z.number().int().min(1).max(9).optional(), fare: z.record(z.unknown()).optional(), price: z.number().optional(),
  }).optional(),
})), async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  if (await rateLimited(c, "lead", 10)) return c.json({ error: "Too many requests — please call the agency." }, 429);
  const a = await siteAgent(db, tenantId, c.req.param("slug"));
  if (!a) return c.json({ error: "Agency page not found" }, 404);
  const b = c.req.valid("json");
  const title = b.trip?.origin && b.trip?.destination ? `Enquiry: ${b.trip.origin} → ${b.trip.destination}${b.trip.date ? ` on ${b.trip.date}` : ""}` : "Website enquiry";
  const [r] = await db.insert(agentRequests).values({
    tenantId, agentId: a.id, type: "LEAD", status: "OPEN", title, details: { ...b, source: "mini-site" },
  }).returning({ id: agentRequests.id });
  c.executionCtx.waitUntil(notifyCustomer(c.env, db, tenantId, {
    email: a.email, phone: a.whatsapp ?? a.phone, category: "agency",
    subject: `New customer enquiry — ${b.name}`,
    html: emailShell("New enquiry from your FlyPoomas page", `<p><b>${escapeHtml(b.name)}</b> (${escapeHtml(b.phone)}) — ${escapeHtml(title)}</p>${b.message ? `<p>${escapeHtml(b.message)}</p>` : ""}`, { label: "Open in portal", href: `${portalUrl(c.env)}/requests/${r.id}` }),
    whatsapp: `🛎 *New enquiry* — ${b.name} (${b.phone})\n${title}${b.message ? `\n${b.message}` : ""}\nPortal: ${portalUrl(c.env)}/requests/${r.id}`,
  }).then(() => {}));
  return c.json({ ok: true, message: `Thanks! ${settingsOf(a).displayName || a.businessName} will contact you shortly.` }, 201);
});

// ── Agency routes (agent login) ──────────────────────────────────────────────

export const agentPortalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

agentPortalRoutes.use("*", async (c, next) => {
  if (!c.get("agentId") || !AGENT_ROLES.includes(c.get("userRole") as never)) {
    throw new HTTPException(403, { message: "Sign in with an agency account" });
  }
  return next();
});

const isAdmin = (c: Ctx) => c.get("userRole") === "AGENT_ADMIN";
const canMoney = (c: Ctx) => ["AGENT_ADMIN", "AGENT_ACCOUNTANT"].includes(c.get("userRole") ?? "");
function requireAdmin(c: Ctx) { if (!isAdmin(c)) throw new HTTPException(403, { message: "Only the agency admin can do this" }); }
function requireMoney(c: Ctx) { if (!canMoney(c)) throw new HTTPException(403, { message: "Only the agency admin or accountant can do this" }); }

async function me(c: Ctx) {
  const [a] = await c.get("db").select().from(agents).where(and(eq(agents.id, c.get("agentId")!), eq(agents.tenantId, c.get("tenantId")))).limit(1);
  if (!a) throw new HTTPException(404, { message: "Agency not found" });
  return a;
}

agentPortalRoutes.get("/me", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const a = await me(c);
  const s = settingsOf(a);
  const program = await getProgram(c.env, tenantId);
  const [wallet, tier, parent, user] = await Promise.all([
    agentWallet(db, tenantId, a.id),
    agentTier(db, tenantId, a.id, program),
    a.parentAgentId ? db.select({ businessName: agents.businessName }).from(agents).where(eq(agents.id, a.parentAgentId)).limit(1).then((r) => r[0] ?? null) : null,
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, c.get("userId")!)).limit(1).then((r) => r[0] ?? null),
  ]);
  const onboarding = await onboardingStatus(c.env, db, tenantId, a).catch(() => null);
  return c.json({
    agent: {
      id: a.id, businessName: a.businessName, ownerName: a.ownerName, email: a.email, phone: a.phone, whatsapp: a.whatsapp,
      region: a.region, currency: a.currency, status: a.status, iataCode: a.iataCode, parentAgentId: a.parentAgentId,
      parentName: parent?.businessName ?? null, createdAt: a.createdAt, agentNumber: a.agentNumber,
    },
    settings: { ...s, logoUrl: logoUrl(a.id, s) },
    user: { id: c.get("userId"), role: c.get("userRole"), name: user?.name ?? "", email: user?.email ?? "" },
    credit: creditStatus(wallet, s, program),
    onboarding,
    tier,
    program: { creditDays: program.creditDays, tiers: program.tiers },
  });
});

const settingsSchema = z.object({
  displayName:  z.string().trim().max(80).optional(),
  brandColor:   z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal("")),
  address:      z.string().trim().max(300).optional(),
  gstNumber:    z.string().trim().max(20).optional(),
  slug:         z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,40}$/, "Use 3–40 letters, numbers or dashes").optional().or(z.literal("")),
  miniSite:     z.boolean().optional(),
  ownMarkup:    z.object({ type: z.enum(["FLAT", "PERCENTAGE"]), value: z.number().min(0).max(100_000) }).nullable().optional(),
  whatsapp:     z.string().trim().max(20).optional(),
});

agentPortalRoutes.patch("/me/settings", zValidator("json", settingsSchema, (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the form" }, 400);
}), async (c) => {
  requireAdmin(c);
  const db = c.get("db");
  const b = c.req.valid("json");
  const a = await me(c);
  if (b.ownMarkup && b.ownMarkup.type === "PERCENTAGE" && b.ownMarkup.value > 50) return c.json({ error: "Selling markup can be at most 50%" }, 400);
  if (b.slug) {
    const [clash] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.tenantId, c.get("tenantId")), sql`${agents.settings}->>'slug' = ${b.slug}`, sql`${agents.id} <> ${a.id}`)).limit(1);
    if (clash) return c.json({ error: "That page address is taken — try another." }, 409);
  }
  const { whatsapp, ...rest } = b;
  const before = settingsOf(a);
  const next = await updateSettings(db, a.id, {
    ...rest,
    ...(rest.slug === "" ? { slug: undefined } : {}),
    ...(rest.contactEmail === "" ? { contactEmail: undefined } : {}),
    ...(rest.ownMarkup === null ? { ownMarkup: undefined } : {}),
    ...(rest.gstNumber ? { gstNumber: rest.gstNumber.toUpperCase() } : {}),
  } as Partial<AgentSettings>);
  if (whatsapp !== undefined) await db.update(agents).set({ whatsapp: whatsapp || null }).where(eq(agents.id, a.id));
  await audit(db, { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "AGENT_SETTINGS_UPDATED", entity: "Agent", entityId: a.id,
    before: { ownMarkup: before.ownMarkup ?? null, slug: before.slug ?? null }, after: { ownMarkup: next.ownMarkup ?? null, slug: next.slug ?? null }, ip: ip(c) });
  return c.json({ settings: { ...next, logoUrl: logoUrl(a.id, next) } });
});

agentPortalRoutes.post("/me/logo", async (c) => {
  requireAdmin(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("logo");
  if (!(file instanceof File) || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) return c.json({ error: "Upload a PNG, JPG or WEBP logo" }, 400);
  if (file.size > 1024 * 1024) return c.json({ error: "The logo must be under 1 MB" }, 413);
  const a = await me(c);
  const key = `agent-logos/${a.id}/${Date.now()}`;
  await c.env.PUBLIC_ASSETS_R2.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  const old = settingsOf(a).logoKey;
  const next = await updateSettings(c.get("db"), a.id, { logoKey: key });
  if (old) c.executionCtx.waitUntil(c.env.PUBLIC_ASSETS_R2.delete(old).catch(() => {}));
  return c.json({ logoUrl: logoUrl(a.id, next) });
});

// ── Dashboard ────────────────────────────────────────────────────────────────

agentPortalRoutes.get("/dashboard", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const a = await me(c);
  const scope = await descendantIds(db, tenantId, a.id);
  const program = await getProgram(c.env, tenantId);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const confirmed = inArray(bookings.status, ["CONFIRMED", "TICKETED"]);
  const [wallet, tier, todayRows, monthRows, pending, recent, openRequests, subCount] = await Promise.all([
    agentWallet(db, tenantId, a.id),
    agentTier(db, tenantId, a.id, program),
    db.select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${bookings.totalAmount}),0)` }).from(bookings)
      .where(and(eq(bookings.agentId, a.id), gte(bookings.createdAt, today), confirmed)),
    db.select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${bookings.totalAmount}),0)`, margin: sql<string>`coalesce(sum(${bookings.markup}),0)` }).from(bookings)
      .where(and(inArray(bookings.agentId, scope), gte(bookings.createdAt, monthStart), confirmed)),
    db.select({ id: bookings.id, status: bookings.status, origin: bookings.origin, destination: bookings.destination, departureDate: bookings.departureDate,
      totalAmount: bookings.totalAmount, currency: bookings.currency, heldUntil: bookings.heldUntil, pnr: bookings.pnr })
      .from(bookings).where(and(inArray(bookings.agentId, scope), inArray(bookings.status, ["HELD", "PAYMENT_PENDING"]), gte(bookings.createdAt, new Date(Date.now() - 3 * 86_400_000))))
      .orderBy(asc(bookings.heldUntil)).limit(20),
    db.select({ id: bookings.id, status: bookings.status, origin: bookings.origin, destination: bookings.destination, departureDate: bookings.departureDate,
      totalAmount: bookings.totalAmount, currency: bookings.currency, pnr: bookings.pnr, createdAt: bookings.createdAt, agentId: bookings.agentId })
      .from(bookings).where(inArray(bookings.agentId, scope)).orderBy(desc(bookings.createdAt)).limit(8),
    db.select({ n: sql<number>`count(*)::int` }).from(agentRequests).where(and(eq(agentRequests.agentId, a.id), inArray(agentRequests.status, ["OPEN", "IN_PROGRESS", "QUOTED"]))),
    db.select({ n: sql<number>`count(*)::int` }).from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.parentAgentId, a.id))),
  ]);
  const commissionRows = await db.select({ total: sql<string>`coalesce(sum(${walletTransactions.amount}),0)` }).from(walletTransactions)
    .where(and(eq(walletTransactions.walletAccountId, wallet?.id ?? "-"), eq(walletTransactions.type, "COMMISSION_CREDIT"), gte(walletTransactions.createdAt, monthStart)));
  return c.json({
    agent: { businessName: a.businessName, status: a.status, currency: a.currency, agentNumber: a.agentNumber },
    credit: creditStatus(wallet, settingsOf(a), program),
    tier,
    today: { bookings: todayRows[0]?.n ?? 0, value: Number(todayRows[0]?.total ?? 0) },
    month: { bookings: monthRows[0]?.n ?? 0, value: Number(monthRows[0]?.total ?? 0), earnings: Number(commissionRows[0]?.total ?? 0) },
    pending: pending.map((p) => ({ ...p, totalAmount: Number(p.totalAmount) })),
    recent: recent.map((r) => ({ ...r, totalAmount: Number(r.totalAmount), mine: r.agentId === a.id })),
    openRequests: openRequests[0]?.n ?? 0,
    subAgents: subCount[0]?.n ?? 0,
  });
});

// ── Team (staff logins) ──────────────────────────────────────────────────────

agentPortalRoutes.get("/users", async (c) => {
  const rows = await c.get("db").select({ id: users.id, name: users.name, email: users.email, phone: users.phone, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
    .from(users).where(and(eq(users.tenantId, c.get("tenantId")), eq(users.agentId, c.get("agentId")!))).orderBy(asc(users.createdAt));
  return c.json({ users: rows });
});

export async function createInvite(env: Env, db: Db, inv: Invite, businessName: string) {
  const token = randomToken();
  await env.SESSIONS_KV.put(`agent_invite:${token}`, JSON.stringify(inv), { expirationTtl: 7 * 86_400 });
  const link = `${portalUrl(env)}/accept-invite?token=${token}`;
  await notifyCustomer(env, db, inv.tenantId, {
    email: inv.email, category: "auth", subject: `You're invited to ${businessName} on FlyPoomas`,
    html: emailShell(`Join ${businessName} on FlyPoomas`, `<p>Hi ${escapeHtml(inv.name)}, you've been invited as <b>${inv.role.replace("AGENT_", "").toLowerCase()}</b>. Set your password to start booking. The link works for 7 days.</p>`, { label: "Accept invitation", href: link }),
    whatsapp: "",
  });
  return link;
}

agentPortalRoutes.post("/users/invite", zValidator("json", z.object({
  name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email(), role: z.enum(AGENT_ROLES),
})), async (c) => {
  requireAdmin(c);
  const db = c.get("db");
  const b = c.req.valid("json");
  const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, c.get("tenantId")), sql`lower(${users.email}) = ${b.email}`)).limit(1);
  if (taken) return c.json({ error: "This email already has a login." }, 409);
  const a = await me(c);
  const link = await createInvite(c.env, db, { tenantId: c.get("tenantId"), agentId: a.id, email: b.email, name: b.name, role: b.role, invitedBy: c.get("userId") ?? null }, a.businessName);
  await audit(db, { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "AGENT_USER_INVITED", entity: "Agent", entityId: a.id, after: { email: b.email, role: b.role }, ip: ip(c) });
  return c.json({ ok: true, link, message: `Invitation sent to ${b.email}.` }, 201);
});

agentPortalRoutes.patch("/users/:id", zValidator("json", z.object({ isActive: z.boolean().optional(), role: z.enum(AGENT_ROLES).optional() })), async (c) => {
  requireAdmin(c);
  const db = c.get("db");
  const id = c.req.param("id");
  if (id === c.get("userId")) return c.json({ error: "You can't change your own login here." }, 400);
  const b = c.req.valid("json");
  const [u] = await db.update(users).set({ ...b, updatedAt: new Date() })
    .where(and(eq(users.id, id), eq(users.agentId, c.get("agentId")!), eq(users.tenantId, c.get("tenantId")))).returning({ id: users.id });
  if (!u) return c.json({ error: "User not found" }, 404);
  if (b.isActive === false) await c.env.SESSIONS_KV.delete(`session:${id}`);
  await audit(db, { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "AGENT_USER_UPDATED", entity: "User", entityId: id, after: b, ip: ip(c) });
  return c.json({ ok: true });
});

// ── Wallet, statements, booking payment ──────────────────────────────────────

agentPortalRoutes.get("/wallet", async (c) => {
  const a = await me(c);
  const program = await getProgram(c.env, c.get("tenantId"));
  const wallet = await agentWallet(c.get("db"), c.get("tenantId"), a.id);
  return c.json({ currency: wallet?.currency ?? a.currency, credit: creditStatus(wallet, settingsOf(a), program), creditDays: program.creditDays });
});

async function statement(c: Ctx, from: Date, to: Date) {
  const db = c.get("db");
  const wallet = await agentWallet(db, c.get("tenantId"), c.get("agentId")!);
  if (!wallet) throw new HTTPException(404, { message: "Wallet not found" });
  const [opening] = await db.select({ balanceBefore: walletTransactions.balanceBefore }).from(walletTransactions)
    .where(and(eq(walletTransactions.walletAccountId, wallet.id), gte(walletTransactions.createdAt, from))).orderBy(asc(walletTransactions.createdAt)).limit(1);
  const rows = await db.select().from(walletTransactions)
    .where(and(eq(walletTransactions.walletAccountId, wallet.id), gte(walletTransactions.createdAt, from), lt(walletTransactions.createdAt, to)))
    .orderBy(asc(walletTransactions.createdAt)).limit(2000);
  const [prev] = opening ? [] : await db.select({ balanceAfter: walletTransactions.balanceAfter }).from(walletTransactions)
    .where(and(eq(walletTransactions.walletAccountId, wallet.id), lt(walletTransactions.createdAt, from))).orderBy(desc(walletTransactions.createdAt)).limit(1);
  const openingBalance = Number(opening?.balanceBefore ?? prev?.balanceAfter ?? 0);
  const credits = rows.filter((r) => Number(r.balanceAfter) > Number(r.balanceBefore)).reduce((s, r) => s + Number(r.amount), 0);
  const debits = rows.filter((r) => Number(r.balanceAfter) < Number(r.balanceBefore)).reduce((s, r) => s + Number(r.amount), 0);
  return {
    currency: wallet.currency, from: from.toISOString(), to: to.toISOString(),
    openingBalance, closingBalance: rows.length ? Number(rows[rows.length - 1].balanceAfter) : openingBalance,
    totalCredits: roundMoney(credits), totalDebits: roundMoney(debits),
    transactions: rows.map((r) => ({ id: r.id, date: r.createdAt, type: r.type, note: r.note, bookingId: r.bookingId,
      credit: Number(r.balanceAfter) > Number(r.balanceBefore) ? Number(r.amount) : 0, debit: Number(r.balanceAfter) < Number(r.balanceBefore) ? Number(r.amount) : 0,
      balance: Number(r.balanceAfter) })),
  };
}

const range = (c: Ctx) => {
  const now = new Date();
  const from = c.req.query("from") && /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from")!) ? new Date(`${c.req.query("from")}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const toDay = c.req.query("to") && /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to")!) ? new Date(`${c.req.query("to")}T00:00:00Z`) : now;
  return { from, to: new Date(Date.UTC(toDay.getUTCFullYear(), toDay.getUTCMonth(), toDay.getUTCDate() + 1)) };
};

agentPortalRoutes.get("/statement", async (c) => {
  requireMoney(c);
  const { from, to } = range(c);
  return c.json(await statement(c, from, to));
});

agentPortalRoutes.get("/statement.csv", async (c) => {
  requireMoney(c);
  const { from, to } = range(c);
  const st = await statement(c, from, to);
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Date", "Type", "Description", "Booking", "Credit", "Debit", "Balance"].map(esc).join(","),
    [st.from.slice(0, 10), "OPENING", "Opening balance", "", "", "", st.openingBalance.toFixed(2)].map(esc).join(","),
    ...st.transactions.map((t) => [new Date(t.date).toISOString().replace("T", " ").slice(0, 16), t.type, t.note ?? "", t.bookingId?.slice(0, 8).toUpperCase() ?? "",
      t.credit ? t.credit.toFixed(2) : "", t.debit ? t.debit.toFixed(2) : "", t.balance.toFixed(2)].map(esc).join(",")),
    ["", "CLOSING", "Closing balance", "", st.totalCredits.toFixed(2), st.totalDebits.toFixed(2), st.closingBalance.toFixed(2)].map(esc).join(","),
  ];
  return new Response(lines.join("\r\n"), { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="statement-${st.from.slice(0, 10)}-to-${new Date(to.getTime() - 1).toISOString().slice(0, 10)}.csv"`,
  } });
});

// Card / UPI top-up through Nomod. The webhook credits the wallet when the
// charge completes (agent_topup:<linkId> in KV identifies the agency).
agentPortalRoutes.post("/wallet/topup", zValidator("json", z.object({ amount: z.number().min(100).max(5_000_000) })), async (c) => {
  requireMoney(c);
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const a = await me(c);
  const wallet = await agentWallet(db, tenantId, a.id);
  if (!wallet) return c.json({ error: "Wallet not found" }, 404);
  const settings = await c.env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:payments`, "json").catch(() => null) as { nomod?: { enabled?: boolean; apiKey?: string } } | null;
  const apiKey = settings?.nomod?.apiKey || c.env.NOMOD_API_KEY;
  if (!settings?.nomod?.enabled || !apiKey) return c.json({ error: "Online top-up isn't available right now. Use bank transfer and submit the receipt." }, 503);
  const { amount } = c.req.valid("json");
  const res = await fetch("https://api.nomod.com/v1/links", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({
      currency: wallet.currency,
      items: [{ name: `Wallet top-up · ${a.businessName}`.slice(0, 80), amount: amount.toFixed(2), quantity: 1 }],
      title: "FlyPoomas agent wallet top-up", note: `Agency ${a.id}`,
      shipping_address_required: false, allow_tip: false, allow_tabby: false, allow_tamara: false, allow_service_fee: false, payment_expiry_limit: 1,
      success_url: `${portalUrl(c.env)}/wallet?topup=success`, failure_url: `${portalUrl(c.env)}/wallet?topup=failed`,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const raw = res ? await res.text() : "";
  let link: { id?: string; url?: string; error?: { message?: string } } = {};
  try { link = raw ? JSON.parse(raw) : {}; } catch {}
  if (!res?.ok || !link.id || !link.url) return c.json({ error: `The payment page couldn't open${link.error?.message ? ` (${link.error.message})` : ""}. Try again or use bank transfer.` }, 502);
  await c.env.SESSIONS_KV.put(`agent_topup:${link.id}`, JSON.stringify({ tenantId, agentId: a.id, walletId: wallet.id, amount, currency: wallet.currency, userId: c.get("userId") ?? null }), { expirationTtl: 7 * 86_400 });
  return c.json({ paymentUrl: link.url });
});

// Pay a held / pending agency booking from the agency wallet (balance + credit).
agentPortalRoutes.post("/bookings/:id/pay", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const agentId = c.get("agentId")!;
  const id = c.req.param("id");
  const [b] = await db.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.tenantId, tenantId))).limit(1);
  if (!b || b.agentId !== agentId) return c.json({ error: "Booking not found" }, 404);
  if (!["HELD", "PAYMENT_PENDING"].includes(b.status)) return c.json({ error: `This booking is ${b.status.toLowerCase().replace("_", " ")}.` }, 409);
  if (b.status === "HELD" && b.heldUntil && b.heldUntil.getTime() < Date.now()) return c.json({ error: "This hold has expired and the airline has released the seats." }, 409);
  try { await assertAgentCanBook(c.env, db, tenantId, agentId); } catch (err) {
    if (err instanceof AgentBlocked && err.code !== "VELOCITY_LIMIT") return c.json({ error: err.message, errorCode: err.code }, 403);
    if (!(err instanceof AgentBlocked)) throw err;
  }
  const [paid] = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.bookingId, id), eq(payments.status, "SUCCESS"))).limit(1);
  if (paid) return c.json({ error: "This booking is already paid." }, 409);
  const wallet = await agentWallet(db, tenantId, agentId);
  if (!wallet) return c.json({ error: "Wallet not found" }, 404);
  if (wallet.currency !== b.currency) return c.json({ error: `Your wallet is in ${wallet.currency}; this booking is in ${b.currency}.` }, 400);

  const amount = roundMoney(Number(b.totalAmount));
  const orderId = `agentwallet_${id}`;
  // One wallet payment per booking (unique gateway payment id).
  const [slot] = await db.insert(payments).values({
    bookingId: id, gateway: "WALLET", gatewayOrderId: orderId, gatewayPaymentId: orderId,
    amount: amount.toFixed(2), currency: b.currency, status: "PENDING",
  }).onConflictDoNothing().returning({ id: payments.id });
  if (!slot) return c.json({ error: "A payment for this booking is already in progress." }, 409);
  const balance = await debitAgentWallet(db, wallet.id, amount, {
    bookingId: id, paymentId: orderId, performedById: c.get("userId") ?? undefined,
    note: `Booking ${id.slice(0, 8).toUpperCase()} · ${b.origin} → ${b.destination}`,
  });
  if (balance === null) {
    await db.delete(payments).where(eq(payments.id, slot.id));
    const credit = creditStatus(wallet, {}, await getProgram(c.env, tenantId));
    return c.json({ error: `Not enough balance. Available ${money(credit.available, wallet.currency)}, needed ${money(amount, wallet.currency)}. Top up your wallet.`, errorCode: "INSUFFICIENT_FUNDS" }, 402);
  }
  await db.update(payments).set({ status: "SUCCESS", updatedAt: new Date() }).where(eq(payments.id, slot.id));
  await db.update(bookings).set({ status: "PAYMENT_PENDING", updatedAt: new Date() }).where(eq(bookings.id, id));
  await c.env.BOOKING_QUEUE.send({ type: "PAYMENT_CAPTURED", gatewayPaymentId: orderId, orderId, amount });
  c.executionCtx.waitUntil(maybeLowBalanceAlert(c.env, db, tenantId, agentId).catch(() => {}));
  return c.json({ ok: true, bookingId: id, amount, balance });
});

// Invoice / credit note data for a booking (rendered and printed in the portal).
agentPortalRoutes.get("/bookings/:id/invoice", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const scope = await descendantIds(db, tenantId, c.get("agentId")!);
  const [b] = await db.select().from(bookings).where(and(eq(bookings.id, c.req.param("id")), eq(bookings.tenantId, tenantId))).limit(1);
  if (!b || !b.agentId || !scope.includes(b.agentId)) return c.json({ error: "Booking not found" }, 404);
  const [a] = await db.select().from(agents).where(eq(agents.id, b.agentId)).limit(1);
  const { bookingPassengers, bookingAmendments } = await import("@poomas/db/schema");
  const [pax, refunds] = await Promise.all([
    db.select({ firstName: bookingPassengers.firstName, lastName: bookingPassengers.lastName, type: bookingPassengers.passengerType }).from(bookingPassengers).where(eq(bookingPassengers.bookingId, b.id)),
    db.select({ id: bookingAmendments.id, refundAmount: bookingAmendments.refundAmount, supplierCharges: bookingAmendments.supplierCharges, refundedAt: bookingAmendments.refundedAt, refundStatus: bookingAmendments.refundStatus })
      .from(bookingAmendments).where(and(eq(bookingAmendments.bookingId, b.id), eq(bookingAmendments.refundStatus, "DONE"))),
  ]);
  const fd = (b.flightData ?? {}) as { agentPricing?: { selling?: number; net?: number } };
  return c.json({
    invoice: {
      number: `FP-${b.createdAt.toISOString().slice(0, 7).replace("-", "")}-${b.id.slice(0, 6).toUpperCase()}`,
      date: b.createdAt, bookingId: b.id, pnr: b.pnr, status: b.status, origin: b.origin, destination: b.destination,
      departureDate: b.departureDate, currency: b.currency, passengers: pax,
      fare: Number(b.baseFare ?? 0), serviceFee: Number(b.markup ?? 0), total: Number(b.totalAmount),
      sellingPrice: fd.agentPricing?.selling ?? null, gstNumber: b.gstNumber,
    },
    agency: a ? { ...publicBranding(a), businessName: a.businessName, gstNumber: settingsOf(a).gstNumber ?? null } : null,
    creditNotes: refunds.map((r) => ({ number: `CN-${r.id.slice(0, 8).toUpperCase()}`, amount: Number(r.refundAmount ?? 0), charges: Number(r.supplierCharges ?? 0), date: r.refundedAt })),
  });
});

// ── Requests (deposits, services, amendments, support, leads) ────────────────

const requestSchema = z.object({
  type: z.enum(REQUEST_TYPES).refine((t) => t !== "LEAD" && t !== "DEPOSIT", "Use the deposit form for top-ups"),
  title: z.string().trim().min(3).max(160),
  details: z.record(z.unknown()).default({}),
  bookingId: z.string().optional(),
});

agentPortalRoutes.get("/requests", async (c) => {
  const type = c.req.query("type");
  const rows = await c.get("db").select().from(agentRequests)
    .where(and(eq(agentRequests.agentId, c.get("agentId")!), ...(type && (REQUEST_TYPES as readonly string[]).includes(type) ? [eq(agentRequests.type, type)] : [])))
    .orderBy(desc(agentRequests.updatedAt)).limit(200);
  return c.json({ requests: rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) })) });
});

async function createRequest(c: Ctx, input: { type: string; title: string; details: Record<string, unknown>; bookingId?: string | null; amount?: number; currency?: string; attachments?: { key: string; name: string; type: string; size: number }[] }) {
  const db = c.get("db");
  if (input.bookingId) {
    const scope = await descendantIds(db, c.get("tenantId"), c.get("agentId")!);
    const [b] = await db.select({ agentId: bookings.agentId }).from(bookings).where(eq(bookings.id, input.bookingId)).limit(1);
    if (!b?.agentId || !scope.includes(b.agentId)) throw new HTTPException(404, { message: "Booking not found" });
  }
  const program = await getProgram(c.env, c.get("tenantId"));
  const [r] = await db.insert(agentRequests).values({
    tenantId: c.get("tenantId"), agentId: c.get("agentId")!, userId: c.get("userId") ?? null, bookingId: input.bookingId ?? null,
    type: input.type, title: input.title, details: input.details, attachments: input.attachments ?? [],
    ...(input.amount !== undefined ? { amount: input.amount.toFixed(2), currency: input.currency ?? null } : {}),
    dueAt: new Date(Date.now() + program.supportSlaHours * 3600_000),
  }).returning();
  return r;
}

agentPortalRoutes.post("/requests", zValidator("json", requestSchema, (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the form" }, 400);
}), async (c) => {
  const b = c.req.valid("json");
  const r = await createRequest(c, { type: b.type, title: b.title, details: b.details, bookingId: b.bookingId ?? null });
  return c.json({ request: r }, 201);
});

// Multipart version for requests that carry documents (visa, offline tickets…).
agentPortalRoutes.post("/requests/upload", async (c) => {
  const { form, files } = await filesFrom(c);
  const type = String(form.get("type") ?? "");
  const title = String(form.get("title") ?? "").trim();
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(String(form.get("details") ?? "{}")); } catch { return c.json({ error: "Invalid details" }, 400); }
  if (!(REQUEST_TYPES as readonly string[]).includes(type) || type === "LEAD" || type === "DEPOSIT") return c.json({ error: "Choose a request type" }, 400);
  if (title.length < 3) return c.json({ error: "Add a short title" }, 400);
  const attachments = [];
  for (const f of files) attachments.push(await saveUpload(c.env, `agent-requests/${c.get("agentId")}`, f));
  const bookingId = String(form.get("bookingId") ?? "") || null;
  const r = await createRequest(c, { type, title, details, bookingId, attachments });
  return c.json({ request: r }, 201);
});

// Company bank accounts the agency can pay into (Admin → Wallet recharges → Bank accounts).
agentPortalRoutes.get("/wallet/bank-accounts", async (c) => {
  const tenantId = c.get("tenantId");
  const wallet = await agentWallet(c.get("db"), tenantId, c.get("agentId")!);
  const settings = await c.env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:payments`, "json").catch(() => null) as { nomod?: { enabled?: boolean } } | null;
  return c.json({
    walletCurrency: wallet?.currency ?? null,
    onlineTopup: Boolean(settings?.nomod?.enabled),
    accounts: visibleAccounts(await getBankAccounts(c.env, tenantId), wallet?.currency ?? ""),
  });
});

// Bank transfer / cash deposit with a payment screenshot; credited once when staff approve it.
agentPortalRoutes.post("/deposits", async (c) => {
  requireMoney(c);
  const { form, files } = await filesFrom(c, "receipt");
  const amount = Number(form.get("amount"));
  const method = String(form.get("method") ?? "BANK_TRANSFER").slice(0, 30);
  const reference = String(form.get("reference") ?? "").trim().slice(0, 80);
  const bankAccountId = String(form.get("bankAccountId") ?? "").trim();
  if (!(amount > 0) || amount > 10_000_000) return c.json({ error: "Enter the amount you paid" }, 400);
  if (!files.length) return c.json({ error: "Upload the payment screenshot or receipt" }, 400);
  const bad = files.find((f) => !/^(image\/|application\/pdf$)/.test(f.type) || f.size > 8 * 1024 * 1024);
  if (bad) return c.json({ error: "The receipt must be a photo, screenshot or PDF under 8 MB" }, 400);
  const tenantId = c.get("tenantId");
  const accounts = (await getBankAccounts(c.env, tenantId)).filter((x) => x.active);
  const bank = bankAccountId ? accounts.find((x) => x.id === bankAccountId) : null;
  if (bankAccountId && !bank) return c.json({ error: "Choose one of the listed bank accounts" }, 400);
  if (method === "BANK_TRANSFER" && accounts.length && !bank) return c.json({ error: "Choose the bank account you paid into" }, 400);
  const a = await me(c);
  // The same transfer reference can't be credited twice.
  if (reference) {
    const [dup] = await c.get("db").select({ id: agentRequests.id, status: agentRequests.status }).from(agentRequests)
      .where(and(eq(agentRequests.agentId, a.id), eq(agentRequests.type, "DEPOSIT"), sql`lower(${agentRequests.details}->>'reference') = ${reference.toLowerCase()}`,
        inArray(agentRequests.status, ["OPEN", "IN_PROGRESS", "APPROVED"]))).limit(1);
    if (dup) return c.json({ error: `A deposit with reference ${reference} was already submitted (${dup.status.toLowerCase().replace("_", " ")}).` }, 409);
  }
  const attachments = [];
  for (const f of files) attachments.push(await saveUpload(c.env, `agent-deposits/${a.id}`, f));
  const r = await createRequest(c, {
    type: "DEPOSIT", title: `Deposit ${money(amount, a.currency)} · ${method.replace("_", " ").toLowerCase()}`,
    details: {
      method, reference, paidOn: String(form.get("paidOn") ?? "").slice(0, 10) || null,
      ...(bank ? { bankAccountId: bank.id, bankAccount: { label: bank.label, bankName: bank.bankName, accountNumber: bank.accountNumber, currency: bank.currency } } : {}),
    },
    amount, currency: a.currency, attachments,
  });
  return c.json({ request: r, message: "Deposit submitted. It's added to your wallet once our team checks the payment." }, 201);
});

async function ownRequest(c: Ctx, id: string) {
  const [r] = await c.get("db").select().from(agentRequests).where(and(eq(agentRequests.id, id), eq(agentRequests.agentId, c.get("agentId")!))).limit(1);
  if (!r) throw new HTTPException(404, { message: "Request not found" });
  return r;
}

agentPortalRoutes.get("/requests/:id", async (c) => {
  const r = await ownRequest(c, c.req.param("id"));
  const messages = await c.get("db").select().from(agentRequestMessages).where(eq(agentRequestMessages.requestId, r.id)).orderBy(asc(agentRequestMessages.createdAt));
  return c.json({ request: { ...r, amount: r.amount === null ? null : Number(r.amount) }, messages });
});

agentPortalRoutes.post("/requests/:id/messages", async (c) => {
  const r = await ownRequest(c, c.req.param("id"));
  let message = "";
  const attachments = [];
  if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    const { form, files } = await filesFrom(c);
    message = String(form.get("message") ?? "").trim();
    for (const f of files) attachments.push(await saveUpload(c.env, `agent-requests/${r.agentId}`, f));
  } else {
    message = String((await c.req.json().catch(() => ({})) as { message?: string }).message ?? "").trim();
  }
  if (!message && !attachments.length) return c.json({ error: "Write a message" }, 400);
  const db = c.get("db");
  const [m] = await db.insert(agentRequestMessages).values({ requestId: r.id, userId: c.get("userId") ?? null, fromStaff: false, message: message.slice(0, 4000) || "(attachment)", attachments }).returning();
  await db.update(agentRequests).set({ updatedAt: new Date(), ...(["DONE", "CLOSED", "REJECTED"].includes(r.status) ? { status: "OPEN" } : {}) }).where(eq(agentRequests.id, r.id));
  return c.json({ message: m }, 201);
});

agentPortalRoutes.post("/requests/:id/close", async (c) => {
  const r = await ownRequest(c, c.req.param("id"));
  await c.get("db").update(agentRequests).set({ status: "CLOSED", updatedAt: new Date() }).where(eq(agentRequests.id, r.id));
  return c.json({ ok: true });
});

// Download an attachment of a request (index into request + message attachments).
agentPortalRoutes.get("/requests/:id/file", async (c) => {
  const r = await ownRequest(c, c.req.param("id"));
  const key = c.req.query("key") ?? "";
  const msgs = await c.get("db").select({ attachments: agentRequestMessages.attachments }).from(agentRequestMessages).where(eq(agentRequestMessages.requestId, r.id));
  const all = [...r.attachments, ...msgs.flatMap((m) => m.attachments)];
  const file = all.find((f) => f.key === key);
  if (!file) return c.json({ error: "File not found" }, 404);
  const obj = await c.env.DOCUMENTS_R2.get(file.key);
  if (!obj) return c.json({ error: "File not found" }, 404);
  return new Response(obj.body as unknown as BodyInit, { headers: { "Content-Type": file.type, "Content-Disposition": `inline; filename="${file.name.replace(/"/g, "")}"` } });
});

// ── KYC documents ────────────────────────────────────────────────────────────


agentPortalRoutes.get("/documents", async (c) => {
  const rows = await c.get("db").select({ id: agentDocuments.id, docType: agentDocuments.docType, fileName: agentDocuments.fileName, mimeType: agentDocuments.mimeType,
    uploadedAt: agentDocuments.uploadedAt, verifiedAt: agentDocuments.verifiedAt })
    .from(agentDocuments).where(eq(agentDocuments.agentId, c.get("agentId")!)).orderBy(desc(agentDocuments.uploadedAt));
  return c.json({ documents: rows, types: DOC_TYPES, labels: DOC_LABEL });
});

agentPortalRoutes.post("/documents", async (c) => {
  requireAdmin(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  const docType = String(form?.get("docType") ?? "");
  if (!(DOC_TYPES as readonly string[]).includes(docType)) return c.json({ error: "Choose the document type" }, 400);
  if (!(file instanceof File)) return c.json({ error: "Attach the document" }, 400);
  const up = await saveUpload(c.env, `agent-kyc/${c.get("agentId")}`, file);
  const [d] = await c.get("db").insert(agentDocuments).values({ agentId: c.get("agentId")!, docType, fileUrl: up.key, fileName: up.name, mimeType: up.type }).returning();
  await audit(c.get("db"), { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "AGENT_KYC_UPLOADED", entity: "Agent", entityId: c.get("agentId")!, after: { docType }, ip: ip(c) });
  return c.json({ document: { id: d.id, docType: d.docType, fileName: d.fileName, uploadedAt: d.uploadedAt, verifiedAt: null } }, 201);
});

agentPortalRoutes.delete("/documents/:id", async (c) => {
  requireAdmin(c);
  const [d] = await c.get("db").delete(agentDocuments)
    .where(and(eq(agentDocuments.id, c.req.param("id")), eq(agentDocuments.agentId, c.get("agentId")!), sql`${agentDocuments.verifiedAt} IS NULL`)).returning();
  if (!d) return c.json({ error: "Only unverified documents can be removed" }, 409);
  c.executionCtx.waitUntil(c.env.DOCUMENTS_R2.delete(d.fileUrl).catch(() => {}));
  return c.json({ ok: true });
});

// ── Onboarding: required KYC + MOU ───────────────────────────────────────────

agentPortalRoutes.get("/onboarding", async (c) => {
  const a = await me(c);
  return c.json(await onboardingStatus(c.env, c.get("db"), c.get("tenantId"), a));
});

async function mouContext(c: Ctx) {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const a = await me(c);
  const [cfg, program, [t]] = await Promise.all([
    getOnboarding(c.env, tenantId), getProgram(c.env, tenantId),
    db.select({ name: tenants.name, companyName: tenants.companyName, supportEmail: tenants.supportEmail, supportPhone: tenants.supportPhone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
  ]);
  return { a, cfg, program, tenant: t ?? { name: "FlyPoomas" } };
}

// The MOU to review (generated from the agency's details), or the signed copy.
agentPortalRoutes.get("/mou", async (c) => {
  const { a, cfg, program, tenant } = await mouContext(c);
  const signed = (settingsOf(a) as { mou?: MouAcceptance }).mou;
  if (signed && signed.version === cfg.mouVersion) {
    const obj = await c.env.DOCUMENTS_R2.get(signed.r2Key).catch(() => null);
    if (obj) return c.json({ accepted: true, acceptance: { ...signed, ip: undefined, userAgent: undefined }, html: await new Response(obj.body as unknown as BodyInit).text(), version: signed.version });
  }
  const m = renderMou({ cfg, tenant, agent: a, program });
  return c.json({ accepted: false, html: m.html, ref: m.ref, version: cfg.mouVersion, hash: await sha256Hex(m.html) });
});

agentPortalRoutes.post("/mou/accept", zValidator("json", z.object({
  name: z.string().trim().min(3).max(100), designation: z.string().trim().min(2).max(80), agree: z.literal(true), hash: z.string().length(64),
}), (r, c) => {
  if (!r.success) return c.json({ error: "Type your full name and designation, and tick the box to accept" }, 400);
}), async (c) => {
  requireAdmin(c);
  const b = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const { a, cfg, program, tenant } = await mouContext(c);
  const existing = (settingsOf(a) as { mou?: MouAcceptance }).mou;
  if (existing && existing.version === cfg.mouVersion) return c.json({ error: "The MOU is already signed." }, 409);
  const m = renderMou({ cfg, tenant, agent: a, program });
  const hash = await sha256Hex(m.html);
  // The agency must accept exactly what it was shown.
  if (hash !== b.hash) return c.json({ error: "Your details changed while the MOU was open. Please review the updated MOU and accept again.", errorCode: "MOU_CHANGED" }, 409);
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, c.get("userId")!)).limit(1);
  const acceptedAt = new Date().toISOString();
  const r2Key = `agent-mou/${a.id}/v${cfg.mouVersion}-${acceptedAt.replace(/[:.]/g, "")}.html`;
  const acceptance: MouAcceptance = {
    version: cfg.mouVersion, acceptedAt, name: b.name, designation: b.designation, userId: c.get("userId") ?? null, email: u?.email ?? null,
    ip: ip(c), userAgent: c.req.header("user-agent")?.slice(0, 200) ?? null, hash, r2Key,
  };
  const frozen = m.html + signatureBlock({ company: m.company, cfg, acceptance, agentName: a.businessName });
  await c.env.DOCUMENTS_R2.put(r2Key, frozen, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await updateSettings(db, a.id, { mou: acceptance });
  await audit(db, { tenantId, userId: c.get("userId"), action: "AGENT_MOU_ACCEPTED", entity: "Agent", entityId: a.id, after: { version: cfg.mouVersion, name: b.name, designation: b.designation, hash }, ip: ip(c) });
  c.executionCtx.waitUntil(notifyCustomer(c.env, db, tenantId, {
    email: a.email, category: "agency", subject: `Your FlyPoomas MOU (${m.ref})`,
    html: emailShell("MOU signed", `<p>Thank you, ${escapeHtml(b.name)}. ${escapeHtml(a.businessName)}'s Memorandum of Understanding with FlyPoomas was accepted on ${escapeHtml(new Date(acceptedAt).toUTCString())}. A copy is below and in the agent portal under Profile, branding &amp; KYC.</p><hr>${frozen}`),
    whatsapp: "",
  }).catch(() => {}));
  return c.json({ ok: true, acceptedAt });
});

// Printable signed (or draft) MOU as a full HTML page.
agentPortalRoutes.get("/mou/print", async (c) => {
  const { a, cfg, program, tenant } = await mouContext(c);
  const signed = (settingsOf(a) as { mou?: MouAcceptance }).mou;
  let body = "";
  if (signed) {
    const obj = await c.env.DOCUMENTS_R2.get(signed.r2Key).catch(() => null);
    if (obj) body = await new Response(obj.body as unknown as BodyInit).text();
  }
  if (!body) body = renderMou({ cfg, tenant, agent: a, program }).html + `<p style="font-family:Arial;color:#b42318;text-align:center">Draft — not yet accepted</p>`;
  return new Response(printablePage(`MOU · ${a.businessName}`, body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
});

// ── Saved travellers ─────────────────────────────────────────────────────────

const travellerSchema = z.object({
  type: z.enum(["ADULT", "CHILD", "INFANT"]).default("ADULT"),
  firstName: z.string().trim().min(1).max(60), lastName: z.string().trim().min(1).max(60),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), gender: z.enum(["M", "F"]).nullable().optional(),
  nationality: z.string().trim().length(2).nullable().optional(),
  passportNumber: z.string().trim().max(20).nullable().optional(), passportExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(), email: z.string().trim().email().nullable().optional().or(z.literal("")),
  groupName: z.string().trim().max(60).nullable().optional(),
});

agentPortalRoutes.get("/travellers", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const rows = await c.get("db").select().from(agentTravellers)
    .where(and(eq(agentTravellers.agentId, c.get("agentId")!),
      ...(q ? [sql`lower(${agentTravellers.firstName} || ' ' || ${agentTravellers.lastName} || ' ' || coalesce(${agentTravellers.groupName}, '') || ' ' || coalesce(${agentTravellers.phone}, '')) LIKE ${`%${q}%`}`] : [])))
    .orderBy(asc(agentTravellers.lastName), asc(agentTravellers.firstName)).limit(500);
  return c.json({ travellers: rows });
});

agentPortalRoutes.post("/travellers", zValidator("json", travellerSchema), async (c) => {
  const b = c.req.valid("json");
  const [t] = await c.get("db").insert(agentTravellers).values({ ...b, email: b.email || null, nationality: b.nationality?.toUpperCase() ?? null, agentId: c.get("agentId")! }).returning();
  return c.json({ traveller: t }, 201);
});

agentPortalRoutes.put("/travellers/:id", zValidator("json", travellerSchema), async (c) => {
  const b = c.req.valid("json");
  const [t] = await c.get("db").update(agentTravellers).set({ ...b, email: b.email || null, nationality: b.nationality?.toUpperCase() ?? null, updatedAt: new Date() })
    .where(and(eq(agentTravellers.id, c.req.param("id")), eq(agentTravellers.agentId, c.get("agentId")!))).returning();
  if (!t) return c.json({ error: "Traveller not found" }, 404);
  return c.json({ traveller: t });
});

agentPortalRoutes.delete("/travellers/:id", async (c) => {
  await c.get("db").delete(agentTravellers).where(and(eq(agentTravellers.id, c.req.param("id")), eq(agentTravellers.agentId, c.get("agentId")!)));
  return c.json({ ok: true });
});

// ── Quotes ───────────────────────────────────────────────────────────────────

const quoteOption = z.object({
  airlineName: z.string().max(80), flightNumber: z.string().max(40).optional(), origin: z.string().max(3), destination: z.string().max(3),
  departureTime: z.string().max(30), arrivalTime: z.string().max(30).optional(), stops: z.number().int().min(0).max(5).optional(),
  duration: z.number().optional(), baggage: z.string().max(80).optional(), isRefundable: z.boolean().optional(),
  sellingPrice: z.number().positive(), note: z.string().max(200).optional(),
});

agentPortalRoutes.get("/quotes", async (c) => {
  const rows = await c.get("db").select().from(agentQuotes).where(eq(agentQuotes.agentId, c.get("agentId")!)).orderBy(desc(agentQuotes.createdAt)).limit(100);
  return c.json({ quotes: rows });
});

agentPortalRoutes.post("/quotes", zValidator("json", z.object({
  customerName: z.string().trim().max(100).optional(), customerPhone: z.string().trim().max(20).optional(),
  note: z.string().trim().max(1000).optional(), validHours: z.number().int().min(1).max(168).default(24),
  currency: z.enum(["INR", "AED", "USD"]).default("INR"), options: z.array(quoteOption).min(1).max(6),
})), async (c) => {
  const b = c.req.valid("json");
  const [q] = await c.get("db").insert(agentQuotes).values({
    tenantId: c.get("tenantId"), agentId: c.get("agentId")!, userId: c.get("userId") ?? null, token: randomToken(12),
    customerName: b.customerName || null, customerPhone: b.customerPhone || null, note: b.note || null, currency: b.currency,
    options: b.options, expiresAt: new Date(Date.now() + b.validHours * 3600_000),
  }).returning();
  return c.json({ quote: q, url: `${portalUrl(c.env)}/q/${q.token}` }, 201);
});

agentPortalRoutes.delete("/quotes/:id", async (c) => {
  await c.get("db").delete(agentQuotes).where(and(eq(agentQuotes.id, c.req.param("id")), eq(agentQuotes.agentId, c.get("agentId")!)));
  return c.json({ ok: true });
});

// ── Offline bookings: read another e-ticket, then register it for staff ──────

agentPortalRoutes.post("/import/ticket", async (c) => {
  if (await rateLimited(c, "ticket-scan", 30)) return c.json({ error: "Too many uploads — try again later." }, 429);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "Attach the e-ticket PDF or photo" }, 400);
  try {
    const ticket = await scanTicket(c.env, file);
    const stored = await saveUpload(c.env, `agent-offline/${c.get("agentId")}`, file);
    return c.json({ ticket, file: stored });
  } catch (err) {
    const e = err instanceof ScanError ? err : new ScanError(String(err), "SCAN_ERROR");
    console.error("[ticket-scan]", e.code, e.message);
    return c.json({ error: e.status < 500 ? e.message : "We couldn't read the ticket. Enter the details instead.", code: e.code }, e.status as 400 | 413 | 415 | 422 | 429 | 502 | 503);
  }
});

// Agency analytics: sales by month, routes and sub-agents.
agentPortalRoutes.get("/reports", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const scope = await descendantIds(db, tenantId, c.get("agentId")!);
  const { from, to } = range(c);
  const where = and(inArray(bookings.agentId, scope), gte(bookings.createdAt, from), lte(bookings.createdAt, to));
  const [byStatus, byRoute, byAgent] = await Promise.all([
    db.select({ status: bookings.status, n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${bookings.totalAmount}),0)` }).from(bookings).where(where).groupBy(bookings.status),
    db.select({ origin: bookings.origin, destination: bookings.destination, n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${bookings.totalAmount}),0)` })
      .from(bookings).where(and(where, inArray(bookings.status, ["CONFIRMED", "TICKETED"]))).groupBy(bookings.origin, bookings.destination).orderBy(desc(sql`count(*)`)).limit(10),
    db.select({ agentId: bookings.agentId, name: agents.businessName, n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${bookings.totalAmount}),0)` })
      .from(bookings).innerJoin(agents, eq(agents.id, bookings.agentId)).where(and(where, inArray(bookings.status, ["CONFIRMED", "TICKETED"]))).groupBy(bookings.agentId, agents.businessName),
  ]);
  return c.json({
    from: from.toISOString(), to: to.toISOString(),
    byStatus: byStatus.map((r) => ({ ...r, total: Number(r.total) })),
    topRoutes: byRoute.map((r) => ({ ...r, total: Number(r.total) })),
    byAgent: byAgent.map((r) => ({ ...r, total: Number(r.total) })),
    monthSales: await monthlySales(db, c.get("agentId")!),
  });
});

