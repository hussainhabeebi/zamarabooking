// Isolated component QA: stops filter per journey leg (no APIs or provider traffic).
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
  const dir = await mkdtemp(path.join(tmpdir(), 'zamra-stops-'));
  const component = path.resolve(__dirname, '../app/search/journey/page.tsx');
  let server, browser;
  try {
    const nav = path.join(dir, 'navigation.js');
    await writeFile(nav, `import {useState,useEffect} from 'react';export function useSearchParams(){const [q,set]=useState(()=>new URLSearchParams(location.search));useEffect(()=>{const f=()=>set(new URLSearchParams(location.search));addEventListener('popstate',f);return()=>removeEventListener('popstate',f)},[]);return q};export function useRouter(){return {push(url){history.pushState(null,'',url);dispatchEvent(new Event('popstate'))}}}`);
    await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(component)};createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: path.dirname(component), loader: 'tsx' }, bundle: true, outfile: path.join(dir, 'app.js'), alias: { react: path.resolve(__dirname, '../node_modules/react'), 'react-dom': path.resolve(__dirname, '../node_modules/react-dom'), 'next/navigation': nav }, jsx: 'automatic', define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify('https://fixture.invalid') } });
    const css = await readFile(path.resolve(__dirname, '../app/globals.css'), 'utf8');
    server = http.createServer(async (req, res) => {
      if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(path.join(dir, 'app.js'))); }
      else { res.setHeader('Content-Type', 'text/html'); res.end(`<html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script src="/app.js"></script></html>`); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({ headless: true });
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.addInitScript(() => {
        window.calls = 0;
        const f = (id, tripKey, o, d, day, stops, details, extra = {}) => ({ id, supplier: 'AKBAR', tripKey, airline: '6E', airlineName: 'IndiGo', flightNumber: id, origin: o, destination: d, departureTime: `${day}T06:00:00`, arrivalTime: `${day}T12:00:00`, duration: 360, stops, stopDetails: details, totalFare: 5000, currency: 'INR', isRefundable: true, baggage: { checked: '15 Kg' }, ...extra });
        const legs = [['ONWARD', 'BOM', 'DEL', '2027-11-04'], ['RETURN', 'DEL', 'BOM', '2027-11-12']];
        window.fetch = async () => { window.calls++; return Response.json({ searchId: 's', availableSuppliers: ['AKBAR'], fares: legs.flatMap(([k, o, d, day]) => [
          f(`${k}-0`, k, o, d, day, 0, []),
          f(`${k}-1`, k, o, d, day, 1, [{ airport: 'BLR', layoverMinutes: 160 }]),
          f(`${k}-2`, k, o, d, day, 2, [{ airport: 'BLR', layoverMinutes: 60 }, { airport: 'HYD', layoverMinutes: 95 }]),
          f(`${k}-u`, k, o, d, day, 0, [], { stopsUnknown: true }),
        ]) }); };
      });
      await page.route('**/*', (r) => new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort());
      await page.goto(`http://127.0.0.1:${server.address().port}/?tripType=ROUNDTRIP&origin=BOM&destination=DEL&departureDate=2027-11-04&returnDate=2027-11-12`);
      const leg = (k) => page.locator(`#leg-${k}`).getByRole('button').filter({ hasText: 'IndiGo ·' });
      await expect(leg('ONWARD')).toHaveCount(4);
      await expect(page.locator('#leg-ONWARD').getByText(/1 stop · Via BLR \(2h 40m layover\)/)).toBeVisible();
      await expect(page.locator('#leg-ONWARD').getByText(/Stops not confirmed/)).toBeVisible();
      const open = async () => { if (width <= 900) await page.getByRole('button', { name: /Filters/ }).click(); };
      const close = async () => { if (width <= 900) await page.getByRole('button', { name: 'Show flights', exact: true }).click(); };
      for (const [btn, id] of [['Nonstop', '0'], ['1 stop', '1'], ['2+ stops', '2']]) {
        await open(); await page.getByRole('button', { name: btn, exact: true }).click(); await close();
        for (const k of ['ONWARD', 'RETURN']) {
          await expect(leg(k)).toHaveCount(1);
          await expect(leg(k).first()).toContainText(`${k}-${id}`);
        }
      }
      assert.equal(await page.evaluate(() => window.calls), 1, 'switching filters must not repeat the search');
      await page.screenshot({ path: path.join(process.argv[3] || dir, `journey-stops-${width}.png`) });
      await page.close(); console.log(`PASS: per-leg Non-stop / 1 stop / 2+ stops and via details at ${width}px`);
    }
  } finally { await browser?.close(); if (server) await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
