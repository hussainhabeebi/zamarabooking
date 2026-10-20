import type { NormalizedFare, StopDetail, BaggageInfo } from "../base.js";

// Duffel offer → NormalizedFare
export function normalizeDuffelOffer(offer: DuffelOffer, currency: string): NormalizedFare {
  const slice    = offer.slices[0];
  const segments = slice.segments;
  const first    = segments[0];
  const last     = segments[segments.length - 1];
  const durationMinutes = parseDuration(slice.duration);

  const stops: StopDetail[] = segments.slice(0, -1).map((seg, i) => {
    const next = segments[i + 1];
    return {
      airport: seg.destination.iata_code,
      arrivalTime: seg.arriving_at,
      departureTime: next.departing_at,
      layoverMinutes: Math.round((new Date(next.departing_at).getTime() - new Date(seg.arriving_at).getTime()) / 60000),
    };
  });

  const baggage = extractBaggage(offer);
  const passengerFare = offer.passenger_fares?.[0];
  const cabinName = passengerFare?.cabin_class_marketing_name ?? first.passengers?.[0]?.cabin?.marketing_name ?? "Economy";

  return {
    id: offer.id,
    supplier: "DUFFEL",
    isBookable: true,
    airline: first.marketing_carrier.iata_code,
    airlineName: first.marketing_carrier.name,
    flightNumber: `${first.marketing_carrier.iata_code}${first.marketing_carrier_flight_number}`,
    origin: first.origin.iata_code,
    destination: last.destination.iata_code,
    departureTime: first.departing_at,
    arrivalTime: last.arriving_at,
    duration: durationMinutes,
    stops: segments.length - 1,
    stopDetails: stops,
    cabinClass: mapCabinClass(cabinName),
    baseFare: parseFloat(offer.base_amount ?? offer.total_amount),
    taxes: parseFloat(offer.tax_amount ?? "0"),
    totalFare: parseFloat(offer.total_amount),
    currency: offer.total_currency ?? currency,
    isRefundable: offer.conditions?.refund_before_departure?.allowed ?? false,
    baggage,
    fareClass: passengerFare?.fare_basis_code ?? "",
    seatsLeft: offer.available_services?.length ?? undefined,
    raw: offer,
  };
}

function parseDuration(iso: string): number {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0") * 60) + parseInt(m[2] ?? "0");
}

function mapCabinClass(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("business")) return "BUSINESS";
  if (n.includes("first")) return "FIRST";
  if (n.includes("premium")) return "PREMIUM_ECONOMY";
  return "ECONOMY";
}

function extractBaggage(offer: DuffelOffer): BaggageInfo {
  const pax = offer.slices[0]?.segments[0]?.passengers?.[0];
  const bags = pax?.baggages ?? [];
  const cabin = bags.find((b: any) => b.type === "carry_on");
  const check = bags.find((b: any) => b.type === "checked");
  return {
    cabin: cabin ? `${cabin.quantity}x cabin bag` : "7 KG",
    checked: check ? `${check.quantity}x ${check.weight_unit === "kg" ? check.weight + " KG" : "bag"}` : "Not included",
  };
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  base_amount?: string;
  tax_amount?: string;
  expires_at?: string;
  live_mode?: boolean;
  passenger_identity_documents_required?: boolean;
  payment_requirements?: { requires_instant_payment?: boolean };
  passengers?: { id: string; type?: string }[];
  passenger_fares?: { cabin_class_marketing_name?: string; fare_basis_code?: string }[];
  available_services?: unknown[];
  conditions?: { refund_before_departure?: { allowed: boolean } };
  slices: {
    duration: string;
    segments: {
      departing_at: string;
      arriving_at: string;
      marketing_carrier: { iata_code: string; name: string };
      marketing_carrier_flight_number: string;
      origin: { iata_code: string };
      destination: { iata_code: string };
      passengers?: {
        cabin?: { marketing_name: string };
        baggages?: { type: string; quantity: number; weight?: number; weight_unit?: string }[];
      }[];
    }[];
  }[];
}
