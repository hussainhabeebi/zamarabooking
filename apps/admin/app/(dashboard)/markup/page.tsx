"use client";
import { useEffect, useMemo, useState } from "react";
import { API, apiHeaders } from "../../../lib/api";

interface Agent {
  id:            string;
  businessName:  string;
  parentAgentId: string | null;
  status:        string;
}

interface Rule {
  id:          string;
  name:        string;
  agentId:     string | null;
  markupType:  "FLAT" | "PERCENTAGE";
  markupValue: string;
  airline:     string | null;
  origin:      string | null;
  destination: string | null;
  cabinClass:  string | null;
  supplier:    string | null;
  validFrom:   string | null;
  validTo:     string | null;
  isActive:    boolean;
  priority:    number;
}

const EMPTY_FORM = {
  name: "", agentId: "", markupType: "FLAT" as "FLAT" | "PERCENTAGE", markupValue: "",
  airline: "", origin: "", destination: "", cabinClass: "", supplier: "",
  validFrom: "", validTo: "", isActive: true, priority: "0",
};

type Form = typeof EMPTY_FORM;

const CABINS    = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"];
const SUPPLIERS = ["TRIPJACK", "RIYA", "DUFFEL", "GOOGLE_SERP"];

function ruleToForm(r: Rule): Form {
  return {
    name: r.name, agentId: r.agentId ?? "", markupType: r.markupType, markupValue: String(Number(r.markupValue)),
    airline: r.airline ?? "", origin: r.origin ?? "", destination: r.destination ?? "",
    cabinClass: r.cabinClass ?? "", supplier: r.supplier ?? "",
    validFrom: r.validFrom ? r.validFrom.slice(0, 10) : "", validTo: r.validTo ? r.validTo.slice(0, 10) : "",
    isActive: r.isActive, priority: String(r.priority),
  };
}

function formToBody(f: Form) {
  return {
    name:        f.name,
    agentId:     f.agentId || null,
    markupType:  f.markupType,
    markupValue: Number(f.markupValue),
    airline:     f.airline || null,
    origin:      f.origin || null,
    destination: f.destination || null,
    cabinClass:  f.cabinClass || null,
    supplier:    f.supplier || null,
    validFrom:   f.validFrom ? new Date(`${f.validFrom}T00:00:00Z`).toISOString() : null,
    validTo:     f.validTo   ? new Date(`${f.validTo}T23:59:59Z`).toISOString()   : null,
    isActive:    f.isActive,
    priority:    Number(f.priority) || 0,
  };
}

export default function MarkupPage() {
  const [rules,   setRules]   = useState<Rule[]>([]);
  const [agents,  setAgents]  = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form,    setForm]    = useState<Form>(EMPTY_FORM);
  const [saving,  setSaving]  = useState(false);
  const [filter,  setFilter]  = useState("");

  async function load() {
    try {
      const res = await fetch(`${API}/api/admin/markup`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`Could not load markup rules (HTTP ${res.status})`);
      const data = await res.json() as { rules: Rule[]; agents: Agent[] };
      setRules(data.rules ?? []);
      setAgents(data.agents ?? []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // Agents first, each followed by its sub-agents.
  const agentOptions = useMemo(() => {
    const top  = agents.filter((a) => !a.parentAgentId || !agentById.has(a.parentAgentId));
    const kids = (id: string) => agents.filter((a) => a.parentAgentId === id);
    return top.flatMap((a) => [
      { id: a.id, label: a.businessName },
      ...kids(a.id).map((k) => ({ id: k.id, label: `   ↳ ${k.businessName} (sub-agent)` })),
    ]);
  }, [agents, agentById]);

  function scopeLabel(agentId: string | null) {
    if (!agentId) return { text: "All agents (default)", color: "#94a3b8" };
    const a = agentById.get(agentId);
    if (!a) return { text: "Unknown agent", color: "#f87171" };
    if (a.parentAgentId) {
      const parent = agentById.get(a.parentAgentId);
      return { text: `${a.businessName} · sub-agent of ${parent?.businessName ?? "?"}`, color: "#c084fc" };
    }
    return { text: a.businessName, color: "#60a5fa" };
  }

  function startNew(agentId = "") {
    setForm({ ...EMPTY_FORM, agentId, name: agentId ? `${agentById.get(agentId)?.businessName ?? ""} markup` : "" });
    setEditing("new"); setError("");
  }

  function startEdit(r: Rule) {
    setForm(ruleToForm(r)); setEditing(r.id); setError("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      const isNew = editing === "new";
      const res = await fetch(`${API}/api/admin/markup${isNew ? "" : `/${editing}`}`, {
        method: isNew ? "POST" : "PUT",
        headers: apiHeaders(),
        body: JSON.stringify(formToBody(form)),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 200) || "Save failed");
      }
      setEditing(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function remove(r: Rule) {
    if (!confirm(`Delete markup rule "${r.name}"?`)) return;
    const res = await fetch(`${API}/api/admin/markup/${r.id}`, { method: "DELETE", headers: apiHeaders() });
    if (!res.ok) { setError("Delete failed"); return; }
    setRules((rs) => rs.filter((x) => x.id !== r.id));
  }

  async function toggleActive(r: Rule) {
    const res = await fetch(`${API}/api/admin/markup/${r.id}`, {
      method: "PUT", headers: apiHeaders(),
      body: JSON.stringify(formToBody({ ...ruleToForm(r), isActive: !r.isActive })),
    });
    if (!res.ok) { setError("Update failed"); return; }
    setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, isActive: !x.isActive } : x));
  }

  const visibleRules = rules.filter((r) =>
    filter === "" ? true : filter === "default" ? !r.agentId : r.agentId === filter);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Markup</h1>
        <button onClick={() => startNew()} style={primaryBtn}>+ Add Markup Rule</button>
      </div>
      <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 20px" }}>
        Markup is added to the supplier fare shown in search. A matching rule allocated to an agent or
        sub-agent wins over the default rules for all agents; otherwise the highest priority matching rule
        wins. Sub-agents additionally pay any markup their parent agent sets in the agent portal.
      </p>

      {error && <div style={errorBox}>{error}</div>}

      {editing && (
        <form onSubmit={save} style={{ ...card, marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9", margin: "0 0 16px" }}>
            {editing === "new" ? "New markup rule" : "Edit markup rule"}
          </h2>

          <div style={grid}>
            <Field label="Rule name">
              <input required value={form.name} onChange={(e) => set("name", e.target.value)} style={inputStyle} placeholder="e.g. Domestic economy" />
            </Field>
            <Field label="Allocate to">
              <select value={form.agentId} onChange={(e) => set("agentId", e.target.value)} style={inputStyle}>
                <option value="">All agents (default)</option>
                {agentOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Markup type">
              <select value={form.markupType} onChange={(e) => set("markupType", e.target.value as Form["markupType"])} style={inputStyle}>
                <option value="FLAT">Flat amount</option>
                <option value="PERCENTAGE">Percentage of fare</option>
              </select>
            </Field>
            <Field label={form.markupType === "FLAT" ? "Amount (per booking)" : "Percentage (%)"}>
              <input required type="number" min="0" step="0.01" max={form.markupType === "PERCENTAGE" ? 100 : undefined}
                value={form.markupValue} onChange={(e) => set("markupValue", e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Priority (higher wins)">
              <input type="number" min="0" max="1000" value={form.priority} onChange={(e) => set("priority", e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Status">
              <select value={form.isActive ? "1" : "0"} onChange={(e) => set("isActive", e.target.value === "1")} style={inputStyle}>
                <option value="1">Active</option>
                <option value="0">Paused</option>
              </select>
            </Field>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", margin: "18px 0 8px", textTransform: "uppercase", letterSpacing: ".06em" }}>
            Applies to (leave blank for all)
          </div>
          <div style={grid}>
            <Field label="Airline code">
              <input maxLength={3} value={form.airline} onChange={(e) => set("airline", e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. 6E" />
            </Field>
            <Field label="Origin airport">
              <input maxLength={3} value={form.origin} onChange={(e) => set("origin", e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. COK" />
            </Field>
            <Field label="Destination airport">
              <input maxLength={3} value={form.destination} onChange={(e) => set("destination", e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. DXB" />
            </Field>
            <Field label="Cabin class">
              <select value={form.cabinClass} onChange={(e) => set("cabinClass", e.target.value)} style={inputStyle}>
                <option value="">Any</option>
                {CABINS.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
              </select>
            </Field>
            <Field label="Supplier">
              <select value={form.supplier} onChange={(e) => set("supplier", e.target.value)} style={inputStyle}>
                <option value="">Any</option>
                {SUPPLIERS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Valid from">
              <input type="date" value={form.validFrom} onChange={(e) => set("validFrom", e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Valid to">
              <input type="date" value={form.validTo} onChange={(e) => set("validTo", e.target.value)} style={inputStyle} />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <button type="submit" disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
              {saving ? "Saving…" : "Save rule"}
            </button>
            <button type="button" onClick={() => setEditing(null)} style={ghostBtn}>Cancel</button>
          </div>
        </form>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "#94a3b8" }}>Show:</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...inputStyle, width: "auto", minWidth: 220 }}>
          <option value="">All rules</option>
          <option value="default">Default (all agents)</option>
          {agentOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {filter && filter !== "default" && (
          <button onClick={() => startNew(filter)} style={ghostBtn}>+ Allocate markup to this agent</button>
        )}
      </div>

      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        {loading ? (
          <div style={{ padding: 24, color: "#64748b" }}>Loading…</div>
        ) : visibleRules.length === 0 ? (
          <div style={{ padding: 24, color: "#64748b" }}>No markup rules yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b" }}>
                {["Rule", "Allocated to", "Markup", "Applies to", "Priority", "Status", ""].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRules.map((r) => {
                const scope = scopeLabel(r.agentId);
                const conditions = [
                  r.airline, r.origin && r.destination ? `${r.origin}→${r.destination}` : r.origin ? `from ${r.origin}` : r.destination ? `to ${r.destination}` : null,
                  r.cabinClass?.replace("_", " "), r.supplier,
                  r.validFrom || r.validTo ? `${r.validFrom?.slice(0, 10) ?? "…"} – ${r.validTo?.slice(0, 10) ?? "…"}` : null,
                ].filter(Boolean).join(" · ") || "All fares";
                return (
                  <tr key={r.id} style={{ borderTop: "1px solid #334155", opacity: r.isActive ? 1 : 0.55 }}>
                    <td style={{ ...td, color: "#f1f5f9", fontWeight: 600 }}>{r.name}</td>
                    <td style={{ ...td, color: scope.color }}>{scope.text}</td>
                    <td style={{ ...td, color: "#f1f5f9", fontWeight: 700 }}>
                      {r.markupType === "FLAT" ? `+ ${Number(r.markupValue).toLocaleString("en-IN")}` : `+ ${Number(r.markupValue)}%`}
                    </td>
                    <td style={{ ...td, color: "#94a3b8" }}>{conditions}</td>
                    <td style={{ ...td, color: "#94a3b8" }}>{r.priority}</td>
                    <td style={td}>
                      <button onClick={() => toggleActive(r)} style={{
                        ...pill, background: r.isActive ? "#064e3b" : "#334155", color: r.isActive ? "#6ee7b7" : "#94a3b8",
                      }}>{r.isActive ? "Active" : "Paused"}</button>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                      <button onClick={() => startEdit(r)} style={linkBtn}>Edit</button>
                      <button onClick={() => remove(r)} style={{ ...linkBtn, color: "#f87171" }}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  );
}

const card: React.CSSProperties = { background: "#1e293b", borderRadius: 12, padding: 24, border: "1px solid #334155" };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 14px",
  background: "#0f172a", border: "1.5px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 14 };
const primaryBtn: React.CSSProperties = { background: "#E31E24", color: "white", border: "none", borderRadius: 8,
  padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { background: "transparent", color: "#cbd5e1", border: "1px solid #334155",
  borderRadius: 8, padding: "9px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" };
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "#60a5fa", fontWeight: 600,
  fontSize: 13, cursor: "pointer", padding: "4px 8px" };
const pill: React.CSSProperties = { border: "none", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" };
const th: React.CSSProperties = { padding: "12px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" };
const td: React.CSSProperties = { padding: "12px 16px", verticalAlign: "middle" };
const errorBox: React.CSSProperties = { background: "#450a0a", color: "#fca5a5", padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontSize: 13 };
