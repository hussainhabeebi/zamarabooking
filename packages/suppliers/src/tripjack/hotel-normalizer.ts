import type { NormalizedHotel } from "./hotel-types.js";

export function normalizeTripjackHotel(
  raw: Record<string, unknown>,
  checkIn: string,
  checkOut: string,
): NormalizedHotel {
  const hInfo = (raw.hInfo ?? raw.hotelInfo ?? {}) as Record<string, unknown>;
  const optInfo = (raw.optInfo ?? raw.ops ?? [raw]) as Record<string, unknown>[];
  const op = optInfo[0] ?? {} as Record<string, unknown>;
  const price = (op.tp ?? raw.tp ?? 0) as number;
  const tax   = (op.tax ?? raw.tax ?? 0) as number;

  const checkInDate  = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const nights = Math.max(1, Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86400000));

  const imgs = hInfo.img as string[] | undefined ?? [];

  return {
    id:          (raw.id ?? raw.optionId ?? op.id ?? "") as string,
    hotelCode:   (hInfo.code ?? raw.hotelCode ?? "") as string,
    name:        (hInfo.name ?? raw.hotelName ?? "") as string,
    starRating:  Number(hInfo.rt ?? hInfo.rating ?? raw.starRating ?? 0),
    address:     (hInfo.ad ?? hInfo.address ?? "") as string,
    cityCode:    (hInfo.cd ?? hInfo.city ?? "") as string,
    checkIn,
    checkOut,
    nights,
    rooms:       1,
    roomType:    (((op.ris as Record<string, unknown>[])?.[0] as Record<string, unknown>)?.rt ?? op.roomType ?? raw.roomType ?? "") as string,
    mealPlan:    (((op.ris as Record<string, unknown>[])?.[0] as Record<string, unknown>)?.mb ?? op.mealPlan ?? "EP") as string,
    isRefundable: ((op.cnp as Record<string, unknown>)?.ra ?? raw.isRefundable ?? false) as boolean,
    baseFare:    Math.max(0, price - tax),
    taxes:       Math.max(0, tax),
    totalFare:   price,
    currency:    (raw.cur ?? op.cur ?? "INR") as string,
    images:      Array.isArray(imgs) ? imgs.slice(0, 5) : [],
    amenities:   (hInfo.fl as string[] | undefined ?? []).slice(0, 20),
    raw,
  };
}
