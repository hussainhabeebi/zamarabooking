"use client";
import { useEffect, useState } from "react";
import { adminApi } from "../../../lib/files";
import { money, REQUEST_TYPE_LABEL, STATUS_COLOR, ui } from "../../../lib/ui";

interface Row { id: string; type: string; status: string; title: string; amount: number | null; currency: string | null; createdAt: string; updatedAt: string; dueAt: string | null; agentId: string; agentName: string; overdue: boolean }

export default function AgentRequestsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState("ACTIVE");
  const [type, setType] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setRows(null); setError("");
    const q = new URLSearchParams({ ...(status ? { status } : {}), ...(type ? { type } : {}) });
    adminApi<{ requests: Row[] }>(`/api/admin/agent-program/requests?${q}`).then((d) => setRows(d.requests)).catch((e) => setError(e.message));
  }, [status, type]);

  return (
    <div>
      <h1 style={ui.h1}>Agent requests</h1>
      <p style={ui.sub}>Deposits to approve, visa / Umrah / holiday / hotel / insurance / bus / group / charter requests, booking changes, offline bookings and agency support. Replies notify the agency on WhatsApp and email.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {[["ACTIVE", "Active"], ["", "All"], ["APPROVED", "Approved"], ["DONE", "Done"], ["REJECTED", "Rejected"], ["CLOSED", "Closed"]].map(([v, l]) => <button key={v} style={ui.chip(status === v)} onClick={() => setStatus(v)}>{l}</button>)}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button style={ui.chip(!type)} onClick={() => setType("")}>All types</button>
        {Object.entries(REQUEST_TYPE_LABEL).map(([v, l]) => <button key={v} style={ui.chip(type === v)} onClick={() => setType(v)}>{l}</button>)}
      </div>
      {error && <div style={ui.err}>{error}</div>}
      <div style={{ ...ui.card, padding: 0, overflowX: "auto" }}>
        {!rows ? <p style={{ ...ui.muted, padding: 16 }}>Loading…</p> : rows.length === 0 ? <p style={{ ...ui.muted, padding: 16 }}>No requests.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={ui.th}>Request</th><th style={ui.th}>Agency</th><th style={ui.th}>Type</th><th style={ui.th}>Status</th><th style={ui.th}>Amount</th><th style={ui.th}>Updated</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td style={ui.td}><a href={`/agent-requests/${r.id}`} style={{ color: "#f1f5f9", fontWeight: 700 }}>{r.title}</a>{r.overdue && <span style={{ color: "#f87171", fontSize: 11, marginLeft: 6 }}>● overdue</span>}</td>
                <td style={ui.td}><a href={`/agents/${r.agentId}`} style={{ color: "#93c5fd" }}>{r.agentName}</a></td>
                <td style={ui.td}>{REQUEST_TYPE_LABEL[r.type] ?? r.type}</td>
                <td style={{ ...ui.td, color: STATUS_COLOR[r.status] ?? "#94a3b8", fontWeight: 700 }}>{r.status.replace("_", " ")}</td>
                <td style={ui.td}>{r.amount !== null ? money(r.amount, r.currency ?? "INR") : ""}</td>
                <td style={{ ...ui.td, color: "#94a3b8" }}>{new Date(r.updatedAt).toLocaleString("en-IN")}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
