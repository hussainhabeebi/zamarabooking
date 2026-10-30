// Additional baggage on staff-ticketed fares (Akbar, Poomas, manual).
//
// The supplier API gives no priced baggage for these fares, so a customer can only
// REQUEST extra weight. A request is stored on the booking as pending staff
// confirmation and never priced or charged here: staff confirm the airline's price
// with the customer and add it on the supplier portal. Included baggage is untouched.

export const BAGGAGE_REQUEST_KG = [5, 10, 15, 20, 25, 30] as const;

export interface BaggageRequestInput { passengerIndex: number; legIndex: number; extraKg: number }

export interface BaggageRequestItem {
  passenger: string;            // "FIRST LAST (ADULT)"
  passengerIndex: number;
  leg: string;                  // "BOM-DEL"
  legIndex: number;
  flight?: string;              // "6E 2101"
  extraKg: number;
}

export interface StoredBaggageRequest {
  status: "PENDING_STAFF_CONFIRMATION";
  charged: false;
  requestedAt: string;
  items: BaggageRequestItem[];
}

type Pax = { type: string; firstName: string; lastName: string };
type Leg = { origin: string; destination: string; airline?: string; flightNumber?: string };

// Checks the customer's choices against the booking's travellers and legs.
// Returns the record to store (null when nothing was requested) or a problem message.
export function buildBaggageRequest(
  passengers: Pax[], legs: Leg[], choices: ("NONE" | "REQUEST")[] | undefined, requests: BaggageRequestInput[] | undefined,
  now = new Date(),
): { request: StoredBaggageRequest | null } | { problem: string } {
  const items: BaggageRequestItem[] = [];
  const seen = new Set<string>();
  for (const r of requests ?? []) {
    const p = passengers[r.passengerIndex];
    const leg = legs[r.legIndex];
    if (!p || !leg) return { problem: "A baggage request does not match a traveller or flight on this booking." };
    if (p.type === "INFANT") return { problem: "Infants cannot request additional baggage." };
    if (choices?.[r.passengerIndex] !== "REQUEST") return { problem: `Traveller ${r.passengerIndex + 1} chose no additional baggage.` };
    if (!(BAGGAGE_REQUEST_KG as readonly number[]).includes(r.extraKg)) return { problem: "Choose an extra baggage weight from the list." };
    const key = `${r.passengerIndex}:${r.legIndex}`;
    if (seen.has(key)) return { problem: "Each traveller can request baggage once per flight." };
    seen.add(key);
    const flight = [leg.airline, leg.flightNumber].filter(Boolean).join(" ");
    items.push({
      passenger: `${p.firstName.trim()} ${p.lastName.trim()} (${p.type})`.toUpperCase(), passengerIndex: r.passengerIndex,
      leg: `${leg.origin}-${leg.destination}`, legIndex: r.legIndex, ...(flight ? { flight } : {}), extraKg: r.extraKg,
    });
  }
  for (const [i, c] of (choices ?? []).entries()) {
    if (c === "REQUEST" && !items.some((x) => x.passengerIndex === i)) return { problem: `Traveller ${i + 1}: choose the extra weight for at least one flight.` };
  }
  if (!items.length) return { request: null };
  items.sort((a, b) => a.passengerIndex - b.passengerIndex || a.legIndex - b.legIndex);
  return { request: { status: "PENDING_STAFF_CONFIRMATION", charged: false, requestedAt: now.toISOString(), items } };
}

// One line for staff: "Extra baggage requested (pending, not charged): JOHN DOE (ADULT) +10 kg BOM-DEL; …"
export function baggageRequestSummary(request: StoredBaggageRequest | undefined | null): string {
  if (!request?.items?.length) return "";
  return `Extra baggage requested (pending staff confirmation, not charged): ${request.items
    .map((x) => `${x.passenger} +${x.extraKg} kg ${x.leg}${x.flight ? ` (${x.flight})` : ""}`).join("; ")}`;
}
