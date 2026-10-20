// Agency analytics: searches and checkout links (daily tally) and bookings —
// both agency-portal bookings (bookings.agent_id) and Leadvyne customer
// bookings tagged with the agency (flight_data.leadAgent.id).

import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { agentActivityDaily, bookings } from "@poomas/db/schema";
import type { Variables } from "../types.js";

type Db = Variables["db"];

const BOOKED = ["CONFIRMED", "TICKETED", "REISSUED"] as const;

export interface AgentStats {
  searches: number; searchesPeriod: number;
  checkouts: number; checkoutsPeriod: number;
  bookings: number; bookingsPeriod: number;           // confirmed / ticketed
  attempts: number;                                   // all booking records (incl. unpaid / failed)
  bookingValue: number; bookingValuePeriod: number;   // INR
  conversionPct: number | null;                       // confirmed bookings per 100 searches (period)
  lastActivity: string | null;
}

const empty = (): AgentStats => ({
  searches: 0, searchesPeriod: 0, checkouts: 0, checkoutsPeriod: 0, bookings: 0, bookingsPeriod: 0,
  attempts: 0, bookingValue: 0, bookingValuePeriod: 0, conversionPct: null, lastActivity: null,
});

const attributedTo = sql<string>`coalesce(${bookings.agentId}, ${bookings.flightData}->'leadAgent'->>'id')`;

export async function agentStats(db: Db, tenantId: string, agentIds: string[], days = 30): Promise<Map<string, AgentStats>> {
  const out = new Map(agentIds.map((id) => [id, empty()]));
  if (!agentIds.length) return out;
  const since = new Date(Date.now() - days * 86_400_000);
  const sinceDay = since.toISOString().slice(0, 10);

  const [activity, booked] = await Promise.all([
    db.select({
      agentId: agentActivityDaily.agentId,
      searches: sql<number>`sum(${agentActivityDaily.searches})::int`,
      searchesPeriod: sql<number>`coalesce(sum(${agentActivityDaily.searches}) filter (where ${agentActivityDaily.day} >= ${sinceDay}), 0)::int`,
      checkouts: sql<number>`sum(${agentActivityDaily.checkouts})::int`,
      checkoutsPeriod: sql<number>`coalesce(sum(${agentActivityDaily.checkouts}) filter (where ${agentActivityDaily.day} >= ${sinceDay}), 0)::int`,
      last: sql<string>`max(${agentActivityDaily.day})::text`,
    }).from(agentActivityDaily)
      .where(and(eq(agentActivityDaily.tenantId, tenantId), inArray(agentActivityDaily.agentId, agentIds)))
      .groupBy(agentActivityDaily.agentId),
    db.select({
      agentId: attributedTo,
      attempts: sql<number>`count(*)::int`,
      bookings: sql<number>`(count(*) filter (where ${inArray(bookings.status, [...BOOKED])}))::int`,
      bookingsPeriod: sql<number>`(count(*) filter (where ${inArray(bookings.status, [...BOOKED])} and ${bookings.createdAt} >= ${since.toISOString()}::timestamptz))::int`,
      value: sql<string>`coalesce(sum(${bookings.totalAmount}) filter (where ${inArray(bookings.status, [...BOOKED])}), 0)::text`,
      valuePeriod: sql<string>`coalesce(sum(${bookings.totalAmount}) filter (where ${inArray(bookings.status, [...BOOKED])} and ${bookings.createdAt} >= ${since.toISOString()}::timestamptz), 0)::text`,
      last: sql<string>`max(${bookings.createdAt})::text`,
    }).from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), or(
        inArray(bookings.agentId, agentIds),
        inArray(sql`${bookings.flightData}->'leadAgent'->>'id'`, agentIds),
      )))
      .groupBy(attributedTo),
  ]);

  for (const a of activity) {
    const s = out.get(a.agentId); if (!s) continue;
    Object.assign(s, { searches: a.searches ?? 0, searchesPeriod: a.searchesPeriod ?? 0, checkouts: a.checkouts ?? 0, checkoutsPeriod: a.checkoutsPeriod ?? 0, lastActivity: a.last });
  }
  for (const b of booked) {
    const s = out.get(b.agentId); if (!s) continue;
    Object.assign(s, { attempts: b.attempts, bookings: b.bookings, bookingsPeriod: b.bookingsPeriod, bookingValue: Number(b.value), bookingValuePeriod: Number(b.valuePeriod) });
    const last = b.last?.slice(0, 10) ?? null;
    if (last && (!s.lastActivity || last > s.lastActivity)) s.lastActivity = last;
  }
  for (const s of out.values()) s.conversionPct = s.searchesPeriod ? Math.round((s.bookingsPeriod / s.searchesPeriod) * 1000) / 10 : null;
  return out;
}

// Day-by-day series for one agency (searches, checkout links, confirmed bookings).
export async function agentDaily(db: Db, tenantId: string, agentId: string, days = 30) {
  const sinceDay = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const [act, bk] = await Promise.all([
    db.select({ day: sql<string>`${agentActivityDaily.day}::text`, searches: agentActivityDaily.searches, checkouts: agentActivityDaily.checkouts })
      .from(agentActivityDaily)
      .where(and(eq(agentActivityDaily.tenantId, tenantId), eq(agentActivityDaily.agentId, agentId), gte(agentActivityDaily.day, sinceDay))),
    db.select({ day: sql<string>`(${bookings.createdAt} at time zone 'UTC')::date::text`, n: sql<number>`count(*)::int`, value: sql<string>`sum(${bookings.totalAmount})::text` })
      .from(bookings)
      .where(and(eq(bookings.tenantId, tenantId), inArray(bookings.status, [...BOOKED]), sql`${bookings.createdAt} >= ${sinceDay}::date`,
        or(eq(bookings.agentId, agentId), sql`${bookings.flightData}->'leadAgent'->>'id' = ${agentId}`)))
      .groupBy(sql`1`),
  ]);
  const rows = new Map<string, { day: string; searches: number; checkouts: number; bookings: number; value: number }>();
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.parse(`${sinceDay}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    rows.set(day, { day, searches: 0, checkouts: 0, bookings: 0, value: 0 });
  }
  for (const a of act) { const r = rows.get(a.day); if (r) { r.searches = a.searches; r.checkouts = a.checkouts; } }
  for (const b of bk) { const r = rows.get(b.day); if (r) { r.bookings = b.n; r.value = Number(b.value); } }
  return [...rows.values()];
}
