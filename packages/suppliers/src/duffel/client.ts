// Duffel API v2 client — thin HTTP wrapper
// Docs: https://duffel.com/docs/api
// Test key format: duffel_test_...  Live key: duffel_live_...

const DUFFEL_BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";

export class DuffelClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = DUFFEL_BASE) {
    this.apiKey  = apiKey;
    this.baseUrl = baseUrl;
  }

  private headers() {
    return {
      "Authorization":  `Bearer ${this.apiKey}`,
      "Duffel-Version": DUFFEL_VERSION,
      "Content-Type":   "application/json",
      "Accept":         "application/json",
      "Accept-Encoding": "gzip",
    };
  }

  private buildUrl(path: string, query: Record<string, string> = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.toString();
  }

  async post<T>(path: string, body: unknown, query: Record<string, string> = {}): Promise<T> {
    if (!this.apiKey) throw new Error("Duffel: apiKey not configured");

    const res = await fetch(this.buildUrl(path, query), {
      method:  "POST",
      headers: this.headers(),
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      const requestId = res.headers.get("x-request-id");
      throw new Error(`Duffel ${path}: ${res.status}${requestId ? ` [${requestId}]` : ""} ${err.slice(0, 500)}`);
    }
    const json = await res.json() as { data: T };
    return json.data;
  }

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    if (!this.apiKey) throw new Error("Duffel: apiKey not configured");

    const res = await fetch(this.buildUrl(path, query), { headers: this.headers() });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      const requestId = res.headers.get("x-request-id");
      throw new Error(`Duffel ${path}: ${res.status}${requestId ? ` [${requestId}]` : ""} ${err.slice(0, 500)}`);
    }
    const json = await res.json() as { data: T };
    return json.data;
  }
}
