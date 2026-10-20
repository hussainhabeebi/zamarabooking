"use client";

import { useEffect, useState } from "react";
import { api, money, STATUS_STYLE } from "../../../lib/api";
import { useMe } from "../Shell";

interface Rep {
  byStatus: { status: string; n: number; total: number }[];
  topRoutes: { origin: string; destination: string; n: number; total: number }[];
  byAgent: { agentId: string; name: string; n: number; total: number }[];
  monthSales: number;
}
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10); };

export default function ReportsPage() {
  const { me } = useMe();
  const [range, setRange] = useState({ from: monthStart(), to: new Date().toISOString().slice(0, 10) });
  const [r, setR] = useState<Rep | null>(null);
  const [error, setError] = useState("");
  const cur = me?.agent.currency ?? "INR";

  useEffect(() => { setR(null); api<Rep>(`/api/agent/reports?from=${range.from}&to=${range.to}`).then(setR).catch((e) => setError(e.message)); }, [range]);
  const sold = r?.byStatus.filter((s) => ["CONFIRMED", "TICKETED"].includes(s.status)).reduce((a, s) => ({ n: a.n + s.n, total: a.total + s.total }), { n: 0, total: 0 });
  const cancelled = r?.byStatus.filter((s) => ["CANCELLED", "REFUNDED"].includes(s.status)).reduce((a, s) => a + s.n, 0) ?? 0;
  const maxRoute = Math.max(1, ...(r?.topRoutes.map((x) => x.total) ?? [1]));

  return (
    <div>
      <div className="page-head"><div><h1>Reports</h1><p>Sales for your agency and your sub-agents.</p></div>
        <div className="row"><input className="in" type="date" style={{ width: 150 }} value={range.from} onChange={(e) => setRange((x) => ({ ...x, from: e.target.value }))} /><span className="muted">to</span><input className="in" type="date" style={{ width: 150 }} value={range.to} onChange={(e) => setRange((x) => ({ ...x, to: e.target.value }))} /></div></div>
      {error && <div className="banner bad">{error}</div>}
      {!r ? <p className="muted"><span className="spin" /> Loading…</p> : (
        <>
          <div className="grid g4" style={{ marginBottom: 16 }}>
            <div className="stat"><small>Sales (confirmed)</small><b>{money(sold?.total ?? 0, cur)}</b><span>{sold?.n ?? 0} bookings</span></div>
            <div className="stat"><small>Average booking</small><b>{money(sold?.n ? (sold.total / sold.n) : 0, cur)}</b></div>
            <div className="stat"><small>Cancelled</small><b>{cancelled}</b><span>{sold?.n ? `${Math.round((cancelled / (sold.n + cancelled)) * 100)}% of bookings` : ""}</span></div>
            <div className="stat"><small>This month (your agency)</small><b>{money(r.monthSales, cur)}</b><span>Counts towards your tier</span></div>
          </div>
          <div className="grid g2">
            <div className="card">
              <h2>Top routes</h2>
              {r.topRoutes.length === 0 ? <p className="muted small">No confirmed bookings in this period.</p> : r.topRoutes.map((x) => (
                <div key={`${x.origin}${x.destination}`} style={{ marginBottom: 10 }}>
                  <div className="row between small"><b>{x.origin} → {x.destination}</b><span>{x.n} · {money(x.total, cur)}</span></div>
                  <div className="progress"><i style={{ width: `${Math.round((x.total / maxRoute) * 100)}%` }} /></div>
                </div>
              ))}
            </div>
            <div className="card">
              <h2>By status</h2>
              <table className="t"><tbody>{r.byStatus.map((s) => (
                <tr key={s.status}><td><span className={`badge ${STATUS_STYLE[s.status]?.cls ?? "b-grey"}`}>{STATUS_STYLE[s.status]?.label ?? s.status}</span></td><td className="num">{s.n}</td><td className="num">{money(s.total, cur)}</td></tr>
              ))}</tbody></table>
            </div>
          </div>
          {r.byAgent.length > 1 && (
            <div className="card flush">
              <div style={{ padding: "14px 16px 0" }}><h2>By agency (you and sub-agents)</h2></div>
              <table className="t"><thead><tr><th>Agency</th><th className="num">Bookings</th><th className="num">Sales</th></tr></thead>
                <tbody>{r.byAgent.sort((a, b) => b.total - a.total).map((a) => <tr key={a.agentId}><td>{a.name}{a.agentId === me?.agent.id ? " (you)" : ""}</td><td className="num">{a.n}</td><td className="num">{money(a.total, cur)}</td></tr>)}</tbody></table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
