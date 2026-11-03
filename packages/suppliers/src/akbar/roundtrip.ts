// Akbar round trips in one search: normal round trip (FareType "RT") and Round Trip Special
// Fare (FareType "RS").
//
// Source of truth: Akbar's sample payloads (Nov 2026):
//   • RT  — ExpressSearch request / response, GetExpSearch request / response (BOM–DEL, SG).
//   • RS  — ExpressSearch request / response, GetExpSearch request / response, SmartPricer request
//           (BOM–DXB, SG).
// GetExpSearch, both types: Trips[0].Journey = onward flights, Trips[1].Journey = return flights.
// RS: every Journey has ReturnIdentifier > 0 (equal to the number after "|" in its Index), and each
// ReturnIdentifier appears once on each side.
//
// Akbar's pairing rules for a Special Fare (onward + return become one fare) — all must hold:
//   both ReturnIdentifiers > 0; ONWARD.ReturnIdentifier = RETURN.ReturnIdentifier;
//   ONWARD.VAC = RETURN.VAC; ONWARD.Provider = RETURN.Provider. The Index values may differ.
//
// NOT here (no sample yet, so not built): the SmartPricer request of a normal RT, the GetSPricer /
// CreateItinerary / StartPay / RetrieveBooking responses of RT / RS, and how the combined price is
// read (Akbar: "the first leg's NetAmount already includes the combined fare", while the RS
// SmartPricer sample sends each leg's own NetFare as its Amount). Nothing calls these helpers yet:
// live search and booking still book a round trip as two one-way itineraries.

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

// SmartPricer request for a Special Fare pair, field for field as in Akbar's RS sample:
// one search TUI, OrderID 1 = onward, 2 = return, each leg's own Index and NetFare as Amount,
// ChannelCode null, Mode "SS", Options "", Source "SF", TripType "RS".
export function akbarSpecialFarePricerBody(pair: { onward: Raw; return: Raw }, searchTui: string, clientId: string) {
  if (!akbarSpecialFarePairs(pair.onward, pair.return)) throw new Error("These flights are not an Akbar Special Fare pair");
  if (!searchTui.trim()) throw new Error("Akbar Special Fare pricing requires a search TUI");
  const trip = (j: Raw, orderId: number) => {
    const amount = Number(j.NetFare);
    const index = typeof j.Index === "string" ? j.Index.trim() : "";
    if (j.NetFare === null || j.NetFare === undefined || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("Akbar Special Fare pricing requires a positive NetFare for each leg");
    }
    if (!index) throw new Error("Akbar Special Fare pricing requires an Index for each leg");
    return { Amount: amount, Index: index, OrderID: orderId, ChannelCode: null, TUI: searchTui };
  };
  return {
    Trips: [trip(pair.onward, 1), trip(pair.return, 2)],
    ClientID: clientId,
    Mode: "SS",
    Options: "",
    Source: "SF",
    TripType: "RS",
  };
}
