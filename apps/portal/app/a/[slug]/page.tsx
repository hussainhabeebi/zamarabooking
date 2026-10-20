"use client";

// Agency mini-site (public): the agency's brand, a flight search at the
// agency's selling prices, and an enquiry form that reaches the agency on
// WhatsApp / email (and in their portal).

import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, fmtDate, fmtTime, money } from "../../../lib/api";

interface Agency { name: string; logoUrl: string | null; color: string; phone: string; email: string; address: string | null; currency: string }
type Fare = { id: string; airline: string; airlineName: string; flightNumber: string; origin: string; destination: string; departureTime: string; arrivalTime: string; duration: number; stops: number; totalFare: number; displayPrice?: number; supplier: string; currency: string; baggage?: { checked?: string }; isRefundable: boolean; isBookable?: boolean; tripKey?: string };

const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export default function AgencySitePage() {
  const { slug } = useParams<{ slug: string }>();
  const [agency, setAgency] = useState<Agency | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState({ origin: "", destination: "", date: addDays(7), adults: 1 });
  const [fares, setFares] = useState<(Fare & { sell: number })[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [lead, setLead] = useState<{ fare?: Fare & { sell: number } } | null>(null);
  const [contact, setContact] = useState({ name: "", phone: "", message: "" });
  const [sent, setSent] = useState("");

  useEffect(() => {
    api<{ agency: Agency }>(`/api/agent-public/site/${slug}`, { auth: false }).then((d) => setAgency(d.agency)).catch((e) => setError(e.message));
  }, [slug]);

  async function search(e: FormEvent) {
    e.preventDefault();
    setSearching(true); setFares(null); setError("");
    try {
      const d = await api<{ fares: Fare[] }>("/api/search", { auth: false, json: { origin: q.origin.toUpperCase(), destination: q.destination.toUpperCase(), departureDate: q.date, adults: q.adults, children: 0, infants: 0, cabinClass: "ECONOMY", tripType: "ONEWAY", currency: agency?.currency ?? "INR" } });
      const list = d.fares.filter((f) => f.isBookable !== false).sort((a, b) => (a.displayPrice ?? a.totalFare) - (b.displayPrice ?? b.totalFare)).slice(0, 30);
      const p = await api<{ prices: { id: string; price: number }[] }>(`/api/agent-public/site/${slug}/prices`, { auth: false, json: { fares: list.map((f) => ({ id: f.id, totalFare: f.totalFare, displayPrice: f.displayPrice, airline: f.airline, origin: f.origin, destination: f.destination, supplier: f.supplier })) } });
      const map = new Map(p.prices.map((x) => [x.id, x.price]));
      setFares(list.map((f) => ({ ...f, sell: map.get(f.id) ?? f.displayPrice ?? f.totalFare })));
    } catch (err) { setError(err instanceof Error ? err.message : "Search failed"); } finally { setSearching(false); }
  }

  async function sendLead(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const f = lead?.fare;
      const d = await api<{ message: string }>(`/api/agent-public/site/${slug}/lead`, { auth: false, json: {
        name: contact.name, phone: contact.phone, message: contact.message || undefined,
        trip: f ? { origin: f.origin, destination: f.destination, date: f.departureTime.slice(0, 10), adults: q.adults, price: f.sell, fare: { airline: f.airlineName, flight: f.flightNumber, departure: f.departureTime } }
          : q.origin && q.destination ? { origin: q.origin.toUpperCase(), destination: q.destination.toUpperCase(), date: q.date, adults: q.adults } : undefined,
      } });
      setSent(d.message); setLead(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't send"); }
  }

  if (error && !agency) return <main className="auth"><div className="auth-card"><h1>Page not found</h1><p className="sub">{error}</p></div></main>;
  if (!agency) return <main className="auth"><span className="spin" /></main>;
  const wa = agency.phone.replace(/\D/g, "");

  return (
    <main style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <header style={{ background: agency.color, color: "#fff", padding: "20px 16px 70px" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", alignItems: "center", gap: 14 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {agency.logoUrl && <img src={agency.logoUrl} alt="" style={{ height: 52, background: "#fff", borderRadius: 10, padding: 4 }} />}
          <div style={{ flex: 1 }}><div style={{ fontSize: 24, fontWeight: 800 }}>{agency.name}</div><div style={{ opacity: .9, fontSize: 14 }}>Flights, visas & holidays · {agency.phone}</div></div>
          {wa && <a className="btn" href={`https://wa.me/${wa}`} target="_blank" rel="noopener">WhatsApp us</a>}
        </div>
      </header>
      <div style={{ maxWidth: 960, margin: "-50px auto 0", padding: "0 16px 40px" }}>
        <form className="card" onSubmit={search}>
          <div className="grid g4">
            <label className="f">From<input required maxLength={3} value={q.origin} onChange={(e) => setQ((x) => ({ ...x, origin: e.target.value.toUpperCase() }))} placeholder="COK" /></label>
            <label className="f">To<input required maxLength={3} value={q.destination} onChange={(e) => setQ((x) => ({ ...x, destination: e.target.value.toUpperCase() }))} placeholder="DXB" /></label>
            <label className="f">Date<input type="date" required min={addDays(0)} value={q.date} onChange={(e) => setQ((x) => ({ ...x, date: e.target.value }))} /></label>
            <label className="f">Travellers<input type="number" min={1} max={9} value={q.adults} onChange={(e) => setQ((x) => ({ ...x, adults: Math.min(9, Math.max(1, Number(e.target.value) || 1)) }))} /></label>
          </div>
          <div className="row between" style={{ marginTop: 12 }}>
            <span className="small muted">Enter airport codes, e.g. COK (Kochi), DXB (Dubai)</span>
            <button className="btn primary" style={{ background: agency.color, borderColor: agency.color }} disabled={searching}>{searching ? <><span className="spin" /> Searching…</> : "Search flights"}</button>
          </div>
        </form>
        {sent && <div className="banner ok">{sent}</div>}
        {error && <div className="banner bad">{error}</div>}
        {fares && (fares.length === 0 ? <div className="card empty">No flights found for this date.</div> : (
          <div className="card flush">
            {fares.map((f) => (
              <div key={f.id} className="fare">
                <div className="air"><b>{f.airlineName}</b><small>{f.flightNumber}</small></div>
                <div className="times"><div><b>{fmtTime(f.departureTime)}</b><div className="small muted">{f.origin}</div></div>
                  <div className="line">{Math.floor(f.duration / 60)}h {f.duration % 60}m · {f.stops ? `${f.stops} stop` : "Direct"}</div>
                  <div><b>{fmtTime(f.arrivalTime)}</b><div className="small muted">{f.destination}</div></div></div>
                <div className="chips">{f.baggage?.checked && <span className="chip">🧳 {f.baggage.checked}</span>}<span className="chip">{fmtDate(f.departureTime)}</span></div>
                <div className="price"><b style={{ color: agency.color }}>{money(f.sell, f.currency)}</b><small>for {q.adults} traveller{q.adults > 1 ? "s" : ""}</small>
                  <div style={{ marginTop: 6 }}><button className="btn sm primary" style={{ background: agency.color, borderColor: agency.color }} onClick={() => { setLead({ fare: f }); setSent(""); }}>Request booking</button></div></div>
              </div>
            ))}
          </div>
        ))}
        {(lead || !fares) && (
          <form className="card stack" onSubmit={sendLead}>
            <h2>{lead?.fare ? `Book ${lead.fare.airlineName} ${lead.fare.flightNumber} · ${money(lead.fare.sell, lead.fare.currency)}` : "Send us an enquiry"}</h2>
            <div className="grid g2">
              <label className="f">Your name<input required value={contact.name} onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))} /></label>
              <label className="f">Mobile / WhatsApp<input required value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} /></label>
            </div>
            <label className="f">Message (optional)<textarea value={contact.message} onChange={(e) => setContact((c) => ({ ...c, message: e.target.value }))} placeholder="Visa, hotel, holiday package…" /></label>
            <div className="row"><button className="btn primary" style={{ background: agency.color, borderColor: agency.color }}>Send</button>{lead && <button type="button" className="btn" onClick={() => setLead(null)}>Cancel</button>}</div>
          </form>
        )}
        <p className="small muted" style={{ textAlign: "center" }}>{agency.address ?? ""} · {agency.email}<br />Powered by FlyPoomas</p>
      </div>
    </main>
  );
}
