"use client";

// TripSafe travel insurance: trip → plans → traveller details → policy.
// Journeys: single trip (standalone), domestic (India), student, annual
// multi-trip and embedded (opened from a flight booking with ?journey=EMBEDDED).

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import "./insurance.css";
import { API_URL, COUNTRIES, TENANT_HEADERS, authHeaders, money, nameOf } from "./shared";

type Journey = "STANDALONE" | "DOMESTIC" | "STUDENT" | "AMT" | "EMBEDDED";
type DestType = "COUNTRY" | "REGION" | "POPULARREGION";
type Destination = { key: string; type: DestType };

type Config = {
  enabled: boolean; instantIssue: boolean; maxTravellers: number;
  studentDurations: number[]; amtDurations: number[];
  regions: { key: string; name: string }[]; nomineeRelationships: string[];
};

type Benefit = { name: string; description?: string; iconCategory?: string; sumInsured?: string };
type Product = {
  productId: string; planCoverage: string; insuranceProvider: string; assistanceProviders: string[];
  regionName: string; planType: string; totalFare: number; banners: string[]; benefits: Benefit[];
  paxFares: { age: number; totalFare: number }[];
};

type Traveller = {
  title: string; firstName: string; lastName: string; dob: string; gender: string;
  passportNumber: string; nomineeName: string; nomineeRelationship: string;
};

const JOURNEYS: { key: Journey; label: string; hint: string }[] = [
  { key: "STANDALONE", label: "Single trip",        hint: "International trip cover, up to 180 days" },
  { key: "DOMESTIC",   label: "Within India",       hint: "Domestic cover, up to 30 days" },
  { key: "STUDENT",    label: "Student",            hint: "Study abroad, 30 days to 2 years (ages 18–45)" },
  { key: "AMT",        label: "Annual multi-trip",  hint: "Unlimited trips for a year, each up to the chosen length" },
];

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const RELATION_LABEL = (r: string) => r.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

function InsurancePageInner() {
  const qs = useSearchParams();
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");

  const initialJourney = (["STANDALONE", "DOMESTIC", "STUDENT", "AMT", "EMBEDDED"].includes(qs.get("journey") ?? "") ? qs.get("journey") : "STANDALONE") as Journey;
  const [journey, setJourney] = useState<Journey>(initialJourney);
  const [startDate, setStartDate] = useState(qs.get("start") ?? plusDays(today(), 5));
  const [endDate, setEndDate] = useState(qs.get("end") ?? plusDays(today(), 12));
  const [duration, setDuration] = useState<number>(0);
  const [destType, setDestType] = useState<"COUNTRY" | "REGION">("COUNTRY");
  const [destinations, setDestinations] = useState<Destination[]>(() =>
    (qs.get("dest") ?? "").split(",").filter(Boolean).map((d) => {
      const [key, type] = d.split(":");
      return { key: key.toUpperCase(), type: (type === "REGION" || type === "POPULARREGION" ? type : "COUNTRY") as DestType };
    }));
  const [countryPick, setCountryPick] = useState("");
  const [dobs, setDobs] = useState<string[]>(() => Array.from({ length: Math.min(10, Math.max(1, Number(qs.get("pax")) || 1)) }, () => ""));

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchId, setSearchId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);

  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/api/insurance/config`, { headers: TENANT_HEADERS })
      .then((r) => r.json())
      .then((d: Config) => setConfig(d))
      .catch(() => setConfigError("Travel insurance is not available right now."));
  }, []);

  // Journey-specific defaults.
  useEffect(() => {
    if (!config) return;
    if (journey === "STUDENT") {
      setDuration((d) => (config.studentDurations.includes(d) ? d : 180));
      setDestType("COUNTRY");
      setDestinations((ds) => ds.filter((d) => d.type === "COUNTRY").slice(0, 1));
    } else if (journey === "AMT") {
      setDuration((d) => (config.amtDurations.includes(d) ? d : config.amtDurations[0]));
      setDestType("REGION");
      setDestinations((ds) => ds.filter((d) => d.type !== "COUNTRY"));
    }
    setProducts([]); setSelected(null); setSearchId("");
  }, [journey, config]);

  const isStudent = journey === "STUDENT";
  const isAmt = journey === "AMT";
  const isDomestic = journey === "DOMESTIC";
  const usesEndDate = !isStudent && !isAmt;
  const maxEnd = isDomestic ? plusDays(startDate, 29) : plusDays(startDate, 179);

  function addCountry(code: string) {
    if (!code) return;
    setDestinations((ds) => {
      if (ds.some((d) => d.key === code)) return ds;
      const next = [...ds.filter((d) => d.type === "COUNTRY"), { key: code, type: "COUNTRY" as const }];
      return isStudent ? next.slice(-1) : next;
    });
    setCountryPick("");
  }

  function toggleRegion(key: string) {
    const type: DestType = isAmt ? "POPULARREGION" : "REGION";
    setDestinations((ds) => ds.some((d) => d.key === key)
      ? ds.filter((d) => d.key !== key)
      : [...ds.filter((d) => d.type !== "COUNTRY"), { key, type }]);
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    setSearchError(""); setProducts([]); setSelected(null);
    if (dobs.some((d) => !d)) { setSearchError("Enter the date of birth for every traveller."); return; }
    if (!isDomestic && !destinations.length) { setSearchError("Choose where you're travelling."); return; }
    setSearching(true);
    try {
      const res = await fetch(`${API_URL}/api/insurance/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...TENANT_HEADERS },
        body: JSON.stringify({
          journey, startDate,
          ...(usesEndDate ? { endDate } : {}),
          ...(isStudent || isAmt ? { coverageDuration: duration } : {}),
          destinations: isDomestic ? [{ key: "IN", type: "COUNTRY" }] : destinations,
          travellerDobs: dobs,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setSearchError(d.error ?? "We couldn't load insurance plans. Please try again."); return; }
      setSearchId(d.searchId);
      setProducts(d.products ?? []);
      setTravellers(dobs.map((dob) => ({ title: "MR", firstName: "", lastName: "", dob, gender: "Male", passportNumber: "", nomineeName: "", nomineeRelationship: "LEGAL_HEIR" })));
    } catch {
      setSearchError("We couldn't reach the server. Please try again.");
    } finally {
      setSearching(false);
    }
  }

  function updateTraveller(i: number, patch: Partial<Traveller>) {
    setTravellers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  async function book(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBookError("");
    setBooking(true);
    try {
      const res = await fetch(`${API_URL}/api/insurance/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          searchId, productId: selected.productId,
          contact: { email: email.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) },
          travellers: travellers.map((t) => ({
            title: t.title, firstName: t.firstName.trim(), lastName: t.lastName.trim(), dob: t.dob, gender: t.gender,
            ...(t.passportNumber.trim() ? { passportNumber: t.passportNumber.trim() } : {}),
            ...(t.nomineeName.trim() ? { nominee: { name: t.nomineeName.trim(), relationship: t.nomineeRelationship } } : {}),
          })),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.reference && d.key) {
        window.location.href = `/insurance/booking?ref=${encodeURIComponent(d.reference)}&key=${encodeURIComponent(d.key)}`;
        return;
      }
      setBookError(d.error ?? (res.status === 400 ? "Please check the traveller details." : "We couldn't issue your policy. Please try again."));
    } catch {
      setBookError("We couldn't reach the server. Please try again.");
    } finally {
      setBooking(false);
    }
  }

  const tripLabel = useMemo(() => {
    if (isStudent || isAmt) return `${startDate} · ${duration} days`;
    return `${startDate} → ${endDate}`;
  }, [isStudent, isAmt, startDate, endDate, duration]);

  if (configError) return <main className="ts-page"><div className="ts-error">{configError}</div></main>;
  if (!config) return <main className="ts-page"><p style={{ color: "#64748b" }}>Loading…</p></main>;
  if (!config.enabled) {
    return <main className="ts-page"><div className="ts-card"><h2>Travel insurance</h2><p style={{ color: "#64748b", margin: 0 }}>Travel insurance is not available right now. Please check back soon.</p></div></main>;
  }

  return (
    <main className="ts-page">
      <div className="ts-hero">
        <div>
          <h1>Travel insurance</h1>
          <p>TripSafe cover for medical emergencies, baggage and trip disruption — policy issued instantly by email.</p>
        </div>
        <span className="ts-badge">Powered by TripSafe</span>
      </div>

      <form className="ts-card" onSubmit={search}>
        {journey === "EMBEDDED" ? (
          <div className="ts-note" style={{ marginTop: 0, marginBottom: 14 }}>Cover for your flight: dates follow your itinerary. <button type="button" className="ts-btn ts-btn-ghost ts-btn-small" onClick={() => setJourney("STANDALONE")}>Choose another plan type</button></div>
        ) : (
          <div className="ts-tabs" role="group" aria-label="Plan type">
            {JOURNEYS.map((j) => (
              <button key={j.key} type="button" className="ts-tab" aria-pressed={journey === j.key} title={j.hint} onClick={() => setJourney(j.key)}>{j.label}</button>
            ))}
          </div>
        )}

        {!isDomestic && (
          <div style={{ marginBottom: 14 }}>
            {!isStudent && !isAmt && (
              <div className="ts-row" style={{ marginBottom: 8 }}>
                <button type="button" className="ts-tab" aria-pressed={destType === "COUNTRY"} onClick={() => setDestType("COUNTRY")}>Countries</button>
                <button type="button" className="ts-tab" aria-pressed={destType === "REGION"} onClick={() => setDestType("REGION")}>Regions</button>
              </div>
            )}
            {destType === "COUNTRY" ? (
              <label className="ts-field">
                <span>{isStudent ? "Country of study" : "Countries you'll visit"}</span>
                <select value={countryPick} onChange={(e) => addCountry(e.target.value)}>
                  <option value="">{isStudent ? "Choose a country" : "Add a country"}</option>
                  {COUNTRIES.filter((c) => c.code !== "IN").map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
              </label>
            ) : (
              <div className="ts-field"><span>{isAmt ? "Regions covered" : "Regions you'll visit"}</span></div>
            )}
            <div className="ts-chips">
              {destType === "REGION" && config.regions.map((r) => (
                <button key={r.key} type="button" className="ts-chip ts-chip-toggle" aria-pressed={destinations.some((d) => d.key === r.key)} onClick={() => toggleRegion(r.key)}>{r.name}</button>
              ))}
              {destType === "COUNTRY" && destinations.filter((d) => d.type === "COUNTRY").map((d) => (
                <span key={d.key} className="ts-chip">{nameOf(d.key)}<button type="button" aria-label={`Remove ${nameOf(d.key)}`} onClick={() => setDestinations((ds) => ds.filter((x) => x.key !== d.key))}>×</button></span>
              ))}
            </div>
          </div>
        )}

        <div className="ts-grid">
          <label className="ts-field">
            <span>{isAmt ? "Cover starts" : isStudent ? "Course starts" : "Trip starts"}</span>
            <input type="date" required min={today()} value={startDate} onChange={(e) => {
              setStartDate(e.target.value);
              if (endDate < e.target.value) setEndDate(e.target.value);
            }} />
          </label>
          {usesEndDate && (
            <label className="ts-field">
              <span>Trip ends</span>
              <input type="date" required min={startDate} max={maxEnd} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              <small>{isDomestic ? "Up to 30 days" : "Up to 180 days"}</small>
            </label>
          )}
          {isStudent && (
            <label className="ts-field">
              <span>Cover length</span>
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {config.studentDurations.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
          )}
          {isAmt && (
            <label className="ts-field">
              <span>Longest single trip</span>
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {config.amtDurations.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
              <small>Covers unlimited trips for a year</small>
            </label>
          )}
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="ts-field"><span>Travellers’ dates of birth {isStudent ? "(ages 18–45)" : "(up to age 70)"}</span></div>
          <div className="ts-grid" style={{ marginTop: 6 }}>
            {dobs.map((dob, i) => (
              <div key={i} className="ts-row" style={{ flexWrap: "nowrap" }}>
                <label className="ts-field" style={{ flex: 1 }}>
                  <input type="date" required max={today()} aria-label={`Traveller ${i + 1} date of birth`} value={dob} onChange={(e) => setDobs((ds) => ds.map((d, j) => (j === i ? e.target.value : d)))} />
                </label>
                {dobs.length > 1 && <button type="button" className="ts-btn ts-btn-ghost ts-btn-small" aria-label={`Remove traveller ${i + 1}`} onClick={() => setDobs((ds) => ds.filter((_, j) => j !== i))}>×</button>}
              </div>
            ))}
          </div>
          {dobs.length < config.maxTravellers && (
            <button type="button" className="ts-btn ts-btn-ghost ts-btn-small" style={{ marginTop: 8 }} onClick={() => setDobs((ds) => [...ds, ""])}>+ Add traveller</button>
          )}
        </div>

        <div className="ts-row" style={{ marginTop: 16 }}>
          <button className="ts-btn" disabled={searching}>{searching ? "Finding plans…" : "Show plans"}</button>
        </div>
        {searchError && <div className="ts-error">{searchError}</div>}
      </form>

      {products.length > 0 && (
        <section className="ts-plans" aria-label="Insurance plans">
          {products.map((p) => (
            <article key={p.productId} className="ts-plan" data-selected={selected?.productId === p.productId}>
              <div>
                <h3>{p.planCoverage} cover</h3>
                <div className="ts-plan-meta">{[p.regionName, p.insuranceProvider, p.planType !== "REGULAR" ? p.planType : ""].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="ts-plan-price">
                <strong>{money(p.totalFare)}</strong>
                <small>for {dobs.length} traveller{dobs.length > 1 ? "s" : ""} · {tripLabel}</small>
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="ts-btn ts-btn-small" onClick={() => { setSelected(p); setTimeout(() => document.getElementById("ts-travellers")?.scrollIntoView({ behavior: "smooth" }), 50); }}>
                    {selected?.productId === p.productId ? "Selected" : "Select"}
                  </button>
                </div>
              </div>
              {p.banners.length > 0 && <ul>{p.banners.map((b) => <li key={b}>{b}</li>)}</ul>}
              {p.benefits.length > 0 && (
                <details>
                  <summary>All benefits ({p.benefits.length})</summary>
                  {p.benefits.map((b, i) => (
                    <div key={`${b.name}-${i}`} className="ts-benefit"><b>{b.name}{b.sumInsured ? ` — ${b.sumInsured}` : ""}</b>{b.description}</div>
                  ))}
                </details>
              )}
            </article>
          ))}
        </section>
      )}

      {selected && (
        <form id="ts-travellers" className="ts-card" style={{ marginTop: 16 }} onSubmit={book}>
          <h2>Traveller details · {selected.planCoverage} cover · {money(selected.totalFare)}</h2>
          {travellers.map((t, i) => (
            <div key={i} className="ts-traveller">
              <h3>Traveller {i + 1} · born {t.dob}</h3>
              <div className="ts-grid">
                <label className="ts-field"><span>Title</span>
                  <select value={t.title} onChange={(e) => updateTraveller(i, { title: e.target.value, gender: ["MRS", "MS", "MISS"].includes(e.target.value) ? "Female" : "Male" })}>
                    {["MR", "MRS", "MS", "MSTR", "MISS"].map((x) => <option key={x}>{x}</option>)}
                  </select>
                </label>
                <label className="ts-field"><span>First name (as on passport)</span><input required value={t.firstName} onChange={(e) => updateTraveller(i, { firstName: e.target.value })} /></label>
                <label className="ts-field"><span>Last name</span><input required value={t.lastName} onChange={(e) => updateTraveller(i, { lastName: e.target.value })} /></label>
                <label className="ts-field"><span>Gender</span>
                  <select value={t.gender} onChange={(e) => updateTraveller(i, { gender: e.target.value })}><option>Male</option><option>Female</option></select>
                </label>
                {!isDomestic && <label className="ts-field"><span>Passport number</span><input value={t.passportNumber} onChange={(e) => updateTraveller(i, { passportNumber: e.target.value })} /></label>}
                <label className="ts-field"><span>Nominee name (optional)</span><input value={t.nomineeName} onChange={(e) => updateTraveller(i, { nomineeName: e.target.value })} /></label>
                {t.nomineeName.trim() && (
                  <label className="ts-field"><span>Nominee relationship</span>
                    <select value={t.nomineeRelationship} onChange={(e) => updateTraveller(i, { nomineeRelationship: e.target.value })}>
                      {config.nomineeRelationships.map((r) => <option key={r} value={r}>{RELATION_LABEL(r)}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
          ))}
          <div className="ts-grid" style={{ marginTop: 14 }}>
            <label className="ts-field"><span>Email for the policy</span><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="ts-field"><span>Mobile number</span><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          </div>
          {!config.instantIssue && <div className="ts-note">We reserve your plan now and issue the policy as soon as payment is received.</div>}
          <div className="ts-row" style={{ marginTop: 16 }}>
            <button className="ts-btn" disabled={booking}>{booking ? "Issuing policy…" : config.instantIssue ? `Get policy · ${money(selected.totalFare)}` : `Reserve · ${money(selected.totalFare)}`}</button>
          </div>
          {bookError && <div className="ts-error">{bookError}</div>}
        </form>
      )}
    </main>
  );
}

export default function InsurancePage() {
  return <Suspense fallback={<main className="ts-page"><p style={{ color: "#64748b" }}>Loading…</p></main>}><InsurancePageInner /></Suspense>;
}
