// TripSafe travel insurance (TripJack Insurance API v2).
//
//   GET  /api/insurance/config             enabled?, journeys, regions, rules
//   POST /api/insurance/search             trip → plans (Standalone / Domestic / Student / AMT / Embedded)
//   POST /api/insurance/book               traveller details for a plan → booking reference
//   GET  /api/insurance/bookings/:ref?key= booking status, policy IDs and COI links
//
// Enabled by Admin → Integrations → TripJack → TripSafe. UAT issues the policy
// straight away (TripJack wallet); production reserves the request and our
// team issues it once payment is received (Admin → TripSafe).
// Amendments (cancellation / correction) are Admin-only.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  TRIPSAFE_AMT_DURATIONS, TRIPSAFE_MAX_TRAVELLERS, TRIPSAFE_NOMINEE_RELATIONSHIPS, TRIPSAFE_REGIONS,
  TRIPSAFE_STUDENT_DURATIONS, TRIPSAFE_TERMINAL_STATUSES, tripsafeProblems,
} from "@poomas/suppliers";
import type { Env, Variables } from "../types.js";
import { optionalCustomerId } from "../lib/optional-customer.js";
import {
  issuePolicy, loadRecord, loadSearch, newAccessKey, newReference, publicRecord, refreshDetails, runSearch,
  saveRecord, tripsafeClient, tripsafeErrorResponse, tripsafeSettings, type TripsafeRecord,
} from "../lib/tripsafe.js";

export const insuranceRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd");

export const tripSchema = z.object({
  journey:          z.enum(["STANDALONE", "DOMESTIC", "STUDENT", "AMT", "EMBEDDED"]),
  startDate:        date,
  endDate:          date.optional(),
  coverageDuration: z.number().int().positive().optional(),
  destinations:     z.array(z.object({
    key:  z.string().trim().min(2).max(4).regex(/^[A-Za-z]+$/),
    type: z.enum(["COUNTRY", "REGION", "POPULARREGION"]),
  })).max(20).default([]),
  travellerDobs:    z.array(date).min(1).max(TRIPSAFE_MAX_TRAVELLERS),
});

const travellerSchema = z.object({
  title:          z.enum(["MR", "MRS", "MS", "MSTR", "MISS"]).optional(),
  firstName:      z.string().trim().min(1).max(60).regex(/^[A-Za-z][A-Za-z .'-]*$/, "Letters only"),
  lastName:       z.string().trim().min(1).max(60).regex(/^[A-Za-z][A-Za-z .'-]*$/, "Letters only"),
  dob:            date,
  gender:         z.enum(["Male", "Female"]).optional(),
  emailId:        z.string().email().optional(),
  contactNumber:  z.string().trim().regex(/^\+?[0-9 ]{6,16}$/).optional(),
  passportNumber: z.string().trim().regex(/^[A-Za-z0-9]{5,15}$/).optional(),
  passportNationality: z.string().trim().length(2).optional(),
  pinCode:        z.string().trim().regex(/^[A-Za-z0-9 -]{3,10}$/).optional(),
  nominee:        z.object({
    name:         z.string().trim().min(1).max(80),
    relationship: z.enum(TRIPSAFE_NOMINEE_RELATIONSHIPS as [string, ...string[]]),
  }).optional(),
});

const bookSchema = z.object({
  searchId:   z.string().min(1).max(64),
  productId:  z.string().min(1).max(120),
  travellers: z.array(travellerSchema).min(1).max(TRIPSAFE_MAX_TRAVELLERS),
  contact:    z.object({ email: z.string().email(), phone: z.string().trim().regex(/^\+?[0-9 ]{6,16}$/).optional() }),
});

async function enabledSettings(c: any) {
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  return settings.enabled ? settings : null;
}

const disabled = (c: any) => c.json({ error: "Travel insurance is not available right now.", code: "TRIPSAFE_DISABLED" }, 404);

insuranceRoutes.get("/config", async (c) => {
  const settings = await tripsafeSettings(c.env, c.get("tenantId"));
  return c.json({
    enabled:          settings.enabled,
    instantIssue:     settings.environment === "UAT",
    maxTravellers:    TRIPSAFE_MAX_TRAVELLERS,
    studentDurations: TRIPSAFE_STUDENT_DURATIONS,
    amtDurations:     TRIPSAFE_AMT_DURATIONS,
    regions:          Object.entries(TRIPSAFE_REGIONS).map(([key, name]) => ({ key, name })),
    nomineeRelationships: TRIPSAFE_NOMINEE_RELATIONSHIPS,
  });
});

insuranceRoutes.post("/search", zValidator("json", tripSchema), async (c) => {
  const settings = await enabledSettings(c);
  if (!settings) return disabled(c);
  const input = c.req.valid("json");
  const problems = tripsafeProblems(input);
  if (problems.length) return c.json({ error: problems[0], problems, code: "VALIDATION_ERROR" }, 400);
  try {
    const { searchId, products } = await runSearch(c, tripsafeClient(c.env, settings), input, "customer search");
    if (!searchId || !products.length) return c.json({ error: "No insurance plans are available for this trip.", code: "NO_PLANS" }, 404);
    return c.json({ searchId, currency: "INR", products: products.sort((a, b) => a.totalFare - b.totalFare) });
  } catch (err) {
    const { status, body } = tripsafeErrorResponse(err, "We couldn't load insurance plans right now. Please try again.");
    return c.json(body, status);
  }
});

insuranceRoutes.post("/book", zValidator("json", bookSchema), async (c) => {
  const settings = await enabledSettings(c);
  if (!settings) return disabled(c);
  const tenantId = c.get("tenantId");
  const body = c.req.valid("json");
  const ctx = await loadSearch(c.env, tenantId, body.searchId);
  if (!ctx) return c.json({ error: "Your insurance quote has expired. Please search again.", code: "SEARCH_EXPIRED" }, 410);
  const product = ctx.products.find((p) => p.productId === body.productId);
  if (!product) return c.json({ error: "Select a plan from the search results.", code: "PRODUCT_NOT_FOUND" }, 400);
  // TripJack: traveller count and DOBs must match the search (error 1134).
  if (body.travellers.length !== ctx.input.travellerDobs.length) {
    return c.json({ error: `Enter details for all ${ctx.input.travellerDobs.length} travellers.`, code: "TRAVELLER_COUNT_MISMATCH" }, 400);
  }
  const wanted = [...ctx.input.travellerDobs].sort().join();
  if ([...body.travellers.map((t) => t.dob)].sort().join() !== wanted) {
    return c.json({ error: "Traveller dates of birth must match the ones used for the quote. Search again to change them.", code: "DOB_MISMATCH" }, 400);
  }

  const now = new Date().toISOString();
  const record: TripsafeRecord = {
    reference:   newReference(),
    tenantId,
    accessKey:   newAccessKey(),
    customerId:  await optionalCustomerId(c).catch(() => null),
    createdAt:   now,
    updatedAt:   now,
    status:      "AWAITING_PAYMENT",
    environment: settings.environment,
    journey:     ctx.input.journey,
    input:       ctx.input,
    searchIds:   [ctx.searchId],
    searchId:    ctx.searchId,
    productId:   product.productId,
    product:     { planCoverage: product.planCoverage, insuranceProvider: product.insuranceProvider, regionName: product.regionName, planType: product.planType, totalFare: product.totalFare },
    currency:    "INR",
    contact:     body.contact,
    travellers:  body.travellers.map((t) => ({
      ...(t.title ? { title: t.title } : {}),
      firstName: t.firstName.toUpperCase(),
      lastName:  t.lastName.toUpperCase(),
      dob:       t.dob,
      ...(t.gender ? { gender: t.gender } : {}),
      emailId:   t.emailId ?? body.contact.email,
      ...(t.contactNumber ?? body.contact.phone ? { contactNumber: (t.contactNumber ?? body.contact.phone)!.replace(/[^0-9]/g, "").slice(-10) } : {}),
      ...(t.passportNumber ? { passportNumber: t.passportNumber.toUpperCase() } : {}),
      ...(t.passportNationality ? { passportNationality: t.passportNationality.toUpperCase() } : {}),
      ...(t.pinCode ? { pinCode: t.pinCode } : {}),
      ...(t.nominee ? { nomineeInfo: [{ nomineeName: t.nominee.name.toUpperCase(), nomineeRelationship: t.nominee.relationship }] } : {}),
    })),
  };
  await saveRecord(c.env, record, true);

  if (settings.environment === "PRODUCTION") {
    return c.json({
      reference: record.reference, key: record.accessKey, status: record.status,
      note: "Your insurance request is reserved. Our team issues the policy once payment is received.",
    }, 201);
  }
  try {
    await issuePolicy(c, settings, record);
  } catch (err) {
    const { status, body: e } = tripsafeErrorResponse(err, "We couldn't issue your policy. Please try again.");
    return c.json({ ...e, reference: record.reference, key: record.accessKey }, status);
  }
  return c.json({ reference: record.reference, key: record.accessKey, status: record.tripjack?.status ?? record.status }, 201);
});

insuranceRoutes.get("/bookings/:ref", async (c) => {
  const tenantId = c.get("tenantId");
  const record = await loadRecord(c.env, tenantId, c.req.param("ref"));
  const key = c.req.query("key") ?? "";
  const customerId = await optionalCustomerId(c).catch(() => null);
  if (!record || !(key === record.accessKey || (customerId && customerId === record.customerId))) {
    return c.json({ error: "Insurance booking not found" }, 404);
  }
  let details = null;
  let detailError: string | undefined;
  if (record.tripjack?.bookingId) {
    const settings = await tripsafeSettings(c.env, tenantId);
    try {
      // COI links are pre-signed and short-lived — always fetch fresh.
      details = await refreshDetails(c, tripsafeClient(c.env, settings), record, "customer view");
    } catch (err) {
      detailError = tripsafeErrorResponse(err, "Policy details are not available right now.").body.error as string;
    }
  }
  const status = details?.status ?? record.tripjack?.status ?? record.status;
  return c.json({
    ...publicRecord(record),
    error: undefined,
    status,
    pending: record.status === "AWAITING_PAYMENT" || (Boolean(record.tripjack) && !TRIPSAFE_TERMINAL_STATUSES.includes(status)),
    failed: record.status === "FAILED",
    details: details && {
      ...details,
      travellers: details.travellers.map(({ raw: _r, ...t }) => t),
    },
    ...(detailError ? { detailError } : {}),
  });
});
