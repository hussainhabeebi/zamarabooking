// Export names only. Never infer a UI filter from a supplier's direct-flight modifier.
export function searchStopLabel(filter?: string | null): string {
  switch (filter) {
    case "0": return "DIRECT";
    case "1": return "1-STOP";
    case "2": return "2PLUS-STOPS";
    case undefined: case null: case "": return "ALL-STOPS";
    default: throw new Error("Invalid stop filter");
  }
}

export function normalizedStopCount(fare: Record<string, any>): number | null {
  if (fare.stopsUnknown) return null;
  const declared = typeof fare.stops === "number" && Number.isInteger(fare.stops) && fare.stops >= 0 ? fare.stops : null;
  const segments = Array.isArray(fare.segments) && fare.segments.length ? fare.segments.length - 1 : null;
  const connections = Array.isArray(fare.stopDetails) && fare.stopDetails.length ? fare.stopDetails.length : null;
  const counts = [declared, segments, connections].filter((n): n is number => n !== null);
  return counts.length ? Math.max(...counts) : null;
}

export function resultStopLabel(count: number | null): string {
  return count === null || !Number.isInteger(count) || count < 0 ? "UNKNOWN-STOPS" : count === 0 ? "DIRECT" : `${count}-STOP${count === 1 ? "" : "S"}`;
}
