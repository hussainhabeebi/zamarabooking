// Group fares: manual fares (Admin → Manual fares, "Group fare" on) that Zamra sells from its own
// blocked seats. Listed on the website (/group-fares) when published and on sale, and in flight
// search like any manual fare. Booked through the offline MANUAL flow: the customer pays, staff
// issue the ticket and enter the PNR in Admin → Bookings. No supplier API is called.
//
// Seats (manual_fares.seats_available = seats still for sale):
//   checkout  → reserveGroupSeats: ONE conditional UPDATE … WHERE seats_available >= n, so two
//               checkouts can never take the same last seats; a HELD row records the booking.
//   payment   → confirmGroupSeats: HELD → SOLD (or, if the hold had already been released,
//               takes the seats again when they are still free; otherwise OVERSOLD for staff).
//   unpaid / cancelled → releaseGroupSeats gives the seats back (hourly cron, and before a
//               checkout is refused as sold out).
// Every step is a single SQL statement: the Neon HTTP driver has no interactive transactions.
// A booking keeps the fare and price it was sold at (bookings.flight_data.offline.fare).

import { sql } from "drizzle-orm";

// The checkout link lasts 20 minutes; the extra 10 cover a late payment confirmation.
export const GROUP_HOLD_MINUTES = 30;

type Exec = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> };
const rowsOf = async <T>(db: Exec, query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

export interface GroupFareFields {
  isGroupFare: boolean; isPublished: boolean; isActive: boolean;
  saleEndsAt: Date | string | null; travelDate: string; departureTime: string;
  minPax: number; maxPax: number | null; seatsAvailable: number;
}

// "YYYY-MM-DDTHH:MM" in India time (manual fare times are entered as local times).
const istNow = (now: Date) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 16);

// Published, active, sale not ended and not yet departed.
export function groupFareOnSale(row: GroupFareFields, now = new Date()): boolean {
  if (!row.isGroupFare || !row.isPublished || !row.isActive) return false;
  if (row.saleEndsAt && new Date(row.saleEndsAt).getTime() <= now.getTime()) return false;
  return `${row.travelDate}T${row.departureTime}` > istNow(now);
}

// Why this party can't book the group fare (null = it can). Infants travel on a lap: no seat.
export function groupFarePaxProblem(row: GroupFareFields, pax: { adults: number; children: number }, checkSeats = true): string | null {
  const seats = pax.adults + pax.children;
  if (seats < Math.max(1, row.minPax)) return `This group fare is for at least ${row.minPax} travellers (adults and children).`;
  if (row.maxPax != null && seats > row.maxPax) return `This group fare is for at most ${row.maxPax} travellers (adults and children).`;
  if (checkSeats && seats > row.seatsAvailable) return row.seatsAvailable > 0 ? `Only ${row.seatsAvailable} seat${row.seatsAvailable === 1 ? "" : "s"} left on this group fare.` : "This group fare is sold out.";
  return null;
}

export type ReserveResult = { ok: true; holdId: string; expiresAt: string } | { ok: false; seatsLeft: number | null };

// Takes `seats` seats for this booking, or nothing. The fare must still be a published, active
// group fare on sale with enough seats; the check and the decrement are one statement.
export async function reserveGroupSeats(db: Exec, p: { tenantId: string; fareId: string; bookingId: string; seats: number }): Promise<ReserveResult> {
  if (!Number.isInteger(p.seats) || p.seats < 1) throw new Error("seats must be a positive whole number");
  const attempt = () => rowsOf<{ id: string; expires_at: string | Date }>(db, sql`
    WITH taken AS (
      UPDATE manual_fares SET seats_available = seats_available - ${p.seats}, updated_at = now()
      WHERE id = ${p.fareId} AND tenant_id = ${p.tenantId}
        AND is_group_fare AND is_published AND is_active
        AND seats_available >= ${p.seats}
        AND (sale_ends_at IS NULL OR sale_ends_at > now())
      RETURNING id
    )
    INSERT INTO manual_fare_seat_holds (tenant_id, manual_fare_id, booking_id, seats, expires_at)
    SELECT ${p.tenantId}, id, ${p.bookingId}, ${p.seats}, now() + make_interval(mins => ${GROUP_HOLD_MINUTES})
    FROM taken
    RETURNING id, expires_at`);
  let rows = await attempt();
  if (!rows.length) {
    // Seats of unpaid checkouts that have run out may still be counted as taken.
    const freed = await releaseGroupSeats(db, { tenantId: p.tenantId, fareId: p.fareId });
    if (freed.holds > 0) rows = await attempt();
  }
  if (rows.length) return { ok: true, holdId: rows[0].id, expiresAt: new Date(rows[0].expires_at).toISOString() };
  const [left] = await rowsOf<{ seats_available: number }>(db, sql`
    SELECT seats_available FROM manual_fares WHERE id = ${p.fareId} AND tenant_id = ${p.tenantId}`);
  return { ok: false, seatsLeft: left ? Number(left.seats_available) : null };
}

// Gives back the seats of (a) holds whose booking was cancelled or refunded, and (b) unpaid holds
// past expires_at — never while the booking is paid / ticketed or a payment was started in the
// last 2 hours. Optional filters narrow it to one tenant, fare or booking.
export async function releaseGroupSeats(db: Exec, f: { tenantId?: string; fareId?: string; bookingId?: string } = {}): Promise<{ holds: number; fares: number }> {
  const [r] = await rowsOf<{ holds: number; fares: number }>(db, sql`
    WITH released AS (
      UPDATE manual_fare_seat_holds h
      SET status = 'RELEASED', released_at = now(), updated_at = now(),
          release_reason = COALESCE((SELECT CASE WHEN b.status IN ('CANCELLED', 'REFUNDED') THEN 'CANCELLED' ELSE 'EXPIRED' END
                                     FROM bookings b WHERE b.id = h.booking_id), 'BOOKING_NOT_SAVED')
      WHERE h.status IN ('HELD', 'SOLD')
        AND (${f.tenantId ?? null}::text IS NULL OR h.tenant_id = ${f.tenantId ?? null})
        AND (${f.fareId ?? null}::text IS NULL OR h.manual_fare_id = ${f.fareId ?? null})
        AND (${f.bookingId ?? null}::text IS NULL OR h.booking_id = ${f.bookingId ?? null})
        AND (
          EXISTS (SELECT 1 FROM bookings b WHERE b.id = h.booking_id AND b.status IN ('CANCELLED', 'REFUNDED'))
          OR (h.status = 'HELD' AND h.expires_at < now()
              AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = h.booking_id
                              AND b.status NOT IN ('SEARCHED', 'HELD', 'PAYMENT_PENDING', 'PAYMENT_FAILED'))
              AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = h.booking_id
                              AND (p.status = 'SUCCESS' OR (p.status = 'PENDING' AND p.created_at > now() - interval '2 hours'))))
        )
      RETURNING h.tenant_id, h.manual_fare_id, h.seats
    ), per_fare AS (
      SELECT tenant_id, manual_fare_id, SUM(seats)::int AS n FROM released GROUP BY tenant_id, manual_fare_id
    ), restored AS (
      UPDATE manual_fares m SET seats_available = m.seats_available + per_fare.n, updated_at = now()
      FROM per_fare WHERE m.id = per_fare.manual_fare_id AND m.tenant_id = per_fare.tenant_id
      RETURNING m.id
    )
    SELECT (SELECT count(*)::int FROM released) AS holds, (SELECT count(*)::int FROM restored) AS fares`);
  return { holds: Number(r?.holds ?? 0), fares: Number(r?.fares ?? 0) };
}

// Releases the hold of a booking that could not be saved (immediately, not at expiry).
export async function releaseUnsavedHold(db: Exec, tenantId: string, bookingId: string) {
  await rowsOf(db, sql`
    WITH released AS (
      UPDATE manual_fare_seat_holds SET status = 'RELEASED', released_at = now(), updated_at = now(), release_reason = 'BOOKING_NOT_SAVED'
      WHERE booking_id = ${bookingId} AND tenant_id = ${tenantId} AND status = 'HELD'
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = ${bookingId})
      RETURNING manual_fare_id, seats
    )
    UPDATE manual_fares m SET seats_available = m.seats_available + released.seats, updated_at = now()
    FROM released WHERE m.id = released.manual_fare_id AND m.tenant_id = ${tenantId}
    RETURNING m.id`);
}

export type ConfirmOutcome = "SOLD" | "ALREADY_SOLD" | "RETAKEN" | "OVERSOLD" | "NO_HOLD";

// On payment: the booking's seats become SOLD. When its hold had already been released (paid
// after it expired), the seats are taken again if still free — otherwise the hold is marked
// OVERSOLD and staff must resolve it (the payment is never undone here).
export async function confirmGroupSeats(db: Exec, tenantId: string, bookingId: string): Promise<ConfirmOutcome> {
  const sold = await rowsOf(db, sql`
    UPDATE manual_fare_seat_holds SET status = 'SOLD', sold_at = now(), updated_at = now()
    WHERE booking_id = ${bookingId} AND tenant_id = ${tenantId} AND status = 'HELD'
    RETURNING id`);
  if (sold.length) return "SOLD";
  const retaken = await rowsOf<{ status: string }>(db, sql`
    WITH h AS (
      SELECT manual_fare_id, seats FROM manual_fare_seat_holds
      WHERE booking_id = ${bookingId} AND tenant_id = ${tenantId} AND status = 'RELEASED'
      FOR UPDATE
    ), taken AS (
      UPDATE manual_fares m SET seats_available = m.seats_available - h.seats, updated_at = now()
      FROM h WHERE m.id = h.manual_fare_id AND m.tenant_id = ${tenantId} AND m.seats_available >= h.seats
      RETURNING m.id
    )
    UPDATE manual_fare_seat_holds
    SET status = CASE WHEN EXISTS (SELECT 1 FROM taken) THEN 'SOLD' ELSE 'OVERSOLD' END,
        sold_at = now(), released_at = NULL, release_reason = NULL, updated_at = now()
    WHERE booking_id = ${bookingId} AND tenant_id = ${tenantId} AND status = 'RELEASED'
    RETURNING status`);
  if (retaken.length) return retaken[0].status === "SOLD" ? "RETAKEN" : "OVERSOLD";
  const [hold] = await rowsOf<{ status: string }>(db, sql`
    SELECT status FROM manual_fare_seat_holds WHERE booking_id = ${bookingId} AND tenant_id = ${tenantId}`);
  return !hold ? "NO_HOLD" : hold.status === "OVERSOLD" ? "OVERSOLD" : "ALREADY_SOLD";
}

export interface GroupSeatStats { held: number; sold: number; oversold: number }

// Seats held (unpaid checkouts), sold and oversold per group fare, for Admin.
export async function groupSeatStats(db: Exec, tenantId: string, fareIds: string[]): Promise<Record<string, GroupSeatStats>> {
  if (!fareIds.length) return {};
  const rows = await rowsOf<{ manual_fare_id: string; held: number; sold: number; oversold: number }>(db, sql`
    SELECT manual_fare_id,
           COALESCE(SUM(seats) FILTER (WHERE status = 'HELD'), 0)::int     AS held,
           COALESCE(SUM(seats) FILTER (WHERE status = 'SOLD'), 0)::int     AS sold,
           COALESCE(SUM(seats) FILTER (WHERE status = 'OVERSOLD'), 0)::int AS oversold
    FROM manual_fare_seat_holds
    WHERE tenant_id = ${tenantId} AND manual_fare_id IN (${sql.join(fareIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY manual_fare_id`);
  return Object.fromEntries(rows.map((r) => [r.manual_fare_id, { held: Number(r.held), sold: Number(r.sold), oversold: Number(r.oversold) }]));
}

// Does this group fare have bookings (held, sold or oversold seats)? Such a fare is deactivated, never deleted.
export async function groupFareHasBookings(db: Exec, tenantId: string, fareId: string): Promise<boolean> {
  const rows = await rowsOf(db, sql`
    SELECT 1 FROM manual_fare_seat_holds WHERE tenant_id = ${tenantId} AND manual_fare_id = ${fareId}
      AND status IN ('HELD', 'SOLD', 'OVERSOLD') LIMIT 1`);
  return rows.length > 0;
}

// Admin form fields for a group fare (not sheet columns: group fares are managed in Admin only).
export interface GroupFareInput {
  isGroupFare: boolean; isPublished: boolean; title: string | null; description: string | null;
  saleEndsAt: Date | null; minPax: number; maxPax: number | null; seatsTotal: number | null;
}

const bool = (v: string) => ["yes", "y", "true", "1", "on"].includes(v.trim().toLowerCase());

// "2026-12-20T18:00" (India time, from the Admin date-time field) or a full ISO time.
function parseSaleEnd(v: string): Date | null | undefined {
  const s = v.trim();
  if (!s) return null;
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s);
  const d = new Date(local ? `${s.length === 16 ? `${s}:00` : s}+05:30` : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function validateGroupFareFields(get: (col: string) => string): GroupFareInput | string {
  if (!bool(get("group_fare"))) {
    return { isGroupFare: false, isPublished: false, title: null, description: null, saleEndsAt: null, minPax: 1, maxPax: null, seatsTotal: null };
  }
  const title = get("title").trim();
  if (!title) return "A group fare needs a title for the website";
  if (title.length > 120) return "title must be at most 120 characters";
  const description = get("description").trim();
  if (description.length > 2000) return "description must be at most 2000 characters";
  const saleEndsAt = parseSaleEnd(get("sale_ends_at"));
  if (saleEndsAt === undefined) return `sale_ends_at "${get("sale_ends_at")}" is not a date and time`;
  const int = (col: string, fallback: number | null, min: number, max: number) => {
    const raw = get(col).trim();
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const minPax = int("min_pax", 1, 1, 99), maxPax = int("max_pax", null, 1, 99), seatsTotal = int("seats_total", null, 1, 999);
  if (minPax === undefined || maxPax === undefined || seatsTotal === undefined) return "min_pax, max_pax and seats_total must be whole numbers (1 or more)";
  if (maxPax != null && maxPax < (minPax ?? 1)) return "max_pax can't be less than min_pax";
  return { isGroupFare: true, isPublished: bool(get("published")), title, description: description || null, saleEndsAt, minPax: minPax ?? 1, maxPax, seatsTotal };
}
