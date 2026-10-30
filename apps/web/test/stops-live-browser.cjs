// Live website check of the stops filter (search only; never opens checkout).
// Usage: node stops-live-browser.cjs <dir with @playwright/test> [site]
const { createRequire } = require('node:module');
const path = require('node:path');
const { chromium } = createRequire(path.resolve(process.argv[2], 'package.json'))('@playwright/test');
const site = process.argv[3] || 'https://zamrabooking.com';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const labelOf = (t) => (/non-?stop/i.test(t) ? 0 : Number(/(\d+)\s*stops?/i.exec(t)?.[1] ?? NaN));

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  try {
    for (const [name, width] of [['desktop', 1280], ['mobile', 390]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      // One-way: server-filtered results page.
      for (const stops of ['', '0', '1', '2']) {
        const url = `${site}/search?tripType=ONEWAY&origin=BOM&destination=DEL&departureDate=${day(21)}&adults=1&cabinClass=ECONOMY&all=1${stops ? `&stops=${stops}` : ''}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.locator('.fare-card-v2-stops-label, .no-results-trip-card, h2').first().waitFor({ timeout: 90000 }).catch(() => {});
        const cards = await page.locator('.fare-card-v2').evaluateAll((els) => els.map((e) => ({
          label: e.querySelector('.fare-card-v2-stops-label')?.textContent?.trim() ?? '',
          via: e.querySelector('.fare-card-v2-via')?.textContent?.trim() ?? '',
          duration: e.querySelector('.fare-card-v2-duration')?.textContent?.trim() ?? '',
        })));
        const counts = {};
        for (const c of cards) counts[c.label] = (counts[c.label] ?? 0) + 1;
        const wrong = stops === '' ? [] : cards.filter((c) => (stops === '2' ? !(labelOf(c.label) >= 2) : labelOf(c.label) !== Number(stops)));
        const viaMissing = cards.filter((c) => labelOf(c.label) > 0 && !c.via).length;
        console.log(JSON.stringify({ view: name, trip: 'ONEWAY', stops: stops || 'any', cards: cards.length, counts, wrong: wrong.length, viaMissing, sample: cards.find((c) => labelOf(c.label) > 0) ?? null }));
        if (wrong.length) failed = true;
      }
      // Round trip: filter applied to each leg list on the journey page.
      for (const stops of ['0', '1']) {
        const url = `${site}/search/journey?tripType=ROUNDTRIP&origin=BOM&destination=DEL&departureDate=${day(21)}&returnDate=${day(28)}&adults=1&cabinClass=ECONOMY&stops=${stops}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.locator('[id^="leg-"]').first().waitFor({ timeout: 90000 }).catch(() => {});
        const legs = await page.locator('[id^="leg-"]').evaluateAll((secs) => secs.map((s) => ({
          leg: s.id, labels: [...s.querySelectorAll('button')].map((b) => /(Non-stop|\d+ stops?)/.exec(b.textContent ?? '')?.[1]).filter(Boolean),
        })));
        const wrong = legs.flatMap((l) => l.labels.filter((t) => labelOf(t) !== Number(stops)));
        console.log(JSON.stringify({ view: name, trip: 'ROUNDTRIP', stops, legs: legs.map((l) => ({ leg: l.leg, cards: l.labels.length, distinct: [...new Set(l.labels)] })), wrong: wrong.length }));
        if (wrong.length) failed = true;
      }
      await page.close();
    }
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
