"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { SeatPicker, seatCss, type SegmentSeatMap } from "./SeatPicker";
import { ScanDocument, type ScannedTraveller } from "../components/ScanDocument";
import SocialSignIn from "./SocialSignIn";
import { bookingError } from "./booking-error";
import { passengerNameProblem } from "./passenger-names";
import { CURRENCY_EVENT, readPrefCurrency, savePrefCurrency } from "../lib/currency-pref";
import { convertInr, fetchFxRates, formatIn, GCC, isDisplayCurrency, type DisplayCurrency, type FxRates } from "../lib/fx";

type Passenger = {
  type: "ADULT" | "CHILD" | "INFANT";
  firstName: string; lastName: string;
  dob: string; gender: "M" | "F";
  nationality: string;
  passportNumber: string; passportExpiry: string;
  passportIssueDate: string; panNumber: string; documentId: string;
  // Chosen SSR per TripJack segment key → SSR code.
  bag: Record<string, string>; meal: Record<string, string>; seat: Record<string, string>;
};

type SsrOption = { code: string; amount: number; desc: string };
type ReviewSegment = { key: string; airline: string; airlineName?: string; flightNumber: string; origin: string; destination: string; departureTime: string; arrivalTime?: string; duration?: number; isReturn?: boolean; ssr: { baggage: SsrOption[]; meal: SsrOption[]; extra: SsrOption[] } };
type Review = {
  bookingId: string; totalFare?: number; displayTotal?: number; currency?: string; expiresAt?: string;
  fareIdentifiers: string[];
  fareAlert?: { oldFare?: number; newFare?: number; message?: string };
  segments: ReviewSegment[];
  conditions: {
    holdAllowed: boolean; seatApplicable: boolean; emergencyContactRequired: boolean;
    gstMandatory: boolean; gstApplicable: boolean;
    passportMandatory: boolean; passportExpiryRequired: boolean;
    dobRequired: { ADULT: boolean; CHILD: boolean; INFANT: boolean };
    panApplicable: boolean; documentIdApplicable: boolean; documentIdMandatory: boolean;
  };
};

type FareInfo = {
  fareId: string; supplier: string;
  airlineName: string; flightNumber: string;
  origin: string; destination: string;
  departureTime: string; arrivalTime: string;
  duration: number; stops: number;
  totalFare: number; currency: string;
  isRefundable: boolean; cabinChecked: string;
};

type SavedPassenger = {
  id: string;
  firstName: string; lastName: string;
  dob: string | null; gender: string | null;
  nationality: string | null;
  passportNumber: string | null; passportExpiry: string | null;
  isDefault: boolean;
};

const emptyPassenger = (type: Passenger["type"] = "ADULT"): Passenger => ({
  type, firstName: "", lastName: "", dob: "", gender: "M", nationality: "IN",
  passportNumber: "", passportExpiry: "",
  passportIssueDate: "", panNumber: "", documentId: "", bag: {}, meal: {}, seat: {},
});

const AIRPORT_COUNTRY: Record<string, string> = {
  BOM:"IN", DEL:"IN", CCJ:"IN", COK:"IN", TRV:"IN", CNN:"IN", IXE:"IN", MAA:"IN", BLR:"IN",
  HYD:"IN", AMD:"IN", PNQ:"IN", GOI:"IN", CCU:"IN", LKO:"IN", IXJ:"IN",
  SXR:"IN", ATQ:"IN", IXC:"IN", VTZ:"IN", IXB:"IN", GAU:"IN", IXA:"IN",
  DXB:"AE", AUH:"AE", SHJ:"AE", RKT:"AE", FJR:"AE", AAN:"AE", DWC:"AE",
  DOH:"QA", MCT:"OM", SLL:"OM", MED:"SA", BAH:"BH", KWI:"KW", RUH:"SA", JED:"SA", DMM:"SA",
  LHR:"GB", CDG:"FR", FRA:"DE", SIN:"SG", KUL:"MY", BKK:"TH",
  HKG:"HK", NRT:"JP", JFK:"US", LAX:"US", ORD:"US", YYZ:"CA", SYD:"AU", MEL:"AU",
  CMB:"LK", KTM:"NP", DAC:"BD", MLE:"MV",
};

// "Book this trip again" (My Trips) leaves the travellers in sessionStorage;
// fill them in by type when booking the same route.
type RebookTraveller = { type: string; firstName: string; lastName: string; dob: string | null; gender: string | null; nationality: string | null; passportNumber: string | null; passportExpiry: string | null };
function withRebookTravellers(list: Passenger[], from: string, to: string): Passenger[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem("rebook_travellers") ?? "null") as { origin: string; destination: string; at: number; travellers: RebookTraveller[] } | null;
    if (!saved || Date.now() - saved.at > 6 * 3600_000) return list;
    if (saved.origin !== from.toUpperCase() || saved.destination !== to.toUpperCase()) return list;
    const pool = [...saved.travellers];
    return list.map((p) => {
      const i = pool.findIndex((t) => t.type === p.type);
      if (i < 0) return p;
      const t = pool.splice(i, 1)[0];
      return {
        ...p, firstName: t.firstName, lastName: t.lastName, dob: t.dob ?? "",
        gender: t.gender === "F" ? "F" : "M", nationality: t.nationality ?? p.nationality,
        passportNumber: t.passportNumber ?? "", passportExpiry: t.passportExpiry ?? "",
      };
    });
  } catch {
    return list;
  }
}

type HandoffSession = {
  fareId: string; supplier: string; email?: string; mobile?: string;
  agentNumber?: string; agentCurrency?: string;   // Leadvyne Live Agency that sent the customer
  passengers: { type: Passenger["type"]; firstName: string; lastName: string; dob?: string; gender?: string; nationality?: string; passportNumber?: string; passportExpiry?: string }[];
};

// Fills flight details missing from the link (WhatsApp / Leadvyne hand-offs)
// from the airline's fare review.
function fillFromReview(f: FareInfo, r: Review): FareInfo {
  const segs = r.segments ?? [];
  const onward = segs.filter((s) => !s.isReturn);
  const legs = onward.length ? onward : segs;
  if (!legs.length) return f;
  const first = legs[0], last = legs[legs.length - 1];
  const price = r.displayTotal ?? r.totalFare;
  return {
    ...f,
    airlineName:   f.airlineName || first.airlineName || first.airline,
    flightNumber:  f.flightNumber || legs.map((s) => s.flightNumber).join(" / "),
    origin:        f.origin || first.origin,
    destination:   f.destination || last.destination,
    departureTime: f.departureTime || first.departureTime,
    arrivalTime:   f.arrivalTime || last.arrivalTime || "",
    // Airline segment durations (local clock times differ across time zones).
    duration:      f.duration || legs.reduce((n, s) => n + (s.duration ?? 0), 0),
    stops:         f.departureTime ? f.stops : Math.max(0, legs.length - 1),
    ...(!(f.totalFare > 0) && price ? { totalFare: price, currency: "INR" } : {}),
  };
}

// The flight's other fare options (Saver / Standard / Flexi…) passed from search:
// shows what this option includes and lets the customer switch or upgrade.
type AltOption = { id: string; label: string; price: number; checked: string; cabin: string; meal: string; ref: string };
function FareOptionSwitcher({ money, currentPrice, disabled }: { money: (n: number) => string; currentPrice: number; disabled: boolean }) {
  const [state, setState] = useState<{ current: AltOption; alts: AltOption[] } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    let alts: AltOption[] = [];
    try { alts = JSON.parse(q.get("alts") ?? "[]"); } catch {}
    const meal = q.get("meal");
    const current: AltOption = {
      id: q.get("fareId") ?? "", label: q.get("fl") ?? "Standard", price: Number(q.get("price")) || 0,
      checked: q.get("bag") ?? "", cabin: q.get("cab") ?? "", meal: meal === "1" ? "Free meal" : meal === "0" ? "Meal at cost" : "",
      ref: q.get("ref") === "1" ? "Refundable" : "Non-refundable",
    };
    if (alts.length) setState({ current, alts: alts.filter((a) => a && typeof a.id === "string" && a.price > 0) });
  }, []);
  if (!state || !state.alts.length) return null;

  function choose(o: AltOption) {
    const q = new URLSearchParams(window.location.search);
    const rest = [state!.current, ...state!.alts].filter((a) => a.id !== o.id);
    q.set("fareId", o.id); q.set("price", String(o.price)); q.set("bag", o.checked); q.set("cab", o.cabin); q.set("fl", o.label);
    q.set("ref", o.ref === "Non-refundable" ? "0" : "1");
    if (o.meal) q.set("meal", o.meal === "Free meal" ? "1" : "0"); else q.delete("meal");
    q.delete("priceIds");
    q.set("alts", JSON.stringify(rest));
    window.location.assign(`/book?${q.toString()}`);
  }

  // The chosen option first, then the others cheapest first.
  const all = [state.current, ...[...state.alts].sort((a, b) => a.price - b.price)];
  const base = currentPrice || state.current.price;
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <b style={{ fontSize: 15 }}>Fare options for this flight</b>
        <span style={{ fontSize: 12, color: "#667085" }}>{all.length} options</span>
      </div>
      <div style={{ display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(150px, 1fr)", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {all.map((o) => {
          const on = o.id === state.current.id;
          const diff = o.price - state.current.price;
          return (
            <button key={o.id} type="button" disabled={disabled || on} onClick={() => choose(o)}
              style={{ textAlign: "left", border: on ? "2px solid #ed1c24" : "1px solid #eaecf0", background: on ? "#fff1f2" : "#fff", borderRadius: 12, padding: 10, cursor: on ? "default" : "pointer", display: "flex", flexDirection: "column", gap: 4, font: "inherit", color: "#101828" }}>
              <b style={{ fontSize: 13 }}>{o.label}{on ? " ✓" : ""}</b>
              <span style={{ fontSize: 12, color: o.checked ? "#344054" : "#98a2b3" }}>🧳 {o.checked || "No check-in bag"}</span>
              {o.cabin && <span style={{ fontSize: 12, color: "#344054" }}>👜 {o.cabin} cabin</span>}
              {o.meal && <span style={{ fontSize: 12, color: o.meal === "Free meal" ? "#344054" : "#98a2b3" }}>🍽 {o.meal}</span>}
              <span style={{ fontSize: 12, color: o.ref === "Non-refundable" ? "#98a2b3" : "#067647" }}>{o.ref}</span>
              <b style={{ fontSize: 14, marginTop: 2 }}>{on ? money(base) : diff > 0 ? `+ ${money(diff)}` : `− ${money(-diff)}`}</b>
              {!on && <span style={{ fontSize: 12, fontWeight: 800, color: "#ed1c24" }}>{diff > 0 ? "Upgrade" : "Switch"} →</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function getToken(): string {
  try {
    const match = document.cookie.match(/(?:^|;\s*)poomas_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch { return ""; }
}

export default function BookPage() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
  const [fare, setFare] = useState<FareInfo | null>(null);
  const [passengers, setPassengers] = useState<Passenger[]>([emptyPassenger()]);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [bookingUncertain, setBookingUncertain] = useState(false);
  // Booking saved as PAYMENT_PENDING; retrying only restarts the payment, never re-books.
  const [pendingPayment, setPendingPayment] = useState<{ bookingId: string; checkoutToken: string } | null>(null);
  // Offered when a signed-in customer's wallet covers the whole (INR) fare.
  const [walletOffer, setWalletOffer] = useState<{ amount: number; balance: number } | null>(null);
  // Prices are shown in the visitor's currency (automatic exchange rates, INR per 1 unit).
  // Cards are charged in INR, or in AED for the GCC currencies.
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>("INR");
  const [rates, setRates] = useState<FxRates>({});
  // Leadvyne Live Agency that sent this customer (from the checkout link): tags the booking.
  const [leadAgentNumber, setLeadAgentNumber] = useState("");
  // Currency changed in the site menu: follow it here.
  useEffect(() => {
    const onChange = (e: Event) => { const c = (e as CustomEvent).detail; if (isDisplayCurrency(c)) setDisplayCurrency(c); };
    window.addEventListener(CURRENCY_EVENT, onChange);
    return () => window.removeEventListener(CURRENCY_EVENT, onChange);
  }, []);
  const aedRate = rates.AED ?? null;
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const [fareExpired, setFareExpired] = useState(false);
  const [confirmation, setConfirmation] = useState<any>(null);
  // Hold now, pay later (when the airline allows it).
  const [held, setHeld] = useState<{ bookingId: string; pnr: string | null; heldUntil: string; amount: number; currency: string; checkoutToken: string } | null>(null);
  // TripJack review (run on load): conditions, SSR options, fare alerts.
  const [review, setReview] = useState<Review | null>(null);
  const [seatMaps, setSeatMaps] = useState<SegmentSeatMap[] | null>(null);
  const [seatLoading, setSeatLoading] = useState(false);
  const [seatError, setSeatError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [tripType, setTripType] = useState<"ONEWAY" | "ROUNDTRIP" | "MULTICITY">("ONEWAY");
  const [useGst, setUseGst] = useState(false);
  const [gst, setGst] = useState({ gstNumber: "", registeredName: "", email: "", mobile: "", address: "" });
  const [emergency, setEmergency] = useState({ name: "", phone: "", email: "" });

  // Auth state
  const [token, setToken] = useState("");
  const [savedPassengers, setSavedPassengers] = useState<SavedPassenger[]>([]);
  const [saveDetails, setSaveDetails] = useState(false);

  // Inline login state
  const [showLogin, setShowLogin] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    // WhatsApp / Leadvyne hand-off: /book?session=<token> carries the fare and
    // travellers server-side (no flight details in the link).
    const session = q.get("session");
    if (session && !q.get("fareId")) {
      fetch(`${apiUrl}/api/integrations/checkout-sessions/${encodeURIComponent(session)}`, { headers: { "x-tenant-slug": "poomas" } })
        .then(async (r) => { if (!r.ok) throw new Error(); return r.json() as Promise<HandoffSession>; })
        .then((h) => {
          q.set("fareId", h.fareId); q.set("supplier", h.supplier);
          if (h.agentNumber) setLeadAgentNumber(h.agentNumber);
          if (h.agentCurrency && !q.get("pc")) q.set("pc", h.agentCurrency);
          start(q, h);
        })
        .catch(() => setReviewError("This booking link has expired. Please ask us on WhatsApp for a new one."));
      return;
    }
    start(q);
  }, []);

  function start(q: URLSearchParams, handoff?: HandoffSession) {
    const fareId   = q.get("fareId") ?? "";
    const supplier = q.get("supplier") ?? "";
    if (!fareId || !supplier) return;
    const count = (t: Passenger["type"]) => handoff?.passengers.filter((p) => p.type === t).length ?? 0;
    const adults   = Math.min(9, Math.max(1, handoff ? count("ADULT") : Number(q.get("adults")) || 1));
    const children = Math.min(6, Math.max(0, handoff ? count("CHILD") : Number(q.get("children")) || 0));
    const infants  = Math.min(4, Math.max(0, handoff ? count("INFANT") : Number(q.get("infants")) || 0));
    const blank = [
      ...Array.from({ length: adults },   () => emptyPassenger("ADULT")),
      ...Array.from({ length: children }, () => emptyPassenger("CHILD")),
      ...Array.from({ length: infants },  () => emptyPassenger("INFANT")),
    ];
    if (handoff) {
      const pool = [...handoff.passengers];
      setPassengers(blank.map((p) => {
        const i = pool.findIndex((x) => x.type === p.type);
        if (i < 0) return p;
        const h = pool.splice(i, 1)[0];
        return { ...p, firstName: h.firstName, lastName: h.lastName, dob: h.dob || "", gender: h.gender === "F" ? "F" : "M",
          nationality: h.nationality || p.nationality, passportNumber: h.passportNumber || "", passportExpiry: h.passportExpiry || "" };
      }));
      if (handoff.email) setEmail(handoff.email);
      if (handoff.mobile) setPhone(handoff.mobile);
    } else {
      setPassengers(withRebookTravellers(blank, q.get("from") ?? "", q.get("to") ?? ""));
    }
    // Without a price in the link the fare is shown in INR from the airline's
    // review; a requested AED display becomes the card currency instead.
    const priceKnown = Number(q.get("price")) > 0;
    const fareCurrency = priceKnown ? (q.get("cur") ?? "INR") : "INR";
    setFare({
      fareId, supplier,
      airlineName:   q.get("airline") ?? "",
      flightNumber:  q.get("fn") ?? "",
      origin:        q.get("from") ?? "",
      destination:   q.get("to") ?? "",
      departureTime: q.get("dep") ?? "",
      arrivalTime:   q.get("arr") ?? "",
      duration:      parseInt(q.get("dur") ?? "0"),
      stops:         parseInt(q.get("stops") ?? "0"),
      totalFare:     priceKnown ? parseFloat(q.get("price")!) : 0,
      currency:      fareCurrency,
      isRefundable:  q.get("ref") === "1",
      cabinChecked:  q.get("bag") ?? "",
    });

    const tt = q.get("tripType");
    if (tt === "ROUNDTRIP" || tt === "MULTICITY") setTripType(tt);
    if (supplier.toUpperCase() === "TRIPJACK") {
      const priceIds = (q.get("priceIds") ?? fareId).split(",").filter(Boolean);
      setReviewLoading(true);
      fetch(`${apiUrl}/api/book/review`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
        body: JSON.stringify({ priceIds, ...(q.get("sid") ? { searchId: q.get("sid") } : {}) }),
      })
        .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error ?? "We couldn't confirm availability."), { code: d.errorCode }); return d as Review; })
        .then((d) => { setReview(d); setFare((f) => f && fillFromReview(f, d)); if (d.conditions.gstMandatory) setUseGst(true); })
        .catch((e) => { if (e.code === "FARE_EXPIRED") setFareExpired(true); else setReviewError(e.message); })
        .finally(() => setReviewLoading(false));
    }

    // Offer AED when the admin has set a rate; start with the customer's chosen currency.
    // The visitor's fixed currency wins; links only decide when none was chosen yet.
    const wanted = readPrefCurrency() ?? q.get("pc") ?? (!priceKnown && q.get("cur") === "AED" ? "AED" : null);
    if (fareCurrency === "INR") {
      fetchFxRates(apiUrl).then((r) => {
        setRates(r);
        if (isDisplayCurrency(wanted) && (wanted === "INR" || r[wanted])) setDisplayCurrency(wanted);
      });
    }
  }

  useEffect(() => {
    const t = getToken();
    if (t) {
      setToken(t);
      fetchSavedPassengers(t);
    }
  }, []);

  async function fetchSavedPassengers(t: string) {
    try {
      const res = await fetch(`${apiUrl}/api/profile/passengers`, {
        headers: { "Authorization": `Bearer ${t}`, "x-tenant-slug": "poomas" },
      });
      if (res.ok) {
        const d = await res.json() as { passengers: SavedPassenger[] };
        setSavedPassengers(d.passengers ?? []);
        const def = d.passengers.find((p) => p.isDefault);
        if (def) setPassengers((prev) => prev.map((p, i) => i === 0 && !p.firstName && !p.lastName
          ? { ...p, firstName: def.firstName, lastName: def.lastName, dob: def.dob?.slice(0, 10) ?? p.dob,
              gender: (def.gender as "M" | "F") ?? p.gender, nationality: def.nationality ?? p.nationality,
              passportNumber: def.passportNumber ?? p.passportNumber, passportExpiry: def.passportExpiry?.slice(0, 10) ?? p.passportExpiry }
          : p));
      }
    } catch { /* non-fatal */ }
  }

  function applyProfile(p: SavedPassenger, idx: number) {
    setPassengers((prev) => prev.map((x, i) => i !== idx ? x : {
      ...x,
      firstName:      p.firstName,
      lastName:       p.lastName,
      dob:            p.dob ? p.dob.slice(0, 10) : x.dob,
      gender:         (p.gender as "M" | "F") ?? x.gender,
      nationality:    p.nationality ?? x.nationality,
      passportNumber: p.passportNumber ?? x.passportNumber,
      passportExpiry: p.passportExpiry ? p.passportExpiry.slice(0, 10) : x.passportExpiry,
    }));
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginError("");
    setLoggingIn(true);
    try {
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword }),
      });
      const d = await res.json() as any;
      if (!res.ok) throw new Error(d.error ?? "Login failed");
      document.cookie = `poomas_token=${d.token}; Path=/; SameSite=Lax; Secure`;
      setToken(d.token);
      setShowLogin(false);
      await fetchSavedPassengers(d.token);
    } catch (x: any) {
      setLoginError(x?.message ?? "Login failed");
    } finally {
      setLoggingIn(false);
    }
  }

  const isInternational = useMemo(() => {
    if (!fare) return false;
    const fromC = AIRPORT_COUNTRY[fare.origin.toUpperCase()];
    const toC   = AIRPORT_COUNTRY[fare.destination.toUpperCase()];
    return !!fromC && !!toC && fromC !== toC;
  }, [fare]);

  const money = useMemo(() => {
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency", currency: fare?.currency ?? "INR", maximumFractionDigits: 0,
      });
    } catch { return new Intl.NumberFormat("en"); }
  }, [fare?.currency]);

  // Any amount (fare, extra bag, meal, seat) in the chosen card currency,
  // rounded up like the payment API.
  const fareInInr = fare?.currency === "INR";
  const shownCur: DisplayCurrency = fareInInr && displayCurrency !== "INR" && rates[displayCurrency] ? displayCurrency : "INR";
  const payCurrency: "INR" | "AED" = shownCur !== "INR" && (GCC as readonly string[]).includes(shownCur) && aedRate ? "AED" : "INR";
  const inForeign = shownCur !== "INR";
  const amt = (inr: number) => {
    const v = inForeign ? convertInr(inr, shownCur, rates) : null;
    return v === null ? money.format(inr) : formatIn(v, shownCur);
  };
  const shownTotal = (inr: number) => (inr > 0 ? amt(inr) : "—");   // "—" while the airline price is checked
  // What the card is charged when it differs from the shown currency.
  const chargedNote = (inr: number) => {
    if (!inForeign || inr <= 0 || payCurrency === shownCur) return "";
    const v = payCurrency === "AED" ? convertInr(inr, "AED", rates) : inr;
    return v === null ? "" : `Charged ${payCurrency === "AED" ? formatIn(v, "AED") : money.format(v)}`;
  };
  function chooseCurrency(cur: DisplayCurrency) {
    setDisplayCurrency(cur);
    savePrefCurrency(cur);
  }
  const switchOptions = (["INR", "AED", ...(shownCur !== "INR" && shownCur !== "AED" ? [shownCur] : [])] as DisplayCurrency[])
    .filter((c) => c === "INR" || rates[c]);
  const currencySwitch = fareInInr && switchOptions.length > 1 ? (
    <div className="curSwitch" role="radiogroup" aria-label="Price currency">
      {switchOptions.map((cur) => (
        <button key={cur} type="button" role="radio" aria-checked={shownCur === cur} className={shownCur === cur ? "on" : ""}
          disabled={submitting} onClick={() => chooseCurrency(cur)}>{cur === "INR" ? "₹ INR" : cur}</button>
      ))}
    </div>
  ) : null;

  // Passport / ID scan → this traveller's fields (only fields the document gave).
  const [scanWarn, setScanWarn] = useState<Record<number, string>>({});
  function applyScan(i: number, t: ScannedTraveller) {
    setPassengers((ps) => ps.map((x, n) => n !== i ? x : {
      ...x,
      ...(t.firstName ? { firstName: t.firstName } : {}),
      ...(t.lastName ? { lastName: t.lastName } : {}),
      ...(t.dob ? { dob: t.dob } : {}),
      ...(t.gender ? { gender: t.gender } : {}),
      ...(t.nationality ? { nationality: t.nationality } : {}),
      ...(t.documentType === "PASSPORT" && t.documentNumber ? { passportNumber: t.documentNumber } : {}),
      ...(t.documentType === "PASSPORT" && t.expiryDate ? { passportExpiry: t.expiryDate } : {}),
      ...(t.documentType === "PASSPORT" && t.issueDate ? { passportIssueDate: t.issueDate } : {}),
    }));
    // The passenger type must match the age on the travel date.
    const travel = fare?.departureTime?.slice(0, 10) || new Date().toISOString().slice(0, 10);
    let warn = "";
    if (t.dob) {
      const [y, m, d] = t.dob.split("-").map(Number);
      const [ty, tm, td] = travel.split("-").map(Number);
      const age = ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
      const type = age < 2 ? "INFANT" : age < 12 ? "CHILD" : "ADULT";
      const current = passengers[i]?.type;
      if (current && current !== type) warn = `Date of birth shows ${type === "ADULT" ? "an adult" : type === "CHILD" ? "a child (2–11)" : "an infant (under 2)"} on the travel date — please check the passenger type.`;
    }
    setScanWarn((w) => ({ ...w, [i]: warn }));
  }

  const upd = (i: number, k: keyof Passenger, v: string) =>
    setPassengers((p) => p.map((x, n) => n === i ? { ...x, [k]: v } : x));
  const updSsr = (i: number, kind: "bag" | "meal", key: string, code: string) =>
    setPassengers((p) => p.map((x, n) => n === i ? { ...x, [kind]: { ...x[kind], [key]: code } } : x));

  const cond = review?.conditions;
  const passportNeeded = isInternational || !!cond?.passportMandatory;
  const ssrSegments = (review?.segments ?? []).filter((s) => s.ssr.baggage.length || s.ssr.meal.length);
  const ssrPrice = (kind: "baggage" | "meal", key: string, code: string) =>
    review?.segments.find((s) => s.key === key)?.ssr[kind].find((o) => o.code === code)?.amount ?? 0;
  const ssrSum = passengers.reduce((n, p) =>
    n + Object.entries(p.bag).reduce((m, [k, c]) => m + (c ? ssrPrice("baggage", k, c) : 0), 0)
      + Object.entries(p.meal).reduce((m, [k, c]) => m + (c ? ssrPrice("meal", k, c) : 0), 0), 0);
  const seatPrice = (key: string, code: string) => seatMaps?.find((m) => m.key === key)?.seats.find((s) => s.code === code)?.amount ?? 0;
  const seatSum = passengers.reduce((n, p) => n + (p.type === "INFANT" ? 0 : Object.entries(p.seat).reduce((m, [k, c]) => m + (c ? seatPrice(k, c) : 0), 0)), 0);
  const grandTotal = (fare?.totalFare ?? 0) + ssrSum + seatSum;

  // A new fare session invalidates the seat map and any seats picked from it.
  useEffect(() => {
    setSeatMaps(null); setSeatError("");
    setPassengers((ps) => ps.map((p) => (Object.keys(p.seat).length ? { ...p, seat: {} } : p)));
  }, [review?.bookingId]);

  async function loadSeatMap() {
    if (!review) return;
    setSeatLoading(true); setSeatError("");
    try {
      const sid = new URLSearchParams(window.location.search).get("sid");
      const res = await fetch(`${apiUrl}/api/book/seat-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
        body: JSON.stringify({ reviewBookingId: review.bookingId, ...(sid ? { searchId: sid } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setSeatError(d.error ?? "Seat map is unavailable right now."); return; }
      setSeatMaps(d.segments ?? []);
    } catch {
      setSeatError("Seat map is unavailable right now.");
    } finally {
      setSeatLoading(false);
    }
  }
  const pickSeat = (i: number, key: string, code: string) =>
    setPassengers((p) => p.map((x, n) => n === i ? { ...x, seat: { ...x.seat, [key]: code } } : x));
  const picks = (m: Record<string, string>) => Object.entries(m).filter(([, c]) => c).map(([key, code]) => ({ key, code }));

  const t = (s?: string) =>
    s ? new Date(s).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--";

  async function startNomodPayment(bookingId: string, checkoutToken: string) {
    const res = await fetch(`${apiUrl}/api/payments/checkout`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas", "X-Checkout-Token": checkoutToken },
      body:    JSON.stringify({ bookingId, gateway: "NOMOD", ...(payCurrency === "AED" && aedRate ? { currency: "AED" } : {}) }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) as { paymentUrl?: string; error?: string } : {};
    if (!res?.ok || !data.paymentUrl) {
      throw new Error(`Your booking is saved but the payment page couldn't open${data.error ? ` (${data.error})` : ""}. You have not been charged — tap the button to try the payment again.`);
    }
    window.location.assign(data.paymentUrl);
  }

  // Wallet can pay only when it covers the full INR fare; otherwise Nomod is used.
  async function walletCovering(amount: number, currency: string): Promise<number | null> {
    if (!token || currency !== "INR") return null;
    try {
      const res = await fetch(`${apiUrl}/api/profile/wallet`, {
        headers: { "x-tenant-slug": "poomas", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const w = await res.json() as { balance?: number };
      return typeof w.balance === "number" && w.balance >= amount ? w.balance : null;
    } catch { return null; }
  }

  async function payWithWallet() {
    if (!pendingPayment || submitting) return;
    setSubmitting(true); setError("");
    try {
      const res = await fetch(`${apiUrl}/api/profile/wallet/pay`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ bookingId: pendingPayment.bookingId }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Wallet payment failed. You have not been charged.");
      const q = new URLSearchParams({ bookingId: pendingPayment.bookingId, token: pendingPayment.checkoutToken, result: "success" });
      window.location.assign(`/checkout/payment-result?${q}`);
    } catch (x: any) {
      setError(x?.message ?? "Wallet payment failed. You have not been charged.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      setSubmitting(false);
    }
  }

  function saveTravellerDetails() {
    if (!saveDetails || !token) return;
    for (const p of passengers) {
      if (!p.firstName || !p.lastName) continue;
      const existing = savedPassengers.find(
        (s) => s.firstName.toLowerCase() === p.firstName.trim().toLowerCase() &&
               s.lastName.toLowerCase()  === p.lastName.trim().toLowerCase(),
      );
      if (!existing) {
        fetch(`${apiUrl}/api/profile/passengers`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "x-tenant-slug": "poomas" },
          body: JSON.stringify({
            firstName:      p.firstName.trim(),
            lastName:       p.lastName.trim(),
            dob:            p.dob || undefined,
            gender:         p.gender,
            nationality:    p.nationality.toUpperCase().slice(0, 2) || undefined,
            passportNumber: p.passportNumber.trim() || undefined,
            passportExpiry: p.passportExpiry || undefined,
            isDefault:      savedPassengers.length === 0,
          }),
        }).catch(() => {});
      }
    }
  }

  // Request body for /api/book (also used to hold the fare).
  function bookingPayload(extra: Record<string, unknown> = {}) {
    if (!fare) throw new Error("No fare selected");
    return {
      fareId:        fare.fareId,
      supplier:      fare.supplier,
      contactEmail:  email.trim(),
      contactPhone:  phone.trim(),
      origin:        fare.origin,
      destination:   fare.destination,
      departureDate: fare.departureTime.slice(0, 10),
      totalFare:     fare.totalFare,
      currency:      fare.currency,
      tripType,
      ...(review ? { reviewBookingId: review.bookingId } : {}),
      ...(useGst && gst.gstNumber.trim() ? { gstInfo: {
        gstNumber: gst.gstNumber.trim().toUpperCase(), registeredName: gst.registeredName.trim(),
        ...(gst.email.trim() ? { email: gst.email.trim() } : {}), ...(gst.mobile.trim() ? { mobile: gst.mobile.replace(/\D/g, "") } : {}),
        ...(gst.address.trim() ? { address: gst.address.trim() } : {}),
      } } : {}),
      ...(cond?.emergencyContactRequired || emergency.name.trim() ? { emergencyContact: {
        name: emergency.name.trim(), phone: emergency.phone.trim(), ...(emergency.email.trim() ? { email: emergency.email.trim() } : {}),
      } } : {}),
      ...(new URLSearchParams(window.location.search).get("sid") ? { searchId: new URLSearchParams(window.location.search).get("sid") } : {}),
      ...(leadAgentNumber ? { leadAgentNumber } : {}),
      passengers:    passengers.map((p) => ({
        type:           p.type,
        gender:         p.gender,
        dob:            p.dob || undefined,
        firstName:      p.firstName.trim(),
        lastName:       p.lastName.trim(),
        nationality:    p.nationality.trim().toUpperCase().slice(0, 2) || "IN",
        passportNumber: p.passportNumber.trim() || undefined,
        passportExpiry: p.passportExpiry || undefined,
        passportIssueDate: p.passportNumber.trim() && p.passportIssueDate ? p.passportIssueDate : undefined,
        panNumber:      p.panNumber.trim() ? p.panNumber.trim().toUpperCase() : undefined,
        documentId:     p.documentId.trim() || undefined,
        ...(p.type !== "INFANT" && (picks(p.bag).length || picks(p.meal).length || picks(p.seat).length)
          ? { ssr: {
              ...(picks(p.bag).length ? { baggage: picks(p.bag) } : {}),
              ...(picks(p.meal).length ? { meal: picks(p.meal) } : {}),
              ...(picks(p.seat).length ? { seat: picks(p.seat) } : {}),
            } }
          : {}),
      })),
      ...extra,
    };
  }

  async function holdFare(form: HTMLFormElement | null) {
    if (!fare || submitting || !review || !cond?.holdAllowed) return;
    if (form && !form.reportValidity()) return;
    setSubmitting(true); setError("");
    try {
      const res = await fetch(`${apiUrl}/api/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(bookingPayload({ holdOnly: true })),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.held) {
        if (d.errorCode === "FARE_EXPIRED") { setFareExpired(true); return; }
        throw new Error(typeof d.error === "string" ? d.error : bookingError(d, res.status));
      }
      saveTravellerDetails();
      setHeld({ bookingId: d.bookingId, pnr: d.pnr ?? null, heldUntil: d.heldUntil, amount: Number(d.amount), currency: d.currency, checkoutToken: d.checkoutToken });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (x: any) {
      setError(x?.message ?? "We couldn't hold this fare. You can still pay now.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!fare || submitting || fareExpired || bookingUncertain) return;
    // Names must be real (no TBA / Test) — the airline and TripJack reject placeholders.
    for (const [i, p] of passengers.entries()) {
      const problem = passengerNameProblem(p.firstName, "First name") ?? passengerNameProblem(p.lastName, "Last name");
      if (problem) { setError(`Traveller ${i + 1}: ${problem}`); setReviewing(false); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    }
    if (cond) {
      const problem = cond.gstMandatory && !(useGst && gst.gstNumber.trim() && gst.registeredName.trim()) ? "GST number and registered name are mandatory for this fare."
        : useGst && gst.gstNumber.trim() && !/^\d{2}[A-Z0-9]{13}$/i.test(gst.gstNumber.trim()) ? "GSTIN must be 15 characters (e.g. 29ABCDE1234F1Z5)."
        : cond.emergencyContactRequired && !(emergency.name.trim() && emergency.phone.trim()) ? "Emergency contact name and phone are mandatory for this fare."
        : null;
      if (problem) { setError(problem); setReviewing(false); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    }
    if (!reviewing) { setReviewing(true); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    // The main button pays from the wallet while the wallet choice is showing.
    if (pendingPayment && walletOffer) { await payWithWallet(); return; }
    setError("");
    setSubmitting(true);
    if (pendingPayment) {
      try {
        await startNomodPayment(pendingPayment.bookingId, pendingPayment.checkoutToken);
      } catch (x: any) {
        setError(x?.message ?? "The payment page couldn't open. Please try again.");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      const res = await fetch(`${apiUrl}/api/book`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(bookingPayload()),
      }).catch(() => {
        setBookingUncertain(true);
        throw new Error(bookingError({ errorCode: "BOOKING_STATUS_UNKNOWN" }, 502));
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if ((d as any).errorCode === "FARE_EXPIRED") {
          setFareExpired(true);
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        if (d.errorCode === "BOOKING_STATUS_UNKNOWN" || !d.errorCode && res.status >= 500) setBookingUncertain(true);
        throw new Error(bookingError(d, res.status));
      }
      // Pay-first flow (TripJack): the fare is reviewed and the booking saved as
      // PAYMENT_PENDING; the airline booking is made after Nomod confirms payment.
      if (d.success === true && d.requiresPayment === true && typeof d.bookingId === "string") {
        saveTravellerDetails();
        if (typeof d.checkoutToken !== "string" || !d.checkoutToken) {
          throw new Error("Your booking is saved but the payment page couldn't open. You have not been charged; please contact support.");
        }
        setPendingPayment({ bookingId: d.bookingId, checkoutToken: d.checkoutToken });
        const amount = Number(d.amount ?? fare.totalFare);
        const balance = await walletCovering(amount, String(d.currency ?? fare.currency));
        if (balance !== null) {
          setWalletOffer({ amount, balance });
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        await startNomodPayment(d.bookingId, d.checkoutToken);
        return;
      }
      if (d.success !== true || typeof d.bookingReference !== "string" || !d.bookingReference) {
        setBookingUncertain(true);
        throw new Error(bookingError({ errorCode: "BOOKING_STATUS_UNKNOWN" }, 502));
      }

      saveTravellerDetails();
      setConfirmation(d);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (x: any) {
      setError(x?.message ?? "Booking failed. Please check your details and try again.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSubmitting(false);
    }
  }

  if (held) {
    const until = new Date(held.heldUntil);
    const payLater = `/pay?${new URLSearchParams({ b: held.bookingId, t: held.checkoutToken })}`;
    return (
      <main className="ck success"><style>{css}{checkoutCss}</style>
        <div className="ok">🔒</div>
        <h1>Your fare is on hold</h1>
        {held.pnr && <p style={{ fontSize: 22, fontWeight: 800 }}>PNR: <span style={{ color: "#E31E24" }}>{held.pnr}</span></p>}
        <p>Pay <b>{new Intl.NumberFormat("en-IN", { style: "currency", currency: held.currency, maximumFractionDigits: 0 }).format(held.amount)}</b> before{" "}
          <b>{until.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true })}</b> to get your e-ticket.
          After that the airline releases the seats.</p>
        <p style={{ color: "#667085" }}>We&apos;ve sent a payment link to {email}{phone ? " and WhatsApp" : ""}. Your ticket is issued only after payment.</p>
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" disabled={submitting} style={{ background: "#E31E24", color: "#fff", border: 0, borderRadius: 10, padding: "12px 18px", fontWeight: 800, cursor: "pointer" }}
            onClick={async () => {
              setSubmitting(true); setError("");
              try { await startNomodPayment(held.bookingId, held.checkoutToken); }
              catch (x: any) { setError(x?.message ?? "The payment page couldn't open."); setSubmitting(false); }
            }}>{submitting ? "Opening payment…" : "Pay now"}</button>
          <a href={payLater} style={{ border: "1px solid #cbd5e1", borderRadius: 10, padding: "12px 18px", fontWeight: 700, color: "#0f172a", textDecoration: "none" }}>Save payment link</a>
        </div>
      </main>
    );
  }

  if (confirmation) {
    return (
      <main className="ck success"><style>{css}{checkoutCss}</style>
        <div className="ok">✓</div>
        <h1>{["CONFIRMED", "TICKETED"].includes(confirmation.status) && confirmation.pnr ? "Booking confirmed" : "Booking request received"}</h1>
        {confirmation.warningCode === "BOOKING_SAVE_PENDING" && <p>The supplier accepted your request, but we couldn't save all details. Do not book again. Contact support with your booking reference.</p>}
        {confirmation.status === "PENDING" && <p>Airline confirmation is pending. Do not submit another booking for this flight.</p>}
        {confirmation.pnr && (
          <p style={{ fontSize: 22, fontWeight: 800 }}>
            PNR: <span style={{ color: "#E31E24" }}>{confirmation.pnr}</span>
          </p>
        )}
        <p style={{ color: "#667085" }}>
          Keep this reference for your booking. Contact email: {email}.
        </p>
        <div className="receipt">
          <Row l="Booking ID"  v={confirmation.bookingId        ?? "—"} />
          <Row l="Booking Ref" v={confirmation.bookingReference ?? "—"} />
          <Row l="PNR"         v={confirmation.pnr              ?? "—"} />
          <Row l="Status"      v={confirmation.status           ?? "CONFIRMED"} />
        </div>
        <a className="home" href="/">Search another flight</a>
      </main>
    );
  }

  return (
    <main className="ck"><style>{css}{checkoutCss}</style>
      <header>
        <button type="button" aria-label={reviewing ? "Edit traveller details" : "Back to results"} disabled={submitting} onClick={() => reviewing ? setReviewing(false) : history.back()}>‹</button>
        <div><b>{reviewing ? "Review your booking" : "Complete your booking"}</b><span>{reviewing ? "Check names and contact details" : "Continue as a guest — no account required"}</span></div>
        <i>🔒</i>
      </header>

      <p className="checkoutProgress">{reviewing ? "Step 2 of 2 · Review" : "Step 1 of 2 · Traveller details"}</p>

      {fareExpired && (
        <div className="err" role="alert">
          <b>This fare is no longer available</b>
          <span>The supplier could not offer this fare. Your entered details remain on this page.</span>
          <a href="/">Search flights again</a>
        </div>
      )}

      {error && <div className="err"><b>Couldn't continue</b><span>{error}</span></div>}
      {walletOffer && pendingPayment && (
        <div style={{ background: "#fff", border: "1.5px solid #fecaca", borderRadius: 14, padding: 16, margin: "0 0 14px" }}>
          <b style={{ display: "block", fontSize: 16, marginBottom: 4 }}>Choose how to pay</b>
          <span style={{ display: "block", color: "#64748b", fontSize: 13, marginBottom: 12 }}>
            Your booking is saved. Wallet balance ₹{walletOffer.balance.toLocaleString("en-IN")} covers this fare of ₹{walletOffer.amount.toLocaleString("en-IN")}.
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={payWithWallet} disabled={submitting}
              style={{ flex: "1 1 180px", background: "#E31E24", color: "#fff", border: 0, borderRadius: 10, padding: "12px 14px", fontWeight: 800, cursor: "pointer", opacity: submitting ? .7 : 1 }}>
              {submitting ? "Paying…" : `Pay ₹${walletOffer.amount.toLocaleString("en-IN")} from wallet`}
            </button>
            <button type="button" disabled={submitting}
              onClick={async () => {
                setSubmitting(true); setError("");
                try { await startNomodPayment(pendingPayment.bookingId, pendingPayment.checkoutToken); }
                catch (x: any) { setError(x?.message ?? "The payment page couldn't open."); setSubmitting(false); }
              }}
              style={{ flex: "1 1 180px", background: "#fff", color: "#0f172a", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "12px 14px", fontWeight: 800, cursor: "pointer" }}>
              Pay with card (Nomod)
            </button>
          </div>
        </div>
      )}

      {/* Login banner — shown when not logged in */}
      {!token && !reviewing && (
        <div className="loginBanner">
          <SocialSignIn apiUrl={apiUrl} onSuccess={(result) => {
            document.cookie = `poomas_token=${result.token}; Path=/; SameSite=Lax; Secure; Max-Age=86400`;
            setToken(result.token); setShowLogin(false);
            setEmail((previous) => previous || result.customer.email || "");
            void fetchSavedPassengers(result.token);
          }} />
          <span>Have an account? <button type="button" className="linkBtn" onClick={() => setShowLogin((v) => !v)}>Sign in with email</button></span>
        </div>
      )}

      {/* Inline login form */}
      {showLogin && !reviewing && (
        <section className="card loginCard">
          <div className="title">
            <span>👤</span>
            <div><h2>Sign in</h2><p>Auto-fill your saved traveller details.</p></div>
          </div>
          {loginError && <div className="err"><span>{loginError}</span></div>}
          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="grid">
              <Input l="Email" t="email" v={loginEmail} c={setLoginEmail} r />
              <Input l="Password" t="password" v={loginPassword} c={setLoginPassword} r />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="submit" className="loginBtn" disabled={loggingIn}>
                {loggingIn ? "Signing in…" : "Sign in"}
              </button>
              <button type="button" className="cancelBtn" onClick={() => setShowLogin(false)}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {fare && (
        <section className="card flight">
          <div className="fh">
            <div><b>{fare.airlineName}</b><span>{fare.flightNumber}</span></div>
            <strong>{shownTotal(grandTotal)}</strong>
          </div>
          {currencySwitch && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 8px", fontSize: 13, flexWrap: "wrap" }}>
              <span style={{ color: "#64748b" }}>Show prices in</span>
              {currencySwitch}
              {inForeign && grandTotal > 0 && <span style={{ color: "#64748b" }}>≈ {money.format(grandTotal)} · 1 {shownCur} = ₹{rates[shownCur]}{chargedNote(grandTotal) ? ` · ${chargedNote(grandTotal)}` : ""}</span>}
            </div>
          )}
          <div className="route">
            <div><b>{t(fare.departureTime)}</b><span>{fare.origin}</span></div>
            <div className="plane">✈</div>
            <div className="end"><b>{t(fare.arrivalTime)}</b><span>{fare.destination}</span></div>
          </div>
          <div className="meta">
            <span>{fare.stops === 0 ? "Nonstop" : `${fare.stops} stop`} · {Math.floor(fare.duration / 60)}h {fare.duration % 60}m</span>
            <span>{fare.isRefundable ? "✓ Refundable" : "Non-refundable"}</span>
            <span>{fare.cabinChecked || "Checked baggage allowance not provided"}</span>
          </div>
        </section>
      )}

      {reviewLoading && <div className="prebook-banner" style={{ background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1d4ed8", borderRadius: 12, padding: "10px 12px", marginBottom: 12, fontSize: 13 }}>Checking live availability and fare rules with the airline…</div>}
      {reviewError && <div className="err"><b>Couldn't confirm this fare</b><span>{reviewError} You can still continue; availability is re-checked when you book.</span></div>}
      {review?.fareAlert && (
        <div className="err" role="alert" style={{ background: "#fffbeb", borderColor: "#fcd34d", color: "#92400e" }}>
          <b>The airline changed this fare</b>
          <span>{review.fareAlert.message ?? `Fare changed${review.fareAlert.oldFare ? ` from ₹${review.fareAlert.oldFare}` : ""}${review.fareAlert.newFare ? ` to ₹${review.fareAlert.newFare}` : ""}.`} Please check the total before paying.</span>
        </div>
      )}
      <FareOptionSwitcher money={(n) => shownTotal(n)} currentPrice={fare?.totalFare ?? 0} disabled={submitting || !!pendingPayment} />

      {review && review.fareIdentifiers.length > 0 && !review.fareIdentifiers.every((f) => f === "PUBLISHED") && (
        <p className="checkoutProgress" style={{ marginTop: 0 }}>Fare type: <b>{review.fareIdentifiers.map((f) => ({ SPECIAL_RETURN: "Special Return", TJ_FLEX: "Flex", STUDENT: "Student", SENIOR_CITIZEN: "Senior Citizen" } as Record<string, string>)[f] ?? f).join(" + ")}</b></p>
      )}
      <form onSubmit={submit}>
        {reviewing ? (
          <section className="card">
            <h2>Review traveller details</h2>
            {passengers.map((p, i) => <p key={i}><b>Traveller {i + 1}:</b> {p.firstName} {p.lastName}</p>)}
            <p>{email}<br />{phone}</p>
            <p className="signinNote">Check names match the travel document. Availability is confirmed when you submit.</p>
            <button type="button" className="cancelBtn" disabled={submitting} onClick={() => setReviewing(false)}>Edit details</button>
          </section>
        ) : (<>
        <section className="card">
          <div className="title">
            <span>👤</span>
            <div><h2>Traveller details</h2><p>Enter details exactly as on your passport.</p></div>
          </div>
          {passengers.map((p, i) => (
            <div className="pax" key={i}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                <span className="chip">Passenger {i + 1}</span>
                <select
                  className="typeSelect"
                  value={p.type}
                  onChange={(e) => upd(i, "type", e.target.value as Passenger["type"])}
                  aria-label={`Passenger ${i + 1} type`}
                >
                  <option value="ADULT">Adult (12+)</option>
                  <option value="CHILD">Child (2–11)</option>
                  <option value="INFANT">Infant (under 2)</option>
                </select>
                {savedPassengers.length > 0 && (
                  <select
                    className="profileSelect"
                    value=""
                    onChange={(e) => {
                      const sp = savedPassengers.find((s) => s.id === e.target.value);
                      if (sp) applyProfile(sp, i);
                    }}
                  >
                    <option value="">Use saved profile…</option>
                    {savedPassengers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.firstName} {s.lastName}{s.isDefault ? " ★" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <ScanDocument onScanned={(t) => applyScan(i, t)} />
              {scanWarn[i] && <p style={{ margin: "0 0 10px", fontSize: 12, color: "#b45309" }}>⚠ {scanWarn[i]}</p>}
              <div className="grid">
                <Input l="First name"             v={p.firstName}      c={(v) => upd(i, "firstName",      v)} r />
                <Input l="Last name"              v={p.lastName}       c={(v) => upd(i, "lastName",       v)} r />
                <Input l="Date of birth"  t="date" v={p.dob}           c={(v) => upd(i, "dob",            v)} r={p.type !== "ADULT" || isInternational || !!cond?.dobRequired[p.type]} />
                <label>Gender
                  <select value={p.gender} onChange={(e) => upd(i, "gender", e.target.value as "M" | "F")}>
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                  </select>
                </label>
              </div>
              <div className="passportSection">
                {passportNeeded && (
                  <p className="intlBadge">✈ {cond?.passportMandatory ? "The airline requires passport details for this fare" : "International flight — passport details required"}</p>
                )}
                <div className="grid">
                  <Input l="Nationality (e.g. IN, AE)" v={p.nationality} c={(v) => upd(i, "nationality", v.toUpperCase().slice(0, 2))} max={2} r={passportNeeded} />
                  <Input l="Passport number" v={p.passportNumber} c={(v) => upd(i, "passportNumber", v)} r={passportNeeded} />
                  <Input l="Passport expiry" t="date" v={p.passportExpiry} c={(v) => upd(i, "passportExpiry", v)} r={passportNeeded || (!!cond?.passportExpiryRequired && !!p.passportNumber)} />
                  {(passportNeeded || p.passportNumber) && (
                    <Input l="Passport issue date" t="date" v={p.passportIssueDate} c={(v) => upd(i, "passportIssueDate", v)} />
                  )}
                  {cond?.panApplicable && (
                    <Input l="PAN (optional)" v={p.panNumber} c={(v) => upd(i, "panNumber", v.toUpperCase().slice(0, 10))} ph="ABCDE1234F" max={10} />
                  )}
                  {cond?.documentIdApplicable && p.type !== "INFANT" && (
                    <Input l={review?.fareIdentifiers.includes("SENIOR_CITIZEN") ? "Senior citizen ID number" : review?.fareIdentifiers.includes("STUDENT") ? "Student ID number" : "Document ID"}
                      v={p.documentId} c={(v) => upd(i, "documentId", v.replace(/[^A-Za-z0-9]/g, ""))} r={cond.documentIdMandatory} />
                  )}
                </div>
                {p.type !== "INFANT" && ssrSegments.length > 0 && (
                  <div className="ssrBox">
                    <div className="ssrHead">
                      <b>Meals &amp; extra baggage</b>
                      <span>Optional · added to your total</span>
                    </div>
                    {ssrSegments.map((seg) => {
                      const bag = seg.ssr.baggage.find((o) => o.code === p.bag[seg.key]);
                      const meal = seg.ssr.meal.find((o) => o.code === p.meal[seg.key]);
                      return (
                        <div key={seg.key} className="ssrSeg">
                          <div className="ssrFlight"><span aria-hidden="true">✈</span> {seg.origin} → {seg.destination}<small>{seg.airline} {seg.flightNumber}</small></div>
                          <div className="ssrGrid">
                            {seg.ssr.baggage.length > 0 && (
                              <label>Extra baggage
                                <select value={p.bag[seg.key] ?? ""} onChange={(e) => updSsr(i, "bag", seg.key, e.target.value)}>
                                  <option value="">None</option>
                                  {seg.ssr.baggage.map((o) => <option key={o.code} value={o.code}>{o.desc} · {o.amount ? amt(o.amount) : "included"}</option>)}
                                </select>
                                {bag && <small className="ssrPick">{bag.amount ? `+ ${amt(bag.amount)}` : "Covers the whole connecting journey"}</small>}
                              </label>
                            )}
                            {seg.ssr.meal.length > 0 && (
                              <label>Meal
                                <select value={p.meal[seg.key] ?? ""} onChange={(e) => updSsr(i, "meal", seg.key, e.target.value)}>
                                  <option value="">None</option>
                                  {seg.ssr.meal.map((o) => <option key={o.code} value={o.code}>{o.desc}{o.amount ? ` · ${amt(o.amount)}` : ""}</option>)}
                                </select>
                                {meal && <small className="ssrPick" title={meal.desc}>{meal.amount ? `+ ${amt(meal.amount)}` : "Included"}</small>}
                              </label>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Save details option — only when logged in */}
          {token && (
            <label className="saveCheck">
              <input type="checkbox" checked={saveDetails} onChange={(e) => setSaveDetails(e.target.checked)} />
              Save traveller details for next time
            </label>
          )}
        </section>

        {cond?.seatApplicable && (
          <section className="card">
            <div className="title">
              <span>💺</span>
              <div><h2>Seats</h2><p>Optional · pick a seat for each traveller. Paid seats are added to your total.</p></div>
            </div>
            {seatMaps?.length ? (
              <SeatPicker maps={seatMaps} segments={review?.segments ?? []} travellers={passengers} onPick={pickSeat} format={(n) => amt(n)} />
            ) : (
              <button type="button" className="seatLoad" disabled={seatLoading} onClick={() => void loadSeatMap()}>
                {seatLoading ? "Loading seat map…" : "Choose seats"}
              </button>
            )}
            {seatError && <p className="seatError">{seatError} You can continue without choosing seats — the airline assigns them at check-in.</p>}
          </section>
        )}

        <section className="card">
          <div className="title">
            <span>☎</span>
            <div><h2>Contact details</h2><p>Booking confirmation will be sent here.</p></div>
          </div>
          <div className="grid">
            <Input l="Email address" t="email" v={email} c={setEmail} r />
            <Input l="Mobile number" t="tel"   v={phone} c={setPhone} r ph="+91…" />
          </div>
        </section>
        {(cond?.gstApplicable || cond?.gstMandatory || !review) && (
          <section className="card">
            <div className="title">
              <span>🧾</span>
              <div><h2>GST details</h2><p>{cond?.gstMandatory ? "The airline requires GST details for this fare." : "Optional — claim GST input credit for business travel."}</p></div>
            </div>
            {!cond?.gstMandatory && (
              <label className="saveCheck">
                <input type="checkbox" checked={useGst} onChange={(e) => setUseGst(e.target.checked)} />
                Use GST for this booking
              </label>
            )}
            {(useGst || cond?.gstMandatory) && (
              <div className="grid">
                <Input l="GSTIN" v={gst.gstNumber} c={(v) => setGst((g) => ({ ...g, gstNumber: v.toUpperCase().slice(0, 15) }))} r max={15} ph="29ABCDE1234F1Z5" />
                <Input l="Registered company name" v={gst.registeredName} c={(v) => setGst((g) => ({ ...g, registeredName: v.slice(0, 35) }))} r max={35} />
                <Input l="GST email" t="email" v={gst.email} c={(v) => setGst((g) => ({ ...g, email: v }))} />
                <Input l="GST mobile" t="tel" v={gst.mobile} c={(v) => setGst((g) => ({ ...g, mobile: v }))} />
                <Input l="Company address" v={gst.address} c={(v) => setGst((g) => ({ ...g, address: v.slice(0, 70) }))} max={70} />
              </div>
            )}
          </section>
        )}
        {cond?.emergencyContactRequired && (
          <section className="card">
            <div className="title">
              <span>🆘</span>
              <div><h2>Emergency contact</h2><p>Required by the airline for this fare — someone not travelling with you.</p></div>
            </div>
            <div className="grid">
              <Input l="Full name" v={emergency.name} c={(v) => setEmergency((x) => ({ ...x, name: v }))} r />
              <Input l="Mobile number" t="tel" v={emergency.phone} c={(v) => setEmergency((x) => ({ ...x, phone: v }))} r ph="+91…" />
              <Input l="Email" t="email" v={emergency.email} c={(v) => setEmergency((x) => ({ ...x, email: v }))} />
            </div>
          </section>
        )}
        {ssrSum > 0 && (
          <p className="checkoutProgress">Meals &amp; baggage: <b>{amt(ssrSum)}</b> added to the fare.</p>
        )}
        {seatSum > 0 && (
          <p className="checkoutProgress">Seats: <b>{amt(seatSum)}</b> added to the fare.</p>
        )}

        </>)}

        {reviewing && cond?.holdAllowed && review && !pendingPayment && !bookingUncertain && !fareExpired
          && !passengers.some((p) => picks(p.bag).length || picks(p.meal).length || picks(p.seat).length) && (
          <div className="holdOffer">
            <div><b>🔒 Not ready to pay?</b><span>Hold this fare free and pay later — before the airline&apos;s time limit (often a few hours). Your ticket is issued after payment.</span></div>
            <button type="button" disabled={submitting} onClick={(e) => void holdFare(e.currentTarget.form)}>{submitting ? "Holding…" : "Hold fare, pay later"}</button>
          </div>
        )}

        <div className="spacer" />
        <div className="pay">
          <div>
            <span>Total{inForeign && grandTotal > 0 ? ` ≈ ${money.format(grandTotal)}` : ""}{chargedNote(grandTotal) ? ` · ${chargedNote(grandTotal)}` : ""}</span>
            <b>{fare ? shownTotal(grandTotal) : "—"}</b>
            {currencySwitch && <div className="paySwitch">{currencySwitch}</div>}
          </div>
          <button disabled={!fare || submitting || fareExpired || bookingUncertain}>
            {submitting ? (walletOffer ? "Paying from wallet…" : pendingPayment ? "Opening payment…" : "Checking availability…") : bookingUncertain ? "Contact support to check status" : walletOffer ? `Pay ₹${walletOffer.amount.toLocaleString("en-IN")} from wallet` : pendingPayment ? "Try payment again" : reviewing ? "Continue to payment" : "Review booking"}
          </button>
        </div>
      </form>
    </main>
  );
}

function Input({ l, v, c, t = "text", r = false, ph, max }: {
  l: string; v: string; c: (v: string) => void; t?: string; r?: boolean; ph?: string; max?: number;
}) {
  return (
    <label>{l}
      <input type={t} value={v} onChange={(e) => c(e.target.value)}
        required={r} placeholder={ph} maxLength={max} />
    </label>
  );
}

function Row({ l, v }: { l: string; v: string }) {
  return <div className="row"><span>{l}</span><b>{v}</b></div>;
}

const checkoutCss = `.ssrBox{margin-top:14px;padding:14px;border:1px solid #eaecf0;border-radius:14px;background:#f9fafb;max-width:100%;overflow:hidden}.ssrHead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:4px}.ssrHead b{font-size:14px;color:#101828}.ssrHead span{font-size:12px;color:#667085}.ssrSeg{margin-top:12px}.ssrSeg+.ssrSeg{padding-top:12px;border-top:1px solid #eaecf0}.ssrFlight{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:#344054;margin-bottom:8px}.ssrFlight small{font-weight:600;color:#98a2b3}.ssrGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ssrGrid label{min-width:0}.ssrGrid select{width:100%;min-width:0;max-width:100%;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:15px}.ssrPick{font-size:12px;font-weight:600;color:#067647;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media(max-width:560px){.ssrGrid{grid-template-columns:minmax(0,1fr)}}.ck header{position:static;z-index:auto}.checkoutProgress{font-size:13px;color:#667085;margin:16px 0}.socialButtons{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px}.appleButton{background:#000;color:#fff;border:1px solid #000;min-height:44px;border-radius:6px;padding:10px 20px;font:600 15px system-ui;cursor:pointer}.signinNote{font-size:13px;color:#667085;line-height:1.5}.passportSection{margin-top:16px}.intlBadge{font-size:12px;font-weight:700;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:7px 11px;margin-bottom:12px}.ck .card h2{font-size:18px}.loginBanner{background:#fff;border-color:#eaecf0;color:#344054}.seatLoad{height:44px;padding:0 18px;border:1px solid #ed1c24;border-radius:12px;background:#fff1f2;color:#be123c;font-weight:800;font-size:14px;cursor:pointer}.seatLoad:disabled{opacity:.6}.seatError{font-size:13px;color:#9a3412;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:9px 11px;margin:10px 0 0}.curSwitch{display:inline-flex;background:#f2f4f7;border-radius:999px;padding:3px;gap:2px}.curSwitch button{border:0;background:transparent;color:#475467;font-weight:800;font-size:12px;border-radius:999px;padding:5px 12px;cursor:pointer;min-height:28px}.curSwitch button.on{background:#fff;color:#ed1c24;box-shadow:0 1px 3px rgba(16,24,40,.15)}.paySwitch{margin-top:4px}.paySwitch .curSwitch button{padding:3px 9px;font-size:11px;min-height:24px}.holdOffer{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:12px 14px;margin:14px 0}.holdOffer div{display:flex;flex-direction:column;gap:3px;flex:1 1 240px;font-size:13px;color:#78350f}.holdOffer b{font-size:14px;color:#451a03}.holdOffer button{height:44px;padding:0 16px;border:1px solid #d97706;border-radius:12px;background:#fff;color:#92400e;font-weight:800;font-size:14px;cursor:pointer}.holdOffer button:disabled{opacity:.6}${seatCss}`;

const css = `.checkBanner{display:flex;align-items:center;gap:8px;background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1;padding:11px 14px;border-radius:12px;font-size:13px;font-weight:700;margin-bottom:14px}.checkError{justify-content:space-between;background:#fff7ed;border-color:#fed7aa;color:#9a3412}.checkError button{border:0;background:#ea580c;color:#fff;border-radius:8px;padding:7px 12px;font-weight:800;cursor:pointer}.spinner{display:inline-block;width:14px;height:14px;border:2px solid #bae6fd;border-top-color:#0369a1;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}@keyframes spin{to{transform:rotate(360deg)}}body{background:#f5f7fb}.ck{max-width:760px;margin:auto;min-height:100vh;padding:0 14px 32px;color:#101828}.ck header{position:sticky;top:0;z-index:30;margin:0 -14px;padding:12px 14px;background:#fff;display:flex;gap:12px;align-items:center;border-bottom:1px solid #eaecf0}.ck header button{width:44px;height:44px;border:0;border-radius:14px;background:#f2f4f7;font-size:31px}.ck header div{display:flex;flex-direction:column}.ck header div span{font-size:11px;color:#667085}.ck header i{margin-left:auto;font-style:normal}.steps{display:flex;align-items:center;padding:18px 24px 4px}.steps b{width:28px;height:28px;border-radius:50%;background:#ed1c24;color:#fff;display:grid;place-items:center;font-size:12px}.steps b.off{background:#e4e7ec;color:#667085}.steps em{height:3px;flex:1;background:#ed1c24}.steps em.off{background:#e4e7ec}.stepLabels{display:flex;justify-content:space-between;padding:0 10px 16px;color:#667085;font-size:11px;font-weight:700}.err{display:flex;flex-direction:column;background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;padding:13px;border-radius:14px;margin-bottom:14px}.loginBanner{background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;padding:12px 14px;border-radius:14px;margin-bottom:14px;font-size:13px}.linkBtn{background:none;border:none;color:#1d4ed8;font-weight:700;cursor:pointer;text-decoration:underline;padding:0;font-size:inherit}.loginCard{border-color:#bfdbfe}.loginBtn{flex:1;height:44px;border:0;border-radius:12px;background:#1d4ed8;color:#fff;font-size:14px;font-weight:700;cursor:pointer}.loginBtn:disabled{opacity:.55}.cancelBtn{height:44px;padding:0 18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font-size:14px;cursor:pointer}.profileSelect{height:36px;border:1px solid #d0d5dd;border-radius:10px;padding:0 10px;background:#fff;font-size:13px;color:#344054;cursor:pointer}.saveCheck{display:flex;align-items:center;gap:8px;margin-top:16px;font-size:13px;color:#344054;cursor:pointer}.saveCheck input{width:16px;height:16px;accent-color:#ed1c24}.card{background:white;border:1px solid #eaecf0;border-radius:18px;padding:16px;margin-bottom:14px}.fh{display:flex;justify-content:space-between}.fh>div{display:flex;flex-direction:column}.fh span,.route span,.meta,.flight small{font-size:12px;color:#667085}.fh strong{font-size:20px;color:#ed1c24}.route{display:grid;grid-template-columns:1fr 1.2fr 1fr;align-items:center;margin:20px 0 12px}.route>div{display:flex;flex-direction:column}.route .end{text-align:right;align-items:flex-end}.plane{text-align:center;border-bottom:1px solid #d0d5dd;height:10px;color:#ed1c24}.meta{display:flex;justify-content:space-between;border-top:1px dashed #eaecf0;padding-top:10px;gap:8px}.title{display:flex;gap:10px}.title h2{font-size:17px;margin:0}.title p{font-size:12px;color:#667085;margin:3px 0 14px}.pax+.pax{border-top:1px solid #f2f4f7;margin-top:16px;padding-top:16px}.chip{display:inline-block;background:#fff1f2;color:#be123c;padding:6px 10px;border-radius:99px;font-size:11px;font-weight:800}.typeSelect{height:32px;border:1px solid #fecdd3;border-radius:99px;padding:0 10px;background:#fff1f2;color:#be123c;font-size:11px;font-weight:800;cursor:pointer;appearance:none;-webkit-appearance:none;padding-right:22px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23be123c'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center}.typeSelect:focus{outline:none;box-shadow:0 0 0 3px rgba(237,28,36,.08)}.grid{display:grid;grid-template-columns:1fr;gap:12px}.grid label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:700;color:#344054}.grid input,.grid select{height:50px;border:1px solid #d0d5dd;border-radius:12px;padding:0 13px;background:#fff;font-size:16px}.grid input:focus,.grid select:focus{outline:none;border-color:#ed1c24;box-shadow:0 0 0 3px rgba(237,28,36,.08)}.spacer{height:96px}.pay{position:fixed;left:0;right:0;bottom:0;z-index:40;background:#fff;border-top:1px solid #eaecf0;padding:10px 14px calc(10px + env(safe-area-inset-bottom));display:flex;gap:12px;align-items:center}.pay>div{display:flex;flex-direction:column;min-width:110px}.pay span{font-size:11px;color:#667085}.pay button{flex:1;height:52px;border:0;border-radius:14px;background:#ed1c24;color:#fff;font-size:16px;font-weight:800}.pay button:disabled{opacity:.55}.success{text-align:center;padding-top:48px}.ok{width:72px;height:72px;border-radius:50%;background:#dcfce7;color:#15803d;display:grid;place-items:center;margin:auto;font-size:36px}.success h1{font-size:24px;margin:16px 0 8px}.success p{color:#667085}.receipt{background:#fff;border:1px solid #eaecf0;border-radius:16px;margin:22px 0;text-align:left}.row{display:flex;justify-content:space-between;padding:14px;border-bottom:1px solid #f2f4f7}.row:last-child{border-bottom:0}.home{display:block;background:#111827;color:#fff;text-decoration:none;padding:14px;border-radius:14px;font-weight:800;margin-top:8px}.ck button,.home{touch-action:manipulation;-webkit-tap-highlight-color:transparent}@media(min-width:640px){.grid{grid-template-columns:repeat(2,1fr)}.pay{left:50%;transform:translateX(-50%);max-width:760px;border-radius:18px 18px 0 0}}`;
