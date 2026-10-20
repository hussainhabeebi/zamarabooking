"use client";

// Seat selection for a reviewed TripJack fare (review conditions.isa = true).
// One seat per traveller (infants sit on a lap) per flight segment.

import { useMemo, useState } from "react";

export type SeatOption = { code: string; seatNo: string; row: number; column: number; amount: number; booked: boolean; legroom: boolean; aisle: boolean };
export type SegmentSeatMap = { key: string; rows: number; columns: number; seats: SeatOption[] };
type SegmentInfo = { key: string; origin: string; destination: string; airline: string; flightNumber: string };
type Traveller = { type: string; firstName: string; lastName: string; seat: Record<string, string> };

export function SeatPicker({ maps, segments, travellers, onPick, format }: {
  maps: SegmentSeatMap[];
  segments: SegmentInfo[];
  travellers: Traveller[];
  onPick: (travellerIndex: number, segmentKey: string, code: string) => void;
  format: (n: number) => string;
}) {
  const seated = travellers.map((t, i) => ({ ...t, i })).filter((t) => t.type !== "INFANT");
  const [segKey, setSegKey] = useState(maps[0]?.key ?? "");
  const [active, setActive] = useState(seated[0]?.i ?? 0);
  const map = maps.find((m) => m.key === segKey) ?? maps[0];
  const info = (key: string) => segments.find((s) => s.key === key);

  const grid = useMemo(() => {
    if (!map) return null;
    const byPos = new Map(map.seats.map((s) => [`${s.row}-${s.column}`, s]));
    const rows = [...new Set(map.seats.map((s) => s.row))].sort((a, b) => a - b);
    const cols = Array.from({ length: map.columns }, (_, c) => c + 1);
    // An aisle runs between two neighbouring columns that are both aisle seats.
    const aisleCol = (c: number) => map.seats.some((s) => s.column === c && s.aisle);
    const gapAfter = new Set(cols.filter((c) => c < map.columns && aisleCol(c) && aisleCol(c + 1)));
    return { byPos, rows, cols, gapAfter };
  }, [map]);

  if (!map || !grid) return null;
  const takenBy = new Map<string, number>();
  seated.forEach((t) => { const code = t.seat[map.key]; if (code) takenBy.set(code, t.i); });
  const letter = (c: number) => String.fromCharCode(64 + c);
  const name = (t: Traveller, i: number) => (t.firstName.trim() ? `${t.firstName.trim()} ${t.lastName.trim()}`.trim() : `Traveller ${i + 1}`);

  function pick(seat: SeatOption) {
    if (seat.booked) return;
    const owner = takenBy.get(seat.code);
    if (owner !== undefined && owner !== active) return;
    onPick(active, map.key, travellers[active]?.seat[map.key] === seat.code ? "" : seat.code);
    // Move on to the next traveller without a seat on this flight.
    const next = seated.find((t) => t.i !== active && !t.seat[map.key]);
    if (next && travellers[active]?.seat[map.key] !== seat.code) setActive(next.i);
  }

  return (
    <div className="seatPicker">
      {maps.length > 1 && (
        <div className="seatTabs" role="tablist" aria-label="Flights">
          {maps.map((m) => {
            const s = info(m.key);
            return (
              <button key={m.key} type="button" role="tab" aria-selected={m.key === map.key} className="seatTab" onClick={() => setSegKey(m.key)}>
                {s ? `${s.origin} → ${s.destination}` : "Flight"}<small>{s ? `${s.airline} ${s.flightNumber}` : ""}</small>
              </button>
            );
          })}
        </div>
      )}

      <div className="seatTravellers" role="radiogroup" aria-label="Choose the traveller to seat">
        {seated.map((t) => (
          <button key={t.i} type="button" role="radio" aria-checked={t.i === active} className="seatTraveller" onClick={() => setActive(t.i)}>
            <span>{name(t, t.i)}</span>
            <b>{t.seat[map.key] ?? "No seat"}</b>
          </button>
        ))}
      </div>

      <div className="seatLegend">
        <span><i className="seatDot" /> Free</span>
        <span><i className="seatDot paid" /> Paid</span>
        <span><i className="seatDot legroom" /> Extra legroom</span>
        <span><i className="seatDot booked" /> Taken</span>
      </div>

      <div className="seatCabin">
        <div className="seatRow seatHeadRow" style={{ gridTemplateColumns: colsTemplate(grid.cols, grid.gapAfter) }}>
          <span />
          {grid.cols.map((c) => <Frag key={c} gap={grid.gapAfter.has(c)}><span className="seatLetter">{letter(c)}</span></Frag>)}
        </div>
        {grid.rows.map((r) => (
          <div key={r} className="seatRow" style={{ gridTemplateColumns: colsTemplate(grid.cols, grid.gapAfter) }}>
            <span className="seatRowNo">{r}</span>
            {grid.cols.map((c) => {
              const seat = grid.byPos.get(`${r}-${c}`);
              if (!seat) return <Frag key={c} gap={grid.gapAfter.has(c)}><span /></Frag>;
              const owner = takenBy.get(seat.code);
              const mine = owner === active;
              const cls = ["seat", seat.booked ? "booked" : seat.amount > 0 ? "paid" : "", seat.legroom ? "legroom" : "", mine ? "mine" : owner !== undefined ? "other" : ""].filter(Boolean).join(" ");
              const label = `Seat ${seat.seatNo}${seat.booked ? ", taken" : seat.amount ? `, ${format(seat.amount)}` : ", free"}${seat.legroom ? ", extra legroom" : ""}`;
              return (
                <Frag key={c} gap={grid.gapAfter.has(c)}>
                  <button type="button" className={cls} disabled={seat.booked || (owner !== undefined && !mine)} aria-pressed={mine} aria-label={label} title={label} onClick={() => pick(seat)}>
                    {owner !== undefined ? seated.findIndex((t) => t.i === owner) + 1 : ""}
                  </button>
                </Frag>
              );
            })}
          </div>
        ))}
      </div>

      {(() => {
        const code = travellers[active]?.seat[map.key];
        const seat = code ? map.seats.find((s) => s.code === code) : undefined;
        return seat ? <p className="seatSummary">{name(travellers[active], active)}: seat <b>{seat.seatNo}</b> · {seat.amount ? `+ ${format(seat.amount)}` : "free"}</p> : null;
      })()}
    </div>
  );
}

function Frag({ gap, children }: { gap: boolean; children: React.ReactNode }) {
  return <>{children}{gap && <span className="seatAisle" aria-hidden="true" />}</>;
}

function colsTemplate(cols: number[], gapAfter: Set<number>) {
  return ["22px", ...cols.flatMap((c) => (gapAfter.has(c) ? ["30px", "14px"] : ["30px"]))].join(" ");
}

export const seatCss = `.seatPicker{margin-top:4px}.seatTabs{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:10px}.seatTab{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;border:1px solid #d0d5dd;background:#fff;border-radius:12px;padding:8px 12px;font-weight:800;font-size:13px;color:#344054;cursor:pointer}.seatTab small{font-weight:600;color:#98a2b3;font-size:11px}.seatTab[aria-selected="true"]{border-color:#ed1c24;background:#fff1f2;color:#be123c}.seatTravellers{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.seatTraveller{display:flex;flex-direction:column;align-items:flex-start;border:1px solid #d0d5dd;background:#fff;border-radius:12px;padding:7px 11px;cursor:pointer;min-width:0;max-width:100%}.seatTraveller span{font-size:12px;color:#667085;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.seatTraveller b{font-size:14px;color:#101828}.seatTraveller[aria-checked="true"]{border-color:#ed1c24;box-shadow:0 0 0 3px rgba(237,28,36,.08)}.seatLegend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#667085;margin-bottom:10px}.seatLegend span{display:inline-flex;align-items:center;gap:5px}.seatDot{display:inline-block;width:14px;height:14px;border-radius:4px;border:1.5px solid #98a2b3;background:#fff}.seatDot.paid{background:#e0f2fe;border-color:#0284c7}.seatDot.legroom{border-color:#16a34a;border-width:2px}.seatDot.booked{background:#e4e7ec;border-color:#e4e7ec}.seatCabin{overflow-x:auto;border:1px solid #eaecf0;border-radius:14px;padding:10px;background:#f9fafb;max-height:420px;overflow-y:auto}.seatRow{display:grid;gap:5px;align-items:center;justify-content:center;margin-bottom:5px;width:max-content;margin-left:auto;margin-right:auto}.seatHeadRow{position:sticky;top:-10px;background:#f9fafb;padding-top:4px;z-index:1}.seatLetter,.seatRowNo{font-size:11px;font-weight:700;color:#98a2b3;text-align:center}.seat{width:30px;height:30px;border-radius:7px;border:1.5px solid #98a2b3;background:#fff;font-size:12px;font-weight:800;color:#fff;cursor:pointer;padding:0}.seat.paid{background:#e0f2fe;border-color:#0284c7}.seat.legroom{border-color:#16a34a;border-width:2px}.seat.booked{background:#e4e7ec;border-color:#e4e7ec;cursor:not-allowed}.seat.other{background:#475467;border-color:#475467}.seat.mine{background:#ed1c24;border-color:#ed1c24}.seat:disabled:not(.booked){cursor:not-allowed}.seatSummary{font-size:13px;color:#344054;margin:10px 0 0}`;
