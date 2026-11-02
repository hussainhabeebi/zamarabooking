import type { SearchParams } from "../base.js";

// Akbar Travels B2B API (built by Benzy Infotech) — flights.
// Docs: https://wrc.benzyinfotech.com/home/b2b-revamp-flight/flight/
//
//   {utilsUrl}/Utils/Signature        → JWT token, valid 48 hours
//   {flightsUrl}/flights/ExpressSearch → starts a search, returns its TUI (token as Bearer)
//   {flightsUrl}/flights/GetExpSearch  → { ClientID, TUI }: results so far; call again
//                                        until "Completed" is true, within 50 s of the search
//   {flightsUrl}/flights/SmartPricer   → re-prices the chosen fare (Index / OrderID / Amount
//                                        from the search response)
//   {flightsUrl}/flights/GetSPricer    → { TUI, ClientID }: live fare + flight details, TUI
//                                        from the SmartPricer response
//   {flightsUrl}/Flights/FlightInfo    → flight, fare and SSR details from store/cache
//   {flightsUrl}/flights/FareRule      → fare rules for the chosen fare (same Trips as SmartPricer)
//   {flightsUrl}/flights/ssr           → seats / meals / baggage on sale (Index "" after SmartPricer)
//   {flightsUrl}/flights/SeatLayout    → seat map for sale; only after SmartPricer + GetSPricer
//   {flightsUrl}/flights/CreateItinerary → { TUI (GetSPricer), ContactInfo, Travellers, NetAmount, … }:
//                                        creates the itinerary; returns TransactionID + TUI
//   {flightsUrl}/Payment/StartPay      → pays from the Akbar deposit account and books
//   {flightsUrl}/Payment/GetItineraryStatus → { TUI, TransactionID }: call after StartPay until
//                                        CurrentStatus is "Success" or "Failed", then RetrieveBooking
//   {flightsUrl}/Utils/RetrieveBooking → booking by Transaction ID
//   {flightsUrl}/flights/cancel        → cancels passengers' tickets on a PNR
//   {flightsUrl}/Utils/GetTravelCheckList → { TUI, ClientID }: traveller details the
//                                        airline requires (passport, DOB, …)
//
// Every call must come from an IP Akbar has whitelisted. Cloudflare Workers have no
// fixed IP, so in production calls go through apps/akbar-gateway (gatewayUrl).

export interface AkbarCredentials {
  utilsUrl:   string;   // https://b2bapiutils.benzyinfotech.com (test)
  flightsUrl: string;   // https://b2bapiflights.benzyinfotech.com (test)
  merchantId: string;
  apiKey:     string;
  clientId:   string;
  password:   string;
  agentCode:  string;
  browserKey: string;
  key:        string;   // extra "Key" Akbar sends with test credentials; omitted when blank
  gatewayUrl?: string;  // https://akbar-proxy.… — when set, every call goes through the gateway
  gatewayKey?: string;  // the gateway's ZAMRA_GATEWAY_KEY
  recorder?:   (x: AkbarExchange) => void;   // receives every call for Admin → API Logs
}

// One Akbar call as sent and received, for Admin → API Logs (request / response files).
// Secrets are blanked: Password, ApiKey and Key in the Signature body, the Bearer token,
// and the gateway key.
export interface AkbarExchange {
  supplier:        "AKBAR";
  endpoint:        string;
  url:             string;
  method:          "POST";
  requestHeaders:  Record<string, string>;
  requestBody:     string;
  status:          number | null;
  responseHeaders: Record<string, string>;
  responseBody:    string | null;
  error?:          string;
  startedAt:       string;
  durationMs:      number;
}

const SECRET_FIELDS = new Set(["Password", "ApiKey", "Key"]);
const TOKEN_FIELDS = new Set(["Token", "token", "TokenID", "AccessToken", "access_token"]);
// The Signature answer holds the 48-hour token itself: blank it in the stored copy.
const redactResponse = (endpoint: string, text: string) => {
  if (endpoint !== "/Utils/Signature") return text;
  try { return JSON.stringify(JSON.parse(text), (k, v) => (TOKEN_FIELDS.has(k) && typeof v === "string" && v ? "••••" : v)); }
  catch { return text; }
};
const redactBody = (body: unknown) => JSON.stringify(body, (k, v) => (SECRET_FIELDS.has(k) && typeof v === "string" && v ? "••••" : v));

export interface AkbarToken {
  token:    string;
  clientId: string;   // ClientID for search requests (from the Signature response when it returns one)
}

// The token lasts 48 hours; renew it an hour early.
export const AKBAR_TOKEN_TTL_SECONDS = 47 * 3600;

export class AkbarError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly endpoint?: string, readonly responseSnippet?: string) {
    super(message);
    this.name = "AkbarError";
  }
}

const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");

export function signatureBody(c: AkbarCredentials): Record<string, string> {
  return {
    MerchantID: c.merchantId,
    ApiKey:     c.apiKey,
    ClientID:   c.clientId,
    Password:   c.password,
    AgentCode:  c.agentCode,
    BrowserKey: c.browserKey,
    ...(c.key ? { Key: c.key } : {}),
  };
}

const CABIN: Record<SearchParams["cabinClass"], string> = { ECONOMY: "E", PREMIUM_ECONOMY: "PE", BUSINESS: "B", FIRST: "F" };

// ExpressSearch request. Mode SY waits for every provider, so one call holds all fares.
export function expressSearchBody(params: SearchParams, clientId: string, mode: "SY" | "AS" | "SS" = "SY") {
  const round = params.tripType === "ROUNDTRIP" && !!params.returnDate;
  return {
    ADT:      params.adults,
    CHD:      params.children,
    INF:      params.infants,
    Cabin:    CABIN[params.cabinClass] ?? "E",
    Source:   "CF",
    Mode:     mode,
    ClientID: clientId,
    TUI:      "",
    FareType: round ? "RT" : "ON",
    Trips: [{
      From:       params.origin.toUpperCase(),
      To:         params.destination.toUpperCase(),
      OnwardDate: params.departureDate,
      ReturnDate: round ? params.returnDate : "",
      TUI:        "",
    }],
    Parameters: { Airlines: "", GroupType: "", Refundable: "", IsDirect: false },
  };
}

export interface AkbarPricerTrip {
  amount:  number;   // net fare from the search response
  index:   string;   // "Index" from the search response
  orderId: number | string;   // "OrderID" from the search response, passed as received
  tui?:    string;   // search TUI
}

// SmartPricer request. Mode SY prices live; AS / SS need GetSPricer for the fare details.
// The booking flow follows the Postman collection: Mode "AS", Options "", then GetSPricer.
export function smartPricerBody(trips: AkbarPricerTrip[], clientId: string, tripType: "ON" | "RT", mode: "SY" | "AS" | "SS" = "SY", options = "A") {
  return {
    ClientID: clientId,
    Trips:    pricerTrips(trips),
    Mode:     mode,
    Options:  options,
    Source:   "SF",
    TripType: tripType,
  };
}

const pricerTrips = (trips: AkbarPricerTrip[]) =>
  trips.map((t) => ({ Amount: t.amount, Index: t.index, OrderID: t.orderId, TUI: t.tui ?? "" }));

export function flightInfoBody(trips: AkbarPricerTrip[], clientId: string, tripType: "ON" | "RT") {
  return { ClientID: clientId, TripType: tripType, Trips: pricerTrips(trips).map((t) => ({ ...t, ChannelCode: null })) };
}

export function fareRuleBody(trips: AkbarPricerTrip[], clientId: string, source: "SF" | "LV" = "SF") {
  return { ClientID: clientId, Source: source, Trips: pricerTrips(trips) };
}

// SSR request. Amount is always 0. Index: the search Index when called at availability,
// "" when called after SmartPricer / GetSPricer.
export function ssrBody(trip: { tui: string; orderId: number | string; index?: string }, clientId: string, paidSsr: boolean, source: "CF" | "LV" = "LV") {
  return { ClientID: clientId, PaidSSR: paidSsr, Source: source, Trips: [{ TUI: trip.tui, Amount: 0, OrderID: trip.orderId, Index: trip.index ?? "" }] };
}

// SeatLayout request: TUI from SmartPricer / GetSPricer, Index always "".
export function seatLayoutBody(trip: { tui: string; orderId: number | string }, clientId: string) {
  return { ClientID: clientId, Source: "LV", Trips: [{ TUI: trip.tui, Index: "", OrderID: trip.orderId }] };
}

export interface AkbarStartPay {
  transactionId: number;   // from the CreateItinerary response
  netAmount:     number;   // NetAmount from the CreateItinerary response
  tui:           string;
}

// StartPay request (deposit account), every field of the Postman collection's sample:
// PaymentAmount 0, Hold false, DepositPayment true, OnlinePayment false, ServiceType "ITI",
// card / UPI fields blank (Zamra never sends card data to Akbar).
export function startPayBody(p: AkbarStartPay, clientId: string, browserKey: string) {
  return {
    TransactionID: p.transactionId,
    PaymentAmount: 0,
    NetAmount:     p.netAmount,
    BrowserKey:    browserKey,
    ClientID:      clientId,
    TUI:           p.tui,
    Hold:          false,
    Promo:         null,
    PaymentType:   "",
    BankCode:      "",
    GateWayCode:   "",
    MerchantID:    "",
    PaymentCharge: 0,
    ReleaseDate:   "",
    OnlinePayment: false,
    DepositPayment: true,
    Card: {
      Number: "", Expiry: "", CVV: "", CHName: "", Address: "", City: "", State: "", Country: "", PIN: "",
      International: false, SaveCard: false, FName: "", LName: "", EMIMonths: "0",
    },
    VPA:            "",
    CardAlias:      "",
    QuickPay:       null,
    RMSSignature:   "",
    TargetCurrency: "",
    TargetAmount:   0,
    ServiceType:    "ITI",
  };
}

// ── CreateItinerary (Postman "5.CreateItinerary") ────────────────────────────

export interface AkbarContactInfo {
  title?:  string;
  fName:   string;
  lName:   string;
  mobile:  string;
  phone?:  string;
  email:   string;
  address: string;
  countryCode: string;   // "IN"
  state:   string;
  city:    string;
  pin:     string;
  gst?: { companyName: string; tin: string; mobile?: string; email?: string };
}

export interface AkbarTraveller {
  id:          number;              // 1, 2, … in passenger order
  title:       string;              // Mr / Mrs / Ms / Mstr / Miss
  fName:       string;
  lName:       string;
  age:         number | null;
  dob:         string;              // YYYY-MM-DD or ""
  gender:      "M" | "F";
  ptc:         "ADT" | "CHD" | "INF";
  nationality: string;              // ISO-2 or ""
  passportNo:  string;
  pli:         string;              // passport place of issue
  pdoe:        string;              // passport date of expiry, YYYY-MM-DD or ""
  visaType:    string;
}

export interface AkbarCreateItinerary {
  tui:       string;                // TUI from GetSPricer
  netAmount: number;                // NetAmount from GetSPricer
  contact:   AkbarContactInfo;
  travellers: AkbarTraveller[];
  ssr?:      unknown[];             // empty until Akbar documents the SSR item format
  ssrAmount?: number;
}

export function createItineraryBody(p: AkbarCreateItinerary, clientId: string) {
  const c = p.contact;
  return {
    TUI: p.tui,
    ContactInfo: {
      Title: c.title ?? "", FName: c.fName, LName: c.lName, Mobile: c.mobile, Phone: c.phone ?? "", Email: c.email,
      Address: c.address, CountryCode: c.countryCode, State: c.state, City: c.city, PIN: c.pin,
      GSTCompanyName: c.gst?.companyName ?? "", GSTTIN: c.gst?.tin ?? "", GSTMobile: c.gst?.mobile ?? "", GSTEmail: c.gst?.email ?? "",
      UpdateProfile: false, IsGuest: false,
    },
    Travellers: p.travellers.map((t) => ({
      ID: t.id, Title: t.title, FName: t.fName, LName: t.lName, Age: t.age, DOB: t.dob, Gender: t.gender, PTC: t.ptc,
      Nationality: t.nationality, PassportNo: t.passportNo, PLI: t.pli, PDOE: t.pdoe, VisaType: t.visaType,
    })),
    PLP: [],
    SSR: p.ssr ?? [],
    CrossSell: [],
    NetAmount: p.netAmount,
    SSRAmount: p.ssrAmount ?? 0,
    ClientID: clientId,
    DeviceID: "",
    AppVersion: "",
    CrossSellAmount: 0,
  };
}

// ── Response helpers ─────────────────────────────────────────────────────────

// Akbar answers HTTP 200 with its own "Code" ("200" on success) and "Msg" (string[]).
export function akbarCode(data: unknown): string {
  const v = data && typeof data === "object" ? (data as Record<string, unknown>).Code : undefined;
  return v == null ? "" : String(v).trim();
}
export const akbarOk = (data: unknown) => akbarCode(data) === "200";
export function akbarMessages(data: unknown): string {
  const m = data && typeof data === "object" ? (data as Record<string, unknown>).Msg : undefined;
  return Array.isArray(m) ? m.filter((x) => x != null && x !== "").map(String).join("; ") : typeof m === "string" ? m : "";
}

const numOrNull = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  return v != null && v !== "" && Number.isFinite(n) ? n : null;
};
export const akbarNetAmount = (data: unknown) =>
  data && typeof data === "object" ? numOrNull((data as Record<string, unknown>).NetAmount) : null;
export function akbarTransactionId(data: unknown): number | null {
  const n = data && typeof data === "object" ? numOrNull((data as Record<string, unknown>).TransactionID) : null;
  return n && n > 0 ? n : null;
}

// PNRs and ticket numbers as Akbar returned them (RetrieveBooking / GetItineraryStatus).
// The Cancel sample shows the shape Trips[].Journey[].Segments[] { CRSPNR, Pax[] { ID, Ticket } };
// any of the usual PNR / ticket keys found anywhere in the response are read, and nothing is
// ever invented: empty values are skipped.
const PNR_KEYS = new Set(["CRSPNR", "APNR", "AirlinePNR", "AirPNR", "PNR", "GDSPNR"]);
const TICKET_KEYS = new Set(["Ticket", "TicketNo", "TicketNumber", "ETicketNo"]);
export function akbarBookingRefs(data: unknown): { pnrs: string[]; tickets: string[] } {
  const pnrs = new Set<string>();
  const tickets = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 12) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" || typeof x === "number") {
        const s = String(x).trim();
        if (PNR_KEYS.has(k) && /^[A-Z0-9]{5,8}$/i.test(s)) pnrs.add(s.toUpperCase());
        if (TICKET_KEYS.has(k) && /^[A-Z0-9-]{6,20}$/i.test(s) && /\d{6}/.test(s)) tickets.add(s);
      } else walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return { pnrs: [...pnrs], tickets: [...tickets] };
}

// GetTravelCheckList: which traveller documents the airline requires. The collection has
// no sample response, so any key naming a passport / DOB / nationality / visa field with a
// "required" value (true, "Y", "M", "Mandatory", "Required", 1) counts.
export interface AkbarTravelRequirements { passport: boolean; dob: boolean; nationality: boolean; visa: boolean; raw: unknown }
export function akbarTravelRequirements(data: unknown): AkbarTravelRequirements {
  const out: AkbarTravelRequirements = { passport: false, dob: false, nationality: false, visa: false, raw: data };
  const yes = (x: unknown) => x === true || x === 1 || ["true", "y", "yes", "m", "mandatory", "required", "1"].includes(String(x ?? "").trim().toLowerCase());
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 10) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x && typeof x === "object") { walk(x, depth + 1); continue; }
      if (!yes(x)) continue;
      const key = k.toLowerCase();
      if (/passport|pdoe|pli/.test(key)) out.passport = true;
      else if (/dob|dateofbirth|birth/.test(key)) out.dob = true;
      else if (/nationality/.test(key)) out.nationality = true;
      else if (/visa/.test(key)) out.visa = true;
    }
  };
  walk(data, 0);
  return out;
}

// RetrieveBooking by Transaction ID (ReferenceType "T"); the docs' sample sends it as a string.
export function retrieveBookingBody(transactionId: number | string, clientId: string, tui = "") {
  return { TUI: tui, ClientID: clientId, ReferenceNumber: String(transactionId), ReferenceType: "T", ServiceType: "FLT" };
}

export interface AkbarCancel {
  transactionId: number;
  tui?:          string;
  remarks?:      string;
  clientIp?:     string;
  // The screenshot cuts off inside "Trips"; CRSPNR and Pax are read as fields of each trip.
  trips: { crsPnr: string; pax: { id: number; ticket: string }[] }[];
}

export function cancelBody(c: AkbarCancel, clientId: string) {
  return {
    ClientID:      clientId,
    ClientIP:      c.clientIp ?? "",
    Remarks:       c.remarks ?? "",
    TUI:           c.tui ?? "",
    TransactionID: c.transactionId,
    Trips:         c.trips.map((t) => ({ CRSPNR: t.crsPnr, Pax: t.pax.map((p) => ({ ID: p.id, Ticket: p.ticket })) })),
  };
}

// "Success" / "Failed" once the booking is final; "" while Akbar is still working on it.
export function itineraryFinalStatus(data: unknown): "Success" | "Failed" | "" {
  const v = pickString(data, ["CurrentStatus"]).toLowerCase();
  return v === "success" ? "Success" : v === "failed" ? "Failed" : "";
}

function pickString(data: unknown, keys: string[]): string {
  if (!data || typeof data !== "object") return "";
  for (const k of keys) {
    const v = (data as Record<string, unknown>)[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

// Search results are complete once "Completed" is true (the docs also call it "Complete").
export function isSearchComplete(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const v = d.Completed ?? d.Complete;
  return v === true || v === "true" || v === "True";
}

export const searchTui = (data: unknown) => pickString(data, ["TUI", "Tui"]);

// True when the response already holds flights (Trips[n].Journey[] not empty).
export function hasJourneys(data: unknown): boolean {
  const trips = (data as { Trips?: unknown } | null)?.Trips;
  return Array.isArray(trips) && trips.some((t) => Array.isArray((t as { Journey?: unknown } | null)?.Journey) && ((t as { Journey: unknown[] }).Journey.length > 0));
}

export interface AkbarSearchOptions {
  pollIntervalMs?: number;   // between GetExpSearch calls
  deadlineMs?:     number;   // the docs allow 50 s after ExpressSearch
  sleep?:          (ms: number) => Promise<void>;
}

export class AkbarClient {
  // Cloudflare Workers reject fetch called as a method of another object
  // ("Illegal invocation"), so the default calls the global fetch directly.
  constructor(private creds: AkbarCredentials, private fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  // Through the gateway, /utils/… and /flights/… map to Akbar's two hosts.
  private gateway() { return this.creds.gatewayUrl ? trimUrl(this.creds.gatewayUrl) : ""; }
  private utilsBase()   { return this.gateway() ? `${this.gateway()}/utils` : trimUrl(this.creds.utilsUrl); }
  private flightsBase() { return this.gateway() ? `${this.gateway()}/flights` : trimUrl(this.creds.flightsUrl); }

  // Every call has its own time limit, so one slow Akbar answer can't hold up a whole search.
  private async post(url: string, endpoint: string, body: unknown, token?: string, timeoutMs = 30_000): Promise<unknown> {
    if (this.gateway() && !this.creds.gatewayKey) throw new AkbarError("Akbar: AKBAR_GATEWAY_KEY is not set on the Worker", undefined, endpoint);
    const startedAt = new Date();
    const record = (status: number | null, responseHeaders: Record<string, string>, responseBody: string | null, error?: string) => {
      try {
        this.creds.recorder?.({
          supplier: "AKBAR", endpoint, url, method: "POST",
          requestHeaders: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer ••••" } : {}) },
          requestBody: redactBody(body), status, responseHeaders, responseBody, ...(error ? { error } : {}),
          startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
        });
      } catch { /* logging never breaks a call */ }
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(this.gateway() ? { "X-Zamra-Gateway-Key": this.creds.gatewayKey! } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const timedOut = name === "TimeoutError" || name === "AbortError";
      record(null, {}, null, timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err));
      if (timedOut) throw new AkbarError(`Akbar ${endpoint} timed out after ${Math.round(timeoutMs / 1000)}s`, 504, endpoint);
      throw err;
    }
    const text = await res.text();
    record(res.status, Object.fromEntries(res.headers.entries()), redactResponse(endpoint, text));
    if (!res.ok) throw new AkbarError(`Akbar ${endpoint} failed (HTTP ${res.status})`, res.status, endpoint, text.slice(0, 1000));
    try { return JSON.parse(text); }
    catch { throw new AkbarError(`Akbar ${endpoint} returned a response that is not JSON`, res.status, endpoint, text.slice(0, 1000)); }
  }

  async signature(): Promise<AkbarToken> {
    const c = this.creds;
    if (!(c.utilsUrl || c.gatewayUrl) || !c.merchantId || !c.apiKey || !c.clientId || !c.password || !c.browserKey) {
      throw new AkbarError("Akbar: fill in Utils URL, MerchantID, ApiKey, ClientID, Password and BrowserKey first");
    }
    const endpoint = "/Utils/Signature";
    const data = await this.post(`${this.utilsBase()}${endpoint}`, endpoint, signatureBody(c));
    const token = pickString(data, ["Token", "token", "TokenID", "AccessToken", "access_token"]);
    if (!token) throw new AkbarError("Akbar Signature returned no token", 200, endpoint, JSON.stringify(data).slice(0, 1000));
    return { token, clientId: pickString(data, ["ClientID", "ClientId", "clientId"]) || c.clientId };
  }

  async expressSearch(params: SearchParams, auth: AkbarToken, timeoutMs?: number): Promise<unknown> {
    if (!this.creds.flightsUrl && !this.creds.gatewayUrl) throw new AkbarError("Akbar: Flights URL not configured");
    const endpoint = "/flights/ExpressSearch";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, expressSearchBody(params, auth.clientId), auth.token, timeoutMs);
  }

  async getExpSearch(tui: string, auth: AkbarToken, timeoutMs?: number): Promise<unknown> {
    const endpoint = "/flights/GetExpSearch";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, { ClientID: auth.clientId, TUI: tui }, auth.token, timeoutMs);
  }

  async smartPricer(trips: AkbarPricerTrip[], tripType: "ON" | "RT", auth: AkbarToken, mode: "SY" | "AS" | "SS" = "SY", options = "A"): Promise<unknown> {
    const endpoint = "/flights/SmartPricer";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, smartPricerBody(trips, auth.clientId, tripType, mode, options), auth.token);
  }

  // Creates the itinerary (no payment yet). Never retried automatically: a timeout here may
  // still have created a TransactionID on Akbar's side.
  async createItinerary(p: AkbarCreateItinerary, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/CreateItinerary";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, createItineraryBody(p, auth.clientId), auth.token, 60_000);
  }

  async flightInfo(trips: AkbarPricerTrip[], tripType: "ON" | "RT", auth: AkbarToken): Promise<unknown> {
    const endpoint = "/Flights/FlightInfo";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, flightInfoBody(trips, auth.clientId, tripType), auth.token);
  }

  async fareRule(trips: AkbarPricerTrip[], auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/FareRule";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, fareRuleBody(trips, auth.clientId), auth.token);
  }

  async ssr(trip: { tui: string; orderId: number | string; index?: string }, paidSsr: boolean, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/ssr";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, ssrBody(trip, auth.clientId, paidSsr), auth.token);
  }

  async seatLayout(trip: { tui: string; orderId: number | string }, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/SeatLayout";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, seatLayoutBody(trip, auth.clientId), auth.token);
  }

  async startPay(p: AkbarStartPay, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/Payment/StartPay";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, startPayBody(p, auth.clientId, this.creds.browserKey), auth.token, 90_000);
  }

  async getItineraryStatus(transactionId: number, tui: string, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/Payment/GetItineraryStatus";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, { TUI: tui, TransactionID: transactionId }, auth.token);
  }

  // After StartPay: GetItineraryStatus until Success / Failed or the deadline passes.
  // status "" = still pending at the deadline (check again later; don't rebook).
  async waitForItinerary(transactionId: number, tui: string, auth: AkbarToken, opts: AkbarSearchOptions = {}): Promise<{ status: "Success" | "Failed" | ""; data: unknown; polls: number }> {
    const { pollIntervalMs = 3000, deadlineMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
    const started = Date.now();
    let polls = 0;
    for (;;) {
      const data = await this.getItineraryStatus(transactionId, tui, auth);
      polls++;
      const status = itineraryFinalStatus(data);
      if (status || Date.now() - started + pollIntervalMs >= deadlineMs) return { status, data, polls };
      await sleep(pollIntervalMs);
    }
  }

  async retrieveBooking(transactionId: number | string, auth: AkbarToken, tui = ""): Promise<unknown> {
    const endpoint = "/Utils/RetrieveBooking";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, retrieveBookingBody(transactionId, auth.clientId, tui), auth.token);
  }

  async cancel(c: AkbarCancel, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/cancel";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, cancelBody(c, auth.clientId), auth.token);
  }

  async getSPricer(tui: string, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/GetSPricer";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, { TUI: tui, ClientID: auth.clientId }, auth.token);
  }

  async getTravelCheckList(tui: string, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/Utils/GetTravelCheckList";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, { TUI: tui, ClientID: auth.clientId }, auth.token);
  }

  // ExpressSearch (Mode SY: Akbar waits for every airline), then GetExpSearch only while the
  // answer holds no flights yet and isn't marked complete. A failed or slow follow-up keeps
  // the flights already received. `completed` is false when Akbar was still collecting fares.
  async search(params: SearchParams, auth: AkbarToken, opts: AkbarSearchOptions = {}): Promise<{ data: unknown; completed: boolean; polls: number }> {
    const { pollIntervalMs = 2000, deadlineMs = 45_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
    const started = Date.now();
    const left = () => deadlineMs - (Date.now() - started);
    const first = await this.expressSearch(params, auth, deadlineMs);
    let data = first;
    const tui = searchTui(data);
    let polls = 0;
    while (!isSearchComplete(data) && !hasJourneys(data) && tui && left() > pollIntervalMs + 1000) {
      await sleep(pollIntervalMs);
      try {
        data = await this.getExpSearch(tui, auth, left());
      } catch (err) {
        if (!(err instanceof AkbarError)) throw err;
        // Show what ExpressSearch said too: that is what tells us how Akbar answered.
        throw new AkbarError(err.message, err.statusCode, err.endpoint,
          `ExpressSearch answered: ${JSON.stringify(first).slice(0, 1500)}\n\n${err.endpoint ?? "GetExpSearch"} answered: ${err.responseSnippet ?? "(nothing)"}`);
      }
      polls++;
    }
    return { data, completed: isSearchComplete(data) || hasJourneys(data), polls };
  }
}
