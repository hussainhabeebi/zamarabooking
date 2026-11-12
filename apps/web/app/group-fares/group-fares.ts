// Shared by the Group fares list and details pages. Data comes from GET /api/group-fares, which
// returns only published, active fares still on sale, priced as the checkout charges them (INR).
import { API } from "../lib/customer-api";

export interface GroupFare {
  id: string; title: string; description: string | null;
  origin: string; destination: string; travelDate: string;
  departureTime: string; arrivalTime: string; arrivalDayOffset: number;
  airline: string; airlineName: string; flightNumber: string; stops: number; cabinClass: string;
  baggage: { checked: string; cabin: string }; isRefundable: boolean;
  seatsLeft: number; seatsTotal: number | null; minPax: number; maxPax: number | null;
  saleEndsAt: string | null; pricePerAdult: number | null; currency: "INR"; soldOut?: boolean;
}

export const groupFaresUrl = (path = "") => `${API}/api/group-fares${path}`;
export const HEADERS = { "x-tenant-slug": "zamra" };

export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export const CABIN: Record<string, string> = { ECONOMY: "Economy", PREMIUM_ECONOMY: "Premium economy", BUSINESS: "Business", FIRST: "First" };

export function travelDay(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export function saleEnds(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

export function seatsText(f: Pick<GroupFare, "seatsLeft" | "minPax">) {
  if (f.seatsLeft < Math.max(1, f.minPax)) return "Sold out";
  return f.seatsLeft <= 9 ? `Only ${f.seatsLeft} seat${f.seatsLeft === 1 ? "" : "s"} left` : `${f.seatsLeft} seats left`;
}
