// Runs lib/akbar-booking.ts for a stored booking: Akbar client with the tenant's settings,
// 48-hour token cache, booking state saved in bookings.flight_data.akbarBooking, every call
// stored as request / response files (supplier_exchanges, Admin → API Logs / certification ZIP),
// booking events, and the e-ticket when Akbar returns the PNR.
//
// Callers hold the booking lock (queue: handlePaymentCaptured; Admin: acquireBookingLock).

import { supplierActionBlocked } from "./akbar-failed-booking.js";
import { bookings, bookingPassengers } from "@zamrabooking/db/schema";
import { eq } from "drizzle-orm";
import type { AkbarToken } from "@zamrabooking/suppliers";
import type { Env, Variables } from "../types.js";
import { akbarClient, getAkbarSettings, getAkbarToken } from "./flight-sources.js";
import { collectExchanges, persistExchanges, type ExchangeCollector } from "./api-exchanges.js";
import { logBookingEvent } from "./booking-recovery.js";
import { issueOfflineTicket } from "./offline-ticket.js";
import {
  akbarBookingGate, akbarContact, akbarLegRefs, akbarPrepaymentCheck, refreshAkbarBooking, runAkbarBooking,
  type AkbarBookingState, type AkbarEngineDeps, type AkbarLegRef, type AkbarOutcome, type PaxInput,
} from "./akbar-booking.js";

type Db = Variables["db"];
type Booking = typeof bookings.$inferSelect;

export interface AkbarRunResult { ok: boolean; outcome?: AkbarOutcome; state?: AkbarBookingState; error?: string; skipped?: boolean }

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

// Departure date of each leg (traveller ages on the day they fly).
export function legDepartureDates(b: Pick<Booking, "departureDate" | "flightData">): string[] {
  const off = ((b.flightData ?? {}) as Record<string, any>).offline ?? {};
  const legs: any[] = Array.isArray(off.legs) && off.legs.length ? off.legs : [off.fare ?? {}];
  return legs.map((l) => (typeof l?.departureTime === "string" && l.departureTime.length >= 10 ? l.departureTime.slice(0, 10) : iso(b.departureDate)));
}

async function deps(env: Env, tenantId: string, collector: ExchangeCollector, save: AkbarEngineDeps["save"], log: AkbarEngineDeps["log"]) {
  const settings = await getAkbarSettings(env, tenantId);
  const client = akbarClient(env, { ...settings, recorder: collector.recorder } as typeof settings);
  const d: AkbarEngineDeps = {
    client, save, log,
    token: (fresh?: boolean): Promise<AkbarToken> => getAkbarToken(env, tenantId, client, !!fresh),
  };
  return { settings, d };
}

// POST /api/book, before payment: live price for every leg + traveller checks.
export async function akbarPrepayment(
  env: Env, tenantId: string, collector: ExchangeCollector,
  input: { legs: AkbarLegRef[]; pax: PaxInput[]; departureDates: string[] },
) {
  const { d } = await deps(env, tenantId, collector, async () => {}, () => {});
  return akbarPrepaymentCheck(d, input);
}

async function loadBooking(db: Db, id: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return b as Booking | undefined;
}

// Books a paid Akbar booking through the API. trigger AUTO runs only in AUTO mode.
export async function bookOnAkbar(env: Env, db: Db, bookingId: string, opts: { trigger: "AUTO" | "ADMIN"; userId?: string | null }): Promise<AkbarRunResult> {
  const b = await loadBooking(db, bookingId);
  if (!b || b.supplier !== "AKBAR") return { ok: false, error: "Not an Akbar booking." };
  if (b.status !== "CONFIRMED") return { ok: false, error: b.status === "TICKETED" ? "This booking is already ticketed." : `The booking is ${b.status}; only paid (CONFIRMED) bookings are booked on Akbar.` };
  let fd = (b.flightData ?? {}) as Record<string, any>;
  if (fd.offline?.ticketing === "ISSUED") return { ok: false, error: "A ticket was already issued for this booking." };
  const blocked = supplierActionBlocked(fd, "akbar-api");
  if (blocked) return { ok: false, error: blocked };

  const collector = collectExchanges();
  const save = async (state: AkbarBookingState) => {
    fd = { ...fd, akbarBooking: state };
    await db.update(bookings).set({ flightData: fd, updatedAt: new Date() }).where(eq(bookings.id, b.id));
  };
  const log: AkbarEngineDeps["log"] = (level, message, detail) => logBookingEvent(env, b.id, "BOOK", level, message, detail);
  const { settings, d } = await deps(env, b.tenantId, collector, save, log);
  const gate = akbarBookingGate(env, settings);
  if (!gate.allowed) return { ok: false, skipped: opts.trigger === "AUTO", error: gate.reason };
  if (opts.trigger === "AUTO" && !gate.auto) return { ok: false, skipped: true, error: "Akbar API booking is set to MANUAL." };

  const legs = akbarLegRefs(fd);
  const paxRows = await db.select().from(bookingPassengers).where(eq(bookingPassengers.bookingId, b.id));
  const pax: PaxInput[] = paxRows.map((p) => ({
    type: p.passengerType as PaxInput["type"], firstName: p.firstName, lastName: p.lastName,
    dob: p.dob ? iso(p.dob) : null, gender: (p.gender as "M" | "F" | null) ?? null, nationality: p.nationality,
    passportNumber: p.passportNumber, passportExpiry: p.passportExpiry ? iso(p.passportExpiry) : null, passportCountry: p.passportCountry,
  }));
  const lead = pax.find((p) => p.type === "ADULT") ?? pax[0];
  const { contact, problems } = akbarContact(settings, lead, b.contactEmail ?? "", b.contactPhone ?? "", fd.offline?.gstInfo ?? null);
  if (problems.length) {
    await log("error", `Akbar API booking not started: ${problems.join(" ")}`);
    return { ok: false, error: problems.join(" ") };
  }

  await log("info", `Akbar API booking started (${opts.trigger === "AUTO" ? "after payment" : "by staff"}, ${settings.environment}, ${legs.length} leg${legs.length > 1 ? "s" : ""})`);
  let state: AkbarBookingState;
  try {
    state = await runAkbarBooking(d, {
      legs, pax, departureDates: legDepartureDates(b), contact, state: fd.akbarBooking ?? null,
      lookups: settings.environment === "UAT", freshToken: settings.environment === "UAT",
    });
  } finally {
    await persistExchanges(env, db, b.tenantId, collector.exchanges, { bookingId: b.id, searchId: typeof fd.searchId === "string" ? fd.searchId : null });
  }
  await applyOutcome(env, db, b.id, state, legs.length, opts.userId ?? null);
  return { ok: state.outcome === "TICKETED", outcome: state.outcome, state };
}

// Admin: GetItineraryStatus + RetrieveBooking for legs already paid. Never pays.
export async function refreshAkbar(env: Env, db: Db, bookingId: string, userId: string | null): Promise<AkbarRunResult> {
  const b = await loadBooking(db, bookingId);
  if (!b || b.supplier !== "AKBAR") return { ok: false, error: "Not an Akbar booking." };
  let fd = (b.flightData ?? {}) as Record<string, any>;
  const current = fd.akbarBooking as AkbarBookingState | undefined;
  if (!current?.legs?.some((l) => l.transactionId && l.paymentSentAt)) return { ok: false, error: "Nothing was paid on Akbar for this booking yet." };
  const collector = collectExchanges();
  const save = async (state: AkbarBookingState) => {
    fd = { ...fd, akbarBooking: state };
    await db.update(bookings).set({ flightData: fd, updatedAt: new Date() }).where(eq(bookings.id, b.id));
  };
  const { d } = await deps(env, b.tenantId, collector, save, (level, message, detail) => logBookingEvent(env, b.id, "BOOKING_DETAILS", level, message, detail));
  const legCount = akbarLegRefs(fd).length;
  let state: AkbarBookingState;
  try { state = await refreshAkbarBooking(d, current, legCount); }
  finally { await persistExchanges(env, db, b.tenantId, collector.exchanges, { bookingId: b.id }); }
  if (b.status === "CONFIRMED") await applyOutcome(env, db, b.id, state, legCount, userId);
  else if (b.status === "TICKETED" && state.outcome === "TICKETED") await updateIssuedTickets(env, db, b.id, state, legCount, userId);
  return { ok: state.outcome === "TICKETED", outcome: state.outcome, state };
}

// Ticket numbers Akbar issued after the booking was marked TICKETED (RetrieveBooking had TicketNo ""):
// store them and rebuild the e-ticket. The first time a booking gets ticket numbers this way, the
// customer is emailed the updated e-ticket once (their confirmation had the PNR only).
export async function updateIssuedTickets(env: Env, db: Db, bookingId: string, state: AkbarBookingState, legCount: number, userId: string | null) {
  const b = await loadBooking(db, bookingId);
  if (!b || b.status !== "TICKETED" || !b.pnr) return;
  const tickets = state.legs.slice(0, legCount).flatMap((l) => l.tickets ?? []);
  if (!tickets.length || tickets.join(",") === (b.ticketNumbers ?? []).join(",")) return;
  const hadTickets = (b.ticketNumbers ?? []).length > 0;
  const { eticketKey } = await issueOfflineTicket(env, db, b, {
    pnr: b.pnr, ticketNumbers: tickets, supplierRef: b.supplierBookingRef ?? undefined,
    issuedBy: userId, source: "akbar-api", flightData: (b.flightData ?? {}) as Record<string, any>,
  });
  if (!hadTickets) {
    await env.NOTIFY_QUEUE.send({ type: "NOTIFY_BOOKING_CONFIRMATION", bookingId: b.id, tenantId: b.tenantId, eticketKey, update: "TICKET_NUMBERS" });
    await logBookingEvent(env, b.id, "TICKET", "info", "Ticket numbers received from Akbar — updated e-ticket emailed to the customer", { ticketNumbers: tickets });
  }
}

// Saves what the run means for the booking. Ticketed only with Akbar's own PNRs.
async function applyOutcome(env: Env, db: Db, bookingId: string, state: AkbarBookingState, legCount: number, userId: string | null) {
  const b = await loadBooking(db, bookingId);
  if (!b) return;
  const fd = (b.flightData ?? {}) as Record<string, any>;
  if (state.outcome === "TICKETED") {
    const legs = state.legs.slice(0, legCount);
    const pnrs = [...new Set(legs.flatMap((l) => l.pnrs ?? []))];
    const tickets = legs.flatMap((l) => l.tickets ?? []);
    if (!pnrs.length) return;
    await issueOfflineTicket(env, db, b, {
      pnr: pnrs.join("/"), ticketNumbers: tickets, supplierRef: legs.map((l) => l.transactionId).filter(Boolean).join(","),
      issuedBy: userId, source: "akbar-api", flightData: fd,
    });
    return;
  }
  // Nothing paid on Akbar: staff ticket it as before. Anything paid but not confirmed: staff check Akbar.
  const ticketing = state.outcome === "FAILED_BEFORE_PAYMENT" ? "PENDING" : "AKBAR_CHECK";
  await db.update(bookings).set({ flightData: { ...fd, offline: { ...(fd.offline ?? {}), ticketing } }, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
  await logBookingEvent(env, bookingId, "BOOK", state.outcome === "PENDING" ? "warn" : "error",
    state.outcome === "FAILED_BEFORE_PAYMENT"
      ? "Akbar API booking stopped before payment — issue the ticket on Akbar's portal as usual, or retry the API booking"
      : state.outcome === "PENDING"
        ? "Akbar has not confirmed the booking yet — use \"Refresh from Akbar\"; StartPay is never sent twice"
        : `Akbar API booking ${state.outcome === "PARTIAL" ? "booked only some legs" : "failed after StartPay"} — check the transaction on Akbar's portal`,
    { legs: state.legs.map((l) => ({ leg: l.leg, state: l.state, transactionId: l.transactionId ?? null, errorCode: l.errorCode ?? null })) });
}
