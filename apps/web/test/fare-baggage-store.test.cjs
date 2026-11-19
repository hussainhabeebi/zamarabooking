// Results-page baggage from Akbar's free SSR (app/lib/fare-baggage-store.ts): asks each fare once, in
// small batches, stops when the API has the feature off, never breaks the page. No network.
const test = require('node:test'), assert = require('node:assert/strict'), ts = require('typescript'), fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const load = (rel) => { const file = path.resolve(__dirname, rel), m = new Module(file, module); m.paths = Module._nodeModulePaths(path.dirname(file)); m.filename = file; m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file); return m.exports; };
const store = load('../app/lib/fare-baggage-store.ts');
const PAX = { adults: 1, children: 0, infants: 0 };
const wait = () => new Promise((r) => setTimeout(r, 250));
const ok = (fares, enabled = true) => ({ ok: true, status: 200, json: async () => ({ enabled, fares }) });

test.beforeEach(() => store.resetBaggageStore());

test('batches of at most 6, each fare once; only Akbar fares', async () => {
  const calls = [];
  const f = async (url, init) => { const b = JSON.parse(init.body); calls.push(b.fareIds); return ok(Object.fromEntries(b.fareIds.map((id) => [id, { status: 'CONFIRMED', baggage: { checked: '15 kg', cabin: '7 kg', checkedStatus: 'INCLUDED', cabinStatus: 'INCLUDED' } }]))); };
  for (let i = 0; i < 8; i++) store.requestBaggage(`AK|t|6E|${i}`, PAX, f);
  store.requestBaggage('AK|t|6E|0', PAX, f);           // repeat: ignored
  store.requestBaggage('TJ-1', PAX, f);                // not Akbar: ignored
  await wait();
  assert.deepEqual(calls.map((c) => c.length), [6, 2]);
  assert.equal(store.baggageFor('AK|t|6E|7').baggage.checked, '15 kg');
});

test('feature off on the API (or the API without it yet): one call, then never again', async () => {
  let n = 0;
  const off = async () => { n++; return ok({}, false); };
  store.requestBaggage('AK|t|6E|1', PAX, off);
  await wait();
  store.requestBaggage('AK|t|6E|2', PAX, off);
  await wait();
  assert.equal(n, 1);
  store.resetBaggageStore();
  let m = 0;
  const missing = async () => { m++; return { ok: false, status: 404, json: async () => ({}) }; };
  store.requestBaggage('AK|t|6E|1', PAX, missing); await wait();
  store.requestBaggage('AK|t|6E|2', PAX, missing); await wait();
  assert.equal(m, 1);
});

test('failures leave the page as it is; BUSY may be asked again later', async () => {
  const boom = async () => { throw new Error('network'); };
  store.requestBaggage('AK|t|6E|1', PAX, boom);
  await wait();
  assert.equal(store.baggageFor('AK|t|6E|1'), undefined);
  let n = 0;
  const busy = async () => { n++; return ok({ 'AK|t|6E|9': { status: 'BUSY' } }); };
  store.requestBaggage('AK|t|6E|9', PAX, busy); await wait();
  store.requestBaggage('AK|t|6E|9', PAX, busy); await wait();
  assert.equal(n, 2);
});

test('the results page asks only for Akbar fares without confirmed baggage, and only the first cards automatically', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../app/search/page.tsx'), 'utf8');
  assert.match(src, /autoBaggage=\{i < 6\}/);
  assert.match(src, /needed: fare\.supplier === "AKBAR" && \(bag\.checked\.status === "UNKNOWN" \|\| bag\.cabin\.status === "UNKNOWN"\)/);
});
