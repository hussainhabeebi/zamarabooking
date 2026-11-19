// Customer search tracking, website side (app/lib/visitor.ts): what the website sends the API
// (the JSON body field `tracking`).
// No network.
const test = require('node:test'), assert = require('node:assert/strict'), ts = require('typescript'), fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
const load = (rel) => { const file = path.resolve(__dirname, rel), m = new Module(file, module); m.paths = Module._nodeModulePaths(path.dirname(file)); m.filename = file; m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file); return m.exports; };
const V = load('../app/lib/visitor.ts');

const VISITOR = '6f9c1b2e-7a4d-4c3b-9e1f-2a3b4c5d6e7f';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const reader = (o) => (n) => o[n.toLowerCase()] ?? o[n] ?? null;

test('tracking field: website marker, device, country, visitor, customer login — a body field, never headers', () => {
  const t = V.serverTracking(reader({ 'user-agent': IPHONE, 'cf-ipcountry': 'ae' }), reader({ zb_vid: VISITOR, zamra_token: 'jwt%2Ex' }));
  assert.deepEqual(t, { client: 'web', device: 'mobile', country: 'AE', visitor: VISITOR, customer: 'jwt.x' });
  // The pages send it as the JSON body field `tracking`, never as Authorization or custom headers
  // (a browser request with new headers would fail before the API with tracking is live).
  for (const f of ['../app/search/page.tsx', '../app/search/journey/page.tsx', '../app/book/page.tsx', '../middleware.ts']) {
    const src = fs.readFileSync(path.resolve(__dirname, f), 'utf8');
    assert.ok(!/X-ZB-/.test(src), f);
    assert.match(src, /tracking/, f);
  }
});

test('Global Privacy Control / Do Not Track: no visitor id is sent', () => {
  for (const flag of [{ 'sec-gpc': '1' }, { dnt: '1' }]) {
    const t = V.serverTracking(reader({ 'user-agent': IPHONE, ...flag }), reader({ zb_vid: VISITOR }));
    assert.equal(t.visitor, undefined);
    assert.equal(V.optedOut(reader(flag)), true);
  }
});

test('bots and prefetches are flagged so the API does not count them', () => {
  assert.equal(V.serverTracking(reader({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }), reader({})).bot, true);
  assert.equal(V.serverTracking(reader({ 'user-agent': IPHONE, 'next-router-prefetch': '1' }), reader({})).prefetch, true);
  assert.equal(V.isPrefetch(reader({ 'sec-purpose': 'prefetch;prerender' })), true);
  assert.equal(V.isPrefetch(reader({})), false);
  assert.equal(V.serverTracking(reader({ 'user-agent': IPHONE }), reader({})).bot, undefined);
});

test('a malformed visitor cookie is not sent; the India day rolls over at midnight IST', () => {
  assert.equal(V.serverTracking(reader({ 'user-agent': IPHONE }), reader({ zb_vid: 'abc' })).visitor, undefined);
  assert.equal(V.istDay(new Date('2026-11-19T18:29:00Z')), '2026-11-19');
  assert.equal(V.istDay(new Date('2026-11-19T18:31:00Z')), '2026-11-20');
});

test('the website and API use the same bot list', () => {
  const api = fs.readFileSync(path.resolve(__dirname, '../../api/src/lib/search-analytics.ts'), 'utf8');
  const web = fs.readFileSync(path.resolve(__dirname, '../app/lib/visitor.ts'), 'utf8');
  const re = (s) => s.match(/const BOT_RE = (\/.*\/i);/)[1];
  assert.equal(re(web), re(api));
});
