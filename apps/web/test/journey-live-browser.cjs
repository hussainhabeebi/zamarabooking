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
      // Pick the first fare of each leg and open checkout. Stops on the traveller form:
      // nothing is reviewed, booked or paid.
      if (shown && process.env.CHECK_CHECKOUT === '1') {
        const legs = await page.locator('[id^="leg-"]').count();
        for (let i = 0; i < legs; i++) await page.locator('[id^="leg-"]').nth(i).getByRole('button').filter({ hasText: ' · ' }).first().click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.waitForURL('**/book?**', { timeout: 30000 });
        const card = page.getByRole('region', { name: 'Baggage' });
        await card.waitFor({ timeout: 30000 }).catch(() => {});
        const bookUrl = new URL(page.url());
        console.log(JSON.stringify({ trip, checkout: {
          supplier: bookUrl.searchParams.get('supplier'), legs: (bookUrl.searchParams.get('priceIds') ?? '').split(',').length,
          baggageCard: await card.isVisible() ? (await card.innerText()).replace(/\s+/g, ' ').trim() : null,
          addBaggageOffered: await page.getByText(/Add Baggage/).count(),
        } }));
        await page.screenshot({ path: `checkout-live-${trip}.png`, fullPage: true });
        if (!(await card.isVisible())) failed = true;
      }
      await page.close();
    }
    // One-way: open the first Akbar fare's checkout from the results page (no booking).
    if (process.env.CHECK_CHECKOUT === '1') {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const url = `${site}/search?tripType=ONEWAY&origin=BOM&destination=DEL&departureDate=${day(21)}&adults=1&cabinClass=ECONOMY`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      const links = page.locator('a.fare-card-v2-book[href*="supplier=AKBAR"]');
      await links.first().waitFor({ timeout: 90000 }).catch(() => {});
      const count = await links.count();
      let result = { trip: 'ONEWAY', url, akbarFaresShown: count, checkout: null };
      if (count) {
        await page.goto(new URL(await links.first().getAttribute('href'), site).toString(), { waitUntil: 'domcontentloaded' });
        const card = page.getByRole('region', { name: 'Baggage' });
        await card.waitFor({ timeout: 30000 }).catch(() => {});
        result.checkout = {
          supplier: new URL(page.url()).searchParams.get('supplier'),
          baggageCard: await card.isVisible() ? (await card.innerText()).replace(/\s+/g, ' ').trim() : null,
          addBaggageOffered: await page.getByText(/Add Baggage/).count(),
        };
        await page.screenshot({ path: 'checkout-live-ONEWAY.png', fullPage: true });
      }
      console.log(JSON.stringify(result));
      if (!result.checkout?.baggageCard) failed = true;
      await page.close();
    }
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
