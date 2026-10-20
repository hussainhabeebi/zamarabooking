// "Hold now, pay later": TripJack books the seats without payment (ON_HOLD) when
// the review says the fare can be held (conditions.isBA). The customer pays
// before the airline's time limit; payment then calls confirm-book instead of
// book (see queue-consumer). Nothing is charged for the hold itself.

// Hold time limit as TripJack reports it (the field name varies by response);
// only a future date-time counts.
export function findHoldDeadline(raw: unknown, now = Date.now(), depth = 0): Date | null {
  if (!raw || typeof raw !== "object" || depth > 8) return null;
  let best: Date | null = null;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    let found: Date | null = null;
    if (/time.?limit|hold.?(time|till|until|expir)|ttl|ticketing.?deadline|holdtl/i.test(key) && (typeof value === "string" || typeof value === "number")) {
      const d = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
      if (!Number.isNaN(d.getTime()) && d.getTime() > now) found = d;
    } else if (value && typeof value === "object") {
      found = findHoldDeadline(value, now, depth + 1);
    }
    if (found && (!best || found < best)) best = found;
  }
  return best;
}

// When TripJack gives no time limit, assume a short one: 3 hours, and never
// later than 6 hours before departure.
export function fallbackHoldDeadline(departure: Date, now = Date.now()): Date {
  const latest = departure.getTime() - 6 * 3600_000;
  return new Date(Math.max(now + 30 * 60_000, Math.min(now + 3 * 3600_000, latest)));
}

export function holdLabel(until: Date, timeZone = "Asia/Kolkata") {
  return until.toLocaleString("en-IN", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}
