// Group fares on the customer website (public, no login). See lib/group-fares.ts.
//
//   GET /api/group-fares/status   { enabled, count }        — for the website menu
//   GET /api/group-fares          { enabled, fares[] }      — published group fares on sale
//   GET /api/group-fares/:id?adults=&children=&infants=     — one fare + the price for that party
//
// Prices are worked out on every request from the fare as it is now in Admin (no caching), with
// the same markup the checkout charges. Inactive, unpublished, sale-ended or departed fares are
// "not available" here and are refused at checkout. Internal notes are never returned.

import { Hono } from "hono";
import { and, asc, eq, gt, gte, isNull, or } from "drizzle-orm";
import { manualFares } from "@zamrabooking/db/schema";
import type { Env, Variables } from "../types.js";
import { getManualSettings, manualFareToNormalized, inrConverter } from "../lib/flight-sources.js";
import { groupFareOnSale, groupFarePaxProblem } from "../lib/group-fares.js";
import { customerPrice } from "./book.js";

export const groupFareRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

type Row = typeof manualFares.$inferSelect;
const NO_STORE = { "Cache-Control": "no-store" };

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function onSaleRows(c: { get: (k: "db") => Variables["db"] }, tenantId: string, id?: string): Promise<Row[]> {
  const rows = await c.get("db").select().from(manualFares).where(and(
    eq(manualFares.tenantId, tenantId),
    ...(id ? [eq(manualFares.id, id)] : []),
    eq(manualFares.isGroupFare, true),
    eq(manualFares.isPublished, true),
    eq(manualFares.isActive, true),
    gte(manualFares.travelDate, todayIst()),
    or(isNull(manualFares.saleEndsAt), gt(manualFares.saleEndsAt, new Date())),
  )).orderBy(asc(manualFares.travelDate), asc(manualFares.departureTime)).limit(id ? 1 : 200);
  return rows.filter((r) => groupFareOnSale(r));
}

function publicFare(row: Row) {
  return {
    id: row.id, title: row.title ?? `${row.origin} → ${row.destination}`, description: row.description,
    origin: row.origin, destination: row.destination, travelDate: row.travelDate,
    departureTime: row.departureTime, arrivalTime: row.arrivalTime, arrivalDayOffset: row.arrivalDayOffset,
    airline: row.airline, airlineName: row.airlineName || row.airline, flightNumber: row.flightNumber,
    stops: row.stops, cabinClass: row.cabinClass,
    baggage: { checked: row.checkedBaggage || "As per airline", cabin: row.cabinBaggage || "As per airline" },
    isRefundable: row.isRefundable,
    seatsLeft: Math.max(0, row.seatsAvailable), seatsTotal: row.seatsTotal,
    minPax: row.minPax, maxPax: row.maxPax,
    saleEndsAt: row.saleEndsAt ? new Date(row.saleEndsAt).toISOString() : null,
  };
}

// The price the checkout would charge this party (supplier amount + company markup), in INR.
async function priceFor(c: { get: (k: "db") => Variables["db"]; env: Env }, tenantId: string, row: Row, pax: { adults: number; children: number; infants: number }) {
  const fare = manualFareToNormalized(row, pax, await inrConverter(c.env, tenantId));
  if (!fare) return null;
  const total = await customerPrice(c.get("db"), tenantId, fare.totalFare, { origin: fare.origin, destination: fare.destination, supplier: "MANUAL", airline: fare.airline });
  return { total, currency: "INR" as const, fare };
}

groupFareRoutes.get("/status", async (c) => {
  const tenantId = c.get("tenantId");
  const settings = await getManualSettings(c.env, tenantId);
  if (!settings.groupFares) return c.json({ enabled: false, count: 0 }, 200, NO_STORE);
  const rows = await onSaleRows(c, tenantId).catch(() => []);
  return c.json({ enabled: true, count: rows.filter((r) => r.seatsAvailable > 0).length }, 200, NO_STORE);
});

groupFareRoutes.get("/", async (c) => {
  const tenantId = c.get("tenantId");
  const settings = await getManualSettings(c.env, tenantId);
  if (!settings.groupFares) return c.json({ enabled: false, fares: [] }, 200, NO_STORE);
  const rows = await onSaleRows(c, tenantId);
  const fares = await Promise.all(rows.map(async (row) => {
    const from = Math.max(1, row.minPax);
    const priced = await priceFor(c, tenantId, row, { adults: 1, children: 0, infants: 0 });
    return priced ? { ...publicFare(row), pricePerAdult: priced.total, currency: priced.currency, soldOut: row.seatsAvailable < from } : null;
  }));
  return c.json({ enabled: true, fares: fares.filter((f) => f !== null) }, 200, NO_STORE);
});

const count = (v: string | undefined, fallback: number, max: number) => {
  const n = Number(v);
  return v == null || v === "" || !Number.isInteger(n) || n < 0 ? fallback : Math.min(n, max);
};

groupFareRoutes.get("/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");
  const unavailable = () => c.json({ errorCode: "GROUP_FARE_UNAVAILABLE", error: "This group fare is no longer available." }, 404, NO_STORE);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return unavailable();
  const settings = await getManualSettings(c.env, tenantId);
  if (!settings.groupFares) return unavailable();
  const [row] = await onSaleRows(c, tenantId, id);
  if (!row) return unavailable();
  const pax = { adults: Math.max(1, count(c.req.query("adults"), Math.max(1, row.minPax), 9)), children: count(c.req.query("children"), 0, 6), infants: count(c.req.query("infants"), 0, 4) };
  const priced = await priceFor(c, tenantId, row, pax);
  if (!priced) return unavailable();
  const perAdult = await priceFor(c, tenantId, row, { adults: 1, children: 0, infants: 0 });
  return c.json({
    fare: { ...publicFare(row), pricePerAdult: perAdult?.total ?? null, currency: "INR" },
    quote: {
      pax, total: priced.total, currency: priced.currency,
      problem: groupFarePaxProblem(row, pax),
      // What the booking page needs (it re-prices on the server at checkout).
      book: {
        fareId: row.id, supplier: "MANUAL", airline: priced.fare.airlineName, fn: priced.fare.flightNumber,
        from: priced.fare.origin, to: priced.fare.destination, dep: priced.fare.departureTime, arr: priced.fare.arrivalTime,
        dur: priced.fare.duration, stops: priced.fare.stops, bag: priced.fare.baggage.checked, cab: priced.fare.baggage.cabin,
        ref: priced.fare.isRefundable, cls: priced.fare.cabinClass, fl: "Group fare",
      },
    },
  }, 200, NO_STORE);
});
