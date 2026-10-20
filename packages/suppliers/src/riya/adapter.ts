import type {
  SupplierAdapter, SearchParams, NormalizedFare, HoldParams, HoldResult,
  BookParams, BookResult, PNRStatusResult, CancelResult, SupplierCredentials, FareRule,
} from "../base.js";
import { RiyaClient } from "./client.js";
import { normalizeRiyaFare } from "./normalizer.js";

export class RiyaAdapter implements SupplierAdapter {
  readonly name = "RIYA" as const;
  private client: RiyaClient;

  constructor(credentials: SupplierCredentials) {
    this.client = new RiyaClient(credentials);
  }

  async search(params: SearchParams): Promise<NormalizedFare[]> {
    const raw = await this.client.search(params);
    return (raw.Results ?? []).map(normalizeRiyaFare);
  }

  async getFareRules(fareId: string, sessionId?: string): Promise<FareRule[]> {
    const raw = await this.client.fareRules(fareId, sessionId);
    return (raw.FareRules ?? []).map((r: { Category: string; Rules: string }) => ({
      category:    r.Category,
      description: r.Rules,
    }));
  }

  async hold(params: HoldParams): Promise<HoldResult> {
    const raw = await this.client.hold(params);
    return {
      success:      raw.Status === "SUCCESS",
      holdId:       raw.HoldId,
      pnr:          raw.PNR,
      expiresAt:    raw.ExpiresAt,
      fareSnapshot: normalizeRiyaFare(raw.FareSnapshot),
    };
  }

  async book(params: BookParams): Promise<BookResult> {
    const raw = await this.client.book(params);
    return {
      success:       raw.Status === "SUCCESS",
      bookingRef:    raw.BookingId,
      pnr:           raw.PNR,
      status:        raw.TicketStatus === "ISSUED" ? "TICKETED" : "CONFIRMED",
      ticketNumbers: raw.Tickets ?? [],
      raw,
    };
  }

  async getPNRStatus(pnr: string): Promise<PNRStatusResult> {
    const raw = await this.client.pnrStatus(pnr);
    return {
      pnr,
      status:     raw.Status,
      passengers: raw.Passengers ?? [],
      itinerary:  raw.Itinerary,
    };
  }

  async cancel(bookingRef: string, pnr: string): Promise<CancelResult> {
    const raw = await this.client.cancel(bookingRef, pnr);
    return {
      success:      raw.Status === "SUCCESS",
      refundAmount: raw.RefundAmount ?? 0,
      penalty:      raw.Penalty ?? 0,
      status:       raw.Status,
    };
  }

  async reissue(bookingRef: string, params: unknown): Promise<unknown> {
    return this.client.reissue(bookingRef, params);
  }
}
