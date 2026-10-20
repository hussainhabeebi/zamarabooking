// Admin → TripJack hotels (v3): city index sync, hold confirmation, cancellation,
// booking lookups. Kept off the public /api/hotels routes on purpose.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { parseHotelBookingDetails } from "@poomas/suppliers";
import type { Env, Variables } from "../../types.js";
import { cityIndexStatus, hotelClient, hotelExchanges, hotelRecorder, syncCityIndex } from "../../lib/hotels.js";
import { hotelError, logged, pollDetails } from "../hotel.js";

export const hotelsAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
// Booking actions keep raw request / response logs (the city sync pages are too large to keep).
hotelsAdminRoutes.use("/bookings/*", hotelExchanges);

hotelsAdminRoutes.get("/city-index", async (c) => c.json(await cityIndexStatus(c.env)));

// Pages through TripJack city region IDs a few pages per call; the Admin page
// calls it repeatedly until { done: true }.
hotelsAdminRoutes.post("/city-index/sync", zValidator("json", z.object({ restart: z.boolean().default(false) })), async (c) => {
  const { restart } = c.req.valid("json");
  const client = await hotelClient(c.env, c.get("tenantId"));
  try {
    return c.json(await logged(c, "/hms/v3/content/fetch-city-regionIds", { restart }, () => syncCityIndex(c.env, client, restart),
      (r) => ({ ...r })));
  } catch (err) {
    return hotelError(c, err, "City sync failed");
  }
});

hotelsAdminRoutes.post("/bookings/list", zValidator("json", z.object({ startDate: z.string(), endDate: z.string() })), async (c) => {
  const { startDate, endDate } = c.req.valid("json");
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    const res = await logged(c, "/oms/v1/hotel/bookings", { startDate, endDate }, () => client.bookingList(startDate, endDate),
      (r) => ({ count: r.bookings?.length ?? 0 }));
    return c.json({ bookings: res.bookings ?? [] });
  } catch (err) {
    return hotelError(c, err, "Could not load hotel bookings");
  }
});

hotelsAdminRoutes.get("/bookings/:bookingId", async (c) => {
  const { bookingId } = c.req.param();
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    const raw = await logged(c, "/oms/v3/hotel/booking-details", { bookingId, source: "admin" }, () => client.bookingDetails(bookingId));
    return c.json({ details: parseHotelBookingDetails(raw), raw });
  } catch (err) {
    return hotelError(c, err, "Could not load the hotel booking");
  }
});

hotelsAdminRoutes.post("/bookings/:bookingId/confirm", zValidator("json", z.object({ amount: z.number().positive() })), async (c) => {
  const { bookingId } = c.req.param();
  const { amount } = c.req.valid("json");
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    await logged(c, "/oms/v3/hotel/confirm-book", { bookingId, amount }, () => client.confirmBook(bookingId, amount));
    const details = await pollDetails(c, client, bookingId, 20_000);
    return c.json({ bookingId, status: details?.status ?? "IN_PROGRESS", details });
  } catch (err) {
    return hotelError(c, err, "Could not confirm the hotel booking");
  }
});

hotelsAdminRoutes.post("/bookings/:bookingId/cancel", async (c) => {
  const { bookingId } = c.req.param();
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    await logged(c, "/oms/v3/hotel/cancel-booking", { bookingId }, () => client.cancel(bookingId));
    const details = parseHotelBookingDetails(await client.bookingDetails(bookingId).catch(() => ({})));
    return c.json({ bookingId, status: details.status || "CANCELLATION_REQUESTED", details });
  } catch (err) {
    return hotelError(c, err, "Could not cancel the hotel booking");
  }
});
