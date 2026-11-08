// Full details of the selected flight on the booking page: each flight of the
// itinerary with dates, times, airports, flight numbers, layovers, included
// baggage and the fare's conditions.

export type ItinSegment = {
  airline?: string; airlineName?: string; flightNumber: string;
  origin: string; destination: string;
  departureTime: string; arrivalTime?: string; duration?: number; isReturn?: boolean;
};
export type ItinLeg = { origin: string; destination: string; segments: ItinSegment[]; checked: string; cabin: string; stops?: number };

const isSegment = (s: any): s is ItinSegment =>
  s && typeof s === "object" && typeof s.origin === "string" && typeof s.destination === "string" && typeof s.departureTime === "string";

// Onward / return legs from one supplier segment list.
export function legsFromSegments(segs: unknown, checked: string, cabin: string): ItinLeg[] {
  const list = Array.isArray(segs) ? segs.filter(isSegment) : [];
  if (!list.length) return [];
  const groups = [list.filter((s) => !s.isReturn), list.filter((s) => s.isReturn)].filter((g) => g.length);
  return groups.map((g) => ({ origin: g[0].origin, destination: g[g.length - 1].destination, segments: g, checked, cabin }));
}

// Journey legs saved by the round-trip / multi-city results page.
export function legsFromJourney(saved: unknown): ItinLeg[] {
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((l: any) => {
    if (!l || typeof l.origin !== "string") return [];
    const segs = Array.isArray(l.segments) ? l.segments.filter(isSegment) : [];
    const segments: ItinSegment[] = segs.length ? segs : [{
      airlineName: l.airlineName, flightNumber: l.flightNumber ?? "", origin: l.origin, destination: l.destination,
      departureTime: l.departureTime ?? "", arrivalTime: l.arrivalTime ?? "",
    }];
    return [{ origin: l.origin, destination: l.destination, segments, checked: l.baggage?.checked ?? "", cabin: l.baggage?.cabin ?? "", stops: typeof l.stops === "number" ? l.stops : undefined }];
  });
}

// Airline clock times as sent ("2026-11-10T08:30…"), not converted to the viewer's zone.
const clock = (s?: string) => s?.match(/T(\d{2}:\d{2})/)?.[1] ?? "--:--";
const dayOf = (s?: string) => s?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
function dateLabel(s?: string, withYear = false) {
  const d = dayOf(s);
  if (!d) return "";
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  });
}
const mins = (a?: string, b?: string) => {
  if (!a || !b) return 0;
  const n = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const hm = (m: number) => (m > 0 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : "");

function legDuration(leg: ItinLeg): number {
  const s = leg.segments;
  if (s.every((x) => (x.duration ?? 0) > 0)) {
    return s.reduce((n, x, i) => n + (x.duration ?? 0) + (i > 0 ? mins(s[i - 1].arrivalTime, x.departureTime) : 0), 0);
  }
  return s.length === 1 ? mins(s[0].departureTime, s[0].arrivalTime) : 0;
}

function legTitle(i: number, count: number, tripType: string) {
  if (count === 1) return "Flight";
  if (tripType === "ROUNDTRIP" && count === 2) return i === 0 ? "Onward" : "Return";
  return `Flight ${i + 1}`;
}

export default function FlightItinerary({ legs, tripType, cabinClass, fareLabel, refundable, meal, travellers }: {
  legs: ItinLeg[]; tripType: string; cabinClass: string; fareLabel: string;
  refundable: boolean; meal: string; travellers: string;
}) {
  if (!legs.length) return null;
  const cls = cabinClass ? cabinClass.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "";
  return (
    <div className="itin">
      {legs.map((leg, li) => {
        const dur = legDuration(leg);
        const stops = leg.segments.length > 1 ? leg.segments.length - 1 : leg.stops ?? 0;
        return (
          <div className="itinLeg" key={li}>
            <div className="itinHead">
              <span className="itinTag">{legTitle(li, legs.length, tripType)}</span>
              <b>{leg.origin} → {leg.destination}</b>
              <span>{[dateLabel(leg.segments[0]?.departureTime, true), stops === 0 ? "Nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`, hm(dur)].filter(Boolean).join(" · ")}</span>
            </div>
            {leg.segments.map((s, si) => {
              const prev = leg.segments[si - 1];
              const lay = prev ? mins(prev.arrivalTime, s.departureTime) : 0;
              const nextDay = s.arrivalTime && dayOf(s.arrivalTime) !== dayOf(s.departureTime);
              const segDur = (s.duration ?? 0) > 0 ? s.duration! : mins(s.departureTime, s.arrivalTime);
              return (
                <div key={si}>
                  {prev && (
                    <div className="itinLayover">
                      {prev.destination !== s.origin ? `Change airport ${prev.destination} → ${s.origin}` : `Change of plane at ${s.origin}`}
                      {lay > 0 && ` · ${hm(lay)} layover`}
                    </div>
                  )}
                  <div className="itinSeg">
                    <div className="itinAir">
                      <i>{(s.airline || s.flightNumber.slice(0, 2) || "✈").toUpperCase()}</i>
                      <span><b>{s.airlineName || s.airline || "Airline"}</b><small>{s.flightNumber}{cls ? ` · ${cls}` : ""}</small></span>
                    </div>
                    <div className="itinTimes">
                      <div><b>{clock(s.departureTime)}</b><strong>{s.origin}</strong><small>{dateLabel(s.departureTime)}</small></div>
                      <div className="itinLine"><small>{hm(segDur)}</small><em /></div>
                      <div className="end"><b>{clock(s.arrivalTime)}{nextDay && <sup>+1</sup>}</b><strong>{s.destination}</strong><small>{dateLabel(s.arrivalTime)}</small></div>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="itinBags">
              <span>🧳 Check-in: <b>{leg.checked || "Not provided"}</b></span>
              <span>👜 Cabin: <b>{leg.cabin || "Not provided"}</b></span>
            </div>
          </div>
        );
      })}
      <dl className="itinFare">
        {cls && <div><dt>Cabin</dt><dd>{cls}</dd></div>}
        {fareLabel && <div><dt>Fare</dt><dd>{fareLabel}</dd></div>}
        <div><dt>Cancellation</dt><dd className={refundable ? "itinOk" : ""}>{refundable ? "Refundable" : "Non-refundable"}</dd></div>
        {meal && <div><dt>Meal</dt><dd>{meal}</dd></div>}
        {travellers && <div><dt>Travellers</dt><dd>{travellers}</dd></div>}
      </dl>
    </div>
  );
}

export const itinCss = `.itin{margin-top:12px;display:grid;gap:12px}.itinLeg{border:1px solid #eaecf0;border-radius:14px;padding:12px;background:#fcfcfd}.itinHead{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin-bottom:10px}.itinHead b{font-size:15px;color:#101828}.itinHead>span:last-child{flex:1 0 100%;font-size:12px;color:#667085}.itinTag{font-size:11px;font-weight:800;color:#0D4B96;background:#EEF4FB;border-radius:99px;padding:2px 9px}.itinSeg{display:flex;flex-direction:column;gap:10px;padding:10px 0}.itinSeg+.itinSeg,.itinLeg>div+div .itinSeg{border-top:1px dashed #eaecf0}.itinAir{display:flex;align-items:center;gap:10px}.itinAir i{font-style:normal;width:34px;height:34px;flex:none;border-radius:10px;background:#0D4B96;color:#fff;display:grid;place-items:center;font-size:11px;font-weight:800}.itinAir span{display:flex;flex-direction:column;min-width:0}.itinAir b{font-size:14px;color:#101828}.itinAir small{font-size:12px;color:#667085}.itinTimes{display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;gap:6px}.itinTimes>div{display:flex;flex-direction:column;min-width:0}.itinTimes b{font-size:18px;color:#101828}.itinTimes sup{font-size:10px;color:#b42318;margin-left:2px}.itinTimes strong{font-size:13px;color:#344054}.itinTimes small{font-size:11px;color:#667085}.itinTimes .end{text-align:right;align-items:flex-end}.itinLine{align-items:center;text-align:center}.itinLine em{display:block;width:100%;height:1px;background:#d0d5dd;margin-top:4px;position:relative}.itinLine em:after{content:"✈";position:absolute;right:-2px;top:-9px;font-size:12px;color:#0D4B96;font-style:normal}.itinLayover{margin:2px 0;padding:7px 10px;border-radius:10px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;font-weight:700}.itinBags{display:flex;flex-wrap:wrap;gap:6px 16px;border-top:1px solid #eaecf0;padding-top:10px;margin-top:4px;font-size:12px;color:#475467}.itinBags b{color:#101828}.itinFare{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:0}.itinFare div{border:1px solid #eaecf0;border-radius:12px;padding:8px 10px;background:#fff}.itinFare dt{font-size:11px;color:#667085}.itinFare dd{margin:2px 0 0;font-size:13px;font-weight:700;color:#101828}.itinFare dd.itinOk{color:#067647}`;
