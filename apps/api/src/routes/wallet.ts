import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { walletAccounts, walletTransactions } from "@poomas/db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { RAZORPAY_ENABLED } from "../lib/payment-gateway.js";

export const walletRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Get wallet balance for the authenticated agent
walletRoutes.get("/", async (c) => {
  const db      = c.get("db");
  const agentId = c.get("agentId");
  const tenantId = c.get("tenantId");

  if (!agentId) {
    throw new HTTPException(403, { message: "Wallet access requires agent account" });
  }

  const [wallet] = await db
    .select()
    .from(walletAccounts)
    .where(
      and(
        eq(walletAccounts.agentId,  agentId),
        eq(walletAccounts.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!wallet) {
    throw new HTTPException(404, { message: "Wallet not found" });
  }

  return c.json({
    wallet: {
      balance:     wallet.balance,
      creditLimit: wallet.creditLimit,
      currency:    wallet.currency,
      available:   String(parseFloat(wallet.balance) + parseFloat(wallet.creditLimit)),
    },
  });
});

// Transaction ledger
walletRoutes.get("/transactions", async (c) => {
  const db      = c.get("db");
  const agentId = c.get("agentId");
  const tenantId = c.get("tenantId");

  if (!agentId) throw new HTTPException(403, { message: "Wallet access requires agent account" });

  const [wallet] = await db
    .select({ id: walletAccounts.id })
    .from(walletAccounts)
    .where(
      and(eq(walletAccounts.agentId, agentId), eq(walletAccounts.tenantId, tenantId)),
    )
    .limit(1);

  if (!wallet) throw new HTTPException(404, { message: "Wallet not found" });

  const txns = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.walletAccountId, wallet.id))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(50);

  return c.json({ transactions: txns });
});

// Initiate wallet top-up (returns payment gateway link)
const topupSchema = z.object({
  amount:  z.number().positive(),
  gateway: z.enum(["RAZORPAY", "NOMOD"]).optional(),
});

walletRoutes.post("/topup", zValidator("json", topupSchema), async (c) => {
  const { amount } = c.req.valid("json");
  const tenant     = c.get("tenant");

  // Auto-detect gateway from tenant currency
  const gateway = RAZORPAY_ENABLED && tenant.defaultCurrency === "INR" ? "RAZORPAY" : "NOMOD";

  await c.env.BOOKING_QUEUE.send({
    type:     "WALLET_TOPUP_INITIATE",
    agentId:  c.get("agentId"),
    tenantId: c.get("tenantId"),
    amount,
    gateway,
  });

  return c.json({ ok: true, message: "Topup initiation queued" });
});
