import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { bookings, bookingPassengers, webhookConfigs } from "@poomas/db/schema";
import type { Env, Variables } from "../types.js";
import { requirePartnerScope } from "../middleware/partner-api-key.js";
import { searchRoutes } from "./search.js";
import { signToken } from "./checkout.js";

const OFFER_TTL_SECONDS = 15 * 60;
const CHECKOUT_TTL_SECONDS = 20 * 60;
const REFERENCE_PATTERN = /^[A-Za-z0-9._:-]+$/;

type PartnerContext = Context<{ Bindings: Env; Variables: Variables }>;

type InternalSearchResponse = {
  fares?: Array<Record<string, unknown>>;
  usedSuppliers?: string[];
  isIndicative?: boolean;
  disclaimer?: string;
  supplierErrors?: Record<string, string>;
  fromCache?: boolean;
};

type StoredPartnerOffer = {
  version: 1;
  partnerApiKeyId: string;
  searchId: string;
  searchParams: Record<string, unknown>;
  fare: Record<string, unknown>;
  expiresAt: string;
};

const partnerPassengerSchema = z.object({
  type: z.enum(["ADULT", "CHILD", "INFANT"]),
  title: z.string().max(12).optional(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  dob: z.string().date().optional(),
  gender: z.enum(["M", "F"]).optional(),
  nationality: z.string().length(2).optional(),
  passportNumber: z.string().max(30).optional(),
  passportExpiry: z.string().date().optional(),
  passportCountry: z.string().length(2).optional(),
});

const customerSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(8).max(24),
});

const reserveSchema = z.object({
  externalReference: z.string().min(1).max(100).regex(REFERENCE_PATTERN).optional(),
  customer: customerSchema.optional(),
});

const checkoutSchema = z.object({
  offerId: z.string().uuid().optional(),
  reservationId: z.string().uuid().optional(),
  externalReference: z.string().min(1).max(100).regex(REFERENCE_PATTERN).optional(),
  customer: customerSchema,
  passengers: z.array(partnerPassengerSchema).min(1).max(14),
  returnUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
}).refine((value) => Boolean(value.offerId) !== Boolean(value.reservationId), {
  message: "Provide exactly one of offerId or reservationId",
});

const webhookTestSchema = z.object({
  webhookConfigId: z.string().optional(),
});

function offerKey(tenantId: string, offerId: string): string {
  return `partner_offer:${tenantId}:${offerId}`;
}

function reservationKey(tenantId: string, reservationId: string): string {
  return `partner_reservation:${tenantId}:${reservationId}`;
}

function referenceKey(tenantId: string, apiKeyId: string, reference: string): string {
  return `partner_booking_ref:${tenantId}:${apiKeyId}:${reference}`;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadPartnerOffer(c: PartnerContext, offerId: string): Promise<StoredPartnerOffer> {
  const tenantId = c.get("tenantId");
  const stored = await c.env.SESSIONS_KV.get(
    offerKey(tenantId, offerId),
    "json",
  ) as StoredPartnerOffer | null;

  if (!stored) throw new Error("PARTNER_OFFER_EXPIRED");
  if (stored.partnerApiKeyId !== c.get("partnerApiKeyId")) {
    throw new Error("PARTNER_OFFER_NOT_OWNED");
  }
  if (new Date(stored.expiresAt).getTime() <= Date.now()) {
    throw new Error("PARTNER_OFFER_EXPIRED");
  }
  return stored;
}

async function createReservation(
  c: PartnerContext,
  offerId: string,
  externalReference?: string,
  customer?: z.infer<typeof customerSchema>,
) {
  const tenantId = c.get("tenantId");
  const apiKeyId = c.get("partnerApiKeyId");
  if (!apiKeyId) throw new Error("PARTNER_AUTHENTICATION_REQUIRED");

  if (externalReference) {
    const existingId = await c.env.SESSIONS_KV.get(
      referenceKey(tenantId, apiKeyId, externalReference),
    );
    if (existingId) {
      const [existing] = await c.get("db")
        .select({
          id: bookings.id,
          status: bookings.status,
          heldUntil: bookings.heldUntil,
          totalAmount: bookings.totalAmount,
          currency: bookings.currency,
        })
        .from(bookings)
        .where(and(eq(bookings.id, existingId), eq(bookings.tenantId, tenantId)))
        .limit(1);
      if (existing) return existing;
    }
  }

  const stored = await loadPartnerOffer(c, offerId);
  const fare = stored.fare;
  if (fare.isBookable !== true || fare.supplier === "GOOGLE_SERP") {
    throw new Error("PARTNER_OFFER_NOT_BOOKABLE");
  }

  const supplier = String(fare.supplier);
  if (!["RIYA", "TRIPJACK", "DUFFEL"].includes(supplier)) {
    throw new Error("PARTNER_OFFER_NOT_BOOKABLE");
  }

  const currency = String(fare.currency ?? "INR");
  if (!["INR", "AED", "USD"].includes(currency)) {
    throw new Error("PARTNER_OFFER_CURRENCY_UNSUPPORTED");
  }

  const tripType = String(stored.searchParams.tripType ?? "ONEWAY");
  const cabinClass = String(stored.searchParams.cabinClass ?? fare.cabinClass ?? "ECONOMY");
  const departureDate = new Date(String(fare.departureTime));
  if (Number.isNaN(departureDate.getTime())) throw new Error("PARTNER_OFFER_INVALID");

  const heldUntil = new Date(Math.min(
    new Date(stored.expiresAt).getTime(),
    Date.now() + OFFER_TTL_SECONDS * 1000,
  ));

  const [booking] = await c.get("db").insert(bookings).values({
    tenantId,
    channel: "B2C_WEB",
    status: "HELD",
    tripType: (["ONEWAY", "ROUNDTRIP", "MULTICITY"].includes(tripType) ? tripType : "ONEWAY") as "ONEWAY" | "ROUNDTRIP" | "MULTICITY",
    cabinClass: (["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"].includes(cabinClass) ? cabinClass : "ECONOMY") as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST",
    origin: String(fare.origin ?? ""),
    destination: String(fare.destination ?? ""),
    departureDate,
    returnDate: stored.searchParams.returnDate
      ? new Date(String(stored.searchParams.returnDate))
      : null,
    flightData: fare,
    adultCount: asNumber(stored.searchParams.adults) || 1,
    childCount: asNumber(stored.searchParams.children),
    infantCount: asNumber(stored.searchParams.infants),
    baseFare: String(asNumber(fare.baseFare)),
    taxes: String(asNumber(fare.taxes)),
    totalAmount: String(asNumber(fare.displayPrice ?? fare.totalFare)),
    currency: currency as "INR" | "AED" | "USD",
    supplier: supplier as "RIYA" | "TRIPJACK" | "DUFFEL",
    supplierSessionId: String(fare.id ?? ""),
    heldUntil,
    contactEmail: customer?.email ?? null,
    contactPhone: customer?.phone ?? null,
  }).returning({
    id: bookings.id,
    status: bookings.status,
    heldUntil: bookings.heldUntil,
    totalAmount: bookings.totalAmount,
    currency: bookings.currency,
  });

  await c.env.SESSIONS_KV.put(
    reservationKey(tenantId, booking.id),
    JSON.stringify({
      partnerApiKeyId: apiKeyId,
      offerId,
      externalReference: externalReference ?? null,
    }),
    { expirationTtl: CHECKOUT_TTL_SECONDS + 300 },
  );

  if (externalReference) {
    await c.env.SESSIONS_KV.put(
      referenceKey(tenantId, apiKeyId, externalReference),
      booking.id,
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
  }

  return booking;
}

async function loadOwnedReservation(c: PartnerContext, reservationId: string) {
  const tenantId = c.get("tenantId");
  const ownership = await c.env.SESSIONS_KV.get(
    reservationKey(tenantId, reservationId),
    "json",
  ) as { partnerApiKeyId?: string } | null;

  if (!ownership || ownership.partnerApiKeyId !== c.get("partnerApiKeyId")) {
    throw new Error("PARTNER_RESERVATION_NOT_FOUND");
  }

  const [booking] = await c.get("db")
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, reservationId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) throw new Error("PARTNER_RESERVATION_NOT_FOUND");
  if (booking.heldUntil && booking.heldUntil.getTime() <= Date.now()) {
    throw new Error("PARTNER_RESERVATION_EXPIRED");
  }
  return booking;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function partnerError(c: PartnerContext, error: unknown) {
  const code = error instanceof Error ? error.message : "PARTNER_REQUEST_FAILED";
  const status = code.includes("EXPIRED") ? 410
    : code.includes("NOT_FOUND") ? 404
      : code.includes("NOT_OWNED") ? 403
        : code.includes("NOT_BOOKABLE") || code.includes("UNSUPPORTED") || code.includes("INVALID") ? 422
          : 500;
  return c.json({ error: code }, status as 403 | 404 | 410 | 422 | 500);
}

const shapePartnerSearchResponse: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  let searchParams: Record<string, unknown> = {};
  try {
    searchParams = await c.req.raw.clone().json() as Record<string, unknown>;
  } catch {}

  await next();

  if (!c.res.ok || !c.res.headers.get("content-type")?.includes("application/json")) {
    return;
  }

  const data = await c.res.clone().json() as InternalSearchResponse;
  if (!Array.isArray(data.fares)) return;

  const tenantId = c.get("tenantId");
  const partnerApiKeyId = c.get("partnerApiKeyId");
  if (!partnerApiKeyId) return;

  const searchId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + OFFER_TTL_SECONDS * 1000).toISOString();

  const offers = await Promise.all(data.fares.map(async (fare) => {
    const opaqueOfferId = crypto.randomUUID();
    await c.env.SESSIONS_KV.put(
      offerKey(tenantId, opaqueOfferId),
      JSON.stringify({
        version: 1,
        partnerApiKeyId,
        searchId,
        searchParams,
        fare,
        expiresAt,
      } satisfies StoredPartnerOffer),
      { expirationTtl: OFFER_TTL_SECONDS },
    );

    const { raw: _supplierPayload, id: _supplierOfferId, ...publicOffer } = fare;
    return { offerId: opaqueOfferId, ...publicOffer };
  }));

  const response = {
    searchId,
    expiresAt,
    offers,
    usedSuppliers: data.usedSuppliers ?? [],
    isIndicative: data.isIndicative ?? false,
    ...(data.disclaimer ? { disclaimer: data.disclaimer } : {}),
    ...(data.supplierErrors ? { supplierErrors: data.supplierErrors } : {}),
    ...(data.fromCache ? { fromCache: true } : {}),
  };

  const headers = new Headers(c.res.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  c.res = new Response(JSON.stringify(response), {
    status: c.res.status,
    headers,
  });
};

export const partnerRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

partnerRoutes.use("/search", requirePartnerScope("search"));
partnerRoutes.use("/search/*", requirePartnerScope("search"));
partnerRoutes.use("/search", shapePartnerSearchResponse);
partnerRoutes.use("/search/*", shapePartnerSearchResponse);
partnerRoutes.route("/search", searchRoutes);

partnerRoutes.use("/offers/*", requirePartnerScope("booking"));
partnerRoutes.post("/offers/:offerId/reserve", zValidator("json", reserveSchema), async (c) => {
  try {
    const { externalReference, customer } = c.req.valid("json");
    const booking = await createReservation(c, c.req.param("offerId"), externalReference, customer);
    return c.json({
      reservationId: booking.id,
      status: booking.status,
      holdType: "LOGICAL",
      heldUntil: booking.heldUntil,
      totalAmount: booking.totalAmount,
      currency: booking.currency,
    }, 201);
  } catch (error) {
    return partnerError(c, error);
  }
});

partnerRoutes.use("/checkout-sessions", requirePartnerScope("booking"));
partnerRoutes.post("/checkout-sessions", zValidator("json", checkoutSchema), async (c) => {
  try {
    const body = c.req.valid("json");
    const tenantId = c.get("tenantId");
    const apiKeyId = c.get("partnerApiKeyId")!;

    const reservation = body.offerId
      ? await createReservation(
          c,
          body.offerId,
          body.externalReference ?? `partner_${crypto.randomUUID()}`,
          body.customer,
        )
      : await loadOwnedReservation(c, body.reservationId!);

    const [existingPassenger] = await c.get("db")
      .select({ id: bookingPassengers.id })
      .from(bookingPassengers)
      .where(eq(bookingPassengers.bookingId, reservation.id))
      .limit(1);

    if (!existingPassenger) {
      await c.get("db").insert(bookingPassengers).values(body.passengers.map((passenger) => ({
        bookingId: reservation.id,
        passengerType: passenger.type,
        title: passenger.title ?? null,
        firstName: passenger.firstName,
        lastName: passenger.lastName,
        dob: passenger.dob ? new Date(passenger.dob) : null,
        gender: passenger.gender ?? null,
        nationality: passenger.nationality?.toUpperCase() ?? null,
        passportNumber: passenger.passportNumber ?? null,
        passportExpiry: passenger.passportExpiry ? new Date(passenger.passportExpiry) : null,
        passportCountry: passenger.passportCountry?.toUpperCase() ?? null,
      })));
    }

    await c.get("db").update(bookings).set({
      contactEmail: body.customer.email,
      contactPhone: body.customer.phone,
      updatedAt: new Date(),
    }).where(and(
      eq(bookings.id, reservation.id),
      eq(bookings.tenantId, tenantId),
    ));

    const now = Math.floor(Date.now() / 1000);
    const exp = now + CHECKOUT_TTL_SECONDS;
    const token = await signToken({
      sub: reservation.id,
      tenantId,
      partnerApiKeyId: apiKeyId,
      iat: now,
      exp,
    }, c.env.JWT_SECRET);

    await c.env.SESSIONS_KV.put(
      `checkout:${tenantId}:${reservation.id}`,
      JSON.stringify({
        token,
        used: false,
        partnerApiKeyId: apiKeyId,
        returnUrl: body.returnUrl ?? null,
        cancelUrl: body.cancelUrl ?? null,
      }),
      { expirationTtl: CHECKOUT_TTL_SECONDS + 60 },
    );

    return c.json({
      checkoutSessionId: crypto.randomUUID(),
      reservationId: reservation.id,
      checkoutUrl: `https://flypoomas.com/checkout/${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    }, 201);
  } catch (error) {
    return partnerError(c, error);
  }
});

partnerRoutes.use("/bookings/*", requirePartnerScope("booking"));
partnerRoutes.get("/bookings/:reference", async (c) => {
  const tenantId = c.get("tenantId");
  const apiKeyId = c.get("partnerApiKeyId")!;
  const reference = c.req.param("reference");
  if (!REFERENCE_PATTERN.test(reference)) {
    return c.json({ error: "PARTNER_REFERENCE_INVALID" }, 400);
  }

  const bookingId = await c.env.SESSIONS_KV.get(
    referenceKey(tenantId, apiKeyId, reference),
  );
  if (!bookingId) return c.json({ error: "PARTNER_BOOKING_NOT_FOUND" }, 404);

  const [booking] = await c.get("db")
    .select({
      id: bookings.id,
      status: bookings.status,
      pnr: bookings.pnr,
      ticketNumbers: bookings.ticketNumbers,
      origin: bookings.origin,
      destination: bookings.destination,
      departureDate: bookings.departureDate,
      returnDate: bookings.returnDate,
      supplier: bookings.supplier,
      totalAmount: bookings.totalAmount,
      currency: bookings.currency,
      heldUntil: bookings.heldUntil,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) return c.json({ error: "PARTNER_BOOKING_NOT_FOUND" }, 404);
  return c.json({ externalReference: reference, booking });
});

partnerRoutes.use("/webhooks/*", requirePartnerScope("webhook"));
partnerRoutes.post("/webhooks/test", zValidator("json", webhookTestSchema), async (c) => {
  const { webhookConfigId } = c.req.valid("json");
  const tenantId = c.get("tenantId");

  const configs = await c.get("db")
    .select({
      id: webhookConfigs.id,
      name: webhookConfigs.name,
      url: webhookConfigs.url,
      secret: webhookConfigs.secret,
      events: webhookConfigs.events,
    })
    .from(webhookConfigs)
    .where(and(
      eq(webhookConfigs.tenantId, tenantId),
      eq(webhookConfigs.isActive, true),
    ));

  const config = webhookConfigId
    ? configs.find((item) => item.id === webhookConfigId)
    : configs.find((item) => item.events.includes("*") || item.events.includes("webhook.test"));

  if (!config) return c.json({ error: "PARTNER_WEBHOOK_NOT_CONFIGURED" }, 404);
  if (!config.secret) return c.json({ error: "PARTNER_WEBHOOK_SECRET_REQUIRED" }, 503);

  let target: URL;
  try {
    target = new URL(config.url);
  } catch {
    return c.json({ error: "PARTNER_WEBHOOK_URL_INVALID" }, 422);
  }
  if (target.protocol !== "https:") {
    return c.json({ error: "PARTNER_WEBHOOK_HTTPS_REQUIRED" }, 422);
  }

  const payload = JSON.stringify({
    eventId: crypto.randomUUID(),
    type: "webhook.test",
    createdAt: new Date().toISOString(),
    data: { tenantId, partner: c.get("partnerName") ?? "partner" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacHex(config.secret, `${timestamp}.${payload}`);

  try {
    const response = await fetch(target.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-poomas-timestamp": timestamp,
        "x-poomas-signature": `sha256=${signature}`,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });

    return c.json({
      delivered: response.ok,
      webhookConfigId: config.id,
      webhookName: config.name,
      responseStatus: response.status,
    }, response.ok ? 200 : 502);
  } catch {
    return c.json({
      delivered: false,
      webhookConfigId: config.id,
      webhookName: config.name,
      error: "PARTNER_WEBHOOK_DELIVERY_FAILED",
    }, 502);
  }
});
