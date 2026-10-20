"use client";

import { useEffect, useState } from "react";
import { api, fmtDate, money, STATUS_STYLE } from "../../../lib/api";
import { useMe } from "../Shell";

interface Dash {
  agent: { businessName: string; status: string; currency: string; agentNumber?: string | null };
  credit: { balance: number; creditLimit: number; available: number; creditUsed: number; dueAt: string | null; overdue: boolean };
  tier: { name: string; commissionPercent: number; sales: number; next: { name: string; needed: number } | null };
  today: { bookings: number; value: number };
  month: { bookings: number; value: number; earnings: number };
  pending: { id: string; status: string; origin: string; destination: string; departureDate: string; totalAmount: number; currency: string; heldUntil: string | null; pnr: string | null }[];
  recent: { id: string; status: string; origin: string; destination: string; departureDate: string; totalAmount: number; currency: string; pnr: string | null; createdAt: string; mine: boolean }[];
  openRequests: number;
  subAgents: number;
}

export default function DashboardPage() {
  const { me } = useMe();
  const [d, setD] = useState<Dash | null>(null);
  const [error, setError] = useState("");
  const [today, setToday] = useState("");   // set after mount so server and browser render the same text
  useEffect(() => { setToday(new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })); }, []);

  useEffect(() => { api<Dash>("/api/agent/dashboard").then(setD).catch((e) => setError(e.message)); }, []);
  const cur = d?.agent.currency ?? "INR";
  const tierPct = d?.tier.next ? Math.min(100, Math.round((d.tier.sales / (d.tier.sales + d.tier.next.needed)) * 100)) : 100;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Welcome{me ? `, ${me.user.name.split(" ")[0]}` : ""}</h1>
          <p>{d?.agent.businessName ?? "Your agency"}{d?.agent.agentNumber ? <> · Agent no. <b>{d.agent.agentNumber}</b></> : null}{today ? ` · ${today}` : ""}</p>
        </div>
        <div className="row">
          <a className="btn primary" href="/search">✈️ Book a flight</a>
          <a className="btn" href="/requests/new">🧳 Visa, hotel & more</a>
        </div>
      </div>
      {error && <div className="banner bad">{error}</div>}
      {!d && !error && <p className="muted"><span className="spin" /> Loading…</p>}
      {d && (
        <>
          <div className="grid g4" style={{ marginBottom: 16 }}>
            <div className="stat"><small>Available to book</small><b>{money(d.credit.available, cur)}</b>
              <span>Balance {money(d.credit.balance, cur)} · credit {money(d.credit.creditLimit, cur)}</span></div>
            <div className="stat"><small>Today</small><b>{d.today.bookings} booking{d.today.bookings === 1 ? "" : "s"}</b><span>{money(d.today.value, cur)}</span></div>
            <div className="stat"><small>This month (incl. sub-agents)</small><b>{money(d.month.value, cur)}</b><span>{d.month.bookings} bookings</span></div>
            <div className="stat"><small>Earned this month</small><b>{money(d.month.earnings, cur)}</b><span>Commission & sub-agent markup</span></div>
          </div>

          {d.credit.creditUsed > 0 && (
            <div className={`banner ${d.credit.overdue ? "bad" : "warn"}`}>
              Credit used: <b>{money(d.credit.creditUsed, cur)}</b>{d.credit.dueAt ? ` · due ${fmtDate(d.credit.dueAt)}` : ""}. <a href="/wallet">Top up now</a>
            </div>
          )}

          <div className="grid g2">
            <div className="card">
              <div className="row between"><h2 style={{ margin: 0 }}>Your tier: {d.tier.name}</h2><span className="badge b-purple">{d.tier.commissionPercent}% commission</span></div>
              <p className="muted small" style={{ margin: "8px 0" }}>{d.tier.next ? `Book ${money(d.tier.next.needed, cur)} more this month to reach ${d.tier.next.name}.` : "You're at the top tier — thank you!"}</p>
              <div className="progress" aria-label="Progress to next tier"><i style={{ width: `${tierPct}%` }} /></div>
              <p className="muted small" style={{ marginTop: 8 }}>Sales counted: {money(d.tier.sales, cur)} (best of this or last month)</p>
            </div>
            <div className="card">
              <h2>Quick links</h2>
              <div className="row">
                <a className="btn sm" href="/wallet">Top up wallet</a>
                <a className="btn sm" href="/quotes">Quotes</a>
                <a className="btn sm" href="/requests">Requests {d.openRequests ? <span className="badge b-blue">{d.openRequests}</span> : null}</a>
                <a className="btn sm" href="/sub-agents">Sub-agents ({d.subAgents})</a>
                <a className="btn sm" href="/marketing">Marketing kit</a>
              </div>
            </div>
          </div>

          <div className="card flush">
            <div style={{ padding: "14px 16px 0" }}><h2>Waiting for payment</h2></div>
            {d.pending.length === 0 ? <p className="empty">Nothing waiting — all paid.</p> : (
              <div className="table-wrap"><table className="t"><thead><tr><th>Trip</th><th>Status</th><th>Pay before</th><th className="num">Amount</th><th /></tr></thead><tbody>
                {d.pending.map((p) => (
                  <tr key={p.id}>
                    <td><b>{p.origin} → {p.destination}</b><div className="muted small">{fmtDate(p.departureDate)}{p.pnr ? ` · PNR ${p.pnr}` : ""}</div></td>
                    <td><span className={`badge ${STATUS_STYLE[p.status]?.cls ?? "b-grey"}`}>{STATUS_STYLE[p.status]?.label ?? p.status}</span></td>
                    <td>{p.heldUntil ? fmtDate(p.heldUntil, true) : "As soon as possible"}</td>
                    <td className="num">{money(p.totalAmount, p.currency)}</td>
                    <td><a className="btn sm primary" href={`/bookings/${p.id}`}>Pay</a></td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </div>

          <div className="card flush">
            <div className="row between" style={{ padding: "14px 16px 0" }}><h2>Recent bookings</h2><a href="/bookings" className="small">All bookings →</a></div>
            {d.recent.length === 0 ? <p className="empty">No bookings yet. <a href="/search">Book your first flight →</a></p> : (
              <div className="table-wrap"><table className="t"><tbody>
                {d.recent.map((r) => (
                  <tr key={r.id}>
                    <td><a href={`/bookings/${r.id}`}><b>{r.origin} → {r.destination}</b></a><div className="muted small">{fmtDate(r.departureDate)}{r.pnr ? ` · PNR ${r.pnr}` : ""}{r.mine ? "" : " · sub-agent"}</div></td>
                    <td><span className={`badge ${STATUS_STYLE[r.status]?.cls ?? "b-grey"}`}>{STATUS_STYLE[r.status]?.label ?? r.status}</span></td>
                    <td className="num">{money(r.totalAmount, r.currency)}<div className="muted small">{fmtDate(r.createdAt)}</div></td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
