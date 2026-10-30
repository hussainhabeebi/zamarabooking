// Isolated component QA: Akbar checkout baggage. No APIs, bookings or provider traffic.
const { createRequire } = require('node:module');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const qaRequire = createRequire(path.resolve(process.argv[2], 'package.json'));
const { chromium, expect } = qaRequire('@playwright/test');
const { build } = qaRequire('esbuild');
(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamra-akbar-bag-'));
  const component = path.resolve(__dirname, '../app/book/page.tsx');
  const reactDir = path.resolve(__dirname, '../node_modules/react');
  const reactDomDir = path.resolve(__dirname, '../node_modules/react-dom');
  let server, browser;
  try {
    const nav = path.join(dir, 'navigation.js');
    await writeFile(nav, `export function useSearchParams(){return new URLSearchParams(location.search)};export function useRouter(){return {push(){},replace(){}}};export function usePathname(){return location.pathname}`);
    await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(component)};createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: path.dirname(component), loader: 'tsx' }, bundle: true, outfile: path.join(dir, 'app.js'), alias: { react: reactDir, 'react-dom': reactDomDir, 'next/navigation': nav }, jsx: 'automatic', define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify('https://fixture.invalid') }, loader: { '.png': 'dataurl', '.svg': 'dataurl' } });
    server = http.createServer(async (req, res) => {
      if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(path.join(dir, 'app.js'))); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/app.js"></script></html>'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({ headless: true });
    const ids = 'AK|t1|6E|1,AK|t2|6E|1';
    for (const width of [375, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.addInitScript((ids) => {
        window.calls = [];
        window.fetch = async (url) => { window.calls.push(String(url)); return Response.json({}); };
        sessionStorage.setItem(`journey:${ids}`, JSON.stringify([
          { origin: 'BOM', destination: 'DXB', baggage: { checked: '30 Kg', cabin: '7 Kg' } },
          { origin: 'DXB', destination: 'BOM', baggage: { checked: '', cabin: '7 Kg' } },
        ]));
      }, ids);
      await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      const q = new URLSearchParams({ fareId: 'AK|t1|6E|1', priceIds: ids, supplier: 'AKBAR', tripType: 'ROUNDTRIP', adults: '2', from: 'BOM', to: 'DXB', dep: '2027-11-04T06:00:00', arr: '2027-11-12T12:00:00', price: '18000', cur: 'INR', bag: '30 Kg', cab: '7 Kg' });
      await page.goto(`http://127.0.0.1:${server.address().port}/book?${q}`);
      const card = page.getByRole('region', { name: 'Baggage' });
      await expect(card).toBeVisible();
      await expect(card.getByText('BOM → DXB')).toBeVisible();
      await expect(card.getByText('Check-in: 30 Kg')).toBeVisible();
      // A leg Akbar gave no allowance for is never filled in with a made-up value.
      await expect(card.getByText('Check-in: As per airline')).toBeVisible();
      await expect(card.getByText(/can't be added online for this fare/)).toBeVisible();
      await expect(card.getByRole('link', { name: /WhatsApp/ })).toHaveAttribute('href', /wa\.me/);
      await expect(page.getByText('Extra baggage: arranged by our team after booking (see Baggage above).')).toHaveCount(2);
      // No baggage options or prices are offered, and no TripJack review is requested.
      await expect(page.getByRole('combobox', { name: /additional baggage/ })).toHaveCount(0);
      await expect(page.getByText(/Add Baggage/)).toHaveCount(0);
      assert.ok(!(await page.evaluate(() => window.calls)).some((u) => u.includes('/api/book/review')));
      await page.screenshot({ path: path.join(process.argv[3] || dir, `akbar-baggage-${width}.png`), fullPage: true });
      await page.close(); console.log(`PASS: Akbar included baggage and staff notice at ${width}px`);
    }
  } finally { await browser?.close(); if (server) await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
