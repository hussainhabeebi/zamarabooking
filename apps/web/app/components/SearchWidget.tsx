"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { AiTripSearch, type AiTripFields } from "./AiTripSearch";
import { useRouter } from "next/navigation";
import { CURRENCY_EVENT, readPrefCurrency, savePrefCurrency } from "../lib/currency-pref";
import { AED_PAYMENTS_ENABLED, SHOWN_CURRENCIES, type DisplayCurrency } from "../lib/fx";
import RecentSearches from "./RecentSearches";
import { DateCalendar } from "./DateCalendar";
import { searchDatePassed, searchUrl, type RecentSearch } from "../lib/recent-searches";

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

// Only currencies customers can pay in (lib/fx.ts). With AED payments: INR and AED as quick picks,
// the other GCC currencies and USD under "More"; without: INR and USD, no "More".
const CURRENCIES = SHOWN_CURRENCIES;
const QUICK_CURRENCIES = SHOWN_CURRENCIES.filter((c) => c.code === "INR" || c.code === (AED_PAYMENTS_ENABLED ? "AED" : "USD"));
const MORE_CURRENCIES = SHOWN_CURRENCIES.filter((c) => !QUICK_CURRENCIES.includes(c));
type CurrencyCode = DisplayCurrency;

type Airport = typeof AIRPORTS[number];
type TripType = "One Way" | "Round Trip" | "Multi-city";

// TripJack passenger fare types (searchModifiers.pfts).
const SPECIAL_FARES = ["Regular", "Student", "Senior Citizen"] as const;
const FARE_TYPE_PARAM: Record<string, string> = { Regular: "REGULAR", Student: "STUDENT", "Senior Citizen": "SENIOR_CITIZEN" };
type ExtraLeg = { origin: Airport | null; dest: Airport | null; date: string };
type SpecialFare = typeof SPECIAL_FARES[number];

const COUNTRY: Record<string, string> = {
  IN: "India", AE: "United Arab Emirates", QA: "Qatar", OM: "Oman", BH: "Bahrain", KW: "Kuwait", SA: "Saudi Arabia",
  GB: "United Kingdom", FR: "France", DE: "Germany", SG: "Singapore", MY: "Malaysia", TH: "Thailand", HK: "Hong Kong",
  JP: "Japan", US: "United States", CA: "Canada", AU: "Australia",
};

// From / To field: the city in large bold type, "[COK] India" under it. onPicked runs after a city is
// chosen, so the form moves on to the next field by itself (From → To → Depart).
function AirportInput({
  id, label, value, onChange, placeholder, onPicked,
}: {
  id: string; label: string; value: Airport | null;
  onChange: (a: Airport) => void; placeholder: string; onPicked?: () => void;
}) {
  const displayVal = value ? value.city : "";
  const [query, setQuery] = useState(displayVal);
  const [open,  setOpen]  = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(value ? value.city : "");
  }, [value]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value ? value.city : "");
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
    setQuery(a.city);
    setOpen(false);
    onPicked?.();
  }

  return (
    <div className="airport-wrap bf-field bf-airport" ref={wrapRef} onClick={() => inputRef.current?.focus()}>
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        className="search-input bf-city"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        inputMode="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-activedescendant={open && activeIndex >= 0 && matches[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault(); setOpen(true);
            setActiveIndex((i) => e.key === "ArrowDown" ? Math.min(i + 1, matches.length - 1) : Math.max(i - 1, 0));
          } else if (e.key === "Enter" && open) {
            e.preventDefault(); const airport = matches[activeIndex]; if (airport) pick(airport);
          } else if (e.key === "Escape") { e.preventDefault(); setOpen(false); setQuery(displayVal); }
        }}
        onBlur={() => { setOpen(false); setQuery(displayVal); setActiveIndex(-1); }}
        onFocus={() => { setQuery(""); setOpen(true); setActiveIndex(-1); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(-1); }}
        required
      />
      <span className="bf-sub">{value ? `[${value.code}] ${COUNTRY[value.country] ?? value.country}` : "Select city or airport"}</span>
      {open && (
        <ul className="airport-dropdown" id={`${id}-options`} role="listbox" aria-label={`${label} airports`}>
          {matches.map((a, index) => (
            <li
              key={a.code}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
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
          {matches.length === 0 && <li role="presentation" className="airport-empty">No matching airport. Try a city or airport code.</li>}
        </ul>
      )}
    </div>
  );
}

// Date field: chosen from our calendar only (no typing). Shows "24 Nov'26" in large bold type with the
// weekday under it. Clicking the field, Enter / Space, or openDatePicker(id) opens its calendar
// (a bottom sheet on phones, a popover on wider screens).
const OPEN_DATE_EVENT = "bf-open-date";
export function openDatePicker(id: string) {
  window.dispatchEvent(new CustomEvent(OPEN_DATE_EVENT, { detail: id }));
}

function DateField({ id, label, value, min, onChange, empty, onOpen, rangeStart }: {
  id: string; label: string; value: string; min: string; onChange: (v: string) => void;
  empty?: React.ReactNode; onOpen?: () => void; rangeStart?: string;
}) {
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  const show = () => { onOpen?.(); setOpen(true); };
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === id) show(); };
    window.addEventListener(OPEN_DATE_EVENT, on);
    return () => window.removeEventListener(OPEN_DATE_EVENT, on);
  });
  return (
    <div ref={field} className="bf-field bf-date" onClick={show}>
      <span className="bf-label">{label}</span>
      <div id={id} role="button" tabIndex={0} className="bf-date-value" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${label}: ${d ? d.toDateString() : "choose a date"}`}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(); } }}>
        {d ? (
          <>
            <span className="bf-date-main"><b>{d.getUTCDate()}</b> {d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}&rsquo;{String(d.getUTCFullYear()).slice(2)}</span>
            <span className="bf-sub">{d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}</span>
          </>
        ) : empty ?? <span className="bf-date-empty">Select date</span>}
      </div>
      <DateCalendar open={open} anchor={field.current} title={`${label} date`} value={value} min={min} rangeStart={rangeStart}
        onClose={close} onPick={(v) => { setOpen(false); onChange(v); }} />
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
    // Dates come from the calendar only: open the first one still missing.
    if (!departDate) { openDatePicker("sw-depart"); return; }
    if (tripType === "Round Trip" && !returnDate) { openDatePicker("sw-return"); return; }
    if (multi && extraLegs.some((l) => !l.origin || !l.dest)) return;
    const noDate = multi ? extraLegs.findIndex((l) => !l.date) : -1;
    if (noDate >= 0) { openDatePicker(`sw-leg-${noDate}-date`); return; }
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

  // Recent searches → "Search again": fill the form with that search and run it again (a new live
  // search, exactly as if the form had been submitted). A date in the past only fills the form.
  function searchAgain(s: RecentSearch) {
    const airport = (code: string): Airport => AIRPORTS.find((a) => a.code === code) ?? ({ code, city: code, country: "" } as Airport);
    const passed = searchDatePassed(s);
    const legs = s.tripType === "MULTICITY" && s.legs?.length ? s.legs : null;
    setTripType(s.tripType === "ROUNDTRIP" ? "Round Trip" : legs ? "Multi-city" : "One Way");
    setOrigin(airport(s.origin));
    setDest(airport(legs ? legs[0].destination : s.destination));
    setDepartDate(passed ? "" : s.departureDate);
    setReturnDate(!passed && s.tripType === "ROUNDTRIP" ? s.returnDate ?? "" : "");
    if (legs) setExtraLegs(legs.slice(1).map((l) => ({ origin: airport(l.origin), dest: airport(l.destination), date: passed ? "" : l.departureDate })));
    setAdults(s.adults); setChildren(s.children); setInfants(s.infants);
    setCabinClass(({ ECONOMY: "Economy", PREMIUM_ECONOMY: "Premium Economy", BUSINESS: "Business", FIRST: "First" } as const)[s.cabinClass]);
    setSpecialFare(s.fareType === "STUDENT" ? "Student" : s.fareType === "SENIOR_CITIZEN" ? "Senior Citizen" : "Regular");
    setDirectOnly(false);
    setAiPrefs({});
    if (passed) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => document.getElementById("sw-depart")?.focus(), 300);
      return;
    }
    const url = searchUrl(s, currency);
    setSearching(true);
    router.prefetch(url);
    window.requestAnimationFrame(() => router.push(url));
  }

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="search-widget">
      <AiTripSearch onApply={applyAi} onSearchNow={() => formRef.current?.requestSubmit()} />
      {/* Top bar: trip type + direct flights + currency */}
      <div className="trip-tabs">
        {(["One Way", "Round Trip", "Multi-city"] as TripType[]).map((t) => (
          <button
            key={t} type="button"
            onClick={() => setTripType(t)}
            aria-pressed={t === tripType}
            className={t === tripType ? "trip-tab trip-tab-active" : "trip-tab trip-tab-inactive"}
          >
            {t}
          </button>
        ))}
        <label className={`toggle-pill bf-direct${directOnly ? " on" : ""}`}>
          <input type="checkbox" checked={directOnly} onChange={(e) => setDirectOnly(e.target.checked)} />
          <span className="toggle-pill-icon">✈</span> Direct flights only
        </label>

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
          {MORE_CURRENCIES.length > 0 && (() => {
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

      <form ref={formRef} onSubmit={handleSearch} aria-busy={searching} className={`bf-form${tripType === "Multi-city" ? " bf-multi" : ""}`}>
        {/* Row 1 (as on Akbar's portal): From ⇄ To · Depart · Return */}
        <div className="bf-row1">
          {tripType === "Multi-city" && <div className="bf-leg-label">Flight 1</div>}
          <div className="bf-route">
            <AirportInput
              id="sw-origin" label="From" value={origin}
              onChange={setOrigin} placeholder="City or airport"
              onPicked={() => document.getElementById("sw-dest")?.focus()}
            />
            <button type="button" className="swap-btn bf-swap" onClick={swap} aria-label="Swap airports">⇄</button>
            <AirportInput
              id="sw-dest" label="To" value={dest}
              onChange={setDest} placeholder="City or airport"
              onPicked={() => openDatePicker("sw-depart")}
            />
          </div>
          <div className="bf-dates">
            <DateField id="sw-depart" label="Depart" value={departDate} min={today}
              onChange={(v) => {
                setDepartDate(v);
                const keepReturn = returnDate && returnDate >= v;
                if (!keepReturn) setReturnDate("");
                if (tripType === "Round Trip" && !keepReturn) setTimeout(() => openDatePicker("sw-return"), 260);
              }} />
            {tripType !== "Multi-city" && (
              <DateField id="sw-return" label="Return" value={tripType === "Round Trip" ? returnDate : ""} min={departDate || today}
                rangeStart={departDate || undefined}
                onOpen={() => { if (tripType !== "Round Trip") setTripType("Round Trip"); }}
                onChange={(v) => { setReturnDate(v); setTripType("Round Trip"); }}
                empty={<span className="bf-date-hint">Book a round trip to save more</span>} />
            )}
          </div>
        </div>

        {tripType === "Multi-city" && (
          <div className="bf-legs">
            {extraLegs.map((leg, i) => (
              <div key={i} className="bf-row1 bf-leg">
                <div className="bf-leg-label">
                  Flight {i + 2}
                  {extraLegs.length > 1 && (
                    <button type="button" className="sw-leg-remove" aria-label={`Remove flight ${i + 2}`}
                      onClick={() => setExtraLegs((ls) => ls.filter((_, n) => n !== i))}>✕</button>
                  )}
                </div>
                <div className="bf-route">
                  <AirportInput id={`sw-leg-${i}-from`} label="From" value={leg.origin}
                    onChange={(a) => updLeg(i, { origin: a })} placeholder="City or airport"
                    onPicked={() => document.getElementById(`sw-leg-${i}-to`)?.focus()} />
                  <span className="bf-leg-arrow" aria-hidden="true">→</span>
                  <AirportInput id={`sw-leg-${i}-to`} label="To" value={leg.dest}
                    onChange={(a) => updLeg(i, { dest: a })} placeholder="City or airport"
                    onPicked={() => openDatePicker(`sw-leg-${i}-date`)} />
                </div>
                <div className="bf-dates bf-dates-one">
                  <DateField id={`sw-leg-${i}-date`} label="Depart" value={leg.date}
                    min={(i === 0 ? departDate : extraLegs[i - 1].date) || today}
                    onChange={(v) => updLeg(i, { date: v })} />
                </div>
              </div>
            ))}
            {extraLegs.length < 5 && (
              <button type="button" className="toggle-pill bf-add-leg"
                onClick={() => setExtraLegs((ls) => [...ls, { origin: ls[ls.length - 1]?.dest ?? null, dest: null, date: "" }])}>
                + Add another flight
              </button>
            )}
          </div>
        )}

        {/* Row 2: Travellers · Class · Fare type · Search */}
        <div className="bf-row2">
          <div ref={paxRef} className="bf-field bf-pax" style={{ position: "relative" }}>
            <span className="bf-label">Travellers</span>
            <button type="button" className="bf-select-btn" onClick={() => setPaxOpen((v) => !v)} aria-label="Travellers" aria-expanded={paxOpen}>
              <span><b>{adults + children + infants}</b> {adults + children + infants === 1 ? "Passenger" : "Passengers"}</span>
              <span className="bf-caret" aria-hidden="true">▾</span>
            </button>
            <span className="bf-sub">{adults} Adult{adults > 1 ? "s" : ""}{children ? ` · ${children} Child${children > 1 ? "ren" : ""}` : ""}{infants ? ` · ${infants} Infant${infants > 1 ? "s" : ""}` : ""}</span>
            {paxOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 60, background: "#fff", border: "1px solid #d0d5dd", borderRadius: 14, padding: "14px 16px", minWidth: 220, boxShadow: "0 8px 24px rgba(0,0,0,.12)" }}>
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
          <div className="bf-field bf-class">
            <label className="bf-label" htmlFor="sw-class">Cabin class</label>
            <select id="sw-class" className="bf-select" value={cabinClass}
              onChange={(e) => setCabinClass(e.target.value as typeof cabinClass)}>
              {CABIN_CLASSES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="bf-field bf-fare">
            <label className="bf-label" htmlFor="sw-fare">Fare type</label>
            <select id="sw-fare" className="bf-select" value={specialFare}
              onChange={(e) => setSpecialFare(e.target.value as SpecialFare)}>
              {SPECIAL_FARES.map((f) => <option key={f}>{f}</option>)}
            </select>
          </div>
          <button type="submit" className={searching ? "search-btn bf-search search-btn-loading" : "search-btn bf-search"} disabled={searching}>
            {searching ? <><span className="search-spinner" /> {SEARCH_STAGES[searchStage]}</> : <>Search flights <span aria-hidden="true">→</span></>}
          </button>
        </div>
      </form>

      {searching && (
        <div className="search-progress" role="status" aria-live="polite">
          <div className="search-progress-track"><span className="search-plane">✈</span><i /></div>
          <div><strong>{SEARCH_STAGES[searchStage]}</strong><small>Live supplier results can take a few seconds. Please don’t close this page.</small></div>
        </div>
      )}

      <RecentSearches onSearchAgain={searchAgain} busy={searching} />

      <div className="search-shortcuts" aria-label="Quick travel benefits">
        <span>✓ Compare flights</span><span>✓ Baggage details</span><span>✓ Secure checkout</span>
      </div>
    </div>
  );
}
