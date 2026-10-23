import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { integrationsAdminRoutes } from '../src/routes/admin/integrations.js';
import { suppliersAdminRoutes } from '../src/routes/admin/suppliers.js';
import { flightSourcesAdminRoutes } from '../src/routes/admin/flight-sources.js';
import type { Env, Variables } from '../src/types.js';

function harness(role = 'TENANT_ADMIN') {
  const key = 'admin_settings:mock-tenant:integration:akbar';
  const values = new Map([[key, JSON.stringify({ enabled: false, environment: 'UAT', baseUrl: '', username: 'mock-user', password: 'mock-only-private-password', agencyCode: '', apiKey: 'mock-only-private-api-key' })], ['admin_settings:mock-tenant:integration:poomas', '{"enabled":false,"apiKey":"mock-poomas"}']]);
  const beforePoomas = values.get('admin_settings:mock-tenant:integration:poomas');
  const kv = { get: async (k: string, type: string) => { const v = values.get(k); return v ? type === 'json' ? JSON.parse(v) : v : null; }, put: async (k: string, v: string) => { values.set(k, v); } };
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => { c.set('tenantId', 'mock-tenant'); c.set('userRole', role as Variables['userRole']); await next(); });
  app.route('/integrations', integrationsAdminRoutes);
  app.route('/suppliers', suppliersAdminRoutes);
  app.route('/', flightSourcesAdminRoutes);
  const env = { TENANT_CACHE_KV: kv } as unknown as Env;
  const request = (method: string, body?: object, path?: string) => app.request(path ?? (method === 'GET' ? '/' : '/akbar'), { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }, env);
  const body = { enabled: false, environment: 'UAT', priority: 7 };
  return { request, body, values, key, beforePoomas };
}

test('Akbar Admin reports disabled/unverified and never returns full secrets', async () => {
  const h = harness(); const r = await h.request('GET'); assert.equal(r.status, 200);
  const d = await r.json() as any;
  assert.equal(d.akbar.connected, false); assert.equal(d.akbar.mode, 'MOCK_ONLY'); assert.equal(d.akbar.searchStatus, 'DISABLED');
  for (const field of ['bookingEnabled', 'ticketingEnabled', 'paymentEnabled']) assert.equal(d.akbar[field], false);
  const output = JSON.stringify(d); assert(!output.includes('mock-only-private-password')); assert(!output.includes('mock-only-private-api-key')); assert(!output.includes('mock-user')); assert.equal(d.akbar.submittedIp, '156.67.110.188'); assert.equal(d.akbar.whitelistingStatus, 'PENDING_CONFIRMATION');
});
test('Akbar cannot be activated even by an administrator', async () => {
  const h = harness(); const before = h.values.get(h.key); const r = await h.request('PUT', { ...h.body, enabled: true });
  assert.equal(r.status, 400); assert.equal(h.values.get(h.key), before);
});
test('prepared priority saves while blank secrets and other suppliers are preserved', async () => {
  const h = harness(); const r = await h.request('PUT', h.body); assert.equal(r.status, 200);
  const saved = JSON.parse(h.values.get(h.key)!); assert.equal(saved.priority, 7); assert.equal(saved.password, 'mock-only-private-password'); assert.equal(saved.apiKey, 'mock-only-private-api-key');
  assert.equal(h.values.get('admin_settings:mock-tenant:integration:poomas'), h.beforePoomas);
});
test('staff cannot save Akbar configuration and priority must be valid', async () => {
  const h = harness('STAFF'); const before = h.values.get(h.key); assert.equal((await h.request('PUT', h.body)).status, 403); assert.equal(h.values.get(h.key), before);
  const a = harness(); assert.equal((await a.request('PUT', { ...a.body, priority: -1 })).status, 400);
});

test('production search rejects enabled Akbar configurations without network or mock fares', async () => {
  const { searchFares } = await import('@zamrabooking/suppliers');
  const previousFetch = globalThis.fetch, previousError = console.error;
  let network = 0;
  globalThis.fetch = async () => { network++; throw new Error('No network permitted'); };
  console.error = () => {};
  try {
    const result = await searchFares({ origin: 'COK', destination: 'DXB', departureDate: '2027-01-10', adults: 1, children: 0, infants: 0, cabinClass: 'ECONOMY', tripType: 'ONEWAY', currency: 'INR' }, [{ name: 'AKBAR', isEnabled: true, priority: 1, credentials: null, timeoutMs: 100, maxRetries: 0 }]);
    assert.deepEqual(result.fares, []); assert.deepEqual(result.usedSuppliers, []); assert.match(result.errors.AKBAR, /disabled/); assert.equal(network, 0);
  } finally { globalThis.fetch = previousFetch; console.error = previousError; }
});

test('integration API is admin-only, does not fetch and never exposes legacy credentials', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No network permitted'); };
  try {
    for (const role of ['TENANT_ADMIN', 'SUPER_ADMIN']) {
      const h = harness(role);
      const res = await h.request('GET', undefined, '/integrations/akbar');
      assert.equal(res.status, 200);
      const d = await res.json() as any;
      assert.equal(d.configured, false); assert.equal(d.connectionTestSupported, false); assert.equal(d.lastTestAt, null);
      assert.equal(d.environment, 'UAT'); assert.equal(d.connected, false);
      const text = JSON.stringify(d); assert(!text.includes('mock-only-private')); assert(!text.includes('mock-user'));
      assert.equal((await h.request('POST', { priority: 4 }, '/integrations/akbar')).status, 200);
      assert.equal(JSON.parse(h.values.get(h.key)!).priority, 4);
      assert.equal(h.values.get('admin_settings:mock-tenant:integration:poomas'), h.beforePoomas);
      assert.equal((await h.request('POST', {}, '/integrations/akbar/test')).status, 404);
    }
    for (const role of ['STAFF', 'CUSTOMER', 'AGENT']) {
      const h = harness(role); const before = h.values.get(h.key);
      assert.equal((await h.request('GET', undefined, '/integrations/akbar')).status, 403);
      assert.equal((await h.request('POST', { priority: 3 }, '/integrations/akbar')).status, 403);
      assert.equal(h.values.get(h.key), before);
    }
  } finally { globalThis.fetch = previous; }
});
test('integration rejects secrets, activation, production, forged health and invalid priorities', async () => {
  const h = harness(); const before = h.values.get(h.key);
  for (const body of [{priority:0}, {priority:1001}, {priority:1.5}, {priority:'1'}, {priority:1, password:'never-store'}, {priority:1, apiKey:'never-store'}, {priority:1, enabled:true}, {priority:1, connected:true}, {priority:1, whitelistingStatus:'CONFIRMED'}, {priority:1, environment:'PRODUCTION'}, {priority:1, tenantId:'other-tenant'}]) {
    assert.equal((await h.request('POST', body, '/integrations/akbar')).status, 400);
    assert.equal(h.values.get(h.key), before);
  }
  assert.equal((await h.request('PATCH', {isEnabled:true}, '/suppliers/AKBAR')).status, 409);
  assert.equal((await h.request('PUT', { ...h.body, password:'never-store' })).status, 400);
});
test('integration overview includes disabled Akbar and status ignores forged saved enablement', async () => {
  const h = harness(); h.values.set(h.key, JSON.stringify({enabled:true, environment:'PRODUCTION', priority:2, connected:true}));
  const res = await h.request('GET', undefined, '/integrations');
  const rows = await res.json() as any[]; const a = rows.find(r => r.supplier === 'AKBAR');
  assert.equal(a.enabled, false); assert.equal(a.connected, false); assert.equal(a.environment, 'UAT');
  assert.equal(a.whitelistingStatus, 'PENDING_CONFIRMATION'); assert.equal(a.priority, 2);
});
