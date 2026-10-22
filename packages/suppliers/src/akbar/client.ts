/** Benzy B2B Revamp contract. Mock transport only: no HTTP implementation exists. */
import { AkbarError, classifyAkbarCode } from "./errors.js";
import {
  accountKey,
  AkbarSessionCache,
  validateScope,
  type AkbarScope,
} from "./session.js";
export { AkbarError } from "./errors.js";
export type AkbarOperation =
  | "Signature"
  | "ExpressSearch"
  | "GetExpSearch"
  | "SmartPricer"
  | "GetSPricer"
  | "FlightInfo";
export const AKBAR_PATHS: Record<AkbarOperation, string> = {
  Signature: "/Utils/Signature",
  ExpressSearch: "/flights/ExpressSearch",
  GetExpSearch: "/flights/GetExpSearch",
  SmartPricer: "/Flights/SmartPricer",
  GetSPricer: "/Flights/GetSPricer",
  FlightInfo: "/Flights/FlightInfo",
};
export interface AkbarSecrets {
  merchantId: string;
  apiKey: string;
  clientId: string;
  password: string;
  agentCode: string;
  browserKey: string;
}
export interface AkbarMockTransport {
  readonly kind: "mock";
  request(
    operation: AkbarOperation,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
}
export function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AkbarError("INVALID_RESPONSE");
  return value as Record<string, any>;
}
export function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 2000 ||
    /[\r\n\u0000]/.test(value)
  )
    throw new AkbarError("INVALID_RESPONSE");
  return value;
}
async function bounded<T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number,
): Promise<T> {
  const remaining = deadline - now();
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new AkbarError("TIMEOUT");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AkbarError("TIMEOUT")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export class AkbarClient {
  private readonly secrets: AkbarSecrets;
  private readonly scope: AkbarScope;
  private readonly cache: AkbarSessionCache;
  private readonly now: () => number;
  private key?: Promise<string>;
  constructor(
    secrets: AkbarSecrets,
    private readonly transport: AkbarMockTransport,
    options: {
      scope: AkbarScope;
      cache?: AkbarSessionCache;
      now?: () => number;
    },
  ) {
    if (transport?.kind !== "mock") throw new AkbarError("DISABLED");
    validateScope(options?.scope);
    this.scope = { ...options.scope };
    this.secrets = { ...secrets };
    this.cache = options.cache ?? new AkbarSessionCache();
    this.now = options.now ?? Date.now;
    for (const key of [
      "merchantId",
      "apiKey",
      "clientId",
      "password",
      "browserKey",
    ] as const)
      if (!secrets[key]) throw new AkbarError("AUTH");
  }
  async scopeKey() {
    return (this.key ??= accountKey(this.scope, this.secrets));
  }
  get scopeIdentity(): Readonly<AkbarScope> {
    return { ...this.scope };
  }
  private async request(
    operation: AkbarOperation,
    body: Record<string, unknown>,
    token: string | undefined,
    deadline: number,
  ): Promise<Record<string, any>> {
    if (!Object.hasOwn(AKBAR_PATHS, operation))
      throw new AkbarError("DISABLED");
    const remaining = Math.min(5000, deadline - this.now());
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new AkbarError("TIMEOUT");
    const controller = new AbortController();
    try {
      const data = await bounded(
        this.transport.request(
          operation,
          body,
          token ? { Authorization: `Bearer ${token}` } : {},
          controller.signal,
        ),
        this.now() + remaining,
        this.now,
      );
      if (
        !Number.isInteger(data.status) ||
        data.status < 100 ||
        data.status > 599
      )
        throw new AkbarError("INVALID_RESPONSE");
      if (data.status === 403) throw new AkbarError("ACCESS_DENIED");
      if (data.status === 401)
        throw new AkbarError(
          operation === "Signature" ? "AUTH" : "UNAUTHORIZED",
        );
      if (data.status === 429) throw new AkbarError("RATE_LIMITED");
      if (data.status < 200 || data.status >= 300)
        throw new AkbarError("UPSTREAM", data.status >= 500);
      const response = record(data.body);
      classifyAkbarCode(operation, response.Code);
      return response;
    } catch (error) {
      if (error instanceof AkbarError) throw error;
      throw new AkbarError("UPSTREAM", true);
    } finally {
      controller.abort();
    }
  }
  private async authenticate(deadline: number) {
    const key = await this.scopeKey();
    // Shared authentication has its own bounded lifetime; a short-lived caller may
    // stop waiting without cancelling another caller's authentication.
    return bounded(
      this.cache.obtain(key, this.now(), async () => {
        const s = this.secrets;
        const d = await this.request(
          "Signature",
          {
            MerchantID: s.merchantId,
            ApiKey: s.apiKey,
            ClientID: s.clientId,
            Password: s.password,
            AgentCode: s.agentCode,
            BrowserKey: s.browserKey,
          },
          undefined,
          this.now() + 5000,
        );
        const token = text(d.Token);
        if (/\s/.test(token)) throw new AkbarError("INVALID_RESPONSE");
        let expires = this.now() + (48 * 60 - 5) * 60000;
        // JWT payload is an UNVERIFIED expiry hint: it may shorten, never extend,
        // the documented lifetime. It never authenticates a user or grants access.
        if (token.split(".").length === 3) {
          try {
            const part = token.split(".")[1];
            if (part.length > 8000) throw new Error();
            const payload = JSON.parse(
              atob(part.replace(/-/g, "+").replace(/_/g, "/")),
            );
            if (
              typeof payload.exp !== "number" ||
              !Number.isFinite(payload.exp)
            )
              throw new Error();
            expires = Math.min(expires, payload.exp * 1000 - 60000);
          } catch {
            throw new AkbarError("INVALID_RESPONSE");
          }
        }
        if (expires <= this.now()) throw new AkbarError("EXPIRED_TOKEN");
        return { token, clientId: text(d.ClientID), expires };
      }),
      deadline,
      this.now,
    );
  }
  async call(
    operation: Exclude<AkbarOperation, "Signature">,
    body: Record<string, unknown>,
    deadline: number,
  ): Promise<Record<string, any>> {
    if (
      !Object.hasOwn(AKBAR_PATHS, operation) ||
      (operation as string) === "Signature"
    )
      throw new AkbarError("DISABLED");
    let refreshed = false,
      retried = false;
    while (true) {
      if (deadline <= this.now()) throw new AkbarError("TIMEOUT");
      const session = await this.authenticate(deadline);
      try {
        return await this.request(
          operation,
          { ...body, ClientID: session.clientId },
          session.token,
          deadline,
        );
      } catch (error) {
        if (
          error instanceof AkbarError &&
          error.code === "UNAUTHORIZED" &&
          !refreshed
        ) {
          this.cache.invalidate(await this.scopeKey(), session.token);
          refreshed = true;
          continue;
        }
        if (
          error instanceof AkbarError &&
          error.retryable &&
          operation.startsWith("Get") &&
          !retried
        ) {
          retried = true;
          continue;
        }
        throw error;
      }
    }
  }
}
export function akbarSecretsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AkbarSecrets {
  const keys = {
    merchantId: "AKBAR_MERCHANT_ID",
    apiKey: "AKBAR_API_KEY",
    clientId: "AKBAR_CLIENT_ID",
    password: "AKBAR_PASSWORD",
    agentCode: "AKBAR_AGENT_CODE",
    browserKey: "AKBAR_BROWSER_KEY",
  } as const;
  const output = {} as AkbarSecrets;
  for (const key of Object.keys(keys) as Array<keyof AkbarSecrets>) {
    const value = env[keys[key]];
    if (key !== "agentCode" && !value) throw new AkbarError("AUTH");
    output[key] = value ?? "";
  }
  return output;
}
