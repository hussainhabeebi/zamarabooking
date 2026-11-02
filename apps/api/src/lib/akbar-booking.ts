// Akbar Travels (Benzy B2B Revamp) API booking, following the Postman collection:
//
//   Signature → ExpressSearch → GetExpSearch           (search, routes/search.ts)
//   SmartPricer (Mode AS) → GetSPricer                  (live fare; validated against the searched fare)
//   GetTravelCheckList                                  (documents the airline requires)
//   SSR / SeatLayout                                    (read-only lookups for the certification logs)
//   CreateItinerary → StartPay (deposit)                (the booking)
//   GetItineraryStatus → RetrieveBooking                (status, PNR, ticket numbers)
//
// Safety rules:
//   • Off unless Admin → Integrations → Akbar "API booking" is MANUAL or AUTO, and in the
//     PRODUCTION environment only when the Worker variable AKBAR_API_BOOKING_PRODUCTION is
//     "approved" (set after UAT certification).
//   • State is saved before every irreversible call. StartPay is sent at most once per leg:
//     once a leg is PAYMENT_SENT, later runs only ask Akbar for its status.
//   • PNRs and ticket numbers are stored only when Akbar returned them.
//   • A failure before StartPay leaves the booking with staff (the existing offline flow).
//   • Round trip / multi-city: each leg is a one-way Akbar search, so each leg is its own
//     itinerary, booked in order; a later leg is never started while an earlier one isn't booked.

import {
  AkbarError, akbarBookingRefs, akbarMessages, akbarNetAmount, akbarOk, akbarTransactionId, akbarTravelRequirements,
  itineraryFinalStatus, searchTui,
  type AkbarClient, type AkbarContactInfo, type AkbarToken, type AkbarTraveller, type AkbarTravelRequirements,
} from "@zamrabooking/suppliers";
import type { AkbarSettings } from "./flight-sources.js";

export type AkbarApiBookingMode = "OFF" | "MANUAL" | "AUTO";

export interface AkbarGate { allowed: boolean; auto: boolean; reason?: string }

export function akbarBookingGate(env: { AKBAR_API_BOOKING_PRODUCTION?: string }, s: Pick<AkbarSettings, "apiBooking" | "environment" | "enabled">): AkbarGate {
  const mode = s.apiBooking ?? "OFF";
  if (mode === "OFF") return { allowed: false, auto: false, reason: "Akbar API booking is off (Admin → Integrations → Akbar Travels)." };
  if (s.environment === "PRODUCTION" && env.AKBAR_API_BOOKING_PRODUCTION !== "approved") {
    return { allowed: false, auto: false, reason: "Akbar API booking is not approved for production yet (AKBAR_API_BOOKING_PRODUCTION)." };
  }
  return { allowed: true, auto: mode === "AUTO" };
}

// ── Inputs ───────────────────────────────────────────────────────────────────

// The searched fare of one leg, as remembered at search time (NormalizedFare.raw).
export interface AkbarLegRef { tui: string; index: string; orderId: number | string | null; netFare: number }

export function akbarLegRefs(flightData: Record<string, any>): AkbarLegRef[] {
  const off = flightData?.offline ?? {};
  const refs = Array.isArray(off.legs) && off.legs.length ? off.legs.map((l: any) => l?.sourceRef) : [off.sourceRef];
  return refs.map((r: any) => ({
    tui: String(r?.tui ?? ""), index: String(r?.index ?? ""), orderId: r?.orderId ?? null, netFare: Number(r?.netFare ?? 0),
  }));
}

export interface PaxInput {
  type: "ADULT" | "CHILD" | "INFANT";
  firstName: string; lastName: string;
  dob?: string | null; gender?: "M" | "F" | null;
  nationality?: string | null; passportNumber?: string | null; passportExpiry?: string | null; passportCountry?: string | null;
}

const PTC = { ADULT: "ADT", CHILD: "CHD", INFANT: "INF" } as const;
const ymd = (v?: string | Date | null) => (!v ? "" : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));

export function ageOn(dob: string, on: string): number | null {
  const b = Date.parse(dob), d = Date.parse(on);
  if (!Number.isFinite(b) || !Number.isFinite(d)) return null;
  const bd = new Date(b), dd = new Date(d);
  let age = dd.getUTCFullYear() - bd.getUTCFullYear();
  if (dd.getUTCMonth() < bd.getUTCMonth() || (dd.getUTCMonth() === bd.getUTCMonth() && dd.getUTCDate() < bd.getUTCDate())) age--;
  return age >= 0 ? age : null;
}

// Zamra passengers → CreateItinerary Travellers, plus what is missing for Akbar.
export function akbarTravellers(pax: PaxInput[], departureDate: string, req?: Pick<AkbarTravelRequirements, "passport" | "dob" | "nationality">) {
  const problems: string[] = [];
  const travellers: AkbarTraveller[] = pax.map((p, i) => {
    const who = `Traveller ${i + 1}`;
    const dob = ymd(p.dob);
    if (!p.gender) problems.push(`${who}: gender is required.`);
    if (p.type !== "ADULT" && !dob) problems.push(`${who}: date of birth is required for children and infants.`);
    if (req?.dob && !dob) problems.push(`${who}: date of birth is required for this flight.`);
    if (req?.passport && (!p.passportNumber || !p.passportExpiry)) problems.push(`${who}: passport number and expiry are required for this flight.`);
    if (req?.nationality && !p.nationality) problems.push(`${who}: nationality is required for this flight.`);
    const male = p.gender !== "F";
    const title = p.type === "ADULT" ? (male ? "Mr" : "Ms") : (male ? "Mstr" : "Miss");
    return {
      id: i + 1, title, fName: p.firstName.trim(), lName: p.lastName.trim(),
      age: dob ? ageOn(dob, departureDate) : null, dob, gender: male ? "M" : "F", ptc: PTC[p.type],
      nationality: (p.nationality ?? "").toUpperCase(), passportNo: (p.passportNumber ?? "").toUpperCase(),
      pli: (p.passportCountry ?? "").toUpperCase(), pdoe: ymd(p.passportExpiry), visaType: "",
    };
  });
  return { travellers, problems };
}

export interface ContactSettings { contactAddress: string; contactCity: string; contactState: string; contactPin: string; contactCountryCode: string }

// 10-digit Indian mobile when the number is +91…; otherwise the digits as entered.
export const akbarMobile = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  return d.length === 12 && d.startsWith("91") ? d.slice(2) : d;
};

export function akbarContact(
  s: ContactSettings, lead: { firstName: string; lastName: string }, email: string, phone: string,
  gst?: { gstNumber: string; registeredName: string; email?: string; mobile?: string } | null,
): { contact: AkbarContactInfo; problems: string[] } {
  const problems = !s.contactAddress || !s.contactCity || !s.contactState || !s.contactPin
    ? ["Akbar contact address (address, city, state, PIN) is not set in Admin → Integrations → Akbar Travels."] : [];
  return {
    problems,
    contact: {
      fName: lead.firstName.trim(), lName: lead.lastName.trim(), mobile: akbarMobile(phone), email,
      address: s.contactAddress, city: s.contactCity, state: s.contactState, pin: s.contactPin, countryCode: s.contactCountryCode || "IN",
      ...(gst ? { gst: { companyName: gst.registeredName, tin: gst.gstNumber.toUpperCase(), mobile: gst.mobile, email: gst.email } } : {}),
    },
  };
}

// ── State (bookings.flight_data.akbarBooking) ────────────────────────────────

export type AkbarLegStep = "PRICED" | "ITINERARY_CREATED" | "PAYMENT_SENT" | "SUCCESS" | "FAILED" | "PENDING";
export interface AkbarLegState {
  leg: number;
  state: AkbarLegStep;
  pricedTui?: string; pricedNetAmount?: number; pricedAt?: string;
  requirements?: { passport: boolean; dob: boolean; nationality: boolean; visa: boolean };
  transactionId?: number; itineraryTui?: string; itineraryNetAmount?: number; itineraryAt?: string;
  paymentSentAt?: string;
  status?: "Success" | "Failed" | "";
  pnrs?: string[]; tickets?: string[];
  errorCode?: string; message?: string; checkedAt?: string;
}
export type AkbarOutcome = "TICKETED" | "PENDING" | "FAILED_BEFORE_PAYMENT" | "FAILED" | "PARTIAL";
export interface AkbarBookingState { legs: AkbarLegState[]; startedAt: string; finishedAt?: string; outcome?: AkbarOutcome; runs: number }

const paymentSent = (l?: AkbarLegState) => !!l?.paymentSentAt;

export function akbarOutcome(state: AkbarBookingState, legCount: number): AkbarOutcome {
  const legs = Array.from({ length: legCount }, (_, i) => state.legs.find((l) => l.leg === i));
  if (legs.every((l) => l?.state === "SUCCESS")) return "TICKETED";
  if (legs.some((l) => l?.state === "PENDING" || l?.state === "PAYMENT_SENT")) return "PENDING";
  const booked = legs.filter((l) => l?.state === "SUCCESS").length;
  if (booked > 0) return "PARTIAL";
  return legs.some(paymentSent) ? "FAILED" : "FAILED_BEFORE_PAYMENT";
}

// ── Engine ───────────────────────────────────────────────────────────────────

type Client = Pick<AkbarClient, "smartPricer" | "getSPricer" | "getTravelCheckList" | "ssr" | "seatLayout" | "createItinerary" | "startPay" | "getItineraryStatus" | "retrieveBooking">;

export interface AkbarEngineDeps {
  client: Client;
  token: (fresh?: boolean) => Promise<AkbarToken>;
  save: (state: AkbarBookingState) => Promise<void>;
  log: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface AkbarEngineInput {
  legs: AkbarLegRef[];
  pax: PaxInput[];
  departureDates: string[];            // per leg, YYYY-MM-DD (traveller ages)
  contact: AkbarContactInfo;
  state?: AkbarBookingState | null;
  fareTolerance?: number;              // INR; a priced fare above searched + tolerance is refused
  lookups?: boolean;                   // SSR + SeatLayout calls for the certification logs
  freshToken?: boolean;                // new Signature (UAT: puts Signature in the booking's logs)
  pricingMaxAgeMs?: number;            // reuse a pre-payment GetSPricer TUI this young
  statusDeadlineMs?: number;           // GetItineraryStatus polling
}

export class AkbarStepError extends Error {
  constructor(readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) { super(message); this.name = "AkbarStepError"; }
}

const msgOf = (err: unknown) => err instanceof AkbarError
  ? `${err.message}${err.responseSnippet ? `: ${err.responseSnippet.slice(0, 300)}` : ""}`
  : err instanceof Error ? err.message : String(err);

function authed(deps: AkbarEngineDeps, fresh: boolean) {
  let token: Promise<AkbarToken> | null = null;
  let firstFresh = fresh;
  const get = (force: boolean) => {
    if (force || !token) { token = deps.token(force || firstFresh); firstFresh = false; }
    return token;
  };
  return async <T>(fn: (t: AkbarToken) => Promise<T>): Promise<T> => {
    const t = await get(false);
    try { return await fn(t); }
    catch (err) {
      if (!(err instanceof AkbarError && err.statusCode === 401)) throw err;
      return fn(await get(true));   // Akbar no longer accepts the cached token: one retry with a new one
    }
  };
}

// SmartPricer (Mode AS, as in the collection) → GetSPricer until it returns a NetAmount.
export async function priceAkbarLeg(deps: AkbarEngineDeps, call: ReturnType<typeof authed>, leg: AkbarLegRef, tolerance = 1) {
  if (!leg.tui || !leg.index || !(leg.netFare > 0)) throw new AkbarStepError("FARE_REFERENCE_MISSING", "The searched Akbar fare reference (TUI / Index / NetFare) is missing.");
  const trip = { amount: leg.netFare, index: leg.index, orderId: leg.orderId ?? 1, tui: leg.tui };
  const sp = await call((t) => deps.client.smartPricer([trip], "ON", t, "AS", ""));
  if (!akbarOk(sp)) throw new AkbarStepError("FARE_UNAVAILABLE", `SmartPricer: ${akbarMessages(sp) || "fare not available"}`);
  const tui = searchTui(sp) || leg.tui;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let priced: unknown = null;
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(2000);
    priced = await call((t) => deps.client.getSPricer(tui, t));
    if (akbarNetAmount(priced) != null) break;
    if (akbarCodeIsError(priced)) break;
  }
  const net = akbarNetAmount(priced);
  if (!akbarOk(priced) || net == null || net <= 0) throw new AkbarStepError("FARE_UNAVAILABLE", `GetSPricer: ${akbarMessages(priced) || "no live fare returned"}`);
  if (net > leg.netFare + tolerance) {
    throw new AkbarStepError("FARE_INCREASED", `The live fare is ₹${net} (searched ₹${leg.netFare}).`, { searched: leg.netFare, priced: net });
  }
  return { pricedTui: searchTui(priced) || tui, pricedNetAmount: net };
}
const akbarCodeIsError = (d: unknown) => {
  const code = d && typeof d === "object" ? String((d as Record<string, unknown>).Code ?? "") : "";
  return !!code && code !== "200" && !/progress|pending/i.test(akbarMessages(d));
};

export async function travelRequirements(deps: AkbarEngineDeps, call: ReturnType<typeof authed>, pricedTui: string) {
  try {
    const r = akbarTravelRequirements(await call((t) => deps.client.getTravelCheckList(pricedTui, t)));
    return { passport: r.passport, dob: r.dob, nationality: r.nationality, visa: r.visa };
  } catch (err) {
    await deps.log("warn", `GetTravelCheckList failed; continuing with the basic traveller checks: ${msgOf(err)}`);
    return null;
  }
}

// Pre-payment check (POST /api/book): every leg priced live and the travellers checked.
export async function akbarPrepaymentCheck(deps: AkbarEngineDeps, input: Pick<AkbarEngineInput, "legs" | "pax" | "departureDates" | "fareTolerance">) {
  const call = authed(deps, false);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const legs: AkbarLegState[] = [];
  for (const [i, leg] of input.legs.entries()) {
    const priced = await priceAkbarLeg(deps, call, leg, input.fareTolerance);
    const requirements = await travelRequirements(deps, call, priced.pricedTui);
    const { problems } = akbarTravellers(input.pax, input.departureDates[i] ?? input.departureDates[0], requirements ?? undefined);
    if (problems.length) throw new AkbarStepError("TRAVELLER_DETAILS_MISSING", problems.join(" "), { leg: i, problems });
    legs.push({ leg: i, state: "PRICED", ...priced, pricedAt: now, ...(requirements ? { requirements } : {}) });
  }
  return { legs, startedAt: now, runs: 0 } satisfies AkbarBookingState;
}

// Status of a leg whose StartPay was sent: GetItineraryStatus (until final or deadline),
// then RetrieveBooking for the PNR / tickets. Read-only; safe to repeat.
export async function checkAkbarLeg(deps: AkbarEngineDeps, call: ReturnType<typeof authed>, l: AkbarLegState, deadlineMs = 60_000): Promise<AkbarLegState> {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  if (!l.transactionId) return l;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let status: "Success" | "Failed" | "" = "";
  let statusData: unknown = null;
  for (;;) {
    try {
      statusData = await call((t) => deps.client.getItineraryStatus(l.transactionId!, l.itineraryTui ?? "", t));
      status = itineraryFinalStatus(statusData);
    } catch (err) {
      await deps.log("warn", `GetItineraryStatus failed for transaction ${l.transactionId}: ${msgOf(err)}`);
    }
    if (status || Date.now() - started + 3000 >= deadlineMs) break;
    await sleep(3000);
  }
  let refs = akbarBookingRefs(statusData);
  let bookingFailureReason = "";
  let bookingStatus = "";
  try {
    const booking = await call((t) => deps.client.retrieveBooking(l.transactionId!, t, l.itineraryTui ?? ""));
    // A successful HTTP/API envelope does not mean the airline booking succeeded.
    // Preserve an actual supplier failure reason; never use generic Msg: ["Success"].
    if (booking && typeof booking === "object") {
      const b = booking as Record<string, unknown>;
      bookingFailureReason = [b.BookingFailureReason, b.Reason]
        .find((v): v is string => typeof v === "string" && !!v.trim())?.trim() ?? "";
      bookingStatus = typeof b.Status === "string" ? b.Status.trim() : "";
    }
    const r = akbarBookingRefs(booking);
    refs = { pnrs: [...new Set([...refs.pnrs, ...r.pnrs])], tickets: [...new Set([...refs.tickets, ...r.tickets])] };
  } catch (err) {
    await deps.log("warn", `RetrieveBooking failed for transaction ${l.transactionId}: ${msgOf(err)}`);
  }
  const next: AkbarLegState = { ...l, status, checkedAt: now(), ...(refs.pnrs.length ? { pnrs: refs.pnrs } : {}), ...(refs.tickets.length ? { tickets: refs.tickets } : {}) };
  if (status === "Success" && refs.pnrs.length) return { ...next, state: "SUCCESS", message: undefined, errorCode: undefined };
  if (status === "Failed") {
    const statusMessage = akbarMessages(statusData).trim();
    const reason = bookingFailureReason || (/^success[.!]?$/i.test(statusMessage) ? "" : statusMessage);
    const message = reason
      ? `Akbar reports the booking failed: ${reason}`
      : `Akbar reports the booking failed${bookingStatus ? ` (RetrieveBooking status ${bookingStatus})` : ""}. No detailed failure reason was returned.`;
    return { ...next, state: "FAILED", errorCode: "BOOKING_FAILED", message };
  }
  return { ...next, state: "PENDING", message: status === "Success" ? "Akbar reports success but returned no PNR yet." : "Akbar has not finished the booking yet." };
}

export async function runAkbarBooking(deps: AkbarEngineDeps, input: AkbarEngineInput): Promise<AkbarBookingState> {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const state: AkbarBookingState = input.state
    ? { ...input.state, legs: input.state.legs.map((l) => ({ ...l })), runs: (input.state.runs ?? 0) + 1 }
    : { legs: [], startedAt: now(), runs: 1 };
  const call = authed(deps, !!input.freshToken);
  const tolerance = input.fareTolerance ?? 1;
  const maxAge = input.pricingMaxAgeMs ?? 10 * 60_000;
  const put = async (l: AkbarLegState) => {
    state.legs = [...state.legs.filter((x) => x.leg !== l.leg), l].sort((a, b) => a.leg - b.leg);
    await deps.save(state);
  };

  for (const [i, ref] of input.legs.entries()) {
    let l: AkbarLegState = state.legs.find((x) => x.leg === i) ?? { leg: i, state: "PRICED" };
    if (l.state === "SUCCESS") continue;
    // A leg that stopped before payment starts again from a fresh price and a new itinerary.
    if (l.state === "FAILED" && !paymentSent(l)) l = { leg: i, state: "PRICED" };

    // StartPay already went out for this leg: only ask Akbar what happened. Never pay again.
    if (paymentSent(l)) {
      l = await checkAkbarLeg(deps, call, l, input.statusDeadlineMs);
      await put(l);
      if (l.state !== "SUCCESS") break;
      continue;
    }

    try {
      // 1. Live fare. A pre-payment price is reused while it is fresh.
      const fresh = l.state === "PRICED" && l.pricedTui && l.pricedAt && Date.parse(now()) - Date.parse(l.pricedAt) < maxAge;
      if (!fresh && !l.transactionId) {
        const priced = await priceAkbarLeg(deps, call, ref, tolerance);
        l = { leg: i, state: "PRICED", ...priced, pricedAt: now() };
        const requirements = await travelRequirements(deps, call, l.pricedTui!);
        if (requirements) l.requirements = requirements;
        await put(l);
      }
      const { travellers, problems } = akbarTravellers(input.pax, input.departureDates[i] ?? input.departureDates[0], l.requirements);
      if (problems.length) throw new AkbarStepError("TRAVELLER_DETAILS_MISSING", problems.join(" "));

      // 2. Ancillary lookups (read-only). The collection's CreateItinerary sends SSR: [];
      //    selections are not sent until Akbar documents the SSR item format.
      if (input.lookups && !l.transactionId) {
        for (const [name, fn] of [
          ["SeatLayout", (t: AkbarToken) => deps.client.seatLayout({ tui: l.pricedTui!, orderId: ref.orderId ?? 1 }, t)],
          ["SSR", (t: AkbarToken) => deps.client.ssr({ tui: l.pricedTui!, orderId: ref.orderId ?? 1, index: "" }, false, t)],
        ] as const) {
          await call(fn).catch((err) => deps.log("warn", `${name} lookup failed (booking continues): ${msgOf(err)}`));
        }
      }

      // 3. CreateItinerary (no payment). A rerun after a failure may create a new itinerary;
      //    an unpaid itinerary is never ticketed, so this cannot double-book.
      if (!l.transactionId) {
        const it = await call((t) => deps.client.createItinerary({
          tui: l.pricedTui!, netAmount: l.pricedNetAmount!, contact: input.contact, travellers,
        }, t));
        const transactionId = akbarTransactionId(it);
        if (!akbarOk(it) || !transactionId) throw new AkbarStepError("ITINERARY_FAILED", `CreateItinerary: ${akbarMessages(it) || "no TransactionID returned"}`);
        const itineraryNetAmount = akbarNetAmount(it) ?? l.pricedNetAmount!;
        l = { ...l, state: "ITINERARY_CREATED", transactionId, itineraryTui: searchTui(it) || l.pricedTui, itineraryNetAmount, itineraryAt: now() };
        await put(l);
        if (itineraryNetAmount > ref.netFare + tolerance) {
          throw new AkbarStepError("FARE_INCREASED", `CreateItinerary NetAmount ₹${itineraryNetAmount} is above the searched ₹${ref.netFare}.`);
        }
      }
    } catch (err) {
      const code = err instanceof AkbarStepError ? err.code : "AKBAR_CALL_FAILED";
      l = { ...l, state: "FAILED", errorCode: code, message: msgOf(err) };
      await put(l);
      await deps.log("error", `Akbar leg ${i + 1}: stopped before payment (${code}) — ${l.message}`);
      break;
    }

    // 4. StartPay — saved as sent BEFORE the call, so no later run can send it again.
    l = { ...l, state: "PAYMENT_SENT", paymentSentAt: now() };
    await put(l);   // throws if the state can't be saved → StartPay is not sent
    await deps.log("info", `Akbar leg ${i + 1}: StartPay for transaction ${l.transactionId} (₹${l.itineraryNetAmount})`);
    try {
      const pay = await call((t) => deps.client.startPay({ transactionId: l.transactionId!, netAmount: l.itineraryNetAmount!, tui: l.itineraryTui! }, t));
      if (!akbarOk(pay)) await deps.log("warn", `StartPay answered Code ${String((pay as any)?.Code ?? "")}: ${akbarMessages(pay)} — checking the itinerary status`);
    } catch (err) {
      await deps.log("warn", `StartPay outcome unknown (${msgOf(err)}) — checking the itinerary status; StartPay will not be resent`);
    }

    // 5. Status + RetrieveBooking.
    l = await checkAkbarLeg(deps, call, l, input.statusDeadlineMs);
    await put(l);
    await deps.log(l.state === "SUCCESS" ? "info" : l.state === "FAILED" ? "error" : "warn",
      `Akbar leg ${i + 1}: ${l.state}${l.pnrs?.length ? ` — PNR ${l.pnrs.join(", ")}` : ""}${l.message ? ` — ${l.message}` : ""}`,
      { transactionId: l.transactionId, tickets: l.tickets ?? [] });
    if (l.state !== "SUCCESS") break;
  }

  state.outcome = akbarOutcome(state, input.legs.length);
  state.finishedAt = now();
  await deps.save(state);
  return state;
}

// Status refresh for legs whose StartPay was sent (Admin → Bookings). Read-only.
export async function refreshAkbarBooking(deps: AkbarEngineDeps, state: AkbarBookingState, legCount: number, deadlineMs = 15_000): Promise<AkbarBookingState> {
  const call = authed(deps, false);
  const next: AkbarBookingState = { ...state, legs: state.legs.map((l) => ({ ...l })) };
  for (const [i, l] of next.legs.entries()) {
    if (paymentSent(l) && l.state !== "SUCCESS") next.legs[i] = await checkAkbarLeg(deps, call, l, deadlineMs);
  }
  next.outcome = akbarOutcome(next, legCount);
  await deps.save(next);
  return next;
}
