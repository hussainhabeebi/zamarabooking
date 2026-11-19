"use client";
// Admin → Analytics: customer search tracking reports (Phase 1, docs/search-analytics.md).
// Data: /api/admin/analytics/* (routes/admin/analytics.ts). CSV exports are made by the API with the
// same permissions; customer details appear only for admins allowed to see them.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { API, apiHeaders } from "../../../lib/api";
import { adminApi } from "../../../lib/files";
import { money, ui } from "../../../lib/ui";

type Tab = "overview" | "sectors" | "airports" | "dates" | "searches" | "abandoned" | "revenue";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" }, { key: "sectors", label: "Sectors" }, { key: "airports", label: "Airports" },
  { key: "dates", label: "Travel dates" }, { key: "searches", label: "Search history" },
  { key: "abandoned", label: "Abandoned checkouts" }, { key: "revenue", label: "Revenue" },
];
const STATUS_LABEL: Record<string, string> = {
  BOOKED: "Booked (paid)", CHECKOUT_UNPAID: "Booking not paid", IN_PROGRESS: "In progress (< 24 h)", ABANDONED: "Abandoned", NO_AVAILABILITY: "No availability",
};
const STATUS_COLOR: Record<string, string> = { BOOKED: "#4ade80", CHECKOUT_UNPAID: "#fbbf24", IN_PROGRESS: "#60a5fa", ABANDONED: "#f87171", NO_AVAILABILITY: "#94a3b8" };

// India-time dates for the presets.
const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => istDay(new Date(Date.now() - n * 86_400_000));
const num = (v: unknown) => Number(v ?? 0).toLocaleString("en-IN");
const pct = (v: unknown) => `${Number(v ?? 0).toFixed(2)}%`;
const when = (v: unknown) => (v ? new Date(String(v)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(istDay());
  const [device, setDevice] = useState("");
  const [country, setCountry] = useState("");
  const [audience, setAudience] = useState("");
  const [interval, setInterval] = useState<"day" | "week" | "month">("day");
  const [status, setStatus] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  const [trendRows, setTrendRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<{ searchTracking: boolean; updatedAt?: string } | null>(null);
  const [fullAdmin, setFullAdmin] = useState(false);
  const [saving, setSaving] = useState(false);

  const query = useMemo(() => {
    const q = new URLSearchParams({ from, to });
    if (device) q.set("device", device);
    if (country) q.set("country", country);
    if (audience) q.set("audience", audience);
    return q;
  }, [from, to, device, country, audience]);

  const path = useCallback((t: Tab) => {
    const q = new URLSearchParams(query);
    if (t === "revenue") q.set("interval", interval);
    if (t === "searches") {
      if (status) q.set("status", status);
      if (origin.length === 3) q.set("origin", origin.toUpperCase());
      if (destination.length === 3) q.set("destination", destination.toUpperCase());
    }
    if (t === "searches" || t === "abandoned") q.set("page", String(page));
    return `/api/admin/analytics/${t === "abandoned" ? "abandoned-checkouts" : t}?${q}`;
  }, [query, interval, status, origin, destination, page]);

  useEffect(() => {
    adminApi("/api/admin/analytics/settings").then(setSettings).catch(() => {});
    adminApi<{ fullAccess: boolean }>("/api/admin/me").then((m) => setFullAdmin(m.fullAccess)).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    const jobs: Promise<unknown>[] = [adminApi(path(tab)).then((d) => { if (alive) setData(d); })];
    if (tab === "overview") jobs.push(adminApi(`/api/admin/analytics/trend?${query}&interval=${interval}`).then((d: any) => { if (alive) setTrendRows(d.rows ?? []); }));
    Promise.all(jobs).catch((e) => { if (alive) { setError(e.message); setData(null); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, path, query, interval]);

  async function download(t: Tab, extra: Record<string, string> = {}) {
    setError("");
    const url = new URL(`${API}${path(t)}`);
    url.searchParams.delete("page");
    url.searchParams.set("format", "csv");
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    try {
      const res = await fetch(url, { headers: apiHeaders() });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? `HTTP ${res.status}`); }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "analytics.csv";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    }
  }

  async function toggleTracking() {
    if (!settings) return;
    const next = !settings.searchTracking;
    if (!confirm(next ? "Turn ON customer search tracking? Searches and daily visits will be recorded (no names, IP addresses or browser details)." : "Turn OFF customer search tracking? Nothing new will be recorded.")) return;
    setSaving(true);
    try {
      setSettings(await adminApi("/api/admin/analytics/settings", { method: "PUT", body: JSON.stringify({ searchTracking: next }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  const preset = (days: number) => { setFrom(daysAgo(days - 1)); setTo(istDay()); setPage(1); };

  return (
    <div>
      <h1 style={ui.h1}>Customer analytics</h1>
      <p style={ui.sub}>Website searches, visitors, bookings and revenue. Dates are India time. Money is shown per currency.</p>

      <div style={{ ...ui.card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ ...ui.text, fontWeight: 700 }}>Search tracking:</span>
        <span style={{ color: settings?.searchTracking ? "#4ade80" : "#f87171", fontWeight: 800, fontSize: 13 }}>{settings ? (settings.searchTracking ? "ON" : "OFF") : "…"}</span>
        <span style={ui.muted}>{settings?.searchTracking ? "Customer searches and daily visits are being recorded." : "Nothing new is recorded. Bookings and revenue reports still work."}</span>
        {fullAdmin && settings && (
          <button type="button" style={{ ...(settings.searchTracking ? ui.ghost : ui.btn), marginLeft: "auto" }} disabled={saving} onClick={toggleTracking}>
            {saving ? "Saving…" : settings.searchTracking ? "Turn off" : "Turn on"}
          </button>
        )}
      </div>

      <div style={{ ...ui.card, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[["Today", 1], ["7 days", 7], ["30 days", 30], ["90 days", 90]].map(([l, d]) => (
            <button key={l} type="button" style={ui.chip(from === daysAgo(Number(d) - 1) && to === istDay())} onClick={() => preset(Number(d))}>{l}</button>
          ))}
        </div>
        <label style={ui.label}>From<input type="date" style={ui.input} value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
        <label style={ui.label}>To<input type="date" style={ui.input} value={to} min={from} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
        <label style={ui.label}>Device
          <select style={ui.input} value={device} onChange={(e) => { setDevice(e.target.value); setPage(1); }}>
            <option value="">All</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option><option value="desktop">Desktop</option>
          </select>
        </label>
        <label style={ui.label}>Country<input style={{ ...ui.input, width: 70 }} maxLength={2} placeholder="IN" value={country} onChange={(e) => { setCountry(e.target.value.toUpperCase()); setPage(1); }} /></label>
        <label style={ui.label}>Customers
          <select style={ui.input} value={audience} onChange={(e) => { setAudience(e.target.value); setPage(1); }}>
            <option value="">All</option><option value="guest">Guests</option><option value="customer">Signed in</option>
          </select>
        </label>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }} role="tablist">
        {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} style={ui.chip(tab === t.key)} onClick={() => { setTab(t.key); setPage(1); setData(null); }}>{t.label}</button>)}
      </div>

      {error && <div style={ui.err}>{error}</div>}
      {loading && !data && <p style={ui.muted}>Loading…</p>}

      {data && tab === "overview" && <Overview d={data} trend={trendRows} interval={interval} setInterval={setInterval} />}
      {data && tab === "sectors" && (
        <Section title="Sectors" onCsv={() => download("sectors")} note="Paid bookings and revenue come from bookings with a successful payment. 'All paid website bookings' also counts bookings made before tracking started.">
          <Table rows={data.rows} cols={[
            ["Route", (r) => `${r.origin} → ${r.destination}`], ["Searches", (r) => num(r.searches)], ["Searchers", (r) => num(r.searchers)],
            ["Fares selected", (r) => num(r.fareSelected)], ["Bookings", (r) => num(r.bookingsCreated)], ["Paid", (r) => num(r.paidBookings)],
            ["Conversion", (r) => pct(r.conversionPct)], ["Abandoned", (r) => num(r.abandoned)], ["No availability", (r) => num(r.noAvailability)],
            ["Revenue", (r) => Object.entries(r.revenue ?? {}).map(([c, v]) => money(v as number, c)).join(" · ") || "—"],
            ["Avg lowest fare", (r) => (r.avgLowestInr === null ? "—" : money(r.avgLowestInr))], ["All paid website bookings", (r) => num(r.websitePaidBookings)],
          ]} />
        </Section>
      )}
      {data && tab === "airports" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
          <Section title="Departure airports" onCsv={() => download("airports", { list: "departures" })}>
            <Table rows={data.departures} cols={[["Airport", (r) => r.airport], ["Searches", (r) => num(r.searches)], ["Searchers", (r) => num(r.searchers)], ["Paid", (r) => num(r.paidBookings)]]} />
          </Section>
          <Section title="Destinations" onCsv={() => download("airports", { list: "destinations" })}>
            <Table rows={data.destinations} cols={[["Airport", (r) => r.airport], ["Searches", (r) => num(r.searches)], ["Searchers", (r) => num(r.searchers)], ["Paid", (r) => num(r.paidBookings)]]} />
          </Section>
        </div>
      )}
      {data && tab === "dates" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
          <Section title="Most searched travel dates" onCsv={() => download("dates", { list: "dates" })}>
            <Table rows={data.dates} cols={[["Departure", (r) => r.departureDate], ["Searches", (r) => num(r.searches)], ["Searchers", (r) => num(r.searchers)], ["Paid", (r) => num(r.paidBookings)], ["Avg lowest fare", (r) => (r.avgLowestInr === null ? "—" : money(r.avgLowestInr))]]} />
          </Section>
          <Section title="How far ahead people search" onCsv={() => download("dates", { list: "lead-time" })}>
            <Table rows={data.leadTime} cols={[["Searched ahead", (r) => r.bucket], ["Searches", (r) => num(r.searches)], ["Paid", (r) => num(r.paidBookings)]]} />
          </Section>
        </div>
      )}
      {data && tab === "searches" && (
        <Section title="Search history" onCsv={() => download("searches")}
          note={data.customerDetails ? "Customer names and contacts are shown because you have Bookings access." : "Customer names and contacts are hidden (needs Bookings access)."}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "flex-end" }}>
            <label style={ui.label}>Status
              <select style={ui.input} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                <option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label style={ui.label}>From airport<input style={{ ...ui.input, width: 80 }} maxLength={3} placeholder="CCJ" value={origin} onChange={(e) => { setOrigin(e.target.value.toUpperCase()); setPage(1); }} /></label>
            <label style={ui.label}>To airport<input style={{ ...ui.input, width: 80 }} maxLength={3} placeholder="DXB" value={destination} onChange={(e) => { setDestination(e.target.value.toUpperCase()); setPage(1); }} /></label>
          </div>
          <Table rows={data.rows} cols={[
            ["Searched", (r) => when(r.first_seen_at)], ["Route", (r) => `${r.origin} → ${r.destination}${r.trip_type === "ROUNDTRIP" ? " (return)" : r.trip_type === "MULTICITY" ? " (multi-city)" : ""}`],
            ["Travel", (r) => [r.departure_date, r.return_date].filter(Boolean).join(" – ")],
            ["Passengers", (r) => `${r.adults}A${r.children ? ` ${r.children}C` : ""}${r.infants ? ` ${r.infants}I` : ""}`],
            ["Lowest fare", (r) => (r.lowest_fare === null ? "—" : money(r.lowest_fare, r.currency))], ["Repeats", (r) => num(r.repeat_count)],
            ["Status", (r) => <span style={{ color: STATUS_COLOR[r.status], fontWeight: 700 }}>{STATUS_LABEL[r.status] ?? r.status}</span>],
            ["Booking", (r) => (r.booking_id ? <a href={`/bookings/${r.booking_id}`} style={{ color: "#60a5fa" }}>{String(r.booking_id).slice(0, 8)}</a> : "—")],
            ["Device", (r) => r.device ?? "—"], ["Country", (r) => r.country ?? "—"],
            ["Customer", (r) => (data.customerDetails && r.signed_in ? [r.customer_name, r.customer_email, r.customer_phone].filter(Boolean).join(" · ") : r.signed_in ? "Signed in" : `Guest ${r.visitor ?? ""}`)],
          ]} />
          <Pager page={page} hasMore={data.hasMore} setPage={setPage} />
        </Section>
      )}
      {data && tab === "abandoned" && (
        <Section title="Abandoned checkouts" onCsv={() => download("abandoned")}
          note="Website bookings created more than 24 hours ago and never paid, unless the same customer paid for the same trip later.">
          <Table rows={data.rows} cols={[
            ["Created", (r) => when(r.created_at)], ["Booking", (r) => <a href={`/bookings/${r.booking_id}`} style={{ color: "#60a5fa" }}>{String(r.booking_id).slice(0, 8)}</a>],
            ["Route", (r) => `${r.origin} → ${r.destination}`], ["Departure", (r) => r.departure_date], ["Amount", (r) => money(r.total_amount, r.currency)],
            ["Status", (r) => r.status], ["Supplier", (r) => r.supplier],
            ["Customer", (r) => (data.customerDetails ? [r.customer_name, r.contact_email, r.contact_phone].filter(Boolean).join(" · ") : r.signed_in ? "Signed in" : "Guest")],
          ]} />
          <Pager page={page} hasMore={data.hasMore} setPage={setPage} />
        </Section>
      )}
      {data && tab === "revenue" && (
        <>
          <Section title="Revenue by period" onCsv={() => download("revenue", { list: "period" })}
            note="Paid website bookings. Revenue counts bookings still confirmed / ticketed; cancelled-after-payment and refunds are shown separately."
            extra={<IntervalPicker interval={interval} setInterval={setInterval} />}>
            <Table rows={data.byPeriod} cols={[["Period", (r) => r.period], ["Currency", (r) => r.currency], ["Paid bookings", (r) => num(r.paidBookings)],
              ["Revenue", (r) => money(r.revenue, r.currency)], ["Markup", (r) => money(r.markup, r.currency)], ["Cancelled after payment", (r) => num(r.cancelledAfterPayment)], ["Refunded", (r) => money(r.refunded, r.currency)]]} />
          </Section>
          <Section title="Revenue by sector" onCsv={() => download("revenue", { list: "sector" })}>
            <Table rows={data.bySector} cols={[["Route", (r) => `${r.origin} → ${r.destination}`], ["Currency", (r) => r.currency], ["Paid bookings", (r) => num(r.paidBookings)], ["Revenue", (r) => money(r.revenue, r.currency)]]} />
          </Section>
        </>
      )}
    </div>
  );
}

function Overview({ d, trend, interval, setInterval }: { d: any; trend: any[]; interval: "day" | "week" | "month"; setInterval: (v: "day" | "week" | "month") => void }) {
  const kpis: [string, string, string?][] = [
    ["Visitors", num(d.visitors)], ["Searches", num(d.searches)], ["Unique searchers", num(d.searchers)],
    ["No availability", num(d.noAvailability), "No results or a supplier error"], ["Fares selected", num(d.fareSelected), "Booking page opened"],
    ["Bookings created", num(d.bookingsCreated)], ["Paid bookings", num(d.paidBookings), "From these searches"],
    ["Conversion", pct(d.conversionPct), "Paid bookings ÷ searches"], ["Abandoned searches", num(d.abandonedSearches), "Results, nothing booked in 24 h"],
    ["Abandoned checkouts", num(d.website?.abandonedCheckouts)],
    ["Active fare alerts", d.activeFareAlerts ? `${num(d.activeFareAlerts.count)}${d.activeFareAlerts.capped ? "+" : ""}` : "—"],
  ];
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
        {kpis.map(([label, value, hint]) => (
          <div key={label} style={{ ...ui.card, marginBottom: 0 }}>
            <div style={{ ...ui.muted, textTransform: "uppercase", fontWeight: 700, fontSize: 11 }}>{label}</div>
            <div style={{ color: "#f1f5f9", fontSize: 24, fontWeight: 800, marginTop: 4 }}>{value}</div>
            {hint && <div style={{ ...ui.muted, marginTop: 2 }}>{hint}</div>}
          </div>
        ))}
      </div>
      <Section title="Website bookings & revenue (all website bookings in this period)">
        <Table rows={d.website?.byCurrency ?? []} cols={[["Currency", (r) => r.currency], ["Created", (r) => num(r.created)], ["Paid", (r) => num(r.paid)],
          ["Revenue", (r) => money(r.revenue, r.currency)], ["Markup", (r) => money(r.markup, r.currency)], ["Cancelled after payment", (r) => num(r.cancelledAfterPayment)]]} />
      </Section>
      <Section title="Trend" extra={<IntervalPicker interval={interval} setInterval={setInterval} />}>
        <Table rows={trend} cols={[["Period", (r) => r.period], ["Visitors", (r) => num(r.visitors)], ["Searches", (r) => num(r.searches)],
          ["Searchers", (r) => num(r.searchers)], ["Paid bookings", (r) => num(r.paidBookings)], ["Abandoned", (r) => num(r.abandoned)]]} />
      </Section>
    </>
  );
}

function IntervalPicker({ interval, setInterval }: { interval: string; setInterval: (v: "day" | "week" | "month") => void }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {(["day", "week", "month"] as const).map((i) => <button key={i} type="button" style={ui.chip(interval === i)} onClick={() => setInterval(i)}>{i === "day" ? "Daily" : i === "week" ? "Weekly" : "Monthly"}</button>)}
    </div>
  );
}

function Section({ title, children, onCsv, note, extra }: { title: string; children: React.ReactNode; onCsv?: () => void; note?: string; extra?: React.ReactNode }) {
  return (
    <div style={ui.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <h2 style={{ ...ui.h2, margin: 0 }}>{title}</h2>
        {extra}
        {onCsv && <button type="button" style={{ ...ui.ghost, marginLeft: "auto" }} onClick={onCsv}>Export CSV</button>}
      </div>
      {note && <p style={{ ...ui.muted, marginBottom: 10 }}>{note}</p>}
      {children}
    </div>
  );
}

type Col = [string, (r: any) => React.ReactNode];
function Table({ rows, cols }: { rows: any[]; cols: Col[] }) {
  if (!rows?.length) return <p style={ui.muted}>Nothing in this period.</p>;
  const wrap: CSSProperties = { overflowX: "auto" };
  return (
    <div style={wrap}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{cols.map(([h]) => <th key={h} style={ui.th}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.id ?? r.booking_id ?? i}>{cols.map(([h, f]) => <td key={h} style={ui.td}>{f(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Pager({ page, hasMore, setPage }: { page: number; hasMore: boolean; setPage: (n: number) => void }) {
  if (page === 1 && !hasMore) return null;
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
      <button type="button" style={ui.ghost} disabled={page === 1} onClick={() => setPage(page - 1)}>← Previous</button>
      <span style={ui.muted}>Page {page}</span>
      <button type="button" style={ui.ghost} disabled={!hasMore} onClick={() => setPage(page + 1)}>Next →</button>
    </div>
  );
}
