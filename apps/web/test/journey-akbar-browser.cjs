// Isolated component QA for Akbar round trip / multi-city. No APIs, bookings or provider traffic.
const { createRequire } = require('node:module');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const qaRequire = createRequire(path.resolve(process.argv[2], 'package.json'));
const { chromium, expect } = qaRequire('@playwright/test');
const { build } = qaRequire('esbuild');
(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamra-date-'));
  const component = path.resolve(__dirname, '../app/search/journey/page.tsx');
  const reactDir = path.resolve(__dirname, '../node_modules/react');
  const reactDomDir = path.resolve(__dirname, '../node_modules/react-dom');
  let server, browser;
  try {
    const nav = path.join(dir,'navigation.js');
    await require('node:fs/promises').writeFile(nav, `import {useState,useEffect} from 'react';export function useSearchParams(){const [q,set]=useState(()=>new URLSearchParams(location.search));useEffect(()=>{const f=()=>set(new URLSearchParams(location.search));addEventListener('popstate',f);return()=>removeEventListener('popstate',f)},[]);return q};export function useRouter(){return {push(url){history.pushState(null,'',url);dispatchEvent(new Event('popstate'))}}}`);
    await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(component)};createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: path.dirname(component), loader:'tsx'},bundle:true,outfile:path.join(dir,'app.js'),alias:{react:reactDir,'react-dom':reactDomDir,'next/navigation':nav},jsx:'automatic',define:{'process.env.NEXT_PUBLIC_API_URL':JSON.stringify('https://fixture.invalid')}});
    server = http.createServer(async (req,res) => {
      if(req.url === '/app.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(dir,'app.js')));}
      else {res.setHeader('Content-Type','text/html');res.end('<html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px sans-serif;margin:16px}label{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}input{padding:12px;border:1px solid #aaa;border-radius:12px;min-width:0;box-sizing:border-box;width:100%}output{display:block;overflow-wrap:anywhere}</style><div id="root"></div><script src="/app.js"></script></html>');}
    });
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    browser = await chromium.launch({headless:true});
    // Akbar is searched one leg at a time: ONWARD / RETURN or "0".."n" lists, one fare per leg.
    for(const trip of ['ROUNDTRIP','MULTICITY']) for(const width of [375,1440]){
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.addInitScript(({trip})=>{
        const legs=trip==='ROUNDTRIP'?[['ONWARD','BOM','DEL','2027-11-04'],['RETURN','DEL','BOM','2027-11-13']]:[['0','BOM','DEL','2027-11-04'],['1','DEL','BLR','2027-11-08'],['2','BLR','BOM','2027-11-13']];
        const fare=([tripKey,origin,destination,day],i,n)=>({id:`AK|tui-${tripKey}|6E|${n}`,supplier:'AKBAR',tripKey,legIndex:i,airline:'6E',airlineName:'IndiGo',flightNumber:String(2100+n),origin,destination,departureTime:`${day}T0${6+n}:00:00`,arrivalTime:`${day}T0${8+n}:10:00`,duration:130,stops:0,totalFare:4000+i*100+n,displayPrice:4200+i*100+n,currency:'INR',isRefundable:true,baggage:{checked:'15 Kg'}});
        window.fetch=async()=>Response.json({searchId:'11111111-1111-4111-8111-111111111111',availableSuppliers:['AKBAR'],usedSuppliers:['AKBAR'],fares:legs.flatMap((l,i)=>[fare(l,i,1),fare(l,i,2)])});
      },{trip});
      await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.pathname==='/book'){route.fulfill({contentType:'text/html',body:'<h1>book</h1>'});return;}u.hostname==='127.0.0.1'?route.continue():route.abort();});
      const query=trip==='ROUNDTRIP'?'tripType=ROUNDTRIP&origin=BOM&destination=DEL&departureDate=2027-11-04&returnDate=2027-11-13':'tripType=MULTICITY&legs=BOM-DEL-2027-11-04,DEL-BLR-2027-11-08,BLR-BOM-2027-11-13';
      await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
      const cards=page.getByRole('button').filter({hasText:'IndiGo ·'});
      const n=trip==='ROUNDTRIP'?2:3;
      await expect(cards).toHaveCount(n*2);
      await expect(page.getByText('No flights found')).toHaveCount(0);
      for(let i=0;i<n;i++) await cards.nth(i*2).click();
      await page.getByRole('button',{name:'Continue',exact:true}).click();
      await page.waitForURL('**/book?**');
      const q=new URL(page.url()).searchParams;
      assert.equal(q.get('supplier'),'AKBAR');
      assert.equal(q.get('tripType'),trip);
      assert.equal(q.get('priceIds').split(',').length,n);
      assert.ok(q.get('priceIds').split(',').every(id=>id.startsWith('AK|')));
      // Shown total = sum of the picked legs' prices.
      assert.equal(Number(q.get('price')),Array.from({length:n},(_,i)=>4201+i*100).reduce((a,b)=>a+b,0));
      await page.close();console.log(`PASS: Akbar ${trip} legs shown, picked and sent to checkout at ${width}px`);
    }
    // A genuine Akbar error is shown, never "No flights found".
    const page=await browser.newPage();
    await page.addInitScript(()=>{window.fetch=async()=>Response.json({searchId:'s',availableSuppliers:['AKBAR'],fares:[],supplierErrors:{AKBAR:'Akbar /flights/ExpressSearch failed (HTTP 500)'}});});
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/?tripType=ROUNDTRIP&origin=BOM&destination=DEL&departureDate=2027-11-04&returnDate=2027-11-13`);
    await expect(page.getByText(/Akbar: Akbar \/flights\/ExpressSearch failed \(HTTP 500\)/)).toBeVisible();
    await expect(page.getByText('No flights found')).toHaveCount(0);
    console.log('PASS: Akbar error shown instead of "No flights found"');
  } finally {await browser?.close();if(server) await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
