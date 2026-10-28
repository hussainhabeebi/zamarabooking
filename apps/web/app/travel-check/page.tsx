"use client";

// Baggage checker — static rules per airline (no AI). The visa section was removed;
// its data is still in lib/travel-rules.
// Opened from search results with ?airline=6E&from=COK&to=DXB, or on its own.

import { useEffect, useState } from "react";
import { AIRLINES, AIRPORT_COUNTRY, GENERAL_BAGGAGE_RULES } from "../lib/travel-rules";

export default function TravelCheckPage() {
  const [airline, setAirline] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const a = (q.get("airline") ?? "").toUpperCase();
    if (AIRLINES.some((x) => x.code === a)) setAirline(a);
    const to = (q.get("to") ?? "").toUpperCase();
    setFrom((q.get("from") ?? "").toUpperCase());
    setTo(to);
  }, []);

  const bag = AIRLINES.find((a) => a.code === airline);
  const domestic = AIRPORT_COUNTRY[from] === "IN" && AIRPORT_COUNTRY[to] === "IN";

  return (
    <main className="page-container tc">
      <style>{css}</style>
      <h1>Baggage checker</h1>
      <p className="tc-lead">Quick guidance before you book. Rules change and vary by fare — always confirm with the airline before you travel.</p>

      <section className="tc-card">
        <h2>🧳 Baggage allowance</h2>
        <label className="tc-field">
          <span>Airline</span>
          <select value={airline} onChange={(e) => setAirline(e.target.value)}>
            <option value="">Choose an airline</option>
            {AIRLINES.map((a) => <option key={a.code} value={a.code}>{a.name} ({a.code})</option>)}
          </select>
        </label>
        {bag && (
          <dl className="tc-facts">
            <div><dt>Cabin</dt><dd>{bag.cabin}</dd></div>
            {bag.domestic && <div className={domestic ? "tc-hit" : ""}><dt>Within India</dt><dd>{bag.domestic}</dd></div>}
            <div className={!domestic ? "tc-hit" : ""}><dt>International</dt><dd>{bag.international}</dd></div>
            {bag.notes && <div><dt>Tip</dt><dd>{bag.notes}</dd></div>}
          </dl>
        )}
        <ul className="tc-list">{GENERAL_BAGGAGE_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
      </section>

      <p className="tc-note">This is general information. The airline&apos;s own baggage rules for your fare always apply.</p>
      <a className="tc-back" href="/">← Search flights</a>
    </main>
  );
}

const css = `.tc{max-width:760px;padding:28px 16px 48px}.tc h1{margin:0 0 6px;font-size:26px}.tc-lead{color:#64748b;margin:0 0 18px}
.tc-card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:18px;margin-bottom:16px}.tc-card h2{margin:0 0 12px;font-size:18px}
.tc-field{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:700;color:#475569;margin-bottom:12px}
.tc-field select{font-size:15px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;max-width:100%}
.tc-facts{display:grid;gap:8px;margin:0 0 12px}.tc-facts div{display:grid;grid-template-columns:120px 1fr;gap:8px;padding:10px 12px;border-radius:10px;background:#f8fafc}
.tc-facts .tc-hit{background:#fef2f2;outline:1px solid #fecaca}.tc-facts dt{font-weight:800;color:#334155}.tc-facts dd{margin:0}
.tc-list{margin:8px 0 0;padding-left:18px;color:#334155;font-size:14px;line-height:1.55}
.tc-note{font-size:12px;color:#64748b}.tc-back{color:#0D4B96;font-weight:700;text-decoration:none}
@media(max-width:520px){.tc-facts div{grid-template-columns:1fr}}`;
