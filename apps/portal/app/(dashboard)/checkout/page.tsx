"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, ApiError, fmtDate, fmtTime, money } from "../../../lib/api";
import { useMe } from "../Shell";

type PaxType = "ADULT" | "CHILD" | "INFANT";
type Pax = {
  type: PaxType; firstName: string; lastName: string; dob: string; gender: "M" | "F"; nationality: string;
  passportNumber: string; passportExpiry: string; passportIssueDate: string; panNumber: string; documentId: string;
  bag: Record<string, string>; meal: Record<string, string>; save: boolean;
};
type Ssr = { code: string; amount: number; desc: string };
type Review = {
  bookingId: string; totalFare?: number; fareAlert?: { oldFare?: number; newFare?: number; message?: string };
  segments: { key: string; airline: string; flightNumber: string; origin: string; destination: string; departureTime: string; ssr: { baggage: Ssr[]; meal: Ssr[] } }[];
  conditions: {
    holdAllowed: boolean; emergencyContactRequired: boolean; gstMandatory: boolean; gstApplicable: boolean; passportMandatory: boolean; passportExpiryRequired: boolean;
    dobRequired: Record<PaxType, boolean>; panApplicable: boolean; documentIdApplicable: boolean; documentIdMandatory: boolean;
  };
};
type Saved = { id: string; type: string; firstName: string; lastName: string; dob: string | null; gender: string | null; nationality: string | null; passportNumber: string | null; passportExpiry: string | null };

const blank = (type: PaxType): Pax => ({ type, firstName: "", lastName: "", dob: "", gender: "M", nationality: "IN", passportNumber: "", passportExpiry: "", passportIssueDate: "", panNumber: "", documentId: "", bag: {}, meal: {}, save: true });
const pick = (m: Record<string, string>) => Object.entries(m).filter(([, c]) => c).map(([key, code]) => ({ key, code }));

export default function CheckoutPage() {
  const { me } = useMe();
  const [q, setQ] = useState<URLSearchParams | null>(null);
  const [ctx, setCtx] = useState<{ fares: { airlineName: string; flightNumber: string; origin: string; destination: string; departureTime: string; arrivalTime: string }[]; total: number; selling: number } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [pax, setPax] = useState<Pax[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [contact, setContact] = useState({ email: "", phone: "" });
  const [useGst, setUseGst] = useState(false);
  const [gst, setGst] = useState({ gstNumber: "", registeredName: "" });
  const [emergency, setEmergency] = useState({ name: "", phone: "" });
  const [mode, setMode] = useState<"PAY" | "HOLD">("PAY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState<number | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQ(params);
    try { setCtx(JSON.parse(sessionStorage.getItem("agent_checkout") ?? "null")); } catch {}
    const n = (k: string, d: number) => Math.max(0, Number(params.get(k) ?? d) || 0);
    setPax([...Array(Math.max(1, n("adults", 1))).fill(0).map(() => blank("ADULT")), ...Array(n("children", 0)).fill(0).map(() => blank("CHILD")), ...Array(n("infants", 0)).fill(0).map(() => blank("INFANT"))]);
    const priceIds = (params.get("priceIds") ?? "").split(",").filter(Boolean);
    if (!priceIds.length) { setReviewError("No fare selected. Search again."); return; }
    api<Review>("/api/book/review", { json: { priceIds, ...(params.get("sid") ? { searchId: params.get("sid") } : {}) } })
      .then((r) => { setReview(r); if (r.conditions.gstMandatory) setUseGst(true); })
      .catch((e: ApiError) => setReviewError(e.code === "FARE_EXPIRED" ? "This fare is no longer available. Please search again." : e.message));
    api<{ travellers: Saved[] }>("/api/agent/travellers").then((d) => setSaved(d.travellers)).catch(() => {});
  }, []);

  useEffect(() => {
    if (me) {
      setContact((c) => ({ email: c.email || me.settings.contactEmail || me.agent.email, phone: c.phone || me.settings.contactPhone || me.agent.whatsapp || me.agent.phone }));
      if (me.settings.gstNumber) setGst((g) => ({ gstNumber: g.gstNumber || me.settings.gstNumber!, registeredName: g.registeredName || me.agent.businessName.slice(0, 35) }));
    }
  }, [me]);

  const cond = review?.conditions;
  const cur = me?.agent.currency ?? "INR";
  const ssrTotal = useMemo(() => {
    if (!review) return 0;
    let t = 0;
    for (const p of pax) for (const s of review.segments) {
      t += s.ssr.baggage.find((o) => o.code === p.bag[s.key])?.amount ?? 0;
      t += s.ssr.meal.find((o) => o.code === p.meal[s.key])?.amount ?? 0;
    }
    return t;
  }, [pax, review]);
  const hasSsr = ssrTotal > 0;
  const upd = (i: number, patch: Partial<Pax>) => setPax((ps) => ps.map((p, n) => n === i ? { ...p, ...patch } : p));

  function fillSaved(i: number, id: string) {
    const t = saved.find((s) => s.id === id);
    if (!t) return;
    upd(i, { firstName: t.firstName, lastName: t.lastName, dob: t.dob ?? "", gender: t.gender === "F" ? "F" : "M", nationality: t.nationality ?? "IN", passportNumber: t.passportNumber ?? "", passportExpiry: t.passportExpiry ?? "", save: false });
  }

  async function scan(i: number, file?: File) {
    if (!file) return;
    setScanning(i); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const d = await api<{ traveller: { firstName: string; lastName: string; dob: string | null; gender: "M" | "F" | null; nationality: string | null; documentNumber: string | null; expiryDate: string | null; issueDate: string | null; warnings: string[] } }>("/api/ai/scan-document", { method: "POST", body: form, auth: false });
      const t = d.traveller;
      upd(i, { firstName: t.firstName || pax[i].firstName, lastName: t.lastName || pax[i].lastName, dob: t.dob ?? pax[i].dob, gender: t.gender ?? pax[i].gender, nationality: t.nationality ?? pax[i].nationality, passportNumber: t.documentNumber ?? pax[i].passportNumber, passportExpiry: t.expiryDate ?? pax[i].passportExpiry, passportIssueDate: t.issueDate ?? pax[i].passportIssueDate });
      if (t.warnings?.length) setError(`Traveller ${i + 1}: ${t.warnings.join(" ")}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read the document");
    } finally {
      setScanning(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!review || !q) return;
    setBusy(true); setError("");
    try {
      const body = {
        fareId: (q.get("priceIds") ?? "").split(",")[0], supplier: q.get("supplier") ?? "TRIPJACK",
        contactEmail: contact.email.trim(), contactPhone: contact.phone.trim(),
        origin: q.get("from"), destination: q.get("to"), departureDate: (q.get("dep") ?? "").slice(0, 10),
        totalFare: review.totalFare ?? ctx?.total ?? 1, currency: cur, tripType: q.get("tripType") ?? "ONEWAY",
        reviewBookingId: review.bookingId, ...(q.get("sid") ? { searchId: q.get("sid") } : {}),
        ...(useGst && gst.gstNumber ? { gstInfo: { gstNumber: gst.gstNumber.trim().toUpperCase(), registeredName: gst.registeredName.trim().slice(0, 35) } } : {}),
        ...(cond?.emergencyContactRequired || emergency.name ? { emergencyContact: { name: emergency.name.trim(), phone: emergency.phone.trim() } } : {}),
        ...(mode === "HOLD" ? { holdOnly: true } : {}),
        passengers: pax.map((p) => ({
          type: p.type, firstName: p.firstName.trim(), lastName: p.lastName.trim(), gender: p.gender, dob: p.dob || undefined,
          nationality: p.nationality.trim().toUpperCase().slice(0, 2) || undefined,
          passportNumber: p.passportNumber.trim() || undefined, passportExpiry: p.passportExpiry || undefined,
          passportIssueDate: p.passportNumber && p.passportIssueDate ? p.passportIssueDate : undefined,
          panNumber: p.panNumber.trim() ? p.panNumber.trim().toUpperCase() : undefined, documentId: p.documentId.trim() || undefined,
          ...(p.type !== "INFANT" && (pick(p.bag).length || pick(p.meal).length) ? { ssr: { ...(pick(p.bag).length ? { baggage: pick(p.bag) } : {}), ...(pick(p.meal).length ? { meal: pick(p.meal) } : {}) } } : {}),
        })),
      };
      const d = await api<{ bookingId: string; held?: boolean; amount: number }>("/api/book", { json: body });
      // Save new travellers for next time (best effort).
      for (const p of pax.filter((x) => x.save && x.firstName && x.lastName)) {
        api("/api/agent/travellers", { json: { type: p.type, firstName: p.firstName.trim(), lastName: p.lastName.trim(), dob: p.dob || null, gender: p.gender, nationality: p.nationality.slice(0, 2).toUpperCase() || null, passportNumber: p.passportNumber || null, passportExpiry: p.passportExpiry || null } }).catch(() => {});
      }
      if (d.held) { window.location.assign(`/bookings/${d.bookingId}?held=1`); return; }
      try {
        await api(`/api/agent/bookings/${d.bookingId}/pay`, { method: "POST" });
        window.location.assign(`/bookings/${d.bookingId}?paid=1`);
      } catch (payErr) {
        window.location.assign(`/bookings/${d.bookingId}?payError=${encodeURIComponent(payErr instanceof Error ? payErr.message : "Payment failed")}`);
      }
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.code === "FARE_EXPIRED" ? "This fare is no longer available. Please search again." : e2.message);
      window.scrollTo({ top: 0, behavior: "smooth" });
      setBusy(false);
    }
  }

  const reqDob = (t: PaxType) => !!cond?.dobRequired?.[t] || t !== "ADULT";
  const needPassport = !!cond && (cond.passportMandatory || cond.passportExpiryRequired);

  return (
    <div>
      <div className="page-head"><div><h1>Booking details</h1><p>{q?.get("from")} → {q?.get("to")} · {fmtDate(q?.get("dep"))}</p></div><a className="btn" href="/search">← Change flight</a></div>
      {error && <div className="banner bad" role="alert">{error}</div>}
      {reviewError && <div className="banner bad">{reviewError} <a href="/search">Search again</a></div>}
      {!review && !reviewError && <div className="card"><span className="spin" /> Checking the latest fare and seat availability with the airline…</div>}
      {ctx && (
        <div className="card">
          {ctx.fares.map((f, i) => (
            <div key={i} className="row between" style={{ padding: "4px 0" }}>
              <span><b>{f.airlineName}</b> {f.flightNumber} · {f.origin} {fmtTime(f.departureTime)} → {f.destination} {fmtTime(f.arrivalTime)}</span>
              <span className="muted small">{fmtDate(f.departureTime)}</span>
            </div>
          ))}
        </div>
      )}
      {review?.fareAlert?.newFare && <div className="banner warn">Fare changed by the airline: {money(review.fareAlert.oldFare ?? 0, cur)} → {money(review.fareAlert.newFare, cur)}.</div>}

      {review && (
        <form onSubmit={submit}>
          {pax.map((p, i) => (
            <div className="card" key={i}>
              <div className="row between">
                <h2 style={{ margin: 0 }}>Traveller {i + 1} · {p.type.toLowerCase()}</h2>
                <div className="row">
                  {saved.length > 0 && (
                    <select className="in" style={{ width: 200 }} value="" onChange={(e) => fillSaved(i, e.target.value)} aria-label="Fill from saved travellers">
                      <option value="">Saved travellers…</option>
                      {saved.filter((s) => s.type === p.type || p.type === "ADULT").map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
                    </select>
                  )}
                  <label className="btn sm" style={{ cursor: "pointer" }}>{scanning === i ? <><span className="spin" /> Reading…</> : "📷 Scan passport"}
                    <input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { void scan(i, e.target.files?.[0]); e.target.value = ""; }} />
                  </label>
                </div>
              </div>
              <div className="grid g4" style={{ marginTop: 12 }}>
                <label className="f">First name<input required value={p.firstName} onChange={(e) => upd(i, { firstName: e.target.value })} /></label>
                <label className="f">Last name<input required value={p.lastName} onChange={(e) => upd(i, { lastName: e.target.value })} /></label>
                <label className="f">Gender<select value={p.gender} onChange={(e) => upd(i, { gender: e.target.value as "M" | "F" })}><option value="M">Male</option><option value="F">Female</option></select></label>
                <label className="f">Date of birth{reqDob(p.type) ? "" : " (optional)"}<input type="date" required={reqDob(p.type)} value={p.dob} onChange={(e) => upd(i, { dob: e.target.value })} /></label>
                <label className="f">Nationality (2 letters)<input maxLength={2} value={p.nationality} onChange={(e) => upd(i, { nationality: e.target.value.toUpperCase() })} /></label>
                <label className="f">Passport no.{needPassport ? "" : " (optional)"}<input required={!!cond?.passportMandatory} value={p.passportNumber} onChange={(e) => upd(i, { passportNumber: e.target.value.toUpperCase() })} /></label>
                <label className="f">Passport expiry<input type="date" required={needPassport && !!p.passportNumber} value={p.passportExpiry} onChange={(e) => upd(i, { passportExpiry: e.target.value })} /></label>
                <label className="f">Passport issue date<input type="date" value={p.passportIssueDate} onChange={(e) => upd(i, { passportIssueDate: e.target.value })} /></label>
                {cond?.panApplicable && <label className="f">PAN (optional)<input value={p.panNumber} onChange={(e) => upd(i, { panNumber: e.target.value.toUpperCase() })} /></label>}
                {cond?.documentIdApplicable && p.type !== "INFANT" && <label className="f">Student / senior ID<input required={cond.documentIdMandatory} value={p.documentId} onChange={(e) => upd(i, { documentId: e.target.value })} /></label>}
              </div>
              {p.type !== "INFANT" && review.segments.some((s) => s.ssr.baggage.length || s.ssr.meal.length) && (
                <div className="grid g2" style={{ marginTop: 12 }}>
                  {review.segments.map((s) => (
                    <div key={s.key} className="stack" style={{ gap: 6 }}>
                      <span className="small muted">{s.flightNumber} {s.origin}→{s.destination}</span>
                      {s.ssr.baggage.length > 0 && <select className="in" value={p.bag[s.key] ?? ""} onChange={(e) => upd(i, { bag: { ...p.bag, [s.key]: e.target.value } })}><option value="">Extra baggage: none</option>{s.ssr.baggage.map((o) => <option key={o.code} value={o.code}>{o.desc} · {money(o.amount, cur)}</option>)}</select>}
                      {s.ssr.meal.length > 0 && <select className="in" value={p.meal[s.key] ?? ""} onChange={(e) => upd(i, { meal: { ...p.meal, [s.key]: e.target.value } })}><option value="">Meal: none</option>{s.ssr.meal.map((o) => <option key={o.code} value={o.code}>{o.desc} · {money(o.amount, cur)}</option>)}</select>}
                    </div>
                  ))}
                </div>
              )}
              {!saved.some((s) => s.firstName.toLowerCase() === p.firstName.trim().toLowerCase() && s.lastName.toLowerCase() === p.lastName.trim().toLowerCase()) && (
                <label className="small row" style={{ gap: 6, marginTop: 10 }}><input type="checkbox" checked={p.save} onChange={(e) => upd(i, { save: e.target.checked })} /> Save to my travellers</label>
              )}
            </div>
          ))}

          <div className="card">
            <h2>Customer contact (for airline messages and e-ticket)</h2>
            <div className="grid g2">
              <label className="f">Email<input type="email" required value={contact.email} onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))} /></label>
              <label className="f">Mobile<input required value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} /></label>
            </div>
            {(cond?.gstApplicable || cond?.gstMandatory) && (
              <>
                <label className="small row" style={{ gap: 6, margin: "12px 0 8px" }}><input type="checkbox" checked={useGst} disabled={cond?.gstMandatory} onChange={(e) => setUseGst(e.target.checked)} /> Use GST details{cond?.gstMandatory ? " (required for this fare)" : ""}</label>
                {useGst && <div className="grid g2">
                  <label className="f">GSTIN<input required value={gst.gstNumber} onChange={(e) => setGst((g) => ({ ...g, gstNumber: e.target.value.toUpperCase() }))} /></label>
                  <label className="f">Registered name<input required maxLength={35} value={gst.registeredName} onChange={(e) => setGst((g) => ({ ...g, registeredName: e.target.value }))} /></label>
                </div>}
              </>
            )}
            {cond?.emergencyContactRequired && (
              <div className="grid g2" style={{ marginTop: 12 }}>
                <label className="f">Emergency contact name<input required value={emergency.name} onChange={(e) => setEmergency((x) => ({ ...x, name: e.target.value }))} /></label>
                <label className="f">Emergency contact phone<input required value={emergency.phone} onChange={(e) => setEmergency((x) => ({ ...x, phone: e.target.value }))} /></label>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Payment</h2>
            <div className="stack">
              <label className="row" style={{ gap: 8 }}><input type="radio" checked={mode === "PAY"} onChange={() => setMode("PAY")} /> <span><b>Pay from agency wallet now</b> — ticket issued straight away. Available: {money(me?.credit.available ?? 0, cur)}</span></label>
              {cond?.holdAllowed && (
                <label className="row" style={{ gap: 8, opacity: hasSsr ? .5 : 1 }}><input type="radio" disabled={hasSsr} checked={mode === "HOLD"} onChange={() => setMode("HOLD")} /> <span><b>Hold the fare, pay later</b> — free hold until the airline&apos;s time limit{hasSsr ? " (not with extra baggage / meals)" : ""}</span></label>
              )}
            </div>
            <div className="row between" style={{ marginTop: 14 }}>
              <div>
                <div className="small muted">Fare (net){ssrTotal ? " + extras" : ""}</div>
                <b style={{ fontSize: 20 }}>{money((ctx?.total ?? review.totalFare ?? 0) + ssrTotal, cur)}</b>
                {ctx && ctx.selling > ctx.total && <div className="ok-text">Your selling price {money(ctx.selling + ssrTotal, cur)}</div>}
                <div className="small muted">Final amount is confirmed by the airline at booking.</div>
              </div>
              <button className="btn primary" disabled={busy || !review}>{busy ? <><span className="spin" /> Booking…</> : mode === "HOLD" ? "Hold fare" : "Book & pay from wallet"}</button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
