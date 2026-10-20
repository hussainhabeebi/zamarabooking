// TripJack Hotel API v3.
//
//   POST /api/hotels/search             city (or hotel IDs) → hotels with cheapest option
//   POST /api/hotels/detail             all options for one hotel (+ static details)
//   POST /api/hotels/review             re-validate an option → TripJack bookingId + final price
//   POST /api/hotels/book               instant (paymentInfos) or hold booking, then poll status
//   GET  /api/hotels/bookings/:id       booking details (status polling)
//   Confirm-hold, cancel, booking list and the city sync are Admin-only
//   (/api/admin/hotels) so a booking ID alone can't cancel or charge a booking.
//   GET  /api/hotels/nationalities      nationality list (ISO2 + TripJack countryId)
//
// Every TripJack call is written to Admin → Supplier logs with the full error.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  HOTEL_TERMINAL_STATUSES, validHotelId, isHotelError, normalizeOption, parseHotelBookingDetails,
  type TripjackHotelV3Client,
} from "@poomas/suppliers";
import type { Env, Variables } from "../types.js";
import { logSupplierCall } from "../lib/supplier-logger.js";
import {
  SEARCH_TTL_MS, hotelExchanges, hotelRecorder, cheapest, hotelClient, hotelContent, nationalityId, searchHotels, tripjackEnvironment,
} from "../lib/hotels.js";

// ── Logging helpers ─────────────────────────────────────────────────────────

function errorCodeOf(err: any): string {
  if (err?.code) return String(err.code);
  if (typeof err?.statusCode === "number") return `HTTP_${err.statusCode}`;
  if (err?.name === "TimeoutError" || /timed out|timeout/i.test(String(err?.message))) return "TIMEOUT";
  return err?.name === "TypeError" ? "NETWORK_ERROR" : "HOTEL_API_ERROR";
}

function errorMessageOf(err: any): string {
  const base = err instanceof Error ? err.message : String(err);
  const hint = err?.code === "UNSUPPORTED_TRIPJACK_ROUTE" || err?.statusCode === 404
    ? " — route not found: redeploy the TripJack gateway (hotel v3 routes) and check TRIPJACK_HMS_UPSTREAM / TRIPJACK_HOTEL_BOOKER_UPSTREAM"
    : err?.statusCode === 401 || err?.statusCode === 403 || ["UNAUTHORIZED", "FORBIDDEN", "API_KEY_SUSPENDED", "6518", "6519", "6520"].includes(String(err?.code))
      ? " — API key not authorised for hotels, or the gateway IP is not whitelisted on the TripJack hotel hosts"
      : "";
  return `${base}${hint}`;
}

export async function logged<T>(
  c: any, endpoint: string, requestSummary: Record<string, unknown>,
  call: () => Promise<T>, summarize: (result: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const started = Date.now();
  // Same ID as the raw request / response files recorded for this call.
  const requestId = c.get("hotelRequestId") ?? crypto.randomUUID();
  const base = { tenantId: c.get("tenantId"), supplier: "TRIPJACK" as const, endpoint, requestId };
  try {
    const result = await call();
    c.executionCtx.waitUntil(logSupplierCall(c.get("db"), {
      ...base, level: "INFO", httpStatus: 200, durationMs: Date.now() - started,
      requestSummary: { ...requestSummary, ...summarize(result) },
    }));
    return result;
  } catch (err: any) {
    console.error(`[hotel] ${endpoint} failed`, err);
    await logSupplierCall(c.get("db"), {
      ...base, level: "ERROR",
      httpStatus: typeof err?.statusCode === "number" ? err.statusCode : undefined,
      errorCode: errorCodeOf(err),
      errorMessage: errorMessageOf(err),
      responseSnippet: typeof err?.responseSnippet === "string" ? err.responseSnippet : String(err?.stack ?? err).slice(0, 800),
      requestSummary: { ...requestSummary, tripjackEndpoint: err?.endpoint },
      durationMs: Date.now() - started,
    });
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { requestId });
  }
}

// TripJack hotel error codes that the customer can fix on the checkout form.
const GUEST_DETAIL_ERRORS: Record<string, { errorCode: string; message: string }> = {
  "1092": { errorCode: "PAN_REQUIRED", message: "This hotel needs a valid PAN (Indian tax ID, e.g. ABCDE1234F) for the lead guest. Please add it and confirm again." },
};

export function hotelError(c: any, err: any, fallback: string) {
  const code = errorCodeOf(err);
  const fixable = GUEST_DETAIL_ERRORS[code];
  if (fixable) return c.json({ error: fixable.message, errorCode: fixable.errorCode, supplierCode: code, requestId: err?.requestId }, 400);
  const status = isHotelError(err, "SESSION_EXPIRED") ? 410 : isHotelError(err, "SOLD_OUT") ? 409
    : ["CITY_INDEX_MISSING", "CITY_NOT_FOUND", "NATIONALITY_UNSUPPORTED"].includes(code) ? 404 : 502;
  const message = isHotelError(err, "SESSION_EXPIRED") ? "Your search has expired. Please search again."
    : isHotelError(err, "SOLD_OUT") ? "This room was just sold out. Please choose another option."
    : isHotelError(err, "PRICE_CHANGED") ? "The price for this room has changed. Please review the new price."
    : err?.message ?? fallback;
  return c.json({ error: message, errorCode: code, requestId: err?.requestId }, status);
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const roomSchema = z.object({
  adults:    z.number().int().min(1).max(9).default(1),
  children:  z.number().int().min(0).max(4).default(0),
  childAge:  z.array(z.number().int().min(0).max(17)).optional(),
  childAges: z.array(z.number().int().min(0).max(17)).optional(),   // older clients
}).transform((r) => ({
  adults: r.adults,
  ...(r.children ? { children: r.children, childAge: r.childAge ?? r.childAges ?? [] } : {}),
}));

const stayFields = {
  checkIn:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rooms:       z.array(roomSchema).min(1).max(9).default([{ adults: 1, children: 0 }]),
  nationality: z.string().min(2).max(6).default("IN"),
  currency:    z.string().length(3).toUpperCase().default("INR"),
};

const searchSchema = z.object({
  cityCode:    z.string().optional(),
  cityName:    z.string().optional(),
  countryCode: z.string().length(2).optional(),
  hids:        z.array(z.string().regex(/^\d+$/)).max(300).optional(),
  ...stayFields,
}).refine((b) => b.cityCode || b.cityName || b.hids?.length, { message: "cityCode, cityName or hids is required" });

// TripJack hotel IDs are numeric today; accept any plain ID so a format change
// doesn't block checkout (it is only ever sent back to TripJack).
const detailSchema = z.object({ correlationId: z.string().min(8), hid: z.string().refine(validHotelId, "Invalid TripJack hotel ID"), ...stayFields });

const reviewSchema = detailSchema.extend({
  optionId:   z.string().min(1),
  reviewHash: z.string().optional(),
});

const guestSchema = z.object({
  title:     z.string().min(1),
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  type:      z.enum(["ADULT", "CHILD"]).default("ADULT"),
  pan:       z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/i).optional(),
  passport:  z.string().min(5).optional(),
});

const bookSchema = z.object({
  bookingId:    z.string().min(5),
  amount:       z.number().positive(),
  rooms:        z.array(z.object({ guests: z.array(guestSchema).min(1) })).min(1),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(6),
  dialCode:     z.string().regex(/^\+?\d{1,4}$/).default("+91"),
  gstInfo:      z.object({ gstNumber: z.string().min(5), registeredName: z.string().min(2) }).optional(),
  hold:         z.boolean().default(false),
});

export const hotelRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
hotelRoutes.use("*", hotelExchanges);

// Request validation with a readable reason ("checkIn: Invalid") instead of the
// raw zod object, logged to Admin → Supplier logs so a rejected request shows up.
function validJson<T extends z.ZodTypeAny>(schema: T, endpoint: string) {
  return zValidator("json", schema, (result, c: any) => {
    if (result.success) return;
    const issues = result.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    c.executionCtx.waitUntil(logSupplierCall(c.get("db"), {
      tenantId: c.get("tenantId"), supplier: "TRIPJACK", endpoint: `hotel ${endpoint}`, level: "WARN",
      errorCode: "INVALID_REQUEST", errorMessage: `Hotel ${endpoint} request rejected before calling TripJack — ${issues.join("; ")}`,
      requestSummary: { issues, body: (result as any).data },
    }).catch(() => {}));
    return c.json({ error: `Some booking details are invalid (${issues[0]}). Please search again.`, code: "INVALID_REQUEST", issues }, 400);
  });
}

// ── Search ──────────────────────────────────────────────────────────────────

hotelRoutes.post("/search", validJson(searchSchema, "search"), async (c) => {
  const params = c.req.valid("json");
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    const result = await logged(c, "/hms/v3/hotel/listing", {
      city: params.cityName ?? params.cityCode, hids: params.hids?.length, checkIn: params.checkIn, checkOut: params.checkOut,
      rooms: params.rooms.length, guests: params.rooms.reduce((n, r) => n + r.adults + (r.children ?? 0), 0),
      nationality: params.nationality, currency: params.currency,
    }, () => searchHotels(c.env, client, params), (r) => ({
      correlationId: r.correlationId, candidates: r.totalCandidates, hotelCount: r.hotels.length,
    }));
    return c.json({
      searchId:      result.correlationId,
      correlationId: result.correlationId,
      expiresAt:     new Date(Date.now() + SEARCH_TTL_MS).toISOString(),
      city:          result.city,
      hotels:        result.hotels,
      totalCandidates: result.totalCandidates,
      supplier:      "TRIPJACK",
    });
  } catch (err) {
    return hotelError(c, err, "Hotel search failed");
  }
});

// ── Detail (all options for one hotel) ──────────────────────────────────────

async function pricingFor(c: any, client: TripjackHotelV3Client, p: z.infer<typeof detailSchema>) {
  const nationality = await nationalityId(c.env, client, p.nationality);
  return logged(c, "/hms/v3/hotel/pricing", { correlationId: p.correlationId, hid: p.hid, checkIn: p.checkIn, checkOut: p.checkOut },
    () => client.pricing({ correlationId: p.correlationId, hid: p.hid, checkIn: p.checkIn, checkOut: p.checkOut,
      rooms: p.rooms, currency: p.currency, nationality, timeoutMs: 13000 }),
    (r) => ({ optionCount: r.options?.length ?? 0 }));
}

hotelRoutes.post("/detail", validJson(detailSchema, "detail"), async (c) => {
  const p = c.req.valid("json");
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    const [pricing, content] = await Promise.all([pricingFor(c, client, p), hotelContent(c.env, client, [p.hid])]);
    const options = (pricing.options ?? []).map(normalizeOption).sort((a, b) => a.pricing.totalPrice - b.pricing.totalPrice);
    return c.json({
      correlationId: p.correlationId,
      hid:           p.hid,
      hotelName:     pricing.hotelName ?? content[p.hid]?.name ?? "",
      hotel:         content[p.hid] ?? null,
      reviewHash:    pricing.reviewHash,
      options,
    });
  } catch (err) {
    return hotelError(c, err, "Could not load this hotel's rooms");
  }
});

// ── Review (re-validate the chosen option; returns TripJack bookingId) ───────

hotelRoutes.post("/review", validJson(reviewSchema, "review"), async (c) => {
  const p = c.req.valid("json");
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    let reviewHash = p.reviewHash;
    let optionId = p.optionId;
    let listedPrice: number | undefined;
    if (!reviewHash) {
      // Coming straight from search: fetch the hotel's options for the reviewHash.
      const pricing = await pricingFor(c, client, p);
      reviewHash = pricing.reviewHash;
      const options = (pricing.options ?? []).map(normalizeOption);
      const same = options.find((o) => o.optionId === optionId);
      const pick = same ?? cheapest(options);
      if (!pick) return c.json({ error: "No rooms are available at this hotel for these dates.", errorCode: "NO_OPTIONS" }, 409);
      optionId = pick.optionId;
      listedPrice = pick.pricing.totalPrice;
    }
    const review = await logged(c, "/hms/v3/hotel/review", { correlationId: p.correlationId, hid: p.hid, optionId },
      () => client.review({ correlationId: p.correlationId, optionId, reviewHash: reviewHash!, hid: p.hid }),
      (r) => ({ bookingId: r.bookingId, totalPrice: r.option?.pricing?.totalPrice }));
    const option = normalizeOption(review.option);
    return c.json({
      bookingId:     review.bookingId,
      hid:           p.hid,
      hotelName:     review.hotelName,
      option,
      optionChanged: optionId !== p.optionId,
      priceChanged:  listedPrice !== undefined && Math.abs(listedPrice - option.pricing.totalPrice) > 0.01,
      onholdAllowed: String(review.onholdAllowed) === "true",
    });
  } catch (err) {
    return hotelError(c, err, "Could not confirm this room");
  }
});

// ── Book ────────────────────────────────────────────────────────────────────

export async function pollDetails(c: any, client: TripjackHotelV3Client, bookingId: string, maxMs: number) {
  const started = Date.now();
  let last: ReturnType<typeof parseHotelBookingDetails> | null = null;
  while (Date.now() - started < maxMs) {
    try {
      last = parseHotelBookingDetails(await client.bookingDetails(bookingId));
      if (HOTEL_TERMINAL_STATUSES.includes(last.status)) return last;
    } catch (err) {
      console.warn(`[hotel] booking-details ${bookingId} failed`, err);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
}

hotelRoutes.post("/book", validJson(bookSchema, "book"), async (c) => {
  const p = c.req.valid("json");
  const tenantId = c.get("tenantId");
  const client = await hotelClient(c.env, tenantId, hotelRecorder(c));
  // Production has no customer hotel payment step yet: never charge the TripJack
  // wallet from the website there — place a hold that Admin confirms after payment.
  const production = (await tripjackEnvironment(c.env, tenantId)) === "PRODUCTION";
  const hold = p.hold || production;
  const phone = p.contactPhone.replace(/\D/g, "");
  try {
    const res = await logged(c, "/oms/v3/hotel/book", {
      bookingId: p.bookingId, mode: hold ? "HOLD" : "INSTANT", amount: p.amount,
      rooms: p.rooms.length, guests: p.rooms.reduce((n, r) => n + r.guests.length, 0), contactEmail: p.contactEmail,
    }, () => client.book({
      bookingId: p.bookingId,
      roomTravellerInfo: p.rooms.map((r) => ({
        travellerInfo: r.guests.map((g) => ({
          ti: g.title, pt: g.type, fN: g.firstName.trim(), lN: g.lastName.trim(),
          ...(g.pan ? { pan: g.pan.toUpperCase() } : {}), ...(g.passport ? { pNum: g.passport } : {}),
        })),
      })),
      deliveryInfo: { emails: [p.contactEmail], contacts: [phone.slice(-10)], code: [p.dialCode.startsWith("+") ? p.dialCode : `+${p.dialCode}`] },
      ...(p.gstInfo ? { gstInfo: p.gstInfo } : {}),
      ...(hold ? {} : { paymentInfos: [{ amount: p.amount }] }),
    }));

    const bookingId = res.bookingId || p.bookingId;
    // TripJack confirms asynchronously (up to 180 s): poll briefly here; the
    // client keeps polling GET /bookings/:id after that.
    const details = await logged(c, "/oms/v3/hotel/booking-details", { bookingId, reason: "post-book poll" },
      () => pollDetails(c, client, bookingId, 25_000), (d) => ({ status: d?.status }));
    return c.json({
      bookingId,
      mode:    hold ? "HOLD" : "INSTANT",
      status:  details?.status ?? "IN_PROGRESS",
      pending: !details || !HOTEL_TERMINAL_STATUSES.includes(details.status),
      details,
      ...(production && !p.hold ? { note: "Reserved on hold — our team confirms it once payment is received." } : {}),
    }, 201);
  } catch (err) {
    return hotelError(c, err, "Hotel booking failed");
  }
});

hotelRoutes.get("/bookings/:bookingId", async (c) => {
  const { bookingId } = c.req.param();
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    const raw = await logged(c, "/oms/v3/hotel/booking-details", { bookingId }, () => client.bookingDetails(bookingId),
      (r) => ({ status: r?.order?.status }));
    const details = parseHotelBookingDetails(raw);
    return c.json({ ...details, pending: !HOTEL_TERMINAL_STATUSES.includes(details.status) });
  } catch (err) {
    return hotelError(c, err, "Could not load the hotel booking");
  }
});

hotelRoutes.get("/nationalities", async (c) => {
  const client = await hotelClient(c.env, c.get("tenantId"), hotelRecorder(c));
  try {
    const res = await logged(c, "/hms/v3/nationality-info", {}, () => client.nationalities(),
      (r) => ({ count: r.nationalityInfos?.length ?? 0 }));
    return c.json({ nationalities: (res.nationalityInfos ?? []).map((n) => ({ code: n.code, countryId: n.countryId, name: n.name, dialCode: n.dialCode })) });
  } catch (err) {
    return hotelError(c, err, "Could not load nationalities");
  }
});
