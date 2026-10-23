import { AkbarError } from "./errors.js";

export interface AkbarScope {
  tenantId: string;
  environment: "UAT";
  accountId: string;
  /** Rotate whenever credentials are changed or revoked. */
  credentialVersion: string;
}
export interface AkbarSession {
  token: string;
  clientId: string;
  expires: number;
}
/** Injectable server-side store. This bounded implementation is isolate-local only. */
export class AkbarSessionCache {
  private sessions = new Map<string, AkbarSession>();
  private pending = new Map<string, Promise<AkbarSession>>();
  constructor(private readonly capacity = 1000) {}
  get(key: string, now: number) {
    const session = this.sessions.get(key);
    if (session && session.expires > now) return session;
    this.sessions.delete(key);
    return undefined;
  }
  invalidate(key: string, token: string) {
    if (this.sessions.get(key)?.token === token) this.sessions.delete(key);
  }
  async obtain(
    key: string,
    now: number,
    create: () => Promise<AkbarSession>,
  ): Promise<AkbarSession> {
    const cached = this.get(key, now);
    if (cached) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= this.capacity) throw new AkbarError("CAPACITY");
    const promise = create()
      .then((session) => {
        for (const [id, value] of this.sessions)
          if (value.expires <= now) this.sessions.delete(id);
        if (this.sessions.size >= this.capacity)
          this.sessions.delete(this.sessions.keys().next().value!);
        this.sessions.set(key, session);
        return session;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
}
export function validateScope(scope: AkbarScope) {
  if (
    !scope ||
    scope.environment !== "UAT" ||
    ![scope.tenantId, scope.accountId, scope.credentialVersion].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v),
    )
  )
    throw new AkbarError("DISABLED");
}
export async function accountKey(
  scope: AkbarScope,
  secrets: object,
): Promise<string> {
  validateScope(scope);
  const data = new TextEncoder().encode(
    JSON.stringify([
      scope.tenantId,
      scope.environment,
      scope.accountId,
      scope.credentialVersion,
      secrets,
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
