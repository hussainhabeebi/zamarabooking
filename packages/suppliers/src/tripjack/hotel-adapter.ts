import type { SupplierCredentials } from "../base.js";
import type {
  HotelSearchParams, NormalizedHotel, HotelPreBookResult,
  HotelBookParams, HotelBookResult, HotelCancelResult,
} from "./hotel-types.js";
import { TripjackClient } from "./client.js";
import { normalizeTripjackHotel } from "./hotel-normalizer.js";

export class TripjackHotelAdapter {
  private client: TripjackClient;

  constructor(credentials: SupplierCredentials) {
    this.client = new TripjackClient(credentials);
  }

  async search(params: HotelSearchParams): Promise<NormalizedHotel[]> {
    const raw = await this.client.hotelSearch(params) as {
      searchResult?: { his?: Record<string, unknown>[] };
      status?: { success?: boolean; statusMessage?: string };
      errors?: { errCode?: string; message?: string }[];
    };
    if (raw?.status?.success === false) {
      const detail = raw.errors?.map((e) => [e.errCode, e.message].filter(Boolean).join(" ")).join("; ") || raw.status.statusMessage || "";
      throw Object.assign(new Error(`TripJack rejected the hotel search${detail ? `: ${detail}` : ""}`), {
        endpoint: "/hotel-search/v1", responseSnippet: JSON.stringify(raw).slice(0, 800),
      });
    }
    const hotels = raw?.searchResult?.his ?? [];
    return hotels.map((h) => normalizeTripjackHotel(h as Record<string, unknown>, params.checkIn, params.checkOut));
  }

  async preBook(optionId: string): Promise<HotelPreBookResult> {
    const raw = await this.client.hotelPreBook(optionId) as Record<string, unknown>;
    const available = (raw.status as { success?: boolean })?.success !== false;
    const tp = (raw.tp ?? 0) as number;
    return {
      optionId,
      isAvailable: available,
      totalFare:   tp,
      currency:    (raw.cur ?? "INR") as string,
      raw,
    };
  }

  async book(params: HotelBookParams): Promise<HotelBookResult> {
    const raw = await this.client.hotelBook(params) as Record<string, unknown>;
    return {
      success:    (raw.status as { success?: boolean })?.success ?? false,
      bookingRef: (raw.bookingId ?? raw.travellerInfo) as string ?? "",
      status:     "CONFIRMED",
      raw,
    };
  }

  async getBookingDetail(bookingId: string) {
    return this.client.hotelBookingDetail(bookingId);
  }

  async cancel(bookingId: string): Promise<HotelCancelResult> {
    const raw = await this.client.hotelCancel(bookingId) as Record<string, unknown>;
    return {
      success:      (raw.status as { success?: boolean })?.success ?? false,
      refundAmount: (raw.refundAmount as number) ?? 0,
      penalty:      (raw.cancellationCharge as number) ?? 0,
      status:       (raw.status as { statusMessage?: string })?.statusMessage ?? "",
    };
  }
}
