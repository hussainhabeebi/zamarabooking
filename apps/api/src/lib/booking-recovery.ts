// Keeps paid bookings moving to the airline and makes failures visible.
//
// - The booking queue records its last error per booking (shown in Admin).
// - A short lock stops two queue runs booking the same seat at once.
// - While the customer waits on the confirmation page, a paid booking still in
//   PAYMENT_PENDING after a few minutes is booked directly (bypassing the queue).

import { payments } from "@poomas/db/schema";
import type { Db } from "@poomas/db";
import { and, desc, eq } from "drizzle-orm";
import type { Env } from "../types.js";

const ERROR_TTL = 60 * 60 * 24 * 14;
const LOCK_TTL = 180;           // longer than a TripJack book + booking-details round trip
const RESEND_AFTER_MS = 3 * 60 * 1000;
const RESEND_EVERY = 180;       // seconds between automatic re-sends

const errorKey = (bookingId: string) => `booking_queue_error:${bookingId}`;
const lockKey = (bookingId: string) => `booking_queue_lock:${bookingId}`;
const resendKey = (bookingId: string) => `booking_queue_resend:${bookingId}`;

export interface BookingQueueError { message: string; attempt: number; at: string }

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = (err as { supplierDetail?: string; responseSnippet?: string }).supplierDetail
    ?? (err as { responseSnippet?: string }).responseSnippet;
  return detail ? `${err.message} — ${detail}` : err.message;
}

export async function recordBookingError(env: Env, bookingId: string, err: unknown, attempt: number) {
  const value: BookingQueueError = {
    message: describeError(err),
    attempt,
    at: new Date().toISOString(),
  };
  try {
    await env.TENANT_CACHE_KV.put(errorKey(bookingId), JSON.stringify(value), { expirationTtl: ERROR_TTL });
  } catch (e) {
    console.error(`[booking-recovery] could not record error for ${bookingId}`, e);
  }
}

export async function readBookingError(env: Env, bookingId: string): Promise<BookingQueueError | null> {
  try {
    return await env.TENANT_CACHE_KV.get(errorKey(bookingId), "json") as BookingQueueError | null;
  } catch {
    return null;
  }
}

// Best-effort: KV is eventually consistent, so this narrows (not eliminates) overlap.
export async function acquireBookingLock(env: Env, bookingId: string): Promise<boolean> {
  try {
    if (await env.TENANT_CACHE_KV.get(lockKey(bookingId))) return false;
    await env.TENANT_CACHE_KV.put(lockKey(bookingId), new Date().toISOString(), { expirationTtl: LOCK_TTL });
  } catch {}
  return true;
}

export async function releaseBookingLock(env: Env, bookingId: string) {
  try { await env.TENANT_CACHE_KV.delete(lockKey(bookingId)); } catch {}
}

// Queue receipts keyed by payment order, so Admin can tell "never received"
// apart from "failed before the booking was loaded".
const seenKey = (orderId: string) => `booking_queue_seen:${orderId}`;

export async function recordQueueReceipt(env: Env, orderId: string, attempt: number, error?: unknown) {
  try {
    await env.TENANT_CACHE_KV.put(seenKey(orderId), JSON.stringify({
      at: new Date().toISOString(), attempt, ...(error ? { error: describeError(error) } : {}),
    }), { expirationTtl: ERROR_TTL });
  } catch {}
}

export async function readQueueReceipt(env: Env, orderId: string) {
  try {
    return await env.TENANT_CACHE_KV.get(seenKey(orderId), "json") as { at: string; attempt: number; error?: string } | null;
  } catch {
    return null;
  }
}

export async function paidBookingMessage(db: Db, bookingId: string) {
  const [payment] = await db
    .select({ gatewayOrderId: payments.gatewayOrderId, gatewayPaymentId: payments.gatewayPaymentId, amount: payments.amount })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "SUCCESS")))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  if (!payment?.gatewayOrderId) return null;
  return {
    type:             "PAYMENT_CAPTURED" as const,
    gatewayPaymentId: payment.gatewayPaymentId ?? payment.gatewayOrderId,
    orderId:          payment.gatewayOrderId,
    amount:           Number(payment.amount),
  };
}

// Called while the customer waits: re-send a paid booking the queue has not finished.
export async function resendStalledBooking(
  db: Db, env: Env,
  booking: { id: string; status: string; updatedAt: Date | string },
  run: (message: NonNullable<Awaited<ReturnType<typeof paidBookingMessage>>>) => Promise<void>,
): Promise<void> {
  if (booking.status !== "PAYMENT_PENDING") return;
  if (Date.now() - new Date(booking.updatedAt).getTime() < RESEND_AFTER_MS) return;
  try {
    if (await env.TENANT_CACHE_KV.get(resendKey(booking.id))) return;
    if (await env.TENANT_CACHE_KV.get(lockKey(booking.id))) return;
    await env.TENANT_CACHE_KV.put(resendKey(booking.id), "1", { expirationTtl: RESEND_EVERY });
    const message = await paidBookingMessage(db, booking.id);
    if (!message) return;
    // Book directly rather than via the queue, in case the queue is what stalled.
    console.warn(`[booking-recovery] booking stalled paid booking ${booking.id} directly`);
    await run(message);
  } catch (err) {
    console.error(`[booking-recovery] re-send failed for ${booking.id}`, err);
  }
}

// ── Booking event log (Admin → booking → "Booking error log") ────────────────
// Step-by-step record of the paid-booking pipeline, so Admin can see exactly
// where and why the PNR / ticket was not issued.

export type BookingStep =
  | "QUEUE" | "SUPPLIER_CONFIG" | "REVIEW" | "BOOK" | "BOOKING_DETAILS" | "PNR" | "TICKET" | "REFUND" | "NOTIFY";

export interface BookingEvent {
  at:      string;
  step:    BookingStep;
  level:   "info" | "warn" | "error";
  message: string;
  detail?: Record<string, unknown>;
  repeat?:  number;   // same event seen again (e.g. the customer page polling)
  firstAt?: string;
}

const eventsKey = (bookingId: string) => `booking_events:${bookingId}`;
const MAX_EVENTS = 80;

// Everything useful on a supplier / network error, without secrets.
export function errorDetail(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const e = err as Error & Record<string, unknown>;
  const pick = (k: string) => (e[k] !== undefined && e[k] !== null && e[k] !== "" ? { [k]: e[k] } : {});
  return {
    errorType: e.name,
    message:   e.message,
    ...pick("statusCode"), ...pick("code"), ...pick("endpoint"),
    ...pick("supplierDetail"), ...pick("supplierMessage"), ...pick("supplierErrorCodes"),
    ...pick("requestId"),
    ...(typeof e.responseSnippet === "string" ? { supplierResponse: (e.responseSnippet as string).slice(0, 1500) } : {}),
    ...(typeof e.body === "string" && e.name === "SupplierError" ? { supplierBody: (e.body as string).slice(0, 500) } : {}),
  };
}

export async function logBookingEvent(
  env: Env, bookingId: string,
  step: BookingStep, level: BookingEvent["level"], message: string, detail?: Record<string, unknown>,
) {
  const event: BookingEvent = { at: new Date().toISOString(), step, level, message, ...(detail ? { detail } : {}) };
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(
    `[booking-log] ${bookingId} ${step} ${level}: ${message}`, detail ? JSON.stringify(detail).slice(0, 1500) : "",
  );
  try {
    const list = (await env.TENANT_CACHE_KV.get(eventsKey(bookingId), "json") as BookingEvent[] | null) ?? [];
    const last = list[list.length - 1];
    if (last && last.step === step && last.level === level && last.message === message) {
      // Collapse repeats into one entry with a count and the latest details.
      last.repeat = (last.repeat ?? 1) + 1;
      last.firstAt = last.firstAt ?? last.at;
      last.at = event.at;
      if (detail) last.detail = detail;
    } else {
      list.push(event);
    }
    await env.TENANT_CACHE_KV.put(eventsKey(bookingId), JSON.stringify(list.slice(-MAX_EVENTS)), { expirationTtl: ERROR_TTL * 4 });
  } catch (err) {
    console.error(`[booking-log] could not store event for ${bookingId}`, err);
  }
}

export async function readBookingEvents(env: Env, bookingId: string): Promise<BookingEvent[]> {
  try {
    return (await env.TENANT_CACHE_KV.get(eventsKey(bookingId), "json") as BookingEvent[] | null) ?? [];
  } catch {
    return [];
  }
}

// Plain-language reason a confirmed TripJack booking still has no PNR / ticket.
export function explainMissingPnr(details: { status: string; statusMessage?: string; pnr: string; passengers: { ticketNumber: string }[] }): string {
  const status = details.status.toUpperCase();
  const tickets = details.passengers.filter((p) => p.ticketNumber).length;
  const suffix = details.statusMessage ? ` TripJack says: "${details.statusMessage}".` : "";
  if (details.pnr && tickets === details.passengers.length && tickets > 0) return "PNR and all ticket numbers issued.";
  if (isTestBooking(details.pnr)) {
    return `TripJack test booking (UAT) — PNR ${details.pnr} is a dummy and no real ticket number is issued. Real PNRs and ticket numbers come once the TripJack production account is live.`;
  }
  switch (status) {
    case "PENDING":
    case "IN_PROGRESS":
      return `TripJack is still processing the booking with the airline (order status ${status}); the PNR/ticket is issued asynchronously.${suffix}`;
    case "ON_HOLD":
      return `Booking is ON HOLD at TripJack — it was not paid from the TripJack wallet, so no ticket is issued until the hold is confirmed.${suffix}`;
    case "FAILED":
    case "ABORTED":
      return `TripJack/airline rejected the booking (order status ${status}).${suffix}`;
    case "CANCELLED":
      return `Booking was cancelled at TripJack.${suffix}`;
    case "UNCONFIRMED":
      return `Airline has not confirmed the seat yet (order status UNCONFIRMED) — TripJack support may need to follow up.${suffix}`;
    case "SUCCESS":
      return details.pnr
        ? `PNR ${details.pnr} issued but ${details.passengers.length - tickets} of ${details.passengers.length} ticket number(s) not yet issued by the airline.${suffix}`
        : `TripJack reports SUCCESS but returned no PNR in booking-details.${suffix}`;
    case "":
      return `TripJack booking-details returned no order status.${suffix}`;
    default:
      return `TripJack order status ${status}: PNR ${details.pnr || "not issued"}, ${tickets}/${details.passengers.length} ticket(s).${suffix}`;
  }
}

// TripJack UAT (test) bookings return a dummy PNR such as "TESTPNR" and never ticket.
export function isTestBooking(pnr: string | null | undefined): boolean {
  return /^TEST/i.test(pnr ?? "");
}
