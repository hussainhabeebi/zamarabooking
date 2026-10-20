// GET/POST/DELETE /api/profile/passengers — saved traveller profiles (authenticated)

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { savedPassengers } from "@poomas/db/schema";
import { eq, and } from "drizzle-orm";
import type { Env, Variables } from "../types.js";

const passengerSchema = z.object({
  firstName:      z.string().min(1),
  lastName:       z.string().min(1),
  dob:            z.string().optional(),
  gender:         z.enum(["M", "F"]).optional(),
  nationality:    z.string().length(2).toUpperCase().optional(),
  passportNumber: z.string().optional(),
  passportExpiry: z.string().optional(),
  isDefault:      z.boolean().optional(),
});

export const profileRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

profileRoutes.get("/passengers", async (c) => {
  const db     = c.get("db");
  const userId = c.get("userId");
  if (!userId) throw new HTTPException(401, { message: "Authentication required" });

  const rows = await db
    .select()
    .from(savedPassengers)
    .where(eq(savedPassengers.userId, userId))
    .orderBy(savedPassengers.isDefault, savedPassengers.createdAt);

  return c.json({ passengers: rows });
});

profileRoutes.post("/passengers", zValidator("json", passengerSchema), async (c) => {
  const db     = c.get("db");
  const userId = c.get("userId");
  if (!userId) throw new HTTPException(401, { message: "Authentication required" });

  const body = c.req.valid("json");

  // If new passenger is default, unset any existing default first
  if (body.isDefault) {
    await db
      .update(savedPassengers)
      .set({ isDefault: false })
      .where(and(eq(savedPassengers.userId, userId), eq(savedPassengers.isDefault, true)));
  }

  const [row] = await db.insert(savedPassengers).values({
    userId,
    firstName:      body.firstName,
    lastName:       body.lastName,
    dob:            body.dob ? new Date(body.dob) : null,
    gender:         body.gender ?? null,
    nationality:    body.nationality ?? null,
    passportNumber: body.passportNumber ?? null,
    passportExpiry: body.passportExpiry ? new Date(body.passportExpiry) : null,
    passportCountry: body.nationality ?? null,
    isDefault:      body.isDefault ?? false,
  }).returning();

  return c.json({ passenger: row }, 201);
});

profileRoutes.delete("/passengers/:id", async (c) => {
  const db     = c.get("db");
  const userId = c.get("userId");
  if (!userId) throw new HTTPException(401, { message: "Authentication required" });

  const { id } = c.req.param();
  const deleted = await db
    .delete(savedPassengers)
    .where(and(eq(savedPassengers.id, id), eq(savedPassengers.userId, userId)))
    .returning();

  if (!deleted.length) throw new HTTPException(404, { message: "Passenger not found" });
  return c.json({ success: true });
});
