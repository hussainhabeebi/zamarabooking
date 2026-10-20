"use client";

// Public quote page the agency shares with its customer (no login).
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, fmtDate, fmtTime, money } from "../../../lib/api";

type Option = { airlineName: string; flightNumber?: string; origin: string; destination: string; departureTime: string; arrivalTime?: string; stops?: number; duration?: number; baggage?: string; isRefundable?: boolean; sellingPrice: number; note?: string };
interface Data {
  quote: { customerName: string | null; options: Option[]; note: string | null; currency: string; expiresAt: string; createdAt: string; expired: boolean };
  agency: { name: string; logoUrl: string | null; color: string; phone: string; email: string; address: string | null } | null;
}

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Data>(`/api/agent-public/quote/${token}`, { auth: false }).then(setD).catch((e) => setError(e.message)); }, [token]);

  if (error) return <main className="auth"><div className="auth-card"><h1>Quote not found</h1><p className="sub">{error}</p></div></main>;
  if (!d) return <main className="auth"><span className="spin" /></main>;
  const { quote: q, agency: a } = d;
  const color = a?.color ?? "#E31E24";
  const wa = (a?.phone ?? "").replace(/\D/g, "");
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px 48px" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `3px solid ${color}`, paddingBottom: 14, marginBottom: 18 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {a?.logoUrl && <img src={a.logoUrl} alt="" style={{ height: 44 }} />}
        <div><div style={{ fontSize: 20, fontWeight: 800 }}>{a?.name ?? "Your travel agent"}</div><div className="small muted">{a?.phone} · {a?.email}</div></div>
      </header>
      <h1>Flight options{q.customerName ? ` for ${q.customerName}` : ""}</h1>
      <p className="muted" style={{ marginTop: 0 }}>{q.expired ? "This quote has expired — ask us for updated prices." : `Prices valid until ${fmtDate(q.expiresAt, true)}. Fares can change until booked.`}</p>
      {q.note && <div className="banner info">{q.note}</div>}
      {q.options.map((o, i) => (
        <div key={i} className="card" style={{ borderLeft: `4px solid ${color}` }}>
          <div className="row between">
            <div><b style={{ fontSize: 16 }}>Option {i + 1}: {o.airlineName} {o.flightNumber ?? ""}</b>{o.note && <span className="badge b-green" style={{ marginLeft: 8 }}>{o.note}</span>}
              <div className="muted">{o.origin} {fmtTime(o.departureTime)} → {o.destination} {fmtTime(o.arrivalTime)} · {fmtDate(o.departureTime)}</div>
              <div className="chips" style={{ marginTop: 6 }}>
                <span className="chip">{o.stops ? `${o.stops} stop${o.stops > 1 ? "s" : ""}` : "Direct"}</span>
                {o.duration ? <span className="chip">{Math.floor(o.duration / 60)}h {o.duration % 60}m</span> : null}
                {o.baggage && <span className="chip">🧳 {o.baggage}</span>}
                <span className="chip">{o.isRefundable ? "Refundable" : "Non-refundable"}</span>
              </div></div>
            <b style={{ fontSize: 22, color }}>{money(o.sellingPrice, q.currency)}</b>
          </div>
        </div>
      ))}
      {!q.expired && wa && (
        <a className="btn primary" style={{ background: color, borderColor: color, width: "100%", padding: 14 }} target="_blank" rel="noopener"
          href={`https://wa.me/${wa}?text=${encodeURIComponent(`Hi, I'd like to book from the quote you sent (${q.options[0]?.origin} → ${q.options[0]?.destination}). Option: `)}`}>Book on WhatsApp</a>
      )}
      <p className="small muted" style={{ textAlign: "center", marginTop: 24 }}>Powered by FlyPoomas</p>
    </main>
  );
}
