import type { NormalizedFare, SearchParams, StopDetail, SupplierAdapter, SupplierCredentials } from "../base.js";
import { AkbarClient, AkbarError, searchTui, type AkbarCredentials, type AkbarToken } from "./client.js";

// Akbar Travels search for Zamra's flight results. Like Poomas, Akbar fares are
// sold on Zamra and ticketed by staff on Akbar's portal (one-way only) until the
// CreateItinerary booking flow is built. The price is Akbar's NetFare: what Akbar
// charges Zamra, before Zamra's markup.
//
// Credentials: the AkbarCredentials fields, plus getToken (the API's 48-hour token cache).

type Raw = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const first = (o: Raw, keys: string[]) => keys.map((k) => o[k]).find((v) => v != null && v !== "");

// "02h 10m", "2h10m", "130" or 130 → minutes.
export function akbarDurationMinutes(v: unknown): number {
  if (typeof v === "number") return Math.max(0, Math.round(v));
  const s = str(v).toLowerCase();
  const hm = s.match(/(\d+)\s*h(?:rs?)?\s*(?:(\d+)\s*m)?/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] ?? 0);
  const m = s.match(/^(\d+)\s*m?$/);
  return m ? Number(m[1]) : 0;
}

const minutesBetween = (a: string, b: string) => {
  const d = (Date.parse(b) - Date.parse(a)) / 60000;
  return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
};

const CABIN: Record<string, string> = { E: "ECONOMY", PE: "PREMIUM_ECONOMY", B: "BUSINESS", F: "FIRST" };
const yes = (v: unknown) => v === true || ["y", "yes", "true", "1", "refundable"].includes(str(v).toLowerCase());

// The flights of a search response: Trips[n].Journey[], one array per trip (0 = onward).
export function akbarJourneys(data: unknown, trip = 0): Raw[] {
  const trips = (data as Raw | null)?.Trips;
  if (!Array.isArray(trips)) return [];
  const journeys = (trips[trip] as Raw | undefined)?.Journey;
  return Array.isArray(journeys) ? journeys.filter((j): j is Raw => !!j && typeof j === "object") : [];
}

// One Akbar journey → a Zamra fare. null when a field Zamra needs is missing.
export function normalizeAkbarJourney(j: Raw, tui: string, cabinClass: string): NormalizedFare | null {
  const index         = str(j.Index);
  const origin        = str(first(j, ["From", "Origin"])).toUpperCase();
  const destination   = str(first(j, ["To", "Destination"])).toUpperCase();
  const departureTime = str(first(j, ["DepartureTime", "DepartureDate"]));
  const arrivalTime   = str(first(j, ["ArrivalTime", "ArrivalDate"]));
  const airline       = str(first(j, ["VAC", "MAC", "OAC", "Provider", "AirlineCode"])).toUpperCase();
  const netFare       = num(first(j, ["NetFare", "TotalFare", "GrossFare"]));
  if (!index || !/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || !departureTime || !arrivalTime || !airline || netFare <= 0) return null;

  // "IndiGo|IndiGo|IndiGo" → "IndiGo"
  const airlineName  = str(j.AirlineName).split("|").find(Boolean) || airline;
  // "6E 2101", "6E-2101" or "2101" → "2101"
  const flightNumber = str(j.FlightNo).replace(new RegExp(`^${airline}[\\s-]*`, "i"), "").replace(/\s+/g, "");
  const connections  = Array.isArray(j.Connections) ? (j.Connections as Raw[]) : [];
  const stops        = j.Stops != null && j.Stops !== "" ? num(j.Stops) : connections.length;
  const stopDetails: StopDetail[] = connections.map((c) => ({
    airport:        str(first(c, ["Airport", "From", "To"])).toUpperCase(),
    arrivalTime:    str(c.ArrivalTime),
    departureTime:  str(c.DepartureTime),
    layoverMinutes: akbarDurationMinutes(first(c, ["Duration", "LayoverTime"])),
  }));
  const duration   = akbarDurationMinutes(j.Duration) || minutesBetween(departureTime, arrivalTime);
  const gross      = num(j.GrossFare);
  const inclusions = (j.Inclusions && typeof j.Inclusions === "object" ? j.Inclusions : {}) as Raw;
  const seats      = num(j.Seats);

  return {
    id:            `AK|${tui}|${index}`,
    supplier:      "AKBAR",
    isBookable:    false,
    airline,
    airlineName,
    flightNumber,
    origin,
    destination,
    departureTime,
    arrivalTime,
    duration,
    stops,
    stopDetails,
    cabinClass:    CABIN[str(j.Cabin).toUpperCase()] ?? cabinClass,
    baseFare:      netFare,
    taxes:         0,
    totalFare:     netFare,
    currency:      "INR",
    isRefundable:  yes(j.Refundable),
    baggage:       { cabin: str(inclusions.Cabin) || "As per airline", checked: str(inclusions.Baggage) || "As per airline" },
    fareClass:     str(first(j, ["RBD", "FareClass"])),
    ...(seats > 0 ? { seatsLeft: seats } : {}),
    ...(str(j.FCType) ? { fareIdentifier: str(j.FCType) } : {}),
    raw:           { tui, index, orderId: j.OrderID ?? null, provider: str(j.Provider), grossFare: gross || null, netFare },
  };
}

export function normalizeAkbarSearch(data: unknown, cabinClass: string): NormalizedFare[] {
  const tui = searchTui(data);
  return akbarJourneys(data, 0)
    .filter((j) => !(num(j.ReturnIdentifier) > 0))   // special-return halves only pair with a return
    .map((j) => normalizeAkbarJourney(j, tui, cabinClass))
    .filter((f): f is NormalizedFare => f !== null);
}

export class AkbarAdapter implements SupplierAdapter {
  readonly name = "AKBAR" as const;
  private client: AkbarClient;
  private getToken: (fresh?: boolean) => Promise<AkbarToken>;

  constructor(credentials: SupplierCredentials) {
    this.client = new AkbarClient(credentials as unknown as AkbarCredentials);
    const provided = credentials.getToken as ((fresh?: boolean) => Promise<AkbarToken>) | undefined;
    this.getToken = provided ?? (() => this.client.signature());
  }

  async search(params: SearchParams): Promise<NormalizedFare[]> {
    // Staff ticket each booking by hand, so only single one-way fares are offered.
    if (params.tripType !== "ONEWAY") return [];
    let token = await this.getToken();
    // Zamra's search waits 28 s for every source, so stop collecting Akbar results before then.
    const opts = { deadlineMs: 22_000 };
    const result = await this.client.search(params, token, opts).catch(async (err) => {
      // A cached token Akbar no longer accepts: get a new one and retry once.
      if (!(err instanceof AkbarError && err.statusCode === 401)) throw err;
      token = await this.getToken(true);
      return this.client.search(params, token, opts);
    });
    return normalizeAkbarSearch(result.data, params.cabinClass);
  }
}
