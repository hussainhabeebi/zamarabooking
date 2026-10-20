"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { AiTripSearch, type AiTripFields } from "./AiTripSearch";
import { useRouter } from "next/navigation";
import { CURRENCY_EVENT, readPrefCurrency, savePrefCurrency } from "../lib/currency-pref";
import { CURRENCY_LIST, type DisplayCurrency } from "../lib/fx";

const AIRPORTS = [
  { code: "BOM", city: "Mumbai",        country: "IN" },
  { code: "DEL", city: "New Delhi",     country: "IN" },
  { code: "CCJ", city: "Kozhikode",     country: "IN" },
  { code: "COK", city: "Kochi",         country: "IN" },
  { code: "TRV", city: "Trivandrum",    country: "IN" },
  { code: "CNN", city: "Kannur",        country: "IN" },
  { code: "IXE", city: "Mangalore",     country: "IN" },
  { code: "MAA", city: "Chennai",       country: "IN" },
  { code: "BLR", city: "Bengaluru",     country: "IN" },
  { code: "HYD", city: "Hyderabad",     country: "IN" },
  { code: "AMD", city: "Ahmedabad",     country: "IN" },
  { code: "PNQ", city: "Pune",          country: "IN" },
  { code: "GOI", city: "Goa",           country: "IN" },
  { code: "CCU", city: "Kolkata",       country: "IN" },
  { code: "LKO", city: "Lucknow",       country: "IN" },
  { code: "IXJ", city: "Jammu",         country: "IN" },
  { code: "SXR", city: "Srinagar",      country: "IN" },
  { code: "ATQ", city: "Amritsar",      country: "IN" },
  { code: "IXC", city: "Chandigarh",    country: "IN" },
  { code: "DXB", city: "Dubai",         country: "AE" },
  { code: "AUH", city: "Abu Dhabi",     country: "AE" },
  { code: "SHJ", city: "Sharjah",       country: "AE" },
  { code: "RKT", city: "Ras Al Khaimah", country: "AE" },
  { code: "FJR", city: "Fujairah",      country: "AE" },
  { code: "AAN", city: "Al Ain",        country: "AE" },
  { code: "DWC", city: "Dubai Al Maktoum", country: "AE" },
  { code: "DOH", city: "Doha",          country: "QA" },
  { code: "MCT", city: "Muscat",        country: "OM" },
  { code: "SLL", city: "Salalah",       country: "OM" },
  { code: "BAH", city: "Bahrain",       country: "BH" },
  { code: "KWI", city: "Kuwait City",   country: "KW" },
  { code: "RUH", city: "Riyadh",        country: "SA" },
  { code: "JED", city: "Jeddah",        country: "SA" },
  { code: "DMM", city: "Dammam",        country: "SA" },
  { code: "MED", city: "Madinah",       country: "SA" },
  { code: "LHR", city: "London",        country: "GB" },
  { code: "CDG", city: "Paris",         country: "FR" },
  { code: "FRA", city: "Frankfurt",     country: "DE" },
  { code: "SIN", city: "Singapore",     country: "SG" },
  { code: "KUL", city: "Kuala Lumpur",  country: "MY" },
  { code: "BKK", city: "Bangkok",       country: "TH" },
  { code: "HKG", city: "Hong Kong",     country: "HK" },
  { code: "NRT", city: "Tokyo",         country: "JP" },
  { code: "JFK", city: "New York",      country: "US" },
  { code: "LAX", city: "Los Angeles",   country: "US" },
  { code: "YYZ", city: "Toronto",       country: "CA" },
  { code: "SYD", city: "Sydney",        country: "AU" },
  { code: "MEL", city: "Melbourne",     country: "AU" },
];

const CABIN_CLASSES = ["Economy", "Premium Economy", "Business", "First"] as const;
const CABIN_MAP: Record<string, string> = {
  "Economy": "ECONOMY", "Premium Economy": "PREMIUM_ECONOMY",
  "Business": "BUSINESS", "First": "FIRST",
};

// INR and AED as quick picks; the other GCC currencies and USD under "More".
const CURRENCIES = CURRENCY_LIST;
const QUICK_CURRENCIES = CURRENCY_LIST.filter((c) => c.code === "INR" || c.code === "AED");
const MORE_CURRENCIES = CURRENCY_LIST.filter((c) => c.code !== "INR" && c.code !== "AED");
type CurrencyCode = DisplayCurrency;

type Airport = typeof AIRPORTS[number];
type TripType = "One Way" | "Round Trip" | "Multi-city";

// TripJack passenger fare types (searchModifiers.pfts).
const SPECIAL_FARES = ["Regular", "Student", "Senior Citizen"] as const;
const FARE_TYPE_PARAM: Record<string, string> = { Regular: "REGULAR", Student: "STUDENT", "Senior Citizen": "SENIOR_CITIZEN" };
type ExtraLeg = { origin: Airport | null; dest: Airport | null; date: string };
type SpecialFare = typeof SPECIAL_FARES[number];

function AirportInput({
  id, label, value, onChange, placeholder, tabIndex,
}: {
  id: string; label: string; value: Airport | null;
  onChange: (a: Airport) => void; placeholder: string; tabIndex?: number;
}) {
  const displayVal = value ? `${value.city} (${value.code})` : "";
  const [query, setQuery] = useState(displayVal);
  const [open,  setOpen]  = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(value ? `${value.city} (${value.code})` : "");
  }, [value]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value ? `${value.city} (${value.code})` : "");
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [value]);

  const q = query.toLowerCase().trim();
  const matches = q
    ? AIRPORTS.filter(
        (a) =>
          a.code.toLowerCase().startsWith(q) ||
          a.city.toLowerCase().includes(q)
      ).slice(0, 8)
    : AIRPORTS.slice(0, 8);

  function pick(a: Airport) {
    onChange(a);
    setQuery(`${a.city} (${a.code})`);
    setOpen(false);
  }

  return (
    <div className="airport-wrap" ref={wrapRef}>
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        className="search-input"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        inputMode="text"
        tabIndex={tabIndex}
        onFocus={() => { setQuery(""); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        required
      />
      {open && matches.length > 0 && (
        <ul className="airport-dropdown">
          {matches.map((a) => (
            <li
              key={a.code}
              onMouseDown={(e) => { e.preventDefault(); pick(a); }}
              onTouchEnd={(e) => { e.preventDefault(); pick(a); }}
            >
              <span className="ap-code">{a.code}</span>
              <span className="ap-city">{a.city}</span>
              <span className="ap-flag">
                {String.fromCodePoint(
                  ...[...a.country].map((c) => 0x1F1A5 + c.charCodeAt(0))
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SearchWidget() {
  const router = useRouter();
  const [tripType,   setTripType]   = useState<TripType>("One Way");
  const [origin,     setOrigin]     = useState<Airport | null>(null);
  const [dest,       setDest]       = useState<Airport | null>(null);
  const [departDate, setDepartDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [adults,     setAdults]     = useState(1);
  const [children,   setChildren]   = useState(0);
  const [infants,    setInfants]    = useState(0);
  const [paxOpen,    setPaxOpen]    = useState(false);
  const paxRef = useRef<HTMLDivElement>(null);
  const [cabinClass,    setCabinClass]    = useState<(typeof CABIN_CLASSES)[number]>("Economy");
  const [currency,      setCurrencyState] = useState<CurrencyCode>("INR");
  const [searching,     setSearching]     = useState(false);
  const [searchStage,   setSearchStage]   = useState(0);
  const [directOnly,    setDirectOnly]    = useState(false);
  const [specialFare,   setSpecialFare]   = useState<SpecialFare>("Regular");
  // Multi-city: legs after the first (2–6 legs in total).
  const [extraLegs,     setExtraLegs]     = useState<ExtraLeg[]>([{ origin: null, dest: null, date: "" }]);
  const updLeg = (i: number, patch: Partial<ExtraLeg>) => setExtraLegs((ls) => ls.map((l, n) => n === i ? { ...l, ...patch } : l));

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (paxRef.current && !paxRef.current.contains(e.target as Node)) setPaxOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const SEARCH_STAGES = ["Checking live fares", "Comparing airlines", "Finding your best options"];

  // Plain-language search fills the regular form; its result-page preferences
  // (sort / refundable / baggage) ride along with the next search.
  const formRef = useRef<HTMLFormElement>(null);
  const [aiPrefs, setAiPrefs] = useState<Record<string, string>>({});
  function applyAi(f: AiTripFields) {
    const toAirport = (p: { code: string; city: string } | null): Airport | null =>
      p ? (AIRPORTS.find((a) => a.code === p.code) ?? { code: p.code, city: p.city, country: "" }) : null;
    setTripType(f.tripType === "ROUNDTRIP" ? "Round Trip" : "One Way");
    if (f.origin) setOrigin(toAirport(f.origin));
    if (f.destination) setDest(toAirport(f.destination));
    if (f.departureDate) setDepartDate(f.departureDate);
    setReturnDate(f.returnDate ?? "");
    setAdults(f.adults); setChildren(f.children); setInfants(f.infants);
    setCabinClass(({ ECONOMY: "Economy", PREMIUM_ECONOMY: "Premium Economy", BUSINESS: "Business", FIRST: "First" } as const)[f.cabinClass]);
    setSpecialFare(f.fareType === "STUDENT" ? "Student" : f.fareType === "SENIOR_CITIZEN" ? "Senior Citizen" : "Regular");
    setDirectOnly(f.directOnly);
    if (f.currency) setCurrency(f.currency);
    setAiPrefs({
      ...(f.sort !== "best" ? { sort: f.sort, all: "1" } : {}),
      ...(f.refundableOnly ? { refundable: "1" } : {}),
      ...(f.withBaggage ? { baggage: "1" } : {}),
    });
  }

  useEffect(() => {
    if (!searching) { setSearchStage(0); return; }
    const timer = window.setInterval(() => setSearchStage((s) => Math.min(s + 1, SEARCH_STAGES.length - 1)), 1600);
    return () => window.clearInterval(timer);
  }, [searching]);

  // One currency for the whole visit (and the signed-in account): restore it and follow changes made elsewhere.
  useEffect(() => {
    const saved = readPrefCurrency();
    if (saved && CURRENCIES.some((c) => c.code === saved)) setCurrencyState(saved);
    const onChange = (e: Event) => {
      const code = (e as CustomEvent).detail;
      if (CURRENCIES.some((c) => c.code === code)) setCurrencyState(code);
    };
    window.addEventListener(CURRENCY_EVENT, onChange);
    return () => window.removeEventListener(CURRENCY_EVENT, onChange);
  }, []);

  function setCurrency(code: CurrencyCode) {
    setCurrencyState(code);
    savePrefCurrency(code);
  }

  function swap() {
    setOrigin(dest);
    setDest(origin);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!origin || !dest) return;
    const multi = tripType === "Multi-city";
    if (multi && extraLegs.some((l) => !l.origin || !l.dest || !l.date)) return;
    const params = new URLSearchParams({
      origin:        origin.code,
      destination:   multi ? extraLegs[extraLegs.length - 1].dest!.code : dest.code,
      departureDate: departDate,
      adults:        String(adults),
      children:      String(children),
      infants:       String(infants),
      cabinClass:    CABIN_MAP[cabinClass] ?? "ECONOMY",
      tripType:      multi ? "MULTICITY" : tripType === "Round Trip" ? "ROUNDTRIP" : "ONEWAY",
      currency,
      ...(FARE_TYPE_PARAM[specialFare] !== "REGULAR" ? { fareType: FARE_TYPE_PARAM[specialFare] } : {}),
      ...(directOnly ? { stops: "0" } : {}),
      ...aiPrefs,
      ...(tripType === "Round Trip" && returnDate ? { returnDate } : {}),
      // legs=DEL-BOM-2026-10-01,BOM-GOI-2026-10-05
      ...(multi ? { legs: [`${origin.code}-${dest.code}-${departDate}`, ...extraLegs.map((l) => `${l.origin!.code}-${l.dest!.code}-${l.date}`)].join(",") } : {}),
    });
    // Round trips and multi-city pick one fare per leg (or a combined fare).
    const url = `${tripType === "One Way" ? "/search" : "/search/journey"}?${params.toString()}`;
    setSearching(true);
    router.prefetch(url);
    // Give mobile Safari one frame to paint the loading state before navigation.
    window.requestAnimationFrame(() => router.push(url));
  }

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="search-widget">
      <AiTripSearch onApply={applyAi} onSearchNow={() => formRef.current?.requestSubmit()} />
      {/* Top bar: trip type + passengers */}
      <div className="trip-tabs">
        {(["One Way", "Round Trip", "Multi-city"] as TripType[]).map((t) => (
          <button
            key={t} type="button"
            onClick={() => setTripType(t)}
            className={t === tripType ? "trip-tab trip-tab-active" : "trip-tab trip-tab-inactive"}
          >
            {t}
          </button>
        ))}
        <div ref={paxRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="passengers-select"
            onClick={() => setPaxOpen((v) => !v)}
            aria-label="Passengers"
            style={{ cursor: "pointer", textAlign: "left" }}
          >
            {adults + children + infants} Pax {children + infants > 0 ? `· ${adults}A${children > 0 ? ` ${children}C` : ""}${infants > 0 ? ` ${infants}I` : ""}` : adults === 1 ? "Adult" : "Adults"}
          </button>
          {paxOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 50, background: "#fff", border: "1px solid #d0d5dd", borderRadius: 14, padding: "14px 16px", minWidth: 220, boxShadow: "0 8px 24px rgba(0,0,0,.12)" }}>
              {([
                // Airline rules: max 9 seats (adults + children); infants sit on an adult's lap, 1 per adult.
                { label: "Adults", sub: "12+ years", val: adults, set: (n: number) => { setAdults(n); setInfants((i) => Math.min(i, n)); }, min: 1, max: 9 - children },
                { label: "Children", sub: "2–11 years", val: children, set: setChildren, min: 0, max: Math.min(6, 9 - adults) },
                { label: "Infants", sub: "Under 2 · 1 per adult", val: infants, set: setInfants, min: 0, max: Math.min(4, adults) },
              ] as const).map(({ label, sub, val, set, min, max }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: label !== "Infants" ? "1px solid #f2f4f7" : "none" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
                    <div style={{ fontSize: 12, color: "#667085" }}>{sub}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button type="button" onClick={() => (set as (n: number) => void)(Math.max(min, val - 1))} disabled={val <= min} style={{ width: 32, height: 32, borderRadius: "50%", border: "1px solid #d0d5dd", background: val <= min ? "#f9fafb" : "#fff", fontWeight: 800, fontSize: 18, cursor: val <= min ? "default" : "pointer", color: val <= min ? "#d0d5dd" : "#111" }}>−</button>
                    <span style={{ minWidth: 18, textAlign: "center", fontWeight: 700 }}>{val}</span>
                    <button type="button" onClick={() => (set as (n: number) => void)(Math.min(max, val + 1))} disabled={val >= max} style={{ width: 32, height: 32, borderRadius: "50%", border: "1px solid #d0d5dd", background: val >= max ? "#f9fafb" : "#fff", fontWeight: 800, fontSize: 18, cursor: val >= max ? "default" : "pointer", color: val >= max ? "#d0d5dd" : "#111" }}>+</button>
                  </div>
                </div>
              ))}
              <button type="button" onClick={() => setPaxOpen(false)} style={{ marginTop: 12, width: "100%", height: 40, borderRadius: 10, border: "none", background: "#0f172a", color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>Done</button>
            </div>
          )}
        </div>

        {/* Currency selector */}
        <div className="currency-pills" role="group" aria-label="Currency">
          {QUICK_CURRENCIES.map((cur) => (
            <button
              key={cur.code}
              type="button"
              className={currency === cur.code ? "currency-pill currency-pill-active" : "currency-pill"}
              onClick={() => setCurrency(cur.code)}
              aria-pressed={currency === cur.code}
            >
              {cur.code === "INR" ? "₹ INR" : cur.code}
            </button>
          ))}
          {(() => {
            const inMore = MORE_CURRENCIES.some((c) => c.code === currency);
            return (
              <select
                className={inMore ? "currency-pill currency-more currency-pill-active" : "currency-pill currency-more"}
                value={inMore ? currency : ""}
                onChange={(e) => { const c = MORE_CURRENCIES.find((m) => m.code === e.target.value); if (c) setCurrency(c.code); }}
                aria-label="More currencies"
              >
                <option value="" disabled>More</option>
                {MORE_CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
              </select>
            );
          })()}
        </div>
      </div>

      <form ref={formRef} onSubmit={handleSearch} aria-busy={searching}>
        <div className={tripType === "Multi-city" ? "sw-grid sw-grid-multicity" : "sw-grid"}>
          {tripType === "Multi-city" && <div className="sw-flight-label">Flight 1</div>}
          {/* Route row: FROM ⇄ TO */}
          <div className="sw-route-row">
            <AirportInput
              id="sw-origin" label="From" value={origin}
              onChange={setOrigin} placeholder="City or airport" tabIndex={1}
            />
            <button type="button" className="swap-btn" onClick={swap} aria-label="Swap airports">
              ⇄
            </button>
            <AirportInput
              id="sw-dest" label="To" value={dest}
              onChange={setDest} placeholder="City or airport" tabIndex={2}
            />
          </div>

          {/* Extras row: DEPART + RETURN/CLASS */}
          <div className="sw-extras-row">
            <div className="search-field">
              <label htmlFor="sw-depart">Depart</label>
              <input
                id="sw-depart" className="search-input" type="date"
                value={departDate} onChange={(e) => setDepartDate(e.target.value)}
                required min={today} tabIndex={3}
              />
            </div>

            {tripType === "Round Trip" ? (
              <div className="search-field">
                <label htmlFor="sw-return">Return</label>
                <input
                  id="sw-return" className="search-input" type="date"
                  value={returnDate} onChange={(e) => setReturnDate(e.target.value)}
                  required min={departDate || today} tabIndex={4}
                />
              </div>
            ) : (
              <div className="search-field">
                <label htmlFor="sw-class">Class</label>
                <select
                  id="sw-class" className="search-input" value={cabinClass}
                  onChange={(e) => setCabinClass(e.target.value as typeof cabinClass)}
                  tabIndex={4}
                >
                  {CABIN_CLASSES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}
          </div>

          {tripType === "Multi-city" && (
            <div className="sw-multicity">
              {extraLegs.map((leg, i) => (
                <div key={i} className="sw-route-row sw-leg-row">
                  <div className="sw-leg-heading">
                    <span className="sw-flight-label">Flight {i + 2}</span>
                    {extraLegs.length > 1 && (
                      <button type="button" className="sw-leg-remove" aria-label={`Remove flight ${i + 2}`}
                        onClick={() => setExtraLegs((ls) => ls.filter((_, n) => n !== i))}>✕</button>
                    )}
                  </div>
                  <AirportInput id={`sw-leg-${i}-from`} label="From" value={leg.origin}
                    onChange={(a) => updLeg(i, { origin: a })} placeholder="City or airport" />
                  <span className="sw-leg-direction" aria-hidden="true">→</span>
                  <AirportInput id={`sw-leg-${i}-to`} label="To" value={leg.dest}
                    onChange={(a) => updLeg(i, { dest: a })} placeholder="City or airport" />
                  <div className="search-field">
                    <label htmlFor={`sw-leg-${i}-date`}>Depart</label>
                    <input id={`sw-leg-${i}-date`} className="search-input" type="date" required
                      min={(i === 0 ? departDate : extraLegs[i - 1].date) || today}
                      value={leg.date} onChange={(e) => updLeg(i, { date: e.target.value })} />
                  </div>
                  <div className="search-field sw-leg-class"><span className="sw-field-label">Class</span><span className="sw-leg-class-value">{cabinClass}</span></div>
                </div>
              ))}
              {extraLegs.length < 5 && (
                <button type="button" className="toggle-pill"
                  onClick={() => setExtraLegs((ls) => [...ls, { origin: ls[ls.length - 1]?.dest ?? null, dest: null, date: "" }])}>
                  + Add another flight
                </button>
              )}
            </div>
          )}

          {/* Extras bar: direct-flights + special fares + cabin (always) */}
          <div className="sw-extras-bar">
            <label className={`toggle-pill${directOnly ? " on" : ""}`}>
              <input type="checkbox" checked={directOnly} onChange={(e) => setDirectOnly(e.target.checked)} />
              <span className="toggle-pill-icon">✈</span> Direct flights only
            </label>
            <select
              className="special-fare-select"
              value={specialFare}
              onChange={(e) => setSpecialFare(e.target.value as SpecialFare)}
              aria-label="Special fare"
            >
              {SPECIAL_FARES.map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>

          {/* Search button */}
          <button type="submit" className={searching ? "search-btn search-btn-loading" : "search-btn"} tabIndex={5} disabled={searching}>
            {searching ? <><span className="search-spinner" /> {SEARCH_STAGES[searchStage]}</> : <>Search live flights <span aria-hidden="true">→</span></>}
          </button>
        </div>
      </form>

      {searching && (
        <div className="search-progress" role="status" aria-live="polite">
          <div className="search-progress-track"><span className="search-plane">✈</span><i /></div>
          <div><strong>{SEARCH_STAGES[searchStage]}</strong><small>Live supplier results can take a few seconds. Please don’t close this page.</small></div>
        </div>
      )}

      <div className="search-shortcuts" aria-label="Quick travel benefits">
        <span>✓ Live fares</span><span>✓ Baggage details</span><span>✓ Secure checkout</span>
      </div>
    </div>
  );
}
