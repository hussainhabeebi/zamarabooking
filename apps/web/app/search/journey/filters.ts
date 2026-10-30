import { stopCount } from "../../lib/stops";

type Fare = { airlineName: string; stops: number; stopsUnknown?: boolean; stopDetails?: {airport?: string; layoverMinutes?: number}[]; departureTime: string; duration: number; totalFare: number; displayPrice?: number; isRefundable: boolean; baggage?: {checked?: string}; tripKey?: string; segments?: {airlineName: string; origin: string; destination: string; departureTime: string; arrivalTime: string; isReturn?: boolean}[] };
export function filterJourneyFares<T extends Fare>(fares: T[], q: URLSearchParams, routes: {origin:string; destination:string}[] = []): T[] {
  const airlines = (q.get("airlines") ?? "").split(",").filter(Boolean);
  const list = fares.filter(f => {
    const segments = f.segments ?? [];
    // Use the requested route boundaries, never infer connections from dates.
    const legs: typeof segments[] = [];
    let routeIndex = 0;
    for (const segment of segments) {
      if (!legs[routeIndex]) legs[routeIndex] = [];
      legs[routeIndex].push(segment);
      if (routes[routeIndex] && segment.destination === routes[routeIndex].destination) routeIndex++;
    }
    // Stops per leg: a combined (COMBO) fare must match on every leg of the journey.
    // Unknown stop counts never match a stops filter.
    const stops: (number|null)[] = f.tripKey === "COMBO" && legs.length ? legs.map(l=>l.length-1) : [stopCount(f)];
    const want = q.get("stops");
    if (want && stops.some(n=>n === null || (want === "2" ? n < 2 : n !== Number(want)))) return false;
    if (q.get("refundable") === "1" && !f.isRefundable) return false;
    if (q.get("baggage") === "1" && (!f.baggage?.checked || /^(0\s*(kg|kgs)?|nil|none|not included)$/i.test(f.baggage.checked.trim()))) return false;
    if (airlines.length && ![f.airlineName,...segments.map(s=>s.airlineName)].every(name=>airlines.includes(name))) return false;
    if (q.get("depBand")) {
      const [start,end] = q.get("depBand")!.split("–").map(Number);
      const departures = f.tripKey === "COMBO" && legs.length ? legs.map(l=>l[0].departureTime) : [f.departureTime];
      if (departures.some(date=>{const hour=Number(/T(\d{2}):/.exec(date)?.[1] ?? NaN);return !Number.isFinite(hour)||hour<start||hour>=end;})) return false;
    }
    return true;
  });
  return list.sort((a,b)=>q.get("sort") === "duration" ? a.duration-b.duration : q.get("sort") === "departure" ? a.departureTime.localeCompare(b.departureTime) : (a.displayPrice ?? a.totalFare)-(b.displayPrice ?? b.totalFare));
}
