// Admin: B2B agency programme.
//
//   GET/PUT /config                         tiers, commission, credit days, risk limits
//   GET     /requests  ?status&type         agency requests (deposits, visa, packages, support…)
//   GET     /requests/:id                   with thread
//   PATCH   /requests/:id                   status / admin note / amount
//   POST    /requests/:id/messages          staff reply (agency is notified)
//   POST    /requests/:id/approve-deposit   credit the agency wallet
//   GET     /requests/:id/file?key=
//   GET     /agents/:id                     tier, credit, settings, users, KYC
//   PATCH   /agents/:id/credit              { creditLimit }
//   PATCH   /agents/:id/freeze              { frozen, reason }
//   PATCH   /documents/:id/verify           mark a KYC document verified
//   GET     /documents/:id/file
//   GET     /analytics ?from&to             per-agency sales, margin, cancellations
//   GET     /audit ?entityId&action

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { agentDocuments, agentRequestMessages, agentRequests, agents, auditLogs, bookings, tenants, users, walletAccounts } from "@poomas/db/schema";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import {
  agentTier, agentWallet, audit, creditAgentWallet, creditStatus, DEFAULT_PROGRAM, getProgram, saveProgram, settingsOf, updateSettings,
} from "../../lib/agent-program.js";
import { emailShell, escapeHtml, money, notifyCustomer } from "../../lib/customer-notify.js";
import { portalUrl, REQUEST_STATUSES } from "../agent-portal.js";
import { bankAccountSchema, getBankAccounts, saveBankAccounts } from "../../lib/bank-accounts.js";
import { DOC_LABEL, DOC_TYPES, getOnboarding, onboardingStatus, printablePage, renderMou, saveOnboarding } from "../../lib/agent-onboarding.js";
import { sendAgentPasswordReset } from "../agent-portal.js";
import { pbkdf2HashPassword } from "../auth.js";

export const agentProgramAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const tierSchema = z.object({
  name: z.string().trim().min(1).max(30), minMonthlySales: z.number().min(0),
  commissionPercent: z.number().min(0).max(10), suggestedCreditLimit: z.number().min(0),
});

agentProgramAdminRoutes.get("/config", async (c) => c.json({ config: await getProgram(c.env, c.get("tenantId")), defaults: DEFAULT_PROGRAM }));

agentProgramAdminRoutes.put("/config", zValidator("json", z.object({
  tiers: z.array(tierSchema).min(1).max(8),
  creditDays: z.number().int().min(1).max(120),
  maxBookingsPerHour: z.number().int().min(1).max(1000),
  blockDuplicates: z.boolean(),
  lowBalanceAlert: z.number().min(0),
  supportSlaHours: z.number().int().min(1).max(168),
})), async (c) => {
  const before = await getProgram(c.env, c.get("tenantId"));
  const next = c.req.valid("json");
  await saveProgram(c.env, c.get("tenantId"), next);
  await audit(c.get("db"), { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "AGENT_PROGRAM_UPDATED", entity: "Tenant", entityId: c.get("tenantId"), before, after: next });
  return c.json({ config: await getProgram(c.env, c.get("tenantId")) });
});

// ── Requests ────────────────────────────────────────────────────────────────

agentProgramAdminRoutes.get("/requests", async (c) => {
  const status = c.req.query("status");
  const type = c.req.query("type");
  const rows = await c.get("db").select({
    id: agentRequests.id, type: agentRequests.type, status: agentRequests.status, title: agentRequests.title, amount: agentRequests.amount,
    currency: agentRequests.currency, createdAt: agentRequests.createdAt, updatedAt: agentRequests.updatedAt, dueAt: agentRequests.dueAt,
    bookingId: agentRequests.bookingId, agentId: agentRequests.agentId, agentName: agents.businessName,
  }).from(agentRequests).innerJoin(agents, eq(agents.id, agentRequests.agentId))
    .where(and(eq(agentRequests.tenantId, c.get("tenantId")),
      ...(status === "ACTIVE" ? [inArray(agentRequests.status, ["OPEN", "IN_PROGRESS", "QUOTED"])] : status ? [eq(agentRequests.status, status)] : []),
      ...(type ? [eq(agentRequests.type, type)] : [])))
    .orderBy(desc(agentRequests.updatedAt)).limit(300);
  const now = Date.now();
  return c.json({ requests: rows.map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount),
    overdue: !!r.dueAt && r.dueAt.getTime() < now && ["OPEN", "IN_PROGRESS"].includes(r.status) })) });
});

async function loadRequest(c: { get: (k: "db" | "tenantId") => any }, id: string) {
  const [r] = await c.get("db").select().from(agentRequests).where(and(eq(agentRequests.id, id), eq(agentRequests.tenantId, c.get("tenantId")))).limit(1);
  return r as typeof agentRequests.$inferSelect | undefined;
}

agentProgramAdminRoutes.get("/requests/:id", async (c) => {
  const r = await loadRequest(c, c.req.param("id"));
  if (!r) return c.json({ error: "Request not found" }, 404);
  const db = c.get("db");
  const [agent] = await db.select({ id: agents.id, businessName: agents.businessName, email: agents.email, phone: agents.phone, currency: agents.currency }).from(agents).where(eq(agents.id, r.agentId)).limit(1);
  const messages = await db.select().from(agentRequestMessages).where(eq(agentRequestMessages.requestId, r.id)).orderBy(asc(agentRequestMessages.createdAt));
  return c.json({ request: { ...r, amount: r.amount === null ? null : Number(r.amount) }, agent, messages });
});

async function notifyAgency(c: { env: Env; get: (k: "db") => any }, agentId: string, tenantId: string, requestId: string, title: string, text: string) {
  const [a] = await c.get("db").select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!a) return;
  const link = `${portalUrl(c.env)}/requests/${requestId}`;
  await notifyCustomer(c.env, c.get("db"), tenantId, {
    email: a.email, phone: a.whatsapp ?? a.phone, category: "agency",
    subject: `Update: ${title}`,
    html: emailShell(title, `<p>${escapeHtml(text)}</p>`, { label: "Open in portal", href: link }),
    whatsapp: `📬 *${title}*\n${text}\n${link}`,
  });
}

agentProgramAdminRoutes.patch("/requests/:id", zValidator("json", z.object({
  status: z.enum(REQUEST_STATUSES).optional(), adminNote: z.string().max(2000).optional(), amount: z.number().min(0).optional(),
})), async (c) => {
  const r = await loadRequest(c, c.req.param("id"));
  if (!r) return c.json({ error: "Request not found" }, 404);
  const b = c.req.valid("json");
  if (r.type === "DEPOSIT" && b.status === "APPROVED") return c.json({ error: "Use 'Approve deposit' to credit the wallet." }, 400);
  await c.get("db").update(agentRequests).set({
    ...(b.status ? { status: b.status } : {}), ...(b.adminNote !== undefined ? { adminNote: b.adminNote } : {}),
    ...(b.amount !== undefined ? { amount: b.amount.toFixed(2) } : {}), updatedAt: new Date(),
  }).where(eq(agentRequests.id, r.id));
  await audit(c.get("db"), { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "AGENT_REQUEST_UPDATED", entity: "AgentRequest", entityId: r.id, before: { status: r.status }, after: b });
  if (b.status && b.status !== r.status) {
    c.executionCtx.waitUntil(notifyAgency(c, r.agentId, r.tenantId, r.id, r.title, `Status: ${b.status.replace("_", " ").toLowerCase()}${b.adminNote ? ` — ${b.adminNote}` : ""}`).catch(() => {}));
  }
  return c.json({ ok: true });
});

agentProgramAdminRoutes.post("/requests/:id/messages", zValidator("json", z.object({ message: z.string().trim().min(1).max(4000) })), async (c) => {
  const r = await loadRequest(c, c.req.param("id"));
  if (!r) return c.json({ error: "Request not found" }, 404);
  const { message } = c.req.valid("json");
  const db = c.get("db");
  const [u] = c.get("userId") ? await db.select({ id: users.id }).from(users).where(eq(users.id, c.get("userId")!)).limit(1) : [];
  const [m] = await db.insert(agentRequestMessages).values({ requestId: r.id, userId: u?.id ?? null, fromStaff: true, message }).returning();
  await db.update(agentRequests).set({ updatedAt: new Date(), ...(r.status === "OPEN" ? { status: "IN_PROGRESS" } : {}) }).where(eq(agentRequests.id, r.id));
  c.executionCtx.waitUntil(notifyAgency(c, r.agentId, r.tenantId, r.id, r.title, message).catch(() => {}));
  return c.json({ message: m }, 201);
});

agentProgramAdminRoutes.post("/requests/:id/approve-deposit", zValidator("json", z.object({ amount: z.number().positive(), note: z.string().max(200).optional() })), async (c) => {
  const r = await loadRequest(c, c.req.param("id"));
  if (!r || r.type !== "DEPOSIT") return c.json({ error: "Deposit request not found" }, 404);
  const db = c.get("db");
  const wallet = await agentWallet(db, r.tenantId, r.agentId);
  if (!wallet) return c.json({ error: "Agency wallet not found" }, 404);
  // Claim the request first so a double click can't credit twice.
  const [claimed] = await db.update(agentRequests).set({ status: "APPROVED", amount: c.req.valid("json").amount.toFixed(2), updatedAt: new Date() })
    .where(and(eq(agentRequests.id, r.id), inArray(agentRequests.status, ["OPEN", "IN_PROGRESS"]))).returning();
  if (!claimed) return c.json({ error: `This deposit is already ${r.status.toLowerCase()}.` }, 409);
  const { amount, note } = c.req.valid("json");
  const balance = await creditAgentWallet(db, wallet.id, amount, "TOPUP", {
    paymentId: `deposit_${r.id}`, performedById: c.get("userId") ?? undefined,
    note: `Deposit approved${(r.details as { reference?: string }).reference ? ` · ref ${(r.details as { reference?: string }).reference}` : ""}${note ? ` · ${note}` : ""}`,
  });
  await audit(db, { tenantId: r.tenantId, userId: c.get("userId"), action: "AGENT_DEPOSIT_APPROVED", entity: "WalletAccount", entityId: wallet.id, after: { amount, requestId: r.id } });
  c.executionCtx.waitUntil(notifyAgency(c, r.agentId, r.tenantId, r.id, "Deposit credited", `${money(amount, wallet.currency)} added to your wallet. New balance ${money(balance, wallet.currency)}.`).catch(() => {}));
  return c.json({ ok: true, balance });
});

// Reject a deposit (wrong amount, payment not received …): the agency sees the reason.
agentProgramAdminRoutes.post("/requests/:id/reject-deposit", zValidator("json", z.object({ reason: z.string().trim().min(3).max(500) })), async (c) => {
  const r = await loadRequest(c, c.req.param("id"));
  if (!r || r.type !== "DEPOSIT") return c.json({ error: "Deposit request not found" }, 404);
  const { reason } = c.req.valid("json");
  const db = c.get("db");
  const [done] = await db.update(agentRequests).set({ status: "REJECTED", adminNote: reason, updatedAt: new Date() })
    .where(and(eq(agentRequests.id, r.id), inArray(agentRequests.status, ["OPEN", "IN_PROGRESS"]))).returning();
  if (!done) return c.json({ error: `This deposit is already ${r.status.toLowerCase()}.` }, 409);
  await audit(db, { tenantId: r.tenantId, userId: c.get("userId"), action: "AGENT_DEPOSIT_REJECTED", entity: "AgentRequest", entityId: r.id, after: { reason } });
  c.executionCtx.waitUntil(notifyAgency(c, r.agentId, r.tenantId, r.id, "Deposit not approved", `${r.title}: ${reason}`).catch(() => {}));
  return c.json({ ok: true });
});

// ── Wallet recharges: queue of bank-transfer deposits with their screenshots ──
agentProgramAdminRoutes.get("/recharges", async (c) => {
  const status = c.req.query("status") ?? "PENDING";
  const statuses = status === "PENDING" ? ["OPEN", "IN_PROGRESS"] : status === "ALL" ? null : [status];
  const db = c.get("db");
  const rows = await db.select({ r: agentRequests, agentName: agents.businessName, agentNumber: agents.agentNumber, agentEmail: agents.email })
    .from(agentRequests).innerJoin(agents, eq(agents.id, agentRequests.agentId))
    .where(and(eq(agentRequests.tenantId, c.get("tenantId")), eq(agentRequests.type, "DEPOSIT"), ...(statuses ? [inArray(agentRequests.status, statuses)] : [])))
    .orderBy(status === "PENDING" ? asc(agentRequests.createdAt) : desc(agentRequests.updatedAt)).limit(200);
  const [counts] = await db.select({ pending: sql<number>`count(*) filter (where ${agentRequests.status} in ('OPEN','IN_PROGRESS'))::int` })
    .from(agentRequests).where(and(eq(agentRequests.tenantId, c.get("tenantId")), eq(agentRequests.type, "DEPOSIT")));
  const wallets = new Map<string, { balance: number; currency: string }>();
  for (const id of [...new Set(rows.map((x: { r: { agentId: string } }) => x.r.agentId))]) {
    const w = await agentWallet(db, c.get("tenantId"), id);
    if (w) wallets.set(id, { balance: Number(w.balance), currency: w.currency });
  }
  return c.json({
    pending: counts?.pending ?? 0,
    recharges: rows.map(({ r, agentName, agentNumber, agentEmail }: any) => ({
      id: r.id, status: r.status, title: r.title, amount: r.amount === null ? null : Number(r.amount), currency: r.currency,
      details: r.details, attachments: r.attachments, adminNote: r.adminNote, createdAt: r.createdAt, updatedAt: r.updatedAt,
      agent: { id: r.agentId, name: agentName, number: agentNumber, email: agentEmail, wallet: wallets.get(r.agentId) ?? null },
    })),
  });
});

agentProgramAdminRoutes.get("/bank-accounts", async (c) => c.json({ accounts: await getBankAccounts(c.env, c.get("tenantId")) }));

agentProgramAdminRoutes.post("/bank-accounts", zValidator("json", bankAccountSchema, (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the bank details" }, 400);
}), async (c) => {
  const tenantId = c.get("tenantId");
  const list = await getBankAccounts(c.env, tenantId);
  if (list.length >= 20) return c.json({ error: "Up to 20 bank accounts" }, 400);
  const now = new Date().toISOString();
  const account = { ...c.req.valid("json"), id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  await saveBankAccounts(c.env, tenantId, [...list, account]);
  await audit(c.get("db"), { tenantId, userId: c.get("userId"), action: "BANK_ACCOUNT_ADDED", entity: "BankAccount", entityId: account.id, after: { label: account.label, accountNumber: account.accountNumber } });
  return c.json({ account }, 201);
});

agentProgramAdminRoutes.patch("/bank-accounts/:id", zValidator("json", bankAccountSchema.partial(), (r, c) => {
  if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? "Check the bank details" }, 400);
}), async (c) => {
  const tenantId = c.get("tenantId");
  const list = await getBankAccounts(c.env, tenantId);
  const i = list.findIndex((a) => a.id === c.req.param("id"));
  if (i < 0) return c.json({ error: "Bank account not found" }, 404);
  const before = list[i];
  const patch = Object.fromEntries(Object.entries(c.req.valid("json")).filter(([, v]) => v !== undefined));
  list[i] = { ...before, ...patch, updatedAt: new Date().toISOString() };
  await saveBankAccounts(c.env, tenantId, list);
  await audit(c.get("db"), { tenantId, userId: c.get("userId"), action: "BANK_ACCOUNT_UPDATED", entity: "BankAccount", entityId: before.id, before, after: list[i] });
  return c.json({ account: list[i] });
});

agentProgramAdminRoutes.delete("/bank-accounts/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const list = await getBankAccounts(c.env, tenantId);
  const gone = list.find((a) => a.id === c.req.param("id"));
  if (!gone) return c.json({ error: "Bank account not found" }, 404);
  await saveBankAccounts(c.env, tenantId, list.filter((a) => a.id !== gone.id));
  await audit(c.get("db"), { tenantId, userId: c.get("userId"), action: "BANK_ACCOUNT_REMOVED", entity: "BankAccount", entityId: gone.id, before: gone });
  return c.json({ ok: true });
});

agentProgramAdminRoutes.get("/requests/:id/file", async (c) => {
  const r = await loadRequest(c, c.req.param("id"));
  if (!r) return c.json({ error: "Request not found" }, 404);
  const key = c.req.query("key") ?? "";
  const msgs = await c.get("db").select({ attachments: agentRequestMessages.attachments }).from(agentRequestMessages).where(eq(agentRequestMessages.requestId, r.id));
  const file = [...r.attachments, ...msgs.flatMap((m: { attachments: typeof r.attachments }) => m.attachments)].find((f) => f.key === key);
  const obj = file ? await c.env.DOCUMENTS_R2.get(file.key) : null;
  if (!file || !obj) return c.json({ error: "File not found" }, 404);
  return new Response(obj.body as unknown as BodyInit, { headers: { "Content-Type": file.type, "Content-Disposition": `inline; filename="${file.name.replace(/"/g, "")}"` } });
});

// ── Agencies: overview, credit, freeze, KYC ─────────────────────────────────

agentProgramAdminRoutes.get("/agents/:id", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [a] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  const program = await getProgram(c.env, tenantId);
  const [wallet, tier, team, docs, subs] = await Promise.all([
    agentWallet(db, tenantId, a.id),
    agentTier(db, tenantId, a.id, program),
    db.select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.agentId, a.id)),
    db.select({ id: agentDocuments.id, docType: agentDocuments.docType, fileName: agentDocuments.fileName, uploadedAt: agentDocuments.uploadedAt, verifiedAt: agentDocuments.verifiedAt })
      .from(agentDocuments).where(eq(agentDocuments.agentId, a.id)).orderBy(desc(agentDocuments.uploadedAt)),
    db.select({ id: agents.id, businessName: agents.businessName, status: agents.status }).from(agents).where(eq(agents.parentAgentId, a.id)),
  ]);
  const s = settingsOf(a);
  const onboarding = await onboardingStatus(c.env, db, tenantId, a).catch(() => null);
  const hasPassword = new Set((await db.select({ id: users.id }).from(users).where(and(eq(users.agentId, a.id), sql`${users.passwordHash} IS NOT NULL`))).map((u: { id: string }) => u.id));
  return c.json({ tier, credit: creditStatus(wallet, s, program), settings: s, team: team.map((u: { id: string }) => ({ ...u, hasPassword: hasPassword.has(u.id) })),
    documents: docs, subAgents: subs, walletCurrency: wallet?.currency ?? a.currency, onboarding, email: a.email });
});

// ── Agency logins: password reset ────────────────────────────────────────────
// mode "link": email a reset link (also returned so staff can send it on WhatsApp);
// mode "temporary": set a one-off password and show it once. An agency without
// any login gets one created for its registered email.
agentProgramAdminRoutes.post("/agents/:id/password-reset", zValidator("json", z.object({
  userId: z.string().optional(), mode: z.enum(["link", "temporary"]),
})), async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [a] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  const { userId, mode } = c.req.valid("json");
  let [u] = await db.select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive }).from(users)
    .where(and(eq(users.agentId, a.id), eq(users.tenantId, tenantId), userId ? eq(users.id, userId) : eq(users.role, "AGENT_ADMIN"))).limit(1);
  if (!u && userId) return c.json({ error: "Login not found for this agency" }, 404);
  let created = false;
  if (!u) {
    const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${a.email.toLowerCase()}`)).limit(1);
    if (taken) return c.json({ error: `${a.email} is already used by another login. Change the agency email first.` }, 409);
    [u] = await db.insert(users).values({ tenantId, name: a.ownerName, email: a.email, phone: a.phone, role: "AGENT_ADMIN", agentId: a.id, isActive: true, emailVerified: false })
      .returning({ id: users.id, email: users.email, name: users.name, isActive: users.isActive });
    created = true;
  }
  if (!u.email) return c.json({ error: "This login has no email address" }, 400);
  if (!u.isActive) await db.update(users).set({ isActive: true }).where(eq(users.id, u.id));
  if (mode === "link") {
    const link = await sendAgentPasswordReset(c.env, db, tenantId, u.id, u.email, u.name);
    await audit(db, { tenantId, userId: c.get("userId"), action: "AGENT_PASSWORD_RESET_SENT", entity: "User", entityId: u.id, after: { email: u.email, created } });
    return c.json({ ok: true, email: u.email, link, created });
  }
  const temporary = tempPassword();
  await db.update(users).set({ passwordHash: await pbkdf2HashPassword(temporary), updatedAt: new Date() }).where(eq(users.id, u.id));
  await c.env.SESSIONS_KV.delete(`session:${u.id}`).catch(() => {});
  await audit(db, { tenantId, userId: c.get("userId"), action: "AGENT_PASSWORD_SET_BY_ADMIN", entity: "User", entityId: u.id, after: { email: u.email, created } });
  return c.json({ ok: true, email: u.email, temporaryPassword: temporary, created });
});

// Readable one-off password: 3 words of letters + digits, no look-alike characters.
function tempPassword() {
  const A = "abcdefghjkmnpqrstuvwxyz", D = "23456789";
  const r = crypto.getRandomValues(new Uint32Array(14));
  const pick = (set: string, i: number) => set[r[i] % set.length];
  const part = (o: number) => Array.from({ length: 4 }, (_, i) => pick(A, o + i)).join("");
  return `${part(0)}-${part(4)}-${pick(D, 8)}${pick(D, 9)}${pick(D, 10)}${pick(A, 11).toUpperCase()}`;
}

// ── Onboarding settings (KYC required per region, MOU company details) ───────
agentProgramAdminRoutes.get("/onboarding", async (c) => c.json({ config: await getOnboarding(c.env, c.get("tenantId")), docTypes: DOC_TYPES, labels: DOC_LABEL }));

agentProgramAdminRoutes.put("/onboarding", zValidator("json", z.object({
  enforce: z.boolean(),
  kycRequired: z.object({ INDIA: z.array(z.enum(DOC_TYPES)).max(8), GCC: z.array(z.enum(DOC_TYPES)).max(8) }),
  requireMou: z.boolean(),
  mouVersion: z.string().trim().min(1).max(20),
  company: z.object({
    legalName: z.string().trim().max(150), address: z.string().trim().max(300), registration: z.string().trim().max(150),
    email: z.string().trim().max(120), phone: z.string().trim().max(40), signatory: z.string().trim().max(100), signatoryTitle: z.string().trim().max(80),
  }),
  extraClauses: z.string().max(4000),
  governingLaw: z.object({ INDIA: z.string().trim().min(3).max(200), GCC: z.string().trim().min(3).max(200) }),
})), async (c) => {
  const tenantId = c.get("tenantId");
  const before = await getOnboarding(c.env, tenantId);
  const next = c.req.valid("json");
  await saveOnboarding(c.env, tenantId, next);
  await audit(c.get("db"), { tenantId, userId: c.get("userId"), action: "AGENT_ONBOARDING_UPDATED", entity: "Tenant", entityId: tenantId, before, after: next });
  return c.json({ config: await getOnboarding(c.env, tenantId) });
});

// Signed MOU (frozen copy) or the current draft, as a printable page.
agentProgramAdminRoutes.get("/agents/:id/mou", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [a] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  const signed = settingsOf(a).mou;
  let body = "";
  if (signed) {
    const obj = await c.env.DOCUMENTS_R2.get(signed.r2Key).catch(() => null);
    if (obj) body = await new Response(obj.body as unknown as BodyInit).text();
  }
  if (!body) {
    const [cfg, program, [t]] = await Promise.all([getOnboarding(c.env, tenantId), getProgram(c.env, tenantId),
      db.select({ name: tenants.name, companyName: tenants.companyName, supportEmail: tenants.supportEmail, supportPhone: tenants.supportPhone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)]);
    body = renderMou({ cfg, tenant: t ?? { name: "FlyPoomas" }, agent: a, program }).html + `<p style="font-family:Arial;color:#b42318;text-align:center">Draft — not yet accepted by the agency</p>`;
  }
  return new Response(printablePage(`MOU · ${a.businessName}`, body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
});

// Ask the agency to review and sign the MOU again (e.g. after its terms changed).
agentProgramAdminRoutes.post("/agents/:id/mou/reset", async (c) => {
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const [a] = await db.select().from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  const before = settingsOf(a).mou ?? null;
  await updateSettings(db, a.id, { mou: undefined });
  await audit(db, { tenantId, userId: c.get("userId"), action: "AGENT_MOU_RESET", entity: "Agent", entityId: a.id, before });
  return c.json({ ok: true });
});

agentProgramAdminRoutes.patch("/agents/:id/credit", zValidator("json", z.object({ creditLimit: z.number().min(0).max(100_000_000) })), async (c) => {
  const db = c.get("db");
  const wallet = await agentWallet(db, c.get("tenantId"), c.req.param("id"));
  if (!wallet) return c.json({ error: "Agency wallet not found" }, 404);
  const { creditLimit } = c.req.valid("json");
  await db.update(walletAccounts).set({ creditLimit: creditLimit.toFixed(2), updatedAt: new Date() }).where(eq(walletAccounts.id, wallet.id));
  await db.update(agents).set({ creditLimit: creditLimit.toFixed(2), updatedAt: new Date() }).where(eq(agents.id, c.req.param("id")));
  await audit(db, { tenantId: c.get("tenantId"), userId: c.get("userId"), action: "AGENT_CREDIT_LIMIT", entity: "Agent", entityId: c.req.param("id"), before: { creditLimit: Number(wallet.creditLimit) }, after: { creditLimit } });
  return c.json({ ok: true });
});

agentProgramAdminRoutes.patch("/agents/:id/freeze", zValidator("json", z.object({ frozen: z.boolean(), reason: z.string().max(200).optional() })), async (c) => {
  const db = c.get("db");
  const [a] = await db.select({ id: agents.id, settings: agents.settings }).from(agents).where(and(eq(agents.id, c.req.param("id")), eq(agents.tenantId, c.get("tenantId")))).limit(1);
  if (!a) return c.json({ error: "Agency not found" }, 404);
  const { frozen, reason } = c.req.valid("json");
  await updateSettings(db, a.id, { frozen: frozen || undefined, frozenReason: frozen ? reason : undefined });
  await audit(db, { tenantId: c.get("tenantId"), userId: c.get("userId"), action: frozen ? "AGENT_FROZEN" : "AGENT_UNFROZEN", entity: "Agent", entityId: a.id, before: { frozen: !!settingsOf(a).frozen }, after: { frozen, reason } });
  return c.json({ ok: true });
});

agentProgramAdminRoutes.patch("/documents/:id/verify", zValidator("json", z.object({ verified: z.boolean() })), async (c) => {
  const db = c.get("db");
  const [d] = await db.select({ id: agentDocuments.id, agentId: agentDocuments.agentId, tenantId: agents.tenantId }).from(agentDocuments)
    .innerJoin(agents, eq(agents.id, agentDocuments.agentId)).where(eq(agentDocuments.id, c.req.param("id"))).limit(1);
  if (!d || d.tenantId !== c.get("tenantId")) return c.json({ error: "Document not found" }, 404);
  const { verified } = c.req.valid("json");
  const [u] = c.get("userId") ? await db.select({ id: users.id }).from(users).where(eq(users.id, c.get("userId")!)).limit(1) : [];
  await db.update(agentDocuments).set({ verifiedAt: verified ? new Date() : null, verifiedById: verified ? (u?.id ?? null) : null }).where(eq(agentDocuments.id, d.id));
  await audit(db, { tenantId: c.get("tenantId"), userId: c.get("userId"), action: verified ? "AGENT_KYC_VERIFIED" : "AGENT_KYC_UNVERIFIED", entity: "Agent", entityId: d.agentId, after: { documentId: d.id } });
  return c.json({ ok: true });
});

agentProgramAdminRoutes.get("/documents/:id/file", async (c) => {
  const db = c.get("db");
  const [d] = await db.select({ fileUrl: agentDocuments.fileUrl, fileName: agentDocuments.fileName, mimeType: agentDocuments.mimeType, tenantId: agents.tenantId })
    .from(agentDocuments).innerJoin(agents, eq(agents.id, agentDocuments.agentId)).where(eq(agentDocuments.id, c.req.param("id"))).limit(1);
  if (!d || d.tenantId !== c.get("tenantId")) return c.json({ error: "Document not found" }, 404);
  const obj = await c.env.DOCUMENTS_R2.get(d.fileUrl);
  if (!obj) return c.json({ error: "File not found" }, 404);
  return new Response(obj.body as unknown as BodyInit, { headers: { "Content-Type": d.mimeType ?? "application/octet-stream", "Content-Disposition": `inline; filename="${d.fileName.replace(/"/g, "")}"` } });
});

// ── Analytics & audit ───────────────────────────────────────────────────────

agentProgramAdminRoutes.get("/analytics", async (c) => {
  const db = c.get("db");
  const now = new Date();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from") ?? "") ? new Date(`${c.req.query("from")}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to") ?? "") ? new Date(`${c.req.query("to")}T23:59:59Z`) : now;
  const rows = await db.select({
    agentId: bookings.agentId, name: agents.businessName, status: agents.status,
    bookings: sql<number>`count(*) filter (where ${bookings.status} in ('CONFIRMED','TICKETED','CANCELLED','REFUNDED'))::int`,
    sales: sql<string>`coalesce(sum(${bookings.totalAmount}) filter (where ${bookings.status} in ('CONFIRMED','TICKETED')), 0)`,
    margin: sql<string>`coalesce(sum(${bookings.markup}) filter (where ${bookings.status} in ('CONFIRMED','TICKETED')), 0)`,
    cancelled: sql<number>`count(*) filter (where ${bookings.status} in ('CANCELLED','REFUNDED'))::int`,
    failed: sql<number>`count(*) filter (where ${bookings.status} = 'PAYMENT_FAILED')::int`,
  }).from(bookings).innerJoin(agents, eq(agents.id, bookings.agentId))
    .where(and(eq(bookings.tenantId, c.get("tenantId")), gte(bookings.createdAt, from), lte(bookings.createdAt, to)))
    .groupBy(bookings.agentId, agents.businessName, agents.status)
    .orderBy(desc(sql`coalesce(sum(${bookings.totalAmount}) filter (where ${bookings.status} in ('CONFIRMED','TICKETED')), 0)`)).limit(200);
  const routes = await db.select({ origin: bookings.origin, destination: bookings.destination, n: sql<number>`count(*)::int`, sales: sql<string>`coalesce(sum(${bookings.totalAmount}),0)` })
    .from(bookings).where(and(eq(bookings.tenantId, c.get("tenantId")), sql`${bookings.agentId} IS NOT NULL`, gte(bookings.createdAt, from), lte(bookings.createdAt, to), inArray(bookings.status, ["CONFIRMED", "TICKETED"])))
    .groupBy(bookings.origin, bookings.destination).orderBy(desc(sql`count(*)`)).limit(10);
  return c.json({
    from: from.toISOString(), to: to.toISOString(),
    agents: rows.map((r) => ({ ...r, sales: Number(r.sales), margin: Number(r.margin),
      cancellationRate: r.bookings ? Math.round((r.cancelled / r.bookings) * 1000) / 10 : 0 })),
    topRoutes: routes.map((r) => ({ ...r, sales: Number(r.sales) })),
  });
});

agentProgramAdminRoutes.get("/audit", async (c) => {
  const entityId = c.req.query("entityId");
  const action = c.req.query("action");
  const rows = await c.get("db").select({
    id: auditLogs.id, action: auditLogs.action, entity: auditLogs.entity, entityId: auditLogs.entityId, before: auditLogs.before, after: auditLogs.after,
    createdAt: auditLogs.createdAt, ipAddress: auditLogs.ipAddress, userName: users.name, userEmail: users.email,
  }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.userId))
    .where(and(eq(auditLogs.tenantId, c.get("tenantId")), ...(entityId ? [eq(auditLogs.entityId, entityId)] : []), ...(action ? [eq(auditLogs.action, action)] : [])))
    .orderBy(desc(auditLogs.createdAt)).limit(300);
  return c.json({ entries: rows });
});
