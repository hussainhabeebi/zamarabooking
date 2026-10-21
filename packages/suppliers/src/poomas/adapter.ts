import type {
  SupplierAdapter, SearchParams, NormalizedFare, SupplierCredentials,
} from "../base.js";

// Poomas (FlyPoomas) Partner API v1 — search only. Zamra sells these fares on its
// own site; after the customer pays, staff issue the ticket on Poomas and enter
// the PNR in Admin. The price is what Poomas charges Zamra (its displayPrice).
//
// Credentials: apiKey (pmsk_…, "search" scope) and baseUrl (https://api.flypoomas.com).

interface PoomasOffer extends Partial<NormalizedFare> {
  offerId:       string;
  displayPrice?: number;
}

interface PoomasSearchResponse {
  searchId?:  string;
  expiresAt?: string;
  offers?:    PoomasOffer[];
}

export class PoomasError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly endpoint?: string, readonly responseSnippet?: string) {
    super(message);
    this.name = "PoomasError";
  }
}

export class PoomasAdapter implements SupplierAdapter {
  readonly name = "POOMAS" as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(credentials: SupplierCredentials) {
    this.apiKey  = (credentials.apiKey as string) || "";
    this.baseUrl = ((credentials.baseUrl as string) || "https://api.flypoomas.com").replace(/\/+$/, "");
  }

  async search(params: SearchParams): Promise<NormalizedFare[]> {
    if (!this.apiKey) throw new PoomasError("Poomas: API key not configured");
    // Staff ticket each booking by hand, so only single one-way fares are offered.
    if (params.tripType !== "ONEWAY") return [];

    const endpoint = "/api/partner/v1/search";
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: params.origin, destination: params.destination, departureDate: params.departureDate,
        adults: params.adults, children: params.children, infants: params.infants,
        cabinClass: params.cabinClass, tripType: "ONEWAY", currency: params.currency,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new PoomasError(`Poomas search failed (HTTP ${res.status})`, res.status, endpoint, text.slice(0, 500));
    }
    let data: PoomasSearchResponse;
    try { data = JSON.parse(text) as PoomasSearchResponse; }
    catch { throw new PoomasError("Poomas returned a response that is not JSON", res.status, endpoint, text.slice(0, 500)); }

    return (data.offers ?? [])
      .filter((o) => o.offerId && o.isBookable !== false && !o.tripKey)
      .map((o) => normalizePoomasOffer(o, data.expiresAt));
  }
}

export function normalizePoomasOffer(o: PoomasOffer, expiresAt?: string): NormalizedFare {
  // What Poomas charges Zamra for the whole party (its own markup included).
  const total = Number(o.displayPrice ?? o.totalFare ?? 0);
  const supplierTotal = Number(o.totalFare ?? total) || total;
  const ratio = supplierTotal > 0 ? total / supplierTotal : 1;
  const baseFare = Math.round(Number(o.baseFare ?? total) * ratio * 100) / 100;
  return {
    id:            o.offerId,
    supplier:      "POOMAS",
    isBookable:    true,
    airline:       o.airline ?? "",
    airlineName:   o.airlineName ?? o.airline ?? "",
    flightNumber:  o.flightNumber ?? "",
    origin:        o.origin ?? "",
    destination:   o.destination ?? "",
    departureTime: o.departureTime ?? "",
    arrivalTime:   o.arrivalTime ?? "",
    duration:      Number(o.duration ?? 0),
    stops:         Number(o.stops ?? 0),
    stopDetails:   o.stopDetails ?? [],
    cabinClass:    o.cabinClass ?? "ECONOMY",
    baseFare,
    taxes:         Math.round((total - baseFare) * 100) / 100,
    totalFare:     total,
    ...(o.perAdultFare ? { perAdultFare: Math.round(o.perAdultFare * ratio * 100) / 100 } : {}),
    currency:      o.currency ?? "INR",
    isRefundable:  Boolean(o.isRefundable),
    baggage:       o.baggage ?? { cabin: "As per airline", checked: "As per airline" },
    fareClass:     o.fareClass ?? "",
    ...(o.seatsLeft != null ? { seatsLeft: o.seatsLeft } : {}),
    ...(o.fareIdentifier ? { fareIdentifier: o.fareIdentifier } : {}),
    ...(o.segments ? { segments: o.segments } : {}),
    raw:           { offerId: o.offerId, expiresAt, poomasSupplier: o.supplier },
  };
}
