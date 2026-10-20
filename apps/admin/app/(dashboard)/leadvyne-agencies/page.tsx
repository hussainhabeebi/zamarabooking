"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { adminApi } from "../../../lib/files";
import { money, ui } from "../../../lib/ui";
import DeleteAgentButton from "../agents/DeleteAgentButton";

// Leadvyne Live Agency clients: create their ZamraBooking agency account (agent
// number + currency from the country) and follow their searches and bookings.

const COUNTRIES: [string, string][] = [
  ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["OM", "Oman"], ["KW", "Kuwait"], ["BH", "Bahrain"],
  ["IN", "India"], ["GB", "United Kingdom"], ["US", "United States"], ["MY", "Malaysia"], ["SG", "Singapore"], ["EG", "Egypt"],
];
const COUNTRY_CURRENCY: Record<string, string> = { IN: "INR", AE: "AED", SA: "SAR", QA: "QAR", OM: "OMR", KW: "KWD", BH: "BHD" };
const CURRENCIES = ["INR", "AED", "SAR", "QAR", "OMR", "KWD", "BHD", "USD"];
const currencyFor = (cc: string) => COUNTRY_CURRENCY[cc] ?? "USD";

type Stats = {
  searches: number; searchesPeriod: number; checkouts: number; checkoutsPeriod: number;
  bookings: number; bookingsPeriod: number; attempts: number; bookingValue: number; bookingValuePeriod: number;
  conversionPct: number | null; lastActivity: string | null;
};
type Agency = {
  id: string; agentNumber: string | null; businessName: string; ownerName: string; email: string; phone: string; status: string;
  currency: string; walletCurrency: string; country: string | null; source: string; leadvyneClientId: string | null; createdAt: string; stats?: Stats;
};
type ListResponse = { days: number; totals: { searches: number; checkouts: number; bookings: number; value: number }; agents: Agency[] };
type Created = { id: string; agentNumber: string | null; businessName: string; currency: string; walletCurrency: string; inviteLink: string | null; inviteError: string | null };
type Day = { day: string; searches: number; checkouts: number; bookings: number; value: number };

const blank = { businessName: "", ownerName: "", email: "", phone: "", whatsapp: "", country: "AE", currency: "", leadvyneClientId: "", sendInvite: true };

export default function LeadvyneAgenciesPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [days, setDays] = useState(30);
  const [onlyLeadvyne, setOnlyLeadvyne] = useState(true);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [series, setSeries] = useState<Record<string, Day[]>>({});

  const load = useCallback(() => {
    setError("");
    adminApi<ListResponse>(`/api/admin/leadvyne-agents?days=${days}${onlyLeadvyne ? "&source=leadvyne" : ""}`)
      .then(setData).catch((e) => setError(e.message));
  }, [days, onlyLeadvyne]);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setCreated(null);
    try {
      const body = {
        businessName: form.businessName, ownerName: form.ownerName, email: form.email, phone: form.phone,
        ...(form.whatsapp ? { whatsapp: form.whatsapp } : {}), country: form.country,
        ...(form.currency ? { currency: form.currency } : {}), ...(form.leadvyneClientId ? { leadvyneClientId: form.leadvyneClientId } : {}),
        sendInvite: form.sendInvite,
      };
      const r = await adminApi<Created>("/api/admin/leadvyne-agents", { method: "POST", body: JSON.stringify(body) });
      setCreated(r); setForm(blank); load();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setError(""); setMsg("");
    try { await fn(); setMsg(done); load(); } catch (err: any) { setError(err.message); }
  }

  async function toggleDaily(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (!series[id]) {
      try {
        const r = await adminApi<{ series: Day[] }>(`/api/admin/leadvyne-agents/${id}/daily?days=${Math.min(days, 90)}`);
        setSeries((s) => ({ ...s, [id]: r.series }));
      } catch (err: any) { setError(err.message); }
    }
  }

  const copy = (text: string) => { void navigator.clipboard?.writeText(text); setMsg(`Copied ${text.length > 40 ? "link" : text}`); };
  const autoCurrency = currencyFor(form.country);
  const rows = (data?.agents ?? []).filter((a) => !q || `${a.agentNumber} ${a.businessName} ${a.email} ${a.leadvyneClientId ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const t = data?.totals;

  return (
    <div>
      <h1 style={ui.h1}>Leadvyne agencies</h1>
      <p style={ui.sub}>
        Agency accounts for Leadvyne Live Agency clients. Each gets a ZamraBooking agent number; Leadvyne sends it with every
        search and checkout link so prices use the agency&apos;s currency and its searches and bookings are counted here.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {[7, 30, 90].map((d) => <button key={d} style={ui.chip(days === d)} onClick={() => setDays(d)}>Last {d} days</button>)}
        <button style={ui.chip(onlyLeadvyne)} onClick={() => setOnlyLeadvyne((v) => !v)}>{onlyLeadvyne ? "Leadvyne agencies" : "All agencies"}</button>
        <input style={{ ...ui.input, width: 220 }} placeholder="Search agent no., name, email" value={q} onChange={(e) => setQ(e.target.value)} />
        <button style={{ ...ui.btn, marginLeft: "auto" }} onClick={() => { setShowForm((v) => !v); setCreated(null); }}>{showForm ? "Close" : "+ New Leadvyne agency"}</button>
      </div>

      {error && <div style={ui.err}>{error}</div>}
      {msg && <div style={ui.ok}>{msg}</div>}

      {showForm && (
        <form onSubmit={create} style={ui.card}>
          <h2 style={ui.h2}>Create agency account</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
            <label style={ui.label}>Agency name<input style={ui.input} required value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} /></label>
            <label style={ui.label}>Owner / contact name<input style={ui.input} required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} /></label>
            <label style={ui.label}>Email (portal login)<input style={ui.input} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label style={ui.label}>Phone<input style={ui.input} required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label style={ui.label}>WhatsApp (optional)<input style={ui.input} value={form.whatsapp} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} /></label>
            <label style={ui.label}>Country
              <select style={ui.input} value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value, currency: "" })}>
                {COUNTRIES.map(([cc, name]) => <option key={cc} value={cc}>{name}</option>)}
              </select>
            </label>
            <label style={ui.label}>Currency
              <select style={ui.input} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                <option value="">{autoCurrency} — automatic from country</option>
                {CURRENCIES.filter((c) => c !== autoCurrency).map((c) => <option key={c} value={c}>{c} (override)</option>)}
              </select>
            </label>
            <label style={ui.label}>Leadvyne client ID (optional)<input style={ui.input} placeholder="e.g. 42" value={form.leadvyneClientId} onChange={(e) => setForm({ ...form, leadvyneClientId: e.target.value })} /></label>
          </div>
          <label style={{ ...ui.text, display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
            <input type="checkbox" checked={form.sendInvite} onChange={(e) => setForm({ ...form, sendInvite: e.target.checked })} />
            Email a portal login invitation (agency sets its own password)
          </label>
          <p style={{ ...ui.muted, margin: "10px 0" }}>
            The account is approved straight away. Prices for this agency are shown in {form.currency || autoCurrency}; its wallet is kept in {["INR", "USD"].includes(form.currency || autoCurrency) ? (form.currency || autoCurrency) : "AED"}.
          </p>
          <button style={ui.btn} disabled={busy}>{busy ? "Creating…" : "Create agency & agent number"}</button>
        </form>
      )}

      {created && (
        <div style={{ ...ui.card, borderColor: "#14532d" }}>
          <div style={ui.muted}>Agency created — give this agent number to {created.businessName} in Leadvyne Live Agency</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "8px 0", flexWrap: "wrap" }}>
            <b style={{ fontSize: 28, color: "#4ade80", letterSpacing: ".04em" }}>{created.agentNumber ?? "—"}</b>
            {created.agentNumber && <button style={ui.ghost} onClick={() => copy(created.agentNumber!)}>Copy</button>}
            <span style={ui.text}>Currency <b>{created.currency}</b> · wallet {created.walletCurrency}</span>
          </div>
          {created.inviteLink && <div style={ui.text}>Invitation emailed. Link (7 days): <button style={{ ...ui.ghost, padding: "4px 10px" }} onClick={() => copy(created.inviteLink!)}>Copy invite link</button></div>}
          {created.inviteError && <div style={ui.err}>Invitation not sent: {created.inviteError}</div>}
        </div>
      )}

      {t && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[["Searches", t.searches.toLocaleString("en-IN")], ["Checkout links", t.checkouts.toLocaleString("en-IN")], ["Bookings", t.bookings.toLocaleString("en-IN")], ["Booking value", money(t.value)],
            ["Search → booking", t.searches ? `${(Math.round((t.bookings / t.searches) * 1000) / 10).toFixed(1)}%` : "—"]].map(([k, v]) => (
            <div key={k} style={{ ...ui.card, marginBottom: 0 }}>
              <div style={ui.muted}>{k} · {days}d</div>
              <div style={{ color: "#f1f5f9", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ ...ui.card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Agent no.", "Agency", "Currency", `Searches ${days}d / all`, "Links", "Bookings", "Value (INR)", ""].map((h) => <th key={h} style={ui.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {!data && <tr><td style={ui.td} colSpan={8}>Loading…</td></tr>}
            {data && rows.length === 0 && <tr><td style={ui.td} colSpan={8}>No agencies yet. Create one with “+ New Leadvyne agency”.</td></tr>}
            {rows.map((a) => {
              const s = a.stats;
              return (
                <Fragment key={a.id}>
                  <tr>
                    <td style={ui.td}>
                      {a.agentNumber
                        ? <button title="Copy" onClick={() => copy(a.agentNumber!)} style={{ background: "none", border: 0, color: "#93c5fd", fontWeight: 800, cursor: "pointer", padding: 0, fontSize: 13 }}>{a.agentNumber}</button>
                        : <button style={{ ...ui.ghost, padding: "4px 8px" }} onClick={() => act(() => adminApi(`/api/admin/leadvyne-agents/${a.id}/number`, { method: "POST" }), "Agent number assigned.")}>Assign</button>}
                    </td>
                    <td style={ui.td}>
                      <a href={`/agents/${a.id}`} style={{ color: "#f1f5f9", fontWeight: 700, textDecoration: "none" }}>{a.businessName}</a>
                      <div style={ui.muted}>{a.email}{a.leadvyneClientId ? ` · Leadvyne #${a.leadvyneClientId}` : ""}{a.status !== "APPROVED" ? ` · ${a.status}` : ""}</div>
                      <div style={ui.muted}>Last activity: {s?.lastActivity ?? "—"}</div>
                    </td>
                    <td style={ui.td}>
                      <select style={{ ...ui.input, padding: "4px 6px" }} value={a.currency}
                        onChange={(e) => act(() => adminApi(`/api/admin/leadvyne-agents/${a.id}`, { method: "PATCH", body: JSON.stringify({ currency: e.target.value }) }), `${a.businessName}: currency set to ${e.target.value}.`)}>
                        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      {a.country && <div style={ui.muted}>{a.country}</div>}
                    </td>
                    <td style={ui.td}><b>{s?.searchesPeriod ?? 0}</b> <span style={ui.muted}>/ {s?.searches ?? 0}</span></td>
                    <td style={ui.td}>{s?.checkoutsPeriod ?? 0} <span style={ui.muted}>/ {s?.checkouts ?? 0}</span></td>
                    <td style={ui.td}><b>{s?.bookingsPeriod ?? 0}</b> <span style={ui.muted}>/ {s?.bookings ?? 0}</span>
                      {s?.conversionPct != null && <div style={ui.muted}>{s.conversionPct}% of searches</div>}
                      {s && s.attempts > s.bookings ? <div style={ui.muted}>{s.attempts - s.bookings} unpaid / failed</div> : null}</td>
                    <td style={ui.td}>{money(s?.bookingValuePeriod ?? 0)}<div style={ui.muted}>all: {money(s?.bookingValue ?? 0)}</div></td>
                    <td style={{ ...ui.td, whiteSpace: "nowrap" }}>
                      <button style={{ ...ui.ghost, padding: "4px 8px" }} onClick={() => toggleDaily(a.id)}>{open === a.id ? "Hide" : "Daily"}</button>{" "}
                      <button style={{ ...ui.ghost, padding: "4px 8px" }} onClick={() => act(async () => { const r = await adminApi<{ inviteLink: string }>(`/api/admin/leadvyne-agents/${a.id}/invite`, { method: "POST" }); copy(r.inviteLink); }, "Invitation emailed; link copied.")}>Invite</button>{" "}
                      <DeleteAgentButton agentId={a.id} businessName={a.businessName} apiPath="/api/admin/leadvyne-agents"
                        onDeleted={() => { setMsg(`${a.businessName} deleted.`); if (open === a.id) setOpen(null); load(); }} />
                    </td>
                  </tr>
                  {open === a.id && (
                    <tr><td style={{ ...ui.td, background: "#0f172a" }} colSpan={8}><DailyChart rows={series[a.id]} /></td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={ui.card}>
        <h2 style={ui.h2}>How Leadvyne sends the agent number</h2>
        <div style={{ ...ui.text, lineHeight: 1.7 }}>
          Add the agency&apos;s agent number to its Leadvyne Live Agency client settings. Leadvyne then sends it to ZamraBooking as the header
          <code style={code}> X-FP-Agent: FPA10001</code> (or <code style={code}>&quot;agentNumber&quot;</code> in the JSON body) on:
          <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
            <li><code style={code}>POST /api/search</code> — counts the search; the response adds <code style={code}>agent</code>, <code style={code}>agentCurrency</code> and an <code style={code}>agentPrice</code> per fare in the agency&apos;s currency.</li>
            <li><code style={code}>POST /api/integrations/checkout-sessions</code> — counts the checkout link, opens the booking page in the agency&apos;s currency and tags the booking.</li>
            <li><code style={code}>GET /api/integrations/agents/FPA10001</code> and <code style={code}>/stats</code> — check a number, read its currency and analytics (integration key).</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

const code: React.CSSProperties = { background: "#0f172a", padding: "1px 6px", borderRadius: 4, fontSize: 12, color: "#fbbf24" };

function DailyChart({ rows }: { rows?: Day[] }) {
  if (!rows) return <span style={ui.muted}>Loading…</span>;
  const max = Math.max(1, ...rows.map((r) => r.searches));
  const totals = rows.reduce((t, r) => ({ s: t.s + r.searches, c: t.c + r.checkouts, b: t.b + r.bookings }), { s: 0, c: 0, b: 0 });
  return (
    <div>
      <div style={{ ...ui.muted, marginBottom: 8 }}>
        <span style={{ color: "#60a5fa" }}>■</span> searches · <span style={{ color: "#fbbf24" }}>■</span> checkout links · <span style={{ color: "#4ade80" }}>■</span> bookings
        &nbsp;— {totals.s} / {totals.c} / {totals.b} in {rows.length} days
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 90 }}>
        {rows.map((r) => (
          <div key={r.day} title={`${r.day}: ${r.searches} searches, ${r.checkouts} links, ${r.bookings} bookings`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", minWidth: 3 }}>
            <div style={{ background: "#60a5fa", height: `${(r.searches / max) * 100}%`, minHeight: r.searches ? 2 : 0, borderRadius: "2px 2px 0 0" }} />
            {r.checkouts > 0 && <div style={{ background: "#fbbf24", height: 3 }} />}
            {r.bookings > 0 && <div style={{ background: "#4ade80", height: 4 }} />}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", ...ui.muted, marginTop: 4 }}><span>{rows[0]?.day}</span><span>{rows[rows.length - 1]?.day}</span></div>
    </div>
  );
}
