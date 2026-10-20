import type {
  SupplierAdapter, SearchParams, NormalizedFare, SupplierCredentials,
} from "../base.js";

// Google Flights SERP API — search only, never bookable.
// Always returns isBookable: false. Any conversion to booking goes via human agent.
export class SerpAdapter implements SupplierAdapter {
  readonly name = "GOOGLE_SERP" as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(credentials: SupplierCredentials) {
    this.apiKey  = (credentials.apiKey  as string) || "";
    this.baseUrl = (credentials.baseUrl as string) || "https://serpapi.com";
  }

  async search(params: SearchParams): Promise<NormalizedFare[]> {
    if (!this.apiKey) throw new Error("SERP: apiKey not configured");

    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("engine",        "google_flights");
    url.searchParams.set("departure_id",  params.origin);
    url.searchParams.set("arrival_id",    params.destination);
    url.searchParams.set("outbound_date", params.departureDate);

    // SerpAPI defaults to round-trip (type=1). One-way searches must explicitly
    // send type=2 or requests without return_date can come back empty/error.
    if (params.tripType === "ONEWAY") {
      url.searchParams.set("type", "2");
    } else if (params.tripType === "ROUNDTRIP") {
      url.searchParams.set("type", "1");
      if (!params.returnDate) throw new Error("SERP: returnDate required for ROUNDTRIP");
      url.searchParams.set("return_date", params.returnDate);
    } else {
      throw new Error("SERP: MULTICITY search is not supported by this adapter yet");
    }

    url.searchParams.set("adults",        String(params.adults));
    if (params.children > 0) url.searchParams.set("children", String(params.children));
    if (params.infants > 0) url.searchParams.set("infants_on_lap", String(params.infants));
    url.searchParams.set("travel_class",  this.mapCabin(params.cabinClass));
    url.searchParams.set("currency",      params.currency);
    url.searchParams.set("api_key",       this.apiKey);
    url.searchParams.set("no_cache",      "false");

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`SERP ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json() as {
      best_flights?: unknown[];
      other_flights?: unknown[];
      error?: string;
    };

    if (data.error) throw new Error(`SERP: ${data.error}`);

    const flights = [...(data.best_flights ?? []), ...(data.other_flights ?? [])];
    return flights.slice(0, 15).map((f) => this.normalizeSerpFare(
      f as Record<string, unknown>,
      params.currency,
      params.origin,
      params.destination,
      params.cabinClass,
    ));
  }

  private normalizeSerpFare(
    f: Record<string, unknown>,
    currency: string,
    origin: string,
    destination: string,
    cabinClass: string,
  ): NormalizedFare {
    const segments   = (f.flights as Record<string, unknown>[]) ?? [];
    const firstLeg   = segments[0] ?? {};
    const lastLeg    = segments[segments.length - 1] ?? firstLeg;
    const depAirport = (firstLeg.departure_airport as Record<string, string>) ?? {};
    const arrAirport = (lastLeg.arrival_airport as Record<string, string>) ?? {};

    return {
      id:            `serp_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      supplier:      "GOOGLE_SERP",
      isBookable:    false,
      airline:       (firstLeg.airline as string) ?? "",
      airlineName:   (firstLeg.airline as string) ?? "",
      flightNumber:  (firstLeg.flight_number as string) ?? "",
      origin:        depAirport.id ?? origin,
      destination:   arrAirport.id ?? destination,
      departureTime: (depAirport.time ?? "").replace(" ", "T"),
      arrivalTime:   (arrAirport.time ?? "").replace(" ", "T"),
      duration:      (f.total_duration as number) ?? 0,
      stops:         Math.max(0, segments.length - 1),
      stopDetails:   [],
      cabinClass:    cabinClass as NormalizedFare["cabinClass"],
      baseFare:      (f.price as number) ?? 0,
      taxes:         0,
      totalFare:     (f.price as number) ?? 0,
      currency,
      isRefundable:  false,
      baggage:       { cabin: "7 KG", checked: "Not included" },
      fareClass:     "",
      raw:           f,
    };
  }

  private mapCabin(cabin: string): string {
    const map: Record<string, string> = {
      ECONOMY:         "1",
      PREMIUM_ECONOMY: "2",
      BUSINESS:        "3",
      FIRST:           "4",
    };
    return map[cabin] ?? "1";
  }
}
