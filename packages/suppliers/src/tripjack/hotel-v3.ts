// TripJack Hotel API v3 (API-OUT).
//
// Flow: Listing (by hotel IDs) → Pricing/Detail (one hotel) → Review → Book →
// Booking Details (poll until terminal). Every call carries the same
// client-generated correlationId from Listing to Review.
//
// Calls go through the Poomas TripJack gateway (fixed, whitelisted IP), which
// forwards /hms/* to the hotel search host and /oms/v3/hotel/* to the hotel
// booker host. Auth is the `apikey` header.

import type { SupplierCredentials } from "../base.js";
import type { ExchangeRecorder, SupplierExchange } from "./client.js";

export interface HotelV3Room {
  adults:    number;
  children?: number;
  childAge?: number[];
}

export interface HotelV3Pricing {
  totalPrice:     number;
  basePrice:      number;
  discount:       number;
  taxes:          number;
  mf:             number;   // management fee
  mft:            number;   // management fee tax
  currency:       string;
  strikethrough?: number;
}

export interface HotelV3Penalty { from: string; to: string; amount: number }

export interface HotelV3Option {
  optionId:     string;
  optionType:   "SRSM" | "SRCM" | "CRSM" | "CRCM" | string;
  roomInfo:     { id: string; name: string; adults?: number; children?: number }[];
  inclusions:   string[];
  mealBasis:    string;
  bookingNotes?: string;
  pricing:      HotelV3Pricing;
  commercial:   { type: string; commission: number };
  compliance:   { gstType: string; panRequired: boolean; passportRequired: boolean };
  cancellation: { isRefundable: boolean; penalties: HotelV3Penalty[]; deadlineDateTime?: string };
}

export interface HotelV3ListingHotel { hotelId: string; name: string; options: HotelV3Option[] }

// Validate before coercion: missing IDs and sentinel strings are never supplier IDs.
export function validHotelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value)
    && !["undefined", "null"].includes(value.toLowerCase());
}

export interface HotelV3Content {
  tjHotelId:   string;
  name:        string;
  starRating:  number;
  address:     string;
  city:        string;
  countryCode: string;
  lat?:        number;
  lng?:        number;
  images:      string[];
  amenities:   string[];
  headline?:   string;
}

// Error with everything Admin → Supplier logs needs.
export class TripjackHotelError extends Error {
  statusCode?:      number;
  code?:            string;
  endpoint!:        string;
  responseSnippet?: string;
  constructor(message: string, init: { endpoint: string; statusCode?: number; code?: string; responseSnippet?: string }) {
    super(message);
    this.name = "TripjackHotelError";
    Object.assign(this, init);
  }
}

// TripJack v3 error codes the UI reacts to.
export const HOTEL_ERROR = {
  SESSION_EXPIRED: ["SEARCH_SESSION_EXPIRED", "6502"],
  SOLD_OUT:        ["OPTION_SOLD_OUT", "6506", "6515"],
  PRICE_CHANGED:   ["PRICE_CHANGED", "6535"],
} as const;

export function isHotelError(err: unknown, kind: keyof typeof HOTEL_ERROR): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  return (HOTEL_ERROR[kind] as readonly string[]).includes(code);
}

export class TripjackHotelV3Client {
  private baseUrl:  string;
  private apiKey:   string;
  private proxyKey: string;
  private recorder?: ExchangeRecorder;

  constructor(creds: SupplierCredentials) {
    this.baseUrl  = String(creds.baseUrl ?? "").replace(/\/$/, "");
    this.apiKey   = String(creds.apiKey ?? "");
    this.proxyKey = String(creds.proxyKey ?? "");
    this.recorder = typeof creds.recorder === "function" ? creds.recorder as ExchangeRecorder : undefined;
  }

  // Raw request / response capture for Admin → API logs (same format as flights).
  setRecorder(recorder: ExchangeRecorder | undefined) { this.recorder = recorder; }

  private record(x: SupplierExchange) {
    try { this.recorder?.(x); } catch (err) { console.error("[tripjack-hotel] exchange recorder failed", err); }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.baseUrl || (!this.apiKey && !this.proxyKey)) {
      throw new TripjackHotelError("TripJack hotel API is not configured (gateway URL / API key missing)", { endpoint: path, code: "NOT_CONFIGURED" });
    }
    const endpoint = path.split("?")[0];
    const url = `${this.baseUrl}${path}`;
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(this.apiKey ? { apikey: this.apiKey } : {}),
      ...(this.proxyKey ? { "X-Poomas-Gateway-Key": this.proxyKey } : {}),
    };
    const requestBody = body !== undefined ? JSON.stringify(body) : "";
    const startedAt = new Date();
    const exchange = (status: number | null, responseHeaders: Record<string, string>, responseBody: string | null, error?: string): SupplierExchange => ({
      supplier: "TRIPJACK", endpoint, url, method, requestHeaders, requestBody,
      status, responseHeaders, responseBody, error, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
    });
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: requestHeaders,
        ...(body !== undefined ? { body: requestBody } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this.record(exchange(null, {}, null, err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
      const timeout = (err as Error)?.name === "TimeoutError";
      throw new TripjackHotelError(timeout ? `TripJack hotel API timed out after ${timeoutMs} ms` : `Could not reach the TripJack gateway: ${(err as Error)?.message ?? err}`,
        { endpoint, code: timeout ? "TIMEOUT" : "NETWORK_ERROR" });
    }
    const text = await res.text();
    this.record(exchange(res.status, Object.fromEntries(res.headers), text));
    let json: any = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON (proxy HTML) */ }

    const envelope = json?.error && typeof json.error === "object" ? json.error : null;
    const failed = !res.ok || json?.status?.success === false || envelope;
    if (failed) {
      const code = String(envelope?.code ?? json?.errors?.[0]?.errCode ?? (typeof json?.error === "string" ? json.error : "") ?? "") || `HTTP_${res.status}`;
      const message = envelope?.message ?? json?.errors?.[0]?.message ?? json?.status?.statusMessage
        ?? (typeof json?.error === "string" ? json.error : "") ?? "";
      throw new TripjackHotelError(
        `TripJack hotel ${endpoint} failed (HTTP ${res.status}${code ? `, ${code}` : ""})${message ? `: ${message}` : ""}`,
        { endpoint, statusCode: res.status, code, responseSnippet: text.slice(0, 1500) },
      );
    }
    if (json === null) {
      throw new TripjackHotelError(`TripJack hotel ${endpoint} returned a non-JSON response`, { endpoint, statusCode: res.status, code: "INVALID_RESPONSE", responseSnippet: text.slice(0, 1500) });
    }
    return json as T;
  }

  // ── Dynamic (search → detail → review) ────────────────────────────────────

  listing(req: { checkIn: string; checkOut: string; rooms: HotelV3Room[]; currency: string; correlationId: string; nationality: string; hids: (string | number)[]; timeoutMs?: number }) {
    return this.request<{ hotels?: HotelV3ListingHotel[]; totalResults?: number; correlationId?: string }>(
      "POST", "/hms/v3/hotel/listing", { ...req, hids: req.hids.map((h) => Number(h)) }, (req.timeoutMs ?? 13_000) + 7_000);
  }

  pricing(req: { correlationId: string; hid: string; checkIn: string; checkOut: string; rooms: HotelV3Room[]; currency: string; nationality: string; timeoutMs?: number }) {
    if (!validHotelId(req.hid)) {
      throw new TripjackHotelError("Invalid TripJack hotel ID", { endpoint: "/hms/v3/hotel/pricing", code: "INVALID_HOTEL_ID" });
    }
    return this.request<{ tjHotelId: string; hotelName: string; options?: HotelV3Option[]; reviewHash: string }>(
      "POST", "/hms/v3/hotel/pricing", req, (req.timeoutMs ?? 13_000) + 7_000);
  }

  review(req: { correlationId: string; optionId: string; reviewHash: string; hid: string }) {
    return this.request<{ bookingId: string; tjHotelId: string; hotelName: string; option: HotelV3Option; onholdAllowed?: string | boolean }>(
      "POST", "/hms/v3/hotel/review", req);
  }

  // ── Booking (booker host) ─────────────────────────────────────────────────

  book(req: {
    bookingId: string;
    roomTravellerInfo: { travellerInfo: { ti: string; pt: "ADULT" | "CHILD"; fN: string; lN: string; pan?: string; pNum?: string }[] }[];
    deliveryInfo: { emails: string[]; contacts: string[]; code: string[] };
    gstInfo?: { gstNumber: string; registeredName: string };
    paymentInfos?: { amount: number }[];   // omit for a Hold booking
  }) {
    return this.request<{ bookingId: string; status: { success: boolean } }>("POST", "/oms/v3/hotel/book", { ...req, type: "HOTEL" }, 60_000);
  }

  confirmBook(bookingId: string, amount: number) {
    return this.request<{ bookingId?: string; status: { success: boolean } }>("POST", "/oms/v3/hotel/confirm-book", { bookingId, paymentInfos: [{ amount }] }, 60_000);
  }

  bookingDetails(bookingId: string) {
    return this.request<any>("POST", "/oms/v3/hotel/booking-details", { bookingId });
  }

  cancel(bookingId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(bookingId)) throw new TripjackHotelError("Invalid booking ID", { endpoint: "/oms/v3/hotel/cancel-booking", code: "INVALID_BOOKING_ID" });
    return this.request<{ status: { success: boolean } }>("POST", `/oms/v3/hotel/cancel-booking/${bookingId}`);
  }

  bookingList(startDate: string, endDate: string) {
    return this.request<{ bookings?: any[] }>("POST", "/oms/v1/hotel/bookings", { startDate, endDate });
  }

  // ── Static content ────────────────────────────────────────────────────────

  async nationalities() {
    try {
      return await this.request<{ nationalityInfos?: { countryId: string; code: string; name: string; dialCode: string }[] }>("GET", "/hms/v3/nationality-info");
    } catch {
      // UAT documents this endpoint on the flight host.
      return this.request<{ nationalityInfos?: { countryId: string; code: string; name: string; dialCode: string }[] }>("GET", "/tj-main/hms/v3/nationality-info");
    }
  }

  staticDetail(hid: string) {
    return this.request<any>("POST", "/hms/v3/hotel/static-detail", { hid });
  }

  hotelContent(hotelIds: string[]) {
    return this.request<{ hotels?: any[] }>("POST", "/hms/v3/content/fetch-hotel-content", { hotelIds: hotelIds.slice(0, 100) });
  }

  hotelMapping(req: { regionIds?: string[]; countryName?: string; page: number; size: number }) {
    return this.request<{ hotels?: { tjHotelId: string; unicaId: string }[]; pageable?: { totalPages?: number } }>(
      "POST", "/hms/v3/content/fetch-hotel-mapping", req);
  }

  cityRegionIds(limit: number, cursor?: string) {
    const q = new URLSearchParams({ limit: String(Math.min(limit, 2000)), ...(cursor ? { cursor } : {}) });
    return this.request<{ hotelCityRegionIds?: { cityName: string; cityRegionId: number; countryName: string; fullRegionName?: string }[]; nextCursor?: string; hasMore?: boolean }>(
      "GET", `/hms/v3/content/fetch-city-regionIds?${q}`, undefined, 45_000);
  }

  countries() {
    return this.request<{ hotelCountries?: string[] }>("GET", "/hms/v3/content/fetch-countries");
  }
}

// ── Normalisers ────────────────────────────────────────────────────────────

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function normalizeOption(o: any): HotelV3Option {
  return {
    optionId:     String(o?.optionId ?? ""),
    optionType:   String(o?.optionType ?? ""),
    roomInfo:     Array.isArray(o?.roomInfo) ? o.roomInfo.map((r: any) => ({ id: String(r?.id ?? ""), name: String(r?.name ?? ""), adults: r?.adults, children: r?.children })) : [],
    inclusions:   Array.isArray(o?.inclusions) ? o.inclusions.map(String) : [],
    mealBasis:    String(o?.mealBasis ?? ""),
    bookingNotes: o?.bookingNotes ? String(o.bookingNotes) : undefined,
    pricing: {
      totalPrice: num(o?.pricing?.totalPrice), basePrice: num(o?.pricing?.basePrice), discount: num(o?.pricing?.discount),
      taxes: num(o?.pricing?.taxes), mf: num(o?.pricing?.mf), mft: num(o?.pricing?.mft),
      currency: String(o?.pricing?.currency ?? "INR"),
      ...(o?.pricing?.strikethrough ? { strikethrough: num(o.pricing.strikethrough) } : {}),
    },
    commercial:   { type: String(o?.commercial?.type ?? ""), commission: num(o?.commercial?.commission) },
    compliance:   {
      gstType: String(o?.compliance?.gstType ?? "NA"),
      // TripJack has used several spellings for this flag.
      panRequired: [o?.compliance?.panRequired, o?.compliance?.isPanRequired, o?.compliance?.panMandatory, o?.isPanRequired]
        .some((v) => v === true || v === "true"),
      passportRequired: o?.compliance?.passportRequired === true,
    },
    cancellation: {
      isRefundable: o?.cancellation?.isRefundable === true,
      penalties: Array.isArray(o?.cancellation?.penalties)
        ? o.cancellation.penalties.map((p: any) => ({ from: String(p?.from ?? ""), to: String(p?.to ?? ""), amount: num(p?.amount) }))
        : [],
      ...(o?.cancellation?.deadlineDateTime ? { deadlineDateTime: String(o.cancellation.deadlineDateTime) } : {}),
    },
  };
}

function imageHref(img: any): string {
  const links = img?.links ?? {};
  for (const key of ["XXL", "XL", "Standard", "original", "1000px", "350px", "200px"]) {
    if (links[key]?.href) return String(links[key].href);
  }
  const first = Object.values(links)[0] as { href?: string } | undefined;
  return first?.href ? String(first.href) : "";
}

export function normalizeContent(h: any): HotelV3Content {
  const addr = h?.locale?.address ?? {};
  const images: any[] = Array.isArray(h?.images) ? h.images : [];
  const hero = images.filter((i) => i?.is_hero_image || i?.hero_image);
  const amenityList = h?.amenities && typeof h.amenities === "object" ? Object.values(h.amenities) as any[] : [];
  return {
    tjHotelId:   String(h?.tjHotelId ?? ""),
    name:        String(h?.name ?? ""),
    starRating:  num(h?.star_rating),
    address:     String(addr.fulladdr ?? [addr.line_1, addr.city].filter(Boolean).join(", ")),
    city:        String(addr.city ?? ""),
    countryCode: String(addr.countrycode ?? ""),
    lat:         h?.locale?.coordinates?.lat,
    lng:         h?.locale?.coordinates?.long,
    images:      [...hero, ...images.filter((i) => !hero.includes(i))].map(imageHref).filter(Boolean).slice(0, 8),
    amenities:   amenityList.map((a) => String(a?.name ?? "")).filter(Boolean).slice(0, 20),
    headline:    h?.descriptions?.headline ? String(h.descriptions.headline) : undefined,
  };
}

// Booking Details → customer / admin view.
export function parseHotelBookingDetails(raw: any) {
  const order = raw?.order ?? {};
  const h = raw?.itemInfos?.HOTEL ?? {};
  const info = h.hInfo ?? {};
  const op = Array.isArray(info.ops) ? info.ops[0] ?? {} : {};
  return {
    bookingId:      String(order.bookingId ?? ""),
    status:         String(order.status ?? "").toUpperCase(),
    amount:         num(order.amount),
    createdOn:      order.createdOn ?? null,
    confirmationNo: raw?.hotelConfirmationNumber ?? null,
    hotelName:      String(info.name ?? ""),
    hotelId:        info.tjid ?? null,
    rating:         num(info.rt),
    address:        [info.ad?.adr, info.ad?.city?.name ?? info.ad?.ctn, info.ad?.country?.name ?? info.ad?.cn].filter(Boolean).join(", "),
    checkIn:        h.query?.checkinDate ?? null,
    checkOut:       h.query?.checkoutDate ?? null,
    checkInTime:    info.checkInTime?.beginTime ?? null,
    checkOutTime:   info.checkOutTime?.beginTime ?? null,
    holdDeadline:   op.ddt ?? null,
    totalPrice:     num(op.tp),
    currency:       String(op.sc ?? ""),
    refundable:     op.cnp?.ifra === true,
    penalties:      Array.isArray(op.cnp?.pd) ? op.cnp.pd.map((p: any) => ({ from: p?.fdt, to: p?.tdt, amount: num(p?.am) })) : [],
    rooms:          Array.isArray(op.ris) ? op.ris.map((r: any) => ({
      name: String(r?.srn ?? r?.rt ?? r?.rc ?? ""), mealBasis: String(r?.mb ?? ""), adults: num(r?.adt), children: num(r?.chd),
      guests: Array.isArray(r?.ti) ? r.ti.map((t: any) => `${t?.ti ?? ""} ${t?.fN ?? ""} ${t?.lN ?? ""}`.replace(/\s+/g, " ").trim()) : [],
    })) : [],
  };
}

export const HOTEL_TERMINAL_STATUSES = ["SUCCESS", "ON_HOLD", "ABORTED", "FAILED", "CANCELLED"];
