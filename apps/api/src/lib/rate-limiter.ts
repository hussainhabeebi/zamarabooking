import type { DurableObjectState } from "@cloudflare/workers-types";

interface RateLimitRequest {
  tenantId: string;
  action:   string;
  limit:    number;
}

// Durable Object: one instance per tenant, provides accurate per-minute rate limiting
export class TenantRateLimiter {
  private state:   DurableObjectState;
  private counts:  Map<string, { count: number; windowStart: number }> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { action, limit } = await request.json() as RateLimitRequest;
    const now      = Date.now();
    const window   = 60_000;  // 1 minute window

    const entry = this.counts.get(action) ?? { count: 0, windowStart: now };

    if (now - entry.windowStart > window) {
      // New window — reset count
      entry.count       = 0;
      entry.windowStart = now;
    }

    entry.count++;
    this.counts.set(action, entry);

    const allowed   = entry.count <= limit;
    const remaining = Math.max(0, limit - entry.count);

    return Response.json({ allowed, remaining, limit });
  }
}
