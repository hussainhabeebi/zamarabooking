// Stop counts for flight results, shared by the one-way and journey pages.
//
// A flight's stops come from the supplier's stop count and its connection list
// (Akbar: Stops + Connections → stops / stopDetails). When the supplier gave
// neither (stopsUnknown) the count is unknown: such a flight never matches a
// stops filter, so it is never shown as non-stop without evidence.

export type StopsFare = { stops?: number | null; stopsUnknown?: boolean; stopDetails?: { airport?: string; layoverMinutes?: number }[] };

export function stopCount(f: StopsFare): number | null {
  if (f.stopsUnknown || typeof f.stops !== "number" || !Number.isFinite(f.stops)) return null;
  return Math.max(f.stops, f.stopDetails?.length ?? 0);
}

// stops filter value: "0" non-stop, "1" exactly one stop, "2" two or more.
export function matchesStops(f: StopsFare, filter: string | null | undefined): boolean {
  if (!filter) return true;
  const n = stopCount(f);
  if (n === null) return false;
  return filter === "2" ? n >= 2 : n === Number(filter);
}

export function stopsLabel(f: StopsFare): string {
  const n = stopCount(f);
  return n === null ? "Stops not confirmed" : n === 0 ? "Non-stop" : `${n} stop${n > 1 ? "s" : ""}`;
}

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;

// "Via BLR (2h 40m layover)" — airports and layovers from the supplier's connection list.
export function viaText(f: StopsFare): string {
  const stops = (f.stopDetails ?? []).filter((s) => s.airport);
  if (!stops.length) return "";
  return `Via ${stops.map((s) => `${s.airport}${s.layoverMinutes ? ` (${hm(s.layoverMinutes)} layover)` : ""}`).join(" · ")}`;
}
