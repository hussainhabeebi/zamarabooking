// Same flight, several airline fare options (Saver / Standard / Flexi / SME…):
// TripJack returns one price per option. Group them so a flight is shown once
// with its options side by side.

export interface FareOptionLike {
  id: string;
  airline?: string; flightNumber?: string; departureTime?: string; arrivalTime?: string; stops?: number;
  totalFare?: number; displayPrice?: number; isRefundable?: boolean; refundableType?: number;
  baggage?: { cabin?: string; checked?: string }; mealIncluded?: boolean; fareIdentifier?: string; fareClass?: string;
  segments?: { flightNumber?: string }[];
}

const LABELS: Record<string, string> = {
  PUBLISHED: "Standard", SOTO: "Saver", LITE: "Lite", SALE: "Sale", SME: "SME", CORPORATE: "Corporate",
  FLEXI: "Flexi", TJ_FLEX: "Flexi", FLEX: "Flexi", PREMIUM_FLEX: "Premium Flexi", SUPER_6E: "Super 6E",
  STUDENT: "Student", SENIOR_CITIZEN: "Senior citizen", SPECIAL_RETURN: "Special Return", INSTANT: "Instant",
  NONREFUNDABLE: "Non-refundable", OFFER: "Offer", COUPON: "Coupon", FAMILY: "Family",
};

export function fareLabel(id?: string) {
  if (!id) return "Standard";
  return LABELS[id] ?? id.toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export const optionPrice = (f: FareOptionLike) => Number(f.displayPrice ?? f.totalFare ?? 0);

export function flightKey(f: FareOptionLike) {
  const route = f.segments?.map((s) => s.flightNumber).join("+") || f.flightNumber || "";
  return [f.airline ?? "", route, f.departureTime ?? "", f.arrivalTime ?? "", f.stops ?? 0].join("|");
}

export interface FlightGroup<T extends FareOptionLike> { key: string; lead: T; options: T[] }

// Keeps the incoming order of flights (first appearance); options cheapest first.
export function groupFareOptions<T extends FareOptionLike>(fares: T[]): FlightGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const f of fares) {
    const k = flightKey(f);
    const list = map.get(k);
    if (list) list.push(f); else map.set(k, [f]);
  }
  return [...map.entries()].map(([key, options]) => {
    const sorted = [...options].sort((a, b) => optionPrice(a) - optionPrice(b));
    return { key, lead: sorted[0], options: sorted };
  });
}

// Short benefits line, e.g. "30 kg · meal · refundable".
export function optionPerks(f: FareOptionLike) {
  return {
    checked: f.baggage?.checked || "",
    cabin: f.baggage?.cabin || "",
    meal: f.mealIncluded === true ? "Free meal" : f.mealIncluded === false ? "Meal at cost" : "",
    refund: f.refundableType === 2 ? "Partly refundable" : f.isRefundable ? "Refundable" : "Non-refundable",
  };
}

// Compact list of the other options of a flight, carried to the booking page
// so the customer can switch / upgrade there.
export interface AltOption { id: string; label: string; price: number; checked: string; cabin: string; meal: string; ref: string }
export function altOptions(options: FareOptionLike[], exceptId: string): AltOption[] {
  return options.filter((o) => o.id !== exceptId).slice(0, 5).map((o) => {
    const p = optionPerks(o);
    return { id: o.id, label: fareLabel(o.fareIdentifier || o.fareClass), price: optionPrice(o), checked: p.checked, cabin: p.cabin, meal: p.meal, ref: p.refund };
  });
}
