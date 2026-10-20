"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

type Props = {
  origin: string;
  destination: string;
  departureDate: string;
  fares?: any[];
};

const AIRPORT_GROUPS = [
  [
    { code: "COK", city: "Kochi" },
    { code: "CCJ", city: "Kozhikode" },
    { code: "CNN", city: "Kannur" },
    { code: "TRV", city: "Thiruvananthapuram" },
  ],
  [
    { code: "DXB", city: "Dubai International" },
    { code: "DWC", city: "Dubai Al Maktoum" },
    { code: "SHJ", city: "Sharjah" },
    { code: "AUH", city: "Abu Dhabi" },
    { code: "RKT", city: "Ras Al Khaimah" },
    { code: "FJR", city: "Fujairah" },
    { code: "AAN", city: "Al Ain" },
  ],
];

function airportOptions(code: string) {
  return AIRPORT_GROUPS.find((group) => group.some((a) => a.code === code)) ?? [{ code, city: code }];
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function moveDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate(new Date());
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

const RESULT_FILTER_KEYS = ["stops", "depBand", "refundable", "baggage", "airlines"] as const;

const TIME_BANDS = [
  { label: "Early morning", range: "00–06", sub: "12am–6am" },
  { label: "Morning",       range: "06–12", sub: "6am–12pm" },
  { label: "Afternoon",     range: "12–18", sub: "12pm–6pm" },
  { label: "Evening",       range: "18–24", sub: "6pm–12am" },
];

export function ChangeDatesAction() {
  function focusDateControls() {
    if (window.matchMedia("(max-width: 900px)").matches) {
      window.dispatchEvent(new Event("flypoomas:open-date-filters"));
    } else {
      document.querySelector<HTMLButtonElement>("#flight-filter-panel .date-switcher button.active, #flight-filter-panel .date-switcher button")?.focus();
    }
  }

  return <button type="button" className="no-results-secondary" onClick={focusDateControls}>Change dates</button>;
}

export default function SearchResultControls({ origin, destination, departureDate, fares = [] }: Props) {
  const router = useRouter();
  const current = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentQuery = current.toString();
  const [pendingQuery, setPendingQuery] = useState<string | null>(null);
  const visible = useMemo(() => new URLSearchParams(pendingQuery ?? currentQuery), [pendingQuery, currentQuery]);
  const today = isoDate(new Date()); // Same UTC day boundary as the homepage search date input.
  const [windowStart, setWindowStart] = useState(() => {
    const centered = moveDate(departureDate, -2);
    return centered < isoDate(new Date()) ? isoDate(new Date()) : centered;
  });

  useEffect(() => { setPendingQuery(null); }, [currentQuery]);
  useEffect(() => {
    setWindowStart((start) => {
      if (departureDate >= start && departureDate <= moveDate(start, 4)) return start;
      const centered = moveDate(departureDate, -2);
      return centered < today ? today : centered;
    });
  }, [departureDate, today]);

  useEffect(() => {
    const openDates = () => setMobileOpen(true);
    window.addEventListener("flypoomas:open-date-filters", openDates);
    return () => window.removeEventListener("flypoomas:open-date-filters", openDates);
  }, []);

  useEffect(() => {
    if (mobileOpen) document.querySelector<HTMLButtonElement>("#flight-filter-panel .date-switcher button.active, #flight-filter-panel .date-switcher button")?.focus();
  }, [mobileOpen]);

  function update(updates: Record<string, string | null>) {
    const next = new URLSearchParams(pendingQuery ?? currentQuery);
    Object.entries(updates).forEach(([key, value]) => {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    });
    next.delete("all");
    setPendingQuery(next.toString());
    startTransition(() => router.push(`/search?${next.toString()}`));
  }

  function resetFilters() {
    if (RESULT_FILTER_KEYS.some((key) => visible.has(key))) {
      update(Object.fromEntries(RESULT_FILTER_KEYS.map((key) => [key, null])));
    }
  }

  const dates = [0, 1, 2, 3, 4].map((offset) => new Date(`${moveDate(windowStart, offset)}T12:00:00Z`));

  const stops       = visible.get("stops");
  const refundable  = visible.get("refundable") === "1";
  const baggage     = visible.get("baggage") === "1";
  const depBand     = visible.get("depBand");
  const airlines    = (visible.get("airlines") ?? "").split(",").filter(Boolean);

  // Derive unique airlines from fares
  const uniqueAirlines = useMemo(() => {
    const seen = new Map<string, { name: string; count: number }>();
    for (const f of fares) {
      if (!f.airlineName) continue;
      const existing = seen.get(f.airlineName);
      if (existing) existing.count++;
      else seen.set(f.airlineName, { name: f.airlineName, count: 1 });
    }
    return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  }, [fares]);

  function toggleAirline(name: string) {
    const next = airlines.includes(name) ? airlines.filter((a) => a !== name) : [...airlines, name];
    update({ airlines: next.length ? next.join(",") : null });
  }

  return (
    <>
    <button type="button" className="mobile-filter-toggle" aria-expanded={mobileOpen} aria-controls="flight-filter-panel" onClick={() => setMobileOpen(true)}>
      <span aria-hidden="true">☷</span> Filters
    </button>
    {mobileOpen && <button type="button" className="filter-backdrop" aria-label="Close filters" onClick={() => setMobileOpen(false)} />}
    <aside id="flight-filter-panel" className={`filter-sidebar${mobileOpen ? " open" : ""}`} aria-label="Flight filters">
      {/* Date strip */}
      <div className="filter-sidebar-title">
        <span>Filters</span>
        <div className="filter-sidebar-actions">
          <a href="#" onClick={(e) => { e.preventDefault(); resetFilters(); }}>Reset all</a>
          <button type="button" className="filter-close" aria-label="Close filters" onClick={() => setMobileOpen(false)}>×</button>
        </div>
      </div>

      {(isPending || pendingQuery !== null) && <div className="result-refresh" role="status"><span /> Updating flights…</div>}
      <div className="filter-section-label">Travel dates</div>
      <div className="date-navigation">
        <button type="button" className="date-range-arrow" aria-label="Previous travel dates" disabled={windowStart <= today} onClick={() => setWindowStart(moveDate(windowStart, -1))}>‹</button>
        <div className="date-switcher" aria-label="Choose departure date">
          {dates.map((date) => {
            const value = isoDate(date);
            const active = value === (visible.get("departureDate") ?? departureDate);
            return (
              <button key={value} type="button" className={active ? "active" : ""} aria-pressed={active} disabled={value < today} onClick={() => !active && update({ departureDate: value })}>
                <span>{date.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" })}</span>
                <strong>{date.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })}</strong>
              </button>
            );
          })}
        </div>
        <button type="button" className="date-range-arrow" aria-label="Next travel dates" onClick={() => setWindowStart(moveDate(windowStart, 1))}>›</button>
      </div>

      {/* Nearby airports */}
      <div className="filter-section">
        <div className="filter-section-label">Airports</div>
        <div className="result-tool-row" style={{ marginTop: 0 }}>
          <label className="airport-select">
            <span>From</span>
            <select value={origin} onChange={(e) => update({ origin: e.target.value })}>
              {airportOptions(origin).map((a) => <option key={a.code} value={a.code}>{a.city} ({a.code})</option>)}
            </select>
          </label>
          <button className="result-swap" type="button" aria-label="Swap airports" onClick={() => update({ origin: destination, destination: origin })}>⇄</button>
          <label className="airport-select">
            <span>To</span>
            <select value={destination} onChange={(e) => update({ destination: e.target.value })}>
              {airportOptions(destination).map((a) => <option key={a.code} value={a.code}>{a.city} ({a.code})</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* Stops */}
      <div className="filter-section">
        <div className="filter-section-label">Stops</div>
        <div className="stops-btn-row">
          {([{ label: "Any", val: null }, { label: "Nonstop", val: "0" }, { label: "1 stop", val: "1" }] as const).map(({ label, val }) => (
            <button
              key={label} type="button"
              className={`stops-btn${stops === val || (val === null && !stops) ? " active" : ""}`}
              onClick={() => update({ stops: val })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Departure time */}
      <div className="filter-section">
        <div className="filter-section-label">Departure time</div>
        <div className="time-bands">
          {TIME_BANDS.map((band) => (
            <button
              key={band.range} type="button"
              className={`time-band${depBand === band.range ? " active" : ""}`}
              onClick={() => update({ depBand: depBand === band.range ? null : band.range })}
            >
              <span className="time-band-title">{band.label}</span>
              {band.sub}
            </button>
          ))}
        </div>
      </div>

      {/* Fare options */}
      <div className="filter-section">
        <div className="filter-section-label">Fare options</div>
        <label className="filter-option">
          <input type="checkbox" checked={refundable} onChange={() => update({ refundable: refundable ? null : "1" })} />
          Refundable only
        </label>
        <label className="filter-option">
          <input type="checkbox" checked={baggage} onChange={() => update({ baggage: baggage ? null : "1" })} />
          Includes checked baggage
        </label>
      </div>

      {/* Airlines */}
      {uniqueAirlines.length > 0 && (
        <div className="filter-section">
          <div className="filter-section-label">Airlines</div>
          {uniqueAirlines.map(({ name, count }) => (
            <label key={name} className="filter-option">
              <input type="checkbox" checked={airlines.includes(name)} onChange={() => toggleAirline(name)} />
              {name}
              <span className="filter-option-badge">{count}</span>
            </label>
          ))}
        </div>
      )}

      <button type="button" className="filter-apply" onClick={() => setMobileOpen(false)}>Show flights</button>
    </aside>
    </>
  );
}
