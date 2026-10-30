// Read-only: one-way SEARCH requests only (no review, booking or payment).
// Prints how Akbar fares' stop counts line up with their timing and stop details.
const API = process.argv[2] || 'https://api.zamrabooking.com';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const routes = [['BOM', 'DEL'], ['COK', 'DXB'], ['BOM', 'DXB'], ['DEL', 'BLR']];
for (const [o, d] of routes) {
  const r = await fetch(`${API}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tenant-slug': 'zamra' },
    body: JSON.stringify({ origin: o, destination: d, departureDate: day(21), adults: 1, children: 0, infants: 0, cabinClass: 'ECONOMY', tripType: 'ONEWAY', currency: 'INR' }) });
  const j = await r.json().catch(() => ({}));
  const fares = (j.fares ?? []).filter((f) => f.supplier === 'AKBAR');
  const byStops = {};
  for (const f of fares) byStops[f.stops] = (byStops[f.stops] ?? 0) + 1;
  const pick = (s) => fares.filter((f) => String(f.stops) === s).slice(0, 4).map((f) => ({
    stops: f.stops, flightNumber: f.flightNumber, airline: f.airline, dep: f.departureTime, arr: f.arrivalTime, duration: f.duration,
    stopDetails: f.stopDetails, segments: f.segments?.length, keys: Object.keys(f).join(','),
  }));
  console.log(JSON.stringify({ route: `${o}-${d}`, status: r.status, akbarFares: fares.length, byStops, samples: { '0': pick('0'), '1': pick('1'), '2': pick('2') } }));
}
