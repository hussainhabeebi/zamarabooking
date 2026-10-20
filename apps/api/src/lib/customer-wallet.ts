// Customer (B2C) wallet ledger: booking bonus, admin credit, wallet payment,
// refunds and coupon sharing.
//
// The Neon HTTP driver has no interactive transactions, so every balance change
// is a single conditional UPDATE … RETURNING (atomic in Postgres). A debit can
// therefore never overdraw even under concurrent requests; the ledger row is
// written from the returned balance.

import type { Db } from "@poomas/db";
import { walletAccounts, walletTransactions, walletCoupons, bookings } from "@poomas/db/schema";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

export const CUSTOMER_WALLET_CURRENCY = "INR" as const;
export const BOOKING_BONUS_AMOUNT = 50;
export const COUPON_TTL_DAYS = 30;
export const COUPON_MIN_AMOUNT = 10;

type TxType = typeof walletTransactions.$inferInsert["type"];
interface TxMeta { bookingId?: string; paymentId?: string; note?: string; performedById?: string }

export async function getOrCreateCustomerWallet(db: Db, tenantId: string, userId: string) {
  const [existing] = await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
  if (existing) return existing;
  await db.insert(walletAccounts)
    .values({ tenantId, userId, currency: CUSTOMER_WALLET_CURRENCY, balance: "0" })
    .onConflictDoNothing();
  const [created] = await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
  if (!created) throw new Error("Could not create wallet");
  return created;
}

export async function creditWallet(db: Db, walletId: string, amount: number, type: TxType, meta: TxMeta = {}) {
  const amt = roundMoney(amount);
  if (!(amt > 0)) throw new Error("Credit amount must be positive");
  const [row] = await db.update(walletAccounts)
    .set({ balance: sql`${walletAccounts.balance} + ${amt}`, updatedAt: new Date() })
    .where(eq(walletAccounts.id, walletId))
    .returning({ balance: walletAccounts.balance });
  if (!row) throw new Error("Wallet not found");
  await recordTx(db, walletId, type, amt, Number(row.balance) - amt, Number(row.balance), meta);
  return Number(row.balance);
}

// Returns the new balance, or null when the balance is insufficient (nothing changed).
export async function debitWallet(db: Db, walletId: string, amount: number, type: TxType, meta: TxMeta = {}) {
  const amt = roundMoney(amount);
  if (!(amt > 0)) throw new Error("Debit amount must be positive");
  const [row] = await db.update(walletAccounts)
    .set({ balance: sql`${walletAccounts.balance} - ${amt}`, updatedAt: new Date() })
    .where(and(eq(walletAccounts.id, walletId), gte(walletAccounts.balance, String(amt))))
    .returning({ balance: walletAccounts.balance });
  if (!row) return null;
  await recordTx(db, walletId, type, amt, Number(row.balance) + amt, Number(row.balance), meta);
  return Number(row.balance);
}

async function recordTx(db: Db, walletId: string, type: TxType, amount: number, before: number, after: number, meta: TxMeta) {
  await db.insert(walletTransactions).values({
    walletAccountId: walletId,
    type,
    amount:        amount.toFixed(2),
    balanceBefore: before.toFixed(2),
    balanceAfter:  after.toFixed(2),
    bookingId:     meta.bookingId ?? null,
    paymentId:     meta.paymentId ?? null,
    note:          meta.note ?? null,
    performedById: meta.performedById ?? null,
  });
}

// ₹50 bonus for a confirmed customer booking. The bookings.wallet_bonus_credited_at
// flag is claimed atomically first, so queue retries can never pay it twice.
export async function creditBookingBonus(db: Db, bookingId: string): Promise<boolean> {
  const [claimed] = await db.update(bookings)
    .set({ walletBonusCreditedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.walletBonusCreditedAt), sql`${bookings.userId} IS NOT NULL`))
    .returning({ tenantId: bookings.tenantId, userId: bookings.userId });
  if (!claimed?.userId) return false;
  try {
    const wallet = await getOrCreateCustomerWallet(db, claimed.tenantId, claimed.userId);
    await creditWallet(db, wallet.id, BOOKING_BONUS_AMOUNT, "BOOKING_BONUS", {
      bookingId, note: `₹${BOOKING_BONUS_AMOUNT} booking bonus`,
    });
    return true;
  } catch (err) {
    // Not released: the balance may already have moved, and a retry would pay twice.
    // Admin can add it manually from the customer wallet page.
    console.error(`[wallet-bonus] bonus for booking ${bookingId} failed after claim`, err);
    return false;
  }
}

// Expire overdue ACTIVE coupons created by this user and refund their wallet.
export async function expireOverdueCoupons(db: Db, userId: string) {
  const expired = await db.update(walletCoupons)
    .set({ status: "EXPIRED" })
    .where(and(eq(walletCoupons.createdByUserId, userId), eq(walletCoupons.status, "ACTIVE"), lt(walletCoupons.expiresAt, new Date())))
    .returning({ id: walletCoupons.id, code: walletCoupons.code, amount: walletCoupons.amount, walletAccountId: walletCoupons.walletAccountId });
  for (const cp of expired) {
    await creditWallet(db, cp.walletAccountId, Number(cp.amount), "COUPON_REFUND", { note: `Coupon ${cp.code} expired` });
  }
}

export function generateCouponCode(): string {
  // No 0/O/1/I to avoid misreading when shared by phone.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `PM-${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export function roundMoney(n: number) {
  return Math.round(n * 100) / 100;
}
