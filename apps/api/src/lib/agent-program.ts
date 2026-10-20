// B2B agency programme: settings, tiers, pricing chain, credit-aware wallet,
// commissions, risk checks and audit trail.
//
// Pricing for an agent booking (all on top of the supplier fare):
//   company markup (tenant rules + rules for this agency)
//   + each parent's markup on its sub-agent, up the tree   → the agent's NET price (charged to its wallet)
//   + the agent's own selling markup (display only)        → the SELLING price shown to its customers
// When the ticket is issued each parent is credited its markup share, and the
// agent gets its tier commission.

import type { Db } from "@poomas/db";
import { agents, auditLogs, bookings, commissions, walletAccounts, walletTransactions, users } from "@poomas/db/schema";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Env } from "../types.js";
import { getAgentMarkup, markupAmount, type AgentMarkup } from "./agent-markup.js";
import { creditWallet, roundMoney } from "./customer-wallet.js";
import { emailShell, escapeHtml, money, notifyCustomer } from "./customer-notify.js";

// ── Programme configuration (admin-editable, KV) ─────────────────────────────

export interface Tier { name: string; minMonthlySales: number; commissionPercent: number; suggestedCreditLimit: number }
export interface ProgramConfig {
  tiers: Tier[];                 // ascending by minMonthlySales
  creditDays: number;            // credit must be repaid within this many days
  maxBookingsPerHour: number;    // velocity limit per agency
  blockDuplicates: boolean;      // same traveller + route + date within 24 h
  lowBalanceAlert: number;       // WhatsApp/email when balance + credit drops below this
  supportSlaHours: number;
}

export const DEFAULT_PROGRAM: ProgramConfig = {
  tiers: [
    { name: "Silver",   minMonthlySales: 0,         commissionPercent: 0,   suggestedCreditLimit: 0 },
    { name: "Gold",     minMonthlySales: 500_000,   commissionPercent: 0,   suggestedCreditLimit: 50_000 },
    { name: "Platinum", minMonthlySales: 2_000_000, commissionPercent: 0,   suggestedCreditLimit: 200_000 },
  ],
  creditDays: 15,
  maxBookingsPerHour: 20,
  blockDuplicates: true,
  lowBalanceAlert: 5_000,
  supportSlaHours: 4,
};

const programKey = (tenantId: string) => `agent_program:${tenantId}`;

export async function getProgram(env: Env, tenantId: string): Promise<ProgramConfig> {
  const saved = await env.TENANT_CACHE_KV.get(programKey(tenantId), "json").catch(() => null) as Partial<ProgramConfig> | null;
  const merged = { ...DEFAULT_PROGRAM, ...(saved ?? {}) };
  merged.tiers = [...(merged.tiers?.length ? merged.tiers : DEFAULT_PROGRAM.tiers)].sort((a, b) => a.minMonthlySales - b.minMonthlySales);
  return merged;
}

export async function saveProgram(env: Env, tenantId: string, p: ProgramConfig) {
  await env.TENANT_CACHE_KV.put(programKey(tenantId), JSON.stringify(p));
}

// ── Agency settings (agents.settings jsonb) ──────────────────────────────────

export interface AgentSettings {
  displayName?: string;
  logoKey?: string;            // R2 key in PUBLIC_ASSETS_R2
  brandColor?: string;
  contactPhone?: string;
  contactEmail?: string;
  address?: string;
  gstNumber?: string;
  slug?: string;               // mini-site: portal /a/<slug>
  miniSite?: boolean;
  ownMarkup?: { type: "FLAT" | "PERCENTAGE"; value: number };   // selling markup shown to its customers
  mou?: { version: string; acceptedAt: string; name: string; designation: string; hash: string; r2Key: string; userId: string | null; email: string | null; ip: string | null; userAgent: string | null };   // signed MOU
  frozen?: boolean;            // admin credit / booking freeze
  frozenReason?: string;
  creditUsedSince?: string;    // when the balance went below zero
  lowBalanceAlertedAt?: string;
}

export function settingsOf(a: { settings?: unknown } | null | undefined): AgentSettings {
  return (a?.settings && typeof a.settings === "object" ? a.settings : {}) as AgentSettings;
}

export async function updateSettings(db: Db, agentId: string, patch: Partial<AgentSettings>) {
  const [row] = await db.select({ settings: agents.settings }).from(agents).where(eq(agents.id, agentId)).limit(1);
  const next = { ...settingsOf(row), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === null) delete (next as Record<string, unknown>)[k];
  await db.update(agents).set({ settings: next, updatedAt: new Date() }).where(eq(agents.id, agentId));
  return next;
}

// ── Tree ────────────────────────────────────────────────────────────────────

export interface AgentNode { id: string; parentAgentId: string | null; status: string; businessName: string }

// [self, parent, grandparent, …] (max 6 levels).
export async function ancestorChain(db: Db, tenantId: string, agentId: string): Promise<AgentNode[]> {
  const chain: AgentNode[] = [];
  let id: string | null = agentId;
  while (id && chain.length < 6 && !chain.some((n) => n.id === id)) {
    const [row] = await db.select({ id: agents.id, parentAgentId: agents.parentAgentId, status: agents.status, businessName: agents.businessName })
      .from(agents).where(and(eq(agents.id, id), eq(agents.tenantId, tenantId))).limit(1);
    if (!row) break;
    chain.push(row);
    id = row.parentAgentId;
  }
  return chain;
}

// All agency ids under (and including) an agency.
export async function descendantIds(db: Db, tenantId: string, agentId: string): Promise<string[]> {
  const all = [agentId];
  let frontier = [agentId];
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const rows = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.tenantId, tenantId), inArray(agents.parentAgentId, frontier)));
    frontier = rows.map((r) => r.id).filter((x) => !all.includes(x));
    all.push(...frontier);
  }
  return all;
}

// ── Pricing ─────────────────────────────────────────────────────────────────

export interface ChainShare { beneficiaryAgentId: string; fromAgentId: string; amount: number }

// Markups the parents add on top of `companyPrice` for this agent.
export function chainShares(chain: AgentNode[], markups: Map<string, AgentMarkup | null>, companyPrice: number): ChainShare[] {
  const shares: ChainShare[] = [];
  let running = companyPrice;
  // Walk from the top so each level's percentage applies to the price it buys at.
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    if (!node.parentAgentId) continue;
    const m = markups.get(node.id);
    if (!m) continue;
    const amount = markupAmount(m, running);
    if (amount > 0) { shares.push({ beneficiaryAgentId: node.parentAgentId, fromAgentId: node.id, amount }); running += amount; }
  }
  return shares;
}

export function sellingPrice(net: number, own?: AgentSettings["ownMarkup"]) {
  if (!own || !(own.value > 0)) return net;
  return roundMoney(net + markupAmount({ ...own, setBy: "", updatedAt: "" } as AgentMarkup, net));
}

// Per-agent pricing context, computed once per request.
export async function agentPricing(env: Env, db: Db, tenantId: string, agentId: string) {
  const chain = await ancestorChain(db, tenantId, agentId);
  const [row] = await db.select({ settings: agents.settings }).from(agents).where(eq(agents.id, agentId)).limit(1);
  const settings = settingsOf(row);
  const markups = new Map<string, AgentMarkup | null>();
  await Promise.all(chain.filter((n) => n.parentAgentId).map(async (n) => markups.set(n.id, await getAgentMarkup(env, tenantId, n.id))));
  return {
    chain, settings,
    price(companyPrice: number) {
      const shares = chainShares(chain, markups, companyPrice);
      const net = roundMoney(companyPrice + shares.reduce((s, x) => s + x.amount, 0));
      return { net, selling: sellingPrice(net, settings.ownMarkup), shares };
    },
  };
}

// Markup rules that apply to a caller: company-wide rules, plus the rules for
// this agency (agency rules never apply to anyone else).
export function rulesFor<T extends { agentId?: string | null }>(rules: T[], agentId: string | null | undefined): T[] {
  return rules.filter((r) => !r.agentId || (agentId && r.agentId === agentId));
}

// ── Wallet (balance + credit limit) ─────────────────────────────────────────

export async function agentWallet(db: Db, tenantId: string, agentId: string) {
  const [w] = await db.select().from(walletAccounts)
    .where(and(eq(walletAccounts.agentId, agentId), eq(walletAccounts.tenantId, tenantId))).limit(1);
  return w ?? null;
}

// Debits within balance + credit limit (atomic). Returns the new balance or null.
export async function debitAgentWallet(db: Db, walletId: string, amount: number, meta: { bookingId?: string; paymentId?: string; note?: string; performedById?: string; type?: "BOOKING_DEBIT" | "ADJUSTMENT" }) {
  const amt = roundMoney(amount);
  if (!(amt > 0)) throw new Error("Debit amount must be positive");
  const [row] = await db.update(walletAccounts)
    .set({ balance: sql`${walletAccounts.balance} - ${amt}`, updatedAt: new Date() })
    .where(and(eq(walletAccounts.id, walletId), sql`${walletAccounts.balance} + ${walletAccounts.creditLimit} >= ${amt}`))
    .returning({ balance: walletAccounts.balance, agentId: walletAccounts.agentId });
  if (!row) return null;
  const after = Number(row.balance);
  await db.insert(walletTransactions).values({
    walletAccountId: walletId, type: meta.type ?? "BOOKING_DEBIT", amount: amt.toFixed(2),
    balanceBefore: (after + amt).toFixed(2), balanceAfter: after.toFixed(2),
    bookingId: meta.bookingId ?? null, paymentId: meta.paymentId ?? null, note: meta.note ?? null, performedById: meta.performedById ?? null,
  });
  if (row.agentId && after < 0) {
    // The credit clock starts when the balance goes from ≥ 0 to below zero.
    const [a] = await db.select({ settings: agents.settings }).from(agents).where(eq(agents.id, row.agentId)).limit(1);
    if (after + amt >= 0 || !settingsOf(a).creditUsedSince) await updateSettings(db, row.agentId, { creditUsedSince: new Date().toISOString() });
  }
  return after;
}

// Credits and clears the "credit used since" clock once the balance is back to ≥ 0.
export async function creditAgentWallet(db: Db, walletId: string, amount: number, type: "TOPUP" | "REFUND_CREDIT" | "COMMISSION_CREDIT" | "ADJUSTMENT", meta: { bookingId?: string; paymentId?: string; note?: string; performedById?: string }) {
  const balance = await creditWallet(db, walletId, amount, type, meta);
  if (balance >= 0) {
    const [w] = await db.select({ agentId: walletAccounts.agentId }).from(walletAccounts).where(eq(walletAccounts.id, walletId)).limit(1);
    if (w?.agentId) {
      const [a] = await db.select({ settings: agents.settings }).from(agents).where(eq(agents.id, w.agentId)).limit(1);
      if (settingsOf(a).creditUsedSince) await updateSettings(db, w.agentId, { creditUsedSince: undefined });
    }
  }
  return balance;
}

export function creditStatus(wallet: { balance: string; creditLimit: string } | null, settings: AgentSettings, program: ProgramConfig, now = Date.now()) {
  const balance = Number(wallet?.balance ?? 0);
  const creditLimit = Number(wallet?.creditLimit ?? 0);
  const used = balance < 0 ? -balance : 0;
  const since = settings.creditUsedSince ? Date.parse(settings.creditUsedSince) : null;
  const dueAt = used > 0 && since ? new Date(since + program.creditDays * 86_400_000) : null;
  return {
    balance, creditLimit, available: roundMoney(balance + creditLimit), creditUsed: roundMoney(used),
    dueAt: dueAt?.toISOString() ?? null, overdue: Boolean(dueAt && dueAt.getTime() < now),
  };
}

// ── Booking guard (status, freeze, overdue credit, velocity, duplicates) ─────

export class AgentBlocked extends Error { constructor(message: string, public code: string) { super(message); } }

export async function assertAgentCanBook(env: Env, db: Db, tenantId: string, agentId: string, trip?: { origin: string; destination: string; departureDate: string; names: string[] }) {
  const [a] = await db.select({ status: agents.status, settings: agents.settings }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1);
  if (!a) throw new AgentBlocked("Agency not found", "AGENT_NOT_FOUND");
  if (a.status !== "APPROVED") throw new AgentBlocked(a.status === "PENDING" ? "Your agency is waiting for approval. You can search, but booking opens once approved." : `Your agency is ${a.status.toLowerCase()}. Please contact support.`, "AGENT_NOT_APPROVED");
  const s = settingsOf(a);
  if (s.frozen) throw new AgentBlocked(`Bookings are paused for your agency${s.frozenReason ? `: ${s.frozenReason}` : ""}. Please contact support.`, "AGENT_FROZEN");
  const program = await getProgram(env, tenantId);
  const credit = creditStatus(await agentWallet(db, tenantId, agentId), s, program);
  if (credit.overdue) throw new AgentBlocked(`Your credit of ${money(credit.creditUsed, "INR")} was due on ${new Date(credit.dueAt!).toLocaleDateString("en-IN")}. Please top up to continue booking.`, "CREDIT_OVERDUE");

  const hourAgo = new Date(Date.now() - 3600_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings)
    .where(and(eq(bookings.agentId, agentId), gte(bookings.createdAt, hourAgo)));
  if (n >= program.maxBookingsPerHour) throw new AgentBlocked(`Booking limit reached (${program.maxBookingsPerHour} per hour). Please try again later or contact support.`, "VELOCITY_LIMIT");

  if (trip && program.blockDuplicates && trip.names.length) {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const recent = await db.select({ id: bookings.id, status: bookings.status }).from(bookings)
      .where(and(eq(bookings.agentId, agentId), eq(bookings.origin, trip.origin), eq(bookings.destination, trip.destination),
        sql`${bookings.departureDate}::date = ${trip.departureDate}::date`, gte(bookings.createdAt, dayAgo),
        inArray(bookings.status, ["HELD", "PAYMENT_PENDING", "CONFIRMED", "TICKETED"])));
    if (recent.length) {
      const { bookingPassengers } = await import("@poomas/db/schema");
      const pax = await db.select({ first: bookingPassengers.firstName, last: bookingPassengers.lastName }).from(bookingPassengers)
        .where(inArray(bookingPassengers.bookingId, recent.map((r) => r.id)));
      const seen = new Set(pax.map((p) => `${p.first} ${p.last}`.toLowerCase().replace(/\s+/g, " ").trim()));
      const dup = trip.names.find((nm) => seen.has(nm.toLowerCase().replace(/\s+/g, " ").trim()));
      if (dup) throw new AgentBlocked(`${dup} already has a booking on this flight date (last 24 hours). Check your bookings to avoid a duplicate.`, "DUPLICATE_BOOKING");
    }
  }
  return { settings: s, program, credit };
}

// ── Ticketed: pay parents their markup and the agent its commission ─────────

export async function settleAgentBooking(env: Env, db: Db, booking: { id: string; tenantId: string; agentId: string | null; flightData: unknown; baseFare: string | null; currency: string }) {
  if (!booking.agentId) return;
  const fd = (booking.flightData ?? {}) as { agentPricing?: { shares?: ChainShare[]; settled?: boolean } };
  const pricing = fd.agentPricing;

  // Claim once (commissions has a unique index on booking_id).
  const program = await getProgram(env, booking.tenantId);
  const tier = await agentTier(db, booking.tenantId, booking.agentId, program);
  const base = Number(booking.baseFare ?? 0);
  const commission = roundMoney(base * tier.commissionPercent / 100);
  const [claimed] = await db.insert(commissions).values({
    bookingId: booking.id, agentId: booking.agentId, baseAmount: base.toFixed(2),
    ratePercent: tier.commissionPercent.toFixed(4), amount: commission.toFixed(2), currency: booking.currency as "INR",
    ...(commission > 0 ? { paidAt: new Date(), paidVia: "WALLET" } : {}),
  }).onConflictDoNothing().returning({ id: commissions.id });
  if (!claimed) return;   // already settled

  if (commission > 0) {
    const w = await agentWallet(db, booking.tenantId, booking.agentId);
    if (w) await creditAgentWallet(db, w.id, commission, "COMMISSION_CREDIT", { bookingId: booking.id, note: `${tier.name} commission ${tier.commissionPercent}% on booking ${booking.id.slice(0, 8)}` });
  }
  for (const share of pricing?.shares ?? []) {
    if (!(share.amount > 0)) continue;
    const w = await agentWallet(db, booking.tenantId, share.beneficiaryAgentId);
    if (w) await creditAgentWallet(db, w.id, share.amount, "COMMISSION_CREDIT", { bookingId: booking.id, note: `Sub-agent markup earned on booking ${booking.id.slice(0, 8)}` });
  }
}

// ── Tiers ───────────────────────────────────────────────────────────────────

export async function monthlySales(db: Db, agentId: string, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${bookings.totalAmount}), 0)` }).from(bookings)
    .where(and(eq(bookings.agentId, agentId), gte(bookings.createdAt, start), inArray(bookings.status, ["CONFIRMED", "TICKETED"])));
  return Number(row?.total ?? 0);
}

export async function agentTier(db: Db, tenantId: string, agentId: string, program: ProgramConfig) {
  // Tier follows last month's or this month's sales, whichever is higher.
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12));
  const [cur, prev] = await Promise.all([monthlySales(db, agentId, now), monthlySales(db, agentId, lastMonth)]);
  return tierFor(program, Math.max(cur, prev));
}

export function tierFor(program: ProgramConfig, sales: number) {
  const tiers = program.tiers;
  let current = tiers[0];
  for (const t of tiers) if (sales >= t.minMonthlySales) current = t;
  const next = tiers.find((t) => t.minMonthlySales > sales) ?? null;
  return { ...current, sales, next: next ? { name: next.name, needed: roundMoney(next.minMonthlySales - sales) } : null };
}

// ── Low balance alert (once a day) ──────────────────────────────────────────

export async function maybeLowBalanceAlert(env: Env, db: Db, tenantId: string, agentId: string) {
  const program = await getProgram(env, tenantId);
  const [a] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!a) return;
  const s = settingsOf(a);
  const credit = creditStatus(await agentWallet(db, tenantId, agentId), s, program);
  if (credit.available >= program.lowBalanceAlert) return;
  if (s.lowBalanceAlertedAt && Date.now() - Date.parse(s.lowBalanceAlertedAt) < 86_400_000) return;
  await updateSettings(db, agentId, { lowBalanceAlertedAt: new Date().toISOString() });
  const amount = money(credit.available, a.currency);
  await notifyCustomer(env, db, tenantId, {
    email: a.email, phone: a.whatsapp ?? a.phone, category: "wallet",
    subject: `Low wallet balance: ${amount} available`,
    html: emailShell("Your agency wallet is running low", `<p>${escapeHtml(a.businessName)}, you have <b>${escapeHtml(amount)}</b> available to book. Top up to keep booking without interruption.</p>`),
    whatsapp: `⚠️ *Low wallet balance* — ${a.businessName}\nAvailable to book: ${amount}\nTop up in the agent portal to keep booking.`,
  });
}

// ── Audit trail ─────────────────────────────────────────────────────────────

export async function audit(db: Db, entry: { tenantId: string; userId?: string | null; action: string; entity: string; entityId?: string | null; before?: unknown; after?: unknown; ip?: string | null; metadata?: unknown }) {
  try {
    // users FK: only store ids that exist (service tokens have none).
    let userId = entry.userId ?? null;
    if (userId) {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
      if (!u) userId = null;
    }
    await db.insert(auditLogs).values({
      tenantId: entry.tenantId, userId, action: entry.action, entity: entry.entity, entityId: entry.entityId ?? null,
      before: (entry.before ?? null) as never, after: (entry.after ?? null) as never, ipAddress: entry.ip ?? null, metadata: (entry.metadata ?? null) as never,
    });
  } catch (err) {
    console.error("[audit] write failed", err);
  }
}
