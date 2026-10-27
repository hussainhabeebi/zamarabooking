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
}

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
export function smartPricerBody(trips: AkbarPricerTrip[], clientId: string, tripType: "ON" | "RT", mode: "SY" | "AS" | "SS" = "SY") {
  return {
    ClientID: clientId,
    Trips:    pricerTrips(trips),
    Mode:     mode,
    Options:  "A",
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

// StartPay request (deposit account). PaymentAmount 0, Hold false, PaymentType / BankCode "".
// The docs list 36 fields; these are the first 10, the ones a deposit payment needs.
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
  };
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

  private async post(url: string, endpoint: string, body: unknown, token?: string): Promise<unknown> {
    if (this.gateway() && !this.creds.gatewayKey) throw new AkbarError("Akbar: AKBAR_GATEWAY_KEY is not set on the Worker", undefined, endpoint);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(this.gateway() ? { "X-Zamra-Gateway-Key": this.creds.gatewayKey! } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
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

  async expressSearch(params: SearchParams, auth: AkbarToken): Promise<unknown> {
    if (!this.creds.flightsUrl && !this.creds.gatewayUrl) throw new AkbarError("Akbar: Flights URL not configured");
    const endpoint = "/flights/ExpressSearch";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, expressSearchBody(params, auth.clientId), auth.token);
  }

  async getExpSearch(tui: string, auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/GetExpSearch";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, { ClientID: auth.clientId, TUI: tui }, auth.token);
  }

  async smartPricer(trips: AkbarPricerTrip[], tripType: "ON" | "RT", auth: AkbarToken): Promise<unknown> {
    const endpoint = "/flights/SmartPricer";
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, smartPricerBody(trips, auth.clientId, tripType), auth.token);
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
    return this.post(`${this.flightsBase()}${endpoint}`, endpoint, startPayBody(p, auth.clientId, this.creds.browserKey), auth.token);
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

  // ExpressSearch, then GetExpSearch until the results are complete or the deadline passes.
  // Returns the last response; `completed` is false when Akbar was still collecting fares.
  async search(params: SearchParams, auth: AkbarToken, opts: AkbarSearchOptions = {}): Promise<{ data: unknown; completed: boolean; polls: number }> {
    const { pollIntervalMs = 2000, deadlineMs = 45_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
    const started = Date.now();
    let data = await this.expressSearch(params, auth);
    const tui = searchTui(data);
    let polls = 0;
    while (!isSearchComplete(data) && tui && Date.now() - started + pollIntervalMs < deadlineMs) {
      await sleep(pollIntervalMs);
      data = await this.getExpSearch(tui, auth);
      polls++;
    }
    return { data, completed: isSearchComplete(data), polls };
  }
}
