// Transactional emails (all through Resend, lib/email.ts). Each one carries an
// idempotency key so a retried job or a double click never sends it twice.

import { eq } from "drizzle-orm";
import { agents, bookingAmendments, bookingPassengers, bookings } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";
import { emailLayout, sendMail } from "./email.js";
import { escapeHtml, WEB_URL } from "./customer-notify.js";

type Db = Variables["db"];
type Amendment = typeof bookingAmendments.$inferSelect;

const fmt = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${currency} ${amount.toFixed(2)}`; }
};

async function bookingFor(db: Db, bookingId: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b) return null;
  const pax = await db.select({ firstName: bookingPassengers.firstName, lastName: bookingPassengers.lastName }).from(bookingPassengers).where(eq(bookingPassengers.bookingId, bookingId));
  return { b, travellers: pax.map((p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`).join(", ") };
}

const REFUND_TO: Record<string, string> = {
  WALLET: "your FlyPoomas wallet — available straight away",
  AGENT_WALLET: "your agency wallet — available straight away",
  NOMOD: "the card / account you paid with — usually 5–10 working days, depending on your bank",
  MANUAL: "your original payment method — our team will process it and confirm",
};

// Payment taken but the airline didn't issue the ticket: refund already started.
export async function emailBookingFailed(env: Env, db: Db, bookingId: string, gatewayPaymentId: string) {
  const found = await bookingFor(db, bookingId);
  if (!found?.b.contactEmail) return;
  const { b, travellers } = found;
  const method = gatewayPaymentId.startsWith("agentwallet_") ? "AGENT_WALLET" : gatewayPaymentId.startsWith("wallet_") ? "WALLET" : "NOMOD";
  await sendMail(env, db, b.tenantId, {
    to: b.contactEmail!, category: "refund", idempotencyKey: `booking-failed:${b.id}`, copyOps: true,
    subject: `We couldn't confirm your booking ${b.origin} → ${b.destination} — refund started`,
    html: emailLayout({
      title: "Your booking couldn't be confirmed",
      preheader: "The airline didn't issue the ticket. Your full payment is being refunded.",
      body: `<p>We're sorry — the airline didn't confirm this booking, so no ticket was issued. <b>Your full payment is being refunded</b> to ${escapeHtml(REFUND_TO[method])}.</p><p>You can search again for another flight; fares change often, so a similar option may still be available.</p>`,
      rows: [["Route", `${b.origin} → ${b.destination}`], ["Travellers", travellers || "—"], ["Refund", fmt(Number(b.totalAmount), b.currency)], ["Booking reference", b.id.slice(0, 8).toUpperCase()]],
      cta: { label: "Search flights again", href: WEB_URL },
    }),
  });
}

export type CancellationEvent = "REQUESTED" | "CONFIRMED" | "REJECTED" | "REFUNDED";

export async function emailCancellation(env: Env, db: Db, a: Amendment, event: CancellationEvent) {
  try {
    const found = await bookingFor(db, a.bookingId);
    if (!found?.b.contactEmail) return;
    const { b, travellers } = found;
    const refund = Number(a.refundAmount ?? 0);
    const route = `${b.origin} → ${b.destination}`;
    const rows: [string, string][] = [["PNR", b.pnr ?? "—"], ["Route", route], ["Travellers", travellers || "—"]];
    const copy: Record<CancellationEvent, { subject: string; title: string; body: string; rows: [string, string][] }> = {
      REQUESTED: {
        subject: `Cancellation requested — PNR ${b.pnr ?? ""} · ${route}`, title: "We've received your cancellation request",
        body: "<p>We've sent your cancellation to the airline. We'll email you as soon as it's confirmed, with the refund amount under the airline's fare rules.</p>",
        rows,
      },
      CONFIRMED: {
        subject: `Cancellation confirmed — PNR ${b.pnr ?? ""}`, title: "Your booking is cancelled",
        body: refund > 0
          ? `<p>The airline has cancelled your booking. A refund of <b>${escapeHtml(fmt(refund, a.currency))}</b> goes to ${escapeHtml(REFUND_TO[a.refundMethod] ?? REFUND_TO.MANUAL)}. We'll confirm when it's paid.</p>`
          : "<p>The airline has cancelled your booking. Under the fare rules no refund is due for this ticket.</p>",
        rows: [...rows, ["Amount paid", fmt(Number(a.amountPaid), a.currency)], ["Refund", fmt(refund, a.currency)]],
      },
      REJECTED: {
        subject: `Cancellation not possible — PNR ${b.pnr ?? ""}`, title: "The airline couldn't cancel this booking",
        body: `<p>The airline didn't accept the cancellation, so your booking stays as it is. Reply to this email and our team will help you with the options (date change, no-show refund of taxes, …).</p>`,
        rows,
      },
      REFUNDED: {
        subject: `Refund paid — ${fmt(refund, a.currency)} · PNR ${b.pnr ?? ""}`, title: "Your refund has been paid",
        body: `<p>We've refunded <b>${escapeHtml(fmt(refund, a.currency))}</b> to ${escapeHtml(REFUND_TO[a.refundMethod] ?? REFUND_TO.MANUAL)}.</p>`,
        rows: [...rows, ["Refund", fmt(refund, a.currency)], ...(a.refundReference && !a.refundReference.startsWith("manual") ? [["Reference", a.refundReference] as [string, string]] : [])],
      },
    };
    const m = copy[event];
    await sendMail(env, db, b.tenantId, {
      to: b.contactEmail!, category: "refund", idempotencyKey: `cancellation:${a.id}:${event}`, copyOps: event !== "REQUESTED",
      subject: m.subject, html: emailLayout({ title: m.title, body: m.body, rows: m.rows, cta: { label: "View my trip", href: `${WEB_URL}/trips` } }),
    });
  } catch (err) {
    console.error("[email] cancellation", err);
  }
}

// ── Agencies ─────────────────────────────────────────────────────────────────

const portal = (env: Env) => (env.PORTAL_URL ?? "https://portal.flypoomas.com").replace(/\/$/, "");

export async function emailAgencyRegistered(env: Env, db: Db, agent: { id: string; tenantId: string; email: string; businessName: string; ownerName: string }) {
  await sendMail(env, db, agent.tenantId, {
    to: agent.email, category: "agency", idempotencyKey: `agency-registered:${agent.id}`,
    subject: `Welcome to FlyPoomas, ${agent.businessName}`,
    html: emailLayout({
      title: "Thanks for registering your agency",
      body: `<p>Hi ${escapeHtml(agent.ownerName)}, we've received <b>${escapeHtml(agent.businessName)}</b>'s registration.</p><p>Next: sign in and upload your KYC documents (trade licence / GST and owner ID) and sign the agency MOU. We usually approve agencies within one working day after that.</p>`,
      cta: { label: "Open the agent portal", href: `${portal(env)}/login` },
    }),
  });
}

export async function emailAgencyStatus(env: Env, db: Db, agentId: string, status: "APPROVED" | "REJECTED" | "SUSPENDED") {
  const [a] = await db.select({ id: agents.id, tenantId: agents.tenantId, email: agents.email, businessName: agents.businessName, ownerName: agents.ownerName, agentNumber: agents.agentNumber })
    .from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!a) return;
  const copy = {
    APPROVED: { subject: `Your agency is approved — ${a.businessName}`, title: "Your agency is approved 🎉",
      body: `<p>Hi ${escapeHtml(a.ownerName)}, <b>${escapeHtml(a.businessName)}</b> can now book flights on FlyPoomas.${a.agentNumber ? ` Your agent number is <b>${escapeHtml(a.agentNumber)}</b>.` : ""}</p><p>Recharge your wallet (card or bank transfer) to start booking.</p>` },
    REJECTED: { subject: `About your FlyPoomas agency registration`, title: "We couldn't approve your agency",
      body: `<p>Hi ${escapeHtml(a.ownerName)}, we weren't able to approve <b>${escapeHtml(a.businessName)}</b> at this time. Reply to this email if you'd like to know more or send updated documents.</p>` },
    SUSPENDED: { subject: `Your FlyPoomas agency account is suspended`, title: "Your agency account is suspended",
      body: `<p>Hi ${escapeHtml(a.ownerName)}, bookings for <b>${escapeHtml(a.businessName)}</b> are paused. Reply to this email or contact our team to resolve it.</p>` },
  }[status];
  await sendMail(env, db, a.tenantId, {
    to: a.email, category: "agency", idempotencyKey: `agency-status:${a.id}:${status}:${new Date().toISOString().slice(0, 10)}`,
    subject: copy.subject, html: emailLayout({ title: copy.title, body: copy.body, cta: { label: "Open the agent portal", href: `${portal(env)}/login` } }),
  });
}

export async function emailAgentTopup(env: Env, db: Db, agentId: string, amount: number, currency: string, balance: number | null, reference: string) {
  const [a] = await db.select({ tenantId: agents.tenantId, email: agents.email, businessName: agents.businessName }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!a) return;
  await sendMail(env, db, a.tenantId, {
    to: a.email, category: "wallet", idempotencyKey: `agent-topup:${reference}`,
    subject: `Wallet recharged — ${fmt(amount, currency)}`,
    html: emailLayout({
      title: "Your wallet has been recharged",
      body: `<p>${escapeHtml(fmt(amount, currency))} has been added to <b>${escapeHtml(a.businessName)}</b>'s wallet.</p>`,
      rows: [["Amount", fmt(amount, currency)], ...(balance !== null ? [["New balance", fmt(balance, currency)] as [string, string]] : []), ["Reference", reference]],
      cta: { label: "View wallet", href: `${portal(env)}/wallet` },
    }),
  });
}

// ── Customers ────────────────────────────────────────────────────────────────

export async function emailCustomerWelcome(env: Env, db: Db, tenantId: string, user: { id: string; email: string; name: string | null }) {
  await sendMail(env, db, tenantId, {
    to: user.email, category: "auth", idempotencyKey: `welcome:${user.id}`,
    subject: "Welcome to FlyPoomas",
    html: emailLayout({
      title: `Welcome${user.name ? `, ${user.name.split(" ")[0]}` : ""}!`,
      body: "<p>Your FlyPoomas account is ready. Save travellers for faster checkout, keep all your trips in one place, and get fare alerts when prices drop.</p>",
      cta: { label: "Search flights", href: WEB_URL },
    }),
  });
}
