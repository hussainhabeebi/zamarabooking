// POST /api/checkout/session — create a signed checkout token for bot→web handoff
// GET  /api/checkout/session/:token — verify token and return booking context (server-side only)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { bookings, bookingPassengers } from "@poomas/db/schema";
import { eq, and } from "drizzle-orm";
import type { Env, Variables } from "../types.js";

const CHECKOUT_TTL = 20 * 60;  // 20 minutes

const createSchema = z.object({
  bookingId:      z.string(),
  whatsappPhone:  z.string().optional(),
  agentId:        z.string().optional(),
});

export const checkoutRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Helpers — HMAC-SHA256 JWT (HS256) using Web Crypto
export async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header  = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const body    = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const data    = `${header}.${body}`;
  const key     = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig     = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64  = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${sigB64}`;
}

export async function verifyToken(token: string, secret: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  const [header, body, sig] = parts;
  const data    = `${header}.${body}`;
  const key     = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const valid    = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  if (!valid) throw new Error("Invalid signature");
  const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return payload;
}

// POST /api/checkout/session — called by the WhatsApp bot after collecting passengers
// Auth: any authenticated agent or the session middleware verifies agentId
checkoutRoutes.post("/session", zValidator("json", createSchema), async (c) => {
  const { bookingId, whatsappPhone, agentId } = c.req.valid("json");
  const tenantId = c.get("tenantId");
  const db       = c.get("db");

  const [booking] = await db
    .select({
      id:          bookings.id,
      status:      bookings.status,
      totalAmount: bookings.totalAmount,
      currency:    bookings.currency,
      heldUntil:   bookings.heldUntil,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });
  if (!["HELD", "PAYMENT_PENDING"].includes(booking.status)) {
    throw new HTTPException(400, { message: `Booking is ${booking.status} — checkout not available` });
  }

  const now     = Math.floor(Date.now() / 1000);
  const exp     = now + CHECKOUT_TTL;
  const payload = { sub: bookingId, tenantId, whatsappPhone, agentId, iat: now, exp };
  const token   = await signToken(payload, c.env.JWT_SECRET);

  // Store token in KV for single-use enforcement
  await c.env.SESSIONS_KV.put(
    `checkout:${tenantId}:${bookingId}`,
    JSON.stringify({ token, used: false }),
    { expirationTtl: CHECKOUT_TTL + 60 },
  );

  // Update booking with whatsapp phone if provided
  if (whatsappPhone) {
    await db.update(bookings).set({ whatsappPhone }).where(eq(bookings.id, bookingId));
  }

  const apiUrl = `https://api.flypoomas.com`;
  const webUrl = `https://flypoomas.com`;

  return c.json({
    token,
    checkoutUrl: `${webUrl}/checkout/${token}`,
    expiresAt:   new Date(exp * 1000).toISOString(),
    booking: {
      id:          booking.id,
      totalAmount: booking.totalAmount,
      currency:    booking.currency,
      heldUntil:   booking.heldUntil,
    },
  });
});

// GET /api/checkout/session/:token — verify and return full booking context
// Called server-side from the checkout page; not exposed to the browser directly
checkoutRoutes.get("/session/:token", async (c) => {
  const token    = c.req.param("token");
  const tenantId = c.get("tenantId");
  const db       = c.get("db");

  let payload: Record<string, unknown>;
  try {
    payload = await verifyToken(token, c.env.JWT_SECRET);
  } catch (err: any) {
    throw new HTTPException(401, { message: err.message ?? "Invalid token" });
  }

  if (payload.tenantId !== tenantId) {
    throw new HTTPException(403, { message: "Token tenant mismatch" });
  }

  const bookingId = payload.sub as string;

  // Check KV store — token must exist and not be used for payment
  const kvRaw = await c.env.SESSIONS_KV.get(`checkout:${tenantId}:${bookingId}`);
  if (!kvRaw) throw new HTTPException(410, { message: "Checkout session expired" });

  const kv = JSON.parse(kvRaw) as { token: string; used: boolean };
  if (kv.token !== token) throw new HTTPException(401, { message: "Token superseded" });

  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });

  const passengers = await db
    .select()
    .from(bookingPassengers)
    .where(eq(bookingPassengers.bookingId, bookingId));

  return c.json({
    booking,
    passengers,
    meta: {
      whatsappPhone:  payload.whatsappPhone,
      agentId:        payload.agentId,
      tokenExpiresAt: new Date((payload.exp as number) * 1000).toISOString(),
    },
  });
});

// Passport extraction and passenger confirmation use the signed checkout token.
// The raw passport is processed in memory and is not persisted.
const passengerUpdateSchema = z.object({
  contactEmail: z.string().email().optional().or(z.literal("")),
  contactPhone: z.string().min(8).optional().or(z.literal("")),
  passengers: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    dob: z.string().optional().or(z.literal("")),
    gender: z.string().optional(),
    nationality: z.string().optional(),
    passportNumber: z.string().optional(),
    passportExpiry: z.string().optional().or(z.literal("")),
    passportCountry: z.string().optional(),
  })).min(1),
});

async function checkoutBookingId(c: any, token: string): Promise<string> {
  let payload: Record<string, unknown>;
  try { payload = await verifyToken(token, c.env.JWT_SECRET); }
  catch (err: any) { throw new HTTPException(401, { message: err.message ?? "Invalid token" }); }
  if (payload.tenantId !== c.get("tenantId")) throw new HTTPException(403, { message: "Token tenant mismatch" });
  const bookingId = String(payload.sub);
  const kvRaw = await c.env.SESSIONS_KV.get(`checkout:${c.get("tenantId")}:${bookingId}`);
  if (!kvRaw) throw new HTTPException(410, { message: "Checkout session expired" });
  const kv = JSON.parse(kvRaw) as { token: string; used: boolean };
  if (kv.token !== token || kv.used) throw new HTTPException(401, { message: "Checkout session is no longer valid" });
  return bookingId;
}

checkoutRoutes.post("/session/:token/passport-extract", async (c) => {
  const token = c.req.param("token");
  const bookingId = await checkoutBookingId(c, token);
  if (!c.env.GEMINI_API_KEY) throw new HTTPException(503, { message: "Passport scanner is not configured" });

  const form = await c.req.formData();
  const file = form.get("passport");
  const passengerId = String(form.get("passengerId") ?? "");
  if (!(file instanceof File)) throw new HTTPException(400, { message: "Passport image or PDF is required" });
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) {
    throw new HTTPException(415, { message: "Use JPG, PNG, WEBP or PDF" });
  }
  if (file.size > 8 * 1024 * 1024) throw new HTTPException(413, { message: "Passport file must be below 8 MB" });

  const db = c.get("db");
  const [passenger] = await db.select({ id: bookingPassengers.id })
    .from(bookingPassengers)
    .where(and(eq(bookingPassengers.id, passengerId), eq(bookingPassengers.bookingId, bookingId)))
    .limit(1);
  if (!passenger) throw new HTTPException(404, { message: "Passenger not found" });

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const base64 = btoa(binary);
  const prompt = "Extract the passport identity page. Return only the requested JSON. Copy names exactly. Dates must be YYYY-MM-DD. Use ISO alpha-3 country codes when clear. Confidence is 0 to 1. If unreadable, return empty strings and low confidence. Do not infer missing values.";
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(c.env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inlineData: { mimeType: file.type, data: base64 } },
        ] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              documentType: { type: "STRING" },
              surname: { type: "STRING" },
              givenNames: { type: "STRING" },
              passportNumber: { type: "STRING" },
              nationality: { type: "STRING" },
              dateOfBirth: { type: "STRING" },
              gender: { type: "STRING" },
              countryOfIssue: { type: "STRING" },
              issueDate: { type: "STRING" },
              expiryDate: { type: "STRING" },
              mrzLine1: { type: "STRING" },
              mrzLine2: { type: "STRING" },
              confidence: {
                type: "OBJECT",
                properties: {
                  name: { type: "NUMBER" },
                  passportNumber: { type: "NUMBER" },
                  dateOfBirth: { type: "NUMBER" },
                  expiryDate: { type: "NUMBER" },
                },
              },
            },
            required: ["surname", "givenNames", "passportNumber", "nationality", "dateOfBirth", "gender", "countryOfIssue", "expiryDate", "confidence"],
          },
        },
      }),
    },
  );
  if (!geminiRes.ok) {
    const detail = await geminiRes.text();
    throw new HTTPException(502, { message: `Passport extraction failed: ${detail.slice(0, 160)}` });
  }
  const response = await geminiRes.json() as any;
  const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new HTTPException(422, { message: "Passport details could not be read" });
  let extracted: any;
  try { extracted = JSON.parse(text); }
  catch { throw new HTTPException(422, { message: "Passport details could not be parsed" }); }
  return c.json({ extracted, rawFileStored: false });
});

checkoutRoutes.put("/session/:token/passengers", zValidator("json", passengerUpdateSchema), async (c) => {
  const token = c.req.param("token");
  const bookingId = await checkoutBookingId(c, token);
  const body = c.req.valid("json");
  const db = c.get("db");

  for (const p of body.passengers) {
    await db.update(bookingPassengers).set({
      title: p.title || null,
      firstName: p.firstName.trim().toUpperCase(),
      lastName: p.lastName.trim().toUpperCase(),
      dob: p.dob ? new Date(p.dob) : null,
      gender: p.gender || null,
      nationality: p.nationality?.toUpperCase() || null,
      passportNumber: p.passportNumber?.replace(/\s/g, "").toUpperCase() || null,
      passportExpiry: p.passportExpiry ? new Date(p.passportExpiry) : null,
      passportCountry: p.passportCountry?.toUpperCase() || null,
    }).where(and(eq(bookingPassengers.id, p.id), eq(bookingPassengers.bookingId, bookingId)));
  }

  await db.update(bookings).set({
    contactEmail: body.contactEmail || null,
    contactPhone: body.contactPhone || null,
    updatedAt: new Date(),
  }).where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, c.get("tenantId"))));

  return c.json({ ok: true });
});

// POST /api/checkout/session/:token/mark-paid — called after successful payment to invalidate token
checkoutRoutes.post("/session/:token/mark-paid", async (c) => {
  const token    = c.req.param("token");
  const tenantId = c.get("tenantId");

  let payload: Record<string, unknown>;
  try {
    payload = await verifyToken(token, c.env.JWT_SECRET);
  } catch {
    throw new HTTPException(401, { message: "Invalid token" });
  }

  const bookingId = payload.sub as string;
  const kvRaw = await c.env.SESSIONS_KV.get(`checkout:${tenantId}:${bookingId}`);
  if (kvRaw) {
    const kv = JSON.parse(kvRaw);
    await c.env.SESSIONS_KV.put(
      `checkout:${tenantId}:${bookingId}`,
      JSON.stringify({ ...kv, used: true }),
      { expirationTtl: 300 },  // Keep for 5 min for dedup
    );
  }

  return c.json({ ok: true });
});
