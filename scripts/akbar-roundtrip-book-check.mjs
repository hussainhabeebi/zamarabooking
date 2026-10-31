// Live, NON-TRANSACTIONAL check that Akbar round-trip fares can be found at booking.
// Searches for 1 adult, then calls /api/book for 2 adults. The server looks up both
// legs' remembered fares before anything is written: a found fare is rejected with
// PASSENGERS_CHANGED (no booking created); a missing one with FARE_EXPIRED.
const API = process.argv[2] || 'https://api.zamrabooking.com';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const H = { 'Content-Type': 'application/json', 'x-tenant-slug': 'zamra' };
const post = async (path, body) => { const r = await fetch(`${API}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
let bad = 0;
for (const [name, dep, ret] of [['SAME-DAY', day(21), day(21)], ['NORMAL', day(21), day(25)]]) {
  const s = await post('/api/search', { origin: 'BOM', destination: 'DEL', departureDate: dep, returnDate: ret, tripType: 'ROUNDTRIP', adults: 1, children: 0, infants: 0, cabinClass: 'ECONOMY', currency: 'INR' });
  const fares = (s.body.fares ?? []).filter((f) => f.supplier === 'AKBAR');
  const onward = fares.filter((f) => f.tripKey === 'ONWARD' && f.airline === '6E');
  const back = fares.filter((f) => f.tripKey === 'RETURN' && f.airline === '6E');
  await new Promise((r) => setTimeout(r, 15000));   // remembered after the search response
  const pairs = [];
  for (let i = 0; i < 8 && onward.length; i++) {
    const o = onward[Math.floor((i * onward.length) / 8)];
    const later = back.filter((b) => b.departureTime.slice(0, 16) > o.arrivalTime.slice(0, 16));
    if (later.length) pairs.push([o, later[Math.floor((i * later.length) / 8)]]);
  }
  const results = {};
  for (const [o, b] of pairs) {
    const r = await post('/api/book', {
      fareId: o.id, priceIds: [o.id, b.id], supplier: 'AKBAR', tripType: 'ROUNDTRIP',
      passengers: [{ type: 'ADULT', firstName: 'Asha', lastName: 'Rao', gender: 'F' }, { type: 'ADULT', firstName: 'Ravi', lastName: 'Rao', gender: 'M' }],
      contactEmail: 'no-reply@example.com', contactPhone: '9000000000', origin: 'BOM', destination: 'DEL',
      departureDate: o.departureTime.slice(0, 10), totalFare: (o.displayPrice ?? o.totalFare) + (b.displayPrice ?? b.totalFare), currency: 'INR',
      baggageChoices: ['NONE', 'NONE'],
    });
    if (r.body.success) { console.error('UNEXPECTED: booking created', r.body.bookingId); process.exit(2); }
    const code = r.body.errorCode ?? `HTTP_${r.status}`;
    results[code] = (results[code] ?? 0) + 1;
    if (code !== 'PASSENGERS_CHANGED') { bad++; console.log(JSON.stringify({ trip: name, code, error: r.body.error, leg: r.body.leg, onward: `${o.flightNumber} ${o.departureTime}`, ret: `${b.flightNumber} ${b.departureTime}` })); }
  }
  console.log(JSON.stringify({ trip: name, dep, ret, searchStatus: s.status, akbarOnward6E: onward.length, akbarReturn6E: back.length, pairsChecked: pairs.length, results }));
}
process.exitCode = bad ? 1 : 0;
