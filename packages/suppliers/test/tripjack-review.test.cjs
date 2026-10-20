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

test('TripJack review contract and safe error handling', async (t) => {
  const { TripjackClient } = await import(moduleUrl('../src/tripjack/client.ts'));
  const client = new TripjackClient({ baseUrl: 'https://gateway.example', apiKey: 'test' });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  await t.test('sends priceIds and returns reviewed booking ID', async () => {
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://gateway.example/fms/v1/review');
      assert.deepEqual(JSON.parse(options.body), { priceIds: ['price-1'] });
      assert.ok(options.signal);
      return Response.json({ bookingId: 'review-1', status: { success: true } });
    };
    assert.equal((await client.validateFare('price-1')).bookingId, 'review-1');
  });

  await t.test('unspecified supplier failure is not invented expiry', async () => {
    global.fetch = async () => Response.json({ status: { success: false } });
    await assert.rejects(client.validateFare('price-1'), (err) => {
      assert.equal(err.code, 'REVIEW_REJECTED');
      return true;
    });
  });

  await t.test('missing booking session fails closed', async () => {
    global.fetch = async () => Response.json({ status: { success: true } });
    await assert.rejects(client.validateFare('price-1'), (err) => err.code === 'REVIEW_INVALID_RESPONSE');
  });

  await t.test('route 404 is not fare expiry', async () => {
    global.fetch = async () => new Response('{}', { status: 404 });
    await assert.rejects(client.validateFare('price-1'), (err) => err.code === 'REVIEW_ROUTE_UNAVAILABLE');
  });

  await t.test('TripJack 404 error body means the fare is gone', async () => {
    global.fetch = async () => Response.json({ status: { success: false, httpStatus: 404 }, errors: [{ errCode: '2502', message: 'Invalid price id' }] }, { status: 404 });
    await assert.rejects(client.validateFare('price-1'), (err) => {
      assert.equal(err.code, 'FARE_EXPIRED');
      assert.match(err.supplierMessage, /Invalid price id/);
      return true;
    });
  });

  await t.test('explicit supplier fare expiry is preserved', async () => {
    global.fetch = async () => Response.json({ status: { success: false, statusMessage: 'Fare has expired' } });
    await assert.rejects(client.validateFare('price-1'), /Fare has expired/);
  });

  for (const wrapper of ['data', 'result']) await t.test(`accepts ${wrapper}-wrapped review`, async () => {
    global.fetch = async () => Response.json({ [wrapper]: { status: { success: true }, bookingId: 'wrapped' } });
    assert.equal((await client.validateFare('price-1')).bookingId, 'wrapped');
  });
  await t.test('credential expiry cannot be mistaken for fare expiry', async () => {
    global.fetch = async () => Response.json({ errors: [{ errCode: '6041', message: 'API token expired' }] }, { status: 401 });
    await assert.rejects(client.validateFare('price-1'), (err) => err.code === 'REVIEW_AUTH_FAILED');
  });
  await t.test('HTTP 400 structured fare expiry is recognised', async () => {
    global.fetch = async () => Response.json({ errors: [{ message: 'Fare has expired' }] }, { status: 400 });
    await assert.rejects(client.validateFare('price-1'), (err) => err.code === 'FARE_EXPIRED');
  });
});

test('TripJack seat map parsing and seat pricing', async () => {
  const { parseTripjackSeatMap, seatTotal } = await import(moduleUrl('../src/tripjack/seat-map.ts'));
  const maps = parseTripjackSeatMap({ tripSeatMap: { tripSeat: { SEG1: { sData: { row: 30, column: 6 }, sInfo: [
    { seatNo: '1A', code: '1A', seatPosition: { row: 1, column: 1 }, isBooked: false, amount: 500, isLegroom: true },
    { seatNo: '1B', code: '1B', seatPosition: { row: 1, column: 2 }, isBooked: true, amount: 0 },
    { seatNo: '12C', code: '12C', amount: 250, isAisle: true },
  ] } } } });
  assert.equal(maps.length, 1);
  assert.equal(maps[0].key, 'SEG1');
  assert.equal(maps[0].rows, 30);
  assert.deepEqual([maps[0].seats[2].row, maps[0].seats[2].column], [12, 3]);
  assert.deepEqual(seatTotal(maps, [{ type: 'ADULT', ssr: { seat: [{ key: 'SEG1', code: '1A' }] } }, { type: 'CHILD', ssr: { seat: [{ key: 'SEG1', code: '12C' }] } }]), { total: 750, invalid: [] });
  assert.equal(seatTotal(maps, [{ type: 'ADULT', ssr: { seat: [{ key: 'SEG1', code: '1B' }] } }]).invalid.length, 1);
  assert.equal(seatTotal(maps, [{ ssr: { seat: [{ key: 'SEG1', code: '1A' }] } }, { ssr: { seat: [{ key: 'SEG1', code: '1A' }] } }]).invalid.length, 1);
  assert.equal(seatTotal(maps, [{ type: 'INFANT', ssr: { seat: [{ key: 'SEG1', code: '1A' }] } }]).invalid.length, 1);
});

test('TripJack search price covers every traveller', async () => {
  const { normalizeTripjackFare } = await import(moduleUrl('../src/tripjack/normalizer.ts'));
  const r = { id: 'P1', sI: [{ fD: { aI: { code: 'AI' }, fN: '996' }, da: { code: 'DXB' }, aa: { code: 'BKK' } }],
    totalPriceInfo: { fd: { ADULT: { fC: { BF: 1500, TAF: 304.9, TF: 1804.9 } }, CHILD: { fC: { BF: 1200, TAF: 300, TF: 1500 } }, INFANT: { fC: { BF: 150, TAF: 50, TF: 200 } } } } };
  const f = normalizeTripjackFare(r, { pax: { adults: 5, children: 3, infants: 2 } });
  assert.equal(f.totalFare, 5 * 1804.9 + 3 * 1500 + 2 * 200);
  assert.equal(f.perAdultFare, 1804.9);
  assert.equal(normalizeTripjackFare(r).totalFare, 1804.9);   // no pax context: unchanged
});

test('Review total covers every traveller, never one adult', async () => {
  const { reviewTotalFare } = await import(moduleUrl('../src/tripjack/review.ts'));
  const perPax = { fd: { ADULT: { fC: { TF: 1800 } }, CHILD: { fC: { TF: 1500 } }, INFANT: { fC: { TF: 200 } } } };
  // totalFareDetail wins over the per-adult fd
  assert.equal(reviewTotalFare({ tripInfos: [{ totalPriceInfo: perPax }], totalPriceInfo: { totalFareDetail: { fC: { TF: 15400 } } } }).TF, 15400);
  // only per-pax fd: summed over the passengers
  assert.equal(reviewTotalFare({ tripInfos: [{ totalPriceInfo: perPax }] }, { adults: 5, children: 3, infants: 2 }).TF, 5 * 1800 + 3 * 1500 + 2 * 200);
  // pax counts from the review's own searchQuery
  assert.equal(reviewTotalFare({ tripInfos: [{ totalPriceInfo: perPax }], searchQuery: { paxInfo: { ADULT: 1, CHILD: 0, INFANT: 0 } } }).TF, 1800);
  // unknown pax and no total: no guess
  assert.equal(reviewTotalFare({ tripInfos: [{ totalPriceInfo: perPax }] }).TF, undefined);
});

test('TripJack error text comes from errors[]', async () => {
  const { tripjackErrorText } = await import(moduleUrl('../src/tripjack/client.ts'));
  assert.equal(tripjackErrorText({ errors: [{ errCode: '2023', message: 'Amount mismatch' }], status: { success: false } }), '2023: Amount mismatch');
  assert.equal(tripjackErrorText({ status: { statusMessage: 'Session expired' } }), 'Session expired');
});

test('Hotel v3 client records every request / response (incl. failures)', async () => {
  const { TripjackHotelV3Client } = await import(moduleUrl('../src/tripjack/hotel-v3.ts'));
  const seen = [];
  const client = new TripjackHotelV3Client({ baseUrl: 'https://gw.example', apiKey: 'KEY', proxyKey: 'P', recorder: (x) => seen.push(x) });
  const realFetch = globalThis.fetch;
  const replies = [
    new Response(JSON.stringify({ hotels: [] }), { status: 200 }),
    new Response(JSON.stringify({ error: { code: '6535', message: 'Price changed' } }), { status: 400 }),
  ];
  globalThis.fetch = async () => replies.shift();
  try {
    await client.listing({ checkIn: '2026-10-01', checkOut: '2026-10-02', rooms: [{ adults: 1 }], currency: 'INR', correlationId: 'c1234567', nationality: '106', hids: ['1'] });
    await assert.rejects(client.review({ correlationId: 'c1234567', optionId: 'o', reviewHash: 'h', hid: '1' }), /Price changed/);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(seen.length, 2);
  assert.equal(seen[0].endpoint, '/hms/v3/hotel/listing');
  assert.equal(seen[0].requestHeaders.apikey, 'KEY');
  assert.equal(seen[0].status, 200);
  assert.equal(seen[1].status, 400);
  assert.match(seen[1].responseBody, /Price changed/);
});

test('TripJack baggage is supplier-confirmed across all journey contexts', async () => {
  const { normalizeTripjackFare } = await import(moduleUrl('../src/tripjack/normalizer.ts'));
  const normalize = (bI, context = {}) => normalizeTripjackFare({ id: 'real-price', totalPriceInfo: { fd: { ADULT: { bI } } } }, context);
  const actual = { cB: ' 8 KG ', iB: '2 pieces · 23 KG each' };
  assert.deepEqual(normalize(actual).baggage, { cabin: actual.cB, checked: actual.iB });
  for (const context of [{}, { tripKey: 'RETURN', legIndex: 1 }, { tripKey: '2', legIndex: 2 }, { tripKey: 'COMBO' }]) {
    for (const bI of [undefined, null, {}, { cB: null, iB: null }, { cB: '', iB: '' }, { cB: '  ', iB: '\t' }]) {
      assert.deepEqual(normalize(bI, context).baggage, { cabin: '', checked: '' });
    }
  }
});

test('actual results filter and booking handoff preserve unknown baggage', async () => {
  const { normalizeTripjackFare } = await import(moduleUrl('../src/tripjack/normalizer.ts'));
  const file = path.resolve(__dirname, '../../../apps/web/app/search/page.tsx');
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter((s) => ts.isFunctionDeclaration(s) && ['filterAndSortFares', 'buildBookUrl'].includes(s.name?.text));
  assert.equal(functions.length, 2);
  const js = ts.transpileModule(functions.map((f) => f.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { filterAndSortFares, buildBookUrl } = new Function(js + ';return { filterAndSortFares, buildBookUrl };')();
  const unknown = normalizeTripjackFare({ id: 'unknown', totalPriceInfo: {} });
  const known = normalizeTripjackFare({ id: 'known', totalPriceInfo: { fd: { ADULT: { bI: { iB: '20 KG' } } } } });
  assert.deepEqual(filterAndSortFares([unknown, known], { baggage: '1' }).map((f) => f.id), ['known']);
  assert.equal(filterAndSortFares([unknown, known], {}).length, 2);
  for (const fare of [unknown, { id: 'absent', supplier: 'TRIPJACK' }, known]) {
    const url = new URL(buildBookUrl(fare, 'INR', 100, 1), 'https://test.example');
    assert.equal(url.searchParams.get('bag'), fare.baggage?.checked ?? '');
    assert.equal(url.searchParams.get('fareId'), fare.id);
  }
  const book = fs.readFileSync(path.resolve(__dirname, '../../../apps/web/app/book/page.tsx'), 'utf8');
  const bookAst = ts.createSourceFile('book.tsx', book, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let allowance;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(bookAst) === 'cabinChecked') allowance = node.initializer.getText(bookAst);
    ts.forEachChild(node, visit);
  }
  visit(bookAst);
  assert.ok(allowance);
  const read = new Function('q', `return ${allowance}`);
  for (const query of ['', 'bag=']) assert.equal(read(new URLSearchParams(query)), '');
  assert.equal(read(new URLSearchParams('bag=20+KG')), '20 KG');
  assert.match(book, /Checked baggage allowance not provided/);
  assert.doesNotMatch(book, /15 KG/);
});

test('extra-baggage selections, prices and supplier booking payload are preserved', async (t) => {
  const { parseTripjackReview, ssrTotal } = await import(moduleUrl('../src/tripjack/review.ts'));
  const { TripjackClient } = await import(moduleUrl('../src/tripjack/client.ts'));
  const summary = parseTripjackReview({ bookingId: 'review-ssr', tripInfos: [{ sI: [{ id: 'segment-1', ssrInfo: { BAGGAGE: [{ code: 'BAG5', amount: 1250, desc: 'Extra 5 KG' }] } }] }] });
  assert.deepEqual(summary.segments[0].ssr.baggage, [{ code: 'BAG5', amount: 1250, desc: 'Extra 5 KG' }]);
  const picks = [{ key: summary.segments[0].key, code: 'BAG5' }];
  const passenger = { type: 'ADULT', firstName: 'Test', lastName: 'Traveller', gender: 'M', ssr: { baggage: picks } };
  assert.deepEqual(ssrTotal(summary.segments, [passenger]), { total: 1250, invalid: [] });
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let body;
  global.fetch = async (_url, options) => { body = JSON.parse(options.body); return Response.json({ status: { success: true } }); };
  await new TripjackClient({ baseUrl: 'https://gateway.example', apiKey: 'test' }).book({ holdId: 'review-ssr', passengers: [passenger], contactPhone: '919999999999', contactEmail: 'test@example.com', paymentAmount: 11250 });
  assert.deepEqual(body.travellerInfo[0].ssrBaggageInfos, picks);
  assert.deepEqual(passenger.ssr.baggage, picks);
});
