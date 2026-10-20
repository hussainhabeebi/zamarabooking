import type { FareSegment, NormalizedFare } from "../base.js";

type Rec = Record<string, any>;

export function normalizeTripjackSegment(s: Rec): FareSegment {
  return {
    ...(s?.id != null ? { id: String(s.id) } : {}),
    airline:       s?.fD?.aI?.code ?? "",
    airlineName:   s?.fD?.aI?.name ?? "",
    flightNumber:  s?.fD?.fN != null ? String(s.fD.fN) : "",
    origin:        s?.da?.code ?? "",
    destination:   s?.aa?.code ?? "",
    departureTime: s?.dt ?? "",
    arrivalTime:   s?.at ?? "",
    duration:      typeof s?.duration === "number" ? s.duration : 0,
    ...(s?.isRs ? { isReturn: true } : {}),
  };
}

export interface PaxCounts { adults: number; children?: number; infants?: number }

// TripJack search prices are per passenger type (fd.ADULT / fd.CHILD / fd.INFANT,
// each for ONE traveller of that type). The trip price is the sum for everyone.
function tripTotals(fd: Rec | undefined, pax?: PaxCounts): { BF: number; TAF: number; TF: number } | null {
  if (!fd || !pax || fd.fC) return null;   // flat fd.fC is already a trip total
  const lines: [string, number][] = [["ADULT", pax.adults], ["CHILD", pax.children ?? 0], ["INFANT", pax.infants ?? 0]];
  let BF = 0, TAF = 0, TF = 0;
  for (const [type, count] of lines) {
    if (!count) continue;
    const fC = fd[type]?.fC;
    if (typeof fC?.TF !== "number") return null;   // a priced pax type is missing: don't guess
    BF += (fC.BF ?? 0) * count; TAF += (fC.TAF ?? 0) * count; TF += fC.TF * count;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { BF: r2(BF), TAF: r2(TAF), TF: r2(TF) };
}

export function normalizeTripjackFare(r: Rec, context: { tripKey?: string; legIndex?: number; pax?: PaxCounts } = {}): NormalizedFare {
  const sI: Rec[] = Array.isArray(r.sI) ? r.sI : [];
  const fi = sI[0] ?? {};
  // COMBO (international return / multi-city) prices cover every leg; the
  // outbound part is everything before the first return segment.
  const outbound = sI.filter((s) => !s?.isRs);
  const last = (outbound.length ? outbound : sI)[Math.max(0, (outbound.length ? outbound : sI).length - 1)] ?? fi;
  const totalPriceInfo = (r.totalPriceInfo as Rec) ?? {};
  // TripJack v2: fd is keyed by pax type (fd.ADULT.fC) or flat (fd.fC)
  const adultFd = totalPriceInfo.fd?.ADULT ?? totalPriceInfo.fd ?? {};
  const fC = totalPriceInfo.fd?.fC ?? adultFd.fC;
  const totals = tripTotals(totalPriceInfo.fd, context.pax);
  const rT = typeof adultFd.rT === "number" ? adultFd.rT : undefined;
  const fareIdentifier = (r.fareIdentifier as string) ?? "";
  const msri = Array.isArray(r.msri) ? r.msri.map(String) : r.msri ? [String(r.msri)] : undefined;
  return {
    id:            r.id as string,
    supplier:      "TRIPJACK",
    isBookable:    true,
    airline:       fi.fD?.aI?.code ?? "",
    airlineName:   fi.fD?.aI?.name ?? "",
    flightNumber:  fi.fD?.fN != null ? String(fi.fD.fN) : "",
    origin:        fi.da?.code ?? "",
    destination:   last.aa?.code ?? fi.aa?.code ?? "",
    departureTime: fi.dt ?? "",
    arrivalTime:   last.at ?? fi.at ?? "",
    duration:      outbound.length > 1
      ? Math.round((Date.parse(last.at) - Date.parse(fi.dt)) / 60000) || outbound.reduce((n, s) => n + (s.duration ?? 0), 0)
      : fi.duration ?? 0,
    stops:         Math.max(0, (outbound.length || sI.length) - 1),
    stopDetails:   [],
    cabinClass:    adultFd.cc ?? r.cabinClass ?? "ECONOMY",
    baseFare:      totals?.BF ?? fC?.BF ?? 0,
    taxes:         totals?.TAF ?? fC?.TAF ?? 0,
    totalFare:     totals?.TF ?? fC?.TF ?? 0,
    ...(typeof fC?.TF === "number" ? { perAdultFare: fC.TF } : {}),
    currency:      "INR",
    isRefundable:  rT !== undefined ? rT !== 0 : fareIdentifier !== "NONREFUNDABLE",
    baggage: {
      cabin:   typeof adultFd.bI?.cB === "string" && adultFd.bI.cB.trim() ? adultFd.bI.cB : "",
      checked: typeof adultFd.bI?.iB === "string" && adultFd.bI.iB.trim() ? adultFd.bI.iB : "",
    },
    fareClass:  fareIdentifier,
    seatsLeft:  (adultFd.sR ?? r.seatsAvailable) as number,
    ...(context.tripKey ? { tripKey: context.tripKey } : {}),
    ...(context.legIndex !== undefined ? { legIndex: context.legIndex } : {}),
    ...(fareIdentifier ? { fareIdentifier } : {}),
    ...(r.sri ? { sri: String(r.sri) } : {}),
    ...(msri?.length ? { msri } : {}),
    ...(rT !== undefined ? { refundableType: rT } : {}),
    ...(typeof adultFd.mI === "boolean" ? { mealIncluded: adultFd.mI } : {}),
    ...(sI.length ? { segments: sI.map(normalizeTripjackSegment) } : {}),
    raw:        r,
  };
}
