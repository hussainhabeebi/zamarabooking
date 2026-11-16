// Akbar Travels (Benzy) flight cancellation + GetRefund: request builders and response readers.
//
// The ONLY sources for this file are the two documents Akbar sent (Nov 2026):
//
//   Cancel     https://b2bapiflights.benzyinfotech.com/Flights//Flights/Cancel
//     request  { ClientID, ClientIP: "", Remarks: "", TUI, TransactionID,
//                Trips: [ { Journey: [ { Segments: [ { CRSPNR, Pax: [ { ID, Ticket: "" } ] } ] } ] } ],
//                Isfullrefund: false, CancelType: "R" }
//     response { TUI, TransactionID, CancellationID, Code: "1903", Msg: ["Auto Cancellation Success"] }
//
//   GetRefund  flightURL/Flights/GetRefund
//     request  { TUI, TransactionId, CancelType: "R" }            (note: "TransactionId", lower-case d)
//     response { TUI, transactionID, Code: "200", Msg: ["Success"],
//                Trips: [ { destOrgin, travelType, refundable, fuId,
//                           Itineraries: [ { from, to, travelType, tripType, paxtype, atoCharge,
//                                            providerCharge (a string), refundAmount, netAmount,
//                                            cancellationCharge, rafCharge, stfCharge, K3Charge,
//                                            VATONATOCancelCharges } ] } ] }
//
// NOT documented (asked to Akbar, no answer yet), so nothing here relies on a guess:
//   - the exact path / letter case (the Cancel URL has a doubled "Flights//Flights")   → AKBAR_CANCEL_PATHS (configurable)
//   - what Isfullrefund and CancelType mean, and any other values                   → only the sample values are ever sent
//   - whether Pax.ID is RetrieveBooking Pax[].ID and what Ticket must hold           → read from RetrieveBooking; Ticket configurable
//   - whether part of a booking (some passengers / segments) can be cancelled         → the caller decides; segments are never split
//   - which TUI to send                                                               → the caller decides (configurable)
//   - every response code except 1903 ("Auto Cancellation Success" in the sample)    → anything else is "unknown": manual check
//   - whether GetRefund is a quote or changes anything                                → treated as possibly state-changing
//   - why the GetRefund sample answers with a different transactionID                → a mismatch is reported, never trusted

// ── Documented values ─────────────────────────────────────────────────────────

// The only CancelType / Isfullrefund values Akbar has shown us (their sample). Their meaning is not
// documented, so no other value can be sent: changing these needs a code change after Akbar answers.
export const AKBAR_CANCEL_TYPE = "R" as const;
export const AKBAR_IS_FULL_REFUND = false as const;

// The only documented Cancel response code: "1903" with Msg "Auto Cancellation Success".
export const AKBAR_CANCEL_CONFIRMED_CODE = "1903";

// Paths the Cancel URL may mean. The document shows "/Flights//Flights/Cancel"; every other Akbar
// flights call lives at "/flights/<Name>" on the same host. Only these can be configured.
export const AKBAR_CANCEL_PATHS = ["/Flights/Cancel", "/flights/cancel", "/Flights//Flights/Cancel"] as const;
export type AkbarCancelPath = (typeof AKBAR_CANCEL_PATHS)[number];
export const AKBAR_CANCEL_PATH_DEFAULT: AkbarCancelPath = "/Flights/Cancel";
export const AKBAR_GET_REFUND_PATH = "/Flights/GetRefund";

// ── RetrieveBooking → what can be cancelled ───────────────────────────────────
// RetrieveBooking (already used by the booking flow; shape from the UAT certification files):
//   Pax[] { ID, PaxID, … }   Trips[].Journey[].Segments[].Flight { CRSPNR, APNR, TicketInfo[] { PaxID, TicketNo, Status } }
// TicketInfo.PaxID holds the Pax[].ID (e.g. 97700), which is the ID the Cancel sample sends.

export interface AkbarCancelPax {
  id: number;                 // Pax[].ID
  name: string;               // as Akbar returned it ("" when RetrieveBooking has no name fields)
  type: string;               // as Akbar returned it ("" when absent)
  tickets: string[];          // TicketNo per segment (non-empty ones)
}
export interface AkbarCancelSegment {
  trip: number; journey: number; segment: number;   // position in RetrieveBooking Trips[].Journey[].Segments[]
  crsPnr: string;
  route: string;              // "COK-DXB" when RetrieveBooking names the airports, else ""
  pax: { id: number; ticket: string; ticketStatus: string }[];
}
export interface AkbarCancelPlan {
  transactionId: number;
  retrieveTui: string;        // TUI of the RetrieveBooking answer ("" when absent)
  bookingStatus: string;      // RetrieveBooking Status, as Akbar wrote it
  segments: AkbarCancelSegment[];
  passengers: AkbarCancelPax[];
  pnrs: string[];
  problems: string[];         // anything that stops a cancellation request being built
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const posInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const firstStr = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) { const s = str(o[k]); if (s) return s; } return ""; };

export function akbarCancelPlan(retrieve: unknown, transactionId: number): AkbarCancelPlan {
  const r = obj(retrieve);
  const problems: string[] = [];
  const answered = posInt(r.TransactionID);
  if (answered !== null && answered !== transactionId) problems.push(`RetrieveBooking answered for transaction ${answered}, not ${transactionId}.`);

  const passengers = new Map<number, AkbarCancelPax>();
  for (const p of arr(r.Pax).map(obj)) {
    const id = posInt(p.ID);
    if (id === null) continue;
    const name = [firstStr(p, ["Title"]), firstStr(p, ["FName", "FirstName"]), firstStr(p, ["LName", "LastName"])].filter(Boolean).join(" ");
    passengers.set(id, { id, name, type: firstStr(p, ["PTC", "PaxType", "Type"]), tickets: [] });
  }
  if (!passengers.size) problems.push("RetrieveBooking returned no passengers (Pax[].ID).");

  const segments: AkbarCancelSegment[] = [];
  arr(r.Trips).forEach((t, ti) => arr(obj(t).Journey).forEach((j, ji) => arr(obj(j).Segments).forEach((s, si) => {
    const seg = obj(s);
    const flight = obj(seg.Flight);
    const crsPnr = firstStr(flight, ["CRSPNR"]) || firstStr(seg, ["CRSPNR"]);
    const from = firstStr(flight, ["DepartureCode", "Origin", "From"]);
    const to = firstStr(flight, ["ArrivalCode", "Destination", "To"]);
    const pax: AkbarCancelSegment["pax"] = [];
    for (const ti2 of arr(flight.TicketInfo).map(obj)) {
      const id = posInt(ti2.PaxID);
      if (id === null) continue;
      const ticket = str(ti2.TicketNo);
      pax.push({ id, ticket, ticketStatus: str(ti2.Status) });
      const known = passengers.get(id);
      if (!known) problems.push(`Segment ${segments.length + 1}: ticket for passenger ${id}, who is not in RetrieveBooking Pax[].`);
      else if (ticket && !known.tickets.includes(ticket)) known.tickets.push(ticket);
    }
    if (!crsPnr) problems.push(`Segment ${segments.length + 1} has no CRSPNR in RetrieveBooking.`);
    if (!pax.length) problems.push(`Segment ${segments.length + 1} lists no passengers (Flight.TicketInfo[].PaxID) in RetrieveBooking.`);
    segments.push({ trip: ti, journey: ji, segment: si, crsPnr, route: from && to ? `${from}-${to}` : "", pax });
  })));
  if (!segments.length) problems.push("RetrieveBooking returned no flight segments (Trips[].Journey[].Segments[]).");
  for (const p of passengers.values()) {
    if (!segments.some((s) => s.pax.some((x) => x.id === p.id))) problems.push(`Passenger ${p.id} is on no segment in RetrieveBooking.`);
  }

  return {
    transactionId,
    retrieveTui: firstStr(r, ["TUI"]),
    bookingStatus: firstStr(r, ["Status"]),
    segments,
    passengers: [...passengers.values()],
    pnrs: [...new Set(segments.map((s) => s.crsPnr).filter(Boolean))],
    problems: [...new Set(problems)],
  };
}

// ── Cancel request ────────────────────────────────────────────────────────────

export interface AkbarCancelRequest {
  transactionId: number;
  tui: string;
  remarks?: string;
  clientIp?: string;
  // Exactly what is to be cancelled, already filtered to the chosen passengers. A segment is never
  // split: every chosen passenger is cancelled on every segment they are on.
  segments: { trip: number; journey: number; crsPnr: string; pax: { id: number; ticket: string }[] }[];
}

// The documented body, Trips[].Journey[].Segments[] grouped as RetrieveBooking listed them.
export function akbarCancelBody(c: AkbarCancelRequest, clientId: string) {
  const trips = new Map<number, Map<number, { CRSPNR: string; Pax: { ID: number; Ticket: string }[] }[]>>();
  for (const s of c.segments) {
    if (!s.pax.length) continue;
    const journeys = trips.get(s.trip) ?? new Map();
    trips.set(s.trip, journeys);
    const segs = journeys.get(s.journey) ?? [];
    journeys.set(s.journey, segs);
    segs.push({ CRSPNR: s.crsPnr, Pax: s.pax.map((p) => ({ ID: p.id, Ticket: p.ticket })) });
  }
  return {
    ClientID:      clientId,
    ClientIP:      c.clientIp ?? "",
    Remarks:       c.remarks ?? "",
    TUI:           c.tui,
    TransactionID: c.transactionId,
    Trips: [...trips.entries()].sort(([a], [b]) => a - b).map(([, journeys]) => ({
      Journey: [...journeys.entries()].sort(([a], [b]) => a - b).map(([, segs]) => ({ Segments: segs })),
    })),
    Isfullrefund: AKBAR_IS_FULL_REFUND,
    CancelType:   AKBAR_CANCEL_TYPE,
  };
}

// What a Cancel answer means. Only the documented code is "confirmed"; it also has to carry a
// CancellationID and be for the transaction that was sent. Everything else needs a person to check.
export type AkbarCancelResult =
  | { kind: "CONFIRMED"; code: string; messages: string[]; cancellationId: string; tui: string; transactionId: number }
  | { kind: "UNKNOWN"; code: string; messages: string[]; cancellationId: string; tui: string; transactionId: number | null; reason: string };

const messagesOf = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);

export function akbarCancelResult(data: unknown, sentTransactionId: number): AkbarCancelResult {
  const d = obj(data);
  const code = str(d.Code);
  const messages = messagesOf(d.Msg);
  const cancellationId = posInt(d.CancellationID) !== null ? String(posInt(d.CancellationID)) : "";
  const transactionId = posInt(d.TransactionID);
  const tui = str(d.TUI);
  const base = { code, messages, cancellationId, tui };
  if (code !== AKBAR_CANCEL_CONFIRMED_CODE) {
    return { kind: "UNKNOWN", ...base, transactionId, reason: code ? `Akbar answered Code ${code}${messages.length ? ` (${messages.join("; ")})` : ""}; its meaning is not documented.` : "Akbar's answer has no Code." };
  }
  if (transactionId !== sentTransactionId) {
    return { kind: "UNKNOWN", ...base, transactionId, reason: `Code 1903, but for transaction ${transactionId ?? "(none)"} instead of ${sentTransactionId}.` };
  }
  if (!cancellationId) return { kind: "UNKNOWN", ...base, transactionId, reason: "Code 1903, but no CancellationID." };
  return { kind: "CONFIRMED", ...base, transactionId };
}

// A failed call: was the request certainly NOT delivered to Akbar? Only errors raised before the
// request left ZamraBooking, or answered by our own gateway before it forwarded anything, count.
// Timeouts, network errors, gateway "upstream" errors and every HTTP error from Akbar itself are
// "uncertain": Akbar may have cancelled, so nothing is retried and a person checks.
const GATEWAY_REFUSALS = new Set([
  "GATEWAY_AUTHENTICATION_FAILED", "GATEWAY_RATE_LIMITED", "UNSUPPORTED_AKBAR_ROUTE", "METHOD_NOT_ALLOWED", "REQUEST_TOO_LARGE", "INVALID_JSON",
]);
export function akbarCallNotSent(err: unknown): boolean {
  const e = err as { message?: unknown; statusCode?: unknown; responseSnippet?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  if (message.includes("AKBAR_GATEWAY_KEY is not set")) return true;          // thrown before fetch
  if (typeof e?.responseSnippet !== "string") return false;
  try {
    const body = JSON.parse(e.responseSnippet) as { error?: unknown };
    return typeof body?.error === "string" && GATEWAY_REFUSALS.has(body.error) && [400, 401, 404, 405, 413, 429].includes(Number(e.statusCode));
  } catch { return false; }
}

// ── GetRefund (request + reader only; see the API for when it may be called) ─────

export function akbarGetRefundBody(p: { tui: string; transactionId: number }) {
  return { TUI: p.tui, TransactionId: p.transactionId, CancelType: AKBAR_CANCEL_TYPE };
}

export interface AkbarRefundLine {
  from: string; to: string; travelType: string; tripType: string; paxType: string;
  cancellationCharge: number | null; providerCharge: number | null; atoCharge: number | null; k3Charge: number | null;
  rafCharge: number | null; stfCharge: number | null; vatOnAtoCancelCharges: number | null;
  netAmount: number | null; refundAmount: number | null;
}
export interface AkbarRefundDetails {
  code: string; messages: string[]; ok: boolean;          // ok: Code "200" (the sample's)
  tui: string; transactionId: number | null; transactionIdMatches: boolean;
  trips: { route: string; travelType: string; refundable: boolean | null; fuId: string; lines: AkbarRefundLine[] }[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// Amounts are kept per line as Akbar wrote them: whether a line is per passenger or for all passengers
// of that type is not documented, so no totals are worked out.
export function akbarRefundDetails(data: unknown, sentTransactionId: number): AkbarRefundDetails {
  const d = obj(data);
  const code = str(d.Code);
  const transactionId = posInt(d.transactionID ?? d.TransactionID ?? d.TransactionId);
  return {
    code, messages: messagesOf(d.Msg), ok: code === "200",
    tui: str(d.TUI), transactionId, transactionIdMatches: transactionId === sentTransactionId,
    trips: arr(d.Trips).map(obj).map((t) => ({
      route: str(t.destOrgin), travelType: str(t.travelType),
      refundable: typeof t.refundable === "boolean" ? t.refundable : null, fuId: str(t.fuId),
      lines: arr(t.Itineraries).map(obj).map((i) => ({
        from: str(i.from), to: str(i.to), travelType: str(i.travelType), tripType: str(i.tripType), paxType: str(i.paxtype),
        cancellationCharge: num(i.cancellationCharge), providerCharge: num(i.providerCharge), atoCharge: num(i.atoCharge),
        k3Charge: num(i.K3Charge), rafCharge: num(i.rafCharge), stfCharge: num(i.stfCharge),
        vatOnAtoCancelCharges: num(i.VATONATOCancelCharges), netAmount: num(i.netAmount), refundAmount: num(i.refundAmount),
      })),
    })),
  };
}
