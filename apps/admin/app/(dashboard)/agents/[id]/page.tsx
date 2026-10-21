"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, apiHeaders } from "../../../../lib/api";
import AgentControls from "./AgentControls";
import DeleteAgentButton from "../DeleteAgentButton";

interface Agent {
  id: string; businessName: string; ownerName: string; email: string; phone: string; whatsapp: string | null;
  region: string; currency: string; status: string; iataCode: string | null; agentNumber?: string | null; creditLimit: string; minimumDeposit: string;
  approvedAt: string | null; createdAt: string; tenantId: string; tenantSlug: string | null; tenantName: string | null; plan: string | null;
  documents: Array<{ id: string; docType: string; fileName: string; fileUrl: string; createdAt?: string }>;
  stats: { bookings: number; bookingValue: string };
}

const STATUS_COLOR: Record<string, string> = { PENDING: "#fbbf24", APPROVED: "#4ade80", SUSPENDED: "#f87171", REJECTED: "#94a3b8" };

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [a, setA] = useState<Agent | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setError("");
    try {
      const res = await fetch(`${API}/api/admin/agents/${id}`, { headers: apiHeaders() });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setA(body);
    } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  async function setStatus(status: "APPROVED" | "REJECTED" | "SUSPENDED") {
    if (!confirm(`Set ${a?.businessName} to ${status}?`)) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API}/api/admin/agents/${id}/status`, { method: "PATCH", headers: apiHeaders(), body: JSON.stringify({ status }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (error && !a) return <div><a href="/agents" style={back}>← Agents</a><div style={errBox}>{error}</div></div>;
  if (!a) return <p style={{ color: "#64748b" }}>Loading…</p>;
  const money = (v: string) => `${a.currency === "INR" ? "₹" : a.currency + " "}${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

  return (
    <div>
      <a href="/agents" style={back}>← Agents</a>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "8px 0 20px" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>{a.businessName}</h1>
          <div style={{ color: "#94a3b8", fontSize: 13 }}>{a.tenantName ?? a.tenantSlug ?? a.tenantId}{a.plan ? ` · ${a.plan}` : ""}</div>
        </div>
        <span style={{ color: STATUS_COLOR[a.status] ?? "#94a3b8", fontWeight: 700 }}>● {a.status}</span>
      </div>
      {error && <div style={errBox}>{error}</div>}

      <div style={card}>
        <h2 style={h2}>Contact</h2>
        <dl style={dl}>
          <Row k="Owner" v={a.ownerName} />
          <Row k="Email" v={a.email} />
          <Row k="Phone" v={a.phone} />
          <Row k="WhatsApp" v={a.whatsapp ?? "—"} />
          <Row k="Region / currency" v={`${a.region} · ${a.currency}`} />
          <Row k="Agent number" v={a.agentNumber ?? "—"} />
          <Row k="IATA code" v={a.iataCode ?? "—"} />
          <Row k="Joined" v={new Date(a.createdAt).toLocaleString("en-IN")} />
          <Row k="Approved" v={a.approvedAt ? new Date(a.approvedAt).toLocaleString("en-IN") : "—"} />
        </dl>
      </div>

      <div style={card}>
        <h2 style={h2}>Finance</h2>
        <dl style={dl}>
          <Row k="Credit limit" v={money(a.creditLimit)} />
          <Row k="Minimum deposit" v={money(a.minimumDeposit)} />
          <Row k="Bookings" v={String(a.stats.bookings)} />
          <Row k="Booking value" v={money(a.stats.bookingValue)} />
        </dl>
      </div>

      <div style={card}>
        <h2 style={h2}>Documents</h2>
        {a.documents.length === 0 ? <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>No documents uploaded.</p> : (
          <ul style={{ margin: 0, paddingLeft: 18, color: "#e2e8f0", fontSize: 13 }}>
            {a.documents.map((d) => <li key={d.id}>{d.docType} · {d.fileName}</li>)}
          </ul>
        )}
      </div>

      <AgentControls agentId={id} />

      <div style={card}>
        <h2 style={h2}>Status</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {a.status !== "APPROVED" && <button disabled={busy} onClick={() => setStatus("APPROVED")} style={btn}>Approve</button>}
          {a.status === "PENDING" && <button disabled={busy} onClick={() => setStatus("REJECTED")} style={btnGhost}>Reject</button>}
          {a.status === "APPROVED" && <button disabled={busy} onClick={() => setStatus("SUSPENDED")} style={btnGhost}>Suspend</button>}
        </div>
      </div>

      <div style={{ ...card, borderColor: "#7f1d1d" }}>
        <h2 style={h2}>Delete agency</h2>
        <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 12px" }}>
          Removes the agency with its logins, wallet, documents, requests and agent number. Agencies with bookings, commissions or wallet
          transactions can&apos;t be deleted — suspend them instead.
        </p>
        <DeleteAgentButton agentId={a.id} businessName={a.businessName} redirectTo="/agents" style={{ padding: "8px 14px" }} />
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <><dt style={{ color: "#64748b" }}>{k}</dt><dd style={{ color: "#e2e8f0", margin: 0, wordBreak: "break-all" }}>{v}</dd></>;
}

const back: React.CSSProperties = { color: "#94a3b8", fontSize: 13, textDecoration: "none" };
const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 16, border: "1px solid #334155", marginBottom: 16 };
const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "#f1f5f9", margin: "0 0 12px" };
const dl: React.CSSProperties = { display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px 12px", fontSize: 13, margin: 0 };
const btn: React.CSSProperties = { background: "#0D4B96", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnGhost: React.CSSProperties = { ...btn, background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
const errBox: React.CSSProperties = { background: "rgba(239,68,68,.1)", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, margin: "12px 0" };
