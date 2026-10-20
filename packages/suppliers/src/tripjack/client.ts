import type { SearchParams, HoldParams, BookParams, SupplierCredentials } from "../base.js";
import type { HotelSearchParams, HotelBookParams } from "./hotel-types.js";
import { SupplierError } from "../riya/client.js";
import { reviewFailure, TripjackReviewError } from "./review-error.js";


// One HTTP exchange with TripJack, captured verbatim for certification logs:
// the exact URL, headers (including the apikey) and body sent, and the exact
// response text received. Nothing is redacted or re-serialised.
export interface SupplierExchange {
  supplier:        "TRIPJACK";
  endpoint:        string;
  url:             string;
  method:          "POST" | "GET";
  requestHeaders:  Record<string, string>;
  requestBody:     string;
  status:          number | null;          // null = no HTTP response (network error / timeout)
  responseHeaders: Record<string, string>;
  responseBody:    string | null;          // raw text exactly as received
  error?:          string;
  startedAt:       string;
  durationMs:      number;
}
export type ExchangeRecorder = (exchange: SupplierExchange) => void;

// TripJack's own reason for a failed call: errors[].errCode / message
// (e.g. "2002: Passenger name is invalid"), else status / order messages.
export function tripjackErrorText(body: unknown): string | undefined {
  const b = body as any;
  const root = b?.data ?? b;
  const errors: any[] = Array.isArray(b?.errors) ? b.errors : Array.isArray(root?.errors) ? root.errors : [];
  const parts = errors.map((e) => [e?.errCode ?? e?.code, e?.message ?? e?.details ?? e?.errMessage].filter(Boolean).join(": ")).filter(Boolean);
  if (parts.length) return parts.join(" | ").slice(0, 600);
  const msg = b?.status?.statusMessage ?? root?.order?.statusMessage ?? b?.message ?? (typeof b?.error === "string" ? b.error : b?.error?.message);
  return typeof msg === "string" && msg.trim() ? msg.trim().slice(0, 600) : undefined;
}

export class TripjackClient {
  private recorder?: ExchangeRecorder;
  private baseUrl: string;
  private omsBaseUrl: string;  // separate base for /oms/ paths when proxy only covers /fms/
  private apiKey:  string;
  private proxyKey: string;

  constructor(creds: SupplierCredentials) {
    this.baseUrl    = ((creds.baseUrl    as string) ?? process.env.TRIPJACK_API_BASE_URL ?? "").replace(/\/$/, "");
    this.omsBaseUrl = ((creds.omsBaseUrl as string) ?? process.env.TRIPJACK_OMS_BASE_URL ?? "").replace(/\/$/, "");
    this.apiKey     = (creds.apiKey   as string) ?? process.env.TRIPJACK_API_KEY      ?? "";
    this.proxyKey   = (creds.proxyKey as string) ?? process.env.TRIPJACK_PROXY_KEY ?? "";
    this.recorder   = typeof creds.recorder === "function" ? creds.recorder as ExchangeRecorder : undefined;
  }

  setRecorder(recorder: ExchangeRecorder | undefined) { this.recorder = recorder; }

  private record(x: SupplierExchange) {
    try { this.recorder?.(x); } catch (err) { console.error("[tripjack] exchange recorder failed", err); }
  }

  private async request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    // OMS paths (book, cancel, booking-details) use omsBaseUrl when set — allows the
    // proxy to cover only FMS (search/review) while OMS goes direct to TripJack.
    const isOms = path.startsWith("/oms/");
    const base  = (isOms && this.omsBaseUrl) ? this.omsBaseUrl : this.baseUrl;

    if (!base || (!this.apiKey && !this.proxyKey)) {
      throw new Error("TripJack is enabled but its gateway or API credentials are missing");
    }

    const url = `${base}${path}`;
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { "apikey": this.apiKey } : {}),
      ...(this.proxyKey ? { "X-Poomas-Gateway-Key": this.proxyKey } : {}),
    };
    const requestBody = JSON.stringify(body);
    const startedAt = new Date();
    const exchange = (status: number | null, responseHeaders: Record<string, string>, responseBody: string | null, error?: string): SupplierExchange => ({
      supplier: "TRIPJACK", endpoint: path, url, method: "POST", requestHeaders, requestBody,
      status, responseHeaders, responseBody, error, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
    });

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: requestHeaders, body: requestBody, signal });
    } catch (err) {
      this.record(exchange(null, {}, null, err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
      throw err;
    }
    // Read the body once as raw text so the log holds exactly what TripJack sent.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      this.record(exchange(res.status, Object.fromEntries(res.headers), null, err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
      throw err;
    }
    this.record(exchange(res.status, Object.fromEntries(res.headers), text));

    if (!res.ok) {
      if (path === "/fms/v1/review") {
        let detail: unknown = null;
        try { detail = JSON.parse(text); } catch { /* Route/proxy HTML is not fare expiry. */ }
        throw reviewFailure(res.status, detail, crypto.randomUUID());
      }
      if (path === "/oms/v1/air/book") {
        console.error(`[tripjack] ${path} failed with HTTP ${res.status}`, text.slice(0, 500));
        let bookDetail: unknown = null;
        try { bookDetail = JSON.parse(text); } catch {}
        const statusMsg = String((bookDetail as any)?.status?.statusMessage ?? (bookDetail as any)?.data?.order?.statusMessage ?? "").toLowerCase();
        if (/expir|no longer available|booking session/i.test(statusMsg)) {
          throw new SupplierError("TRIPJACK", 409, "Booking session expired");
        }
        const supplierDetail = tripjackErrorText(bookDetail);
        const safeMsg = res.status === 401 || res.status === 403
          ? "Authentication or proxy IP whitelist rejected"
          : res.status === 404 ? "TripJack route is unavailable"
          : res.status === 429 ? "Rate limit exceeded"
          : "Upstream request failed";
        const err = new SupplierError("TRIPJACK", res.status, safeMsg) as any;
        if (supplierDetail) err.supplierDetail = supplierDetail;
        err.endpoint = path;
        err.responseSnippet = text.slice(0, 1500);
        throw err;
      } else console.error(`[tripjack] ${path} failed with HTTP ${res.status}`, text.slice(0, 1000));
      const safeMessage = res.status === 401 || res.status === 403
        ? "Authentication or proxy IP whitelist rejected"
        : res.status === 404
          ? "TripJack route is unavailable"
          : res.status === 429
            ? "Rate limit exceeded"
            : "Upstream request failed";
      // Keep the upstream detail on the error for Admin supplier logs; the
      // customer-facing message stays generic.
      let detail: unknown = null;
      try { detail = JSON.parse(text); } catch {}
      throw Object.assign(new SupplierError("TRIPJACK", res.status, safeMessage), {
        endpoint: path,
        responseSnippet: text.slice(0, 1500),
        ...(tripjackErrorText(detail) ? { supplierDetail: tripjackErrorText(detail) } : {}),
      });
    }

    return JSON.parse(text) as T;
  }

  // ── Flights ─────────────────────────────────────────────────────

  async search(params: SearchParams) {
    // Gateway alias path when proxyKey is set; direct TripJack path otherwise.
    const searchPath = this.proxyKey ? "/air-search-all/v2" : "/fms/v1/air-search-all";
    return this.request(searchPath, {
      searchQuery: {
        cabinClass:    params.cabinClass.charAt(0),  // Tripjack uses E/B/F
        paxInfo: {
          ADULT:  params.adults,
          CHILD:  params.children,
          INFANT: params.infants,
        },
        routeInfos: searchLegs(params).map((leg) => ({
          fromCityOrAirport: { code: leg.origin },
          toCityOrAirport:   { code: leg.destination },
          travelDate:        leg.date,
        })),
        searchModifiers: {
          isDirectFlight: false,
          ...(params.fareType && params.fareType !== "REGULAR" ? { pfts: params.fareType } : {}),
        },
      },
    });
  }

  async fareRules(fareId: string, sessionId?: string) {
    return this.request("/fms/v2/farerule", { id: fareId, flowType: "SEARCH" });
  }

  async validateFare(fareId: string) {
    return this.review([fareId]);
  }

  // Review one or more price IDs (1 one-way / COMBO, 2 domestic return, up to 6 multi-city).
  async review(priceIds: string[]) {
    const requestId = crypto.randomUUID();
    try {
      const raw = await this.request<any>("/fms/v1/review", { priceIds }, AbortSignal.timeout(20000));
      const result = raw?.data ?? raw?.result ?? raw;
      if (raw?.status?.success === false || result?.status?.success === false || result?.errors?.length) {
        throw reviewFailure(200, raw?.status?.success === false ? raw : result, requestId);
      }
      const bookingId = result?.bookingId;
      if (typeof bookingId !== "string" || !bookingId.trim()) {
        throw new TripjackReviewError("REVIEW_INVALID_RESPONSE", 502, requestId);
      }
      return { bookingId, result };
    } catch (err) {
      if (err instanceof TripjackReviewError) throw err;
      const code = err instanceof Error && /TimeoutError|AbortError/.test(err.name) ? "REVIEW_TIMEOUT" : "REVIEW_UNAVAILABLE";
      console.error("[tripjack-review]", JSON.stringify({ requestId, code }));
      throw new TripjackReviewError(code, 503, requestId);
    }
  }

  async book(params: HoldParams & BookParams) {
    const phone = params.contactPhone.replace(/\D/g, "");
    // TripJack contacts format: E.164 string e.g. "+919500112233"
    const contact = phone.length > 10 ? `+${phone}` : `+91${phone.slice(-10)}`;

    const travellerInfo = params.passengers.map((p) => ({
      // TripJack titles: Adult → Mr/Ms, Child/Infant → Master/Ms
      ti:  p.type !== "ADULT" ? (p.gender === "F" ? "Ms" : "Master") : (p.gender === "F" ? "Ms" : "Mr"),
      fN:  p.firstName,
      lN:  p.lastName,
      // TripJack requires full words: ADULT, CHILD, INFANT
      pt:  p.type,
      // TripJack v2 accepts YYYY-MM-DD for dob (HTML date input format)
      ...(p.dob            ? { dob: p.dob }                              : {}),
      // Only send passport fields when passport number is present
      ...(p.passportNumber ? {
        pNum: p.passportNumber,
        ...(p.passportExpiry ? { eD: p.passportExpiry }                  : {}),
        ...(p.nationality    ? { pNat: p.nationality }                   : {}),
        ...(p.passportIssueDate ? { pid: p.passportIssueDate }           : {}),
      } : {}),
      ...(p.panNumber  ? { pan: p.panNumber.toUpperCase() } : {}),
      ...(p.documentId ? { di: p.documentId }               : {}),
      ...(p.frequentFlyer && Object.keys(p.frequentFlyer).length ? { ff: p.frequentFlyer } : {}),
      ...(p.ssr?.baggage?.length ? { ssrBaggageInfos:      p.ssr.baggage } : {}),
      ...(p.ssr?.meal?.length    ? { ssrMealInfos:         p.ssr.meal }    : {}),
      ...(p.ssr?.seat?.length    ? { ssrSeatInfos:         p.ssr.seat }    : {}),
      ...(p.ssr?.extra?.length   ? { ssrExtraServiceInfos: p.ssr.extra }   : {}),
    }));
    const emergencyPhone = params.emergencyContact?.phone?.replace(/\D/g, "") ?? "";

    // paymentInfos.amount must equal the exact TF from the review response.
    // TripJack B2B deducts from the agent wallet, but the field is required.
    return this.request("/oms/v1/air/book", {
      bookingId: params.holdId,
      // A hold (ON_HOLD) is a book without paymentInfos; confirmHold() pays later.
      ...(params.holdOnly ? {} : { paymentInfos: [{ amount: params.paymentAmount }] }),
      deliveryInfo: {
        emails:   [params.contactEmail],
        contacts: [contact],
      },
      travellerInfo,
      ...(params.gstInfo ? {
        gstInfo: {
          gstNumber:      params.gstInfo.gstNumber.toUpperCase(),
          registeredName: params.gstInfo.registeredName.slice(0, 35),
          ...(params.gstInfo.email   ? { email: params.gstInfo.email }                     : {}),
          ...(params.gstInfo.mobile  ? { mobile: params.gstInfo.mobile.replace(/\D/g, "") } : {}),
          ...(params.gstInfo.address ? { address: params.gstInfo.address.slice(0, 70) }   : {}),
        },
      } : {}),
      ...(params.emergencyContact ? {
        contactInfo: {
          ecn: params.emergencyContact.name,
          ...(params.emergencyContact.email ? { emails: [params.emergencyContact.email] } : {}),
          ...(emergencyPhone ? { contacts: [emergencyPhone.length > 10 ? `+${emergencyPhone}` : `+91${emergencyPhone.slice(-10)}`] } : {}),
        },
      } : {}),
      // Some TripJack partner accounts require a remarks field; harmless when not required.
      remarks: "Direct booking",
    }, AbortSignal.timeout(25000));
  }

  // Pay for a held (ON_HOLD) booking before its time limit; amount = held TF.
  async confirmHold(bookingId: string, amount: number) {
    return this.request("/oms/v1/air/confirm-book", { bookingId, paymentInfos: [{ amount }] }, AbortSignal.timeout(30000));
  }

  // Release a held booking (customer changed their mind).
  async releaseHold(bookingId: string, pnrs: string[]) {
    return this.request("/oms/v1/air/unhold", { bookingId, pnrs }, AbortSignal.timeout(20000));
  }

  // Seat map for a reviewed booking — only when review conditions.isa = true.
  async seatMap(bookingId: string) {
    return this.request<any>("/fms/v1/seat", { bookingId }, AbortSignal.timeout(20000));
  }

  async pnrStatus(bookingId: string) {
    return this.request("/oms/v1/booking-details", { bookingId });
  }

  async ssrList(bookingId: string) {
    return this.request<any>("/oms/v1/air/ssr-list", { bookingId });
  }

  async addSsr(bookingId: string, ssrDetails: Array<{
    type:         "MEAL" | "BAGGAGE";
    key:          string;
    paxIndex:     number;
    segmentIndex?: number;
  }>) {
    return this.request("/oms/v1/air/ssr", {
      bookingId,
      ssrDetails: ssrDetails.map((s) => ({
        code:         s.key,
        type:         s.type,
        paxIndex:     s.paxIndex,
        segmentIndex: s.segmentIndex ?? 0,
      })),
    });
  }

  // Cancellation charges quote for a whole booking (no change is made).
  async amendmentCharges(bookingId: string) {
    return this.request<any>("/oms/v1/air/amendment/amendment-charges", {
      bookingId, type: "CANCELLATION", remarks: "Charges check before customer cancellation",
    }, AbortSignal.timeout(20000));
  }

  async submitCancellation(bookingId: string, remarks: string) {
    return this.request<any>("/oms/v1/air/amendment/submit-amendment", {
      bookingId, type: "CANCELLATION", remarks,
    }, AbortSignal.timeout(20000));
  }

  async amendmentDetails(amendmentId: string) {
    return this.request<any>("/oms/v1/air/amendment/amendment-details", { amendmentId }, AbortSignal.timeout(15000));
  }

  async cancel(bookingRef: string) {
    return this.request("/oms/v1/air/amendment/submit-amendment", {
      bookingId: bookingRef,
      type:      "CANCELLATION",
      remarks:   "Customer requested cancellation",
    });
  }

  // ── Hotels ──────────────────────────────────────────────────────

  async hotelSearch(params: HotelSearchParams) {
    return this.request("/hotel-search/v1", {
      searchQuery: {
        checkinDate:  params.checkIn,
        checkoutDate: params.checkOut,
        roomInfo:     params.rooms.map((r) => ({
          numberOfAdults: r.adults,
          numberOfChild:  r.children,
          childAge:       r.childAges ?? [],
        })),
        searchCriteria: {
          city:        params.cityCode,
          nationality: params.nationality,
          currency:    params.currency,
        },
        searchPreferences: {
          ratings:       params.ratings ?? [],
          freeBreakfast: params.freeBreakfast ?? false,
          freeCancel:    params.freeCancel    ?? false,
        },
      },
    });
  }

  async hotelPreBook(optionId: string) {
    return this.request("/hotel-prebook/v1", { optionId, fieldType: "DETAIL" });
  }

  async hotelBook(params: HotelBookParams) {
    return this.request("/hotel-book/v1", {
      optionId: params.optionId,
      travellerInfo: params.guests.map((g) => ({
        ti:       g.title,
        fN:       g.firstName,
        lN:       g.lastName,
        pt:       g.type,
        age:      g.age,
        roomIndex: g.roomIndex,
      })),
      deliveryInfo: {
        emails:  [params.contactEmail],
        mobiles: [{ countryCode: "+91", number: params.contactPhone }],
      },
    });
  }

  async hotelBookingDetail(bookingId: string) {
    return this.request("/hotel-booking-detail/v1", { bookingId });
  }

  async hotelCancel(bookingId: string) {
    return this.request("/hotel-cancel/v1", { bookingId });
  }
}

// Search legs: explicit multi-city legs, else one-way / round trip from origin + dates.
export function searchLegs(params: SearchParams): { origin: string; destination: string; date: string }[] {
  if (params.legs?.length) return params.legs.slice(0, 6);
  const out = [{ origin: params.origin, destination: params.destination, date: params.departureDate }];
  if (params.tripType === "ROUNDTRIP" && params.returnDate) {
    out.push({ origin: params.destination, destination: params.origin, date: params.returnDate });
  }
  return out;
}
