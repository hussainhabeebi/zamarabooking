// GET   /api/admin/leadvyne-agents                 — agencies with agent numbers + analytics (?days=30&source=leadvyne)
// POST  /api/admin/leadvyne-agents                 — create an agency account for a Leadvyne Live Agency client
// GET   /api/admin/leadvyne-agents/:id/daily       — day-by-day searches, checkout links, bookings
// PATCH /api/admin/leadvyne-agents/:id             — change currency / Leadvyne client id
// POST  /api/admin/leadvyne-agents/:id/invite      — send a new portal login invitation
// POST  /api/admin/leadvyne-agents/:id/number      — give an agent number to an agency that has none
// DELETE /api/admin/leadvyne-agents/:id            — delete an agency with no booking or money history

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { agents, users, walletAccounts } from "@zamrabooking/db/schema";
import type { Env, Variables } from "../../types.js";
import { DISPLAY_CURRENCIES, type DisplayCurrency } from "../../lib/fx.js";
import {
  assignAgentNumber, agentCurrency, currencyForCountry, forgetAgentNumber, regionForCountry, walletCurrencyFor,
} from "../../lib/agent-number.js";
import { agentDaily, agentStats } from "../../lib/agent-analytics.js";
import { audit } from "../../lib/agent-program.js";
import { createInvite } from "../agent-portal.js";
import { deleteAgent } from "../../lib/agent-delete.js";
import { requireRole } from "../../middleware/auth.js";

export const leadvyneAgentsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const settingsOf = (s: unknown) => (s ?? {}) as Record<string, unknown>;

leadvyneAgentsAdminRoutes.get("/", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const days = Math.min(365, Math.max(1, Number(c.req.query("days")) || 30));
  const onlyLeadvyne = c.req.query("source") === "leadvyne";
  const rows = await db.select({
    id: agents.id, agentNumber: agents.agentNumber, businessName: agents.businessName, ownerName: agents.ownerName,
    email: agents.email, phone: agents.phone, status: agents.status, currency: agents.currency, settings: agents.settings, createdAt: agents.createdAt,
  }).from(agents)
    .where(and(eq(agents.tenantId, tenantId), onlyLeadvyne ? sql`${agents.settings}->>'source' = 'LEADVYNE'` : undefined))
    .orderBy(desc(agents.createdAt)).limit(500);
  const stats = await agentStats(db, tenantId, rows.map((r) => r.id), days);
  const list = rows.map((r) => {
    const s = settingsOf(r.settings);
    return {
      id: r.id, agentNumber: r.agentNumber, businessName: r.businessName, ownerName: r.ownerName, email: r.email, phone: r.phone,
      status: r.status, currency: agentCurrency(r), walletCurrency: r.currency, country: (s.country as string) ?? null,
      source: (s.source as string) ?? "PORTAL", leadvyneClientId: (s.leadvyneClientId as string) ?? null,
      createdAt: r.createdAt, stats: stats.get(r.id),
    };
  });
  const totals = list.reduce((t, a) => {
    const s = a.stats!;
    t.searches += s.searchesPeriod; t.checkouts += s.checkoutsPeriod; t.bookings += s.bookingsPeriod; t.value += s.bookingValuePeriod;
    return t;
  }, { searches: 0, checkouts: 0, bookings: 0, value: 0 });
  return c.json({ days, totals, agents: list });
});

const createSchema = z.object({
  businessName: z.string().trim().min(2).max(150),
  ownerName:    z.string().trim().min(2).max(100),
  email:        z.string().trim().toLowerCase().email(),
  phone:        z.string().trim().min(6).max(20),
  whatsapp:     z.string().trim().max(20).optional(),
  country:      z.string().trim().length(2).toUpperCase(),
  currency:     z.enum(DISPLAY_CURRENCIES).optional(),    // empty = from the country
  leadvyneClientId: z.string().trim().max(60).optional(),
  sendInvite:   z.boolean().default(true),
});

leadvyneAgentsAdminRoutes.post("/", zValidator("json", createSchema, (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the form" }, 400);
}), async (c) => {
  const b = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const userId = c.get("userId") ?? null;

  const [takenAgent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.tenantId, tenantId), eq(agents.email, b.email))).limit(1);
  const [takenUser] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${b.email}`)).limit(1);
  if (takenAgent || takenUser) return c.json({ error: "An account with this email already exists." }, 409);

  const currency: DisplayCurrency = b.currency ?? currencyForCountry(b.country);
  const wallet = walletCurrencyFor(currency);
  const [agent] = await db.insert(agents).values({
    tenantId, businessName: b.businessName, ownerName: b.ownerName, email: b.email, phone: b.phone, whatsapp: b.whatsapp || null,
    region: regionForCountry(b.country), currency: wallet, status: "APPROVED", approvedAt: new Date(), approvedById: userId,
    settings: { source: "LEADVYNE", country: b.country, displayCurrency: currency, ...(b.leadvyneClientId ? { leadvyneClientId: b.leadvyneClientId } : {}) },
  }).returning();
  await db.insert(walletAccounts).values({ tenantId, agentId: agent.id, currency: wallet }).onConflictDoNothing();
  const agentNumber = await assignAgentNumber(db, tenantId, agent.id);

  let inviteLink: string | null = null;
  let inviteError: string | null = null;
  if (b.sendInvite) {
    try {
      inviteLink = await createInvite(c.env, db, { tenantId, agentId: agent.id, email: b.email, name: b.ownerName, role: "AGENT_ADMIN", invitedBy: userId }, b.businessName);
    } catch (err) {
      inviteError = err instanceof Error ? err.message : "Invitation not sent";
    }
  }
  await audit(db, { tenantId, userId, action: "LEADVYNE_AGENT_CREATED", entity: "Agent", entityId: agent.id, after: { businessName: agent.businessName, agentNumber, currency } });
  return c.json({ id: agent.id, agentNumber, businessName: agent.businessName, currency, walletCurrency: wallet, inviteLink, inviteError }, 201);
});

leadvyneAgentsAdminRoutes.get("/:id/daily", async (c) => {
  const days = Math.min(180, Math.max(7, Number(c.req.query("days")) || 30));
  return c.json({ days, series: await agentDaily(c.get("db"), c.get("tenantId"), c.req.param("id"), days) });
});

leadvyneAgentsAdminRoutes.patch("/:id", zValidator("json", z.object({
  currency: z.enum(DISPLAY_CURRENCIES).optional(),
  leadvyneClientId: z.string().trim().max(60).nullable().optional(),
})), async (c) => {
  const b = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [a] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  const settings = { ...settingsOf(a.settings) };
  if (b.currency) settings.displayCurrency = b.currency;
  if (b.leadvyneClientId !== undefined) {
    if (b.leadvyneClientId) settings.leadvyneClientId = b.leadvyneClientId; else delete settings.leadvyneClientId;
  }
  await db.update(agents).set({ settings, updatedAt: new Date() }).where(eq(agents.id, a.id));
  await forgetAgentNumber(c.env, tenantId, a.agentNumber);
  await audit(db, { tenantId, userId: c.get("userId") ?? null, action: "LEADVYNE_AGENT_UPDATED", entity: "Agent", entityId: a.id, before: { currency: agentCurrency(a) }, after: b });
  return c.json({ ok: true, currency: settings.displayCurrency ?? a.currency });
});

leadvyneAgentsAdminRoutes.post("/:id/invite", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [a] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  const [hasLogin] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.agentId, a.id), isNotNull(users.passwordHash))).limit(1);
  if (hasLogin) return c.json({ error: "This agency already has a login. They can reset the password from the portal." }, 409);
  const inviteLink = await createInvite(c.env, db, { tenantId, agentId: a.id, email: a.email, name: a.ownerName, role: "AGENT_ADMIN", invitedBy: c.get("userId") ?? null }, a.businessName);
  return c.json({ inviteLink });
});

leadvyneAgentsAdminRoutes.post("/:id/number", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  return c.json({ agentNumber: await assignAgentNumber(db, tenantId, a.id) });
});

leadvyneAgentsAdminRoutes.delete("/:id", async (c) => {
  requireRole("SUPER_ADMIN", "TENANT_ADMIN")(c.get("userRole"));
  const r = await deleteAgent(c.env, c.get("db"), { agentId: c.req.param("id"), tenantId: c.get("tenantId"), performedBy: c.get("userId") ?? null });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, businessName: r.businessName });
});
