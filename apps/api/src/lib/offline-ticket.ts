// Marks a Poomas / Akbar / manual fare booking TICKETED with its PNR, builds the e-ticket
// and (first time only) queues the confirmation email. Used by Admin → Bookings
// "Issue ticket" (staff) and by the Akbar API booking (lib/akbar-booking-runner.ts).

import { bookings, bookingPassengers, tenants } from "@zamrabooking/db/schema";
import { eq } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { renderETicketHtml, storeETicket } from "./eticket.js";
import { logBookingEvent } from "./booking-recovery.js";

type Booking = typeof bookings.$inferSelect;

export async function issueOfflineTicket(
  env: Env, db: Variables["db"], b: Booking,
  t: { pnr: string; ticketNumbers: string[]; supplierRef?: string; issuedBy: string | null; source: "staff" | "akbar-api"; flightData?: Record<string, any> },
): Promise<{ firstIssue: boolean; eticketKey: string }> {
  const { pnr, ticketNumbers, supplierRef } = t;
  const flightData = (t.flightData ?? b.flightData ?? {}) as Record<string, any>;
  const firstIssue = b.status !== "TICKETED";
  await db.update(bookings).set({
    status: "TICKETED", pnr, ticketNumbers,
    ...(supplierRef ? { supplierBookingRef: supplierRef } : {}),
    flightData: { ...flightData, offline: { ...(flightData.offline ?? {}), ticketing: "ISSUED", issuedAt: new Date().toISOString(), issuedBy: t.issuedBy, ...(t.source === "akbar-api" ? { issuedVia: "AKBAR_API" } : {}) } },
    updatedAt: new Date(),
  }).where(eq(bookings.id, b.id));

  const paxRows = await db.select().from(bookingPassengers).where(eq(bookingPassengers.bookingId, b.id));
  const [tenantRow] = await db.select({ name: tenants.name, logoUrl: tenants.logoUrl, primaryColor: tenants.primaryColor, supportEmail: tenants.supportEmail })
    .from(tenants).where(eq(tenants.id, b.tenantId)).limit(1);
  const departureTime = flightData.departureTime ?? b.departureDate.toISOString();
  const eticketKey = await storeETicket(env.DOCUMENTS_R2, b.id, renderETicketHtml({
    bookingRef: b.id, pnr, ticketNumbers,
    airline: flightData.airline ?? "", airlineName: flightData.airlineName ?? flightData.airline ?? "", flightNumber: flightData.flightNumber ?? "",
    origin: b.origin, destination: b.destination, departureTime, arrivalTime: flightData.arrivalTime ?? departureTime,
    cabinClass: flightData.cabinClass ?? b.cabinClass, isRefundable: Boolean(flightData.isRefundable),
    baggage: flightData.baggage ?? { cabin: "As per airline", checked: "As per airline" },
    passengers: paxRows.map((p, i) => ({ name: `${p.firstName} ${p.lastName}`, type: p.passengerType, ticketNumber: ticketNumbers[i] })),
    totalAmount: Number(b.totalAmount), currency: b.currency,
    brandName: tenantRow?.name ?? "Zamra Travels", brandLogo: tenantRow?.logoUrl ?? undefined,
    primaryColor: tenantRow?.primaryColor ?? "#0D4B96", supportEmail: tenantRow?.supportEmail ?? undefined,
  }));
  const by = t.source === "staff" ? "by staff" : "via the Akbar API";
  await logBookingEvent(env, b.id, "TICKET", "info", `${firstIssue ? "Ticket issued" : "Ticket details corrected"} ${by} — PNR ${pnr}`, { ticketNumbers, supplierRef: supplierRef ?? null });
  if (firstIssue) await env.NOTIFY_QUEUE.send({ type: "NOTIFY_BOOKING_CONFIRMATION", bookingId: b.id, tenantId: b.tenantId, eticketKey });
  return { firstIssue, eticketKey };
}
