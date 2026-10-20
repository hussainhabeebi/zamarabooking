"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, fmtDate, fmtTime, money, QUOTE_DRAFT } from "../../../lib/api";
import { useMe } from "../Shell";

type Fare = { id: string; airlineName: string; flightNumber: string; origin: string; destination: string; departureTime: string; arrivalTime: string; stops: number; duration: number; isRefundable: boolean; baggage?: { checked?: string }; currency: string; netPrice?: number; displayPrice?: number; totalFare: number; sellingPrice?: number };
type Option = { airlineName: string; flightNumber: string; origin: string; destination: string; departureTime: string; arrivalTime: string; stops: number; duration: number; baggage?: string; isRefundable: boolean; sellingPrice: number; note?: string; net: number };
interface Q { id: string; token: string; customerName: string | null; customerPhone: string | null; options: Option[]; currency: string; expiresAt: string; viewedAt: string | null; createdAt: string }

export default function QuotesPage() {
  const { me } = useMe();
  const [draft, setDraft] = useState<Option[]>([]);
  const [quotes, setQuotes] = useState<Q[]>([]);
  const [cust, setCust] = useState({ name: "", phone: "", note: "", validHours: 24 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ url: string; phone: string } | null>(null);
  const cur = me?.agent.currency ?? "INR";

  const loadQuotes = () => api<{ quotes: Q[] }>("/api/agent/quotes").then((d) => setQuotes(d.quotes)).catch(() => {});
  useEffect(() => {
    try {
      const fares = JSON.parse(localStorage.getItem(QUOTE_DRAFT) ?? "[]") as Fare[];
      setDraft(fares.map((f) => {
        const net = f.netPrice ?? f.displayPrice ?? f.totalFare;
        return { airlineName: f.airlineName, flightNumber: f.flightNumber, origin: f.origin, destination: f.destination, departureTime: f.departureTime, arrivalTime: f.arrivalTime, stops: f.stops, duration: f.duration, baggage: f.baggage?.checked, isRefundable: f.isRefundable, sellingPrice: Math.round(f.sellingPrice ?? net), net };
      }));
    } catch {}
    loadQuotes();
  }, []);

  function clearDraft() { localStorage.removeItem(QUOTE_DRAFT); setDraft([]); }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const d = await api<{ url: string }>("/api/agent/quotes", { json: {
        customerName: cust.name || undefined, customerPhone: cust.phone || undefined, note: cust.note || undefined, validHours: cust.validHours, currency: cur,
        options: draft.map(({ net: _n, ...o }) => ({ ...o, baggage: o.baggage || undefined, note: o.note || undefined })),
      } });
      setCreated({ url: d.url, phone: cust.phone });
      clearDraft(); loadQuotes();
    } catch (err) { setError(err instanceof Error ? err.message : "Couldn't create the quote"); } finally { setBusy(false); }
  }

  const waLink = (url: string, phone?: string | null) => {
    const text = `Here are your flight options from ${me?.settings.displayName || me?.agent.businessName || "us"}: ${url}`;
    const p = (phone ?? "").replace(/\D/g, "");
    return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
  };

  return (
    <div>
      <div className="page-head"><div><h1>Quotes</h1><p>Send customers a branded quote with your selling prices. Mark fares with “+ Quote” in flight search.</p></div><a className="btn" href="/search">✈️ Find fares</a></div>
      {error && <div className="banner bad">{error}</div>}
      {created && (
        <div className="banner ok">Quote ready: <a href={created.url} target="_blank" rel="noopener">{created.url}</a>{" "}
          <a className="btn sm" href={waLink(created.url, created.phone)} target="_blank" rel="noopener">Send on WhatsApp</a>{" "}
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(created.url)}>Copy link</button></div>
      )}
      {draft.length > 0 ? (
        <form className="card stack" onSubmit={create}>
          <div className="row between"><h2 style={{ margin: 0 }}>New quote ({draft.length} option{draft.length > 1 ? "s" : ""})</h2><button type="button" className="btn sm" onClick={clearDraft}>Clear</button></div>
          {draft.map((o, i) => (
            <div key={i} className="row between" style={{ borderBottom: "1px solid #f1f5f9", paddingBottom: 10 }}>
              <div><b>{o.airlineName} {o.flightNumber}</b><div className="small muted">{o.origin} {fmtTime(o.departureTime)} → {o.destination} {fmtTime(o.arrivalTime)} · {fmtDate(o.departureTime)} · {o.stops ? `${o.stops} stop` : "direct"}</div>
                <div className="small muted">Your cost {money(o.net, cur)}</div></div>
              <div className="row">
                <label className="f" style={{ width: 150 }}>Selling price<input type="number" min={1} required value={o.sellingPrice} onChange={(e) => setDraft((d) => d.map((x, n) => n === i ? { ...x, sellingPrice: Number(e.target.value) } : x))} /></label>
                <label className="f" style={{ width: 200 }}>Note<input value={o.note ?? ""} placeholder="e.g. Best value" onChange={(e) => setDraft((d) => d.map((x, n) => n === i ? { ...x, note: e.target.value } : x))} /></label>
                <span className={o.sellingPrice >= o.net ? "ok-text" : "err"}>{o.sellingPrice >= o.net ? `+${money(o.sellingPrice - o.net, cur)}` : "Below cost"}</span>
              </div>
            </div>
          ))}
          <div className="grid g4">
            <label className="f">Customer name<input value={cust.name} onChange={(e) => setCust((c) => ({ ...c, name: e.target.value }))} /></label>
            <label className="f">WhatsApp number<input value={cust.phone} onChange={(e) => setCust((c) => ({ ...c, phone: e.target.value }))} placeholder="+91…" /></label>
            <label className="f">Valid for<select value={cust.validHours} onChange={(e) => setCust((c) => ({ ...c, validHours: Number(e.target.value) }))}><option value={6}>6 hours</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select></label>
            <label className="f">Message<input value={cust.note} onChange={(e) => setCust((c) => ({ ...c, note: e.target.value }))} placeholder="Prices may change until booked" /></label>
          </div>
          <button className="btn primary" disabled={busy} style={{ alignSelf: "flex-start" }}>{busy ? "Creating…" : "Create quote link"}</button>
        </form>
      ) : <div className="card empty">No fares selected. In <a href="/search">flight search</a>, tap “+ Quote” on up to 6 fares.</div>}

      <div className="card flush">
        <div style={{ padding: "14px 16px 0" }}><h2>Sent quotes</h2></div>
        {quotes.length === 0 ? <p className="empty">No quotes yet.</p> : (
          <div className="table-wrap"><table className="t"><tbody>{quotes.map((q) => {
            const url = `${window.location.origin}/q/${q.token}`;
            return (
              <tr key={q.id}>
                <td><b>{q.customerName || "Customer"}</b><div className="muted small">{q.options.length} option(s) · {q.options[0] ? `${q.options[0].origin} → ${q.options[0].destination}` : ""}</div></td>
                <td className="small">{q.viewedAt ? <span className="badge b-green">Viewed</span> : <span className="badge b-grey">Not opened</span>}</td>
                <td className="small muted">{new Date(q.expiresAt).getTime() < Date.now() ? "Expired" : `Valid till ${fmtDate(q.expiresAt, true)}`}</td>
                <td className="num"><a className="btn sm" href={url} target="_blank" rel="noopener">Open</a>{" "}<a className="btn sm" href={waLink(url, q.customerPhone)} target="_blank" rel="noopener">WhatsApp</a>{" "}
                  <button className="btn sm danger" onClick={async () => { await api(`/api/agent/quotes/${q.id}`, { method: "DELETE" }).catch(() => {}); loadQuotes(); }}>Delete</button></td>
              </tr>
            );
          })}</tbody></table></div>
        )}
      </div>
    </div>
  );
}
