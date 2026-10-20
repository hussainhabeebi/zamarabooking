"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { readPrefCurrency, savePrefCurrency } from "../lib/currency-pref";

const CITIES = [
  { code: "DXB", city: "Dubai",         country: "AE" },
  { code: "AUH", city: "Abu Dhabi",     country: "AE" },
  { code: "SHJ", city: "Sharjah",       country: "AE" },
  { code: "DOH", city: "Doha",          country: "QA" },
  { code: "BOM", city: "Mumbai",        country: "IN" },
  { code: "DEL", city: "New Delhi",     country: "IN" },
  { code: "CCJ", city: "Kozhikode",     country: "IN" },
  { code: "COK", city: "Kochi",         country: "IN" },
  { code: "BLR", city: "Bengaluru",     country: "IN" },
  { code: "HYD", city: "Hyderabad",     country: "IN" },
  { code: "MAA", city: "Chennai",       country: "IN" },
  { code: "GOI", city: "Goa",           country: "IN" },
  { code: "AMD", city: "Ahmedabad",     country: "IN" },
  { code: "CCU", city: "Kolkata",       country: "IN" },
  { code: "TRV", city: "Trivandrum",    country: "IN" },
  { code: "MCT", city: "Muscat",        country: "OM" },
  { code: "RUH", city: "Riyadh",        country: "SA" },
  { code: "JED", city: "Jeddah",        country: "SA" },
  { code: "KWI", city: "Kuwait City",   country: "KW" },
  { code: "BAH", city: "Bahrain",       country: "BH" },
  { code: "LHR", city: "London",        country: "GB" },
  { code: "CDG", city: "Paris",         country: "FR" },
  { code: "SIN", city: "Singapore",     country: "SG" },
  { code: "BKK", city: "Bangkok",       country: "TH" },
  { code: "KUL", city: "Kuala Lumpur",  country: "MY" },
  { code: "NRT", city: "Tokyo",         country: "JP" },
  { code: "JFK", city: "New York",      country: "US" },
  { code: "SYD", city: "Sydney",        country: "AU" },
];

type City = typeof CITIES[number];

// Common guest nationalities (ISO 3166-1 alpha-2) — TripJack takes the ISO code.
const NATIONALITIES: [string, string][] = [
  ["IN", "India"], ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["OM", "Oman"], ["KW", "Kuwait"],
  ["BH", "Bahrain"], ["PK", "Pakistan"], ["BD", "Bangladesh"], ["LK", "Sri Lanka"], ["NP", "Nepal"], ["PH", "Philippines"],
  ["EG", "Egypt"], ["JO", "Jordan"], ["LB", "Lebanon"], ["GB", "United Kingdom"], ["US", "United States"], ["CA", "Canada"],
  ["AU", "Australia"], ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"], ["NL", "Netherlands"],
  ["RU", "Russia"], ["CN", "China"], ["JP", "Japan"], ["KR", "South Korea"], ["SG", "Singapore"], ["MY", "Malaysia"],
  ["ID", "Indonesia"], ["TH", "Thailand"], ["NG", "Nigeria"], ["KE", "Kenya"], ["ZA", "South Africa"], ["TR", "Turkey"], ["IR", "Iran"],
];
type CurrencyCode = "INR" | "AED" | "USD";
const CURRENCIES = [
  { code: "INR" as CurrencyCode, symbol: "₹" },
  { code: "AED" as CurrencyCode, symbol: "د.إ" },
  { code: "USD" as CurrencyCode, symbol: "$" },
];
const POPULAR_HUB_CODES = ["DXB", "AUH", "DOH", "BOM", "DEL", "COK"];
const HUB_IMAGES: Record<string, string> = {
  DXB: "/routes/dubai.jpg",
  AUH: "/routes/abu-dhabi.jpg",
  DOH: "/routes/doha.jpg",
  BOM: "/routes/mumbai.jpg",
  DEL: "/routes/delhi.jpg",
  COK: "/routes/kochi.jpg",
};

function CityInput({
  label, value, onChange,
}: { label: string; value: City | null; onChange: (c: City) => void }) {
  const displayVal = value ? `${value.city} (${value.code})` : "";
  const [query, setQuery] = useState(displayVal);
  const [open, setOpen]   = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(value ? `${value.city} (${value.code})` : "");
  }, [value]);

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value ? `${value.city} (${value.code})` : "");
      }
    }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, [value]);

  const q = query.toLowerCase().trim();
  const matches = q
    ? CITIES.filter((c) => c.code.toLowerCase().startsWith(q) || c.city.toLowerCase().includes(q)).slice(0, 8)
    : CITIES.slice(0, 8);

  return (
    <div className="hw-field-wrap" ref={wrapRef}>
      <label>{label}</label>
      <input
        className="hw-input"
        value={query}
        placeholder="City or destination"
        autoComplete="off"
        onFocus={() => { setQuery(""); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        required
      />
      {open && matches.length > 0 && (
        <ul className="hw-dropdown">
          {matches.map((c) => (
            <li
              key={c.code}
              onMouseDown={(e) => { e.preventDefault(); onChange(c); setQuery(`${c.city} (${c.code})`); setOpen(false); }}
              onTouchEnd={(e) => { e.preventDefault(); onChange(c); setQuery(`${c.city} (${c.code})`); setOpen(false); }}
            >
              <span className="hw-code">{c.code}</span>
              <span className="hw-city">{c.city}</span>
              <span className="hw-flag">
                {String.fromCodePoint(...[...c.country].map((ch) => 0x1F1A5 + ch.charCodeAt(0)))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function HotelsPage() {
  const router = useRouter();
  const checkInRef = useRef<HTMLInputElement>(null);
  const [city,     setCity]     = useState<City | null>(null);
  const [checkIn,  setCheckIn]  = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [rooms,    setRooms]    = useState(1);
  const [adults,   setAdults]   = useState(1);
  const [currency, setCurrencyState] = useState<CurrencyCode>("INR");
  // Same currency as flights: chosen once for the visit.
  useEffect(() => { const c = readPrefCurrency(); if (c === "INR" || c === "AED" || c === "USD") setCurrencyState(c); }, []);
  const setCurrency = (code: CurrencyCode) => { setCurrencyState(code); savePrefCurrency(code); };
  // Guests' nationality: TripJack prices hotels by it and asks Indian guests
  // for a PAN at hotels abroad (foreign guests don't need one).
  const [nationality, setNationality] = useState("IN");

  const today = new Date().toISOString().split("T")[0];

  // Search button animation while the results page loads live hotel rates.
  const SEARCH_STAGES = ["Checking live hotel rates", "Comparing rooms", "Finding your best stays"];
  const [searching, setSearching] = useState(false);
  const [searchStage, setSearchStage] = useState(0);
  useEffect(() => {
    if (!searching) { setSearchStage(0); return; }
    const timer = window.setInterval(() => setSearchStage((s) => Math.min(s + 1, SEARCH_STAGES.length - 1)), 1600);
    return () => window.clearInterval(timer);
  }, [searching]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back with the browser's Back button must not leave the button spinning.
  useEffect(() => {
    const reset = () => setSearching(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!city || searching) return;
    const params = new URLSearchParams({
      city:     city.code,
      cityName: city.city,
      checkIn,
      checkOut,
      rooms:    String(rooms),
      adults:   String(adults),
      currency,
      nationality,
    });
    const url = `/hotels/search?${params}`;
    setSearching(true);
    router.prefetch(url);
    // Give mobile Safari one frame to paint the loading state before navigating.
    window.requestAnimationFrame(() => router.push(url));
  }

  function chooseHub(hub: City) {
    setCity(hub);
    checkInRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    checkInRef.current?.focus({ preventScroll: true });
  }

  return (
    <main className="hw-page">
      <style>{css}</style>

      <div className="hw-hero">
        <div className="hw-hero-inner">
          <span className="hw-badge">STAYS ACROSS INDIA, THE GULF & BEYOND</span>
          <h1 className="hw-title">Find your perfect stay</h1>
          <p className="hw-subtitle">Choose your destination and dates, then explore available stays for your trip.</p>
        </div>
      </div>

      <div className="hw-container">
        <div className="hw-widget">
          <div className="hw-widget-tabs">
            <div className="hw-widget-intro"><strong>Search hotels</strong><span>Find a stay that fits your journey</span></div>
            <div className="hw-currency" role="group" aria-label="Hotel search currency">
              <span className="hw-currency-label">Currency</span>
              {(["INR", "AED", "USD"] as CurrencyCode[]).map((code) => (
                <button
                  key={code} type="button"
                  className={currency === code ? "hw-cur hw-cur-active" : "hw-cur"}
                  onClick={() => setCurrency(code)}
                  aria-pressed={currency === code}
                >
                  {CURRENCIES.find((c) => c.code === code)?.symbol} {code}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSearch} aria-busy={searching}>
            <div className="hw-grid">
              <CityInput label="Destination" value={city} onChange={setCity} />
              <div className="hw-dates">
                <div className="hw-field-wrap">
                  <label htmlFor="hw-check-in">Check-in</label>
                  <input id="hw-check-in" ref={checkInRef} className="hw-input" type="date" value={checkIn} min={today}
                    onChange={(e) => setCheckIn(e.target.value)} required />
                </div>
                <div className="hw-field-wrap">
                  <label htmlFor="hw-check-out">Check-out</label>
                  <input id="hw-check-out" className="hw-input" type="date" value={checkOut}
                    min={checkIn || today} onChange={(e) => setCheckOut(e.target.value)} required />
                </div>
              </div>
              <div className="hw-occupancy">
              <label className="hw-select-label">
                <span>Rooms</span>
                <select className="hw-select" value={rooms} onChange={(e) => setRooms(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="hw-select-label">
                <span>Adults/room</span>
                <select className="hw-select" value={adults} onChange={(e) => setAdults(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              </div>
              <button type="submit" className={searching ? "hw-search-btn search-btn-loading" : "hw-search-btn"} disabled={searching}>
                {searching
                  ? <><i className="search-spinner" aria-hidden="true" /> {SEARCH_STAGES[searchStage]}</>
                  : <>Search Hotels <span aria-hidden="true">→</span></>}
              </button>
            </div>
          </form>

          {searching && (
            <div className="search-progress" role="status" aria-live="polite">
              <div className="search-progress-track"><span className="search-plane" aria-hidden="true">🏨</span><i /></div>
              <div><strong>{SEARCH_STAGES[searchStage]}</strong><small>Live hotel rates can take a few seconds. Please don’t close this page.</small></div>
            </div>
          )}

          <label className="hw-nat">
            <span>Guests&apos; nationality</span>
            <select value={nationality} onChange={(e) => setNationality(e.target.value)} aria-label="Guests' nationality">
              {NATIONALITIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>

          <div className="hw-perks">
            <span>✓ Destination and date search</span>
            <span>✓ Room details in results</span>
            <span>✓ Cancellation terms shown per stay</span>
          </div>
        </div>

        <section className="hw-hubs" aria-labelledby="hw-hubs-title">
          <div className="hw-section-heading">
            <div><span className="hw-eyebrow">EXPLORE DESTINATIONS</span><h2 id="hw-hubs-title">Popular hubs for your next stay</h2></div>
            <p>Select a destination, then add your dates above to search.</p>
          </div>
          <div className="hw-hub-list">
            {POPULAR_HUB_CODES.map((code) => {
              const hub = CITIES.find((item) => item.code === code)!;
              return <button type="button" key={code} className="hw-hub" onClick={() => chooseHub(hub)}>
                <span className="hw-hub-image" aria-hidden="true">
                  {/* The city name below supplies the button's accessible name. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={HUB_IMAGES[code]} alt="" loading="lazy" decoding="async" width="640" height="360" />
                </span>
                <span className="hw-hub-content">
                  <span><strong>{hub.city}</strong><small>{hub.country} · {hub.code}</small></span>
                  <span className="hw-hub-arrow" aria-hidden="true">↗</span>
                </span>
              </button>;
            })}
          </div>
        </section>

        <section className="hw-benefits" aria-labelledby="hw-benefits-title">
          <div className="hw-section-heading hw-benefits-heading">
            <div><span className="hw-eyebrow">PLAN WITH CLARITY</span><h2 id="hw-benefits-title">Why book your stay with FlyPoomas?</h2></div>
            <p>See the details that matter before choosing a stay.</p>
          </div>
          <div className="hw-benefit-grid">
            <div className="hw-benefit"><span className="hw-benefit-icon" aria-hidden="true">₹</span><h3>Choose your currency</h3><p>Search in INR, AED or USD using the existing hotel search options.</p></div>
            <div className="hw-benefit"><span className="hw-benefit-icon" aria-hidden="true">▤</span><h3>Review room details</h3><p>See available room type, meal plan and amenities when supplied with a result.</p></div>
            <div className="hw-benefit"><span className="hw-benefit-icon" aria-hidden="true">✓</span><h3>Check stay terms</h3><p>Review each result’s cancellation status before continuing to booking.</p></div>
          </div>
        </section>
      </div>
    </main>
  );
}

const css = `
.hw-page { min-height: 100vh; background: #f8fafc; color: #15263f; overflow-x: clip; }
.hw-hero {
  min-height: 260px; display: flex; align-items: flex-start; justify-content: center;
  padding: 38px 24px 96px; text-align: center;
  background: radial-gradient(ellipse at 50% -35%, rgba(103,123,170,.37), transparent 54%), linear-gradient(125deg, #0a1426, #172c4d 53%, #0b1527);
}
.hw-hero-inner { max-width: 700px; }
.hw-badge {
  display: inline-block; background: rgba(255,255,255,.08); color: #e9eef8;
  border: 1px solid rgba(255,255,255,.18); border-radius: 20px;
  padding: 6px 13px; font-size: 10px; font-weight: 750; letter-spacing: .12em; margin-bottom: 14px;
}
.hw-title { margin: 0 0 9px; font-size: clamp(30px, 3.4vw, 46px); line-height: 1.1; font-weight: 850; letter-spacing: -.045em; color: white; }
.hw-subtitle { margin: 0; font-size: 14px; line-height: 1.6; color: #d1daeb; }
.hw-container { max-width: 1440px; margin: -74px auto 0; padding: 0 28px 76px; position: relative; z-index: 10; }
.hw-widget {
  background: white; border: 1px solid #dfe6f0; border-radius: 16px; padding: 20px 22px 16px;
  box-shadow: 0 15px 38px rgba(8,24,49,.13);
}
.hw-widget-tabs {
  display: flex; justify-content: space-between; gap: 16px; margin-bottom: 15px; flex-wrap: wrap; align-items: center;
}
.hw-widget-intro { display: flex; align-items: baseline; gap: 11px; }
.hw-widget-intro strong { font-size: 17px; color: #132944; }
.hw-widget-intro span { color: #75849b; font-size: 12px; }
.hw-currency { display: flex; align-items: center; gap: 5px; }
.hw-currency-label { margin-right: 5px; color: #697a90; font-size: 11px; font-weight: 700; }
.hw-cur {
  min-height: 31px; padding: 5px 10px; border-radius: 17px; border: 1px solid #dae3ed;
  background: white; color: #53647a; font-size: 11px; font-weight: 700; cursor: pointer; transition: background .2s, border-color .2s, color .2s;
}
.hw-cur:hover { border-color: #e31e24; color: #c91924; }
.hw-cur-active, .hw-cur-active:hover { background: #e31e24; border-color: #e31e24; color: white; }
.hw-nat { display: inline-flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12px; color: #53647a; font-weight: 650; }
.hw-nat select { border: 1px solid #d0d5dd; border-radius: 8px; padding: 6px 8px; font-size: 13px; background: #fff; color: #1e293b; max-width: 220px; }
.hw-occupancy { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 10px; min-width: 0; }
.hw-select-label { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 10px; color: #53647a; font-weight: 750; text-transform: uppercase; letter-spacing: .045em; }
.hw-select {
  width: 100%; min-width: 0; min-height: 47px; border: 1px solid #d8e2ec; border-radius: 9px; padding: 8px 10px;
  font-size: 13px; color: #172b44; background: white; cursor: pointer; outline: none;
}
.hw-grid { display: grid; grid-template-columns: minmax(170px,1.5fr) minmax(260px,1.8fr) minmax(190px,1.35fr) minmax(150px,.9fr); gap: 10px; align-items: end; }
.hw-field-wrap { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hw-field-wrap label { font-size: 10px; color: #53647a; font-weight: 750; text-transform: uppercase; letter-spacing: .045em; }
.hw-input {
  padding: 10px 12px; border: 1px solid #d8e2ec; border-radius: 9px;
  font-size: 14px; width: 100%; min-width: 0; outline: none; min-height: 47px; background: white;
  color: #172b44; font-family: inherit;
}
.hw-input:focus, .hw-select:focus-visible { border-color: #e31e24; box-shadow: 0 0 0 3px #e31e241c; }
.hw-dates { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.hw-dropdown {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  background: white; border: 1.5px solid #e5e7eb; border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.12); list-style: none; margin: 0; padding: 4px 0; z-index: 200;
  max-height: 260px; overflow-y: auto;
}
.hw-dropdown li {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px; cursor: pointer;
}
.hw-dropdown li:hover { background: #f3f4f6; }
.hw-code { font-weight: 700; font-size: 15px; color: #E31E24; min-width: 38px; }
.hw-city { font-size: 14px; color: #1e293b; flex: 1; }
.hw-flag { font-size: 18px; }
.hw-search-btn {
  background: #e31e24; color: white; border: none; border-radius: 9px;
  padding: 11px 14px; font-weight: 750; font-size: 13px; cursor: pointer;
  width: 100%; min-height: 47px; font-family: inherit; white-space: nowrap;
}
.hw-search-btn:hover { background: #c91924; }
.hw-search-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; transition: transform .12s ease, box-shadow .2s ease, background .2s ease; }
.hw-search-btn:hover:not(:disabled) { box-shadow: 0 8px 20px rgba(227,30,36,.28); transform: translateY(-1px); }
.hw-search-btn:active:not(:disabled) { transform: scale(.97); }
.hw-search-btn:disabled { cursor: progress; }
.hw-search-btn .search-spinner { display: inline-block; flex-shrink: 0; }
@media (prefers-reduced-motion: reduce) { .hw-search-btn { transition: none; } .hw-search-btn:hover:not(:disabled), .hw-search-btn:active:not(:disabled) { transform: none; } }
.hw-search-btn span { margin-left: 4px; }
.hw-perks { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 14px; font-size: 11px; color: #6a7a90; font-weight: 600; }
.hw-hubs { margin-top: 42px; }
.hw-section-heading { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 18px; }
.hw-section-heading h2 { margin: 4px 0 0; color: #142944; font-size: clamp(22px,2.2vw,27px); letter-spacing: -.035em; }
.hw-section-heading p { margin: 0 0 2px; color: #697b91; font-size: 12px; }
.hw-eyebrow { color: #c71c28; font-size: 10px; letter-spacing: .12em; font-weight: 800; }
.hw-hub-list { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 11px; }
.hw-hub { display: block; min-width: 0; padding: 0; overflow: hidden; border: 1px solid #dfe7f0; border-radius: 12px; background: white; color: #1a2e47; text-align: left; cursor: pointer; transition: border-color .2s, box-shadow .2s, transform .2s; }
.hw-hub:hover { transform: translateY(-2px); border-color: #e5b6bd; box-shadow: 0 7px 18px rgba(18,39,68,.06); }
.hw-hub-image { display: block; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #e8edf3; }
.hw-hub-image img { display: block; width: 100%; height: 100%; object-fit: cover; transition: transform .22s ease; }
.hw-hub:hover .hw-hub-image img { transform: scale(1.035); }
.hw-hub-content { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 65px; padding: 12px 15px; }
.hw-hub strong, .hw-hub small { display: block; }
.hw-hub strong { font-size: 15px; }
.hw-hub small { margin-top: 3px; color: #718096; font-size: 11px; }
.hw-hub-arrow { flex: none; color: #a6b3c3; font-size: 18px; }
.hw-benefits { margin-top: 46px; }
.hw-benefit-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 14px; }
.hw-benefit { min-width: 0; padding: 21px; border: 1px solid #e5ebf2; border-radius: 13px; background: #fff; }
.hw-benefit-icon { display: grid; place-items: center; width: 32px; height: 32px; margin-bottom: 13px; border-radius: 9px; background: #fff1f2; color: #c71c28; font-weight: 800; }
.hw-benefit h3 { margin: 0 0 6px; color: #152944; font-size: 15px; }
.hw-benefit p { margin: 0; color: #65768c; font-size: 12px; line-height: 1.55; }
.hw-hub:focus-visible, .hw-cur:focus-visible, .hw-search-btn:focus-visible { outline: 2px solid #b91c1c; outline-offset: 3px; }
@media (max-width: 1100px) {
  .hw-grid { grid-template-columns: minmax(160px,1.2fr) minmax(250px,1.6fr) minmax(180px,1.25fr); }
  .hw-search-btn { grid-column: 1 / -1; }
}
@media (max-width: 760px) {
  .hw-hero { min-height: 248px; padding: 34px 20px 88px; }
  .hw-container { margin-top: -62px; padding: 0 20px 54px; }
  .hw-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .hw-grid > .hw-field-wrap, .hw-dates, .hw-occupancy, .hw-search-btn { grid-column: 1 / -1; }
  .hw-hub-list { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .hw-section-heading { display: block; }
  .hw-section-heading p { margin-top: 7px; }
}
@media (max-width: 500px) {
  .hw-hero { min-height: 242px; padding: 31px 18px 80px; }
  .hw-badge { font-size: 9px; }
  .hw-title { font-size: 31px; }
  .hw-subtitle { font-size: 13px; }
  .hw-container { margin-top: -48px; padding: 0 16px 48px; }
  .hw-widget { padding: 17px 15px 15px; }
  .hw-widget-intro { display: block; }
  .hw-widget-intro span { display: block; margin-top: 2px; }
  .hw-currency { width: 100%; flex-wrap: wrap; }
  .hw-currency-label { margin-right: 7px; }
  .hw-grid { display: flex; flex-direction: column; align-items: stretch; gap: 12px; }
  .hw-dates, .hw-occupancy { width: 100%; }
  .hw-input, .hw-select, .hw-search-btn { min-height: 48px; }
  .hw-perks { gap: 7px 14px; line-height: 1.4; }
  .hw-hubs, .hw-benefits { margin-top: 34px; }
  .hw-hub-list { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
  .hw-hub-content { min-height: 62px; padding: 10px; }
  .hw-hub strong { font-size: 12px; }
  .hw-hub small { font-size: 10px; }
  .hw-hub-arrow { font-size: 15px; }
  .hw-benefit-grid { grid-template-columns: 1fr; gap: 10px; }
  .hw-benefit { padding: 17px; }
}
@media (prefers-reduced-motion: reduce) { .hw-hub, .hw-hub-image img, .hw-cur { transition: none; } .hw-hub:hover, .hw-hub:hover .hw-hub-image img { transform: none; } }
`;
