// Permanently delete an agency account (normal or Leadvyne).
//
// Agencies with booking or money history are kept: bookings, commissions and
// wallet movements are financial records, so those agencies must be suspended
// instead. Anything else — logins, wallet with no movements, markup overrides,
// documents, requests, quotes, travellers, analytics — is removed with it.

import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  agents, auditLogs, bookingAmendments, bookings, commissions, markupRules, supportRequests,
  users, walletAccounts, walletCoupons, walletTransactions,
} from "@poomas/db/schema";
import type { Db } from "@poomas/db";
import type { Env } from "../types.js";
import { forgetAgentNumber } from "./agent-number.js";
import { audit } from "./agent-program.js";

export type DeleteAgentResult =
  | { ok: true; businessName: string }
  | { ok: false; status: 404 | 409; error: string };

export async function deleteAgent(
  env: Env, db: Db,
  opts: { agentId: string; tenantId?: string | null; performedBy?: string | null },
): Promise<DeleteAgentResult> {
  const [a] = await db.select().from(agents)
    .where(and(eq(agents.id, opts.agentId), opts.tenantId ? eq(agents.tenantId, opts.tenantId) : undefined)).limit(1);
  if (!a) return { ok: false, status: 404, error: "Agency not found" };

  const staff = await db.select({ id: users.id }).from(users).where(eq(users.agentId, a.id));
  const staffIds = staff.map((u) => u.id);
  const wallets = await db.select({ id: walletAccounts.id }).from(walletAccounts).where(eq(walletAccounts.agentId, a.id));
  const walletIds = wallets.map((w) => w.id);

  const [[b], [cm], [sub], [tx]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(bookings)
      .where(staffIds.length ? or(eq(bookings.agentId, a.id), inArray(bookings.userId, staffIds)) : eq(bookings.agentId, a.id)),
    db.select({ n: sql<number>`count(*)::int` }).from(commissions).where(eq(commissions.agentId, a.id)),
    db.select({ n: sql<number>`count(*)::int` }).from(agents).where(eq(agents.parentAgentId, a.id)),
    walletIds.length
      ? db.select({ n: sql<number>`count(*)::int` }).from(walletTransactions).where(inArray(walletTransactions.walletAccountId, walletIds))
      : Promise.resolve([{ n: 0 }]),
  ]);
  const blockers = [
    b?.n ? `${b.n} booking${b.n === 1 ? "" : "s"}` : "",
    cm?.n ? `${cm.n} commission record${cm.n === 1 ? "" : "s"}` : "",
    tx?.n ? `${tx.n} wallet transaction${tx.n === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (blockers.length) {
    return { ok: false, status: 409, error: `${a.businessName} has ${blockers.join(", ")} and can't be deleted. Suspend the agency instead.` };
  }
  if (sub?.n) {
    return { ok: false, status: 409, error: `${a.businessName} has ${sub.n} sub-agent${sub.n === 1 ? "" : "s"}. Delete those first.` };
  }

  await db.delete(markupRules).where(eq(markupRules.agentId, a.id));
  if (walletIds.length) await db.delete(walletAccounts).where(inArray(walletAccounts.id, walletIds));
  if (staffIds.length) {
    // Keep the history these logins left behind, without the user link.
    await db.update(auditLogs).set({ userId: null }).where(inArray(auditLogs.userId, staffIds));
    await db.update(supportRequests).set({ userId: null }).where(inArray(supportRequests.userId, staffIds));
    await db.update(bookingAmendments).set({ userId: null }).where(inArray(bookingAmendments.userId, staffIds));
    await db.update(walletCoupons).set({ redeemedByUserId: null }).where(inArray(walletCoupons.redeemedByUserId, staffIds));
    await db.delete(users).where(and(inArray(users.id, staffIds), eq(users.agentId, a.id)));
  }
  await db.delete(agents).where(eq(agents.id, a.id));
  await forgetAgentNumber(env, a.tenantId, a.agentNumber);

  const settings = (a.settings ?? {}) as Record<string, unknown>;
  await audit(db, {
    tenantId: a.tenantId, userId: opts.performedBy ?? null, action: "AGENT_DELETED", entity: "Agent", entityId: a.id,
    before: { businessName: a.businessName, email: a.email, agentNumber: a.agentNumber, status: a.status, source: settings.source ?? "PORTAL", logins: staffIds.length },
  });
  return { ok: true, businessName: a.businessName };
}
