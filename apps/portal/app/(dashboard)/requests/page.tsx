"use client";

import { useEffect, useState } from "react";
import { api, fmtDate, money, REQUEST_TYPES, requestLabel, STATUS_STYLE } from "../../../lib/api";

interface Req { id: string; type: string; status: string; title: string; amount: number | null; currency: string | null; createdAt: string; updatedAt: string }

export default function RequestsPage() {
  const [rows, setRows] = useState<Req[] | null>(null);
  const [type, setType] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setRows(null);
    api<{ requests: Req[] }>(`/api/agent/requests${type ? `?type=${type}` : ""}`).then((d) => setRows(d.requests)).catch((e) => setError(e.message));
  }, [type]);

  return (
    <div>
      <div className="page-head"><div><h1>Services & requests</h1><p>Visa, Umrah, holidays, hotels, insurance, bus, groups, booking changes and support — our team handles them and replies here.</p></div>
        <a className="btn primary" href="/requests/new">+ New request</a></div>
      <div className="service-grid" style={{ marginBottom: 16 }}>
        {REQUEST_TYPES.slice(0, 8).map((r) => (
          <a key={r.type} className="service" href={`/requests/new?type=${r.type}`} style={{ textDecoration: "none" }}>
            <span style={{ fontSize: 22 }}>{r.icon}</span><b>{r.label}</b><small>{r.hint}</small>
          </a>
        ))}
      </div>
      <div className="tabs">
        <button className={!type ? "on" : ""} onClick={() => setType("")}>All</button>
        {["LEAD", ...REQUEST_TYPES.map((r) => r.type), "DEPOSIT"].map((t) => <button key={t} className={type === t ? "on" : ""} onClick={() => setType(t)}>{requestLabel(t)}</button>)}
      </div>
      {error && <div className="banner bad">{error}</div>}
      <div className="card flush">
        {!rows ? <p className="empty"><span className="spin" /> Loading…</p> : rows.length === 0 ? <p className="empty">No requests yet.</p> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Request</th><th>Type</th><th>Status</th><th className="num">Amount</th><th>Updated</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><a href={`/requests/${r.id}`}><b>{r.title}</b></a><div className="muted small">#{r.id.slice(0, 8).toUpperCase()} · {fmtDate(r.createdAt)}</div></td>
                <td>{requestLabel(r.type)}</td>
                <td><span className={`badge ${STATUS_STYLE[r.status]?.cls ?? "b-grey"}`}>{STATUS_STYLE[r.status]?.label ?? r.status}</span></td>
                <td className="num">{r.amount !== null ? money(r.amount, r.currency ?? "INR") : ""}</td>
                <td className="small muted">{fmtDate(r.updatedAt, true)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
