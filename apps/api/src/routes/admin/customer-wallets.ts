// GET  /api/admin/customer-wallets?q=         find customers (name / email / phone) with balances
// GET  /api/admin/customer-wallets/:userId    one customer's wallet + recent transactions
// POST /api/admin/customer-wallets/:userId/credit  { amount, note } add balance

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { users, walletAccounts, walletTransactions } from "@poomas/db/schema";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { Env, Variables } from "../../types.js";
import { creditWallet, getOrCreateCustomerWallet } from "../../lib/customer-wallet.js";

export const customerWalletsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

customerWalletsAdminRoutes.get("/", async (c) => {
  const db = c.get("db");
  const q = (c.req.query("q") ?? "").trim();
  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const rows = await db.select({
    userId: users.id, name: users.name, email: users.email, phone: users.phone,
    createdAt: users.createdAt, balance: walletAccounts.balance,
  })
    .from(users)
    .leftJoin(walletAccounts, eq(walletAccounts.userId, users.id))
    .where(and(
      eq(users.tenantId, c.get("tenantId")),
      eq(users.role, "CUSTOMER"),
      q ? or(ilike(users.name, like), ilike(users.email, like), ilike(users.phone, like)) : undefined,
    ))
    .orderBy(desc(users.createdAt))
    .limit(50);
  return c.json({ customers: rows.map((r) => ({ ...r, balance: Number(r.balance ?? 0) })) });
});

async function loadCustomer(c: { get: (k: "db" | "tenantId") => any }, userId: string) {
  const [user] = await c.get("db").select({ id: users.id, name: users.name, email: users.email, phone: users.phone })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, c.get("tenantId")), eq(users.role, "CUSTOMER")))
    .limit(1);
  if (!user) throw new HTTPException(404, { message: "Customer not found" });
  return user;
}

customerWalletsAdminRoutes.get("/:userId", async (c) => {
  const db = c.get("db");
  const user = await loadCustomer(c, c.req.param("userId"));
  const wallet = await getOrCreateCustomerWallet(db, c.get("tenantId"), user.id);
  const transactions = await db.select({
    id: walletTransactions.id, type: walletTransactions.type, amount: walletTransactions.amount,
    balanceAfter: walletTransactions.balanceAfter, bookingId: walletTransactions.bookingId,
    note: walletTransactions.note, createdAt: walletTransactions.createdAt,
  })
    .from(walletTransactions)
    .where(eq(walletTransactions.walletAccountId, wallet.id))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);
  return c.json({ customer: user, balance: Number(wallet.balance), currency: wallet.currency, transactions });
});

customerWalletsAdminRoutes.post("/:userId/credit", zValidator("json", z.object({
  amount: z.number().positive().max(100_000),
  note:   z.string().trim().min(3).max(200),
})), async (c) => {
  const db = c.get("db");
  const { amount, note } = c.req.valid("json");
  const user = await loadCustomer(c, c.req.param("userId"));
  const wallet = await getOrCreateCustomerWallet(db, c.get("tenantId"), user.id);
  const balance = await creditWallet(db, wallet.id, amount, "ADMIN_CREDIT", {
    note: `Admin credit: ${note}`,
    performedById: c.get("userId") ?? "admin-service",
  });
  return c.json({ ok: true, balance });
});
