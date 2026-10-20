"use client";

import { useEffect, useMemo, useState } from "react";
import { api, fmtDate, money, STATUS_STYLE } from "../../../lib/api";

interface Trip {
  id: string; status: string; pnr: string | null; origin: string; destination: string; departureDate: string | null;
  totalAmount: number; currency: string; adultCount: number; childCount: number; infantCount: number; createdAt: string;
}

const FILTERS: [string, string, (t: Trip) => boolean][] = [
  ["all", "All", () => true],
  ["pay", "To pay", (t) => ["HELD", "PAYMENT_PENDING"].includes(t.status)],
  ["upcoming", "Upcoming", (t) => ["CONFIRMED", "TICKETED"].includes(t.status) && !!t.departureDate && t.departureDate.slice(0, 10) >= new Date().toISOString().slice(0, 10)],
  ["done", "Travelled", (t) => ["CONFIRMED", "TICKETED"].includes(t.status) && !!t.departureDate && t.departureDate.slice(0, 10) < new Date().toISOString().slice(0, 10)],
  ["cancelled", "Cancelled", (t) => ["CANCELLED", "REFUNDED", "REFUND_PENDING", "PAYMENT_FAILED"].includes(t.status)],
];

export default function BookingsPage() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");

  useEffect(() => { api<{ trips: Trip[] }>("/api/agent/trips").then((d) => setTrips(d.trips)).catch((e) => setError(e.message)); }, []);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x[0] === filter)![2];
    const s = q.trim().toLowerCase();
    return (trips ?? []).filter(f).filter((t) => !s || `${t.pnr ?? ""} ${t.id} ${t.origin} ${t.destination}`.toLowerCase().includes(s));
  }, [trips, filter, q]);

  return (
    <div>
      <div className="page-head"><div><h1>Bookings</h1><p>Your agency&apos;s and your sub-agents&apos; bookings.</p></div><a className="btn primary" href="/search">✈️ New booking</a></div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="tabs" style={{ margin: 0 }}>{FILTERS.map(([k, label]) => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>)}</div>
        <input className="in" style={{ maxWidth: 260 }} placeholder="Search PNR, route or booking ID" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="banner bad">{error}</div>}
      <div className="card flush">
        {!trips && !error ? <p className="empty"><span className="spin" /> Loading…</p> : visible.length === 0 ? <p className="empty">No bookings here yet.</p> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Trip</th><th>Travel date</th><th>Travellers</th><th>Status</th><th className="num">Amount</th><th>Booked</th></tr></thead>
            <tbody>{visible.map((t) => (
              <tr key={t.id}>
                <td><a href={`/bookings/${t.id}`}><b>{t.origin} → {t.destination}</b></a><div className="muted small">{t.pnr ? `PNR ${t.pnr}` : `ID ${t.id.slice(0, 8).toUpperCase()}`}</div></td>
                <td>{fmtDate(t.departureDate)}</td>
                <td>{t.adultCount + t.childCount + t.infantCount}</td>
                <td><span className={`badge ${STATUS_STYLE[t.status]?.cls ?? "b-grey"}`}>{STATUS_STYLE[t.status]?.label ?? t.status}</span></td>
                <td className="num">{money(t.totalAmount, t.currency)}</td>
                <td className="muted small">{fmtDate(t.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
