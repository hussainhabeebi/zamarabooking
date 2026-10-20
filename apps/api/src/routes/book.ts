// POST /api/book — public B2C direct booking (no auth required)
// TripJack and Riya support direct booking without an explicit hold step.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { getBookableAdapter, parseTripjackReview, parseTripjackSeatMap, reviewTotalFare, seatTotal, ssrTotal, TripjackClient, type ReviewSummary, type SegmentSeatMap } from "@poomas/suppliers";
import { normalizeBookingResponse } from "../lib/booking-response.js";
import { resolveFlightSuppliers } from "./search.js";
import { logSupplierCall } from "../lib/supplier-logger.js";
import { signToken, verifyToken } from "./checkout.js";
import { optionalCustomerId } from "../lib/optional-customer.js";
import { optionalAgent } from "../lib/agent-markup.js";
import { resolveAgentNumber } from "../lib/agent-number.js";
import { AgentBlocked, agentPricing, assertAgentCanBook } from "../lib/agent-program.js";
import { bookings, bookingPassengers } from "@poomas/db/schema";
import { and, eq } from "drizzle-orm";
import type { Env, Variables } from "../types.js";
import { collectExchanges, persistExchanges, persistInBackground, type ExchangeCollector } from "../lib/api-exchanges.js";
import { passengerNameProblem } from "../lib/passenger-names.js";
import { fallbackHoldDeadline, findHoldDeadline, holdLabel } from "../lib/fare-hold.js";
import { parseBookingDetails } from "../lib/trips.js";
import { emailShell, escapeHtml, money, notifyCustomer, WEB_URL } from "../lib/customer-notify.js";

const ssrPick = z.object({ key: z.string().min(1), code: z.string().min(1) });

const passengerSchema = z.object({
  type:            z.enum(["ADULT", "CHILD", "INFANT"]),
  firstName:       z.string().min(1),
  lastName:        z.string().min(1),
  dob:             z.string().optional(),
  gender:          z.enum(["M", "F"]).optional(),
  nationality:     z.string().max(2).optional(),
  passportNumber:  z.string().optional(),
  passportExpiry:  z.string().optional(),
  passportCountry: z.string().max(2).optional(),
  passportIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  panNumber:       z.string().regex(/^[A-Za-z]{5}\d{4}[A-Za-z]$/, "PAN must look like ABCDE1234F").optional(),
  documentId:      z.string().regex(/^[A-Za-z0-9]{3,30}$/, "Document ID must be letters and digits only").optional(),
  ssr: z.object({
    baggage: z.array(ssrPick).max(6).optional(),
    meal:    z.array(ssrPick).max(6).optional(),
    extra:   z.array(ssrPick).max(6).optional(),
    seat:    z.array(ssrPick).max(6).optional(),
  }).optional(),
}).superRefine((p, ctx) => {
  for (const [field, label] of [["firstName", "First name"], ["lastName", "Last name"]] as const) {
    const problem = passengerNameProblem(p[field], label);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: problem });
  }
});

const directBookSchema = z.object({
  fareId:        z.string().min(1),
  supplier:      z.enum(["TRIPJACK", "RIYA"]),
  // Up to 9 seats (adults + children); lap infants come on top, one per adult.
  passengers:    z.array(passengerSchema).min(1).max(18),
  contactEmail:  z.string().email(),
  contactPhone:  z.string().min(7),
  // Fare data for the DB record (sourced from the search result displayed to the user)
  origin:        z.string().length(3),
  destination:   z.string().length(3),
  departureDate: z.string().date(),
  totalFare:     z.number().positive(),
  currency:      z.enum(["INR", "AED", "USD"]).default("INR"),
  searchId:      z.string().uuid().optional(),   // links the booking to its search's TripJack logs
  // Leadvyne Live Agency hand-off: the agency's FlyPoomas agent number (analytics only).
  leadAgentNumber: z.string().max(20).optional(),
  // Review-first flow (round trip / multi-city / SSR / GST): the bookingId from
  // POST /api/book/review. The fareId is then only informational.
  reviewBookingId: z.string().min(5).optional(),
  tripType:      z.enum(["ONEWAY", "ROUNDTRIP", "MULTICITY"]).default("ONEWAY"),
  gstInfo: z.object({
    gstNumber:      z.string().regex(/^\d{2}[A-Za-z0-9]{13}$/, "GSTIN must be 15 characters"),
    registeredName: z.string().min(2).max(35),
    email:          z.string().email().optional(),
    mobile:         z.string().min(7).max(15).optional(),
    address:        z.string().max(70).optional(),
  }).optional(),
  emergencyContact: z.object({
    name:  z.string().min(2),
    phone: z.string().min(7),
    email: z.string().email().optional(),
  }).optional(),
  // Hold now, pay later (TripJack, when the review allows it): seats are held
  // without payment and the customer pays before the airline's time limit.
  holdOnly:      z.boolean().optional(),
}).superRefine((b, ctx) => {
  const n = (t: string) => b.passengers.filter((p) => p.type === t).length;
  if (n("ADULT") < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["passengers"], message: "At least one adult is required" });
  if (n("ADULT") + n("CHILD") > 9) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["passengers"], message: "Adults and children cannot exceed 9" });
  if (n("INFANT") > n("ADULT")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["passengers"], message: "Each infant must travel with an adult" });
});

// Review sessions kept server-side so /api/book can trust TF, conditions and SSR prices.
const REVIEW_KEY = (tenantId: string, bookingId: string) => `flight_review:${tenantId}:${bookingId}`;
interface StoredReview { priceIds: string[]; summary: ReviewSummary; createdAt: string }

// Checks a booking against TripJack's review conditions; returns the first problem.
function conditionProblem(review: ReviewSummary, body: z.infer<typeof directBookSchema>): string | null {
  const c = review.conditions;
  if (c.gstMandatory && !body.gstInfo) return "GST details are mandatory for this fare.";
  if (c.emergencyContactRequired && !body.emergencyContact) return "An emergency contact is mandatory for this fare.";
  for (const [i, p] of body.passengers.entries()) {
    const who = `Traveller ${i + 1}`;
    if (c.dobRequired[p.type] && !p.dob) return `${who}: date of birth is required.`;
    if (c.passportMandatory && !p.passportNumber) return `${who}: passport number is required.`;
    if (c.passportMandatory && !p.nationality) return `${who}: passport nationality is required.`;
    if ((c.passportMandatory || c.passportExpiryRequired) && p.passportNumber && !p.passportExpiry) return `${who}: passport expiry date is required.`;
    if (c.documentIdMandatory && p.type !== "INFANT" && !p.documentId) return `${who}: student / senior citizen ID is required.`;
    if (p.type === "INFANT" && (p.ssr?.baggage?.length || p.ssr?.meal?.length || p.ssr?.extra?.length)) return `${who}: infants cannot add meals or baggage.`;
  }
  return null;
}

export const bookDirectRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Capture every raw TripJack exchange made while booking and store it against the
// booking (or the request, if no booking was created) for certification logs.
bookDirectRoutes.use("/", async (c, next) => {
  const collector = collectExchanges();
  (c as any).set("exchanges", collector);
  await next();
  persistInBackground(c, persistExchanges(c.env, c.get("db"), c.get("tenantId"), collector.exchanges, {
    bookingId: (c as any).get("exchangeBookingId") ?? null,
    searchId: (c as any).get("exchangeSearchId") ?? null,
    requestId: (c as any).get("exchangeRequestId") ?? null,
  }));
});

// POST /api/book/review — TripJack Review for 1–6 priceIds (one-way / COMBO: 1,
// domestic return: 2, domestic multi-city: one per leg). Returns the session
// bookingId, TF, conditions (GST / passport / DOB / PAN / document ID /
// emergency contact / hold / seat), per-segment SSR options and fare alerts.
bookDirectRoutes.post("/review", zValidator("json", z.object({
  priceIds: z.array(z.string().min(1)).min(1).max(6),
  searchId: z.string().uuid().optional(),
})), async (c) => {
  const { priceIds, searchId } = c.req.valid("json");
  const db = c.get("db");
  const tenantId = c.get("tenantId");
  const requestId = crypto.randomUUID();
  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(c.env, c.get("tenant"), tenantId);
  const config = supplierConfigs.find((s) => s.name === "TRIPJACK");
  if (!config?.isEnabled) return c.json({ errorCode: "BOOKING_UNAVAILABLE", requestId }, 503);

  const collector = collectExchanges();
  const client = new TripjackClient({ recorder: collector.recorder, ...(platformCredentials.TRIPJACK ?? {}), ...(config.credentials ?? {}) });
  const started = Date.now();
  try {
    const { result } = await client.review(priceIds);
    const summary = parseTripjackReview(result as Record<string, unknown>);
    const ttl = Math.max(60, Math.min(summary.conditions.sessionSeconds ?? 900, 1800));
    await c.env.SESSIONS_KV.put(REVIEW_KEY(tenantId, summary.bookingId),
      JSON.stringify({ priceIds, summary, createdAt: new Date().toISOString() } satisfies StoredReview), { expirationTtl: ttl });
    persistInBackground(c, persistExchanges(c.env, db, tenantId, collector.exchanges, { searchId: searchId ?? null, requestId }));
    runInBackground(c, logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/fms/v1/review",
      httpStatus: 200, level: summary.totalFare ? "INFO" : "WARN", requestId,
      requestSummary: { priceIds, bookingId: summary.bookingId, tf: summary.totalFare, conditions: summary.conditions,
        fareIdentifiers: summary.fareIdentifiers, fareAlert: summary.fareAlert, ssrSegments: summary.segments.filter((s) => s.ssr.baggage.length || s.ssr.meal.length).length },
      durationMs: Date.now() - started }));
    // Customer price incl. markup, for booking pages opened without a price in
    // the link (e.g. WhatsApp / Leadvyne hand-offs).
    const first = summary.segments[0], last = summary.segments[summary.segments.length - 1];
    const displayTotal = summary.totalFare
      ? await customerPrice(db, tenantId, summary.totalFare, { origin: first?.origin ?? "", destination: last?.destination ?? "", supplier: "TRIPJACK", airline: summary.airline ?? first?.airline ?? "" })
      : undefined;
    return c.json({ ...summary, displayTotal, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), requestId });
  } catch (err: any) {
    persistInBackground(c, persistExchanges(c.env, db, tenantId, collector.exchanges, { searchId: searchId ?? null, requestId }));
    runInBackground(c, logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/fms/v1/review",
      httpStatus: typeof err?.statusCode === "number" ? err.statusCode : undefined, level: "ERROR", requestId: err?.requestId ?? requestId,
      requestSummary: { priceIds, supplierErrorCodes: err?.supplierErrorCodes }, errorCode: err?.code,
      errorMessage: err?.supplierMessage ? `${err.message} — TripJack: ${err.supplierMessage}` : err?.message,
      durationMs: Date.now() - started }));
    const expired = err?.code === "FARE_EXPIRED";
    return c.json({
      error: expired ? "This fare is no longer available. Please search again." : "We couldn't confirm availability right now.",
      errorCode: expired ? "FARE_EXPIRED" : "FARE_REVIEW_FAILED", supplierMessage: err?.supplierMessage, requestId: err?.requestId ?? requestId,
    }, expired ? 409 : 503);
  }
});

// POST /api/book/seat-map — TripJack seat map for a reviewed booking (conditions.isa).
// The parsed map is kept for the fare session so the booking can price the seats.
const SEAT_MAP_KEY = (tenantId: string, bookingId: string) => `flight_seatmap:${tenantId}:${bookingId}`;

bookDirectRoutes.post("/seat-map", zValidator("json", z.object({ reviewBookingId: z.string().min(5), searchId: z.string().uuid().optional() })), async (c) => {
  const { reviewBookingId, searchId } = c.req.valid("json");
  const tenantId = c.get("tenantId");
  const stored = await c.env.SESSIONS_KV.get(REVIEW_KEY(tenantId, reviewBookingId), "json") as StoredReview | null;
  if (!stored) return c.json({ errorCode: "FARE_EXPIRED", error: "Your fare session expired. Please search again." }, 409);
  if (!stored.summary.conditions.seatApplicable) return c.json({ errorCode: "SEAT_NOT_APPLICABLE", error: "Seat selection is not available for this fare." }, 400);
  const cached = await c.env.SESSIONS_KV.get(SEAT_MAP_KEY(tenantId, reviewBookingId), "json").catch(() => null) as SegmentSeatMap[] | null;
  if (cached?.length) return c.json({ segments: cached });
  const { platformCredentials, supplierConfigs } = await resolveFlightSuppliers(c.env, c.get("tenant"), tenantId);
  const config = supplierConfigs.find((s) => s.name === "TRIPJACK");
  const collector = collectExchanges();
  const client = new TripjackClient({ recorder: collector.recorder, ...(platformCredentials.TRIPJACK ?? {}), ...(config?.credentials ?? {}) });
  const requestId = crypto.randomUUID();
  try {
    const raw = await client.seatMap(reviewBookingId) as any;
    const segments = parseTripjackSeatMap(raw);
    const ttl = Math.max(60, Math.min(stored.summary.conditions.sessionSeconds ?? 900, 1800));
    if (segments.length) await c.env.SESSIONS_KV.put(SEAT_MAP_KEY(tenantId, reviewBookingId), JSON.stringify(segments), { expirationTtl: ttl });
    persistInBackground(c, persistExchanges(c.env, c.get("db"), tenantId, collector.exchanges, { searchId: searchId ?? null, requestId }));
    if (!segments.length) return c.json({ errorCode: "SEAT_MAP_EMPTY", error: "The airline hasn't released seats for this flight yet." }, 404);
    return c.json({ segments });
  } catch (err: any) {
    persistInBackground(c, persistExchanges(c.env, c.get("db"), tenantId, collector.exchanges, { searchId: searchId ?? null, requestId }));
    runInBackground(c, logSupplierCall(c.get("db"), { tenantId, supplier: "TRIPJACK", endpoint: "/fms/v1/seat", level: "ERROR", requestId,
      httpStatus: typeof err?.statusCode === "number" ? err.statusCode : undefined, requestSummary: { bookingId: reviewBookingId },
      errorCode: err?.code ?? "SEAT_MAP_FAILED", errorMessage: err?.message, responseSnippet: err?.responseSnippet }));
    return c.json({ errorCode: "SEAT_MAP_FAILED", error: "Seat map is unavailable right now." }, 502);
  }
});

// GET /api/book/held/:id — a held fare for the "pay later" page; authorised by
// the checkout token sent in the hold message (X-Checkout-Token).
bookDirectRoutes.get("/held/:id", async (c) => {
  const id = c.req.param("id");
  let payload: Record<string, unknown>;
  try { payload = await verifyToken(c.req.header("X-Checkout-Token") ?? "", c.env.JWT_SECRET); }
  catch { return c.json({ error: "This payment link has expired. Please search again." }, 401); }
  if (payload.sub !== id || payload.tenantId !== c.get("tenantId")) return c.json({ error: "Invalid payment link" }, 403);
  const [b] = await c.get("db").select({
    id: bookings.id, status: bookings.status, origin: bookings.origin, destination: bookings.destination,
    departureDate: bookings.departureDate, pnr: bookings.pnr, heldUntil: bookings.heldUntil,
    totalAmount: bookings.totalAmount, currency: bookings.currency,
    adultCount: bookings.adultCount, childCount: bookings.childCount, infantCount: bookings.infantCount,
  }).from(bookings).where(and(eq(bookings.id, id), eq(bookings.tenantId, c.get("tenantId")))).limit(1);
  if (!b) return c.json({ error: "Booking not found" }, 404);
  const expired = b.status === "HELD" && !!b.heldUntil && b.heldUntil.getTime() < Date.now();
  return c.json({ booking: { ...b, totalAmount: Number(b.totalAmount), expired } });
});

bookDirectRoutes.post("/", zValidator("json", directBookSchema, (result, c) => {
  if (!result.success) {
    const nameIssue = result.error.issues.find((i) => i.path.includes("firstName") || i.path.includes("lastName"))
      ?? result.error.issues.find((i) => ["panNumber", "documentId", "gstNumber", "registeredName", "passportIssueDate"].some((f) => i.path.includes(f)));
    return c.json({ errorCode: "BOOKING_DETAILS_INVALID", ...(nameIssue ? { error: nameIssue.message } : {}) }, 400);
  }
}), async (c) => {
  const body     = c.req.valid("json");
  const db       = c.get("db");
  const tenantId = c.get("tenantId");
  const tenant   = c.get("tenant");
  const requestId = crypto.randomUUID();
  const exchanges = (c as any).get("exchanges") as ExchangeCollector | undefined;
  (c as any).set("exchangeRequestId", requestId);
  if (body.searchId) (c as any).set("exchangeSearchId", body.searchId);
  const customerId = await optionalCustomerId(c);
  // B2B: an agency login books for its customers (paid from the agency wallet).
  const agent = customerId ? null : await optionalAgent(c);
  // Customer sent by a Leadvyne Live Agency: tag the booking with the agency (no wallet / pricing effect).
  const leadAgent = !agent && body.leadAgentNumber
    ? await resolveAgentNumber(c.env, db, tenantId, body.leadAgentNumber).catch(() => null)
    : null;
  const leadAgentTag = leadAgent ? { leadAgent: { id: leadAgent.id, number: leadAgent.number } } : {};
  if (agent) {
    try {
      await assertAgentCanBook(c.env, db, tenantId, agent.agentId, {
        origin: body.origin.toUpperCase(), destination: body.destination.toUpperCase(), departureDate: body.departureDate,
        names: body.passengers.map((p) => `${p.firstName.trim()} ${p.lastName.trim()}`),
      });
    } catch (err) {
      if (err instanceof AgentBlocked) return c.json({ error: err.message, errorCode: err.code, requestId }, 403);
      throw err;
    }
  }

  const { platformCredentials: platformCreds, supplierConfigs } = await resolveFlightSuppliers(c.env, tenant, tenantId);

  if (!supplierConfigs.some((s) => s.name === body.supplier && s.isEnabled)) {
    return c.json({ errorCode: "BOOKING_UNAVAILABLE", requestId }, 503);
  }
  const adapter = getBookableAdapter(body.supplier, supplierConfigs, platformCreds);
  if (!adapter.book) {
    throw new HTTPException(400, { message: `${body.supplier} does not support direct booking` });
  }

  // TripJack fare IDs are search references. Review immediately before booking so
  // the supplier gives us a fresh booking session instead of rejecting a stale ID.
  let bookingSessionId = body.fareId;
  let tripjackClient: TripjackClient | undefined;
  let reviewPaymentAmount: number | undefined;
  let reviewAirline: string | undefined;
  let reviewSummary: ReviewSummary | undefined;
  let reviewedPriceIds: string[] = [body.fareId];
  if (body.supplier === "TRIPJACK") {
    const tripjackConfig = supplierConfigs.find((s) => s.name === "TRIPJACK");
    const client = new TripjackClient({
      recorder: exchanges?.recorder,
      ...(platformCreds.TRIPJACK ?? {}),
      ...(tripjackConfig?.credentials ?? {}),
    });
    tripjackClient = client;
    const reviewStart = Date.now();
    if (body.reviewBookingId) {
      const stored = await c.env.SESSIONS_KV.get(REVIEW_KEY(tenantId, body.reviewBookingId), "json") as StoredReview | null;
      if (!stored) return c.json({ error: "Your fare session expired. Please search again.", errorCode: "FARE_EXPIRED", requestId }, 409);
      bookingSessionId = stored.summary.bookingId;
      reviewPaymentAmount = stored.summary.totalFare;
      reviewAirline = stored.summary.airline;
      reviewSummary = stored.summary;
      reviewedPriceIds = stored.priceIds;
    } else try {
      const review = await client.validateFare(body.fareId);
      bookingSessionId = review.bookingId;
      // TripJack requires paymentInfos.amount = TF from the review response exactly.
      // review.result is already raw.data (unwrapped by validateFare).
      // TF is at results[0].totalPriceInfo or results[0].fareGroups[0].totalPriceInfo.
      const rr = review.result as any;
      reviewAirline = findAirlineCode(rr);
      reviewSummary = parseTripjackReview(rr);
      // TripJack review: response uses either "results" or "tripInfos" at the top level
      // depending on the API version / proxy. Try both.
      const rFirstResult = rr?.results?.[0] ?? rr?.tripInfos?.[0];
      const priceInfo = rFirstResult?.totalPriceInfo;
      const fd  = priceInfo?.fd;
      const tfd = priceInfo?.totalFareDetail;
      const fg0Price = rFirstResult?.fareGroups?.[0]?.totalPriceInfo;
      const fg0fd  = fg0Price?.fd;
      const fg0tfd = fg0Price?.totalFareDetail;
      // Also try the top-level totalPriceInfo directly on rr (some gateway versions)
      const rrPrice = rr?.totalPriceInfo;
      const rrfd  = rrPrice?.fd;
      const rrtfd = rrPrice?.totalFareDetail;
      // The booking total for every traveller (never one adult's per-pax fare).
      const n = (t: string) => body.passengers.filter((p) => p.type === t).length;
      reviewPaymentAmount = reviewTotalFare(rr, { adults: n("ADULT"), children: n("CHILD"), infants: n("INFANT") }).TF;
      if (!reviewPaymentAmount) {
        // Log the raw structure so the next request tells us the correct path.
        console.warn("[book-review] TF not found; payable booking will be rejected. rr keys:",
          JSON.stringify(Object.keys(rr ?? {})), "snippet:", JSON.stringify(rr).slice(0, 500));
      }
      void logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/fms/v1/review",
        httpStatus: 200, level: reviewPaymentAmount ? "INFO" : "WARN", requestId,
        requestSummary: { fareId: body.fareId, bookingId: review.bookingId, tf: reviewPaymentAmount,
          tfMissing: !reviewPaymentAmount || undefined },
        responseSnippet: !reviewPaymentAmount ? JSON.stringify(priceInfo ?? fg0Price ?? rrPrice ?? rr).slice(0, 800) : undefined,
        durationMs: Date.now() - reviewStart });
    } catch (err: any) {
      console.error("[book-review]", JSON.stringify({ code: err?.code, requestId: err?.requestId }));
      // waitUntil: a bare promise can be cancelled once the response is sent.
      runInBackground(c, logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/fms/v1/review",
        httpStatus: typeof err?.statusCode === "number" ? err.statusCode : undefined,
        level: "ERROR", requestId: err?.requestId ?? requestId,
        requestSummary: { fareId: body.fareId, supplierErrorCodes: err?.supplierErrorCodes },
        errorCode: err?.code,
        errorMessage: err?.supplierMessage ? `${err.message} — TripJack: ${err.supplierMessage}` : err?.message,
        durationMs: Date.now() - reviewStart }));
      return c.json({ error: err?.code === "FARE_EXPIRED" ? "This fare is no longer available." : "We couldn't confirm availability. Your details are still here.",
        errorCode: err?.code === "FARE_EXPIRED" ? "FARE_EXPIRED" : "FARE_REVIEW_FAILED",
        diagnosticCode: err?.code, requestId: err?.requestId ?? requestId }, err?.code === "FARE_EXPIRED" ? 409 : 503);
    }

    if (typeof reviewPaymentAmount !== "number" || !Number.isFinite(reviewPaymentAmount) || reviewPaymentAmount <= 0) {
      return c.json({
        error: "We couldn't confirm the airline's current total. Please search again. You have not been charged.",
        errorCode: "FARE_REVIEW_FAILED",
        diagnosticCode: "REVIEW_TOTAL_INVALID",
        requestId,
      }, 503);
    }

    // Safe payment flow: save booking as PAYMENT_PENDING and let the frontend
    // call /api/payments/checkout to get a payment URL. The actual TripJack
    // book() call happens in the queue consumer after payment is captured.
    // Customer pays TripJack's reviewed fare plus the tenant markup (the same rules
    // search used for the displayed price). TripJack itself is paid the net fare.
    let ssrAmount = 0;
    let seatAmount = 0;
    if (reviewSummary) {
      const problem = conditionProblem(reviewSummary, body);
      if (problem) return c.json({ errorCode: "BOOKING_DETAILS_INVALID", error: problem, requestId }, 400);
      const ssr = ssrTotal(reviewSummary.segments, body.passengers);
      if (ssr.invalid.length) return c.json({ errorCode: "BOOKING_DETAILS_INVALID", error: `Unavailable meal / baggage choice (${ssr.invalid[0]}). Please choose again.`, requestId }, 400);
      ssrAmount = ssr.total;
      if (body.passengers.some((p) => p.ssr?.seat?.length)) {
        if (!reviewSummary.conditions.seatApplicable) return c.json({ errorCode: "BOOKING_DETAILS_INVALID", error: "Seat selection is not available for this fare.", requestId }, 400);
        const maps = await c.env.SESSIONS_KV.get(SEAT_MAP_KEY(tenantId, bookingSessionId!), "json").catch(() => null) as SegmentSeatMap[] | null;
        if (!maps?.length) return c.json({ errorCode: "BOOKING_DETAILS_INVALID", error: "Your seat selection expired. Please choose your seats again.", requestId }, 400);
        const seats = seatTotal(maps, body.passengers);
        if (seats.invalid.length) return c.json({ errorCode: "BOOKING_DETAILS_INVALID", error: `Seat unavailable (${seats.invalid[0]}). Please choose another seat.`, requestId }, 400);
        seatAmount = seats.total;
        ssrAmount = Math.round((ssrAmount + seatAmount) * 100) / 100;
      }
    }
    // TripJack is paid TF + chosen SSR (paymentInfos.amount); markup applies to the fare only.
    const fareAmount = reviewPaymentAmount;
    const supplierAmount = Math.round((fareAmount + ssrAmount) * 100) / 100;
    const companyFareAmount = await customerPrice(db, tenantId, fareAmount, {
      origin: body.origin.toUpperCase(), destination: body.destination.toUpperCase(),
      supplier: body.supplier, airline: reviewAirline ?? "",
    }, agent?.agentId ?? null);
    // Agencies pay their NET price: company price + each parent agency's markup.
    const agentQuote = agent ? (await agentPricing(c.env, db, tenantId, agent.agentId)).price(companyFareAmount) : null;
    const fareCustomerAmount = agentQuote?.net ?? companyFareAmount;
    const customerAmount = fareCustomerAmount + ssrAmount;
    const markupAmount = Math.max(0, Math.round((customerAmount - supplierAmount) * 100) / 100);

    // Hold now, pay later: book with TripJack without payment (ON_HOLD) first.
    let hold: { ref: string; pnr: string | null; until: Date } | null = null;
    if (body.holdOnly) {
      if (!body.reviewBookingId || !reviewSummary?.conditions.holdAllowed || !tripjackClient) {
        return c.json({ errorCode: "HOLD_NOT_ALLOWED", error: "This fare can't be held. Please pay now to book it.", requestId }, 400);
      }
      if (ssrAmount > 0) {
        return c.json({ errorCode: "HOLD_NOT_ALLOWED", error: "Meals, baggage and seats can't be added to a held fare. Remove them, or pay now.", requestId }, 400);
      }
      const holdStart = Date.now();
      try {
        const raw = await tripjackClient.book({
          fareId: body.fareId, holdId: bookingSessionId!, holdOnly: true,
          passengers: body.passengers.map(({ ssr: _ssr, ...p }) => p),
          contactEmail: body.contactEmail, contactPhone: body.contactPhone, paymentRef: "HOLD",
          ...(body.gstInfo ? { gstInfo: body.gstInfo } : {}),
          ...(body.emergencyContact ? { emergencyContact: body.emergencyContact } : {}),
        });
        const held = normalizeBookingResponse(raw, bookingSessionId!);
        if (!held.success) throw Object.assign(new Error("TripJack did not hold the booking"), { responseSnippet: JSON.stringify(raw).slice(0, 800) });
        let until = findHoldDeadline(raw);
        let pnr = held.pnr || null;
        try {
          const details = await tripjackClient.pnrStatus(held.bookingRef);
          pnr ||= parseBookingDetails(details).pnr ?? null;
          until ??= findHoldDeadline(details);
        } catch { /* the PNR also shows later in My Trips */ }
        hold = { ref: held.bookingRef, pnr, until: until ?? fallbackHoldDeadline(new Date(body.departureDate)) };
        runInBackground(c, logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/oms/v1/air/book", level: "INFO", requestId,
          requestSummary: { bookingId: hold.ref, hold: true, pnr: hold.pnr, holdUntil: hold.until.toISOString(), deadlineFromSupplier: Boolean(until) },
          durationMs: Date.now() - holdStart }));
      } catch (err: any) {
        runInBackground(c, logSupplierCall(db, { tenantId, supplier: "TRIPJACK", endpoint: "/oms/v1/air/book", level: "ERROR", requestId,
          httpStatus: typeof err?.statusCode === "number" ? err.statusCode : undefined,
          requestSummary: { bookingId: bookingSessionId, hold: true },
          responseSnippet: err?.responseSnippet, errorCode: "HOLD_FAILED",
          errorMessage: err?.supplierDetail ?? err?.message, durationMs: Date.now() - holdStart }));
        return c.json({ errorCode: "HOLD_FAILED", error: "The airline couldn't hold this fare right now. You can still pay now to book it.", requestId }, 422);
      }
    }

    let pendingBooking: typeof bookings.$inferSelect | undefined;
    try {
      [pendingBooking] = await db.insert(bookings).values({
        tenantId,
        userId:             customerId,
        ...(agent ? { agentId: agent.agentId } : {}),
        channel:            agent ? "B2B_PORTAL" : "B2C_WEB",
        status:             hold ? "HELD" : "PAYMENT_PENDING",
        tripType:           body.tripType,
        cabinClass:         "ECONOMY",
        origin:             body.origin.toUpperCase(),
        destination:        body.destination.toUpperCase(),
        departureDate:      new Date(body.departureDate),
        flightData:         {
          id: body.fareId,
          ...(body.searchId ? { searchId: body.searchId } : {}),
          ...leadAgentTag,
          ...(agent && agentQuote ? { agentPricing: {
            agentUserId: agent.userId, companyPrice: companyFareAmount, net: agentQuote.net,
            selling: Math.round((agentQuote.selling + ssrAmount) * 100) / 100, shares: agentQuote.shares,
          } } : {}),
          // Everything the post-payment TripJack book needs beyond the passenger rows.
          tripjack: {
            priceIds: reviewedPriceIds,
            reviewBookingId: bookingSessionId,
            fareIdentifiers: reviewSummary?.fareIdentifiers ?? [],
            conditions: reviewSummary?.conditions ?? null,
            ssrAmount,
            ...(hold ? { held: true } : {}),
            ...(seatAmount ? { seatAmount } : {}),
            ...(body.gstInfo ? { gstInfo: body.gstInfo } : {}),
            ...(body.emergencyContact ? { emergencyContact: body.emergencyContact } : {}),
            pax: body.passengers.map((p) => ({
              type: p.type, firstName: p.firstName.trim(), lastName: p.lastName.trim(),
              ...(p.passportIssueDate ? { passportIssueDate: p.passportIssueDate } : {}),
              ...(p.panNumber ? { panNumber: p.panNumber.toUpperCase() } : {}),
              ...(p.documentId ? { documentId: p.documentId } : {}),
              ...(p.ssr ? { ssr: p.ssr } : {}),
            })),
            segments: reviewSummary?.segments.map(({ ssr: _ssr, ...seg }) => seg) ?? [],
          },
        },
        ...(body.gstInfo ? { gstNumber: body.gstInfo.gstNumber.toUpperCase() } : {}),
        adultCount:         body.passengers.filter((p) => p.type === "ADULT").length,
        childCount:         body.passengers.filter((p) => p.type === "CHILD").length,
        infantCount:        body.passengers.filter((p) => p.type === "INFANT").length,
        baseFare:           String(supplierAmount),
        taxes:              "0",
        markup:             String(markupAmount),
        totalAmount:        String(supplierAmount + markupAmount),
        currency:           body.currency,
        supplier:           body.supplier,
        supplierBookingRef: hold?.ref ?? bookingSessionId,
        ...(hold ? { heldUntil: hold.until, ...(hold.pnr ? { pnr: hold.pnr } : {}) } : {}),
        contactEmail:       body.contactEmail,
        contactPhone:       body.contactPhone,
      }).returning();
      (c as any).set("exchangeBookingId", pendingBooking?.id);

      await db.insert(bookingPassengers).values(
        body.passengers.map((p) => ({
          bookingId:       pendingBooking!.id,
          passengerType:   p.type,
          firstName:       p.firstName,
          lastName:        p.lastName,
          dob:             p.dob ? new Date(p.dob) : null,
          gender:          p.gender ?? null,
          nationality:     p.nationality ?? null,
          passportNumber:  p.passportNumber  ?? null,
          passportExpiry:  p.passportExpiry  ? new Date(p.passportExpiry) : null,
          passportCountry: p.passportCountry ?? p.nationality ?? null,
        })),
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[book-save]", JSON.stringify({ requestId, error: errMsg }));
      return c.json({ errorCode: "BOOKING_SAVE_FAILED", requestId }, 500);
    }

    // Short-lived checkout token so the browser can start the Nomod payment for
    // this booking only (/api/payments/checkout accepts it via X-Checkout-Token).
    const now = Math.floor(Date.now() / 1000);
    // A held fare can be paid until the airline's time limit (link in the hold message).
    const exp = hold ? Math.max(now + 20 * 60, Math.floor(hold.until.getTime() / 1000)) : now + 20 * 60;
    const checkoutToken = await signToken(
      { sub: pendingBooking!.id, tenantId, iat: now, exp },
      c.env.JWT_SECRET,
    );

    if (hold) {
      const amount = supplierAmount + markupAmount;
      const payLink = `${WEB_URL}/pay?${new URLSearchParams({ b: pendingBooking!.id, t: checkoutToken })}`;
      const route = `${body.origin.toUpperCase()} → ${body.destination.toUpperCase()}`;
      runInBackground(c, notifyCustomer(c.env, db, tenantId, {
        email: body.contactEmail, phone: body.contactPhone, category: "booking",
        subject: `Fare on hold: ${route} — pay by ${holdLabel(hold.until)}`,
        html: emailShell("Your fare is on hold", `<p>${escapeHtml(route)} on ${escapeHtml(body.departureDate)} is held${hold.pnr ? ` (airline PNR <b>${escapeHtml(hold.pnr)}</b>)` : ""}.</p>
<p>Pay <b>${escapeHtml(money(amount, body.currency))}</b> before <b>${escapeHtml(holdLabel(hold.until))} (IST)</b> to get your e-ticket. After that the airline releases the seats.</p>`, { label: "Pay now", href: payLink }),
        whatsapp: `🔒 *Fare on hold* — ${route} on ${body.departureDate}${hold.pnr ? `\nPNR: ${hold.pnr}` : ""}\nPay ${money(amount, body.currency)} before ${holdLabel(hold.until)} (IST) to get your ticket:\n${payLink}`,
      }));
      return c.json({
        success: true, held: true, bookingId: pendingBooking!.id, pnr: hold.pnr, heldUntil: hold.until.toISOString(),
        amount, currency: body.currency, requiresPayment: true, checkoutToken, requestId,
      }, 201);
    }

    return c.json({
      success:         true,
      bookingId:       pendingBooking!.id,
      amount:          supplierAmount + markupAmount,
      currency:        body.currency,
      requiresPayment: true,
      checkoutToken,
      requestId,
    }, 201);
  }

  // Log that a book attempt is being made — written before the call so CF timeout can't swallow it.
  void logSupplierCall(db, { tenantId, supplier: body.supplier as "TRIPJACK", endpoint: "/oms/v1/air/book",
    level: "INFO", requestId,
    requestSummary: { bookingId: bookingSessionId, fareId: body.fareId,
      origin: body.origin, destination: body.destination, paxCount: body.passengers.length,
      paymentAmount: reviewPaymentAmount ?? body.totalFare, status: "INITIATED" } });

  let result;
  const bookStart = Date.now();
  try {
    const params = {
      fareId:         body.fareId,
      holdId:         bookingSessionId,
      passengers:     body.passengers,
      contactEmail:   body.contactEmail,
      contactPhone:   body.contactPhone,
      paymentRef:     "DIRECT_B2C",
      paymentAmount:  reviewPaymentAmount ?? body.totalFare,
    };
    result = tripjackClient
      ? normalizeBookingResponse(await tripjackClient.book(params), bookingSessionId)
      : await adapter.book(params);
  } catch (err: any) {
    // Once sent, a network/5xx failure cannot establish that no booking exists.
    const status = Number(err?.statusCode);
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError" || /timeout/i.test(String(err?.message));
    if (status === 409) {
      c.executionCtx.waitUntil(logSupplierCall(db, { tenantId, supplier: body.supplier as "TRIPJACK", endpoint: "/oms/v1/air/book",
        httpStatus: 409, level: "ERROR", requestId,
        requestSummary: { bookingId: bookingSessionId, origin: body.origin, destination: body.destination },
        errorCode: "FARE_EXPIRED", errorMessage: "Booking session expired", durationMs: Date.now() - bookStart }));
      return c.json({ errorCode: "FARE_EXPIRED", requestId }, 409);
    }
    const rejected = [400, 401, 403, 404, 422, 429].includes(status);
    const httpSupplierMsg = typeof (err as any)?.supplierDetail === "string" && (err as any).supplierDetail.trim()
      ? (err as any).supplierDetail.trim() : undefined;
    const errorCode = isTimeout ? "BOOK_TIMEOUT" : rejected ? "BOOKING_REJECTED" : "BOOKING_STATUS_UNKNOWN";
    console.error("[book-submit]", JSON.stringify({ requestId, httpStatus: status || null, code: errorCode }));
    c.executionCtx.waitUntil(logSupplierCall(db, { tenantId, supplier: body.supplier as "TRIPJACK", endpoint: "/oms/v1/air/book",
      httpStatus: status || undefined, level: "ERROR", requestId,
      requestSummary: { bookingId: bookingSessionId, origin: body.origin, destination: body.destination, paxCount: body.passengers.length },
      errorCode,
      errorMessage: httpSupplierMsg ?? err?.message, durationMs: Date.now() - bookStart }));
    return c.json({ errorCode: isTimeout ? "BOOKING_STATUS_UNKNOWN" : rejected ? "BOOKING_REJECTED" : "BOOKING_STATUS_UNKNOWN",
      requestId, bookingReference: bookingSessionId,
      ...(httpSupplierMsg ? { supplierMessage: httpSupplierMsg } : {}) }, isTimeout ? 502 : rejected ? 422 : 502);
  }

  if (!result.success) {
    const raw = result.raw as any;
    const orderMsg = String(raw?.data?.order?.statusMessage ?? raw?.data?.statusMessage ?? "");
    const topMsg   = String(raw?.status?.statusMessage ?? "");
    console.error("[book-rejected]", JSON.stringify({ requestId, orderMsg, topMsg, paymentAmount: reviewPaymentAmount ?? body.totalFare, raw: JSON.stringify(raw).slice(0, 600) }));
    c.executionCtx.waitUntil(logSupplierCall(db, { tenantId, supplier: body.supplier as "TRIPJACK", endpoint: "/oms/v1/air/book",
      httpStatus: 200, level: "ERROR", requestId,
      requestSummary: { bookingId: bookingSessionId, origin: body.origin, destination: body.destination, paxCount: body.passengers.length },
      responseSnippet: JSON.stringify(raw).slice(0, 800),
      errorCode: "BOOKING_REJECTED", errorMessage: orderMsg || topMsg || "Supplier rejected booking",
      durationMs: Date.now() - bookStart }));
    // If the raw TripJack response indicates session/fare expiry, surface it as FARE_EXPIRED
    // so the frontend shows "search again" rather than "contact support".
    const rawMsg = (orderMsg + " " + topMsg).toLowerCase();
    if (/expir|no longer available|booking session|no tripjack comment|no comment found|session not found/i.test(rawMsg)) {
      return c.json({ errorCode: "FARE_EXPIRED", requestId }, 409);
    }
    const supplierMessage = (orderMsg || topMsg) || undefined;
    return c.json({ errorCode: "BOOKING_REJECTED", requestId, ...(supplierMessage ? { supplierMessage } : {}) }, 422);
  }

  // Persist booking record
  let booking: typeof bookings.$inferSelect | undefined;
  try {
  [booking] = await db.insert(bookings).values({
    tenantId,
    userId:             customerId,
    channel:            "B2C_WEB",
    status:             result.status === "CONFIRMED" || result.status === "TICKETED" ? "CONFIRMED" : "HELD",
    tripType:           "ONEWAY",
    cabinClass:         "ECONOMY",
    origin:             body.origin.toUpperCase(),
    destination:        body.destination.toUpperCase(),
    departureDate:      new Date(body.departureDate),
    flightData:         { id: body.fareId, ...(body.searchId ? { searchId: body.searchId } : {}), ...leadAgentTag },
    adultCount:         body.passengers.filter((p) => p.type === "ADULT").length,
    childCount:         body.passengers.filter((p) => p.type === "CHILD").length,
    infantCount:        body.passengers.filter((p) => p.type === "INFANT").length,
    baseFare:           String(body.totalFare),
    taxes:              "0",
    totalAmount:        String(body.totalFare),
    currency:           body.currency,
    supplier:           body.supplier,
    supplierBookingRef: result.bookingRef,
    pnr:                result.pnr ?? null,
    contactEmail:       body.contactEmail,
    contactPhone:       body.contactPhone,
  }).returning();
  (c as any).set("exchangeBookingId", booking?.id);

  const bookingId = booking.id;
  await db.insert(bookingPassengers).values(
    body.passengers.map((p) => ({
      bookingId,
      passengerType:   p.type,
      firstName:       p.firstName,
      lastName:        p.lastName,
      dob:             p.dob ? new Date(p.dob) : null,
      gender:          p.gender ?? null,
      nationality:     p.nationality ?? null,
      passportNumber:  p.passportNumber  ?? null,
      passportExpiry:  p.passportExpiry  ? new Date(p.passportExpiry) : null,
      passportCountry: p.nationality ?? null,
    })),
  );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[book-save]", JSON.stringify({ requestId, bookingReference: result.bookingRef, error: errMsg }));
    c.executionCtx.waitUntil(logSupplierCall(db, { tenantId, supplier: body.supplier as "TRIPJACK", endpoint: "db:bookings:insert",
      level: "ERROR", requestId,
      requestSummary: { bookingRef: result.bookingRef, pnr: result.pnr },
      errorCode: "DB_WRITE_FAILED", errorMessage: errMsg }));
    // The supplier accepted this request. Do not invite a duplicate booking.
    return c.json({ success: true, bookingId: booking?.id, pnr: result.pnr,
      bookingReference: result.bookingRef, status: result.status,
      warningCode: "BOOKING_SAVE_PENDING", requestId }, 202);
  }

  return c.json({
    success:          true,
    bookingId:        booking.id,
    pnr:              result.pnr,
    bookingReference: result.bookingRef,
    status:           result.status,
  }, 201);
});

// First airline code in a TripJack review response (tripInfos[].sI[].fD.aI.code).
function findAirlineCode(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  const code = (value as any)?.fD?.aI?.code;
  if (typeof code === "string" && code) return code;
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = findAirlineCode(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// Applies the tenant's markup rules to the supplier amount. If rules can't be
// loaded the supplier amount is used, matching search's fallback.
async function customerPrice(
  db: Variables["db"], tenantId: string, supplierAmount: number,
  fare: { origin: string; destination: string; supplier: string; airline: string },
  agentId: string | null = null,
): Promise<number> {
  try {
    const { applyMarkup } = await import("../lib/markup.js");
    const { markupRules } = await import("@poomas/db/schema");
    const { rulesFor } = await import("../lib/agent-program.js");
    // Company-wide rules, plus this agency's own rules when an agency books.
    const rules = rulesFor(await db.select().from(markupRules).where(eq(markupRules.tenantId, tenantId)), agentId);
    const priced = applyMarkup({ ...fare, cabinClass: "ECONOMY", totalFare: supplierAmount } as any, rules);
    return Math.round(Math.max(priced, supplierAmount) * 100) / 100;
  } catch (err) {
    console.error("[book] markup unavailable; charging supplier amount", err);
    return supplierAmount;
  }
}

// Keeps background work alive after the response when a Worker execution
// context exists (always in production); falls back to a detached promise.
function runInBackground(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, work: Promise<unknown>) {
  try { c.executionCtx.waitUntil(work); } catch { void work; }
}
