// Isolated component QA. No APIs, bookings or provider traffic.
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
    for(const trip of ['ROUNDTRIP','MULTICITY']) for(const width of [375,390,768,1024,1440]){
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.addInitScript(({trip})=>{
        window.calls=0;
        const segment=(origin,destination,departureTime)=>({origin,destination,departureTime,arrivalTime:departureTime,duration:120,airlineName:'Air India',airline:'AI',flightNumber:'1'});
        const end=trip==='ROUNDTRIP'?'BOM':'SIN';
        const base={supplier:'TRIPJACK',tripKey:'COMBO',airlineName:'Air India',airline:'AI',flightNumber:'1',origin:'BOM',destination:'DXB',departureTime:'2027-11-04T13:00:00',arrivalTime:'2027-11-04T15:00:00',duration:120,currency:'INR',stops:0,isRefundable:true,baggage:{checked:'15 Kg'}};
        const direct=[segment('BOM','DXB','2027-11-04T13:00:00'),segment('DXB',end,'2027-11-13T13:00:00')];
        window.fetch=async()=>{window.calls++;return Response.json({searchId:'fixture',fares:[{...base,id:'direct',totalFare:100,segments:direct},{...base,id:'connection',flightNumber:'2',totalFare:200,segments:[segment('BOM','DEL','2027-11-04T13:00:00'),segment('DEL','DXB','2027-11-04T16:00:00'),...direct.slice(1)]}]})};
      },{trip});
      await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      const query=trip==='ROUNDTRIP'?'tripType=ROUNDTRIP&origin=BOM&destination=DXB&departureDate=2027-11-04&returnDate=2027-11-13':'tripType=MULTICITY&legs=BOM-DXB-2027-11-04,DXB-SIN-2027-11-13';
      await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
      await expect(page.getByRole('heading',{name:'Complete journey fares'})).toBeVisible();
      const cards=page.getByRole('button').filter({hasText:'Air India ·'});
      await expect(cards).toHaveCount(2);
      if(width<=900)await page.getByRole('button',{name:/Filters/}).click();
      await page.getByRole('button',{name:'Nonstop',exact:true}).click();
      await expect(cards).toHaveCount(1);
      await page.getByRole('checkbox',{name:'Refundable only'}).check();
      await expect(cards).toHaveCount(1);
      await page.getByRole('link',{name:'Reset all'}).click();
      await expect(cards).toHaveCount(2);
      if(width<=900)await page.getByRole('button',{name:'Show flights',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.calls),1,'filters must not repeat supplier searches');
      assert.ok((await page.url()).includes('tripType='+trip));
      await cards.first().click();
      await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeVisible();
      await page.close();console.log(`PASS: ${trip} filters/reset/selection at ${width}px`);
    }
  } finally {await browser?.close();if(server) await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
