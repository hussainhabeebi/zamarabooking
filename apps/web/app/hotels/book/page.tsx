"use client";

import { FormEvent, useEffect, useState } from "react";
import { ScanDocument, type ScannedTraveller } from "../../components/ScanDocument";

type HotelInfo = {
  optionId: string; hid: string; correlationId: string; adults: number; nationality: string; expiresAt: string;
  name: string; stars: number;
  price: number; currency: string;
  checkIn: string; checkOut: string; nights: number;
  rooms: number; roomType: string; mealPlan: string;
  isRefundable: boolean; city: string; address: string; countryCode: string;
};

type Guest = { title: string; firstName: string; lastName: string; pan: string; passport: string };

type Pricing = { totalPrice: number; basePrice: number; discount: number; taxes: number; mf: number; mft: number; currency: string };
type Review = {
  bookingId: string;
  priceChanged: boolean;
  optionChanged: boolean;
  option: {
    optionId: string; mealBasis: string; bookingNotes?: string; inclusions: string[];
    roomInfo: { name: string }[];
    pricing: Pricing;
    compliance: { gstType: string; panRequired: boolean; passportRequired: boolean };
    cancellation: { isRefundable: boolean; penalties: { from: string; to: string; amount: number }[]; deadlineDateTime?: string };
  };
};
type SavedPassenger = { id: string; firstName: string; lastName: string; isDefault: boolean };

// API errors are usually a string; a validation failure can be an object.
function errorText(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err;
  const issue = (err as { issues?: { message?: string; path?: unknown[] }[] } | null)?.issues?.[0];
  if (issue?.message) return `Please search again (${[issue.path?.join("."), issue.message].filter(Boolean).join(": ")}).`;
  return fallback;
}

// Hotel notes arrive as plain inclusions ("Free WiFi") or as JSON objects
// ({"know_before_you_go": "..."}, {"Mandatory": "..."}), sometimes several in
// one string. Turn them into readable sections.
type NoteSection = { title: string; text: string; important: boolean };
const NOTE_TITLES: Record<string, string> = {
  know_before_you_go: "Know before you go", special_instructions: "Special instructions", instructions: "Check-in instructions",
  optional: "Optional fees (paid at the hotel if used)", mandatory: "Fees payable at the hotel", fees: "Fees",
};
function noteTitle(key: string) {
  const k = key.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return NOTE_TITLES[k] ?? key.replace(/_/g, " ").replace(/^\w/, (m) => m.toUpperCase());
}
// "...property policyGovernment-issued ID..." → separate lines.
const tidy = (t: string) => t.replace(/\s+"?\s*$/, "").replace(/([a-z0-9.)%])([A-Z](?:[a-z]|\s))/g, "$1\n$2").trim();

function parseHotelNotes(items: string[]): { inclusions: string[]; sections: NoteSection[] } {
  const inclusions: string[] = [];
  const sections: NoteSection[] = [];
  for (const raw of items) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    let objects: unknown[] | null = null;
    for (const candidate of [text, `[${text}]`]) {
      try { const v = JSON.parse(candidate); objects = Array.isArray(v) ? v : [v]; break; } catch { /* not JSON */ }
    }
    if (!objects || !objects.every((o) => o && typeof o === "object")) { inclusions.push(text); continue; }
    for (const o of objects as Record<string, unknown>[]) {
      for (const [key, value] of Object.entries(o)) {
        const body = tidy(String(value ?? ""));
        if (!body) continue;
        sections.push({ title: noteTitle(key), text: body, important: /mandatory/i.test(key) });
      }
    }
  }
  return { inclusions, sections };
}

function HotelNotes({ items }: { items: string[] }) {
  const { inclusions, sections } = parseHotelNotes(items);
  if (!inclusions.length && !sections.length) return null;
  return (
    <div className="hnotes">
      {inclusions.length > 0 && <p className="hnotes-inc"><b>Includes:</b> {inclusions.join(" · ")}</p>}
      {sections.map((s, i) => (
        <details key={i} className={s.important ? "hnote hnote-important" : "hnote"} open={s.important}>
          <summary>{s.title}</summary>
          <p>{s.text}</p>
        </details>
      ))}
    </div>
  );
}

function friendlyHotelError(msg: string, status: number): string {
  if (/expired|no longer|not available|unavailable/i.test(msg)) return "This room is no longer available. Please search again.";
  if (status === 422) return "We couldn't complete your booking. Please search again and try a different option.";
  if (status >= 500) return "Something went wrong on our end. Please try again in a moment.";
  return "Booking failed. Please check your details and try again.";
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;

const emptyGuest = (): Guest => ({ title: "Mr", firstName: "", lastName: "", pan: "", passport: "" });

function getToken(): string {
  try {
    const match = document.cookie.match(/(?:^|;\s*)poomas_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch { return ""; }
}

export default function HotelBookPage() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";

  const [hotel,       setHotel]       = useState<HotelInfo | null>(null);
  const [prebooking,  setPrebooking]  = useState(false);
  const [prebooked,   setPrebooked]   = useState(false);
  const [prebookErr,  setPrebookErr]  = useState("");
  const [confirmedPrice, setConfirmedPrice] = useState<number | null>(null);
  const [review,         setReview]         = useState<Review | null>(null);
  // PAN becomes required when the room says so, or when TripJack asks for it at booking (error 1092).
  const [panNeeded,      setPanNeeded]      = useState(false);
  // Overseas hotels booked from India need the lead guest's PAN (TCS on foreign travel), so ask up front.
  // Only Indian guests need a PAN (foreign nationals don't have one).
  const indianGuests = (hotel?.nationality ?? "IN").toUpperCase() === "IN";
  const overseas = Boolean(hotel?.countryCode && hotel.countryCode !== "IN");
  const panRequiredNow = indianGuests && (panNeeded || overseas || Boolean(review?.option.compliance.panRequired));

  const [contactName,  setContactName]  = useState("");
  const [email,        setEmail]        = useState("");
  const [phone,        setPhone]        = useState("");
  const [guests,       setGuests]       = useState<Guest[][]>([[emptyGuest()]]);

  const [submitting,   setSubmitting]   = useState(false);
  const [error,        setError]        = useState("");
  const [confirmation, setConfirmation] = useState<any>(null);

  // Auth state
  const [token,           setToken]           = useState("");
  const [savedPassengers, setSavedPassengers] = useState<SavedPassenger[]>([]);

  // Inline login state
  const [showLogin,      setShowLogin]      = useState(false);
  const [loginEmail,     setLoginEmail]     = useState("");
  const [loginPassword,  setLoginPassword]  = useState("");
  const [loginError,     setLoginError]     = useState("");
  const [loggingIn,      setLoggingIn]      = useState(false);

  useEffect(() => {
    const t = getToken();
    if (t) { setToken(t); fetchSavedPassengers(t); }
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
        if (def) {
          setGuests((gs) => gs.map((room, ri) => ri !== 0 ? room : room.map((g, gi) => gi !== 0 ? g : {
            ...g, firstName: def.firstName, lastName: def.lastName,
          })));
        }
      }
    } catch { /* non-fatal */ }
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
      if (!res.ok) throw new Error(errorText(d.error, "Login failed"));
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

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const optionId = q.get("optionId") ?? "";
    if (!optionId) return;

    const roomCount = Math.max(1, parseInt(q.get("rooms") ?? "1"));
    const adults    = Math.max(1, parseInt(q.get("adults") ?? "1"));
    const info: HotelInfo = {
      optionId,
      hid:           q.get("hid") ?? "",
      correlationId: q.get("sid") ?? "",
      adults,
      nationality:   q.get("nat") ?? "IN",
      expiresAt:     q.get("exp") ?? "",
      name:        q.get("name")     ?? "",
      stars:       parseInt(q.get("stars")  ?? "0"),
      price:       parseFloat(q.get("price") ?? "0"),
      currency:    q.get("currency") ?? "INR",
      checkIn:     q.get("checkIn")  ?? "",
      checkOut:    q.get("checkOut") ?? "",
      nights:      parseInt(q.get("nights") ?? "1"),
      rooms:       roomCount,
      roomType:    q.get("roomType") ?? "",
      mealPlan:    q.get("mealPlan") ?? "",
      isRefundable: q.get("ref") === "1",
      city:        q.get("city")    ?? "",
      address:     q.get("address") ?? "",
      countryCode: (q.get("cc") ?? "").toUpperCase(),
    };
    setHotel(info);
    setGuests(Array.from({ length: roomCount }, () => Array.from({ length: adults }, emptyGuest)));

    if (!info.hid || !info.correlationId) {
      setPrebookErr("This hotel link is from an older search. Please search again.");
      return;
    }
    if (info.expiresAt && Date.parse(info.expiresAt) < Date.now()) {
      setPrebookErr("Your search has expired. Please search again for live prices.");
      return;
    }

    // TripJack Review: re-validates availability + price and returns the booking ID.
    setPrebooking(true);
    fetch(`${apiUrl}/api/hotels/review`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
      body: JSON.stringify({
        correlationId: info.correlationId, hid: info.hid, optionId,
        checkIn: info.checkIn, checkOut: info.checkOut,
        rooms: Array.from({ length: roomCount }, () => ({ adults, children: 0 })),
        nationality: info.nationality, currency: info.currency,
      }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(errorText(d.error, "This room is no longer available"));
        return d as Review;
      })
      .then((d) => {
        setReview(d);
        setConfirmedPrice(d.option.pricing.totalPrice);
        setPrebooked(true);
      })
      .catch((err) => setPrebookErr(err?.message ?? "Price check failed"))
      .finally(() => setPrebooking(false));
  }, []);

  const money = (amount: number) => {
    const code = hotel?.currency ?? "INR";
    try {
      return new Intl.NumberFormat("en-IN", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(amount);
    } catch {
      return `${code} ${amount.toLocaleString()}`;
    }
  };

  // Passport / ID scan → this guest's name (and passport number from a passport).
  const scanGuest = (room: number, i: number, t: ScannedTraveller) =>
    setGuests((gs) => gs.map((rm, ri) => ri !== room ? rm : rm.map((g, n) => n !== i ? g : {
      ...g,
      ...(t.firstName ? { firstName: t.firstName } : {}),
      ...(t.lastName ? { lastName: t.lastName } : {}),
      ...(t.gender === "F" && g.title === "Mr" ? { title: "Ms" } : t.gender === "M" && g.title !== "Mr" ? { title: "Mr" } : {}),
      ...(t.documentType === "PASSPORT" && t.documentNumber ? { passport: t.documentNumber } : {}),
    })));

  const updGuest = (room: number, i: number, k: keyof Guest, v: string) =>
    setGuests((gs) => gs.map((rm, ri) => ri !== room ? rm : rm.map((g, n) => n === i ? { ...g, [k]: v } : g)));

  // TripJack confirms hotel bookings asynchronously (up to ~3 minutes).
  async function followBooking(bookingId: string) {
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await fetch(`${apiUrl}/api/hotels/bookings/${encodeURIComponent(bookingId)}`, { headers: { "x-tenant-slug": "poomas" } });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
          setConfirmation((c: any) => ({ ...c, status: d.status, details: d, pending: d.pending }));
          if (!d.pending) return;
        }
      } catch { /* keep polling */ }
    }
    setConfirmation((c: any) => ({ ...c, pending: false, timedOut: true }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!hotel || !review || submitting || prebooking) return;
    setError("");
    // Catch a mistyped PAN here instead of a TripJack rejection after submit.
    const lead = guests[0]?.[0];
    const badPan = guests.flat().find((g) => g.pan.trim() && !PAN_RE.test(g.pan.trim().toUpperCase()));
    if (badPan) { setError(`PAN "${badPan.pan}" doesn't look right — it should be 10 characters like ABCDE1234F.`); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (panRequiredNow && !lead?.pan.trim()) { setError("Please enter the lead guest's PAN — this hotel requires it."); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${apiUrl}/api/hotels/book`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
        body: JSON.stringify({
          bookingId:    review.bookingId,
          amount:       review.option.pricing.totalPrice,
          contactEmail: email.trim(),
          contactPhone: phone.trim(),
          rooms: guests.map((room) => ({
            guests: room.map((g) => ({
              title:     g.title,
              firstName: g.firstName.trim(),
              lastName:  g.lastName.trim(),
              type:      "ADULT",
              ...(PAN_RE.test(g.pan.trim().toUpperCase()) ? { pan: g.pan.trim().toUpperCase() } : {}),
              ...(g.passport.trim().length >= 5 ? { passport: g.passport.trim() } : {}),
            })),
          })),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok && (d as any).errorCode === "PAN_REQUIRED") {
        setPanNeeded(true);
        throw new Error(errorText((d as any).error, "Please enter a valid PAN for the lead guest."));
      }
      if (!res.ok) {
        const msg = errorText((d as any).error, "");
        throw new Error(res.status === 409 || res.status === 410 ? msg : friendlyHotelError(msg, res.status));
      }
      setConfirmation(d);
      window.scrollTo({ top: 0, behavior: "smooth" });
      if ((d as any).pending) void followBooking((d as any).bookingId);
    } catch (x: any) {
      setError(x?.message ?? "Booking failed");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSubmitting(false);
    }
  }

  const displayPrice = confirmedPrice ?? hotel?.price ?? 0;
  const mealLabel: Record<string, string> = {
    CP: "Breakfast included", MAP: "Half board", AP: "Full board",
  };

  if (confirmation) {
    const st = String(confirmation.status ?? "");
    const ok = st === "SUCCESS";
    const onHold = st === "ON_HOLD";
    const failed = ["FAILED", "ABORTED"].includes(st);
    return (
      <main className="ck success"><style>{css}</style>
        <div className="ok" style={failed ? { background: "#fee2e2", color: "#b91c1c" } : undefined}>{failed ? "×" : confirmation.pending ? "…" : "✓"}</div>
        <h1>{ok ? "Hotel booked!" : onHold ? "Hotel reserved (on hold)" : failed ? "Booking could not be completed" : "Confirming with the hotel…"}</h1>
        <p style={{ color: "#667085" }}>
          {ok ? `Your booking is confirmed. Details sent to ${email}.`
            : onHold ? (confirmation.note ?? "Your room is held. It will be confirmed before the hold deadline.")
            : failed ? "The hotel could not confirm this booking. You have not been charged for it by the hotel."
            : confirmation.timedOut ? "The hotel is taking longer than usual. We'll email you as soon as it's confirmed."
            : "Keep this page open — hotels can take up to 3 minutes to confirm."}
        </p>
        <div className="receipt">
          <Row l="Hotel"       v={confirmation.details?.hotelName || hotel?.name || "—"} />
          <Row l="Booking ID"  v={confirmation.bookingId ?? "—"} />
          {confirmation.details?.confirmationNo && <Row l="Confirmation no." v={confirmation.details.confirmationNo} />}
          <Row l="Status"      v={st || "IN_PROGRESS"} />
          <Row l="Check-in"    v={hotel?.checkIn       ?? "—"} />
          <Row l="Check-out"   v={hotel?.checkOut      ?? "—"} />
          {onHold && confirmation.details?.holdDeadline && <Row l="Hold until" v={String(confirmation.details.holdDeadline).replace("T", " ")} />}
        </div>
        <a className="home" href="/hotels">Search another hotel</a>
      </main>
    );
  }

  return (
    <main className="ck"><style>{css}</style>
      <header>
        <button type="button" onClick={() => history.back()}>‹</button>
        <div><b>Hotel Checkout</b><span>{hotel?.name ?? "Loading…"}</span></div>
        <i>🔒</i>
      </header>

      {error && <div className="err"><b>Couldn't continue</b><span>{error}</span></div>}

      {/* Login banner */}
      {!token && !showLogin && (
        <div className="loginBanner">
          <span>Save time — <button type="button" className="linkBtn" onClick={() => setShowLogin(true)}>sign in</button> to auto-fill your details</span>
        </div>
      )}
      {showLogin && (
        <section className="card loginCard">
          <div className="title">
            <span>👤</span>
            <div><h2>Sign in</h2><p>Auto-fill your saved guest details.</p></div>
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

      {/* Price verification banner */}
      {prebooking && (
        <div className="prebook-banner prebook-checking">
          <span className="spinner" /> Verifying availability &amp; price…
        </div>
      )}
      {!prebooking && prebooked && (
        <div className="prebook-banner prebook-ok">
          ✓ Available — price confirmed with the hotel
          {review?.priceChanged && confirmedPrice !== null && (
            <b> · Price updated to {money(confirmedPrice)}</b>
          )}
          {review?.optionChanged && <b> · Room option updated</b>}
        </div>
      )}
      {!prebooking && prebookErr && (
        <div className="prebook-banner prebook-warn">
          ⚠ {prebookErr} <a href="/hotels" style={{ fontWeight: 700 }}>Search again</a>
        </div>
      )}

      {/* Hotel summary card */}
      {hotel && (
        <section className="card hotel">
          <div className="hh">
            <div>
              <b>{hotel.name}</b>
              <span style={{ color: "#f59e0b", fontSize: 12 }}>{"★".repeat(Math.min(5, hotel.stars))}</span>
              {hotel.address && <small>{hotel.address}</small>}
            </div>
            <strong>{money(displayPrice)}</strong>
          </div>
          <div className="hd">
            <div><b>{hotel.checkIn}</b><span>Check-in</span></div>
            <div className="hd-nights">{hotel.nights}n</div>
            <div className="hd-end"><b>{hotel.checkOut}</b><span>Check-out</span></div>
          </div>
          <div className="hmeta">
            {hotel.roomType && <span>{hotel.rooms} × {hotel.roomType}</span>}
            {hotel.mealPlan && hotel.mealPlan !== "EP" && <span>{mealLabel[hotel.mealPlan] ?? hotel.mealPlan}</span>}
            <span>{hotel.isRefundable ? "✓ Free cancellation" : "Non-refundable"}</span>
          </div>
        </section>
      )}

      {review && (
        <section className="card">
          <div className="title"><span>₹</span><div><h2>Price breakup</h2><p>{review.option.roomInfo.map((r) => r.name).join(" · ")} · {review.option.mealBasis}</p></div></div>
          <div className="receipt" style={{ margin: 0 }}>
            <Row l="Room charges" v={money(review.option.pricing.basePrice)} />
            {review.option.pricing.discount > 0 && <Row l="Discount" v={`− ${money(review.option.pricing.discount)}`} />}
            <Row l="Taxes" v={money(review.option.pricing.taxes)} />
            <Row l="Management fee" v={money(review.option.pricing.mf)} />
            <Row l="Management fee tax" v={money(review.option.pricing.mft)} />
            <Row l="Total" v={money(review.option.pricing.totalPrice)} />
          </div>
          <HotelNotes items={[...review.option.inclusions, ...(review.option.bookingNotes ? [review.option.bookingNotes] : [])]} />
          <h3 style={{ fontSize: 14, margin: "14px 0 6px" }}>Cancellation policy</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "#475467" }}>
            {review.option.cancellation.penalties.map((p, i) => (
              <li key={i}>{p.from.replace("T", " ").slice(0, 16)} → {p.to.replace("T", " ").slice(0, 16)}: {p.amount > 0 ? `${money(p.amount)} charge` : "Free cancellation"}</li>
            ))}
            {!review.option.cancellation.penalties.length && <li>{review.option.cancellation.isRefundable ? "Refundable" : "Non-refundable"}</li>}
          </ul>
          <p style={{ fontSize: 11, color: "#98a2b3" }}>Times are India time (GMT+5:30).</p>

        </section>
      )}

      <form onSubmit={submit}>
        {/* Contact details */}
        <section className="card">
          <div className="title">
            <span>☎</span>
            <div><h2>Contact details</h2><p>Confirmation will be sent here.</p></div>
          </div>
          <div className="grid">
            <Input l="Full name"     v={contactName} c={setContactName} r />
            <Input l="Email"  t="email" v={email}  c={setEmail} r />
            <Input l="Mobile" t="tel"   v={phone}  c={setPhone} r ph="+91…" />
          </div>
        </section>

        {/* Guest details */}
        <section className="card">
          <div className="title">
            <span>👤</span>
            <div>
              <h2>Guest details</h2>
              <p>Enter names as on government ID for every guest.</p>
            </div>
          </div>
          {guests.map((room, ri) => room.map((g, i) => (
            <div className="pax" key={`${ri}-${i}`}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div className="chip">Room {ri + 1} — {i === 0 ? "Lead guest" : `Guest ${i + 1}`}</div>
                {savedPassengers.length > 0 && (
                  <select
                    className="profileSelect"
                    value=""
                    onChange={(e) => {
                      const sp = savedPassengers.find((x) => x.id === e.target.value);
                      if (sp) { updGuest(ri, i, "firstName", sp.firstName); updGuest(ri, i, "lastName", sp.lastName); }
                    }}
                  >
                    <option value="">Use saved profile…</option>
                    {savedPassengers.map((x) => (
                      <option key={x.id} value={x.id}>{x.firstName} {x.lastName}{x.isDefault ? " ★" : ""}</option>
                    ))}
                  </select>
                )}
              </div>
              <ScanDocument onScanned={(t) => scanGuest(ri, i, t)} />
              <div className="grid">
                <label>Title
                  <select value={g.title} onChange={(e) => updGuest(ri, i, "title", e.target.value)}>
                    <option value="Mr">Mr</option>
                    <option value="Ms">Ms</option>
                    <option value="Mrs">Mrs</option>
                    <option value="Miss">Miss</option>
                  </select>
                </label>
                <Input l="First name" v={g.firstName} c={(v) => updGuest(ri, i, "firstName", v)} r />
                <Input l="Last name"  v={g.lastName}  c={(v) => updGuest(ri, i, "lastName",  v)} r />
                {indianGuests && (review?.option.compliance.panRequired || (ri === 0 && i === 0)) && (
                  <Input
                    l={panRequiredNow && ri === 0 && i === 0 ? (overseas ? "PAN (required for hotels outside India)" : "PAN (required by the hotel)") : "PAN (optional)"}
                    v={g.pan} c={(v) => updGuest(ri, i, "pan", v.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    r={panRequiredNow && ri === 0 && i === 0} ph="ABCDE1234F" max={10} />
                )}
                {(review?.option.compliance.passportRequired || (ri === 0 && i === 0)) && (
                  <Input l={review?.option.compliance.passportRequired ? "Passport number" : "Passport number (optional)"}
                    v={g.passport} c={(v) => updGuest(ri, i, "passport", v.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    r={Boolean(review?.option.compliance.passportRequired)} max={15} />
                )}
              </div>
            </div>
          )))}
        </section>

        <div className="spacer" />
        <div className="pay">
          <div>
            <span>Total · {hotel?.nights ?? 0} nights</span>
            <b>{money(displayPrice)}</b>
          </div>
          <button disabled={!hotel || !review || submitting || prebooking}>
            {submitting ? "Booking…" : "Confirm Booking"}
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

const css = `.hnotes{margin-top:10px;display:flex;flex-direction:column;gap:8px}.hnotes-inc{font-size:12px;color:#475467;margin:0}.hnote{border:1px solid #eaecf0;border-radius:10px;background:#f9fafb;padding:8px 12px}.hnote summary{cursor:pointer;font-size:13px;font-weight:700;color:#344054}.hnote p{margin:6px 0 2px;font-size:12px;line-height:1.55;color:#475467;white-space:pre-line}.hnote-important{background:#fffbeb;border-color:#fde68a}.hnote-important summary{color:#92400e}.loginBanner{background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;padding:12px 14px;border-radius:14px;margin-bottom:14px;font-size:13px}.linkBtn{background:none;border:none;color:#1d4ed8;font-weight:700;cursor:pointer;text-decoration:underline;padding:0;font-size:inherit}.loginCard{border-color:#bfdbfe}.loginBtn{flex:1;height:44px;border:0;border-radius:12px;background:#1d4ed8;color:#fff;font-size:14px;font-weight:700;cursor:pointer}.loginBtn:disabled{opacity:.55}.cancelBtn{height:44px;padding:0 18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;font-size:14px;cursor:pointer}.profileSelect{height:36px;border:1px solid #d0d5dd;border-radius:10px;padding:0 10px;background:#fff;font-size:13px;color:#344054;cursor:pointer}body{background:#f5f7fb}.ck{max-width:760px;margin:auto;min-height:100vh;padding:0 14px 32px;color:#101828}.ck header{position:sticky;top:0;z-index:30;margin:0 -14px;padding:12px 14px;background:#fff;display:flex;gap:12px;align-items:center;border-bottom:1px solid #eaecf0}.ck header button{width:44px;height:44px;border:0;border-radius:14px;background:#f2f4f7;font-size:31px}.ck header div{display:flex;flex-direction:column}.ck header div span{font-size:11px;color:#667085}.ck header i{margin-left:auto;font-style:normal}.err{display:flex;flex-direction:column;background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;padding:13px;border-radius:14px;margin:14px 0}.prebook-banner{padding:11px 14px;border-radius:12px;font-size:13px;font-weight:700;margin:14px 0;display:flex;align-items:center;gap:8px}.prebook-checking{background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1}.prebook-ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}.prebook-warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}.spinner{display:inline-block;width:14px;height:14px;border:2px solid #bae6fd;border-top-color:#0369a1;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.card{background:white;border:1px solid #eaecf0;border-radius:18px;padding:16px;margin-bottom:14px}.hh{display:flex;justify-content:space-between;gap:8px}.hh>div{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}.hh small{font-size:11px;color:#667085}.hh strong{font-size:20px;color:#ed1c24;flex-shrink:0}.hd{display:grid;grid-template-columns:1fr 1.2fr 1fr;align-items:center;margin:16px 0 10px}.hd>div{display:flex;flex-direction:column}.hd>div b{font-size:15px}.hd>div span{font-size:11px;color:#667085}.hd-nights{text-align:center;background:#f0f9ff;border-radius:99px;height:28px;display:grid;place-items:center;font-size:12px;font-weight:800;color:#0369a1;border:1px solid #bae6fd}.hd-end{text-align:right;align-items:flex-end}.hmeta{display:flex;flex-wrap:wrap;gap:8px;border-top:1px dashed #eaecf0;padding-top:10px;font-size:12px;color:#667085}.title{display:flex;gap:10px}.title h2{font-size:17px;margin:0}.title p{font-size:12px;color:#667085;margin:3px 0 14px}.pax+.pax{border-top:1px solid #f2f4f7;margin-top:16px;padding-top:16px}.chip{display:inline-block;background:#eff6ff;color:#1d4ed8;padding:6px 10px;border-radius:99px;font-size:11px;font-weight:800;margin-bottom:12px}.grid{display:grid;grid-template-columns:1fr;gap:12px}.grid label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:700;color:#344054}.grid input,.grid select{height:50px;border:1px solid #d0d5dd;border-radius:12px;padding:0 13px;background:#fff;font-size:16px}.grid input:focus,.grid select:focus{outline:none;border-color:#ed1c24;box-shadow:0 0 0 3px rgba(237,28,36,.08)}.spacer{height:96px}.pay{position:fixed;left:0;right:0;bottom:0;z-index:40;background:#fff;border-top:1px solid #eaecf0;padding:10px 14px calc(10px + env(safe-area-inset-bottom));display:flex;gap:12px;align-items:center}.pay>div{display:flex;flex-direction:column;min-width:110px}.pay span{font-size:11px;color:#667085}.pay button{flex:1;height:52px;border:0;border-radius:14px;background:#ed1c24;color:#fff;font-size:16px;font-weight:800}.pay button:disabled{opacity:.55}.success{text-align:center;padding-top:48px}.ok{width:72px;height:72px;border-radius:50%;background:#dcfce7;color:#15803d;display:grid;place-items:center;margin:auto;font-size:36px}.success h1{font-size:24px;margin:16px 0 8px}.success p{color:#667085}.receipt{background:#fff;border:1px solid #eaecf0;border-radius:16px;margin:22px 0;text-align:left}.row{display:flex;justify-content:space-between;padding:14px;border-bottom:1px solid #f2f4f7}.row:last-child{border-bottom:0}.home{display:block;background:#111827;color:#fff;text-decoration:none;padding:14px;border-radius:14px;font-weight:800;margin-top:8px}@media(min-width:640px){.grid{grid-template-columns:repeat(2,1fr)}.pay{left:50%;transform:translateX(-50%);max-width:760px;border-radius:18px 18px 0 0}}`;
