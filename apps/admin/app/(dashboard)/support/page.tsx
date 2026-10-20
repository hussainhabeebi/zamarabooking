"use client";
import { useEffect, useState } from "react";
import { API, apiHeaders } from "../../../lib/api";

interface Req {
  id: string; type: string; message: string; status: string; adminNote: string | null;
  contactEmail: string | null; contactPhone: string | null; createdAt: string; updatedAt: string;
  bookingId: string | null; pnr: string | null; origin: string | null; destination: string | null;
  departureDate: string | null; customerName: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  DATE_CHANGE: "Date change", ADD_BAGGAGE: "Extra baggage", MEAL_SEAT: "Meal / seat", NAME_CORRECTION: "Name correction",
  CANCELLATION_HELP: "Cancellation help", OTHER: "Other",
};
const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
const STATUS_COLOR: Record<string, string> = { OPEN: "#f87171", IN_PROGRESS: "#fbbf24", RESOLVED: "#4ade80", CLOSED: "#94a3b8" };

export default function SupportPage() {
  const [rows, setRows] = useState<Req[]>([]);
  const [filter, setFilter] = useState("OPEN");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true); setError("");
    try {
      const res = await fetch(`${API}/api/admin/support-requests${filter ? `?status=${filter}` : ""}`, { headers: apiHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.requests ?? []);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [filter]);

  async function update(id: string, body: { status?: string; adminNote?: string }) {
    setError("");
    const res = await fetch(`${API}/api/admin/support-requests/${id}`, { method: "PATCH", headers: apiHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
    await load();
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 8 }}>Support requests</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 16 }}>
        Date changes, extra baggage, meals/seats, name corrections and other help requests from customers. Your reply note is shown to the customer on their booking.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {["", ...STATUSES].map((s) => (
          <button key={s} onClick={() => setFilter(s)} style={{ ...chip, background: filter === s ? "#E31E24" : "#1e293b" }}>{s ? s.replace("_", " ") : "All"}</button>
        ))}
      </div>
      {error && <div style={errBox}>{error}</div>}
      {loading ? <p style={{ color: "#64748b" }}>Loading…</p> : rows.length === 0 ? <p style={{ color: "#64748b" }}>No requests.</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => (
            <div key={r.id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <strong style={{ color: "#f1f5f9" }}>{TYPE_LABEL[r.type] ?? r.type}</strong>
                  {r.bookingId && <span style={{ color: "#94a3b8", fontSize: 13 }}> · {r.origin} → {r.destination} · {r.departureDate ? new Date(r.departureDate).toLocaleDateString("en-IN") : ""} · PNR {r.pnr ?? "—"}</span>}
                  <div style={{ color: "#94a3b8", fontSize: 12 }}>{r.customerName ?? "Guest"} · {r.contactEmail ?? ""}{r.contactPhone ? ` · ${r.contactPhone}` : ""} · {new Date(r.createdAt).toLocaleString("en-IN")}</div>
                </div>
                <span style={{ color: STATUS_COLOR[r.status] ?? "#94a3b8", fontWeight: 800, fontSize: 13 }}>{r.status.replace("_", " ")}</span>
              </div>
              <p style={{ color: "#e2e8f0", fontSize: 14, margin: "10px 0", whiteSpace: "pre-wrap" }}>{r.message}</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input placeholder="Reply note to customer" defaultValue={r.adminNote ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                  style={{ flex: "1 1 240px", minWidth: 0, padding: "8px 10px", background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#f1f5f9", fontSize: 13 }} />
                <button onClick={() => update(r.id, { adminNote: notes[r.id] ?? r.adminNote ?? "" })} style={btnGhost}>Save note</button>
                <select value={r.status} onChange={(e) => update(r.id, { status: e.target.value, ...(notes[r.id] !== undefined ? { adminNote: notes[r.id] } : {}) })}
                  style={{ padding: "8px 10px", background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#f1f5f9", fontSize: 13 }}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155" };
const chip: React.CSSProperties = { color: "#fff", border: "1px solid #334155", borderRadius: 20, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const btnGhost: React.CSSProperties = { background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 8, padding: "8px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginBottom: 12 };
