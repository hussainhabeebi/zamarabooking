// GET  /api/eticket/:bookingId      — serves e-ticket HTML for a confirmed booking
// POST /api/eticket/:bookingId/send — send e-ticket via WhatsApp (Leadvyne) + email (Resend)

import { emailLayout, sendMail } from "../lib/email.js";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { bookings, bookingPassengers } from "@poomas/db/schema";
import { eq, and } from "drizzle-orm";
import type { Env, Variables } from "../types.js";

export const eticketRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

eticketRoutes.get("/:bookingId", async (c) => {
  const db        = c.get("db");
  const tenantId  = c.get("tenantId");
  const bookingId = c.req.param("bookingId");

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, pnr: bookings.pnr })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });
  if (!["CONFIRMED", "TICKETED"].includes(booking.status)) {
    throw new HTTPException(400, { message: "E-ticket only available for confirmed bookings" });
  }

  const key = `etickets/${bookingId}.html`;
  const obj = await c.env.DOCUMENTS_R2.get(key);
  if (!obj) throw new HTTPException(404, { message: "E-ticket not yet generated" });

  const html = await obj.text();
  return c.body(html, 200, {
    "Content-Type":        "text/html; charset=utf-8",
    "Content-Disposition": `attachment; filename="eticket-${booking.pnr ?? bookingId}.html"`,
    "Cache-Control":       "private, no-cache",
  });
});

const sendSchema = z.object({
  channels: z.array(z.enum(["WHATSAPP", "EMAIL"])).min(1).default(["WHATSAPP", "EMAIL"]),
  whatsappPhone: z.string().optional(),  // Override; falls back to booking.whatsappPhone
  email:         z.string().email().optional(),  // Override; falls back to booking.contactEmail
});

eticketRoutes.post("/:bookingId/send", zValidator("json", sendSchema), async (c) => {
  const db        = c.get("db");
  const tenantId  = c.get("tenantId");
  const bookingId = c.req.param("bookingId");
  const body      = c.req.valid("json");

  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });
  if (!["CONFIRMED", "TICKETED"].includes(booking.status)) {
    throw new HTTPException(400, { message: "E-ticket only available for confirmed bookings" });
  }

  const passengers = await db
    .select({ firstName: bookingPassengers.firstName, lastName: bookingPassengers.lastName })
    .from(bookingPassengers)
    .where(eq(bookingPassengers.bookingId, bookingId));

  const paxNames  = passengers.map((p) => `${p.firstName} ${p.lastName}`).join(", ");
  const flightData = booking.flightData as Record<string, unknown>;
  const pnr       = booking.pnr ?? "TBD";

  // Public URL for the e-ticket HTML (stored in PUBLIC_ASSETS_R2 after generation)
  const eticketUrl = `https://assets.flypoomas.com/etickets/${bookingId}.html`;

  const results: Record<string, unknown> = {};

  // ── WhatsApp via Leadvyne ──────────────────────────────────────────────────
  if (body.channels.includes("WHATSAPP") && c.env.LEADVYNE_API_KEY) {
    const phone = body.whatsappPhone ?? booking.whatsappPhone;
    if (phone) {
      const msg = [
        `✈️ *Booking Confirmed!*`,
        `PNR: *${pnr}*`,
        `Route: ${booking.origin} → ${booking.destination}`,
        `Passengers: ${paxNames}`,
        ``,
        `📄 Download your e-ticket:`,
        eticketUrl,
      ].join("\n");

      try {
        const waRes = await fetch(`${c.env.LEADVYNE_BASE_URL ?? "https://api.leadvyne.com"}/v1/messages/send`, {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${c.env.LEADVYNE_API_KEY}`,
            "X-Instance-ID": c.env.LEADVYNE_INSTANCE_ID ?? "",
          },
          body: JSON.stringify({ to: phone, message: msg }),
        });
        results.whatsapp = { ok: waRes.ok, status: waRes.status };
      } catch (err: any) {
        results.whatsapp = { ok: false, error: err.message };
      }
    } else {
      results.whatsapp = { ok: false, error: "No WhatsApp phone on booking" };
    }
  }

  // ── Email via Resend ───────────────────────────────────────────────────────
  if (body.channels.includes("EMAIL")) {
    const email = body.email ?? booking.contactEmail;
    if (email) {
      const r = await sendMail(c.env, db, booking.tenantId, {
        to: email, category: "booking",
        subject: `E-ticket — PNR ${pnr} · ${booking.origin} → ${booking.destination}`,
        html: emailLayout({
          title: "Your e-ticket is ready",
          body: "<p>Here is your e-ticket. Show it with your passport / ID at the airport.</p>",
          rows: [["PNR", pnr], ["Route", `${booking.origin} → ${booking.destination}`], ["Travellers", paxNames], ["Total paid", `${booking.currency} ${booking.totalAmount}`]],
          cta: { label: "Download e-ticket", href: eticketUrl },
        }),
      });
      results.email = r.ok ? { ok: true, status: 200 } : { ok: false, error: r.error };
    } else {
      results.email = { ok: false, error: "No contact email on booking" };
    }
  }

  return c.json({ bookingId, pnr, results });
});
