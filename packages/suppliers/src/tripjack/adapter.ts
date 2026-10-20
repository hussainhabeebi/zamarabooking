import type {
  SupplierAdapter, SearchParams, NormalizedFare, HoldParams, HoldResult,
  BookParams, BookResult, PNRStatusResult, CancelResult, SupplierCredentials, FareRule, RevalidateResult,
} from "../base.js";
import { TripjackClient } from "./client.js";
import { normalizeTripjackFare } from "./normalizer.js";
import { TripjackReviewError } from "./review-error.js";

export class TripjackAdapter implements SupplierAdapter {
  readonly name = "TRIPJACK" as const;
  private client: TripjackClient;

  constructor(credentials: SupplierCredentials) {
    this.client = new TripjackClient(credentials);
  }

  async search(params: SearchParams): Promise<NormalizedFare[]> {
    const raw = await this.client.search(params) as Record<string, unknown>;
    // Some whitelisted proxies wrap the upstream JSON in `data` or `result`.
    const response = (raw.data ?? raw.result ?? raw) as Record<string, unknown>;
    const status = response.status as { success?: boolean; statusMessage?: string } | undefined;
    if (status?.success === false) {
      console.error("[tripjack-search] rejected:", JSON.stringify({ status, keys: Object.keys(response) }));
      throw Object.assign(
        new Error(`TripJack rejected the flight search request: ${status?.statusMessage ?? "unknown reason"}`),
        { code: "SEARCH_REJECTED", responseSnippet: safeSnippet(response) },
      );
    }

    const searchResult = response.searchResult as { tripInfos?: Record<string, unknown[]> } | undefined;
    if (!searchResult?.tripInfos) {
      console.error("[tripjack-search] unrecognized response structure:", JSON.stringify({ topKeys: Object.keys(response), hasSearchResult: !!response.searchResult }));
      throw Object.assign(
        new Error("TripJack returned an unrecognized flight-search response"),
        { code: "SEARCH_INVALID_RESPONSE", responseSnippet: safeSnippet(response) },
      );
    }

    const pax = { adults: params.adults, children: params.children, infants: params.infants };
    const expand = (trips: unknown[], leg: { tripKey?: string; legIndex?: number }) => trips.flatMap((trip) => {
      const context = { ...leg, pax };
      const row = trip as Record<string, unknown>;
      // TripJack puts the bookable fare id and price inside totalPriceList, not
      // on the itinerary wrapper. Expand every price option so the client receives
      // the real id required by fare rules and checkout instead of an empty id.
      const prices = Array.isArray(row.totalPriceList) ? row.totalPriceList as Record<string, unknown>[] : [];
      if (!prices.length) return [normalizeTripjackFare(row, context)];
      return prices.map((price) => normalizeTripjackFare({
        ...row,
        ...price,
        id: price.id,
        totalPriceInfo: price,
      }, context));
    });

    const tripInfoKeys = Object.keys(searchResult.tripInfos);
    // Round trip / multi-city: keep every leg. Domestic return → ONWARD + RETURN
    // (2 priceIds at review); international return / multi-city → COMBO (1 priceId);
    // domestic multi-city → indexed keys "0".."5".
    if (params.tripType === "ROUNDTRIP" || params.tripType === "MULTICITY" || (params.legs?.length ?? 0) > 1) {
      console.info(`[tripjack-search] journey tripInfos keys=${JSON.stringify(tripInfoKeys)}`);
      return tripInfoKeys.flatMap((key) => {
        const trips = searchResult.tripInfos![key];
        if (!Array.isArray(trips)) return [];
        const legIndex = key === "ONWARD" || key === "COMBO" ? 0 : key === "RETURN" ? 1 : /^\d+$/.test(key) ? Number(key) : undefined;
        return expand(trips, { tripKey: key, legIndex });
      });
    }

    // TripJack keys one-way results as "ONWARD" in v2, but some proxy/API versions
    // key by route string (e.g. "DEL-DXB") or another label. "ONWARD" may also be
    // present as an empty array [] rather than undefined, so ?? alone isn't enough —
    // check for a non-empty array explicitly before falling back.
    const onwardKey = searchResult.tripInfos["ONWARD"];
    const trips: unknown[] =
      (Array.isArray(onwardKey) && onwardKey.length > 0 ? onwardKey : null) ??
      Object.values(searchResult.tripInfos).find((v) => Array.isArray(v) && v.length > 0) ??
      [];
    console.info(`[tripjack-search] tripInfos keys=${JSON.stringify(tripInfoKeys)} trips=${trips.length}`);
    return expand(trips, {});
  }

  async getFareRules(fareId: string): Promise<FareRule[]> {
    const raw = await this.client.fareRules(fareId) as any;
    return parseTripjackFareRules(raw);
  }

  async revalidate(fareId: string): Promise<RevalidateResult> {
    try {
      const { bookingId, result } = await this.client.validateFare(fareId);
      const response = (result as any)?.data ?? (result as any)?.result ?? result as Record<string, unknown>;
      const price = (response as any).totalPriceInfo as {
        fd?: { fC?: { BF?: number; TAF?: number; TF?: number }; ADULT?: { fC?: { BF?: number; TAF?: number; TF?: number } } };
      } | undefined;
      // TripJack v2: fd keyed by pax type (fd.ADULT.fC) or flat (fd.fC)
      const components = price?.fd?.fC ?? price?.fd?.ADULT?.fC;
      return {
        success: true,
        fareId,
        bookingId,
        baseFare: components?.BF,
        taxes: components?.TAF,
        totalFare: components?.TF,
        currency: String((response as any).currency ?? "INR"),
        raw: response,
      };
    } catch (err) {
      if (err instanceof TripjackReviewError) {
        throw new Error(err.message || "TripJack could not revalidate this fare");
      }
      throw err;
    }
  }

  async hold(_params: HoldParams): Promise<HoldResult> {
    // Tripjack uses session-based booking — hold is implicit in the session
    throw new Error("Tripjack does not support explicit hold — proceed directly to book");
  }

  async book(params: BookParams): Promise<BookResult> {
    const raw = await this.client.book(params as HoldParams & BookParams) as Record<string, unknown>;
    const response = unwrap(raw);
    const order = (response.order ?? response) as Record<string, unknown>;
    const travellers = travellersOf(response);
    const pnr = firstValue(travellers.find((t) => firstValue(t.pnrDetails))?.pnrDetails) || String(response.pnr ?? "");
    const bookingRef = String(order.bookingId ?? response.bookingId ?? params.holdId);
    const orderStatus = String(order.status ?? "").toUpperCase();
    const apiSuccess = (response.status as { success?: boolean } | undefined)?.success === true;
    return {
      success:       orderStatus === "SUCCESS" || orderStatus === "ON_HOLD" || apiSuccess || !!(pnr || bookingRef !== params.holdId),
      bookingRef,
      pnr,
      status:        orderStatus === "SUCCESS" || orderStatus === "ON_HOLD" || apiSuccess ? "CONFIRMED" : "FAILED",
      ticketNumbers: travellers.map((t) => firstValue(t.ticketNumberDetails)).filter(Boolean),
      raw: response,
    };
  }

  async getPNRStatus(bookingId: string): Promise<PNRStatusResult> {
    const raw = unwrap(await this.client.pnrStatus(bookingId) as Record<string, unknown>);
    // booking-details: { order: {status}, itemInfos: { AIR: { tripInfos, travellerInfos } } }
    const order = (raw.order ?? raw) as Record<string, unknown>;
    const air = ((raw.itemInfos as Record<string, unknown> | undefined)?.AIR ?? {}) as Record<string, unknown>;
    const travellers = travellersOf(raw);
    const status = raw.status as { statusMessage?: string } | undefined;
    return {
      pnr:        firstValue(travellers.find((t) => firstValue(t.pnrDetails))?.pnrDetails),
      status:     String(order.status ?? ""),
      statusMessage: String(order.statusMessage ?? order.message ?? status?.statusMessage ?? "") || undefined,
      passengers: travellers.map((t) => ({
        name:         `${t.fN ?? ""} ${t.lN ?? ""}`.trim(),
        ticketNumber: firstValue(t.ticketNumberDetails),
        status:       String(order.status ?? ""),
      })),
      itinerary: air.tripInfos ?? raw.tripInfos ?? raw.itemInfos,
      raw,
    };
  }

  async cancel(bookingRef: string): Promise<CancelResult> {
    const raw = await this.client.cancel(bookingRef) as Record<string, unknown>;
    // submit-amendment returns amendmentId; success means amendment was accepted
    const success = !!(raw.amendmentId) || (raw.status as any)?.success === true;
    return {
      success,
      refundAmount: raw.refundableAmount as number ?? 0,
      penalty:      raw.amendmentCharges as number ?? 0,
      status:       raw.amendmentId ? "CANCELLATION_REQUESTED" : String((raw.status as any)?.statusMessage ?? ""),
    };
  }
}

function safeSnippet(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 800); } catch { return ""; }
}

// Some whitelisted proxies wrap the upstream JSON in `data` or `result`.
function unwrap(raw: Record<string, unknown>): Record<string, unknown> {
  return (raw?.data ?? raw?.result ?? raw ?? {}) as Record<string, unknown>;
}

// Travellers (with pnrDetails / ticketNumberDetails) live under itemInfos.AIR.
function travellersOf(root: Record<string, unknown>): Array<Record<string, unknown>> {
  const air = (root.itemInfos as Record<string, unknown> | undefined)?.AIR as Record<string, unknown> | undefined;
  const list = air?.travellerInfos ?? root.travellerInfos;
  return Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
}

function firstValue(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const first = Object.values(v as Record<string, unknown>).find((x) => typeof x === "string" && x);
  return typeof first === "string" ? first : "";
}

// TripJack v2 farerule: tfr (timed fare rules) keyed by policy type, usually
// nested under the route ("COK-DXB": { tfr: { CANCELLATION: [...], DATECHANGE: [...] } }).
export function parseTripjackFareRules(raw: unknown): FareRule[] {
  const find = (v: any, depth = 0): any => {
    if (!v || typeof v !== "object" || depth > 6) return null;
    if (v.tfr && typeof v.tfr === "object") return v.tfr;
    if (v.fareRestrictions) return v.fareRestrictions;
    for (const x of Object.values(v)) { const hit = find(x, depth + 1); if (hit) return hit; }
    return null;
  };
  const tfr = find(raw);
  const describe = (r: any) => {
    const parts: string[] = [];
    if (typeof r?.amount === "number") parts.push(`₹${Math.round(r.amount).toLocaleString("en-IN")}${typeof r.additionalFee === "number" && r.additionalFee > 0 ? ` + ₹${Math.round(r.additionalFee).toLocaleString("en-IN")} fee` : ""}`);
    if (r?.st != null || r?.et != null) parts.push(`${r.st ?? 0}–${r.et ?? "∞"} hrs before departure`);
    const info = typeof r?.policyInfo === "string" ? r.policyInfo.replace(/__nls__/g, " ").trim() : "";
    return [info, parts.join(" · ")].filter(Boolean).join(" — ") || "As per airline rules";
  };
  if (Array.isArray(tfr)) return tfr.map((r: any) => ({ category: String(r.type ?? "General"), description: describe(r) }));
  if (tfr && typeof tfr === "object") {
    return Object.entries(tfr).flatMap(([category, policies]) =>
      (Array.isArray(policies) ? policies : []).map((r: any) => ({ category, description: describe(r) })));
  }
  return [];
}
