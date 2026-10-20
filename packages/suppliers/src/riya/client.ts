import type { SearchParams, HoldParams, BookParams, SupplierCredentials } from "../base.js";

// Riya Travel API HTTP client
// All actual endpoint paths should be verified against Riya API docs during integration
export class RiyaClient {
  private baseUrl: string;
  private apiKey:  string;
  private secret:  string;

  constructor(creds: SupplierCredentials) {
    this.baseUrl = (creds.baseUrl as string) ?? process.env.RIYA_API_BASE_URL ?? "";
    this.apiKey  = (creds.apiKey  as string) ?? process.env.RIYA_API_KEY    ?? "";
    this.secret  = (creds.secretKey as string) ?? process.env.RIYA_API_SECRET ?? "";
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "X-API-Secret":  this.secret,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SupplierError("RIYA", res.status, text);
    }

    return res.json() as Promise<T>;
  }

  async search(params: SearchParams) {
    return this.request<{ Results?: Record<string, unknown>[] }>("/search/availability", {
      Origin:         params.origin,
      Destination:    params.destination,
      DepartureDate:  params.departureDate,
      ReturnDate:     params.returnDate,
      Adults:         params.adults,
      Children:       params.children,
      Infants:        params.infants,
      CabinClass:     params.cabinClass,
      TripType:       params.tripType,
      Currency:       params.currency,
    });
  }

  async fareRules(fareId: string, sessionId?: string) {
    return this.request<{ FareRules?: Array<{ Category: string; Rules: string }> }>("/search/farerules", { FareId: fareId, SessionId: sessionId });
  }

  async hold(params: HoldParams) {
    return this.request<{ Status: string; HoldId: string; PNR?: string; ExpiresAt: string; FareSnapshot: Record<string, unknown> }>("/booking/hold", {
      FareId:     params.fareId,
      SessionId:  params.sessionId,
      Passengers: params.passengers,
    });
  }

  async book(params: BookParams) {
    return this.request<{ Status: string; BookingId: string; PNR: string; TicketStatus?: string; Tickets?: string[] }>("/booking/create", {
      HoldId:       params.holdId,
      ContactEmail: params.contactEmail,
      ContactPhone: params.contactPhone,
      PaymentRef:   params.paymentRef,
    });
  }

  async pnrStatus(pnr: string) {
    return this.request<{ Status: string; Passengers?: Array<{ name: string; ticketNumber: string; status: string }>; Itinerary?: unknown }>("/booking/pnrstatus", { PNR: pnr });
  }

  async cancel(bookingRef: string, pnr: string) {
    return this.request<{ Status: string; RefundAmount?: number; Penalty?: number }>("/booking/cancel", { BookingId: bookingRef, PNR: pnr });
  }

  async reissue(bookingRef: string, params: unknown) {
    return this.request<unknown>("/booking/reissue", { BookingId: bookingRef, ...params as object });
  }
}

export class SupplierError extends Error {
  constructor(
    public supplier: string,
    public statusCode: number,
    public body: string,
  ) {
    super(`${supplier} API error ${statusCode}: ${body}`);
    this.name = "SupplierError";
  }
}
