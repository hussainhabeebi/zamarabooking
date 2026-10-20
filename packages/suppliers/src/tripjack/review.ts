// Parses a TripJack Flights v2 Review (fms/v1/review) response into what
// checkout needs: session bookingId, total fare, booking conditions, the
// per-segment SSR options (baggage / meal / extra services) and fare alerts.

import { normalizeTripjackSegment } from "./normalizer.js";
import type { FareSegment } from "../base.js";

type Rec = Record<string, any>;

export interface SsrOption { code: string; amount: number; desc: string }

export interface ReviewSegment extends FareSegment {
  key:   string;   // segment id — the SSR "key" in the Book request
  ssr: { baggage: SsrOption[]; meal: SsrOption[]; extra: SsrOption[] };
}

export interface ReviewConditions {
  sessionSeconds:         number | null;   // st — bookingId validity
  seatApplicable:         boolean;         // isa — call Seat Map only when true
  holdAllowed:            boolean;         // isBA
  emergencyContactRequired: boolean;       // iecr
  gstMandatory:           boolean;         // gst.igm
  gstApplicable:          boolean;         // gst.gstappl
  passportMandatory:      boolean;         // pcs.pm
  passportExpiryRequired: boolean;         // pcs.pped
  dobRequired:            { ADULT: boolean; CHILD: boolean; INFANT: boolean };
  panApplicable:          boolean;         // ipa
  documentIdApplicable:   boolean;         // dc.ida (student / senior citizen)
  documentIdMandatory:    boolean;         // dc.idm
}

export interface ReviewSummary {
  bookingId:   string;
  totalFare:   number | undefined;   // TF — must equal paymentInfos.amount (plus chosen SSR)
  baseFare?:   number;
  taxes?:      number;
  currency:    string;
  conditions:  ReviewConditions;
  segments:    ReviewSegment[];
  fareAlert?:  { oldFare?: number; newFare?: number; message?: string };
  airline?:    string;
  fareIdentifiers: string[];
}

const bool = (v: unknown) => v === true || v === "true";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

function ssrList(v: unknown): SsrOption[] {
  return Array.isArray(v)
    ? v.filter((x: Rec) => x?.code).map((x: Rec) => ({ code: String(x.code), amount: num(x.amount), desc: String(x.desc ?? x.code) }))
    : [];
}

// Booking total (TF) from a Review response — what paymentInfos.amount must be.
// totalFareDetail is the total for every traveller. fd is keyed by pax type and
// priced for ONE traveller of that type, so it is only used summed over the
// passenger counts, never as the booking total on its own.
export function reviewTotalFare(rr: Rec, pax?: { adults: number; children?: number; infants?: number }): { TF?: number; BF?: number; TAF?: number } {
  const first = rr?.results?.[0] ?? (Array.isArray(rr?.tripInfos) ? rr.tripInfos[0] : undefined);
  const infos = [rr?.totalPriceInfo, first?.totalPriceInfo, first?.fareGroups?.[0]?.totalPriceInfo];
  for (const info of infos) {
    const fC = info?.totalFareDetail?.fC;
    if (typeof fC?.TF === "number") return { TF: fC.TF, BF: fC.BF, TAF: fC.TAF };
  }
  for (const info of infos) {
    const fC = info?.fd?.fC;   // flat (not per pax type): already a total
    if (typeof fC?.TF === "number") return { TF: fC.TF, BF: fC.BF, TAF: fC.TAF };
  }
  const q = rr?.searchQuery?.paxInfo ?? first?.searchQuery?.paxInfo;
  pax ??= q ? { adults: Number(q.ADULT) || 0, children: Number(q.CHILD) || 0, infants: Number(q.INFANT) || 0 } : undefined;
  if (pax) {
    for (const info of infos) {
      const fd = info?.fd;
      if (!fd?.ADULT) continue;
      const lines: [string, number][] = [["ADULT", pax.adults], ["CHILD", pax.children ?? 0], ["INFANT", pax.infants ?? 0]];
      if (lines.some(([t, n]) => n > 0 && typeof fd[t]?.fC?.TF !== "number")) continue;
      const sum = (k: "TF" | "BF" | "TAF") => Math.round(lines.reduce((t, [type, n]) => t + (n ? (fd[type].fC[k] ?? 0) * n : 0), 0) * 100) / 100;
      return { TF: sum("TF"), BF: sum("BF"), TAF: sum("TAF") };
    }
  }
  return {};
}

export function parseTripjackReview(result: Rec): ReviewSummary {
  const c = result?.conditions ?? {};
  const trips: Rec[] = Array.isArray(result?.tripInfos) ? result.tripInfos : [];
  const segments: ReviewSegment[] = trips.flatMap((t) => (Array.isArray(t?.sI) ? t.sI : [])).map((s: Rec) => ({
    ...normalizeTripjackSegment(s),
    key: String(s?.id ?? ""),
    ssr: {
      baggage: ssrList(s?.ssrInfo?.BAGGAGE),
      meal:    ssrList(s?.ssrInfo?.MEAL),
      extra:   ssrList(s?.ssrInfo?.EXTRASERVICES),
    },
  }));
  const alert = (Array.isArray(result?.alerts) ? result.alerts : []).find((a: Rec) => a?.type === "FAREALERT");
  const tf = reviewTotalFare(result);
  const fareIdentifiers = trips.flatMap((t) => (Array.isArray(t?.totalPriceList) ? t.totalPriceList : []))
    .map((p: Rec) => p?.fareIdentifier).filter(Boolean).map(String);
  return {
    bookingId: String(result?.bookingId ?? ""),
    totalFare: tf.TF,
    baseFare:  tf.BF,
    taxes:     tf.TAF,
    currency:  String(result?.currency ?? "INR"),
    conditions: {
      sessionSeconds:         typeof c.st === "number" ? c.st : null,
      seatApplicable:         bool(c.isa),
      holdAllowed:            bool(c.isBA),
      emergencyContactRequired: bool(c.iecr),
      gstMandatory:           bool(c.gst?.igm ?? c.igm),
      gstApplicable:          bool(c.gst?.gstappl ?? c.gstappl) || bool(c.gst?.igm ?? c.igm),
      passportMandatory:      bool(c.pcs?.pm ?? c.pm),
      passportExpiryRequired: bool(c.pcs?.pped ?? c.pped),
      dobRequired: {
        ADULT:  bool(c.dob?.adobr ?? c.adobr),
        CHILD:  bool(c.dob?.cdobr ?? c.cdobr),
        INFANT: true,   // TripJack: DOB mandatory for infants
      },
      panApplicable:          bool(c.ipa),
      documentIdApplicable:   bool(c.dc?.ida ?? c.ida) || bool(c.dc?.idm ?? c.idm),
      documentIdMandatory:    bool(c.dc?.idm ?? c.idm),
    },
    segments,
    ...(alert ? { fareAlert: { oldFare: alert.oldFare, newFare: alert.newFare, message: alert.message } } : {}),
    airline: segments[0]?.airline || undefined,
    fareIdentifiers: [...new Set(fareIdentifiers)],
  };
}

// Price of the SSR a passenger picked, validated against the review options.
export function ssrTotal(
  segments: ReviewSegment[],
  passengers: { ssr?: { baggage?: { key: string; code: string }[]; meal?: { key: string; code: string }[]; extra?: { key: string; code: string }[] } }[],
): { total: number; invalid: string[] } {
  const byKey = new Map(segments.map((s) => [s.key, s]));
  let total = 0;
  const invalid: string[] = [];
  passengers.forEach((p, i) => {
    for (const [kind, list] of [["baggage", p.ssr?.baggage], ["meal", p.ssr?.meal], ["extra", p.ssr?.extra]] as const) {
      for (const pick of list ?? []) {
        const option = byKey.get(pick.key)?.ssr[kind].find((o) => o.code === pick.code);
        if (!option) invalid.push(`passenger ${i + 1} ${kind} ${pick.code} on ${pick.key}`);
        else total += option.amount;
      }
    }
  });
  return { total: Math.round(total * 100) / 100, invalid };
}
