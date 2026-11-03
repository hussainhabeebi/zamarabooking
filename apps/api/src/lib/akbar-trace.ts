// Read-only Akbar diagnostic trace for Admin → Supplier logs ("Akbar request trace").
//
// Given a checkout requestId (shown in Supplier logs), the stored supplier_exchanges of that request
// (SmartPricer, GetSPricer, GetTravelCheckList …) and of the search it came from (ExpressSearch,
// GetExpSearch, WebSettings — linked by searchId) are summarised field by field.
//
// Only an allowlist of pricing / search fields is read from the stored files: never ContactInfo,
// Travellers, Signature credentials, tokens or ClientID values (shown only as "sent" / "empty").
// The raw files stay available through the existing ZIP download (secrets already blanked when
// recorded, see AkbarClient.redactBody / redactResponse).

type Raw = Record<string, any>;

export interface TraceTrip {
  index: string | null; orderId: number | string | null; amount: number | null; channelCode: string | null;
  tui: string | null; from?: string; to?: string; onwardDate?: string; returnDate?: string;
}
export interface TraceJourney {
  index: string; returnIdentifier: number | null; vac: string | null; provider: string | null;
  netFare: number | null; flightNo: string | null; departureTime: string | null; from: string | null; to: string | null;
}
export interface TraceCall {
  id: string; startedAt: string; endpoint: string; service: string; httpStatus: number | null; durationMs: number | null;
  error: string | null; searchId: string | null; requestId: string | null;
  request: {
    tui: string | null; fareType: string | null; mode: string | null; options: string | null; tripType: string | null;
    source: string | null; secType: string | null; clientId: "sent" | "empty" | "absent"; netAmount: number | null; transactionId: number | string | null;
    trips: TraceTrip[];
  } | null;
  response: {
    code: string | null; messages: string[]; tui: string | null; netAmount: number | null; completed: string | null;
    journeysPerTrip: number[]; transactionId: number | string | null;
  } | null;
}
export interface TraceCheck {
  callId: string; service: string; tui: string | null; searchFound: boolean; secondsAfterSearch: number | null;
  trips: { orderId: number | string | null; index: string | null; amount: number | null; found: TraceJourney | null; amountMatches: boolean | null }[];
  specialFarePair: { returnIdentifierEqual: boolean; vacEqual: boolean; providerEqual: boolean } | null;
}

const s = (v: unknown) => (v == null || v === "" ? null : String(v));
const n = (v: unknown) => { const x = Number(v); return v == null || v === "" || !Number.isFinite(x) ? null : x; };
const service = (endpoint: string) => endpoint.split("/").filter(Boolean).pop() ?? endpoint;

// The stored request file: { url, method, headers, body } (body already redacted).
export function traceRequest(stored: unknown): TraceCall["request"] {
  const body: Raw | null = stored && typeof stored === "object" ? ((stored as Raw).body ?? null) : null;
  if (!body || typeof body !== "object") return null;
  const trips: TraceTrip[] = Array.isArray(body.Trips) ? body.Trips.filter((t: unknown) => t && typeof t === "object").map((t: Raw) => ({
    index: s(t.Index), orderId: t.OrderID ?? null, amount: n(t.Amount), channelCode: t.ChannelCode === undefined ? null : t.ChannelCode === null ? "null" : String(t.ChannelCode),
    tui: s(t.TUI),
    ...(t.From ? { from: String(t.From), to: String(t.To ?? ""), onwardDate: String(t.OnwardDate ?? ""), returnDate: String(t.ReturnDate ?? "") } : {}),
  })) : [];
  return {
    tui: s(body.TUI), fareType: s(body.FareType), mode: s(body.Mode), options: body.Options === undefined ? null : String(body.Options),
    tripType: s(body.TripType), source: s(body.Source), secType: body.SecType === undefined ? null : String(body.SecType),
    clientId: !("ClientID" in body) ? "absent" : body.ClientID ? "sent" : "empty",
    netAmount: n(body.NetAmount), transactionId: body.TransactionID ?? body.ReferenceNumber ?? null, trips,
  };
}

export function traceResponse(data: unknown): TraceCall["response"] {
  if (!data || typeof data !== "object") return null;
  const d = data as Raw;
  const msg = Array.isArray(d.Msg) ? d.Msg.map(String) : d.Msg != null ? [String(d.Msg)] : [];
  const journeysPerTrip = Array.isArray(d.Trips) ? d.Trips.map((t: Raw) => (Array.isArray(t?.Journey) ? t.Journey.length : 0)) : [];
  return { code: s(d.Code), messages: msg, tui: s(d.TUI), netAmount: n(d.NetAmount), completed: s(d.Completed), journeysPerTrip, transactionId: d.TransactionID ?? null };
}

// GetExpSearch journeys by trip position (0 = onward, 1 = return) and Index.
export function searchJourneys(data: unknown): Map<string, TraceJourney>[] {
  const trips = data && typeof data === "object" && Array.isArray((data as Raw).Trips) ? (data as Raw).Trips : [];
  return trips.map((t: Raw) => new Map((Array.isArray(t?.Journey) ? t.Journey : []).filter((j: Raw) => j?.Index).map((j: Raw) => [String(j.Index), {
    index: String(j.Index), returnIdentifier: n(j.ReturnIdentifier), vac: s(j.VAC), provider: s(j.Provider), netFare: n(j.NetFare),
    flightNo: s(j.FlightNo)?.trim() ?? null, departureTime: s(j.DepartureTime), from: s(j.From), to: s(j.To),
  }])));
}

// Pricing calls checked against the search they reference: is the TUI one of this trace's searches,
// is each Index in that search (trip OrderID-1), does Amount equal its NetFare, and for a two-leg
// price the Special Fare rule (ReturnIdentifier / VAC / Provider equal).
export function traceChecks(calls: TraceCall[], searches: Map<string, { journeys: Map<string, TraceJourney>[]; startedAt: string }>): TraceCheck[] {
  return calls.filter((c) => /SmartPricer|FlightInfo|FareRule/i.test(c.endpoint) && c.request).map((c) => {
    const tui = c.request!.trips[0]?.tui ?? c.request!.tui;
    const search = tui ? searches.get(tui) : undefined;
    const trips = c.request!.trips.map((t, i) => {
      const pos = typeof t.orderId === "number" && c.request!.trips.length > 1 ? t.orderId - 1 : i;
      const found = (t.index && search?.journeys[pos]?.get(t.index)) || (t.index && search?.journeys.find((m) => m.has(t.index!))?.get(t.index)) || null;
      return { orderId: t.orderId, index: t.index, amount: t.amount, found, amountMatches: found && t.amount != null && found.netFare != null ? Math.abs(found.netFare - t.amount) < 0.01 : null };
    });
    const [a, b] = trips.map((t) => t.found);
    return {
      callId: c.id, service: c.service, tui, searchFound: !!search,
      secondsAfterSearch: search ? Math.round((Date.parse(c.startedAt) - Date.parse(search.startedAt)) / 1000) : null,
      trips,
      specialFarePair: trips.length === 2 && a && b ? {
        returnIdentifierEqual: (a.returnIdentifier ?? 0) > 0 && a.returnIdentifier === b.returnIdentifier,
        vacEqual: !!a.vac && a.vac === b.vac, providerEqual: !!a.provider && a.provider === b.provider,
      } : null,
    };
  });
}

export function traceCall(x: { id: string; startedAt: Date | string; endpoint: string; httpStatus: number | null; durationMs: number | null; error: string | null; searchId: string | null; requestId: string | null },
  storedRequest: unknown, responseData: unknown): TraceCall {
  const signature = /Signature/i.test(x.endpoint);   // credentials only: never summarised
  return {
    id: x.id, startedAt: new Date(x.startedAt).toISOString(), endpoint: x.endpoint, service: service(x.endpoint),
    httpStatus: x.httpStatus, durationMs: x.durationMs, error: x.error, searchId: x.searchId, requestId: x.requestId,
    request: signature ? null : traceRequest(storedRequest),
    response: signature ? null : traceResponse(responseData),
  };
}
