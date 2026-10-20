"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, fmtTime, money, QUOTE_DRAFT } from "../../../lib/api";
import { fareLabel, groupFareOptions, optionPerks } from "../../../lib/fare-options";

type Fare = {
  id: string; supplier: string; airline: string; airlineName: string; flightNumber: string; origin: string; destination: string;
  departureTime: string; arrivalTime: string; duration: number; stops: number; totalFare: number; displayPrice?: number;
  netPrice?: number; sellingPrice?: number; currency: string; isRefundable: boolean; baggage?: { cabin?: string; checked?: string };
  tripKey?: string; legIndex?: number; fareIdentifier?: string; sri?: string; msri?: string[]; isBookable?: boolean;
  mealIncluded?: boolean; refundableType?: number; fareClass?: string; segments?: { flightNumber?: string }[];
};
type Leg = { origin: string; destination: string; date: string };

const AIRPORTS = ["COK", "CCJ", "TRV", "CNN", "IXE", "BOM", "DEL", "BLR", "MAA", "HYD", "CCU", "GOI", "AMD", "DXB", "AUH", "SHJ", "RKT", "FJR", "AAN", "DOH", "MCT", "BAH", "KWI", "RUH", "JED", "DMM", "MED", "SIN", "KUL", "BKK", "LHR", "CMB", "MLE", "KTM"];
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const dur = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;


export default function SearchPage() {
  const [tripType, setTripType] = useState<"ONEWAY" | "ROUNDTRIP" | "MULTICITY">("ONEWAY");
  const [legs, setLegs] = useState<Leg[]>([{ origin: "", destination: "", date: addDays(7) }, { origin: "", destination: "", date: addDays(14) }]);
  const [returnDate, setReturnDate] = useState(addDays(14));
  const [pax, setPax] = useState({ adults: 1, children: 0, infants: 0 });
  const [cabinClass, setCabin] = useState("ECONOMY");
  const [fareType, setFareType] = useState("REGULAR");
  const [directOnly, setDirectOnly] = useState(false);
  const [sort, setSort] = useState<"price" | "departure" | "duration">("price");
  const [fares, setFares] = useState<Fare[] | null>(null);
  const [searchId, setSearchId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [picks, setPicks] = useState<Record<number, Fare | undefined>>({});
  const [quoted, setQuoted] = useState<string[]>([]);

  useEffect(() => {
    try { setQuoted((JSON.parse(localStorage.getItem(QUOTE_DRAFT) ?? "[]") as Fare[]).map((f) => f.id)); } catch {}
    const q = new URLSearchParams(window.location.search);
    if (q.get("from") && q.get("to")) setLegs((l) => [{ origin: q.get("from")!.toUpperCase(), destination: q.get("to")!.toUpperCase(), date: q.get("date") ?? l[0].date }, l[1]]);
  }, []);

  const seats = pax.adults + pax.children;
  const group = seats > 9;

  async function search(e: FormEvent) {
    e.preventDefault();
    if (group) return;
    const first = legs[0];
    if (!/^[A-Za-z]{3}$/.test(first.origin) || !/^[A-Za-z]{3}$/.test(first.destination)) { setError("Enter 3-letter airport codes (e.g. COK, DXB)."); return; }
    setLoading(true); setError(""); setFares(null); setPicks({});
    try {
      const body: Record<string, unknown> = {
        origin: first.origin.toUpperCase(), destination: (tripType === "MULTICITY" ? legs[legs.length - 1] : first).destination.toUpperCase(),
        departureDate: first.date, ...pax, cabinClass, tripType, ...(fareType !== "REGULAR" ? { fareType } : {}),
        ...(tripType === "ROUNDTRIP" ? { returnDate } : {}),
        ...(tripType === "MULTICITY" ? { legs: legs.map((l) => ({ origin: l.origin.toUpperCase(), destination: l.destination.toUpperCase(), departureDate: l.date })) } : {}),
      };
      const d = await api<{ fares: Fare[]; searchId: string }>("/api/search", { json: body });
      setFares(d.fares.filter((f) => f.isBookable !== false));
      setSearchId(d.searchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  // Combined fares cover the whole journey; otherwise one fare per leg.
  const combos = useMemo(() => (fares ?? []).filter((f) => f.tripKey === "COMBO"), [fares]);
  const legCount = tripType === "ONEWAY" ? 1 : tripType === "ROUNDTRIP" ? 2 : legs.length;
  const byLeg = useMemo(() => {
    const out: Fare[][] = Array.from({ length: legCount }, () => []);
    for (const f of fares ?? []) {
      if (f.tripKey === "COMBO") continue;
      const i = f.legIndex ?? (f.tripKey === "RETURN" ? 1 : 0);
      if (out[i]) out[i].push(f);
    }
    return out;
  }, [fares, legCount]);

  const shown = (list: Fare[], leg: number) => {
    let l = list.filter((f) => !directOnly || f.stops === 0);
    // Special return fares only pair with the matching onward fare.
    const onward = picks[0];
    if (leg === 1 && onward) l = l.filter((f) => !f.msri?.length || (onward.sri && f.msri.includes(onward.sri)));
    if (leg === 1 && !onward) l = l.filter((f) => !f.msri?.length);
    return [...l].sort((a, b) => sort === "price" ? price(a) - price(b) : sort === "duration" ? a.duration - b.duration : a.departureTime.localeCompare(b.departureTime)).slice(0, 80);
  };

  function toggleQuote(f: Fare) {
    let list: Fare[] = [];
    try { list = JSON.parse(localStorage.getItem(QUOTE_DRAFT) ?? "[]"); } catch {}
    list = list.some((x) => x.id === f.id) ? list.filter((x) => x.id !== f.id) : [...list, f].slice(-6);
    localStorage.setItem(QUOTE_DRAFT, JSON.stringify(list));
    setQuoted(list.map((x) => x.id));
  }

  function book(chosen: Fare[]) {
    const first = chosen[0];
    const total = chosen.reduce((s, f) => s + price(f), 0);
    const selling = chosen.reduce((s, f) => s + (f.sellingPrice ?? price(f)), 0);
    sessionStorage.setItem("agent_checkout", JSON.stringify({ fares: chosen, total, selling, searchId, pax, tripType }));
    const q = new URLSearchParams({
      priceIds: chosen.map((f) => f.id).join(","), supplier: first.supplier, from: legs[0].origin.toUpperCase(),
      to: (tripType === "MULTICITY" ? legs[legs.length - 1] : legs[0]).destination.toUpperCase(),
      dep: first.departureTime, tripType, adults: String(pax.adults), children: String(pax.children), infants: String(pax.infants),
      ...(searchId ? { sid: searchId } : {}),
    });
    window.location.assign(`/checkout?${q}`);
  }

  const multiReady = byLeg.every((_, i) => picks[i]);
  const cur = fares?.[0]?.currency ?? "INR";

  return (
    <div>
      <div className="page-head"><div><h1>Flights</h1><p>Agent net prices — your selling price includes your markup.</p></div><a className="btn" href="/quotes">📝 Quote draft ({quoted.length})</a></div>
      <form className="card stack" onSubmit={search}>
        <div className="tabs" role="tablist">
          {(["ONEWAY", "ROUNDTRIP", "MULTICITY"] as const).map((t) => (
            <button type="button" key={t} className={tripType === t ? "on" : ""} onClick={() => setTripType(t)}>{t === "ONEWAY" ? "One way" : t === "ROUNDTRIP" ? "Round trip" : "Multi-city"}</button>
          ))}
        </div>
        {(tripType === "MULTICITY" ? legs : legs.slice(0, 1)).map((l, i) => (
          <div className="grid g4" key={i}>
            <label className="f">From<input list="airports" required value={l.origin} maxLength={3} onChange={(e) => setLegs((ls) => ls.map((x, n) => n === i ? { ...x, origin: e.target.value.toUpperCase() } : x))} placeholder="COK" /></label>
            <label className="f">To<input list="airports" required value={l.destination} maxLength={3} onChange={(e) => setLegs((ls) => ls.map((x, n) => n === i ? { ...x, destination: e.target.value.toUpperCase() } : n === i + 1 && !x.origin ? { ...x, origin: e.target.value.toUpperCase() } : x))} placeholder="DXB" /></label>
            <label className="f">{tripType === "MULTICITY" ? `Flight ${i + 1} date` : "Departure"}<input type="date" required min={addDays(0)} value={l.date} onChange={(e) => setLegs((ls) => ls.map((x, n) => n === i ? { ...x, date: e.target.value } : x))} /></label>
            {tripType === "ROUNDTRIP" && i === 0 ? <label className="f">Return<input type="date" required min={l.date} value={returnDate} onChange={(e) => setReturnDate(e.target.value)} /></label>
              : tripType === "MULTICITY" && legs.length > 2 ? <div className="row" style={{ alignItems: "flex-end" }}><button type="button" className="btn sm danger" onClick={() => setLegs((ls) => ls.filter((_, n) => n !== i))}>Remove</button></div> : <div />}
          </div>
        ))}
        {tripType === "MULTICITY" && legs.length < 6 && <button type="button" className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setLegs((ls) => [...ls, { origin: ls[ls.length - 1].destination, destination: "", date: ls[ls.length - 1].date }])}>+ Add flight</button>}
        <datalist id="airports">{AIRPORTS.map((a) => <option key={a} value={a} />)}</datalist>
        <div className="grid g4">
          <label className="f">Adults (12+)<input type="number" min={1} max={30} value={pax.adults} onChange={(e) => setPax((p) => ({ ...p, adults: Math.max(1, Number(e.target.value) || 1) }))} /></label>
          <label className="f">Children (2–11)<input type="number" min={0} max={20} value={pax.children} onChange={(e) => setPax((p) => ({ ...p, children: Math.max(0, Number(e.target.value) || 0) }))} /></label>
          <label className="f">Infants (under 2)<input type="number" min={0} max={pax.adults} value={pax.infants} onChange={(e) => setPax((p) => ({ ...p, infants: Math.min(p.adults, Math.max(0, Number(e.target.value) || 0)) }))} /></label>
          <label className="f">Cabin
            <select value={cabinClass} onChange={(e) => setCabin(e.target.value)}><option value="ECONOMY">Economy</option><option value="PREMIUM_ECONOMY">Premium economy</option><option value="BUSINESS">Business</option><option value="FIRST">First</option></select>
          </label>
        </div>
        <div className="row between">
          <div className="row">
            <label className="f" style={{ flexDirection: "row", alignItems: "center" }}>Fare type&nbsp;
              <select className="in" style={{ width: "auto" }} value={fareType} onChange={(e) => setFareType(e.target.value)}><option value="REGULAR">Regular</option><option value="STUDENT">Student</option><option value="SENIOR_CITIZEN">Senior citizen</option></select>
            </label>
            <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={directOnly} onChange={(e) => setDirectOnly(e.target.checked)} /> Direct flights only</label>
          </div>
          {group
            ? <a className="btn primary" href={`/requests/new?type=GROUP&from=${legs[0].origin}&to=${legs[0].destination}&date=${legs[0].date}&pax=${seats}`}>👥 Request group fare ({seats} seats)</a>
            : <button className="btn primary" disabled={loading}>{loading ? <><span className="spin" /> Searching…</> : "Search flights"}</button>}
        </div>
        {group && <p className="small muted" style={{ margin: 0 }}>Airlines sell up to 9 seats per booking. For 10 or more travellers, request a group fare — our team replies with a quote.</p>}
      </form>

      {error && <div className="banner bad">{error}</div>}
      {fares && fares.length === 0 && <div className="card empty">No flights found. Try another date or nearby airport.</div>}
      {fares && fares.length > 0 && (
        <>
          <div className="row between" style={{ marginBottom: 10 }}>
            <span className="muted small">{fares.length} fares · prices for {pax.adults + pax.children + pax.infants} traveller{pax.adults + pax.children + pax.infants > 1 ? "s" : ""}</span>
            <div className="tabs" style={{ margin: 0 }}>
              {(["price", "departure", "duration"] as const).map((s) => <button type="button" key={s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>{s === "price" ? "Cheapest" : s === "departure" ? "Earliest" : "Fastest"}</button>)}
            </div>
          </div>

          {combos.length > 0 && (
            <div className="card flush">
              <div style={{ padding: "12px 16px 0" }}><h2>Complete journey fares</h2></div>
              {groupFareOptions(shown(combos, -1)).map((g) => <FareRow key={g.key} f={g.lead} options={g.options} quoted={quoted} onQuote={toggleQuote} action={(f) => <button className="btn primary sm" onClick={() => book([f])}>Book</button>} />)}
            </div>
          )}

          {byLeg.map((list, i) => list.length > 0 && (
            <div className="card flush" key={i}>
              <div className="row between" style={{ padding: "12px 16px 0" }}>
                <h2>{legCount === 1 ? "Flights" : `${i === 0 ? "Onward" : tripType === "ROUNDTRIP" ? "Return" : `Flight ${i + 1}`}: ${list[0]?.origin} → ${list[0]?.destination}`}</h2>
                {picks[i] && <span className="badge b-green">Selected {picks[i].flightNumber}</span>}
              </div>
              {groupFareOptions(shown(list, i)).map((g) => (
                <FareRow key={g.key} f={g.lead} options={g.options} pickedId={picks[i]?.id} quoted={quoted} onQuote={toggleQuote}
                  action={(f) => legCount === 1
                    ? <button className="btn primary sm" onClick={() => book([f])}>Book</button>
                    : <button className={`btn sm ${picks[i]?.id === f.id ? "dark" : ""}`} onClick={() => setPicks((p) => ({ ...p, [i]: f, ...(i === 0 ? { 1: undefined } : {}) }))}>{picks[i]?.id === f.id ? "Selected" : "Select"}</button>} />
              ))}
            </div>
          ))}

          {legCount > 1 && combos.length === 0 && (
            <div className="card row between" style={{ position: "sticky", bottom: 70, zIndex: 5 }}>
              <span>{multiReady ? <>Total <b>{money(Object.values(picks).reduce((s, f) => s + (f ? price(f) : 0), 0), cur)}</b> net</> : "Select a flight for each leg"}</span>
              <button className="btn primary" disabled={!multiReady} onClick={() => book(byLeg.map((_, i) => picks[i]!))}>Continue to book</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const price = (f: Fare) => f.netPrice ?? f.displayPrice ?? f.totalFare;

function FareRow({ f, options, action, pickedId, quoted, onQuote }: { f: Fare; options: Fare[]; action: (f: Fare) => React.ReactNode; pickedId?: string; quoted: string[]; onQuote: (f: Fare) => void }) {
  const [open, setOpen] = useState(false);
  const picked = options.some((o) => o.id === pickedId);
  return (
    <div style={{ borderBottom: "1px solid #f1f5f9" }}>
      <div className={`fare${picked ? " picked" : ""}`} style={{ borderBottom: 0 }}>
        <div className="air"><b>{f.airlineName || f.airline}</b><small>{f.flightNumber}</small></div>
        <div className="times">
          <div><b>{fmtTime(f.departureTime)}</b><div className="small muted">{f.origin}</div></div>
          <div className="line">{dur(f.duration)} · {f.stops === 0 ? "Direct" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`}</div>
          <div><b>{fmtTime(f.arrivalTime)}</b><div className="small muted">{f.destination}</div></div>
        </div>
        <div className="chips">
          <span className="chip">{fareLabel(f.fareIdentifier || f.fareClass)}</span>
          {f.baggage?.checked && <span className="chip">🧳 {f.baggage.checked}</span>}
          <span className="chip">{f.isRefundable ? "Refundable" : "Non-refundable"}</span>
          <button type="button" className="chip" style={{ border: 0, cursor: "pointer", background: quoted.includes(f.id) ? "#dcfce7" : undefined }} onClick={() => onQuote(f)}>{quoted.includes(f.id) ? "✓ In quote" : "+ Quote"}</button>
        </div>
        <div className="price">
          {options.length > 1 && <small>from</small>}
          <b>{money(price(f), f.currency)}</b>
          <small>Net</small>
          {f.sellingPrice && f.sellingPrice !== price(f) && <span className="sell">Sell {money(f.sellingPrice, f.currency)}</span>}
          <div style={{ marginTop: 6 }}>{options.length > 1 ? <button className="btn sm" onClick={() => setOpen((v) => !v)}>{open ? "Hide" : `${options.length} fare options`}</button> : action(f)}</div>
        </div>
      </div>
      {open && options.length > 1 && (
        <div className="table-wrap" style={{ padding: "0 16px 12px" }}>
          <table className="t">
            <thead><tr><th>Fare</th><th>Check-in</th><th>Cabin</th><th>Meal</th><th>Refund</th><th className="num">Net</th><th className="num">Sell</th><th /></tr></thead>
            <tbody>{options.map((o) => {
              const p = optionPerks(o);
              return (
                <tr key={o.id} style={o.id === pickedId ? { background: "#fff7f7" } : undefined}>
                  <td><b>{fareLabel(o.fareIdentifier || o.fareClass)}</b></td>
                  <td>{p.checked || <span className="muted">None</span>}</td>
                  <td>{p.cabin || "—"}</td>
                  <td>{p.meal || "—"}</td>
                  <td>{p.refund}</td>
                  <td className="num">{money(price(o), o.currency)}</td>
                  <td className="num ok-text">{o.sellingPrice ? money(o.sellingPrice, o.currency) : ""}</td>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="btn ghost sm" onClick={() => onQuote(o)}>{quoted.includes(o.id) ? "✓ Quote" : "+ Quote"}</button> {action(o)}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
