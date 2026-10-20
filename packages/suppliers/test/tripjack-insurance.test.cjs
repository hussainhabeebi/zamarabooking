const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function moduleUrl(file) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return 'data:text/javascript;base64,' + Buffer.from(output.replace(
    /from "(\.[^"]+\.js)"/g,
    (_, dependency) => 'from ' + JSON.stringify(moduleUrl(path.join(path.dirname(file), dependency.replace(/\.js$/, '.ts')))),
  )).toString('base64');
}

const load = () => import(moduleUrl('../src/tripjack/insurance.ts'));
const today = '2026-09-29';

test('TripSafe search bodies match the v2 samples', async () => {
  const { tripsafeSearchBody } = await load();
  const dobs = ['1990-01-01'];
  assert.deepEqual(tripsafeSearchBody({ journey: 'STUDENT', startDate: '2026-10-04', endDate: '2027-01-01', coverageDuration: 180, destinations: [{ key: 'us', type: 'COUNTRY' }], travellerDobs: dobs }),
    { startDate: '2026-10-04', travellerDobs: dobs, destinations: [{ key: 'US', type: 'COUNTRY' }], coverageDuration: 180, planType: 'STUDENT' });
  assert.deepEqual(tripsafeSearchBody({ journey: 'AMT', startDate: '2026-10-04', coverageDuration: 45, destinations: [{ key: 'EUR', type: 'REGION' }], travellerDobs: dobs }),
    { startDate: '2026-10-04', travellerDobs: dobs, coverageDuration: 45, planType: 'AMT', destinations: [{ key: 'EUR', type: 'POPULARREGION' }] });
  assert.deepEqual(tripsafeSearchBody({ journey: 'DOMESTIC', startDate: '2026-10-04', endDate: '2026-10-10', destinations: [], travellerDobs: dobs }),
    { startDate: '2026-10-04', travellerDobs: dobs, endDate: '2026-10-10', destinations: [{ key: 'IN', type: 'COUNTRY' }], journeyType: 'DOMESTIC' });
  assert.equal(tripsafeSearchBody({ journey: 'EMBEDDED', startDate: '2026-10-04', endDate: '2027-01-02', destinations: [{ key: 'MDE', type: 'REGION' }], travellerDobs: dobs }).funnelType, 'EMBEDDED');
  assert.equal(tripsafeSearchBody({ journey: 'STANDALONE', startDate: '2026-10-04', endDate: '2026-10-08', destinations: [{ key: 'US', type: 'COUNTRY' }], travellerDobs: dobs }).funnelType, 'STANDALONE');
});

test('TripSafe validation rules', async () => {
  const { tripsafeProblems } = await load();
  const ok = (x) => assert.deepEqual(tripsafeProblems(x, today), []);
  const bad = (x, re) => assert.ok(tripsafeProblems(x, today).some((p) => re.test(p)), JSON.stringify(tripsafeProblems(x, today)));
  const base = { journey: 'STANDALONE', startDate: '2026-10-04', endDate: '2026-10-08', destinations: [{ key: 'US', type: 'COUNTRY' }], travellerDobs: ['1990-01-01'] };
  ok(base);
  ok({ ...base, endDate: '2027-04-01' });                                     // Today+5 → Today+180
  bad({ ...base, endDate: '2027-04-10' }, /180 days/);
  bad({ ...base, startDate: '2026-09-01' }, /today or later/);
  bad({ ...base, travellerDobs: Array(11).fill('1990-01-01') }, /maximum of 10/);
  bad({ ...base, travellerDobs: ['1950-01-01'] }, /above 70/);
  bad({ ...base, destinations: [{ key: 'IR', type: 'COUNTRY' }] }, /does not cover IR/);
  bad({ ...base, journey: 'DOMESTIC', destinations: [], endDate: '2026-11-10' }, /30 days/);
  ok({ journey: 'STUDENT', startDate: '2026-10-04', coverageDuration: 365, destinations: [{ key: 'MY', type: 'COUNTRY' }], travellerDobs: ['1990-01-01', '2000-05-05'] });
  bad({ journey: 'STUDENT', startDate: '2026-10-04', coverageDuration: 100, destinations: [{ key: 'MY', type: 'COUNTRY' }], travellerDobs: ['1990-01-01'] }, /30 \/ 60/);
  bad({ journey: 'STUDENT', startDate: '2026-10-04', coverageDuration: 180, destinations: [{ key: 'MY', type: 'COUNTRY' }], travellerDobs: ['2012-01-01'] }, /18–45/);
  bad({ journey: 'STUDENT', startDate: '2026-10-04', coverageDuration: 180, destinations: [{ key: 'EUR', type: 'REGION' }], travellerDobs: ['1990-01-01'] }, /country/);
  ok({ journey: 'AMT', startDate: '2026-10-04', coverageDuration: 60, destinations: [{ key: 'EUR', type: 'POPULARREGION' }], travellerDobs: Array(8).fill('1990-01-01') });
  bad({ journey: 'AMT', startDate: '2026-10-04', coverageDuration: 50, destinations: [{ key: 'EUR', type: 'POPULARREGION' }], travellerDobs: ['1990-01-01'] }, /30 \/ 45/);
  bad({ journey: 'AMT', startDate: '2026-10-04', coverageDuration: 30, destinations: [{ key: 'US', type: 'COUNTRY' }], travellerDobs: ['1990-01-01'] }, /regions/);
});

test('TripSafe client handles the envelope, raw 401 and direct amendment responses', async () => {
  const { TripjackInsuranceClient, TripsafeError } = await load();
  const exchanges = [];
  const client = new TripjackInsuranceClient({ baseUrl: 'https://gw.example/', apiKey: 'KEY', proxyKey: 'P', recorder: (x) => exchanges.push(x) });
  const replies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const r = replies.shift(); r.check?.(url, init); return new Response(r.body, { status: r.status ?? 200 }); };
  try {
    replies.push({ body: JSON.stringify({ success: true, data: { searchId: 'isid1', productInfo: [{ productId: 'P1' }] } }),
      check: (url, init) => { assert.equal(url, 'https://gw.example/insurance/v2/search'); assert.equal(init.headers.apikey, 'KEY'); } });
    assert.equal((await client.search({ startDate: '2026-10-04', travellerDobs: [], destinations: [] })).searchId, 'isid1');

    replies.push({ body: JSON.stringify({ success: true, data: { status: 'SUCCESS', bookingId: 'TJS1' } }),
      check: (url, init) => { assert.equal(url, 'https://gw.example/insurance/v2/booking/TJS1'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); } });
    assert.equal((await client.bookingDetail('TJS1')).status, 'SUCCESS');

    replies.push({ status: 401, body: JSON.stringify({ path: '/insurance/v2/search', error: 'Unauthorized', message: 'Invalid Access', status: 401 }) });
    await assert.rejects(client.search({}), (e) => e instanceof TripsafeError && e.code === 'UNAUTHORIZED' && e.statusCode === 401);

    replies.push({ status: 400, body: JSON.stringify({ success: false, error: { code: 'INS_8343', message: 'Invalid insurance search criteria' } }) });
    await assert.rejects(client.search({}), (e) => e.code === 'INS_8343' && /Invalid insurance search criteria/.test(e.message));

    replies.push({ body: JSON.stringify({ amendmentItems: [{ amendmentId: 'A1', status: 'REQUESTED', amount: 10 }] }),
      check: (_url, init) => assert.equal(JSON.parse(init.body).amendmentId, '') });
    assert.equal((await client.raiseAmendment({ bookingId: 'TJS1', type: 'CANCELLATION', travellerKeys: {} })).amendmentItems[0].amendmentId, 'A1');

    assert.equal(exchanges.length, 5);
    assert.equal(exchanges[1].method, 'GET');
    assert.equal(exchanges[2].status, 401);
    await assert.rejects(client.bookingDetail('../x'), /Invalid TripSafe booking ID/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('TripSafe product and booking normalizers', async () => {
  const { normalizeTripsafeProduct, parseTripsafeBooking } = await load();
  const p = normalizeTripsafeProduct({ productId: 'X', planCoverage: '$50,000', fareDetails: { totalFare: 118 },
    productBenefits: [{ name: 'A', visibility: 'BANNER' }, { name: 'A', visibility: 'BANNER' }, { name: 'B', visibility: 'POPUP' }],
    paxFareDetails: [{ age: 30, insuranceFareComponents: { TF: 118 } }] });
  assert.deepEqual(p.banners, ['A']);
  assert.equal(p.benefits.length, 1);
  assert.equal(p.paxFares[0].totalFare, 118);
  const b = parseTripsafeBooking({ bookingId: 'TJS1', status: 'SUCCESS', productInfo: { productName: '$50,000',
    insuranceTravellerInfos: [{ id: 1, title: 'MS', firstName: 'BETA', lastName: 'TEST', policyId: 'TSON1', coiUrl: 'https://x/coi.pdf', fareDetail: { fareComponents: { TF: 1060 } } }] } });
  assert.equal(b.travellers[0].name, 'MS BETA TEST');
  assert.equal(b.travellers[0].policyId, 'TSON1');
  assert.equal(b.travellers[0].totalFare, 1060);
});
