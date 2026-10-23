import type { NormalizedFare, SearchParams, SupplierAdapter } from "../base.js";
import { AkbarClient, AkbarError, record, text } from "./client.js";
import { AkbarOfferStore, type AkbarOffer } from "./offers.js";

const cabins = {
  ECONOMY: "E",
  PREMIUM_ECONOMY: "PE",
  BUSINESS: "B",
  FIRST: "F",
} as const;
const cabinNames: Record<string, string> = {
  E: "ECONOMY",
  PE: "PREMIUM_ECONOMY",
  B: "BUSINESS",
  F: "FIRST",
};
export const money = (v: unknown) => {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < 0 ||
    !Number.isSafeInteger(Math.round(v * 100))
  )
    throw new AkbarError("INVALID_RESPONSE");
  return v;
};
export const array = (v: unknown): any[] => {
  if (!Array.isArray(v) || v.length > 500)
    throw new AkbarError("INVALID_RESPONSE");
  return v;
};
export function minutes(v: unknown): number {
  const match = /^(\d{1,3})h\s*(\d{1,2})m\s*$/.exec(text(v));
  if (!match || Number(match[2]) > 59) throw new AkbarError("INVALID_RESPONSE");
  return Number(match[1]) * 60 + Number(match[2]);
}
export function airport(v: unknown) {
  const s = text(v);
  if (!/^[A-Z]{3}$/.test(s)) throw new AkbarError("INVALID_RESPONSE");
  return s;
}
export function dateTime(v: unknown) {
  const s = text(v);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)?$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s.slice(0, 10)).toISOString().slice(0, 10) !== s.slice(0, 10) ||
    Number(s.slice(11, 13)) > 23 ||
    Number(s.slice(14, 16)) > 59 ||
    Number(s.slice(17, 19)) > 59
  )
    throw new AkbarError("INVALID_RESPONSE");
  return s;
}
export function akbarSearchBody(
  p: SearchParams,
  multiCityFareType?: "IM" | "DM",
) {
  if (p.legs && p.tripType !== "MULTICITY") throw new AkbarError("UNSUPPORTED");
  if (
    !["ONEWAY", "ROUNDTRIP", "MULTICITY"].includes(p.tripType) ||
    !cabins[p.cabinClass] ||
    p.currency !== "INR" ||
    (p.fareType && p.fareType !== "REGULAR")
  )
    throw new AkbarError("UNSUPPORTED");
  if (
    ![p.adults, p.children, p.infants].every(Number.isInteger) ||
    p.adults < 1 ||
    p.children < 0 ||
    p.infants < 0 ||
    p.infants > p.adults ||
    p.adults + p.children > 9
  )
    throw new AkbarError("INVALID_REQUEST");
  const trip = (from: string, to: string, date: string) => {
    if (
      !Number.isFinite(Date.parse(date)) ||
      !/^[A-Z]{3}$/.test(from) ||
      !/^[A-Z]{3}$/.test(to) ||
      from === to ||
      !/^\d{4}-\d\d-\d\d$/.test(date) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new AkbarError("INVALID_REQUEST");
    return { From: from, To: to, OnwardDate: date, TUI: "" };
  };
  let Trips: Array<Record<string, unknown>>;
  if (p.tripType === "MULTICITY") {
    if (!multiCityFareType || !p.legs || p.legs.length < 2 || p.legs.length > 6)
      throw new AkbarError("UNSUPPORTED");
    Trips = p.legs.map((l) => trip(l.origin, l.destination, l.date));
  } else {
    const t: Record<string, unknown> = trip(
      p.origin,
      p.destination,
      p.departureDate,
    );
    if (p.tripType === "ROUNDTRIP") {
      if (!p.returnDate || p.returnDate < p.departureDate)
        throw new AkbarError("INVALID_REQUEST");
      trip(p.destination, p.origin, p.returnDate);
      t.ReturnDate = p.returnDate;
    }
    Trips = [t];
  }
  return {
    ADT: p.adults,
    CHD: p.children,
    INF: p.infants,
    Cabin: cabins[p.cabinClass],
    Source: "CF",
    Mode: "AS",
    TUI: "",
    FareType:
      p.tripType === "ONEWAY"
        ? "ON"
        : p.tripType === "ROUNDTRIP"
          ? "RT"
          : multiCityFareType,
    Trips,
    Parameters: {
      Airlines: "",
      GroupType: "",
      Refundable: "",
      IsDirect: false,
      IsStudentFare: false,
      IsNearbyAirport: false,
    },
  };
}

export interface AkbarAvailability {
  reference: string;
  expiresInSeconds: number;
  leg: number;
  airline: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  totalFare: number;
  currency: "INR";
  isBookable: false;
}
export interface AkbarMockContract {
  /** WRC does not establish snapshot vs delta semantics. No default. */
  partialResults?: "snapshot" | "incremental";
  /** Fixtures only until provider resolves OrderID and segment fare aggregation. */
  pricing?: { fixtureOnly: true; orderIds: number[]; segmentTotals: true };
}
export interface AkbarAdapterOptions {
  mode: "mock";
  contract?: AkbarMockContract;
  budgetMs?: number;
  pollMs?: number;
  offers?: AkbarOfferStore;
  now?: () => number;
}
export class AkbarAdapter implements SupplierAdapter {
  readonly name = "AKBAR" as const;
  private readonly offers: AkbarOfferStore;
  private readonly now: () => number;
  constructor(
    private readonly client: AkbarClient,
    private readonly options: AkbarAdapterOptions = { mode: "mock" },
  ) {
    if (options.mode !== "mock") throw new AkbarError("DISABLED");
    for (const n of [options.budgetMs ?? 20000, options.pollMs ?? 250])
      if (!Number.isFinite(n) || n < 0) throw new AkbarError("INVALID_REQUEST");
    this.now = options.now ?? Date.now;
    this.offers = options.offers ?? new AkbarOfferStore(this.now);
  }
  /** Shared public search interface is deliberately unavailable in this milestone. */
  async search(_p: SearchParams): Promise<NormalizedFare[]> {
    throw new AkbarError("DISABLED");
  }
  private deadline() {
    return (
      this.now() + Math.min(45000, Math.max(10, this.options.budgetMs ?? 20000))
    );
  }
  async searchAvailability(params: SearchParams): Promise<AkbarAvailability[]> {
    if (params.tripType === "MULTICITY") throw new AkbarError("UNSUPPORTED");
    const p = structuredClone(params),
      body = akbarSearchBody(p),
      deadline = this.deadline();
    const start = await this.client.call("ExpressSearch", body, deadline),
      tui = text(start.TUI);
    const legs = p.tripType === "ROUNDTRIP" ? 2 : 1;
    let rows = new Map<string, { j: Record<string, any>; leg: number }>(),
      completed = false;
    for (let poll = 0; poll < 50; poll++) {
      const d = await this.client.call("GetExpSearch", { TUI: tui }, deadline);
      if (
        d.TUI !== tui ||
        ![true, false, "True", "False", "true", "false"].includes(
          d.Completed,
        ) ||
        d.CurrencyCode !== "INR"
      )
        throw new AkbarError("INVALID_RESPONSE");
      completed =
        d.Completed === true || String(d.Completed).toLowerCase() === "true";
      if (!completed && !this.options.contract?.partialResults)
        throw new AkbarError("PENDING_UNVERIFIED");
      if (this.options.contract?.partialResults !== "incremental")
        rows = new Map();
      const trips = array(d.Trips);
      if (trips.length && trips.length !== legs)
        throw new AkbarError("INVALID_RESPONSE");
      for (const [leg, t] of trips.entries())
        for (const item of array(record(t).Journey)) {
          const j = record(item);
          this.validateAvailability(j, p, leg);
          const key = `${leg}:${text(j.Provider)}:${text(j.Index)}`;
          if (rows.size >= 500 && !rows.has(key))
            throw new AkbarError("CAPACITY");
          rows.set(key, { j, leg });
        }
      if (completed) break;
      if (poll === 49 || this.now() >= deadline)
        throw new AkbarError("TIMEOUT");
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(
            this.options.pollMs ?? 250,
            Math.max(0, deadline - this.now()),
          ),
        ),
      );
    }
    if (!completed || this.now() >= deadline) throw new AkbarError("TIMEOUT");
    const owner = await this.client.scopeKey();
    const ids: string[] = [];
    try {
      return Array.from(rows.values()).map(({ j, leg }) => {
        const reference = this.offers.put(owner, {
          leg,
          tui,
          index: text(j.Index),
          provider: text(j.Provider),
          net: money(j.NetFare),
          gross: money(j.GrossFare),
          baggage:
            typeof j.Inclusions?.Baggage === "string"
              ? text(j.Inclusions.Baggage)
              : "",
          params: p,
        });
        ids.push(reference);
        return {
          reference,
          expiresInSeconds: 300,
          leg,
          airline: text(j.MAC),
          flightNumber: text(j.FlightNo).trim(),
          origin: airport(j.From),
          destination: airport(j.To),
          departureTime: dateTime(j.DepartureTime),
          arrivalTime: dateTime(j.ArrivalTime),
          totalFare: money(j.GrossFare),
          currency: "INR",
          isBookable: false,
        } as const;
      });
    } catch (error) {
      ids.forEach((id) => this.offers.remove(owner, id));
      throw error;
    }
  }
  private validateAvailability(
    j: Record<string, any>,
    p: SearchParams,
    leg: number,
  ) {
    const origin = leg === 0 ? p.origin : p.destination,
      destination = leg === 0 ? p.destination : p.origin;
    const date = leg === 0 ? p.departureDate : p.returnDate;
    if (
      airport(j.From) !== origin ||
      airport(j.To) !== destination ||
      dateTime(j.DepartureTime).slice(0, 10) !== date ||
      j.Cabin !== cabins[p.cabinClass]
    )
      throw new AkbarError("INVALID_RESPONSE");
    dateTime(j.ArrivalTime);
    money(j.GrossFare);
    money(j.NetFare);
    text(j.MAC);
    text(j.Provider);
    text(j.Index);
    text(j.FlightNo);
    if (j.ReturnIdentifier && j.ReturnIdentifier !== 0)
      throw new AkbarError("UNSUPPORTED");
  }
  async priceSelectedOffers(references: string[]): Promise<NormalizedFare> {
    const contract = this.options.contract?.pricing;
    if (!contract?.fixtureOnly || !contract.segmentTotals)
      throw new AkbarError("DISABLED");
    if (
      !Array.isArray(references) ||
      references.length < 1 ||
      references.length > 2 ||
      new Set(references).size !== references.length
    )
      throw new AkbarError("INVALID_REQUEST");
    const owner = await this.client.scopeKey(),
      offers = references
        .map((id) => this.offers.read(owner, id))
        .sort((a, b) => a.leg - b.leg);
    const p = offers[0].params,
      legs = p.tripType === "ROUNDTRIP" ? 2 : 1;
    if (
      offers.length !== legs ||
      offers.some(
        (o, i) =>
          o.leg !== i ||
          o.tui !== offers[0].tui ||
          JSON.stringify(o.params) !== JSON.stringify(p),
      )
    )
      throw new AkbarError("INVALID_REQUEST");
    if (
      contract.orderIds.length !== legs ||
      !contract.orderIds.every((n) => Number.isInteger(n) && n >= 0)
    )
      throw new AkbarError("DISABLED");
    const deadline = this.deadline();
    try {
      const pricer = await this.client.call(
        "SmartPricer",
        {
          Trips: offers.map((o, i) => ({
            Amount: o.net,
            Index: o.index,
            OrderID: contract.orderIds[i],
            TUI: o.tui,
          })),
          Mode: "AS",
          Options: "A",
          Source: "SF",
          TripType: p.tripType === "ROUNDTRIP" ? "RT" : "ON",
        },
        deadline,
      );
      if (!pricer.TUI) throw new AkbarError("PENDING_UNVERIFIED");
      const tui = text(pricer.TUI),
        d = await this.client.call("GetSPricer", { TUI: tui }, deadline);
      if (!d.Trips) throw new AkbarError("PENDING_UNVERIFIED");
      // Expiration is checked again after potentially slow pricing.
      references.forEach((id) => this.offers.read(owner, id));
      return normalizeAkbarItinerary(d, references.join(":"), offers, tui);
    } catch (error) {
      if (
        error instanceof AkbarError &&
        ["FARE_CHANGED", "INVALID_RESPONSE"].includes(error.code)
      )
        references.forEach((id) => this.offers.remove(owner, id));
      throw error;
    }
  }
}

/** Only enabled by the explicit fixture-only segment-totals contract. */
export function normalizeAkbarItinerary(
  input: unknown,
  id: string,
  offers: AkbarOffer[],
  pricingTui: string,
): NormalizedFare {
  const d = record(input),
    p = offers[0]?.params;
  if (
    !p ||
    (d.Code !== "200" && d.Code !== 200) ||
    d.TUI !== pricingTui ||
    d.CurrencyCode !== "INR" ||
    d.ADT !== p.adults ||
    d.CHD !== p.children ||
    d.INF !== p.infants ||
    d.FareType !== (p.tripType === "ROUNDTRIP" ? "RT" : "ON")
  )
    throw new AkbarError("INVALID_RESPONSE");
  const trips = array(d.Trips);
  if (trips.length !== offers.length) throw new AkbarError("INVALID_RESPONSE");
  const segments: NonNullable<NormalizedFare["segments"]> = [],
    stopDetails: NormalizedFare["stopDetails"] = [];
  let base = 0,
    taxes = 0,
    duration = 0,
    stops = 0;
  let refundable = true;
  let fareClass = "";
  for (const [leg, t] of trips.entries()) {
    const journeys = array(record(t).Journey);
    if (journeys.length !== 1) throw new AkbarError("INVALID_RESPONSE");
    const j = record(journeys[0]);
    if (j.Provider !== offers[leg].provider)
      throw new AkbarError("INVALID_RESPONSE");
    const ss = array(j.Segments);
    if (!ss.length || ss.length > 12) throw new AkbarError("INVALID_RESPONSE");
    duration += minutes(j.Duration);
    if (
      (typeof j.Stops !== "number" && typeof j.Stops !== "string") ||
      !/^\d+$/.test(String(j.Stops))
    )
      throw new AkbarError("INVALID_RESPONSE");
    const count = Number(j.Stops);
    if (!Number.isInteger(count) || count < 0 || count > 12)
      throw new AkbarError("INVALID_RESPONSE");
    stops += count;
    const fs = ss.map((s) => record(record(s).Flight));
    const expectedFrom = leg === 0 ? p.origin : p.destination,
      expectedTo = leg === 0 ? p.destination : p.origin,
      date = leg === 0 ? p.departureDate : p.returnDate;
    if (
      airport(fs[0].DepartureCode) !== expectedFrom ||
      airport(fs.at(-1)!.ArrivalCode) !== expectedTo ||
      dateTime(fs[0].DepartureTime).slice(0, 10) !== date
    )
      throw new AkbarError("INVALID_RESPONSE");
    for (const [i, f] of fs.entries()) {
      if (
        f.Cabin !== cabins[p.cabinClass] ||
        !["Y", "N"].includes(f.Refundable) ||
        !/^[A-Z0-9]{2}$/.test(text(f.MAC))
      )
        throw new AkbarError("INVALID_RESPONSE");
      if (leg === 0 && i === 0) fareClass = text(f.FareClass);
      const dep = dateTime(f.DepartureTime),
        arr = dateTime(f.ArrivalTime);
      const hasOffset = (s: string) => /Z$|[+-]\d\d:\d\d$/.test(s);
      // Offsetless provider values are preserved as airport-local, never silently converted to UTC.
      if (
        hasOffset(dep) !== hasOffset(arr) ||
        (hasOffset(dep) && Date.parse(arr) <= Date.parse(dep))
      )
        throw new AkbarError("INVALID_RESPONSE");
      if (i && airport(fs[i - 1].ArrivalCode) !== airport(f.DepartureCode))
        throw new AkbarError("INVALID_RESPONSE");
      if (i) {
        const a = dateTime(fs[i - 1].ArrivalTime),
          gap = (Date.parse(dep) - Date.parse(a)) / 60000;
        if (!Number.isFinite(gap) || gap < 0 || gap > 2880)
          throw new AkbarError("INVALID_RESPONSE");
        stopDetails.push({
          airport: airport(f.DepartureCode),
          arrivalTime: a,
          departureTime: dep,
          layoverMinutes: gap,
        });
      }
      const fare = record(record(ss[i]).Fares);
      base += money(fare.TotalBaseFare);
      taxes += money(fare.TotalTax);
      refundable &&= f.Refundable === "Y";
      segments.push({
        airline: text(f.MAC),
        airlineName: text(f.Airline).split("|")[0],
        flightNumber: `${f.MAC}${text(f.FlightNo).trim()}`,
        origin: airport(f.DepartureCode),
        destination: airport(f.ArrivalCode),
        departureTime: dep,
        arrivalTime: arr,
        duration: minutes(f.Duration),
        isReturn: leg === 1,
      });
    }
  }
  const total = money(d.GrossAmount),
    expected = offers.reduce((n, o) => n + o.gross, 0);
  if (Math.abs(total - expected) > 0.01) throw new AkbarError("FARE_CHANGED");
  if (base + taxes > total + 0.01) throw new AkbarError("INVALID_RESPONSE");
  const outward = segments.filter((s) => !s.isReturn),
    first = segments[0];
  const baggage = [
    ...new Set(offers.map((o) => o.baggage || "Not provided")),
  ].join(" / ");
  // SSR descriptions are retained verbatim with PTC/FUID; comma-separated text is
  // not guessed to mean checked/cabin allowances or applied across every passenger.
  const descriptions =
    d.SSR === undefined
      ? []
      : array(d.SSR)
          .filter((s) => record(s).Code === "BAG")
          .map((s) => {
            const r = record(s);
            return {
              category: "Baggage",
              description: `${text(r.PTC)} / ${text(r.FUID)}: ${text(r.Description)}`,
            };
          });
  return {
    id,
    supplier: "AKBAR",
    isBookable: false,
    airline: first.airline,
    airlineName: first.airlineName,
    flightNumber: segments.map((s) => s.flightNumber).join("/"),
    origin: first.origin,
    destination: outward.at(-1)!.destination,
    departureTime: first.departureTime,
    arrivalTime: outward.at(-1)!.arrivalTime,
    duration,
    stops,
    stopDetails,
    cabinClass: p.cabinClass,
    baseFare: base,
    taxes,
    totalFare: total,
    currency: "INR",
    isRefundable: refundable,
    baggage: { checked: baggage, cabin: "Not provided" },
    fareClass,
    segments,
    tripKey: offers.length === 2 ? "COMBO" : "ONWARD",
    legIndex: 0,
    fareRules: descriptions,
    raw: {
      mock: true,
      chargesAndMarkup: Math.round((total - base - taxes) * 100) / 100,
      baggageSource: "availability-unverified",
      pricingCertified: false,
    },
  };
}
