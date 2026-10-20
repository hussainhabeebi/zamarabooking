import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { agents, agentDocuments, walletAccounts } from "@poomas/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { creditWallet, debitWallet, roundMoney } from "../lib/customer-wallet.js";
import { getAgentMarkup, setAgentMarkup } from "../lib/agent-markup.js";
import { audit } from "../lib/agent-program.js";
import { createInvite } from "./agent-portal.js";
import type { Env, Variables } from "../types.js";
import { requireRole } from "../middleware/auth.js";

export const agentRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const registerSchema = z.object({
  businessName:   z.string().min(2),
  ownerName:      z.string().min(2),
  email:          z.string().email(),
  phone:          z.string().min(8),
  whatsapp:       z.string().optional(),
  region:         z.enum(["INDIA", "GCC"]),
  currency:       z.enum(["INR", "AED", "USD"]),
  iataCode:       z.string().optional(),
  parentAgentId:  z.string().optional(),
});

// Agent self-registration (creates a PENDING agent record)
agentRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
  const body     = c.req.valid("json");
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.email, body.email)))
    .limit(1);

  if (existing) {
    throw new HTTPException(409, { message: "An agent with this email already exists" });
  }

  const [agent] = await db.insert(agents).values({
    tenantId,
    ...body,
    status: "PENDING",
  }).returning();

  // Create wallet account for agent
  await db.insert(walletAccounts).values({
    tenantId,
    agentId:  agent.id,
    currency: body.currency,
  });

  return c.json({ agentId: agent.id, status: "PENDING" }, 201);
});

// List all agents under this tenant (TENANT_ADMIN only)
agentRoutes.get("/", async (c) => {
  requireRole("TENANT_ADMIN", "SUPER_ADMIN")(c.get("userRole"));

  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const status   = c.req.query("status");

  const rows = await db
    .select()
    .from(agents)
    .where(
      status
        ? and(eq(agents.tenantId, tenantId), eq(agents.status, status as "PENDING"))
        : eq(agents.tenantId, tenantId),
    );

  return c.json(rows);
});

// Approve/reject agent (TENANT_ADMIN)
agentRoutes.patch("/:id/status", async (c) => {
  requireRole("TENANT_ADMIN", "SUPER_ADMIN")(c.get("userRole"));

  const body   = await c.req.json() as { status: "APPROVED" | "REJECTED" | "SUSPENDED" };
  const db     = c.get("db");
  const userId = c.get("userId")!;

  await db.update(agents).set({
    status:      body.status,
    approvedAt:  body.status === "APPROVED" ? new Date() : null,
    approvedById: userId,
    updatedAt:   new Date(),
  }).where(
    and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, c.get("tenantId"))),
  );

  return c.json({ ok: true });
});

// Invite a sub-agent (simpler form for portal — uses parent agent's region/currency)
const inviteSchema = z.object({
  businessName: z.string().min(2),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(8),
});

agentRoutes.post("/sub-agents/invite", zValidator("json", inviteSchema), async (c) => {
  const body     = c.req.valid("json");
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const agentId  = c.get("agentId");

  if (!agentId) throw new HTTPException(403, { message: "Agent auth required" });

  // Get parent agent's region/currency
  const [parent] = await db
    .select({ region: agents.region, currency: agents.currency })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.email, body.contactEmail)))
    .limit(1);

  if (existing) throw new HTTPException(409, { message: "Agent with this email already exists" });

  const [agent] = await db.insert(agents).values({
    tenantId,
    parentAgentId:  agentId,
    businessName:   body.businessName,
    ownerName:      body.businessName,
    email:          body.contactEmail,
    phone:          body.contactPhone,
    status:         "PENDING",
    region:         parent?.region ?? "INDIA",
    currency:       parent?.currency ?? "INR",
  }).returning();

  await db.insert(walletAccounts).values({
    tenantId,
    agentId:  agent.id,
    currency: parent?.currency ?? "INR",
  });

  // Login for the sub-agent's admin: an invitation link to set a password.
  const inviteLink = await createInvite(c.env, db, {
    tenantId, agentId: agent.id, email: body.contactEmail.toLowerCase(), name: body.businessName, role: "AGENT_ADMIN", invitedBy: c.get("userId") ?? null,
  }, body.businessName).catch(() => null);
  await audit(db, { tenantId, userId: c.get("userId"), action: "SUBAGENT_INVITED", entity: "Agent", entityId: agent.id, after: { parentAgentId: agentId, email: body.contactEmail } });

  return c.json({
    inviteLink,
    id:           agent.id,
    businessName: agent.businessName,
    contactEmail: agent.email,
    contactPhone: agent.phone,
    status:       agent.status,
    createdAt:    agent.createdAt,
  }, 201);
});

// Sub-agents of the currently authenticated agent
agentRoutes.get("/sub-agents", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const agentId  = c.get("agentId");

  if (!agentId) throw new HTTPException(403, { message: "Agent auth required" });

  const rows = await db
    .select({
      id:           agents.id,
      businessName: agents.businessName,
      contactEmail: agents.email,
      contactPhone: agents.phone,
      status:       agents.status,
      createdAt:    agents.createdAt,
    })
    .from(agents)
    .where(
      and(eq(agents.tenantId, tenantId), eq(agents.parentAgentId, agentId)),
    );

  // Each sub-account's own wallet and selling markup (set by this agent).
  const wallets = rows.length
    ? await db.select({ agentId: walletAccounts.agentId, balance: walletAccounts.balance, currency: walletAccounts.currency })
      .from(walletAccounts).where(inArray(walletAccounts.agentId, rows.map((r) => r.id)))
    : [];
  const enriched = await Promise.all(rows.map(async (r) => {
    const w = wallets.find((x) => x.agentId === r.id);
    return { ...r, walletBalance: w ? Number(w.balance) : 0, walletCurrency: w?.currency ?? null, markup: await getAgentMarkup(c.env, tenantId, r.id) };
  }));

  return c.json({ agents: enriched });
});

// ── Sub-account management (parent agent admin) ─────────────────────────────

async function ownSubAgent(c: any, subId: string) {
  const parentId = c.get("agentId") as string | undefined;
  if (!parentId) throw new HTTPException(403, { message: "Agent auth required" });
  requireRole("AGENT_ADMIN")(c.get("userRole"));
  const [sub] = await c.get("db").select({ id: agents.id, status: agents.status, businessName: agents.businessName, currency: agents.currency })
    .from(agents)
    .where(and(eq(agents.id, subId), eq(agents.tenantId, c.get("tenantId")), eq(agents.parentAgentId, parentId)))
    .limit(1);
  if (!sub) throw new HTTPException(404, { message: "Sub-agent not found" });
  return { parentId, sub };
}

// PUT /api/agents/sub-agents/:id/markup  { type: FLAT | PERCENTAGE, value } (value 0 removes it)
agentRoutes.put("/sub-agents/:id/markup", zValidator("json", z.object({
  type:  z.enum(["FLAT", "PERCENTAGE"]),
  value: z.number().min(0),
}).refine((m) => m.type === "PERCENTAGE" ? m.value <= 50 : m.value <= 100_000, { message: "Markup is too high (max 50% or 100,000 flat)" })), async (c) => {
  const { parentId, sub } = await ownSubAgent(c, c.req.param("id"));
  const body = c.req.valid("json");
  const markup = body.value > 0 ? { type: body.type, value: roundMoney(body.value), setBy: parentId, updatedAt: new Date().toISOString() } : null;
  const before = await getAgentMarkup(c.env, c.get("tenantId"), sub.id);
  await setAgentMarkup(c.env, c.get("tenantId"), sub.id, markup);
  await audit(c.get("db"), { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "SUBAGENT_MARKUP_SET", entity: "Agent", entityId: sub.id, before, after: markup });
  return c.json({ ok: true, markup });
});

// POST /api/agents/sub-agents/:id/transfer  { amount, direction: TO_SUB | TO_PARENT }
// Moves balance between the parent's and the sub-agent's wallets (same currency).
agentRoutes.post("/sub-agents/:id/transfer", zValidator("json", z.object({
  amount:    z.number().positive().max(10_000_000),
  direction: z.enum(["TO_SUB", "TO_PARENT"]),
  note:      z.string().trim().max(120).optional(),
})), async (c) => {
  const { parentId, sub } = await ownSubAgent(c, c.req.param("id"));
  const { amount, direction, note } = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const walletOf = async (agentId: string) => (await db.select().from(walletAccounts)
    .where(and(eq(walletAccounts.agentId, agentId), eq(walletAccounts.tenantId, tenantId))).limit(1))[0];
  const [parentWallet, subWallet] = await Promise.all([walletOf(parentId), walletOf(sub.id)]);
  if (!parentWallet || !subWallet) throw new HTTPException(404, { message: "Wallet not found" });
  if (parentWallet.currency !== subWallet.currency) throw new HTTPException(400, { message: "Both wallets must use the same currency" });
  if (direction === "TO_SUB" && sub.status !== "APPROVED") throw new HTTPException(409, { message: `Sub-agent is ${sub.status.toLowerCase()} — only approved sub-agents can receive funds` });

  const [from, to] = direction === "TO_SUB" ? [parentWallet, subWallet] : [subWallet, parentWallet];
  const label = direction === "TO_SUB" ? `Transfer to sub-agent ${sub.businessName}` : `Transfer from sub-agent ${sub.businessName}`;
  const meta = { performedById: c.get("userId"), note: note ? `${label} — ${note}` : label };
  const left = await debitWallet(db, from.id, amount, "ADJUSTMENT", meta);
  if (left === null) return c.json({ error: "Not enough balance for this transfer" }, 402);
  try {
    await creditWallet(db, to.id, amount, "ADJUSTMENT", meta);
  } catch (err) {
    // Put the money back if the second leg failed.
    await creditWallet(db, from.id, amount, "ADJUSTMENT", { ...meta, note: `${label} — reversed` });
    throw err;
  }
  await audit(db, { tenantId, userId: c.get("userId"), action: "SUBAGENT_TRANSFER", entity: "Agent", entityId: sub.id, after: { amount, direction } });
  return c.json({ ok: true, amount: roundMoney(amount), direction, currency: from.currency });
});

// PATCH /api/agents/sub-agents/:id/status  { status: APPROVED | SUSPENDED }
// A parent can pause and resume an approved sub-agent (approval stays with admin).
agentRoutes.patch("/sub-agents/:id/status", zValidator("json", z.object({ status: z.enum(["APPROVED", "SUSPENDED"]) })), async (c) => {
  const { sub } = await ownSubAgent(c, c.req.param("id"));
  const { status } = c.req.valid("json");
  if (!["APPROVED", "SUSPENDED"].includes(sub.status)) throw new HTTPException(409, { message: `Sub-agent is ${sub.status.toLowerCase()} — waiting for admin approval` });
  await c.get("db").update(agents).set({ status, updatedAt: new Date() }).where(eq(agents.id, sub.id));
  await audit(c.get("db"), { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "SUBAGENT_STATUS", entity: "Agent", entityId: sub.id, before: { status: sub.status }, after: { status } });
  return c.json({ ok: true, status });
});

// Sub-agent list for a specific parent agent (ADMIN)
agentRoutes.get("/:id/sub-agents", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.tenantId,      tenantId),
        eq(agents.parentAgentId, c.req.param("id")),
      ),
    );

  return c.json(rows);
});
