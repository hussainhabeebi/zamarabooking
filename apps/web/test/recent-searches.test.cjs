// Recent searches (app/lib/recent-searches.ts): parsing, URLs, de-duplication, guest (localStorage)
// and signed-in (account API, mocked) storage. No live calls.
const test = require('node:test'), assert = require('node:assert/strict'), ts = require('typescript'), fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const file = path.resolve(__dirname, '../app/lib/recent-searches.ts'), m = new Module(file, module);
m.paths = Module._nodeModulePaths(path.dirname(file)); m.filename = file;
m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const R = m.exports;

// Browser stand-ins.
const store = new Map();
global.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let events = 0;
global.window = { dispatchEvent: () => { events++; } };
global.Event = class { constructor(t) { this.type = t; } };
let cookie = '';
global.document = { get cookie() { return cookie; } };
const signIn = (t) => { cookie = t ? `zamra_token=${t}` : ''; };

const at = (n) => new Date(Date.UTC(2026, 10, 17, 10, n)).toISOString();
const s = (over = {}) => ({ tripType: 'ONEWAY', origin: 'COK', destination: 'DOH', departureDate: '2099-11-24', adults: 1, children: 0, infants: 0, cabinClass: 'ECONOMY', searchedAt: at(0), ...over });

test.beforeEach(() => { store.clear(); signIn(''); events = 0; global.fetch = async () => { throw new Error('no network in tests'); }; });

test('results URL → search: one way, round trip, multi-city; incomplete URLs are ignored', () => {
  const one = R.searchFromParams(new URLSearchParams('origin=cok&destination=DOH&departureDate=2026-11-24&adults=2&children=1&infants=1&cabinClass=BUSINESS&tripType=ONEWAY&currency=AED&fareType=STUDENT&sort=price'));
  assert.deepEqual({ ...one, searchedAt: 'x' }, { tripType: 'ONEWAY', origin: 'COK', destination: 'DOH', departureDate: '2026-11-24', adults: 2, children: 1, infants: 1, cabinClass: 'BUSINESS', fareType: 'STUDENT', searchedAt: 'x' });
  const rt = R.searchFromParams(new URLSearchParams('origin=COK&destination=DXB&departureDate=2026-12-01&returnDate=2026-12-10&tripType=ROUNDTRIP'));
  assert.equal(rt.returnDate, '2026-12-10'); assert.equal(rt.adults, 1);
  const mc = R.searchFromParams(new URLSearchParams('tripType=MULTICITY&legs=COK-BOM-2026-12-01,BOM-DEL-2026-12-04,DEL-COK-2026-12-08'));
  assert.equal(mc.origin, 'COK'); assert.equal(mc.destination, 'COK'); assert.equal(mc.legs.length, 3); assert.equal(mc.departureDate, '2026-12-01');
  for (const bad of ['origin=COK&departureDate=2026-11-24', 'origin=COK&destination=DOH&departureDate=24-11-2026', 'origin=COK&destination=DXB&departureDate=2026-12-01&tripType=ROUNDTRIP', 'tripType=MULTICITY&legs=COK-BOM-2026-12-01']) {
    assert.equal(R.searchFromParams(new URLSearchParams(bad)), null, bad);
  }
});

test('Search again URL is the same search the form runs (fresh results page)', () => {
  assert.equal(R.searchUrl(s({ adults: 2, fareType: 'SENIOR_CITIZEN' }), 'INR'),
    '/search?origin=COK&destination=DOH&departureDate=2099-11-24&adults=2&children=0&infants=0&cabinClass=ECONOMY&tripType=ONEWAY&currency=INR&fareType=SENIOR_CITIZEN');
  const rt = R.searchUrl(s({ tripType: 'ROUNDTRIP', returnDate: '2099-12-01' }), 'AED');
  assert.ok(rt.startsWith('/search/journey?') && rt.includes('returnDate=2099-12-01') && rt.includes('currency=AED'));
  const mc = R.searchUrl(s({ tripType: 'MULTICITY', destination: 'DEL', legs: [{ origin: 'COK', destination: 'BOM', departureDate: '2099-12-01' }, { origin: 'BOM', destination: 'DEL', departureDate: '2099-12-04' }] }), 'INR');
  assert.ok(mc.includes('legs=COK-BOM-2099-12-01%2CBOM-DEL-2099-12-04'));
  // Round trip: the URL parses back to the same search.
  const back = R.searchFromParams(new URLSearchParams(rt.split('?')[1]));
  assert.equal(R.recentSearchKey(back), R.recentSearchKey(s({ tripType: 'ROUNDTRIP', returnDate: '2099-12-01' })));
});

test('keeps the last 4, newest first; repeating a search moves it to the top (no duplicates)', () => {
  let list = [];
  for (let i = 0; i < 12; i++) list = R.mergeRecentSearches([s({ destination: ['DOH', 'DXB', 'BOM', 'DEL', 'BLR', 'MAA', 'HYD', 'CCU', 'AUH', 'SHJ', 'MCT', 'RUH'][i], searchedAt: at(i) })], list);
  assert.equal(R.RECENT_SEARCH_LIMIT, 4);
  assert.deepEqual(list.map((x) => x.destination), ['RUH', 'MCT', 'SHJ', 'AUH']);   // only the newest 4
  list = R.mergeRecentSearches([s({ destination: 'SHJ', searchedAt: at(30) })], list);   // a repeat moves to the top, once
  assert.deepEqual(list.map((x) => x.destination), ['SHJ', 'RUH', 'MCT', 'AUH']);
  list = R.mergeRecentSearches([s({ destination: 'MAA', searchedAt: at(31) })], list);
  assert.deepEqual(list.map((x) => x.destination), ['MAA', 'SHJ', 'RUH', 'MCT']);
  // Different passengers / cabin / dates are different searches.
  const two = R.mergeRecentSearches([s({ adults: 2, searchedAt: at(1) })], [s()]);
  assert.equal(two.length, 2);
});

test('guest: stored in this browser; clear removes them', async () => {
  await R.recordRecentSearch(s());
  await R.recordRecentSearch(s({ destination: 'DXB', searchedAt: at(1) }));
  await R.recordRecentSearch(s({ searchedAt: at(2) }));   // repeat → top, once
  const list = await R.loadRecentSearches();
  assert.deepEqual(list.map((x) => x.destination), ['DOH', 'DXB']);
  assert.ok(events >= 3);
  await R.clearRecentSearches();
  assert.deepEqual(await R.loadRecentSearches(), []);
  store.set('zamra_recent_searches', '{not json'); assert.deepEqual(await R.loadRecentSearches(), []);   // damaged storage → empty, no error
});

test('signed in: saved with the account; guest searches move to the account once; clear clears both', async () => {
  const calls = [];
  let account = [s({ destination: 'BOM', searchedAt: at(0) })];
  global.fetch = async (url, init) => {
    calls.push([init.method, url, init.headers.Authorization]);
    if (init.method === 'POST') account = R.mergeRecentSearches(JSON.parse(init.body).searches, account);
    if (init.method === 'DELETE') account = [];
    return { ok: true, json: async () => ({ searches: account }) };
  };
  await R.recordRecentSearch(s({ destination: 'DXB', searchedAt: at(1) }));          // as a guest (no token)
  assert.equal(calls.length, 0);
  signIn('jwt-1');
  const first = await R.loadRecentSearches();                                          // guest list moved to the account
  assert.deepEqual(first.map((x) => x.destination), ['DXB', 'BOM']);
  assert.equal(store.get('zamra_recent_searches'), undefined);
  assert.deepEqual(calls[0], ['POST', 'https://api.zamrabooking.com/api/profile/recent-searches', 'Bearer jwt-1']);
  await R.recordRecentSearch(s({ searchedAt: at(2) }));
  assert.deepEqual((await R.loadRecentSearches()).map((x) => x.destination), ['DOH', 'DXB', 'BOM']);
  assert.equal(calls.at(-1)[0], 'GET');
  await R.clearRecentSearches();
  assert.equal(calls.at(-1)[0], 'DELETE');
  assert.deepEqual(await R.loadRecentSearches(), []);
});

test('signed in but the account API is down: falls back to this browser, nothing lost', async () => {
  signIn('jwt-1');
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await R.recordRecentSearch(s());
  assert.deepEqual((await R.loadRecentSearches()).map((x) => x.destination), ['DOH']);
});

test('labels and past dates', () => {
  assert.equal(R.routeLabel(s()), 'COK → DOH');
  assert.equal(R.routeLabel(s({ tripType: 'ROUNDTRIP', returnDate: '2099-12-01' })), 'COK ⇄ DOH');
  assert.equal(R.routeLabel(s({ tripType: 'MULTICITY', legs: [{ origin: 'COK', destination: 'BOM', departureDate: 'x' }, { origin: 'BOM', destination: 'DEL', departureDate: 'y' }] })), 'COK → BOM → DEL');
  assert.equal(R.paxLabel(s({ adults: 2, children: 1, infants: 1 })), '4 travellers');
  assert.equal(R.paxLabel(s()), '1 traveller');
  assert.equal(R.tripLabel(s({ tripType: 'MULTICITY', legs: [{}, {}, {}] })), 'Multi-city · 3 flights');
  assert.match(R.dateLabel('2026-11-24'), /^Tue,? 24 Nov$/);   // ICU builds differ on the comma
  assert.equal(R.searchDatePassed(s({ departureDate: '2026-11-16' }), '2026-11-17'), true);
  assert.equal(R.searchDatePassed(s({ departureDate: '2026-11-17' }), '2026-11-17'), false);
});

test('a browser list saved before the limit was 4 shows only its newest 4; the next search keeps 4', async () => {
  store.set('zamra_recent_searches', JSON.stringify(['DOH', 'DXB', 'BOM', 'DEL', 'BLR', 'MAA'].map((d, i) => s({ destination: d, searchedAt: at(50 - i) }))));
  assert.deepEqual((await R.loadRecentSearches()).map((x) => x.destination), ['DOH', 'DXB', 'BOM', 'DEL']);
  await R.recordRecentSearch(s({ destination: 'RUH', searchedAt: at(55) }));
  assert.deepEqual((await R.loadRecentSearches()).map((x) => x.destination), ['RUH', 'DOH', 'DXB', 'BOM']);
});

test('signed in: the website shows at most 4 even if the account still sends more', async () => {
  signIn('jwt-1');
  const many = ['DOH', 'DXB', 'BOM', 'DEL', 'BLR', 'MAA'].map((d, i) => s({ destination: d, searchedAt: at(60 - i) }));
  global.fetch = async () => ({ ok: true, json: async () => ({ searches: many }) });
  assert.deepEqual((await R.loadRecentSearches()).map((x) => x.destination), ['DOH', 'DXB', 'BOM', 'DEL']);
});
