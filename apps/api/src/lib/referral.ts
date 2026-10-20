// Refer a friend: every customer gets a code; a new customer (account under
// 30 days old, no confirmed booking yet) can apply one friend's code once.
// When that new customer's first booking is confirmed, both wallets get
// REFERRAL_REWARD. Stored in KV (no schema change):
//
//   ref_code:<tenant>:<CODE>      → referrer userId
//   ref_by:<tenant>:<userId>      → { referrerId, code, appliedAt, rewardedAt? }
//   ref_stats:<tenant>:<userId>   → { joined, rewarded, earned }

import type { Db } from "@poomas/db";
import { bookings, users } from "@poomas/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../types.js";
import { creditWallet, getOrCreateCustomerWallet } from "./customer-wallet.js";

export const REFERRAL_REWARD = 100;        // INR to each side
export const REFERRAL_WINDOW_DAYS = 30;    // a new account can apply a code within this
export const REFERRAL_MAX_REWARDS = 25;    // per referrer

type KV = Env["SESSIONS_KV"];
interface ReferredBy { referrerId: string; code: string; appliedAt: string; rewardedAt?: string }
interface Stats { joined: number; rewarded: number; earned: number }

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function referralCode(secret: string, tenantId: string, userId: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`referral:${tenantId}:${userId}`)));
  return `FP${Array.from(sig.slice(0, 6), (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

export async function myReferral(env: Env, tenantId: string, userId: string) {
  const code = await referralCode(env.JWT_SECRET, tenantId, userId);
  // Publish the code → user mapping (idempotent).
  const mapKey = `ref_code:${tenantId}:${code}`;
  if ((await env.SESSIONS_KV.get(mapKey)) !== userId) await env.SESSIONS_KV.put(mapKey, userId);
  const stats = (await env.SESSIONS_KV.get(`ref_stats:${tenantId}:${userId}`, "json").catch(() => null) as Stats | null) ?? { joined: 0, rewarded: 0, earned: 0 };
  const referredBy = await env.SESSIONS_KV.get(`ref_by:${tenantId}:${userId}`, "json").catch(() => null) as ReferredBy | null;
  return { code, reward: REFERRAL_REWARD, stats, referredBy: referredBy ? { code: referredBy.code, rewarded: Boolean(referredBy.rewardedAt) } : null };
}

export class ReferralError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); }
}

export async function applyReferral(env: Env, db: Db, tenantId: string, userId: string, rawCode: string) {
  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const kv: KV = env.SESSIONS_KV;
  if (await kv.get(`ref_by:${tenantId}:${userId}`)) throw new ReferralError("You've already used a friend's code.", 409);
  const referrerId = await kv.get(`ref_code:${tenantId}:${code}`);
  if (!referrerId) throw new ReferralError("That code isn't valid. Check it with your friend.", 404);
  if (referrerId === userId) throw new ReferralError("You can't use your own code.");

  const [me] = await db.select({ createdAt: users.createdAt }).from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId))).limit(1);
  if (!me) throw new ReferralError("Account not found", 404);
  if (Date.now() - me.createdAt.getTime() > REFERRAL_WINDOW_DAYS * 86_400_000) {
    throw new ReferralError(`Friend codes can be used within ${REFERRAL_WINDOW_DAYS} days of creating your account.`);
  }
  const [booked] = await db.select({ id: bookings.id }).from(bookings)
    .where(and(eq(bookings.userId, userId), inArray(bookings.status, ["CONFIRMED", "TICKETED"]))).limit(1);
  if (booked) throw new ReferralError("Friend codes are for your first booking — you've already booked with us.");

  const record: ReferredBy = { referrerId, code, appliedAt: new Date().toISOString() };
  await kv.put(`ref_by:${tenantId}:${userId}`, JSON.stringify(record));
  await bumpStats(kv, tenantId, referrerId, { joined: 1 });
  return { code, reward: REFERRAL_REWARD };
}

async function bumpStats(kv: KV, tenantId: string, userId: string, d: Partial<Stats>) {
  const key = `ref_stats:${tenantId}:${userId}`;
  const s = (await kv.get(key, "json").catch(() => null) as Stats | null) ?? { joined: 0, rewarded: 0, earned: 0 };
  await kv.put(key, JSON.stringify({ joined: s.joined + (d.joined ?? 0), rewarded: s.rewarded + (d.rewarded ?? 0), earned: s.earned + (d.earned ?? 0) }));
}

// Called once a booking is confirmed. Pays both sides the first time only.
export async function rewardReferral(env: Env, db: Db, booking: { id: string; tenantId: string; userId: string | null }) {
  if (!booking.userId) return false;
  const kv: KV = env.SESSIONS_KV;
  const key = `ref_by:${booking.tenantId}:${booking.userId}`;
  const rec = await kv.get(key, "json").catch(() => null) as ReferredBy | null;
  if (!rec || rec.rewardedAt) return false;
  // Claim first so a queue retry can't pay twice.
  await kv.put(key, JSON.stringify({ ...rec, rewardedAt: new Date().toISOString() }));

  const stats = (await kv.get(`ref_stats:${booking.tenantId}:${rec.referrerId}`, "json").catch(() => null) as Stats | null);
  const referrerCapped = (stats?.rewarded ?? 0) >= REFERRAL_MAX_REWARDS;

  const friend = await getOrCreateCustomerWallet(db, booking.tenantId, booking.userId);
  await creditWallet(db, friend.id, REFERRAL_REWARD, "ADMIN_CREDIT", { bookingId: booking.id, note: `Referral reward — welcome bonus (code ${rec.code})` });
  if (!referrerCapped) {
    const [referrer] = await db.select({ id: users.id }).from(users).where(eq(users.id, rec.referrerId)).limit(1);
    if (referrer) {
      const wallet = await getOrCreateCustomerWallet(db, booking.tenantId, rec.referrerId);
      await creditWallet(db, wallet.id, REFERRAL_REWARD, "ADMIN_CREDIT", { note: "Referral reward — your friend booked their first trip" });
      await bumpStats(kv, booking.tenantId, rec.referrerId, { rewarded: 1, earned: REFERRAL_REWARD });
    }
  }
  return true;
}
