import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { getBookableAdapter, TripjackClient, type SupplierConfig, type PlatformCredentials } from "@poomas/suppliers";
import { bookings, bookingPassengers, payments, walletAccounts, walletTransactions } from "@poomas/db/schema";
import { eq, and } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { logSupplierCall } from "../lib/supplier-logger.js";

const passengerSchema = z.object({
  type:            z.enum(["ADULT", "CHILD", "INFANT"]),
  firstName:       z.string().min(1),
  lastName:        z.string().min(1),
  dob:             z.string().optional(),
  gender:          z.enum(["M", "F"]).optional(),
  nationality:     z.string().length(2).optional(),
  passportNumber:  z.string().optional(),
  passportExpiry:  z.string().optional(),
  passportCountry: z.string().length(2).optional(),
});

const fareSnapshotSchema = z.object({
  origin:        z.string(),
  destination:   z.string(),
  departureTime: z.string(),
  baseFare:      z.number(),
  taxes:         z.number(),
  totalFare:     z.number(),
  currency:      z.string(),
  airlineName:   z.string().optional(),
  flightNumber:  z.string().optional(),
}).optional();

const bookingCreateSchema = z.object({
  fareId:       z.string(),
  supplier:     z.enum(["RIYA", "TRIPJACK"]),
  sessionId:    z.string().optional(),
  passengers:   z.array(passengerSchema).min(1),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(8),
  gstNumber:    z.string().optional(),
  promoCode:    z.string().optional(),
  paymentMethod: z.enum(["GATEWAY", "WALLET"]).default("GATEWAY"),
  fareSnapshot: fareSnapshotSchema,
});

export const bookingRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Create / initiate booking
bookingRoutes.post("/", zValidator("json", bookingCreateSchema), async (c) => {
  const body     = c.req.valid("json");
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const tenant   = c.get("tenant");
  const userId   = c.get("userId");
  const agentId  = c.get("agentId");

  const supplierConfigs: SupplierConfig[] = tenant.supplierConfigs.map((sc) => ({
    name:        sc.supplier as "RIYA" | "TRIPJACK" | "GOOGLE_SERP",
    isEnabled:   sc.isEnabled,
    priority:    sc.priority,
    credentials: sc.credentials,
    timeoutMs:   sc.timeoutMs,
    maxRetries:  sc.maxRetries,
  }));

  const platformCredentials: PlatformCredentials = {
    ...(c.env.RIYA_API_KEY ? {
      RIYA: { apiKey: c.env.RIYA_API_KEY, secretKey: c.env.RIYA_API_SECRET, baseUrl: c.env.RIYA_API_BASE_URL },
    } : {}),
  };

  if (body.supplier === "TRIPJACK") {
    const saved = await c.env.TENANT_CACHE_KV.get(
      `admin_settings:${tenantId}:integration:tripjack`,
      "json",
    ) as { enabled?: boolean; apiKey?: string; baseUrl?: string } | null;
    const apiKey = saved?.apiKey || c.env.TRIPJACK_API_KEY;
    const baseUrl = c.env.TRIPJACK_API_BASE_URL || saved?.baseUrl;
    if ((apiKey || c.env.TRIPJACK_PROXY_KEY) && baseUrl) {
      platformCredentials.TRIPJACK = { apiKey, baseUrl, omsBaseUrl: c.env.TRIPJACK_OMS_BASE_URL || undefined, proxyKey: c.env.TRIPJACK_PROXY_KEY };
      let config = supplierConfigs.find((item) => item.name === "TRIPJACK");
      if (!config) {
        const newConfig = {
          name: "TRIPJACK" as const, isEnabled: saved ? saved.enabled === true : true,
          priority: 20, credentials: platformCredentials.TRIPJACK ?? null, timeoutMs: 25000, maxRetries: 0,
        };
        supplierConfigs.push(newConfig);
        config = newConfig;
      } else {
        config.isEnabled = saved ? saved.enabled === true : true;
        config.credentials = { ...(config.credentials ?? {}), ...platformCredentials.TRIPJACK };
      }
    }
  }

  const adapter = getBookableAdapter(body.supplier, supplierConfigs, platformCredentials);

  // TripJack review already holds the current price and returns its booking ID.
  if (body.supplier === "TRIPJACK") {
    const snap = body.fareSnapshot;
    if (!snap) throw new HTTPException(400, { message: "fareSnapshot is required for TripJack bookings" });
    if (!body.sessionId) throw new HTTPException(400, { message: "TripJack fare must be reviewed before booking" });
    if (!adapter.book) throw new HTTPException(500, { message: "TripJack book method not available" });

    let bookResult;
    const bookStart = Date.now();
    try {
      bookResult = await adapter.book({
        fareId:       body.fareId,
        holdId:       body.sessionId,  // Booking ID returned by TripJack /fms/v1/review
        sessionId:    body.sessionId,
        passengers:   body.passengers,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        paymentRef:   "TRIPJACK_DIRECT",
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      void logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/oms/v1/air/book",
        level: "ERROR", requestId: body.sessionId,
        requestSummary: { fareId: body.fareId, sessionId: body.sessionId,
          origin: snap.origin, destination: snap.destination, paxCount: body.passengers.length },
        errorCode: "BOOKING_FAILED", errorMessage: errMsg,
        durationMs: Date.now() - bookStart });
      throw new HTTPException(422, { message: errMsg });
    }

    if (!bookResult.success) {
      void logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/oms/v1/air/book",
        httpStatus: 200, level: "ERROR", requestId: body.sessionId,
        requestSummary: { fareId: body.fareId, sessionId: body.sessionId,
          origin: snap.origin, destination: snap.destination, paxCount: body.passengers.length },
        errorCode: "BOOKING_REJECTED", errorMessage: "TripJack booking was not confirmed",
        durationMs: Date.now() - bookStart });
      throw new HTTPException(422, { message: "TripJack booking was not confirmed" });
    }

    void logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/oms/v1/air/book",
      httpStatus: 200, level: "INFO", requestId: body.sessionId,
      requestSummary: { fareId: body.fareId, bookingRef: bookResult.bookingRef, pnr: bookResult.pnr,
        origin: snap.origin, destination: snap.destination, paxCount: body.passengers.length },
      durationMs: Date.now() - bookStart });

    const paxValues = body.passengers.map((p) => ({
      passengerType: p.type,
      firstName:     p.firstName,
      lastName:      p.lastName,
      dob:           p.dob ? new Date(p.dob) : null,
      gender:        p.gender ?? null,
      nationality:   p.nationality ?? null,
      passportNumber:  p.passportNumber  ?? null,
      passportExpiry:  p.passportExpiry  ? new Date(p.passportExpiry) : null,
      passportCountry: p.passportCountry ?? null,
    }));

    let booking: typeof bookings.$inferSelect | undefined;
    try {
      [booking] = await db.insert(bookings).values({
        tenantId,
        userId:             userId ?? null,
        agentId:            agentId ?? null,
        channel:            agentId ? "B2B_PORTAL" : "B2C_WEB",
        status:             "CONFIRMED",
        tripType:           "ONEWAY",
        cabinClass:         "ECONOMY",
        origin:             snap.origin,
        destination:        snap.destination,
        departureDate:      new Date(snap.departureTime),
        flightData:         snap as unknown as Record<string, unknown>,
        adultCount:         body.passengers.filter((p) => p.type === "ADULT").length,
        childCount:         body.passengers.filter((p) => p.type === "CHILD").length,
        infantCount:        body.passengers.filter((p) => p.type === "INFANT").length,
        baseFare:           String(snap.baseFare),
        taxes:              String(snap.taxes),
        totalAmount:        String(snap.totalFare),
        currency:           snap.currency.toUpperCase() as "INR" | "AED" | "USD",
        supplier:           body.supplier,
        supplierBookingRef: bookResult.bookingRef ?? null,
        pnr:                bookResult.pnr ?? null,
        gstNumber:          body.gstNumber ?? null,
        heldUntil:          null,
        contactEmail:       body.contactEmail,
        contactPhone:       body.contactPhone,
      }).returning();

      await db.insert(bookingPassengers).values(
        paxValues.map((p) => ({ ...p, bookingId: booking!.id })),
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[booking-save]", JSON.stringify({ sessionId: body.sessionId, bookingRef: bookResult.bookingRef, error: errMsg }));
      void logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "db:bookings:insert",
        level: "ERROR", requestId: body.sessionId,
        requestSummary: { bookingRef: bookResult.bookingRef, pnr: bookResult.pnr },
        errorCode: "DB_WRITE_FAILED", errorMessage: errMsg });
      return c.json({ bookingId: undefined, pnr: bookResult.pnr, status: "CONFIRMED",
        bookingRef: bookResult.bookingRef, warningCode: "BOOKING_SAVE_PENDING" }, 202);
    }

    return c.json({ bookingId: booking!.id, pnr: bookResult.pnr, status: "CONFIRMED" }, 201);
  }

  // RIYA (and future suppliers): hold seat before taking payment
  if (!adapter.hold) {
    throw new HTTPException(400, { message: `${body.supplier} does not support hold — use book directly` });
  }

  const holdResult = await adapter.hold({
    fareId:     body.fareId,
    sessionId:  body.sessionId,
    passengers: body.passengers,
  });

  if (!holdResult.success) {
    throw new HTTPException(422, { message: "Could not hold seat — fare may have expired" });
  }

  // Create booking record in HELD state
  const [booking] = await db.insert(bookings).values({
    tenantId,
    userId:           userId ?? null,
    agentId:          agentId ?? null,
    channel:          agentId ? "B2B_PORTAL" : "B2C_WEB",
    status:           "HELD",
    tripType:         "ONEWAY",
    cabinClass:       "ECONOMY",
    origin:           holdResult.fareSnapshot.origin,
    destination:      holdResult.fareSnapshot.destination,
    departureDate:    new Date(holdResult.fareSnapshot.departureTime),
    flightData:       holdResult.fareSnapshot as unknown as Record<string, unknown>,
    adultCount:       body.passengers.filter((p) => p.type === "ADULT").length,
    childCount:       body.passengers.filter((p) => p.type === "CHILD").length,
    infantCount:      body.passengers.filter((p) => p.type === "INFANT").length,
    baseFare:         String(holdResult.fareSnapshot.baseFare),
    taxes:            String(holdResult.fareSnapshot.taxes),
    totalAmount:      String(holdResult.fareSnapshot.totalFare),
    currency:         (tenant.defaultCurrency as "INR" | "AED" | "USD"),
    supplier:         body.supplier,
    supplierBookingRef: holdResult.holdId,
    gstNumber:        body.gstNumber ?? null,
    heldUntil:        new Date(holdResult.expiresAt),
    contactEmail:     body.contactEmail,
    contactPhone:     body.contactPhone,
  }).returning();

  // Insert passengers
  await db.insert(bookingPassengers).values(
    body.passengers.map((p) => ({
      bookingId:     booking.id,
      passengerType: p.type,
      firstName:     p.firstName,
      lastName:      p.lastName,
      dob:           p.dob ? new Date(p.dob) : null,
      gender:        p.gender ?? null,
      nationality:   p.nationality ?? null,
      passportNumber:  p.passportNumber  ?? null,
      passportExpiry:  p.passportExpiry  ? new Date(p.passportExpiry) : null,
      passportCountry: p.passportCountry ?? null,
    })),
  );

  // Queue payment initiation job
  await c.env.BOOKING_QUEUE.send({
    type:       "INITIATE_PAYMENT",
    bookingId:  booking.id,
    tenantId,
    method:     body.paymentMethod,
    agentId,
  });

  return c.json({ bookingId: booking.id, holdId: holdResult.holdId, expiresAt: holdResult.expiresAt }, 201);
});

// List bookings for the authenticated user/agent
bookingRoutes.get("/", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");
  const agentId  = c.get("agentId");

  const conditions = [eq(bookings.tenantId, tenantId)];
  if (agentId) conditions.push(eq(bookings.agentId, agentId));
  else if (userId) conditions.push(eq(bookings.userId, userId));

  const rows = await db
    .select({
      id:           bookings.id,
      status:       bookings.status,
      origin:       bookings.origin,
      destination:  bookings.destination,
      departureDate: bookings.departureDate,
      adultCount:   bookings.adultCount,
      childCount:   bookings.childCount,
      totalAmount:  bookings.totalAmount,
      currency:     bookings.currency,
      pnr:          bookings.pnr,
      supplier:     bookings.supplier,
      createdAt:    bookings.createdAt,
    })
    .from(bookings)
    .where(and(...conditions))
    .limit(50);

  return c.json({ bookings: rows });
});

// Get booking details
bookingRoutes.get("/:id", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [booking] = await db
    .select()
    .from(bookings)
    .where(
      and(eq(bookings.id, c.req.param("id")), eq(bookings.tenantId, tenantId)),
    )
    .limit(1);

  if (!booking) {
    throw new HTTPException(404, { message: "Booking not found" });
  }

  return c.json(booking);
});

// SSR list — available meal/baggage options for a confirmed TripJack booking
bookingRoutes.get("/:id/ssr", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");

  const [booking] = await db
    .select({ id: bookings.id, supplier: bookings.supplier, supplierBookingRef: bookings.supplierBookingRef })
    .from(bookings)
    .where(and(eq(bookings.id, c.req.param("id")), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });
  if (booking.supplier !== "TRIPJACK") throw new HTTPException(400, { message: "SSR only supported for TripJack bookings" });
  if (!booking.supplierBookingRef) throw new HTTPException(400, { message: "Booking has no supplier reference" });

  const tenant = c.get("tenant");
  const saved = await c.env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:integration:tripjack`, "json") as { apiKey?: string; baseUrl?: string } | null;
  const client = new TripjackClient({
    apiKey:     saved?.apiKey || c.env.TRIPJACK_API_KEY,
    baseUrl:    c.env.TRIPJACK_API_BASE_URL || saved?.baseUrl || "",
    omsBaseUrl: c.env.TRIPJACK_OMS_BASE_URL || "",
    proxyKey:   c.env.TRIPJACK_PROXY_KEY,
  });

  const raw = await client.ssrList(booking.supplierBookingRef);
  return c.json({ bookingId: booking.id, ssr: raw?.data ?? raw });
});

// Add SSR (meal / baggage) to a confirmed TripJack booking
bookingRoutes.post("/:id/ssr", zValidator("json", z.object({
  ssrDetails: z.array(z.object({
    type:         z.enum(["MEAL", "BAGGAGE"]),
    key:          z.string().min(1),
    paxIndex:     z.number().int().min(0),
    segmentIndex: z.number().int().min(0).optional(),
  })).min(1),
})), async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const body     = c.req.valid("json");

  const [booking] = await db
    .select({ id: bookings.id, supplier: bookings.supplier, supplierBookingRef: bookings.supplierBookingRef })
    .from(bookings)
    .where(and(eq(bookings.id, c.req.param("id")), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new HTTPException(404, { message: "Booking not found" });
  if (booking.supplier !== "TRIPJACK") throw new HTTPException(400, { message: "SSR only supported for TripJack bookings" });
  if (!booking.supplierBookingRef) throw new HTTPException(400, { message: "Booking has no supplier reference" });

  const saved = await c.env.TENANT_CACHE_KV.get(`admin_settings:${tenantId}:integration:tripjack`, "json") as { apiKey?: string; baseUrl?: string } | null;
  const client = new TripjackClient({
    apiKey:     saved?.apiKey || c.env.TRIPJACK_API_KEY,
    baseUrl:    c.env.TRIPJACK_API_BASE_URL || saved?.baseUrl || "",
    omsBaseUrl: c.env.TRIPJACK_OMS_BASE_URL || "",
    proxyKey:   c.env.TRIPJACK_PROXY_KEY,
  });

  const result = await client.addSsr(booking.supplierBookingRef, body.ssrDetails);
  return c.json({ success: true, result });
});

// PNR status check (no auth required — public tool)
bookingRoutes.get("/pnr/:pnr", async (c) => {
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const pnr      = c.req.param("pnr");

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, supplier: bookings.supplier })
    .from(bookings)
    .where(and(eq(bookings.pnr, pnr), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) {
    throw new HTTPException(404, { message: "PNR not found" });
  }

  const tenant  = c.get("tenant");
  const configs = tenant.supplierConfigs.map((sc) => ({
    name:        sc.supplier as "RIYA" | "TRIPJACK" | "GOOGLE_SERP",
    isEnabled:   sc.isEnabled,
    priority:    sc.priority,
    credentials: sc.credentials,
    timeoutMs:   sc.timeoutMs,
    maxRetries:  sc.maxRetries,
  }));

  const adapter = getBookableAdapter(booking.supplier as "RIYA" | "TRIPJACK", configs);
  const status  = await adapter.getPNRStatus?.(pnr);

  return c.json({ pnr, localStatus: booking.status, supplierStatus: status });
});
