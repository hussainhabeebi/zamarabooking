// Live website check of round-trip / multi-city results. Search only: never clicks
// Continue, so no checkout, booking or payment is started.
// Usage: node journey-live-browser.cjs <dir with @playwright/test> [site url]
const { createRequire } = require('node:module');
const path = require('node:path');
const { chromium } = createRequire(path.resolve(process.argv[2], 'package.json'))('@playwright/test');
const site = process.argv[3] || 'https://zamrabooking.com';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const journeys = {
  ROUNDTRIP: `tripType=ROUNDTRIP&origin=BOM&destination=DEL&departureDate=${day(21)}&returnDate=${day(28)}&adults=1&cabinClass=ECONOMY`,
  MULTICITY: `tripType=MULTICITY&legs=BOM-DEL-${day(21)},DEL-BLR-${day(25)}&adults=1&cabinClass=ECONOMY`,
};
(async () => {
  const browser = await chromium.launch();
  let failed = false;
  try {
    for (const [trip, query] of Object.entries(journeys)) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const searches = [];
      page.on('response', async (r) => {
        if (r.url().endsWith('/api/search') && r.request().method() === 'POST') {
          const d = await r.json().catch(() => ({}));
          const groups = {};
          for (const f of d.fares ?? []) groups[`${f.supplier}:${f.tripKey}`] = (groups[`${f.supplier}:${f.tripKey}`] ?? 0) + 1;
          searches.push({ status: r.status(), searchId: d.searchId, groups, supplierErrors: d.supplierErrors });
        }
      });
      const url = `${site}/search/journey?${query}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const cards = page.getByRole('button').filter({ hasText: ' · ' });
      await Promise.race([
        cards.first().waitFor({ timeout: 70000 }),
        page.getByText(/No flights found|could not complete|unavailable|Search failed|contact support/i).first().waitFor({ timeout: 70000 }),
      ]).catch(() => {});
      const shown = await cards.count();
      const notice = (await page.locator('main').innerText().catch(() => '')).match(/(No flights found[^\n]*|The flight supplier[^\n]*|Round-trip and multi-city[^\n]*|[^\n]*\(JOURNEY_[A-Z_]+\)[^\n]*)/)?.[0] ?? null;
      await page.screenshot({ path: `journey-live-${trip}.png`, fullPage: true });
      console.log(JSON.stringify({ trip, url, fareCardsShown: shown, notice, apiSearches: searches }));
      if (!shown) failed = true;
      await page.close();
    }
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
