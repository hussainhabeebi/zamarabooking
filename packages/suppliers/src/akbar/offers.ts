import type { SearchParams } from "../base.js";
import { AkbarError } from "./errors.js";
export interface AkbarOffer {
  leg: number;
  tui: string;
  index: string;
  provider: string;
  net: number;
  gross: number;
  baggage: string;
  params: SearchParams;
}
/** Opaque, scoped, bounded and isolate-local. Never return its payload to a browser. */
export class AkbarOfferStore {
  private values = new Map<
    string,
    { owner: string; expires: number; value: AkbarOffer }
  >();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1000,
  ) {}
  put(owner: string, value: AkbarOffer, ttlMs = 300000): string {
    if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 300000)
      throw new AkbarError("INVALID_REQUEST");
    for (const [id, v] of this.values)
      if (v.expires <= this.now()) this.values.delete(id);
    if (this.values.size >= this.capacity) throw new AkbarError("CAPACITY");
    const id = `akbar_mock_${crypto.randomUUID()}`;
    this.values.set(id, {
      owner,
      expires: this.now() + ttlMs,
      value: structuredClone(value),
    });
    return id;
  }
  read(owner: string, id: string): AkbarOffer {
    const entry = this.values.get(id);
    if (!entry || entry.owner !== owner)
      throw new AkbarError("OFFER_NOT_FOUND");
    if (entry.expires <= this.now()) {
      this.values.delete(id);
      throw new AkbarError("OFFER_EXPIRED");
    }
    return structuredClone(entry.value);
  }
  remove(owner: string, id: string) {
    if (this.values.get(id)?.owner === owner) this.values.delete(id);
  }
}
