// Akbar round trips in one search: normal round trip (FareType "RT") and Round Trip Special
// Fare (FareType "RS").
//
// Source of truth: Akbar's sample payloads and Akbar support's reply (Nov 2026):
//   • RT  — ExpressSearch request / response, GetExpSearch request / response (BOM–DEL, SG);
//           SmartPricer request (6E onward + SG return: a normal RT may combine airlines / providers).
//   • RS  — ExpressSearch request / response, GetExpSearch request / response (BOM–DXB, SG);
//           SmartPricer request (two samples).
//   • "CreateItinerary, GetSPricer, StartPay, GetItineraryStatus and RetrieveBooking are the same for
//     round trip and onward booking"; SmartPricer gets the amount of each leg separately.
// GetExpSearch, both types: Trips[0].Journey = onward flights, Trips[1].Journey = return flights.
// RS: every Journey has ReturnIdentifier > 0, and each ReturnIdentifier appears once on each side.
// Normal RT journeys have ReturnIdentifier 0 and any onward goes with any return.
//
// Akbar's pairing rules for a Special Fare (onward + return become one fare) — all must hold:
//   both ReturnIdentifiers > 0; ONWARD.ReturnIdentifier = RETURN.ReturnIdentifier;
//   ONWARD.VAC = RETURN.VAC; ONWARD.Provider = RETURN.Provider. The Index values may differ.
//
// Both legs come from one search TUI and are priced together (one SmartPricer, OrderID 1 / 2), so
// they become ONE itinerary: one GetSPricer NetAmount, one CreateItinerary, one StartPay.

import type { SearchParams } from "../base.js";
import { akbarSector } from "./websettings.js";

type Raw = Record<string, unknown>;
export type AkbarRoundTripFareType = "RT" | "RS";

const CABIN: Record<SearchParams["cabinClass"], string> = { ECONOMY: "E", PREMIUM_ECONOMY: "PE", BUSINESS: "B", FIRST: "F" };

// ExpressSearch request for a round trip, field for field as in Akbar's RT / RS samples.
// SecType: "D" (domestic, RT sample BOM–DEL) / "I" (international, RS sample BOM–DXB); "" when
// the sector can't be told (Postman collection sample). preferedAirlines: [] is in the RS sample only.
export function akbarRoundTripSearchBody(params: SearchParams, clientId: string, fareType: AkbarRoundTripFareType, mode: "AS" | "SY" = "AS") {
  if (!params.returnDate) throw new Error("A round-trip search needs a return date");
  const sector = akbarSector(params.origin, params.destination);
  return {
    FareType: fareType,
    ADT: params.adults,
    YTH: 0,
    CHD: params.children,
    INF: params.infants,
    Cabin: CABIN[params.cabinClass] ?? "E",
    Source: "CF",
    Mode: mode,
    ClientID: clientId,
    MoreFltKey: "",
    ONFltNo: "",
    RTFltNo: "",
    IsMultipleCarrier: false,
    IsRefundable: false,
    ...(fareType === "RS" ? { preferedAirlines: [] as string[] } : {}),
    SecType: sector === "Dom" ? "D" : sector === "Int" ? "I" : "",
    TUI: "",
    Trips: [{
      From: params.origin.toUpperCase(),
      To: params.destination.toUpperCase(),
      OnwardDate: params.departureDate,
      ReturnDate: params.returnDate,
    }],
    Parameters: {
      IsDirect: false,
      IsNearbyAirport: false,
      IsStudentFare: false,
      IsSeniorCitizen: null,
      Airlines: "",
      IsGDSSearch: true,
      IsLCCSearch: true,
      Refundable: "",
    },
  };
}

const journeysOf = (data: unknown, trip: number): Raw[] => {
  const trips = (data as Raw | null)?.Trips;
  const list = Array.isArray(trips) ? (trips[trip] as Raw | undefined)?.Journey : undefined;
  return Array.isArray(list) ? list.filter((j): j is Raw => !!j && typeof j === "object") : [];
};

// Onward (Trips[0]) and return (Trips[1]) journeys of an RT / RS GetExpSearch response.
export function akbarRoundTripJourneys(data: unknown): { onward: Raw[]; return: Raw[] } {
  return { onward: journeysOf(data, 0), return: journeysOf(data, 1) };
}

const rid = (j: Raw) => { const n = Number(j.ReturnIdentifier); return Number.isFinite(n) ? n : 0; };
const code = (v: unknown) => String(v ?? "").trim().toUpperCase();

// Akbar's Special Fare rule: may this onward and this return journey be sold together?
export function akbarSpecialFarePairs(onward: Raw, ret: Raw): boolean {
  const r = rid(onward);
  return r > 0 && rid(ret) > 0 && r === rid(ret)
    && code(onward.VAC) !== "" && code(onward.VAC) === code(ret.VAC)
    && code(onward.Provider) !== "" && code(onward.Provider) === code(ret.Provider);
}

// Every onward + return Special Fare pair of an RS GetExpSearch response, onward order kept.
export function akbarSpecialFareCombinations(data: unknown): { onward: Raw; return: Raw }[] {
  const { onward, return: ret } = akbarRoundTripJourneys(data);
  const byRid = new Map<number, Raw[]>();
  for (const j of ret) if (rid(j) > 0) (byRid.get(rid(j)) ?? byRid.set(rid(j), []).get(rid(j))!).push(j);
  return onward.flatMap((o) => (byRid.get(rid(o)) ?? []).filter((r) => akbarSpecialFarePairs(o, r)).map((r) => ({ onward: o, return: r })));
}

export interface AkbarRoundTripPricerLeg { amount: number; index: string }

// SmartPricer request for a round trip, field for field as in Akbar's samples: one search TUI,
// OrderID 1 = onward, 2 = return, each leg's own amount, Mode "SS", Source "SF".
//   RT sample: ChannelCode null, ClientID = the agency ClientID, Options "A", TripType "RT".
//   RS sample: ChannelCode "", ClientID "", Options "", TripType "RS".
// Never sends a malformed request: every leg needs a positive amount and an Index, and the TUI is required.
export function akbarRoundTripPricerBody(legs: [AkbarRoundTripPricerLeg, AkbarRoundTripPricerLeg], searchTui: string, clientId: string, fareType: AkbarRoundTripFareType) {
  const tui = typeof searchTui === "string" ? searchTui.trim() : "";
  if (!tui) throw new Error("Akbar round-trip pricing requires a search TUI");
  const trips = legs.map((l) => {
    const index = typeof l.index === "string" ? l.index.trim() : "";
    if (l.amount == null || !Number.isFinite(l.amount) || l.amount <= 0) throw new Error(`Akbar round-trip pricing requires a positive amount for each leg (got ${l.amount})`);
    if (!index) throw new Error("Akbar round-trip pricing requires an Index for each leg");
    return { amount: l.amount, index };
  });
  const rs = fareType === "RS";
  return {
    Trips: trips.map((l, i) => ({ Amount: l.amount, Index: l.index, ChannelCode: rs ? "" : null, OrderID: i + 1, TUI: tui })),
    ClientID: rs ? "" : clientId,
    Mode: "SS",
    Options: rs ? "" : "A",
    Source: "SF",
    TripType: fareType,
  };
}

// SmartPricer request for a Special Fare pair of journeys (refuses a pair Akbar's rules don't allow, and
// a leg without a positive NetFare or an Index). The RS samples send ClientID "", so clientId is unused.
export function akbarSpecialFarePricerBody(pair: { onward: Raw; return: Raw }, searchTui: string, _clientId = "") {
  if (!akbarSpecialFarePairs(pair.onward, pair.return)) throw new Error("These flights are not an Akbar Special Fare pair");
  if (typeof searchTui !== "string" || !searchTui.trim()) throw new Error("Akbar Special Fare pricing requires a search TUI");
  const leg = (j: Raw): AkbarRoundTripPricerLeg => {
    const amount = Number(j.NetFare);
    const index = typeof j.Index === "string" ? j.Index.trim() : "";
    if (j.NetFare === null || j.NetFare === undefined || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("Akbar Special Fare pricing requires a positive NetFare for each leg");
    }
    if (!index) throw new Error("Akbar Special Fare pricing requires an Index for each leg");
    return { amount, index };
  };
  return akbarRoundTripPricerBody([leg(pair.onward), leg(pair.return)], searchTui, "", "RS");
}
