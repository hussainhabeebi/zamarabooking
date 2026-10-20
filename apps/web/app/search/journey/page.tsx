"use client";

// Round trip / multi-city results (TripJack Flights v2):
//  • Domestic return → ONWARD + RETURN lists: pick one fare per leg (2 priceIds).
//  • Domestic multi-city → indexed legs "0".."5": one fare per leg.
//  • International return / multi-city → COMBO: one combined fare (1 priceId).
// Special Return: when the chosen onward fare is SPECIAL_RETURN, the return leg
// only offers SPECIAL_RETURN fares whose msri contains the onward sri.

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { readPrefCurrency } from "../../lib/currency-pref";
import { convertInr, fetchFxRates, formatIn, type FxRates } from "../../lib/fx";

type Segment = { airline: string; airlineName: string; flightNumber: string; origin: string; destination: string; departureTime: string; arrivalTime: string; duration: number; isReturn?: boolean };
type Fare = {
  id: string; supplier: string; airline: string; airlineName: string; flightNumber: string;
  origin: string; destination: string; departureTime: string; arrivalTime: string; duration: number; stops: number;
  totalFare: number; displayPrice?: number; currency: string; isRefundable: boolean;
  baggage?: { cabin?: string; checked?: string };
  tripKey?: string; legIndex?: number; fareIdentifier?: string; sri?: string; msri?: string[]; segments?: Segment[];
};

const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.flypoomas.com";
const FARE_LABEL: Record<string, string> = {
  PUBLISHED: "Published", SPECIAL_RETURN: "Special Return", TJ_FLEX: "Flex (free cancellation)",
  STUDENT: "Student fare", SENIOR_CITIZEN: "Senior citizen fare",
};

const money = (n: number, cur: string) => {
  try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 0 }).format(n); }
  catch { return `${cur} ${Math.round(n).toLocaleString()}`; }
};
const time = (s: string) => /T(\d{2}:\d{2})/.exec(s)?.[1] ?? s;
const day = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : s;
};
const hm = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`;
const price = (f: Fare) => f.displayPrice ?? f.totalFare;

export default function JourneyPage() {
  return <Suspense fallback={<main className="page-container" style={{ padding: 24 }}>Loading…</main>}><Journey /></Suspense>;
}

function parseLegs(q: URLSearchParams) {
  const raw = q.get("legs");
  if (raw) {
    return raw.split(",").map((l) => {
      const m = /^([A-Z]{3})-([A-Z]{3})-(\d{4}-\d{2}-\d{2})$/.exec(l.trim().toUpperCase());
      return m ? { origin: m[1], destination: m[2], departureDate: m[3] } : null;
    }).filter(Boolean) as { origin: string; destination: string; departureDate: string }[];
  }
  const o = q.get("origin") ?? "", d = q.get("destination") ?? "";
  const legs = [{ origin: o, destination: d, departureDate: q.get("departureDate") ?? "" }];
  if (q.get("returnDate")) legs.push({ origin: d, destination: o, departureDate: q.get("returnDate")! });
  return legs;
}

function Journey() {
  const q = useSearchParams();
  const legs = useMemo(() => parseLegs(new URLSearchParams(q.toString())), [q]);
  const tripType = q.get("tripType") === "MULTICITY" ? "MULTICITY" : "ROUNDTRIP";
  const adults = Math.max(1, Number(q.get("adults")) || 1);
  const children = Number(q.get("children")) || 0;
  const infants = Number(q.get("infants")) || 0;
  const fareType = q.get("fareType") ?? "";
  const directOnly = q.get("stops") === "0";

  const [fares, setFares] = useState<Fare[] | null>(null);
  // Prices in the visitor's chosen currency (automatic exchange rates); INR fares otherwise.
  const [fx, setFx] = useState<{ cur: string; rates: FxRates }>({ cur: "INR", rates: {} });
  useEffect(() => {
    const cur = readPrefCurrency();
    if (cur && cur !== "INR") fetchFxRates(API).then((rates) => setFx({ cur, rates }));
  }, []);
  const show = (n: number, cur: string) => {
    const v = cur === "INR" && fx.cur !== "INR" ? convertInr(n, fx.cur, fx.rates) : null;
    return v === null ? money(n, cur) : formatIn(v, fx.cur);
  };
  const [searchId, setSearchId] = useState<string>();
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Record<string, Fare>>({});
  const [comboPick, setComboPick] = useState<Fare | null>(null);
  const [limit, setLimit] = useState<Record<string, number>>({});

  useEffect(() => {
    const first = legs[0];
    if (!first?.origin) { setError("Missing journey details. Please search again."); return; }
    const c = new AbortController();
    fetch(`${API}/api/search`, {
      method: "POST", signal: c.signal,
      headers: { "Content-Type": "application/json", "x-tenant-slug": "poomas" },
      body: JSON.stringify({
        origin: first.origin, destination: tripType === "MULTICITY" ? legs[legs.length - 1].destination : first.destination,
        departureDate: first.departureDate, ...(tripType === "ROUNDTRIP" && legs[1] ? { returnDate: legs[1].departureDate } : {}),
        ...(tripType === "MULTICITY" ? { legs } : {}),
        adults, children, infants, cabinClass: q.get("cabinClass") ?? "ECONOMY", tripType,
        ...(fareType ? { fareType } : {}), ...((readPrefCurrency() ?? q.get("currency")) ? { currency: readPrefCurrency() ?? q.get("currency") } : {}),
      }),
    })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error((typeof d.error === "string" ? d.error : d.error?.issues?.[0]?.message) ?? `Search failed (${r.status})`); return d; })
      .then((d) => { setFares((d.fares ?? []).filter((f: Fare) => f.supplier === "TRIPJACK" && f.tripKey)); setSearchId(d.searchId); })
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); });
    return () => c.abort();
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const byKey: Record<string, Fare[]> = {};
    for (const f of fares ?? []) {
      if (directOnly && f.stops > 0 && f.tripKey !== "COMBO") continue;
      (byKey[f.tripKey!] ??= []).push(f);
    }
    for (const k of Object.keys(byKey)) byKey[k].sort((a, b) => price(a) - price(b));
    return byKey;
  }, [fares, directOnly]);

  const combo = groups.COMBO ?? [];
  const legKeys = Object.keys(groups).filter((k) => k !== "COMBO")
    .sort((a, b) => (a === "ONWARD" ? -1 : b === "ONWARD" ? 1 : a === "RETURN" ? 1 : b === "RETURN" ? -1 : Number(a) - Number(b)));

  // Special Return pairing on the return leg.
  const optionsFor = (key: string) => {
    const list = groups[key] ?? [];
    if (key !== "RETURN") return list;
    const onward = picked.ONWARD;
    if (!onward) return list.filter((f) => f.fareIdentifier !== "SPECIAL_RETURN");
    if (onward.fareIdentifier === "SPECIAL_RETURN") return list.filter((f) => f.fareIdentifier === "SPECIAL_RETURN" && onward.sri && f.msri?.includes(onward.sri));
    return list.filter((f) => f.fareIdentifier !== "SPECIAL_RETURN");
  };

  const pick = (key: string, f: Fare) => setPicked((p) => {
    const next = { ...p, [key]: f };
    // A new onward choice can invalidate the paired return fare.
    if (key === "ONWARD" && p.RETURN) {
      const r = p.RETURN;
      const ok = f.fareIdentifier === "SPECIAL_RETURN" ? r.fareIdentifier === "SPECIAL_RETURN" && !!f.sri && !!r.msri?.includes(f.sri) : r.fareIdentifier !== "SPECIAL_RETURN";
      if (!ok) delete next.RETURN;
    }
    return next;
  });

  const legLabel = (key: string, i: number) => (key === "ONWARD" ? "departure" : key === "RETURN" ? "return" : `flight ${i + 1}`);
  const nextMissing = comboPick ? null : legKeys.find((k) => !picked[k]) ?? null;
  const goTo = (key: string) => {
    window.setTimeout(() => document.getElementById(`leg-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  // After choosing one leg, bring the next leg to be chosen into view.
  const pickAndAdvance = (key: string, f: Fare) => {
    pick(key, f);
    setComboPick(null);
    const next = legKeys.find((k) => k !== key && !picked[k]);
    if (next) goTo(next);
  };

  const selection: Fare[] = comboPick ? [comboPick] : legKeys.every((k) => picked[k]) ? legKeys.map((k) => picked[k]) : [];
  const total = selection.reduce((n, f) => n + price(f), 0);
  const currency = selection[0]?.currency ?? fares?.[0]?.currency ?? "INR";

  function continueToBook() {
    if (!selection.length) return;
    const firstFare = selection[0];
    const lastFare = selection[selection.length - 1];
    const summary = selection.map((f) => ({ id: f.id, tripKey: f.tripKey, airlineName: f.airlineName, flightNumber: f.flightNumber, origin: f.origin, destination: f.destination, departureTime: f.departureTime, arrivalTime: f.arrivalTime, stops: f.stops, fareIdentifier: f.fareIdentifier, segments: f.segments }));
    try { sessionStorage.setItem(`journey:${selection.map((f) => f.id).join(",")}`, JSON.stringify(summary)); } catch {}
    const p = new URLSearchParams({
      fareId: firstFare.id, priceIds: selection.map((f) => f.id).join(","), supplier: "TRIPJACK", tripType,
      adults: String(adults), children: String(children), infants: String(infants),
      airline: firstFare.airlineName, fn: firstFare.flightNumber,
      from: legs[0].origin, to: tripType === "ROUNDTRIP" ? legs[0].destination : legs[legs.length - 1].destination,
      dep: firstFare.departureTime, arr: lastFare.arrivalTime, dur: String(firstFare.duration ?? 0), stops: String(firstFare.stops ?? 0),
      price: String(Math.round(total * 100) / 100), cur: currency, ref: selection.every((f) => f.isRefundable) ? "1" : "0",
      bag: firstFare.baggage?.checked ?? "", ...(searchId ? { sid: searchId } : {}), ...(q.get("pc") ? { pc: q.get("pc")! } : {}),
    });
    window.location.href = `/book?${p}`;
  }

  const title = tripType === "ROUNDTRIP"
    ? `${legs[0]?.origin} ⇄ ${legs[0]?.destination}`
    : legs.map((l) => l.origin).concat(legs[legs.length - 1]?.destination ?? "").join(" → ");

  return (
    <main className="page-container" style={{ paddingTop: 16, paddingBottom: 120 }}>
      <h1 style={{ fontSize: "clamp(18px,4vw,24px)", fontWeight: 800, margin: "0 0 4px" }}>{title}</h1>
      <p style={{ margin: "0 0 12px", color: "#667085", fontSize: 14 }}>
        {legs.map((l) => day(l.departureDate)).join(" · ")} · {adults} adult{adults > 1 ? "s" : ""}{children ? `, ${children} child` : ""}{infants ? `, ${infants} infant` : ""}
        {fareType ? ` · ${FARE_LABEL[fareType] ?? fareType}` : ""}
      </p>
      <a href="/" style={{ fontSize: 13, color: "#E31E24", fontWeight: 600, textDecoration: "none" }}>‹ New search</a>

      {error && <div style={errBox}>{error}</div>}
      {!fares && !error && <p style={{ padding: "40px 0", textAlign: "center", color: "#667085" }}>Searching live fares for every leg…</p>}
      {fares && !fares.length && !error && <p style={{ padding: "40px 0", textAlign: "center", color: "#667085" }}>No flights found for this journey. Try other dates.</p>}

      {combo.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <h2 style={h2}>Complete journey fares</h2>
          <p style={muted}>One fare covers every flight in this journey.</p>
          <div style={{ display: "grid", gap: 10 }}>
            {combo.slice(0, limit.COMBO ?? 20).map((f) => (
              <FareRow show={show} travellers={adults + children + infants} key={f.id} fare={f} selected={comboPick?.id === f.id} onPick={() => { setComboPick(f); setPicked({}); }} showSegments />
            ))}
          </div>
          {combo.length > (limit.COMBO ?? 20) && <button style={moreBtn} onClick={() => setLimit((l) => ({ ...l, COMBO: (l.COMBO ?? 20) + 20 }))}>Show more</button>}
        </section>
      )}

      {legKeys.map((key, i) => {
        const leg = legs[i];
        const opts = optionsFor(key);
        return (
          <section key={key} id={`leg-${key}`} style={{ marginTop: 18, scrollMarginTop: 80 }}>
            <h2 style={h2}><span style={stepBadge(Boolean(picked[key]))}>{picked[key] ? "✓" : i + 1}</span>{key === "ONWARD" ? "Departure" : key === "RETURN" ? "Return" : `Flight ${i + 1}`}{leg ? ` · ${leg.origin} → ${leg.destination} · ${day(leg.departureDate)}` : ""}</h2>
            {key === "RETURN" && picked.ONWARD?.fareIdentifier === "SPECIAL_RETURN" && (
              <p style={{ ...muted, color: "#b54708" }}>Special Return fare selected — showing matching Special Return flights only.</p>
            )}
            {key === "RETURN" && !picked.ONWARD && <p style={muted}>Choose your departure flight first to see Special Return pairings.</p>}
            <div style={{ display: "grid", gap: 10 }}>
              {opts.slice(0, limit[key] ?? 15).map((f) => (
                <FareRow show={show} travellers={adults + children + infants} key={f.id} fare={f} selected={picked[key]?.id === f.id} onPick={() => pickAndAdvance(key, f)} />
              ))}
              {!opts.length && <p style={muted}>No matching flights.</p>}
            </div>
            {opts.length > (limit[key] ?? 15) && <button style={moreBtn} onClick={() => setLimit((l) => ({ ...l, [key]: (l[key] ?? 15) + 15 }))}>Show more</button>}
          </section>
        );
      })}

      {(selection.length > 0 || Object.keys(picked).length > 0) && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "#fff", borderTop: "1px solid #e4e7ec", boxShadow: "0 -6px 20px rgba(16,24,40,.08)", padding: "12px 16px calc(12px + env(safe-area-inset-bottom))", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, zIndex: 40 }}>
          <div style={{ minWidth: 0 }}>
            {comboPick ? (
              <div style={{ fontSize: 12, color: "#667085" }}>Journey · {FARE_LABEL[comboPick.fareIdentifier ?? ""] ?? comboPick.fareIdentifier ?? ""}</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 12, color: "#667085" }}>
                {legKeys.map((k, i) => (
                  <span key={k} style={{ whiteSpace: "nowrap" }}>
                    {picked[k] ? "✓" : "○"} <span style={{ textTransform: "capitalize" }}>{legLabel(k, i)}</span>
                    {picked[k] ? `: ${picked[k].airline} ${picked[k].flightNumber}` : ": not chosen"}
                  </span>
                ))}
              </div>
            )}
            <b style={{ fontSize: 20 }}>{selection.length ? show(total, currency) : show(legKeys.reduce((n, k) => n + (picked[k] ? price(picked[k]) : 0), 0), currency)}</b>
            {!selection.length && <span style={{ fontSize: 12, color: "#667085" }}> so far</span>}
          </div>
          {selection.length ? (
            <button onClick={continueToBook} style={{ background: "#E31E24", color: "#fff", border: 0, borderRadius: 12, padding: "12px 22px", fontWeight: 800, fontSize: 15, cursor: "pointer", flexShrink: 0 }}>Continue</button>
          ) : nextMissing ? (
            <button onClick={() => goTo(nextMissing)} style={{ background: "#101828", color: "#fff", border: 0, borderRadius: 12, padding: "12px 18px", fontWeight: 800, fontSize: 14, cursor: "pointer", flexShrink: 0 }}>
              Choose {legLabel(nextMissing, legKeys.indexOf(nextMissing))} flight ↓
            </button>
          ) : null}
        </div>
      )}
    </main>
  );
}

function FareRow({ fare, selected, onPick, showSegments, travellers = 1, show = money }: { fare: Fare; selected: boolean; onPick: () => void; showSegments?: boolean; travellers?: number; show?: (n: number, cur: string) => string }) {
  const segs = fare.segments ?? [];
  const outbound = segs.filter((s) => !s.isReturn);
  const inbound = segs.filter((s) => s.isReturn);
  return (
    <button type="button" onClick={onPick} style={{
      textAlign: "left", width: "100%", background: selected ? "#fff5f5" : "#fff", border: `1.5px solid ${selected ? "#E31E24" : "#e5e7eb"}`,
      borderRadius: 10, padding: 14, cursor: "pointer", display: "grid", gap: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div>
          <b>{fare.airlineName} · {fare.flightNumber ? `${fare.airline} ${fare.flightNumber}` : ""}</b>
          <div style={{ fontSize: 13, color: "#344054" }}>
            {time(fare.departureTime)} {fare.origin} → {time(fare.arrivalTime)} {fare.destination} · {hm(fare.duration)} · {fare.stops ? `${fare.stops} stop${fare.stops > 1 ? "s" : ""}` : "Non-stop"}
          </div>
          {showSegments && inbound.length > 0 && (
            <div style={{ fontSize: 13, color: "#344054" }}>
              Return: {time(inbound[0].departureTime)} {inbound[0].origin} → {time(inbound[inbound.length - 1].arrivalTime)} {inbound[inbound.length - 1].destination} · {day(inbound[0].departureTime)} · {inbound.length > 1 ? `${inbound.length - 1} stop` : "Non-stop"}
            </div>
          )}
          {showSegments && outbound.length > 1 && !inbound.length && segs.length > 1 && (
            <div style={{ fontSize: 12, color: "#667085" }}>{segs.map((s) => `${s.origin}→${s.destination}`).join(" · ")}</div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <b style={{ fontSize: 18, color: "#E31E24" }}>{show(price(fare), fare.currency)}</b>
          {travellers > 1 && <small style={{ display: "block", color: "#667085", fontSize: 11 }}>total for {travellers} travellers</small>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
        {fare.fareIdentifier && <span style={chip(fare.fareIdentifier === "SPECIAL_RETURN" ? "#fef3c7" : "#f1f5f9")}>{FARE_LABEL[fare.fareIdentifier] ?? fare.fareIdentifier}</span>}
        <span style={chip(fare.isRefundable ? "#ecfdf3" : "#f1f5f9")}>{fare.isRefundable ? "Refundable" : "Non-refundable"}</span>
        {fare.baggage?.checked && <span style={chip("#f1f5f9")}>Check-in {fare.baggage.checked}</span>}
      </div>
    </button>
  );
}

const h2: React.CSSProperties = { fontSize: 16, fontWeight: 800, margin: "0 0 4px" };
const muted: React.CSSProperties = { fontSize: 13, color: "#667085", margin: "0 0 8px" };
const errBox: React.CSSProperties = { marginTop: 14, padding: 12, borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 14 };
const stepBadge = (done: boolean): React.CSSProperties => ({
  display: "inline-grid", placeItems: "center", width: 22, height: 22, borderRadius: "50%", marginRight: 8, fontSize: 12, verticalAlign: "2px",
  background: done ? "#16a34a" : "#E31E24", color: "#fff",
});
const moreBtn: React.CSSProperties = { marginTop: 8, background: "none", border: "1px solid #d0d5dd", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontWeight: 600 };
const chip = (bg: string): React.CSSProperties => ({ background: bg, borderRadius: 6, padding: "2px 7px", fontWeight: 700, color: "#344054" });
