// Automatic Akbar status checks (hourly cron, index.ts): the same read-only "Refresh from Akbar"
// staff can click (GetItineraryStatus → RetrieveBooking; never CreateItinerary or StartPay), run for:
//
//   AWAITING_PNR      paid on Akbar (StartPay sent) but Akbar hadn't confirmed yet — booking CONFIRMED,
//                     outcome PENDING / PARTIAL (e.g. GetItineraryStatus timed out after StartPay)
//   AWAITING_TICKETS  TICKETED with Akbar's PNR but RetrieveBooking had TicketNo "" (tickets not issued yet)
//
// Only while the flight hasn't departed and for 24 hours after StartPay; after that one warning is
// logged on the booking for staff. Each check holds the booking lock (as the Admin button does), so it
// never overlaps a staff action or the payment queue. Skipped when Akbar API booking is OFF.

import { bookings } from "@zamrabooking/db/schema";
import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { acquireBookingLock, logBookingEvent, releaseBookingLock } from "./booking-recovery.js";
import { getAkbarSettings } from "./flight-sources.js";
import { refreshAkbar, type AkbarRunResult } from "./akbar-booking-runner.js";

type Db = Variables["db"];
type Booking = typeof bookings.$inferSelect;

export const AUTO_CHECK_WINDOW_MS = 24 * 3600_000;   // after StartPay
export const AUTO_CHECK_MAX_PER_RUN = 10;            // each check can take ~15 s (status polling)

export type AutoCheckReason = "AWAITING_PNR" | "AWAITING_TICKETS";

// Why this booking needs an automatic check now (null = it doesn't), or that its 24 hours are over.
export function akbarAutoCheck(b: Pick<Booking, "supplier" | "status" | "departureDate" | "ticketNumbers" | "flightData">, now: Date):
  { reason: AutoCheckReason; expired: boolean } | null {
  if (b.supplier !== "AKBAR" || !["CONFIRMED", "TICKETED"].includes(b.status)) return null;
  if (new Date(b.departureDate).getTime() <= now.getTime()) return null;
  const fd = (b.flightData ?? {}) as Record<string, any>;
  if (fd.offline?.resolution?.type === "REFUND") return null;
  const state = fd.akbarBooking as { outcome?: string; legs?: { paymentSentAt?: string }[] } | undefined;
  const sent = (state?.legs ?? []).map((l) => Date.parse(l.paymentSentAt ?? "")).filter((t) => Number.isFinite(t));
  if (!sent.length) return null;   // nothing paid on Akbar: not a status question
  let reason: AutoCheckReason | null = null;
  if (b.status === "CONFIRMED" && ["PENDING", "PARTIAL"].includes(state?.outcome ?? "")) reason = "AWAITING_PNR";
  if (b.status === "TICKETED" && !(b.ticketNumbers ?? []).length) reason = "AWAITING_TICKETS";
  if (!reason) return null;
  return { reason, expired: now.getTime() - Math.min(...sent) > AUTO_CHECK_WINDOW_MS };
}

const warnedKey = (id: string) => `akbar_autocheck_warned:${id}`;

export interface AutoCheckSummary { checked: number; ticketed: number; warned: number; skipped: number }

export async function runAkbarAutoChecks(
  env: Env, db: Db, now = new Date(),
  refresh: (env: Env, db: Db, bookingId: string, userId: string | null) => Promise<AkbarRunResult> = refreshAkbar,
): Promise<AutoCheckSummary> {
  const summary: AutoCheckSummary = { checked: 0, ticketed: 0, warned: 0, skipped: 0 };
  const rows = await db.select().from(bookings).where(and(
    eq(bookings.supplier, "AKBAR"),
    inArray(bookings.status, ["CONFIRMED", "TICKETED"]),
    gt(bookings.departureDate, now),
    gte(bookings.createdAt, new Date(now.getTime() - AUTO_CHECK_WINDOW_MS - 3 * 24 * 3600_000)),
  )).orderBy(asc(bookings.createdAt)).limit(200);

  const apiOn = new Map<string, boolean>();
  for (const b of rows) {
    const check = akbarAutoCheck(b, now);
    if (!check) continue;
    if (check.expired) {
      // Once: staff take it from here.
      if (!(await env.TENANT_CACHE_KV.get(warnedKey(b.id)).catch(() => null))) {
        await logBookingEvent(env, b.id, "BOOKING_DETAILS", "warn", check.reason === "AWAITING_PNR"
          ? "Akbar still hasn't confirmed this booking 24 hours after payment — automatic checks stopped. Check the transaction on Akbar's portal."
          : "Akbar still hasn't issued ticket numbers 24 hours after the PNR — automatic checks stopped. Ask Akbar, or enter the ticket numbers with \"Update ticket details\".").catch(() => {});
        await env.TENANT_CACHE_KV.put(warnedKey(b.id), now.toISOString(), { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
        summary.warned++;
      }
      continue;
    }
    if (summary.checked >= AUTO_CHECK_MAX_PER_RUN) { summary.skipped++; continue; }
    if (!apiOn.has(b.tenantId)) {
      apiOn.set(b.tenantId, await getAkbarSettings(env, b.tenantId).then((s) => (s.apiBooking ?? "OFF") !== "OFF").catch(() => false));
    }
    if (!apiOn.get(b.tenantId)) { summary.skipped++; continue; }
    if (!(await acquireBookingLock(env, b.id))) { summary.skipped++; continue; }   // staff / queue busy with it
    try {
      summary.checked++;
      await logBookingEvent(env, b.id, "BOOKING_DETAILS", "info",
        `Automatic Akbar status check (${check.reason === "AWAITING_PNR" ? "waiting for Akbar's confirmation" : "waiting for ticket numbers"})`).catch(() => {});
      const r = await refresh(env, db, b.id, null);
      if (r.outcome === "TICKETED" && (check.reason === "AWAITING_PNR" || r.state?.legs.every((l) => l.tickets?.length))) summary.ticketed++;
    } catch (err) {
      await logBookingEvent(env, b.id, "BOOKING_DETAILS", "warn", `Automatic Akbar status check failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    } finally {
      await releaseBookingLock(env, b.id);
    }
  }
  return summary;
}
