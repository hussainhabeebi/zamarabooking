"use client";

// Above one-way results: a price calendar (cheapest fare per adult seen on
// nearby days, from recent searches), a "notify me when it drops" alert and a
// link to the baggage & visa checker.

import { FormEvent, useEffect, useMemo, useState } from "react";
import { convertInr, type FxRates } from "../lib/fx";

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const HEADERS = { "x-tenant-slug": "poomas" };

type Day = { date: string; price: number; seenAt: string };

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// `currency` is the fares' own currency (what the calendar and alerts store);
// prices are shown in `displayCurrency`, converted like the fare cards.
export function FareTools({ origin, destination, departureDate, currency, displayCurrency, rates, cheapest, airline, query }: {
  origin: string; destination: string; departureDate: string; currency: string;
  displayCurrency?: string | null; rates?: FxRates; cheapest: number | null; airline?: string; query: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const start = addDays(departureDate, -3) < today ? today : addDays(departureDate, -3);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(start, i)), [start]);
  const [prices, setPrices] = useState<Record<string, Day>>({});

  useEffect(() => {
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return;
    const months = [...new Set(days.map((d) => d.slice(0, 7)))];
    Promise.all(months.map((month) =>
      fetch(`${API}/api/fares/calendar?${new URLSearchParams({ origin, destination, month, currency })}`, { headers: HEADERS })
        .then((r) => (r.ok ? r.json() : { days: [] })).then((d) => (d.days ?? []) as Day[]).catch(() => [] as Day[]),
    )).then((all) => setPrices(Object.fromEntries(all.flat().map((d) => [d.date, d]))));
  }, [origin, destination, currency, days]);

  const known = days.map((d) => prices[d]?.price).filter((p): p is number => typeof p === "number");
  const low = known.length ? Math.min(...known) : null;
  const rate = currency === "INR" && displayCurrency && displayCurrency !== "INR" ? rates?.[displayCurrency as keyof FxRates] : null;
  const shownCurrency = rate && rate > 0 ? displayCurrency! : currency;
  const toShown = (n: number) => (shownCurrency === currency ? n : convertInr(n, shownCurrency, rates) ?? n);
  const toFare = (n: number) => (shownCurrency === currency ? n : Math.round(n * rate!));
  const fmt = (n: number) => {
    const v = toShown(n);
    const digits = shownCurrency === currency ? 0 : v < 1000 ? 2 : 0;
    try { return new Intl.NumberFormat(shownCurrency === "INR" ? "en-IN" : "en-US", { style: "currency", currency: shownCurrency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v); } catch { return `${shownCurrency} ${v}`; }
  };
  const href = (date: string) => { const q = new URLSearchParams(query); q.set("departureDate", date); return `/search?${q}`; };

  return (
    <div className="fare-tools">
      <style>{css}</style>
      {known.length > 0 && (
        <div className="ft-cal" aria-label="Prices on nearby dates">
          <div className="ft-cal-head"><b>📅 Price calendar</b><small>Lowest fare per adult seen recently · prices change</small></div>
          <div className="ft-cal-strip">
            {days.map((d) => {
              const p = prices[d];
              const dt = new Date(`${d}T00:00:00Z`);
              const cls = ["ft-day", d === departureDate ? "on" : "", p && p.price === low ? "low" : ""].join(" ");
              return (
                <a key={d} className={cls} href={href(d)} aria-current={d === departureDate ? "date" : undefined}>
                  <span>{dt.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" })} {dt.getUTCDate()}</span>
                  <strong>{p ? fmt(p.price) : "—"}</strong>
                </a>
              );
            })}
          </div>
        </div>
      )}
      <div className="ft-actions">
        <PriceAlert origin={origin} destination={destination} date={departureDate} currency={currency} shownCurrency={shownCurrency} cheapest={cheapest} fmt={fmt} toShown={toShown} toFare={toFare} />
        <a className="ft-link" href={`/travel-check?${new URLSearchParams({ from: origin, to: destination, ...(airline ? { airline } : {}) })}`}>🧳 Baggage &amp; visa check</a>
      </div>
    </div>
  );
}

function PriceAlert({ origin, destination, date, currency, shownCurrency, cheapest, fmt, toShown, toFare }: {
  origin: string; destination: string; date: string; currency: string; shownCurrency: string; cheapest: number | null;
  fmt: (n: number) => string; toShown: (n: number) => number; toFare: (n: number) => number;
}) {
  const [open, setOpen] = useState(false);
  // The target is typed in the shown currency; the alert is stored in the fares' currency.
  const [target, setTarget] = useState(cheapest ? String(Math.floor(toShown(cheapest) * 0.95)) : "");
  useEffect(() => { if (cheapest) setTarget(String(Math.floor(toShown(cheapest) * 0.95))); }, [shownCurrency]); // eslint-disable-line react-hooks/exhaustive-deps
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { try { setContact(localStorage.getItem("fare_alert_contact") ?? ""); } catch {} }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = contact.trim();
    const isEmail = value.includes("@");
    if (!value) { setError("Add your email or WhatsApp number."); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch(`${API}/api/fares/alerts`, {
        method: "POST", headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ origin, destination, date, currency, targetPrice: toFare(Number(target)), ...(isEmail ? { email: value } : { phone: value }) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(typeof d.error === "string" ? d.error : "Couldn't create the alert."); return; }
      try { localStorage.setItem("fare_alert_contact", value); } catch {}
      setDone(d.message ?? "Alert created.");
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="ft-done" role="status">🔔 {done}</p>;
  if (!open) return <button type="button" className="ft-btn" onClick={() => setOpen(true)}>🔔 Alert me if the price drops</button>;
  return (
    <form className="ft-alert" onSubmit={submit}>
      <b>Price alert · {origin} → {destination}</b>
      <label>Tell me when it&apos;s at or under ({shownCurrency}, per adult)
        <input type="number" min={0.01} step="any" required value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" />
      </label>
      {cheapest && <small>Cheapest now: {fmt(cheapest)}</small>}
      <label>Email or WhatsApp number
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="you@email.com or +971 50 123 4567" autoComplete="email" />
      </label>
      {error && <small className="ft-err" role="alert">{error}</small>}
      <div className="ft-row">
        <button type="submit" className="ft-btn primary" disabled={busy || !(Number(target) > 0)}>{busy ? "Saving…" : "Create alert"}</button>
        <button type="button" className="ft-btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

const css = `.fare-tools{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
.ft-cal{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px}
.ft-cal-head{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;margin-bottom:8px;font-size:14px}.ft-cal-head small{color:#64748b;font-size:11px}
.ft-cal-strip{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}
.ft-day{flex:0 0 auto;min-width:74px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:7px 6px;border:1px solid #e2e8f0;border-radius:10px;text-decoration:none;color:#334155;font-size:11px}
.ft-day strong{font-size:13px;color:#0f172a}.ft-day.low{background:#f0fdf4;border-color:#86efac}.ft-day.low strong{color:#15803d}
.ft-day.on{border-color:#E31E24;box-shadow:0 0 0 1px #E31E24}
.ft-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
.ft-btn{background:#fff;border:1px solid #cbd5e1;border-radius:999px;padding:8px 14px;font-size:13px;font-weight:700;color:#0f172a;cursor:pointer}
.ft-btn.primary{background:#E31E24;border-color:#E31E24;color:#fff}.ft-btn:disabled{opacity:.6;cursor:default}
.ft-link{border:1px solid #cbd5e1;border-radius:999px;padding:8px 14px;font-size:13px;font-weight:700;color:#0f172a;text-decoration:none;background:#fff}
.ft-alert{flex:1 1 320px;display:flex;flex-direction:column;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;font-size:13px}
.ft-alert label{display:flex;flex-direction:column;gap:4px;font-weight:700;color:#475569}
.ft-alert input{font-size:15px;padding:9px 11px;border:1px solid #cbd5e1;border-radius:9px;max-width:100%}
.ft-alert small{color:#64748b}.ft-alert .ft-err{color:#b91c1c}.ft-row{display:flex;gap:8px}
.ft-done{margin:0;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:10px;padding:8px 12px;font-size:13px}`;
