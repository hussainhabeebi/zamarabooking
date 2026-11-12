// Special Group Fares in flight search results (GET /api/group-fares/match: uncached, only fares
// on sale with seats for this party). A failure here never affects the live results.
export interface SearchGroupFare {
  id: string; title: string; airline: string; airlineName: string; flightNumber: string;
  origin: string; destination: string; travelDate: string; departureTime: string; arrivalTime: string; arrivalDayOffset: number;
  stops: number; cabinClass: string; baggage: { checked: string; cabin: string }; isRefundable: boolean;
  seatsLeft: number; minPax: number; maxPax: number | null; saleEndsAt: string | null; pricePerAdult: number | null;
  quote: {
    pax: { adults: number; children: number; infants: number }; total: number; currency: "INR"; problem: string | null;
    book: { fareId: string; supplier: string; airline: string; fn: string; from: string; to: string; dep: string; arr: string;
      dur: number; stops: number; bag: string; cab: string; ref: boolean; cls: string; fl: string };
  };
}

export async function fetchGroupFares(q: { origin?: string; destination?: string; departureDate?: string; adults: number; children: number; infants: number }): Promise<{ ok: boolean; fares: SearchGroupFare[] }> {
  if (!q.origin || !q.destination || !q.departureDate) return { ok: false, fares: [] };
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.zamrabooking.com";
    const qs = new URLSearchParams({ origin: q.origin, destination: q.destination, date: q.departureDate, adults: String(q.adults), children: String(q.children), infants: String(q.infants) });
    const res = await fetch(`${apiUrl}/api/group-fares/match?${qs}`, { headers: { "x-tenant-slug": "zamra" }, cache: "no-store", signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return { ok: false, fares: [] };
    const d = await res.json() as { fares?: SearchGroupFare[] };
    return { ok: true, fares: Array.isArray(d.fares) ? d.fares : [] };
  } catch {
    return { ok: false, fares: [] };
  }
}

const norm = (v: unknown) => String(v ?? "").toUpperCase().replace(/[\s-]+/g, "");

// The live result for the same flight (airline + flight number), if any.
export function sameFlight(g: SearchGroupFare, fare: any): boolean {
  if (norm(fare?.airline) !== norm(g.airline)) return false;
  const numbers = [fare?.flightNumber, ...(Array.isArray(fare?.segments) ? fare.segments.map((s: any) => s?.flightNumber) : [])].map(norm).filter(Boolean);
  const want = norm(g.flightNumber);
  // "6E1475" and "1475" both name 6E 1475.
  return numbers.some((n) => n === want || `${norm(g.airline)}${n}` === want || n === `${norm(g.airline)}${want}`);
}

export function groupFareBookUrl(g: SearchGroupFare) {
  const b = g.quote.book;
  const p = new URLSearchParams({
    fareId: b.fareId, supplier: b.supplier, adults: String(g.quote.pax.adults), children: String(g.quote.pax.children), infants: String(g.quote.pax.infants),
    airline: b.airline, fn: b.fn, from: b.from, to: b.to, dep: b.dep, arr: b.arr, dur: String(b.dur), stops: String(b.stops),
    price: String(g.quote.total), cur: "INR", ref: b.ref ? "1" : "0", bag: b.bag, cab: b.cab, cls: b.cls, fl: b.fl,
  });
  return `/book?${p.toString()}`;
}

export function groupFareDetailsUrl(g: SearchGroupFare) {
  const p = g.quote.pax;
  return `/group-fares/${g.id}?adults=${p.adults}&children=${p.children}&infants=${p.infants}`;
}
