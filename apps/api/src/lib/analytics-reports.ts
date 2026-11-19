// Admin → Analytics reports (Phase 1, docs/search-analytics.md). Read-only queries over the two
// analytics tables (migration 0015) and the live bookings / payments tables.
//
// Definitions (the same everywhere, including CSV):
//   paid booking     a booking with a successful payment (payments.status SUCCESS, PARTIAL_REFUND or
//                    REFUNDED — as routes/payments.ts) in a post-payment status. Cancelled / refunded
//                    after payment still counts as converted and is reported separately.
//   search status    NO_AVAILABILITY  no results or an error (never "abandoned")
//                    BOOKED           a paid booking from this search, or by the same visitor /
//                                     customer for the same route + date within 24 h by another path
//                    CHECKOUT_UNPAID  a booking was created (same rule) but not paid
//                    IN_PROGRESS      last seen under 24 h ago, nothing booked yet
//                    ABANDONED        had results, older than 24 h, nothing booked
//   abandoned checkout  a website booking created > 24 h ago, never paid, and no later paid booking
//                    by the same customer / contact for the same route + date.
// Money is always grouped by currency (never mixed). Dates are India time.

import { sql, type SQL } from "drizzle-orm";
import { ABANDON_WINDOW_HOURS } from "./search-analytics.js";

type Db = { execute: (q: SQL) => Promise<{ rows: unknown[] }> };
const rowsOf = async <T>(db: Db, q: SQL) => (await db.execute(q)).rows as T[];

export const MAX_RANGE_DAYS = 366;
export const MAX_EXPORT_ROWS = 50_000;
export const PAGE_SIZE = 100;

export interface ReportFilters {
  tenantId: string;
  from: string;   // YYYY-MM-DD (India), inclusive
  to: string;     // YYYY-MM-DD (India), inclusive
  device?: "mobile" | "tablet" | "desktop";
  country?: string;
  audience?: "guest" | "customer";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Validates query parameters; returns an error message or the filters. */
export function parseFilters(tenantId: string, q: Record<string, string | undefined>, today: string): ReportFilters | string {
  const to = q.to ?? today;
  const from = q.from ?? to;
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) return "from / to must be YYYY-MM-DD";
  if (from > to) return "from must be on or before to";
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) return `The date range can be at most ${MAX_RANGE_DAYS} days`;
  const f: ReportFilters = { tenantId, from, to };
  if (q.device && ["mobile", "tablet", "desktop"].includes(q.device)) f.device = q.device as ReportFilters["device"];
  if (q.country && /^[A-Za-z]{2}$/.test(q.country)) f.country = q.country.toUpperCase();
  if (q.audience === "guest" || q.audience === "customer") f.audience = q.audience;
  return f;
}

// India-time day boundaries as timestamps.
const startOf = (day: string) => `${day}T00:00:00+05:30`;
const endOf = (day: string) => new Date(Date.parse(`${day}T00:00:00+05:30`) + 86_400_000).toISOString();

function searchWhere(f: ReportFilters, alias = "se"): SQL {
  const a = sql.raw(alias);
  const parts: SQL[] = [
    sql`${a}.tenant_id = ${f.tenantId}`,
    sql`${a}.first_seen_at >= ${startOf(f.from)}::timestamptz`,
    sql`${a}.first_seen_at < ${endOf(f.to)}::timestamptz`,
  ];
  if (f.device) parts.push(sql`${a}.device = ${f.device}`);
  if (f.country) parts.push(sql`${a}.country = ${f.country}`);
  if (f.audience === "guest") parts.push(sql`${a}.user_id IS NULL`);
  if (f.audience === "customer") parts.push(sql`${a}.user_id IS NOT NULL`);
  return sql.join(parts, sql` AND `);
}

const PAID = (b: string) => sql.raw(`(${b}.status IN ('CONFIRMED','TICKETED','REISSUED','CANCELLED','REFUND_PENDING','REFUNDED')
  AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = ${b}.id AND p.status IN ('SUCCESS','PARTIAL_REFUND','REFUNDED')))`);
const WINDOW = sql.raw(`interval '${ABANDON_WINDOW_HOURS} hours'`);

/**
 * Every search in the filter with its status and the booking it led to (own link first, else a
 * booking by the same visitor / customer for the same route + date within the window).
 */
function classified(f: ReportFilters): SQL {
  return sql`
    WITH se AS (SELECT * FROM search_events se WHERE ${searchWhere(f)}),
    c AS (
      SELECT se.*,
        COALESCE(se.visitor_hash, 'u:' || se.user_id, 'anon:' || se.id) AS who,
        ob.id AS own_id, (ob.id IS NOT NULL AND ${PAID("ob")}) AS own_paid,
        alt.id AS alt_id, COALESCE(alt.paid, false) AS alt_paid
      FROM se
      LEFT JOIN bookings ob ON ob.id = se.booking_id AND ob.tenant_id = se.tenant_id
      LEFT JOIN LATERAL (
        SELECT b.id, ${PAID("b")} AS paid FROM bookings b
        WHERE b.tenant_id = se.tenant_id AND b.id IS DISTINCT FROM se.booking_id
          AND b.origin = se.origin AND b.destination = se.destination
          AND (b.departure_date AT TIME ZONE 'UTC')::date = se.departure_date
          AND b.created_at >= se.first_seen_at - interval '1 hour' AND b.created_at < se.last_seen_at + ${WINDOW}
          AND ((se.user_id IS NOT NULL AND b.user_id = se.user_id)
            OR (se.visitor_hash IS NOT NULL AND EXISTS (
              SELECT 1 FROM search_events s2 WHERE s2.tenant_id = se.tenant_id AND s2.booking_id = b.id AND s2.visitor_hash = se.visitor_hash)))
        ORDER BY 2 DESC, b.created_at LIMIT 1
      ) alt ON true
    ),
    k AS (
      SELECT c.*,
        CASE WHEN c.own_paid THEN c.own_id WHEN c.alt_paid THEN c.alt_id END AS paid_booking_id,
        COALESCE(c.own_id, c.alt_id) AS any_booking_id,
        CASE
          WHEN c.outcome <> 'RESULTS' THEN 'NO_AVAILABILITY'
          WHEN c.own_paid OR c.alt_paid THEN 'BOOKED'
          WHEN c.own_id IS NOT NULL OR c.alt_id IS NOT NULL THEN 'CHECKOUT_UNPAID'
          WHEN c.last_seen_at > now() - ${WINDOW} THEN 'IN_PROGRESS'
          ELSE 'ABANDONED'
        END AS status
      FROM c
    )`;
}

const n = (v: unknown) => Number(v ?? 0);

// ── Overview ──────────────────────────────────────────────────────────────────────

export async function overview(db: Db, f: ReportFilters) {
  const visitorWhere: SQL[] = [sql`tenant_id = ${f.tenantId}`, sql`day >= ${f.from}::date`, sql`day <= ${f.to}::date`];
  if (f.device) visitorWhere.push(sql`device = ${f.device}`);
  if (f.country) visitorWhere.push(sql`country = ${f.country}`);
  if (f.audience === "guest") visitorWhere.push(sql`user_id IS NULL`);
  if (f.audience === "customer") visitorWhere.push(sql`user_id IS NOT NULL`);
  const [v] = await rowsOf<{ visitors: string }>(db, sql`SELECT count(DISTINCT visitor_hash) AS visitors FROM site_visits WHERE ${sql.join(visitorWhere, sql` AND `)}`);
  const [s] = await rowsOf<Record<string, string>>(db, sql`${classified(f)}
    SELECT count(*) AS searches, count(DISTINCT who) AS searchers,
      count(*) FILTER (WHERE status = 'NO_AVAILABILITY') AS no_availability,
      count(*) FILTER (WHERE fare_selected_at IS NOT NULL) AS fare_selected,
      count(DISTINCT any_booking_id) AS bookings_created,
      count(DISTINCT paid_booking_id) AS paid_bookings,
      count(*) FILTER (WHERE status = 'ABANDONED') AS abandoned,
      count(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
      count(*) FILTER (WHERE status = 'BOOKED') AS booked_searches
    FROM k`);
  const searches = n(s?.searches);
  const paid = n(s?.paid_bookings);
  return {
    visitors: n(v?.visitors),
    searches, searchers: n(s?.searchers), noAvailability: n(s?.no_availability), fareSelected: n(s?.fare_selected),
    bookingsCreated: n(s?.bookings_created), paidBookings: paid, abandonedSearches: n(s?.abandoned), inProgress: n(s?.in_progress),
    bookedSearches: n(s?.booked_searches),
    conversionPct: searches ? Math.round((paid / searches) * 10_000) / 100 : 0,
    website: await websiteBookings(db, f),
  };
}

/** All website bookings created in the range (from the bookings table, tracked or not). */
export async function websiteBookings(db: Db, f: ReportFilters) {
  const rows = await rowsOf<Record<string, string>>(db, sql`
    SELECT b.currency,
      count(*) AS created,
      count(*) FILTER (WHERE ${PAID("b")}) AS paid,
      COALESCE(sum(b.total_amount) FILTER (WHERE ${PAID("b")} AND b.status IN ('CONFIRMED','TICKETED','REISSUED')), 0) AS revenue,
      COALESCE(sum(b.markup) FILTER (WHERE ${PAID("b")} AND b.status IN ('CONFIRMED','TICKETED','REISSUED')), 0) AS markup,
      count(*) FILTER (WHERE ${PAID("b")} AND b.status IN ('CANCELLED','REFUND_PENDING','REFUNDED')) AS cancelled_after_payment
    FROM bookings b
    WHERE b.tenant_id = ${f.tenantId} AND b.channel = 'B2C_WEB'
      AND b.created_at >= ${startOf(f.from)}::timestamptz AND b.created_at < ${endOf(f.to)}::timestamptz
    GROUP BY b.currency ORDER BY b.currency`);
  const abandoned = await abandonedCheckouts(db, f, { countOnly: true }) as number;
  return {
    byCurrency: rows.map((r) => ({ currency: r.currency, created: n(r.created), paid: n(r.paid), revenue: n(r.revenue), markup: n(r.markup), cancelledAfterPayment: n(r.cancelled_after_payment) })),
    abandonedCheckouts: abandoned,
  };
}

// ── Trends ────────────────────────────────────────────────────────────────────────

export async function trend(db: Db, f: ReportFilters, interval: "day" | "week" | "month") {
  const unit = sql.raw(`'${interval}'`);
  const searches = await rowsOf<Record<string, string>>(db, sql`${classified(f)}
    SELECT to_char(date_trunc(${unit}, first_seen_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS period,
      count(*) AS searches, count(DISTINCT who) AS searchers, count(DISTINCT paid_booking_id) AS paid_bookings,
      count(*) FILTER (WHERE status = 'ABANDONED') AS abandoned
    FROM k GROUP BY 1 ORDER BY 1`);
  const visitors = await rowsOf<Record<string, string>>(db, sql`
    SELECT to_char(date_trunc(${unit}, day::timestamp), 'YYYY-MM-DD') AS period, count(DISTINCT visitor_hash) AS visitors
    FROM site_visits WHERE tenant_id = ${f.tenantId} AND day >= ${f.from}::date AND day <= ${f.to}::date GROUP BY 1 ORDER BY 1`);
  const byPeriod = new Map<string, { period: string; visitors: number; searches: number; searchers: number; paidBookings: number; abandoned: number }>();
  const row = (p: string) => byPeriod.get(p) ?? byPeriod.set(p, { period: p, visitors: 0, searches: 0, searchers: 0, paidBookings: 0, abandoned: 0 }).get(p)!;
  for (const r of visitors) row(r.period).visitors = n(r.visitors);
  for (const r of searches) Object.assign(row(r.period), { searches: n(r.searches), searchers: n(r.searchers), paidBookings: n(r.paid_bookings), abandoned: n(r.abandoned) });
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

// ── Sectors / airports / dates ───────────────────────────────────────────────────

export async function sectors(db: Db, f: ReportFilters) {
  const rows = await rowsOf<Record<string, string>>(db, sql`${classified(f)}
    SELECT origin, destination, count(*) AS searches, count(DISTINCT who) AS searchers,
      count(*) FILTER (WHERE fare_selected_at IS NOT NULL) AS fare_selected,
      count(DISTINCT any_booking_id) AS bookings_created, count(DISTINCT paid_booking_id) AS paid_bookings,
      count(*) FILTER (WHERE status = 'ABANDONED') AS abandoned,
      count(*) FILTER (WHERE status = 'NO_AVAILABILITY') AS no_availability,
      round(avg(lowest_fare) FILTER (WHERE currency = 'INR')) AS avg_lowest_inr,
      min(lowest_fare) FILTER (WHERE currency = 'INR') AS min_lowest_inr
    FROM k GROUP BY origin, destination ORDER BY count(*) DESC, origin, destination`);
  const revenue = await rowsOf<Record<string, string>>(db, sql`${classified(f)}
    SELECT x.origin, x.destination, b.currency, sum(b.total_amount) AS revenue
    FROM (SELECT DISTINCT origin, destination, paid_booking_id FROM k WHERE paid_booking_id IS NOT NULL) x
    JOIN bookings b ON b.id = x.paid_booking_id
    WHERE b.status IN ('CONFIRMED','TICKETED','REISSUED')
    GROUP BY 1, 2, 3`);
  // Every paid website booking on the route in the range (tracked or not, e.g. before tracking started).
  const allBookings = await rowsOf<Record<string, string>>(db, sql`
    SELECT b.origin, b.destination, count(*) AS paid FROM bookings b
    WHERE b.tenant_id = ${f.tenantId} AND b.channel = 'B2C_WEB' AND ${PAID("b")}
      AND b.created_at >= ${startOf(f.from)}::timestamptz AND b.created_at < ${endOf(f.to)}::timestamptz
    GROUP BY 1, 2`);
  const rev = new Map<string, Record<string, number>>();
  for (const r of revenue) {
    const key = `${r.origin}-${r.destination}`;
    rev.set(key, { ...(rev.get(key) ?? {}), [r.currency]: n(r.revenue) });
  }
  const all = new Map(allBookings.map((r) => [`${r.origin.trim()}-${r.destination.trim()}`, n(r.paid)]));
  return rows.map((r) => {
    const key = `${r.origin.trim()}-${r.destination.trim()}`;
    const searches = n(r.searches), paid = n(r.paid_bookings);
    return {
      origin: r.origin.trim(), destination: r.destination.trim(), searches, searchers: n(r.searchers), fareSelected: n(r.fare_selected),
      bookingsCreated: n(r.bookings_created), paidBookings: paid, abandoned: n(r.abandoned), noAvailability: n(r.no_availability),
      conversionPct: searches ? Math.round((paid / searches) * 10_000) / 100 : 0,
      revenue: rev.get(key) ?? {}, avgLowestInr: r.avg_lowest_inr === null ? null : n(r.avg_lowest_inr),
      minLowestInr: r.min_lowest_inr === null ? null : n(r.min_lowest_inr),
      websitePaidBookings: all.get(key) ?? 0,
    };
  });
}

export async function airports(db: Db, f: ReportFilters) {
  const q = (col: "origin" | "destination") => rowsOf<Record<string, string>>(db, sql`${classified(f)}
    SELECT ${sql.raw(col)} AS airport, count(*) AS searches, count(DISTINCT who) AS searchers, count(DISTINCT paid_booking_id) AS paid_bookings
    FROM k GROUP BY 1 ORDER BY count(*) DESC, 1`);
  const shape = (rows: Record<string, string>[]) => rows.map((r) => ({ airport: r.airport.trim(), searches: n(r.searches), searchers: n(r.searchers), paidBookings: n(r.paid_bookings) }));
  return { departures: shape(await q("origin")), destinations: shape(await q("destination")) };
}

export async function travelDates(db: Db, f: ReportFilters) {
  const dates = await rowsOf<Record<string, string>>(db, sql`${classified(f)}
    SELECT to_char(departure_date, 'YYYY-MM-DD') AS departure_date, count(*) AS searches, count(DISTINCT who) AS searchers,
      count(DISTINCT paid_booking_id) AS paid_bookings, round(avg(lowest_fare) FILTER (WHERE currency = 'INR')) AS avg_lowest_inr
    FROM k GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 500`);
  const leadTime = await rowsOf<Record<string, string>>(db, sql`${classified(f)}
    SELECT CASE
        WHEN d <= 3 THEN '0-3 days' WHEN d <= 7 THEN '4-7 days' WHEN d <= 14 THEN '8-14 days'
        WHEN d <= 30 THEN '15-30 days' WHEN d <= 60 THEN '31-60 days' ELSE '61+ days' END AS bucket,
      min(d) AS sort, count(*) AS searches, count(DISTINCT paid_booking_id) AS paid_bookings
    FROM (SELECT k.*, GREATEST(0, departure_date - (first_seen_at AT TIME ZONE 'Asia/Kolkata')::date) AS d FROM k) x
    GROUP BY 1 ORDER BY 2`);
  return {
    dates: dates.map((r) => ({ departureDate: r.departure_date, searches: n(r.searches), searchers: n(r.searchers), paidBookings: n(r.paid_bookings), avgLowestInr: r.avg_lowest_inr === null ? null : n(r.avg_lowest_inr) })),
    leadTime: leadTime.map((r) => ({ bucket: r.bucket, searches: n(r.searches), paidBookings: n(r.paid_bookings) })),
  };
}

// ── Search history ────────────────────────────────────────────────────────────────

export const SEARCH_STATUSES = ["BOOKED", "CHECKOUT_UNPAID", "IN_PROGRESS", "ABANDONED", "NO_AVAILABILITY"] as const;

export async function searchHistory(db: Db, f: ReportFilters, opts: { status?: string; origin?: string; destination?: string; page?: number; limit?: number; customers: boolean }) {
  const where: SQL[] = [sql`true`];
  if (opts.status && (SEARCH_STATUSES as readonly string[]).includes(opts.status)) where.push(sql`k.status = ${opts.status}`);
  if (opts.origin && /^[A-Z]{3}$/.test(opts.origin)) where.push(sql`k.origin = ${opts.origin}`);
  if (opts.destination && /^[A-Z]{3}$/.test(opts.destination)) where.push(sql`k.destination = ${opts.destination}`);
  const limit = Math.min(opts.limit ?? PAGE_SIZE, MAX_EXPORT_ROWS);
  const offset = Math.max(0, ((opts.page ?? 1) - 1) * limit);
  const customer = opts.customers ? sql`, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone` : sql``;
  const rows = await rowsOf<Record<string, unknown>>(db, sql`${classified(f)}
    SELECT k.id, k.first_seen_at, k.last_seen_at, k.repeat_count, k.trip_type, k.origin, k.destination,
      to_char(k.departure_date, 'YYYY-MM-DD') AS departure_date, to_char(k.return_date, 'YYYY-MM-DD') AS return_date, k.legs,
      k.adults, k.children, k.infants, k.cabin_class, k.fare_type, k.outcome, k.result_count, k.lowest_fare, k.currency,
      k.device, k.country, k.status, k.fare_selected_at, k.any_booking_id AS booking_id, k.paid_booking_id,
      (k.user_id IS NOT NULL) AS signed_in, left(k.visitor_hash, 8) AS visitor ${customer}
    FROM k ${opts.customers ? sql`LEFT JOIN users u ON u.id = k.user_id AND u.tenant_id = k.tenant_id` : sql``}
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY k.first_seen_at DESC, k.id
    LIMIT ${limit + 1} OFFSET ${offset}`);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

// ── Abandoned checkouts ──────────────────────────────────────────────────────────

export async function abandonedCheckouts(db: Db, f: ReportFilters, opts: { customers?: boolean; countOnly?: boolean; page?: number; limit?: number } = {}) {
  const base = sql`
    FROM bookings b
    WHERE b.tenant_id = ${f.tenantId} AND b.channel = 'B2C_WEB'
      AND b.created_at >= ${startOf(f.from)}::timestamptz AND b.created_at < ${endOf(f.to)}::timestamptz
      AND b.created_at < now() - ${WINDOW}
      AND NOT ${PAID("b")}
      AND b.status IN ('HELD','PAYMENT_PENDING','PAYMENT_FAILED','CANCELLED')
      AND NOT EXISTS (
        SELECT 1 FROM bookings b2
        WHERE b2.tenant_id = b.tenant_id AND b2.id <> b.id AND b2.created_at > b.created_at
          AND b2.origin = b.origin AND b2.destination = b.destination
          AND (b2.departure_date AT TIME ZONE 'UTC')::date = (b.departure_date AT TIME ZONE 'UTC')::date
          AND ((b.user_id IS NOT NULL AND b2.user_id = b.user_id)
            OR (b.contact_email IS NOT NULL AND lower(b2.contact_email) = lower(b.contact_email))
            OR (b.contact_phone IS NOT NULL AND b2.contact_phone = b.contact_phone))
          AND ${PAID("b2")})`;
  if (opts.countOnly) {
    const [r] = await rowsOf<{ n: string }>(db, sql`SELECT count(*) AS n ${base}`);
    return n(r?.n);
  }
  const limit = Math.min(opts.limit ?? PAGE_SIZE, MAX_EXPORT_ROWS);
  const offset = Math.max(0, ((opts.page ?? 1) - 1) * limit);
  const contact = opts.customers ? sql`, b.contact_email, b.contact_phone, u.name AS customer_name` : sql``;
  const rows = await rowsOf<Record<string, unknown>>(db, sql`
    SELECT b.id AS booking_id, b.created_at, b.status, b.trip_type, b.origin, b.destination,
      to_char(b.departure_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS departure_date,
      b.adult_count, b.child_count, b.infant_count, b.total_amount, b.currency, b.supplier,
      (b.user_id IS NOT NULL) AS signed_in,
      (SELECT se.id FROM search_events se WHERE se.booking_id = b.id AND se.tenant_id = b.tenant_id LIMIT 1) AS search_event_id
      ${contact}
    FROM (SELECT b.* ${base}) b
    ${opts.customers ? sql`LEFT JOIN users u ON u.id = b.user_id AND u.tenant_id = b.tenant_id` : sql``}
    ORDER BY b.created_at DESC, b.id
    LIMIT ${limit + 1} OFFSET ${offset}`);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

// ── Revenue ───────────────────────────────────────────────────────────────────────

export async function revenue(db: Db, f: ReportFilters, interval: "day" | "week" | "month") {
  const unit = sql.raw(`'${interval}'`);
  const byPeriod = await rowsOf<Record<string, string>>(db, sql`
    SELECT to_char(date_trunc(${unit}, b.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS period, b.currency,
      count(*) AS paid_bookings,
      COALESCE(sum(b.total_amount) FILTER (WHERE b.status IN ('CONFIRMED','TICKETED','REISSUED')), 0) AS revenue,
      COALESCE(sum(b.markup) FILTER (WHERE b.status IN ('CONFIRMED','TICKETED','REISSUED')), 0) AS markup,
      count(*) FILTER (WHERE b.status IN ('CANCELLED','REFUND_PENDING','REFUNDED')) AS cancelled_after_payment,
      COALESCE(sum(b.refunded), 0) AS refunded
    FROM (
      SELECT b.*, (SELECT COALESCE(sum(p.refunded_amount), 0) FROM payments p WHERE p.booking_id = b.id) AS refunded
      FROM bookings b
      WHERE b.tenant_id = ${f.tenantId} AND b.channel = 'B2C_WEB' AND ${PAID("b")}
        AND b.created_at >= ${startOf(f.from)}::timestamptz AND b.created_at < ${endOf(f.to)}::timestamptz
    ) b
    GROUP BY 1, 2 ORDER BY 1, 2`);
  const bySector = await rowsOf<Record<string, string>>(db, sql`
    SELECT b.origin, b.destination, b.currency, count(*) AS paid_bookings,
      COALESCE(sum(b.total_amount) FILTER (WHERE b.status IN ('CONFIRMED','TICKETED','REISSUED')), 0) AS revenue
    FROM bookings b
    WHERE b.tenant_id = ${f.tenantId} AND b.channel = 'B2C_WEB' AND ${PAID("b")}
      AND b.created_at >= ${startOf(f.from)}::timestamptz AND b.created_at < ${endOf(f.to)}::timestamptz
    GROUP BY 1, 2, 3 ORDER BY 5 DESC, 4 DESC`);
  return {
    byPeriod: byPeriod.map((r) => ({ period: r.period, currency: r.currency, paidBookings: n(r.paid_bookings), revenue: n(r.revenue), markup: n(r.markup), cancelledAfterPayment: n(r.cancelled_after_payment), refunded: n(r.refunded) })),
    bySector: bySector.map((r) => ({ origin: r.origin.trim(), destination: r.destination.trim(), currency: r.currency, paidBookings: n(r.paid_bookings), revenue: n(r.revenue) })),
  };
}

// ── CSV ───────────────────────────────────────────────────────────────────────────

/** RFC 4180 CSV; cells that a spreadsheet would run as a formula are prefixed with '. */
export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(","))].join("\r\n") + "\r\n";
}
