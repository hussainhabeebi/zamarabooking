const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const source = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const url = (s) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64');

test('hotel listing ID survives normalization, checkout URL and pricing', async (t) => {
  const supplierUrl = url(source('packages/suppliers/src/tripjack/hotel-v3.ts'));
  const { TripjackHotelV3Client, validHotelId } = await import(supplierUrl);
  const lib = source('apps/api/src/lib/hotels.ts').replace('"@poomas/suppliers"', JSON.stringify(supplierUrl)).replace(/^import .* from "\.\/api-exchanges\.js";$/m, '');
  const { searchHotels } = await import(url(lib));
  const option = { optionId: 'option-123', pricing: { totalPrice: 100, currency: 'INR' } };
  const invalid = [undefined, null, '', 'undefined', 'null', 'NULL', 'bad id'];
  const client = {
    listing: async () => ({ hotels: [{ hotelId: '100000569607', name: 'Test hotel', options: [option] }, ...invalid.map(hotelId => ({ hotelId, options: [option] }))] }),
    hotelContent: async (ids) => { assert.deepEqual(ids, ['100000569607']); return { hotels: [] }; },
  };
  const env = { FARE_CACHE_KV: { get: async () => null, put: async () => {} } };
  const input = { hids: ['100000569607'], checkIn: '2026-10-14', checkOut: '2026-10-22', rooms: [{ adults: 1, children: 0 }], nationality: '106', currency: 'INR' };
  const result = await searchHotels(env, client, input);
  assert.equal(result.hotels.length, 1);
  const hotel = result.hotels[0];
  assert.equal(hotel.hid, '100000569607'); assert.equal(hotel.hotelCode, hotel.hid); assert.equal(hotel.id, 'option-123');
  const page = source('apps/web/app/hotels/search/page.tsx');
  const buildSource = page.slice(page.indexOf('function buildBookUrl('), page.indexOf('function Stars('));
  const { buildBookUrl } = await import(url(buildSource + '\nexport { buildBookUrl };'));
  const q = new URL(buildBookUrl(hotel, 1, 1), 'https://example.test').searchParams;
  assert.equal(q.get('hid'), hotel.hid); assert.equal(q.get('optionId'), hotel.id); assert.equal(q.get('sid'), result.correlationId);
  const originalFetch = global.fetch; t.after(() => { global.fetch = originalFetch; });
  const pricing = new TripjackHotelV3Client({ baseUrl: 'https://gateway.example', apiKey: 'test' });
  let calls = 0;
  const req = { hid: q.get('hid'), correlationId: q.get('sid'), checkIn: q.get('checkIn'), checkOut: q.get('checkOut'), rooms: input.rooms, nationality: input.nationality, currency: q.get('currency') };
  global.fetch = async (endpoint, options) => { calls++; assert.equal(endpoint, 'https://gateway.example/hms/v3/hotel/pricing'); assert.deepEqual(JSON.parse(options.body), req); return Response.json({ status: { success: true }, hotelId: req.hid, options: [option] }); };
  await pricing.pricing(req); assert.equal(calls, 1);
  for (const hid of invalid) { assert.equal(validHotelId(hid), false); assert.throws(() => pricing.pricing({ ...req, hid }), /Invalid TripJack hotel ID/); }
  assert.equal(calls, 1);
  const checkout = source('apps/web/app/hotels/book/page.tsx');
  assert.match(checkout, /hid:\s+q.get\("hid"\)/);
  assert.match(checkout, /hid: info.hid, optionId/);
  const api = source('apps/api/src/routes/hotel.ts');
  assert.match(api, /hid: z.string\(\).refine\(validHotelId/);
  assert.match(api, /client.pricing\(\{ correlationId: p.correlationId, hid: p.hid/);
});
