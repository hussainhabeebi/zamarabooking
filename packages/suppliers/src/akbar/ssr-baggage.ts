// Included (free) baggage from Akbar's SSR answer, for one fare option.
//
// Akbar (Nov 2026): SSR can be called before pricing with the ExpressSearch result's Index, and the
// free SSR is the recommended source of baggage; this also covers AKB-SPCL fares.
//
// Request (client.ts ssrBody): { ClientID, PaidSSR: false, Source, Trips: [{ TUI: <search TUI>,
//   Amount: 0, OrderID, Index: <the journey's Index, e.g. "6E|1"> }] }.
// Answer (UAT, after pricing — the same shape): Trips[].Journey[].Segments[] = { FUID, VAC, Index,
//   SSR: [{ Code: "BAG", Description: "15 Kg, 7 Kg", Charge: 0, Type: "2", PTC: "ADT" | "CHD" | "INF", … }] }.
// The included allowance is the BAG item with Charge 0, one per passenger type per flight; its
// Description is "check-in, cabin" like ExpressSearch Inclusions.Baggage (../baggage.ts reads it).
//
// Safety: the answer is used only when it is for this fare — the airline matches, any Index Akbar echoes
// matches the one asked for, there is exactly one journey — and each passenger type has exactly one
// free BAG per flight. Flights of one journey with different allowances are kept apart (VARIES), never
// merged. Anything else is UNKNOWN: the page keeps "Allowance not confirmed".

import { akbarBaggage, type StructuredBaggage } from "../baggage.js";
import { akbarMessages, akbarOk } from "./client.js";

type Raw = Record<string, unknown>;
type Ptc = "ADT" | "CHD" | "INF";
const PTCS: Ptc[] = ["ADT", "CHD", "INF"];

export interface SsrSegmentBaggage { fuid: string; airline: string; byPtc: Partial<Record<Ptc, StructuredBaggage>> }

export type SsrBaggageResult =
  // Every flight of the journey has the same allowance for that passenger type.
  | { status: "CONFIRMED"; adult: StructuredBaggage; child?: StructuredBaggage; infant?: StructuredBaggage; segments: SsrSegmentBaggage[] }
  // The flights differ (e.g. a connection on another carrier): shown per flight, never merged.
  | { status: "VARIES"; segments: SsrSegmentBaggage[] }
  // Akbar answered, but not with a usable included allowance for this fare.
  | { status: "UNKNOWN"; reason: string };

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
const same = (a?: StructuredBaggage, b?: StructuredBaggage) =>
  !!a && !!b && a.checked === b.checked && a.cabin === b.cabin && a.checkedStatus === b.checkedStatus && a.cabinStatus === b.cabinStatus;

/**
 * @param data      the SSR answer
 * @param expect    the fare it was asked for: carriers (VAC / MAC / OAC codes of the fare) and the Index sent
 */
export function akbarSsrBaggage(data: unknown, expect: { carriers: string[]; index: string }): SsrBaggageResult {
  if (!akbarOk(data)) return { status: "UNKNOWN", reason: `SSR: ${akbarMessages(data) || "no answer"}` };
  const trips = Array.isArray((data as Raw).Trips) ? (data as Raw).Trips as Raw[] : [];
  const journeys = trips.flatMap((t) => (Array.isArray(t?.Journey) ? t.Journey as Raw[] : []));
  if (journeys.length !== 1) return { status: "UNKNOWN", reason: `SSR returned ${journeys.length} journeys for one fare` };
  const segs = Array.isArray(journeys[0].Segments) ? journeys[0].Segments as Raw[] : [];
  if (!segs.length) return { status: "UNKNOWN", reason: "SSR returned no flights" };
  const carriers = new Set(expect.carriers.map((c) => c.toUpperCase()).filter(Boolean));

  const segments: SsrSegmentBaggage[] = [];
  for (const s of segs) {
    const airline = str(s.VAC).toUpperCase() || str(journeys[0].Provider).toUpperCase();
    if (carriers.size && airline && !carriers.has(airline)) return { status: "UNKNOWN", reason: `SSR is for ${airline}, not ${[...carriers].join("/")}` };
    const echoed = str(s.Index);
    if (echoed && expect.index && echoed !== expect.index) return { status: "UNKNOWN", reason: `SSR is for Index ${echoed}, not ${expect.index}` };
    const free = (Array.isArray(s.SSR) ? s.SSR as Raw[] : [])
      .filter((x) => str(x.Code).toUpperCase() === "BAG" && Number(x.Charge ?? 0) === 0 && str(x.Description));
    const byPtc: SsrSegmentBaggage["byPtc"] = {};
    for (const ptc of PTCS) {
      const items = free.filter((x) => str(x.PTC).toUpperCase() === ptc);
      if (items.length !== 1) continue;            // none, or more than one: not a reliable allowance
      byPtc[ptc] = akbarBaggage(items[0].Description);
    }
    segments.push({ fuid: str(s.FUID), airline, byPtc });
  }

  const adultAll = segments.map((s) => s.byPtc.ADT);
  if (adultAll.some((b) => !b)) return { status: "UNKNOWN", reason: "SSR has no single free adult baggage item on every flight" };
  if (!adultAll.every((b) => same(b, adultAll[0]))) return { status: "VARIES", segments };
  const uniform = (ptc: Ptc) => {
    const all = segments.map((s) => s.byPtc[ptc]);
    return all.every((b) => same(b, all[0])) ? all[0] : undefined;
  };
  return {
    status: "CONFIRMED", adult: adultAll[0]!, segments,
    ...(uniform("CHD") ? { child: uniform("CHD") } : {}),
    ...(uniform("INF") ? { infant: uniform("INF") } : {}),
  };
}
