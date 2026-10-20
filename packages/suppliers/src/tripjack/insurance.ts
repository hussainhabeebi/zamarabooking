// TripJack TripSafe (travel insurance) API v2.
//
// Booking flow:   Search → Create Booking → Get Booking Detail (policy IDs + COI links)
// Amendment flow: Raise (priced quote) → Confirm → Get Booking Detail
//
// Calls go through the Poomas TripJack gateway (fixed, whitelisted IP), which
// forwards /insurance/v2/* 1:1 to TripJack's main host. Auth is the `apikey`
// header. Every exchange is handed to the recorder verbatim so TripJack
// certification logs can be produced (separate request / response JSON files).

import type { SupplierCredentials } from "../base.js";
import type { ExchangeRecorder, SupplierExchange } from "./client.js";

type Rec = Record<string, any>;

// ── Request / response types ────────────────────────────────────────────────

export type TripsafeJourney = "STANDALONE" | "DOMESTIC" | "STUDENT" | "AMT" | "EMBEDDED";
export type TripsafeDestinationType = "COUNTRY" | "REGION" | "POPULARREGION";

export interface TripsafeDestination { key: string; type: TripsafeDestinationType }

export interface TripsafeSearchRequest {
  startDate:         string;
  endDate?:          string;
  travellerDobs:     string[];
  destinations:      TripsafeDestination[];
  planType?:         string;
  journeyType?:      "DOMESTIC" | "INTERNATIONAL" | "ALL";
  searchId?:         string;
  coverageDuration?: number;
  funnelType?:       "STANDALONE" | "EMBEDDED" | "STUDENT" | "AMT" | "API_EMB";
}

export interface TripsafeBenefit {
  name: string; type?: string; visibility?: string; iconCategory?: string;
  benefitProvider?: string; description?: string; sumInsured?: string;
}

export interface TripsafeProduct {
  productId:           string;
  planCoverage:        string;
  insuranceProvider:   string;
  assistanceProviders: string[];
  regionName:          string;
  planType:            string;
  totalFare:           number;
  agentCommission:     number;
  banners:             string[];
  benefits:            TripsafeBenefit[];
  paxFares:            { age: number; totalFare: number; components: Record<string, number> }[];
}

export interface TripsafeTraveller {
  id?:                  number;
  dob:                  string;
  age?:                 number;
  title?:               string;
  firstName:            string;
  lastName:             string;
  emailId?:             string;
  passportNumber?:      string;
  passportNationality?: string;
  contactNumber?:       string;
  pinCode?:             string;
  gender?:              string;
  nomineeInfo?:         { nomineeName: string; nomineeRelationship?: string }[];
  isInsuranceOpted?:    boolean;
}

export interface TripsafeBookRequest {
  searchId:        string;
  productId:       string;
  travellerInfos:  TripsafeTraveller[];
  deliveryInfo?:   { code?: string[]; emails?: string[]; contacts?: string[] };
  paymentOptions?: { payUserId: string; paymentMedium: "WALLET" | "CREDIT_LINE" };
}

export interface TripsafeBookResult {
  bookingId:      string;
  status:         string;
  tnc?:           { assistance?: string; insurance?: string; tripjack?: string };
  paymentResult?: { status?: string; errorCode?: string; errorMessage?: string };
}

export interface TripsafeAmendmentItem {
  amendmentId: string; bookingId: string; amendmentType: string; status: string;
  amount?: number; createdOn?: string; processedOn?: string; additionalInfo?: Rec; modifiedInfo?: Rec;
}

export interface TripsafeAmendmentResult {
  amendmentItems?: TripsafeAmendmentItem[];
  insuranceCancellationResponse?: { totalAmountToRefund?: number; insuranceInfo?: Rec; cancellationTravellerKeys?: Rec };
  errorMessage?: string;
}

export type TripsafeAmendmentRequest = {
  bookingId:    string;
  amendmentId?: string;
  remarks?:     string;
} & (
  | { type: "CANCELLATION"; travellerKeys: Record<string, Record<string, { id: number }[]>> }
  | { type: "CORRECTION"; insuranceUpdateRequest: { amendedTravellerInfos?: Rec[]; startDate?: string; endDate?: string } }
);

export interface TripsafeConfirmRequest {
  bookingId:        string;
  amendmentId:      string;
  type:             "CANCELLATION" | "CORRECTION";
  remarks?:         string;
  paymentRequests?: { amount: number; paymentMedium: "WALLET" | "CREDIT_LINE" }[];
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class TripsafeError extends Error {
  statusCode?:      number;
  code?:            string;
  endpoint!:        string;
  responseSnippet?: string;
  constructor(message: string, init: { endpoint: string; statusCode?: number; code?: string; responseSnippet?: string }) {
    super(message);
    this.name = "TripsafeError";
    Object.assign(this, init);
  }
}

// ── Business rules (TripSafe v2 validation rules + UAT search matrix) ──────

export const TRIPSAFE_STUDENT_DURATIONS = [30, 60, 90, 120, 180, 240, 270, 365, 730];
export const TRIPSAFE_AMT_DURATIONS = [30, 45, 60, 90];
export const TRIPSAFE_REGIONS: Record<string, string> = {
  MDE: "Middle East", EUR: "Europe", SCH: "Schengen", USC: "USA / Canada", ASI: "Asia",
};
export const TRIPSAFE_BLOCKED_COUNTRIES = ["MM", "IR", "KP", "NK"];
export const TRIPSAFE_MAX_TRAVELLERS = 10;
export const TRIPSAFE_MAX_AGE = 70;
export const TRIPSAFE_NOMINEE_RELATIONSHIPS = ["LEGAL_HEIR", "FATHER", "MOTHER", "SISTER", "SPOUSE", "BROTHER", "DAUGHTER", "SON"];

const DAY = 86_400_000;
const isoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const utc = (v: string) => Date.parse(`${v}T00:00:00Z`);
export const addDays = (v: string, days: number) => new Date(utc(v) + days * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY);

export function ageOn(dob: string, on: string): number {
  const [y, m, d] = dob.split("-").map(Number);
  const [oy, om, od] = on.split("-").map(Number);
  return oy - y - (om < m || (om === m && od < d) ? 1 : 0);
}

export interface TripsafeTripInput {
  journey:           TripsafeJourney;
  startDate:         string;
  endDate?:          string;
  coverageDuration?: number;
  destinations:      TripsafeDestination[];
  travellerDobs:     string[];
  searchId?:         string;
}

// Problems TripJack would reject — checked before calling so customers get a
// clear message. Empty list = OK.
export function tripsafeProblems(input: TripsafeTripInput, today = new Date().toISOString().slice(0, 10)): string[] {
  const problems: string[] = [];
  const { journey, startDate, endDate, coverageDuration, destinations, travellerDobs } = input;

  if (!isoDate(startDate)) problems.push("Start date must be a valid date (yyyy-MM-dd).");
  else if (startDate < today) problems.push("Start date must be today or later.");

  if (!travellerDobs.length) problems.push("Add at least one traveller.");
  if (travellerDobs.length > TRIPSAFE_MAX_TRAVELLERS) problems.push(`A maximum of ${TRIPSAFE_MAX_TRAVELLERS} travellers is allowed per policy.`);
  travellerDobs.forEach((dob, i) => {
    if (!isoDate(dob) || dob > today) problems.push(`Traveller ${i + 1}: date of birth is not valid.`);
    else if (isoDate(startDate)) {
      const age = ageOn(dob, startDate);
      if (age > TRIPSAFE_MAX_AGE) problems.push(`Traveller ${i + 1}: travellers above ${TRIPSAFE_MAX_AGE} years can't be insured.`);
      if (journey === "STUDENT" && (age < 18 || age > 45)) problems.push(`Traveller ${i + 1}: student plans cover ages 18–45 (age ${age}).`);
    }
  });

  if (journey !== "DOMESTIC" && !destinations.length) problems.push("Select at least one destination.");
  const blocked = destinations.filter((d) => TRIPSAFE_BLOCKED_COUNTRIES.includes(d.key.toUpperCase()));
  if (blocked.length) problems.push(`TripSafe does not cover ${blocked.map((d) => d.key.toUpperCase()).join(", ")}.`);

  const needsEnd = journey === "STANDALONE" || journey === "DOMESTIC" || journey === "EMBEDDED";
  if (needsEnd) {
    if (!endDate || !isoDate(endDate)) problems.push("End date is required.");
    else if (isoDate(startDate) && endDate < startDate) problems.push("End date must be on or after the start date.");
    else if (isoDate(startDate)) {
      const days = daysBetween(startDate, endDate) + 1;
      if (journey === "DOMESTIC" && days > 30) problems.push("Domestic cover is limited to 30 days.");
      if (journey !== "DOMESTIC" && days > 180) problems.push("Cover can't exceed 180 days from the start date.");
    }
  }

  if (journey === "STUDENT") {
    if (!coverageDuration || !TRIPSAFE_STUDENT_DURATIONS.includes(coverageDuration)) {
      problems.push(`Student plans need a duration of ${TRIPSAFE_STUDENT_DURATIONS.join(" / ")} days.`);
    }
    if (destinations.some((d) => d.type !== "COUNTRY")) problems.push("Student plans cover a country, not a region.");
    if (destinations.length > 1) problems.push("Student plans cover one country only.");
  }

  if (journey === "AMT") {
    if (!coverageDuration || !TRIPSAFE_AMT_DURATIONS.includes(coverageDuration)) {
      problems.push(`Annual multi-trip plans cover each trip for ${TRIPSAFE_AMT_DURATIONS.join(" / ")} days.`);
    }
    if (destinations.some((d) => d.type === "COUNTRY")) problems.push("Annual multi-trip plans cover regions, not countries.");
  }

  if (journey === "DOMESTIC" && destinations.some((d) => d.key.toUpperCase() !== "IN")) {
    problems.push("Domestic cover is for trips within India only.");
  }
  return problems;
}

// Builds the TripJack search body for a journey (matches the v2 samples).
export function tripsafeSearchBody(input: TripsafeTripInput): TripsafeSearchRequest {
  const destinations = input.destinations.map((d) => ({ key: d.key.toUpperCase(), type: d.type }));
  const base = {
    startDate:     input.startDate,
    travellerDobs: input.travellerDobs,
    ...(input.searchId ? { searchId: input.searchId } : {}),
  };
  switch (input.journey) {
    case "DOMESTIC":
      return { ...base, endDate: input.endDate, destinations: [{ key: "IN", type: "COUNTRY" }], journeyType: "DOMESTIC" };
    case "STUDENT":
      // endDate must not be sent: the duration goes in coverageDuration.
      return { ...base, destinations, coverageDuration: input.coverageDuration, planType: "STUDENT" };
    case "AMT":
      return {
        ...base, coverageDuration: input.coverageDuration, planType: "AMT",
        destinations: destinations.map((d) => ({ key: d.key, type: d.type === "COUNTRY" ? d.type : "POPULARREGION" })),
      };
    case "EMBEDDED":
      return { ...base, endDate: input.endDate, destinations, funnelType: "EMBEDDED" };
    default:
      return { ...base, endDate: input.endDate, destinations, funnelType: "STANDALONE" };
  }
}

// ── Normalizers ─────────────────────────────────────────────────────────────

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function normalizeTripsafeProduct(p: Rec): TripsafeProduct {
  const benefits: TripsafeBenefit[] = Array.isArray(p?.productBenefits) ? p.productBenefits : [];
  // Insurance and assistance benefits are usually duplicated; show each name once.
  const seen = new Set<string>();
  const unique = benefits.filter((b) => {
    const key = `${b.visibility}|${b.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    productId:           String(p?.productId ?? p?.id ?? ""),
    planCoverage:        String(p?.planCoverage ?? p?.productName ?? ""),
    insuranceProvider:   String(p?.insuranceProvider ?? ""),
    assistanceProviders: Array.isArray(p?.assistanceProviders) ? p.assistanceProviders.map(String) : [],
    regionName:          String(p?.regionName ?? ""),
    planType:            String(p?.planType ?? "REGULAR"),
    totalFare:           num(p?.fareDetails?.totalFare),
    agentCommission:     num(p?.fareDetails?.agentCommission),
    banners:             unique.filter((b) => b.visibility === "BANNER").map((b) => b.name),
    benefits:            unique.filter((b) => b.visibility !== "BANNER"),
    paxFares: (Array.isArray(p?.paxFareDetails) ? p.paxFareDetails : []).map((x: Rec) => ({
      age: num(x?.age), totalFare: num(x?.insuranceFareComponents?.TF), components: x?.insuranceFareComponents ?? {},
    })),
  };
}

export interface TripsafePolicy {
  travellerId:  number | null;
  name:         string;
  dob?:         string;
  age?:         number;
  policyId?:    string;
  coiFileName?: string;
  coiUrl?:      string;
  totalFare?:   number;
  raw:          Rec;
}

export interface TripsafeBookingDetails {
  bookingId:         string;
  status:            string;
  searchId?:         string;
  productId?:        string;
  startDate?:        string;
  endDate?:          string;
  productIdentifier?: string;
  planCoverage?:     string;
  insuranceProvider?: string;
  assistanceProviders: string[];
  regionName?:       string;
  totalAmount?:      number;
  tnc?:              { assistance?: string; insurance?: string; tripjack?: string };
  travellers:        TripsafePolicy[];
  benefits:          TripsafeBenefit[];
}

export const TRIPSAFE_TERMINAL_STATUSES = ["SUCCESS", "CANCELLED", "ABORTED", "PAYMENT_FAILED", "UNCONFIRMED"];

export function parseTripsafeBooking(d: Rec): TripsafeBookingDetails {
  const pi = d?.productInfo ?? {};
  const travellers: Rec[] = Array.isArray(pi?.insuranceTravellerInfos) ? pi.insuranceTravellerInfos : [];
  return {
    bookingId:           String(d?.bookingId ?? ""),
    status:              String(d?.status ?? "UNKNOWN"),
    searchId:            d?.searchId,
    productId:           d?.productId ?? pi?.id,
    startDate:           d?.startDate,
    endDate:             d?.endDate,
    productIdentifier:   d?.productIdentifier ?? pi?.productIdentifier,
    planCoverage:        pi?.productName,
    insuranceProvider:   pi?.insuranceProvider,
    assistanceProviders: Array.isArray(pi?.assistanceProviders) ? pi.assistanceProviders.map(String) : [],
    regionName:          pi?.regionName,
    totalAmount:         typeof d?.totalAmount === "number" ? d.totalAmount : undefined,
    tnc:                 d?.tnc,
    travellers: travellers.map((t) => ({
      travellerId: typeof t?.id === "number" ? t.id : t?.id != null ? Number(t.id) : null,
      name:        [t?.title, t?.firstName, t?.lastName].filter(Boolean).join(" "),
      dob:         t?.dob,
      age:         t?.age,
      policyId:    t?.policyId,
      coiFileName: t?.coiFileName,
      coiUrl:      t?.coiUrl,
      totalFare:   t?.fareDetail?.fareComponents?.TF,
      raw:         t,
    })),
    benefits: (Array.isArray(pi?.productBenefits) ? pi.productBenefits : []).filter((b: Rec) => b?.visibility !== "BANNER"),
  };
}

// ── Client ──────────────────────────────────────────────────────────────────

export class TripjackInsuranceClient {
  private baseUrl:   string;
  private apiKey:    string;
  private proxyKey:  string;
  private recorder?: ExchangeRecorder;

  constructor(creds: SupplierCredentials) {
    this.baseUrl  = String(creds.baseUrl ?? "").replace(/\/$/, "");
    this.apiKey   = String(creds.apiKey ?? "");
    this.proxyKey = String(creds.proxyKey ?? "");
    this.recorder = typeof creds.recorder === "function" ? creds.recorder as ExchangeRecorder : undefined;
  }

  setRecorder(recorder: ExchangeRecorder | undefined) { this.recorder = recorder; }

  private record(x: SupplierExchange) {
    try { this.recorder?.(x); } catch (err) { console.error("[tripsafe] exchange recorder failed", err); }
  }

  // `envelope`: search / booking / detail wrap data in { success, data, error };
  // the amendment APIs return the object directly on success.
  private async request<T>(method: "GET" | "POST", path: string, body: unknown, envelope: boolean): Promise<T> {
    // TripJack: endpoints must not end with a trailing slash.
    const endpoint = path.replace(/\/+$/, "");
    if (!this.baseUrl || (!this.apiKey && !this.proxyKey)) {
      throw new TripsafeError("TripSafe is not configured (TripJack gateway URL / API key missing)", { endpoint, code: "NOT_CONFIGURED" });
    }
    const url = `${this.baseUrl}${endpoint}`;
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...(this.apiKey ? { apikey: this.apiKey } : {}),
      ...(this.proxyKey ? { "X-Poomas-Gateway-Key": this.proxyKey } : {}),
    };
    const requestBody = method === "POST" ? JSON.stringify(body ?? {}) : "";
    const startedAt = new Date();
    const exchange = (status: number | null, responseHeaders: Record<string, string>, responseBody: string | null, error?: string): SupplierExchange => ({
      supplier: "TRIPJACK", endpoint, url, method, requestHeaders, requestBody,
      status, responseHeaders, responseBody, error, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method, headers: requestHeaders,
        ...(method === "POST" ? { body: requestBody } : {}),
        signal: AbortSignal.timeout(60_000),   // TripSafe timeout: 60 s
      });
    } catch (err) {
      const timeout = (err as Error)?.name === "TimeoutError";
      this.record(exchange(null, {}, null, err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
      throw new TripsafeError(timeout ? "TripSafe timed out after 60 s" : `Could not reach the TripJack gateway: ${(err as Error)?.message ?? err}`,
        { endpoint, code: timeout ? "TIMEOUT" : "NETWORK_ERROR" });
    }
    const text = await res.text();
    this.record(exchange(res.status, Object.fromEntries(res.headers), text));

    let json: Rec | null = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON (proxy HTML) */ }
    const snippet = text.slice(0, 1500);

    if (json === null) {
      throw new TripsafeError(`TripSafe ${endpoint} returned a non-JSON response (HTTP ${res.status})`,
        { endpoint, statusCode: res.status, code: res.ok ? "INVALID_RESPONSE" : `HTTP_${res.status}`, responseSnippet: snippet });
    }
    // 401: raw auth error shape { path, error, message, timestamp, status }.
    if (res.status === 401) {
      throw new TripsafeError(`TripSafe ${endpoint} unauthorised: ${json.message ?? json.error ?? "invalid API key"}`,
        { endpoint, statusCode: 401, code: "UNAUTHORIZED", responseSnippet: snippet });
    }
    const err = json.error && typeof json.error === "object" ? json.error : null;
    if (!res.ok || json.success === false || err) {
      const code = String(err?.code ?? (typeof json.error === "string" ? json.error : "") ?? "") || `HTTP_${res.status}`;
      const message = String(err?.message ?? json.message ?? json.errorMessage ?? "");
      throw new TripsafeError(`TripSafe ${endpoint} failed (HTTP ${res.status}, ${code})${message ? `: ${message}` : ""}`,
        { endpoint, statusCode: res.status, code, responseSnippet: snippet });
    }
    if (!envelope) {
      if (json.errorMessage && !json.amendmentItems?.length) {
        throw new TripsafeError(`TripSafe ${endpoint} failed: ${json.errorMessage}`,
          { endpoint, statusCode: res.status, code: "AMENDMENT_FAILED", responseSnippet: snippet });
      }
      return json as T;
    }
    return (json.data ?? {}) as T;
  }

  search(body: TripsafeSearchRequest) {
    return this.request<{ searchId?: string; productInfo?: Rec[] }>("POST", "/insurance/v2/search", body, true);
  }

  book(body: TripsafeBookRequest) {
    return this.request<TripsafeBookResult>("POST", "/insurance/v2/booking", body, true);
  }

  bookingDetail(bookingId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(bookingId)) {
      return Promise.reject(new TripsafeError("Invalid TripSafe booking ID", { endpoint: "/insurance/v2/booking", code: "INVALID_REQUEST" }));
    }
    return this.request<Rec>("GET", `/insurance/v2/booking/${bookingId}`, undefined, true);
  }

  raiseAmendment(body: TripsafeAmendmentRequest) {
    return this.request<TripsafeAmendmentResult>("POST", "/insurance/v2/amendment/raise", { amendmentId: "", ...body }, false);
  }

  confirmAmendment(body: TripsafeConfirmRequest) {
    return this.request<TripsafeAmendmentResult>("POST", "/insurance/v2/amendment/confirm", body, false);
  }
}
