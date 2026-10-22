/** Benzy B2B Revamp contract. Mock transport only: no HTTP implementation exists. */
export type AkbarOperation = 'Signature' | 'ExpressSearch' | 'GetExpSearch' | 'SmartPricer' | 'GetSPricer' | 'FlightInfo';
export const AKBAR_PATHS: Record<AkbarOperation, string> = {
  Signature: '/Utils/Signature', ExpressSearch: '/flights/ExpressSearch',
  GetExpSearch: '/flights/GetExpSearch', SmartPricer: '/Flights/SmartPricer',
  GetSPricer: '/Flights/GetSPricer', FlightInfo: '/Flights/FlightInfo',
};
export interface AkbarSecrets { merchantId: string; apiKey: string; clientId: string; password: string; agentCode: string; browserKey: string }
export interface AkbarMockTransport {
  readonly kind: 'mock';
  request(operation: AkbarOperation, body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}
export class AkbarError extends Error {
  constructor(readonly code: 'DISABLED' | 'AUTH' | 'TIMEOUT' | 'UPSTREAM' | 'INVALID_RESPONSE' | 'UNSUPPORTED' | 'INVALID_REQUEST') {
    super(`Akbar ${code}`); this.name = 'AkbarError';
  }
}
export function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AkbarError('INVALID_RESPONSE');
  return value as Record<string, any>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new AkbarError('INVALID_RESPONSE');
  return value;
}
export class AkbarClient {
  private session?: { token: string; clientId: string; expires: number };
  private authenticating?: Promise<void>;
  constructor(private readonly secrets: AkbarSecrets, private readonly transport: AkbarMockTransport, private readonly now = Date.now) {
    if (transport?.kind !== 'mock') throw new AkbarError('DISABLED');
    for (const key of ['merchantId', 'apiKey', 'clientId', 'password', 'browserKey'] as const) {
      if (!secrets[key]) throw new AkbarError('AUTH');
    }
  }
  private async request(operation: AkbarOperation, body: Record<string, unknown>, token: string | undefined, deadline: number): Promise<Record<string, any>> {
    if (!Object.hasOwn(AKBAR_PATHS, operation)) throw new AkbarError('DISABLED');
    const remaining = Math.min(5000, deadline - this.now());
    if (remaining <= 0) throw new AkbarError('TIMEOUT');
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.transport.request(operation, body, token ? { Authorization: `Bearer ${token}` } : {}, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AkbarError('TIMEOUT')); }, remaining); }),
      ]);
      if (response.status === 401 || response.status === 403) throw new AkbarError('AUTH');
      if (response.status < 200 || response.status >= 300) throw new AkbarError('UPSTREAM');
      const data = record(response.body);
      // Never include Msg, bodies, tokens, credentials or upstream exception text in errors.
      if (String(data.Code) !== '200') throw new AkbarError(operation === 'Signature' ? 'AUTH' : 'UPSTREAM');
      return data;
    } catch (error) {
      if (error instanceof AkbarError) throw error;
      throw new AkbarError('UPSTREAM');
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private async authenticate(deadline: number): Promise<void> {
    if (this.session && this.now() < this.session.expires) return;
    if (!this.authenticating) this.authenticating = (async () => {
      const s = this.secrets;
      // “Signature” is a server-issued JWT endpoint, NOT a documented local HMAC algorithm.
      const d = await this.request('Signature', { MerchantID: s.merchantId, ApiKey: s.apiKey, ClientID: s.clientId, Password: s.password, AgentCode: s.agentCode, BrowserKey: s.browserKey }, undefined, deadline);
      this.session = { token: text(d.Token), clientId: text(d.ClientID), expires: this.now() + (48 * 60 - 5) * 60_000 };
    })().finally(() => { this.authenticating = undefined; });
    await this.authenticating;
  }
  async call(operation: Exclude<AkbarOperation, 'Signature'>, body: Record<string, unknown>, deadline: number): Promise<Record<string, any>> {
    if (!Object.hasOwn(AKBAR_PATHS, operation) || (operation as string) === 'Signature') throw new AkbarError('DISABLED');
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.authenticate(deadline);
      const s = this.session!;
      try { return await this.request(operation, { ...body, ClientID: s.clientId }, s.token, deadline); }
      catch (error) {
        if (error instanceof AkbarError && error.code === 'AUTH' && attempt === 0) { this.session = undefined; continue; }
        // Retry only result retrieval, never initiate duplicate search/pricing operations.
        if (error instanceof AkbarError && error.code === 'UPSTREAM' && operation.startsWith('Get') && attempt === 0) continue;
        throw error;
      }
    }
    throw new AkbarError('AUTH');
  }
}

/** Server-side only. No Worker binding or production secret is changed by this helper. */
export function akbarSecretsFromEnv(env: Readonly<Record<string, string | undefined>>): AkbarSecrets {
  const keys = { merchantId: 'AKBAR_MERCHANT_ID', apiKey: 'AKBAR_API_KEY', clientId: 'AKBAR_CLIENT_ID', password: 'AKBAR_PASSWORD', agentCode: 'AKBAR_AGENT_CODE', browserKey: 'AKBAR_BROWSER_KEY' } as const;
  const output = {} as AkbarSecrets;
  for (const key of Object.keys(keys) as Array<keyof AkbarSecrets>) {
    const value = env[keys[key]];
    if (key !== 'agentCode' && !value) throw new AkbarError('AUTH');
    output[key] = value ?? '';
  }
  return output;
}
