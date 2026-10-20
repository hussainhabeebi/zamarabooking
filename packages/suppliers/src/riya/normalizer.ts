import type { NormalizedFare } from "../base.js";

// Maps Riya API fare response shape → internal NormalizedFare
// Field names are placeholders — verify against actual Riya API docs during integration
export function normalizeRiyaFare(r: Record<string, unknown>): NormalizedFare {
  const seg = (r.Segments as Record<string, unknown>[])?.[0] ?? {};
  return {
    id:            r.FareId as string,
    supplier:      "RIYA",
    isBookable:    true,
    airline:       seg.AirlineCode as string,
    airlineName:   seg.AirlineName as string,
    flightNumber:  seg.FlightNumber as string,
    origin:        seg.Origin as string,
    destination:   seg.Destination as string,
    departureTime: seg.DepartureTime as string,
    arrivalTime:   seg.ArrivalTime as string,
    duration:      seg.DurationMinutes as number ?? 0,
    stops:         (r.Segments as unknown[]).length - 1,
    stopDetails:   [],  // Populated from stop segments
    cabinClass:    r.CabinClass as string,
    baseFare:      r.BaseFare as number,
    taxes:         r.Taxes as number,
    totalFare:     r.TotalFare as number,
    currency:      r.Currency as string,
    isRefundable:  r.IsRefundable as boolean ?? false,
    baggage: {
      cabin:   r.CabinBaggage as string ?? "7 KG",
      checked: r.CheckedBaggage as string ?? "15 KG",
    },
    fareClass: r.FareClass as string ?? "",
    seatsLeft: r.SeatsAvailable as number,
    raw:       r,
  };
}
