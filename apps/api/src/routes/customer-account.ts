// Customer account (mounted at /api/profile/account, customer JWT required)
//   GET  /            profile
//   PUT  /            update name / phone / WhatsApp opt-in
//   POST /password    change password
//
// Support requests
//   /api/profile/support   GET list, POST create   (signed-in customer)
//   /api/trips/support     POST create             (guest with X-Trip-Token)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { bookings, supportRequests, users } from "@poomas/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { pbkdf2HashPassword, verifyPassword } from "./auth.js";
import { guestTrip } from "./trips.js";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

function requireCustomer(c: any) {
  if (c.get("userRole") !== "CUSTOMER" || !c.get("userId")) {
    throw new HTTPException(403, { message: "Sign in with a customer account" });
  }
  return c.get("userId") as string;
}

export const customerAccountRoutes: App = new Hono();

customerAccountRoutes.get("/", async (c) => {
  const userId = requireCustomer(c);
  const [u] = await c.get("db").select({
    name: users.name, email: users.email, phone: users.phone, whatsappOptIn: users.whatsappOptIn,
    hasPassword: users.passwordHash, socialProvider: users.socialProvider, createdAt: users.createdAt,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new HTTPException(404, { message: "Account not found" });
  return c.json({ account: { ...u, hasPassword: Boolean(u.hasPassword) } });
});

customerAccountRoutes.put("/", zValidator("json", z.object({
  name:          z.string().trim().min(2).max(100),
  phone:         z.string().trim().min(8).max(20).nullable().optional(),
  whatsappOptIn: z.boolean().optional(),
})), async (c) => {
  const userId = requireCustomer(c);
  const db = c.get("db");
  const body = c.req.valid("json");
  if (body.phone) {
    const [taken] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.tenantId, c.get("tenantId")), eq(users.phone, body.phone), ne(users.id, userId))).limit(1);
    if (taken) throw new HTTPException(409, { message: "This phone number is used by another account" });
  }
  await db.update(users).set({
    name: body.name,
    ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
    ...(body.whatsappOptIn !== undefined ? { whatsappOptIn: body.whatsappOptIn } : {}),
    updatedAt: new Date(),
  }).where(eq(users.id, userId));
  return c.json({ ok: true });
});

customerAccountRoutes.post("/password", zValidator("json", z.object({
  currentPassword: z.string().optional(),
  newPassword:     z.string().min(8).max(200),
})), async (c) => {
  const userId = requireCustomer(c);
  const db = c.get("db");
  const { currentPassword, newPassword } = c.req.valid("json");
  const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  // Social-only accounts have no password yet and may set one.
  if (u?.passwordHash && !(currentPassword && await verifyPassword(currentPassword, u.passwordHash))) {
    throw new HTTPException(400, { message: "Current password is incorrect" });
  }
  await db.update(users).set({ passwordHash: await pbkdf2HashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, userId));
  return c.json({ ok: true });
});

// ── Support requests ─────────────────────────────────────────────────────────

export const SUPPORT_TYPES = ["DATE_CHANGE", "ADD_BAGGAGE", "MEAL_SEAT", "NAME_CORRECTION", "CANCELLATION_HELP", "OTHER"] as const;
const supportSchema = z.object({
  type:      z.enum(SUPPORT_TYPES),
  message:   z.string().trim().min(5).max(2000),
  bookingId: z.string().optional(),
});

export const customerSupportRoutes: App = new Hono();

customerSupportRoutes.get("/", async (c) => {
  const userId = requireCustomer(c);
  const rows = await c.get("db").select().from(supportRequests)
    .where(eq(supportRequests.userId, userId)).orderBy(desc(supportRequests.createdAt)).limit(50);
  return c.json({ requests: rows });
});

customerSupportRoutes.post("/", zValidator("json", supportSchema), async (c) => {
  const userId = requireCustomer(c);
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const body = c.req.valid("json");
  if (body.bookingId) {
    const [own] = await db.select({ id: bookings.id }).from(bookings)
      .where(and(eq(bookings.id, body.bookingId), eq(bookings.tenantId, tenantId), eq(bookings.userId, userId))).limit(1);
    if (!own) throw new HTTPException(404, { message: "Booking not found" });
  }
  const [u] = await db.select({ email: users.email, phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
  const [row] = await db.insert(supportRequests).values({
    tenantId, userId, bookingId: body.bookingId ?? null, type: body.type, message: body.message,
    contactEmail: u?.email ?? null, contactPhone: u?.phone ?? null,
  }).returning();
  return c.json({ request: row }, 201);
});

export async function createGuestSupportRequest(c: any) {
  const parsed = supportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: "Choose a request type and describe what you need (at least 5 characters)" });
  const body = parsed.data;
  const trip = await guestTrip(c);
  const [row] = await c.get("db").insert(supportRequests).values({
    tenantId: c.get("tenantId"), userId: trip.booking.userId ?? null, bookingId: trip.booking.id,
    type: body.type, message: body.message,
    contactEmail: trip.booking.contactEmail, contactPhone: trip.booking.contactPhone,
  }).returning();
  return c.json({ request: row }, 201);
}
