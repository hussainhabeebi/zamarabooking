// TripJack Flights v2 Seat Map (fms/v1/seat) → a grid per segment.
//
// Response: tripSeatMap.tripSeat is keyed by segment id (the SSR "key" used in
// the Book request's ssrSeatInfos). Each segment has sData { row, column } and
// sInfo[] { seatNo, code, seatPosition { row, column }, isBooked, amount,
// isLegroom, isAisle }.

type Rec = Record<string, any>;

export interface SeatOption {
  code:     string;          // sent back as ssrSeatInfos[].code
  seatNo:   string;
  row:      number;
  column:   number;
  amount:   number;
  booked:   boolean;
  legroom:  boolean;
  aisle:    boolean;
}

export interface SegmentSeatMap {
  key:     string;           // segment id = ssrSeatInfos[].key
  rows:    number;
  columns: number;
  seats:   SeatOption[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const bool = (v: unknown) => v === true || v === "true";

function position(s: Rec): { row: number; column: number } {
  const row = num(s?.seatPosition?.row ?? s?.row);
  const column = num(s?.seatPosition?.column ?? s?.column);
  if (row && column) return { row, column };
  // Fallback: "12C" → row 12, column C (A = 1).
  const m = /^(\d+)([A-Z])$/i.exec(String(s?.seatNo ?? s?.code ?? ""));
  return m ? { row: Number(m[1]), column: m[2].toUpperCase().charCodeAt(0) - 64 } : { row: 0, column: 0 };
}

export function parseTripjackSeatMap(raw: unknown): SegmentSeatMap[] {
  const root = ((raw as Rec)?.data ?? raw) as Rec;
  const tripSeat = root?.tripSeatMap?.tripSeat ?? root?.tripSeat ?? {};
  const entries: [string, Rec][] = Array.isArray(tripSeat)
    ? tripSeat.map((s: Rec, i: number) => [String(s?.key ?? s?.id ?? i), s])
    : Object.entries(tripSeat as Record<string, Rec>);
  return entries.map(([key, seg]) => {
    const seats: SeatOption[] = (Array.isArray(seg?.sInfo) ? seg.sInfo : [])
      .filter((s: Rec) => s?.code || s?.seatNo)
      .map((s: Rec) => ({
        code:    String(s.code ?? s.seatNo),
        seatNo:  String(s.seatNo ?? s.code),
        ...position(s),
        amount:  num(s.amount),
        booked:  bool(s.isBooked),
        legroom: bool(s.isLegroom),
        aisle:   bool(s.isAisle),
      }));
    const rows = Math.max(num(seg?.sData?.row), ...seats.map((s) => s.row), 0);
    const columns = Math.max(num(seg?.sData?.column), ...seats.map((s) => s.column), 0);
    return { key, rows, columns, seats };
  }).filter((s) => s.seats.length);
}

// Price of the seats passengers picked; flags unknown / taken / duplicate seats.
export function seatTotal(
  maps: SegmentSeatMap[],
  passengers: { type?: string; ssr?: { seat?: { key: string; code: string }[] } }[],
): { total: number; invalid: string[] } {
  const byKey = new Map(maps.map((m) => [m.key, new Map(m.seats.map((s) => [s.code, s]))]));
  const taken = new Set<string>();
  let total = 0;
  const invalid: string[] = [];
  passengers.forEach((p, i) => {
    const perSegment = new Set<string>();
    for (const pick of p.ssr?.seat ?? []) {
      const seat = byKey.get(pick.key)?.get(pick.code);
      const id = `${pick.key}|${pick.code}`;
      if (p.type === "INFANT") invalid.push(`passenger ${i + 1}: infants sit on an adult's lap`);
      else if (!seat) invalid.push(`passenger ${i + 1} seat ${pick.code}`);
      else if (seat.booked) invalid.push(`seat ${pick.code} is already taken`);
      else if (taken.has(id)) invalid.push(`seat ${pick.code} was picked twice`);
      else if (perSegment.has(pick.key)) invalid.push(`passenger ${i + 1} has two seats on one flight`);
      else { total += seat.amount; taken.add(id); perSegment.add(pick.key); }
    }
  });
  return { total: Math.round(total * 100) / 100, invalid };
}
