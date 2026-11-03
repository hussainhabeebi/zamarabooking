import type { NormalizedFare, SearchParams, StopDetail, SupplierAdapter, SupplierCredentials } from "../base.js";
import { AkbarClient, AkbarError, searchTui, type AkbarCredentials, type AkbarToken } from "./client.js";
import { akbarWebSettings, type WebSettingsMap } from "./websettings.js";
import { akbarRoundTripJourneys, akbarSpecialFarePairs, type AkbarRoundTripFareType } from "./roundtrip.js";

// Akbar Travels search for Zamra's flight results. Like Poomas, Akbar fares are
// sold on Zamra and ticketed by staff on Akbar's portal until the CreateItinerary
// booking flow is built. Round trips and multi-city are searched one leg at a time
// with the one-way ExpressSearch, so every leg is a fare staff can ticket on its own. The price is Akbar's NetFare: what Akbar
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
  // Stops: Akbar's count, never fewer than the connections it lists. With neither
  // a numeric count nor a connection list the count is unknown, not non-stop.
  const declared     = j.Stops != null && j.Stops !== "" && Number.isFinite(Number(j.Stops)) ? Math.max(0, Math.round(Number(j.Stops))) : null;
  const stopsUnknown = declared === null && !Array.isArray(j.Connections);
  const stops        = Math.max(declared ?? 0, connections.length);
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
    isBookable:    true,
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
    ...(stopsUnknown ? { stopsUnknown: true } : {}),
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
    // carriers: validating / marketing / operating airline codes (WebSettings lists airline codes).
    raw:           { tui, index, orderId: j.OrderID ?? null, provider: str(j.Provider), grossFare: gross || null, netFare,
                     carriers: [...new Set([j.VAC, j.MAC, j.OAC].flatMap((c) => str(c).toUpperCase().split("|")).map((c) => c.trim()).filter(Boolean))] },
  };
}

export function normalizeAkbarSearch(data: unknown, cabinClass: string): NormalizedFare[] {
  const tui = searchTui(data);
  return akbarJourneys(data, 0)
    .filter((j) => !(num(j.ReturnIdentifier) > 0))   // special-return halves only pair with a return
    .map((j) => normalizeAkbarJourney(j, tui, cabinClass))
    .filter((f): f is NormalizedFare => f !== null);
}

// One RT / RS GetExpSearch response → ONWARD and RETURN fares of that one search.
//   • ids carry the side: in one round-trip search the onward and return lists share the TUI and
//     reuse the same Index ("SG|1", "SG|2001" on both sides), so `AK|<TUI>|<Index>` would collide.
//   • raw.fareType / side / returnIdentifier / vac link the two halves back to the search; the
//     booking prices both with one SmartPricer (OrderID 1 / 2) as one itinerary.
//   • RT: journeys with ReturnIdentifier 0; any onward may go with any return (Akbar: airlines and
//     providers may differ).
//   • RS: only journeys whose partner satisfies Akbar's pairing rule; marked SPECIAL_RETURN with
//     sri / msri = "<TUI>:<ReturnIdentifier>", so the journey page offers only the partner.
//   • A journey without a positive NetFare, an Index or the fields every fare needs is dropped.
export function normalizeAkbarRoundTrip(data: unknown, cabinClass: string, fareType: AkbarRoundTripFareType): NormalizedFare[] {
  const tui = searchTui(data);
  if (!tui) return [];
  const { onward, return: ret } = akbarRoundTripJourneys(data);
  const rid = (j: Raw) => num(j.ReturnIdentifier);
  const valid = (j: Raw) => str(j.Index) !== "" && num(j.NetFare) > 0;
  let pairs: { side: "ONWARD" | "RETURN"; j: Raw }[];
  if (fareType === "RT") {
    pairs = [...onward.filter((j) => rid(j) === 0 && valid(j)).map((j) => ({ side: "ONWARD" as const, j })),
             ...ret.filter((j) => rid(j) === 0 && valid(j)).map((j) => ({ side: "RETURN" as const, j }))];
  } else {
    const o = onward.filter(valid), r = ret.filter(valid);
    pairs = [...o.filter((x) => r.some((y) => akbarSpecialFarePairs(x, y))).map((j) => ({ side: "ONWARD" as const, j })),
             ...r.filter((y) => o.some((x) => akbarSpecialFarePairs(x, y))).map((j) => ({ side: "RETURN" as const, j }))];
  }
  return pairs.flatMap(({ side, j }) => {
    const f = normalizeAkbarJourney(j, tui, cabinClass);
    if (!f) return [];
    const key = `${tui}:${rid(j)}`;
    return [{
      ...f,
      id: `${f.id}|${side}`,
      tripKey: side,
      legIndex: side === "ONWARD" ? 0 : 1,
      ...(fareType === "RS" ? { fareIdentifier: "SPECIAL_RETURN", ...(side === "ONWARD" ? { sri: key } : { msri: [key] }) } : {}),
      raw: { ...(f.raw as Raw), fareType, side, returnIdentifier: rid(j), vac: str(j.VAC).toUpperCase(), orderId: side === "ONWARD" ? 1 : 2 },
    }];
  });
}

export class AkbarAdapter implements SupplierAdapter {
  readonly name = "AKBAR" as const;
  private client: AkbarClient;
  private getToken: (fresh?: boolean) => Promise<AkbarToken>;
  private mode: "SY" | "AS" = "SY";
  private roundTrip = false;

  constructor(credentials: SupplierCredentials) {
    this.client = new AkbarClient(credentials as unknown as AkbarCredentials);
    // API booking on (certification): Akbar's documented Mode AS → GetExpSearch sequence. A GetExpSearch
    // after a Mode SY ExpressSearch never answered on UAT (HTTP 504, then timeouts at 16.6 s and 28 s).
    // API booking off: Mode SY, unchanged.
    const { apiBooking } = credentials as { apiBooking?: unknown };
    if (apiBooking === "MANUAL" || apiBooking === "AUTO") this.mode = "AS";
    // Round trips in one RT / RS search (booked as one itinerary): Admin → Akbar → "Round-trip fares",
    // off by default, and only with API booking on (the fare must be priced with Akbar at checkout).
    this.roundTrip = this.mode === "AS" && (credentials as { roundTripFares?: unknown }).roundTripFares === "ON";
    const provided = credentials.getToken as ((fresh?: boolean) => Promise<AkbarToken>) | undefined;
    this.getToken = provided ?? (() => this.client.signature());
  }

  async search(params: SearchParams): Promise<NormalizedFare[]> {
    if (params.tripType === "ONEWAY") return this.searchLeg(params);
    if (this.roundTrip && params.tripType === "ROUNDTRIP" && params.returnDate && !params.legs?.length) {
      const fares = await this.searchRoundTrip(params).catch(() => null);
      if (fares?.length) return fares;
      // No RT / RS fares (or the search failed): the one-way searches, as before.
    }
    const legs = akbarJourneyLegs(params);
    if (legs.length < 2) return [];
    // One-way ExpressSearch per leg, all at once. Any failed leg fails the search with
    // Akbar's own error: a journey missing a leg can't be booked.
    const perLeg = await Promise.all(legs.map((leg) => this.searchLeg({
      ...params, tripType: "ONEWAY", origin: leg.origin, destination: leg.destination,
      departureDate: leg.date, returnDate: undefined, legs: undefined,
    })));
    return perLeg.flatMap((fares, i) => {
      const tripKey = akbarTripKey(params, i, legs.length);
      return fares.map((f) => ({ ...f, tripKey, legIndex: i }));
    });
  }

  // RT and RS searches at once (Akbar's samples); RS failing never fails RT.
  private async searchRoundTrip(params: SearchParams): Promise<NormalizedFare[]> {
    const started = Date.now();
    let token = await this.getToken();
    const run = (fareType: AkbarRoundTripFareType) => this.client.search(params, token, { deadlineMs: 22_000, fareType }).catch(async (err) => {
      if (!(err instanceof AkbarError && err.statusCode === 401)) throw err;
      token = await this.getToken(true);
      return this.client.search(params, token, { deadlineMs: 22_000, fareType });
    });
    const [rt, rs] = await Promise.all([run("RT"), run("RS").catch(() => null)]);
    const results = [{ r: rt, fareType: "RT" as const }, ...(rs ? [{ r: rs, fareType: "RS" as const }] : [])];
    const out: NormalizedFare[] = [];
    for (const { r, fareType } of results) {
      const fares = normalizeAkbarRoundTrip(r.data, params.cabinClass, fareType);
      const tui = r.tui || searchTui(r.data);
      const budget = Math.min(8_000, 26_000 - (Date.now() - started));
      const settings: WebSettingsMap | null = fares.length && tui && budget >= 1_000
        ? await this.client.webSettings(tui, token, budget).then(akbarWebSettings).catch(() => null) : null;
      out.push(...(settings ? fares.map((f) => ({ ...f, raw: { ...(f.raw as Record<string, unknown>), webSettings: settings } })) : fares));
    }
    // A round trip needs both directions.
    return out.some((f) => f.tripKey === "ONWARD") && out.some((f) => f.tripKey === "RETURN") ? out : [];
  }

  private async searchLeg(params: SearchParams): Promise<NormalizedFare[]> {
    const started = Date.now();
    let token = await this.getToken();
    // Zamra's search waits 28 s for every source, so stop collecting Akbar results before then.
    const opts = { deadlineMs: 22_000, mode: this.mode };
    const result = await this.client.search(params, token, opts).catch(async (err) => {
      // A cached token Akbar no longer accepts: get a new one and retry once.
      if (!(err instanceof AkbarError && err.statusCode === 401)) throw err;
      token = await this.getToken(true);
      return this.client.search(params, token, opts);
    });
    const fares = normalizeAkbarSearch(result.data, params.cabinClass);
    // API booking on (certification): WebSettings for this search's TUI, right after the search.
    // Its Settings (Key → Value, as Akbar sent them) ride on each fare (raw.webSettings) to the
    // booking, which works out SSR / SeatLayout for the fare's airline and sector. It never fails or
    // holds up the search: it gets what is left of the 26 s before Zamra's 28 s limit, at most 8 s.
    if (this.mode !== "AS" || !fares.length) return fares;
    const tui = result.tui || searchTui(result.data);   // ExpressSearch's response TUI
    const budget = Math.min(8_000, 26_000 - (Date.now() - started));
    if (!tui || budget < 1_000) return fares;
    const settings: WebSettingsMap | null = await this.client.webSettings(tui, token, budget).then(akbarWebSettings).catch(() => null);
    return settings ? fares.map((f) => ({ ...f, raw: { ...(f.raw as Record<string, unknown>), webSettings: settings } })) : fares;
  }
}

// The legs of a round trip / multi-city search: explicit legs, else out and back.
export function akbarJourneyLegs(params: SearchParams): { origin: string; destination: string; date: string }[] {
  if (params.legs?.length) return params.legs.slice(0, 6);
  if (params.tripType === "ROUNDTRIP" && params.returnDate) {
    return [
      { origin: params.origin, destination: params.destination, date: params.departureDate },
      { origin: params.destination, destination: params.origin, date: params.returnDate },
    ];
  }
  return [];
}

// Same leg keys the journey page uses for TripJack: ONWARD / RETURN, or "0".."5".
const akbarTripKey = (params: SearchParams, i: number, count: number) =>
  params.tripType === "ROUNDTRIP" && count === 2 ? (i === 0 ? "ONWARD" : "RETURN") : String(i);
