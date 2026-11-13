import type { NormalizedFare } from "@zamrabooking/suppliers";

// Company markup (Admin → Markup). The FIRST matching rule applies — agency-specific rules first,
// then the highest priority — so rules never add up: an airline rule (e.g. WY ₹600 per passenger,
// priority 10) replaces the all-airlines default (₹400 per passenger, priority 0).
//
// Types:
//   FLAT          fixed amount per booking (journey)
//   FLAT_PER_PAX  fixed amount per passenger (adults + children + infants) per complete journey
//   PERCENTAGE    % of the fare
//
// Fixed amounts are charged ONCE per journey. A round trip / multi-city searched as separate legs is
// priced leg by leg, so the fixed amount sits on the first leg (or on the one fare covering every leg)
// and later legs carry none; the journey's rule is the first leg's (its airline). Checkout prices the
// journey the same way (routes/book.ts customerPrice), so search total = amount charged.
// The supplier fare is never changed: markup = customer price − supplier fare.

interface MarkupRule {
  agentId?:    string | null;
  markupType:  string;
  markupValue: string;
  airline?:    string | null;
  origin?:     string | null;
  destination?: string | null;
  cabinClass?: string | null;
  supplier?:   string | null;
  tripType?:   string | null;
  priority:    number;
  isActive:    boolean;
  validFrom?:  Date | null;
  validTo?:    Date | null;
}

export interface PaxCount { adults: number; children?: number; infants?: number }

export interface MarkupOptions {
  pax?: PaxCount | null;          // passengers the fare is priced for (default 1)
  continuation?: boolean;         // a later leg of a journey priced leg by leg: no fixed amount
}

type FareLike = Pick<NormalizedFare, "totalFare" | "airline" | "origin" | "destination" | "cabinClass" | "supplier">;

// Every passenger counts, infants included (they are ticketed).
export function paxTotal(p?: PaxCount | null): number {
  if (!p) return 1;
  return Math.max(1, (Number(p.adults) || 0) + (Number(p.children) || 0) + (Number(p.infants) || 0));
}

// Search fares of a journey searched as separate legs: "ONWARD" / "0" is the first leg, "RETURN" /
// "1", "2"… are later legs. "COMBO" is one fare for the whole journey; no tripKey = a one-way fare.
export function isJourneyContinuation(tripKey: unknown): boolean {
  if (tripKey === undefined || tripKey === null || tripKey === "") return false;
  return !["COMBO", "ONWARD", "0"].includes(String(tripKey));
}

// The rule that applies to this fare (null = no markup).
export function matchMarkupRule<R extends MarkupRule>(fare: Omit<FareLike, "totalFare">, rules: R[]): R | null {
  const now = new Date();
  const active = rules
    .filter((r) => r.isActive)
    .filter((r) => !r.validFrom || r.validFrom <= now)
    .filter((r) => !r.validTo   || r.validTo   >= now)
    // Rules allocated to an agent beat the tenant-wide defaults, then highest priority first.
    .sort((a, b) => Number(Boolean(b.agentId)) - Number(Boolean(a.agentId)) || b.priority - a.priority);
  return active.find((r) => ruleMatches(r, fare)) ?? null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// The markup on this fare, in the fare's currency.
export function markupAmount(fare: FareLike, rules: MarkupRule[], opts: MarkupOptions = {}): number {
  const rule = matchMarkupRule(fare, rules);
  if (!rule) return 0;
  const value = parseFloat(rule.markupValue);
  if (!Number.isFinite(value) || value <= 0) return 0;
  switch (rule.markupType) {
    case "FLAT":         return opts.continuation ? 0 : value;
    case "FLAT_PER_PAX": return opts.continuation ? 0 : round2(value * paxTotal(opts.pax));
    case "PERCENTAGE":   return round2(fare.totalFare * (value / 100));
    default:             return 0;
  }
}

// Customer price = supplier fare + markup.
export function applyMarkup(fare: FareLike, rules: MarkupRule[], opts: MarkupOptions = {}): number {
  return round2(fare.totalFare + markupAmount(fare, rules, opts));
}

// Search results: displayPrice for each fare. standalone = every fare is booked on its own (Partner
// API offers), so each carries its journey's full markup.
export function priceSearchFares<F extends FareLike & { tripKey?: unknown }>(
  fares: F[], rules: MarkupRule[], opts: { pax?: PaxCount | null; standalone?: boolean } = {},
): (F & { displayPrice: number })[] {
  return fares.map((fare) => ({
    ...fare,
    displayPrice: applyMarkup(fare, rules, { pax: opts.pax, continuation: !opts.standalone && isJourneyContinuation(fare.tripKey) }),
  }));
}

function ruleMatches(rule: MarkupRule, fare: Omit<FareLike, "totalFare">): boolean {
  if (rule.airline    && rule.airline.toUpperCase() !== String(fare.airline ?? "").toUpperCase()) return false;
  if (rule.origin     && rule.origin     !== fare.origin)     return false;
  if (rule.destination && rule.destination !== fare.destination) return false;
  if (rule.cabinClass && rule.cabinClass !== fare.cabinClass) return false;
  if (rule.supplier   && rule.supplier   !== fare.supplier)   return false;
  return true;
}
