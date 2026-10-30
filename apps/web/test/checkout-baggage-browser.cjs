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
  const component = path.resolve(__dirname, '../app/checkout/[token]/CheckoutBaggage.tsx');
  const reactDir = path.resolve(__dirname, '../node_modules/react');
  const reactDomDir = path.resolve(__dirname, '../node_modules/react-dom');
  let server, browser;
  try {
    await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Baggage from ${JSON.stringify(component)};function App(){const [dirty,setDirty]=useState(false),[total,setTotal]=useState('100.00');return <><Baggage token="fixture" passengers={[{id:'p1',passengerType:'ADULT'}]} onDirty={setDirty} onApplied={setTotal}/><output>{total}</output><button disabled={dirty}>Continue fixture</button></>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:path.dirname(component),loader:'tsx'},bundle:true,outfile:path.join(dir,'app.js'),alias:{react:reactDir,'react-dom':reactDomDir},jsx:'automatic',define:{'process.env.NEXT_PUBLIC_API_URL':JSON.stringify('https://fixture.invalid')}});
    server = http.createServer(async (req,res) => {
      if(req.url === '/app.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(dir,'app.js')));}
      else {res.setHeader('Content-Type','text/html');res.end('<html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px sans-serif;margin:16px}label{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}input{padding:12px;border:1px solid #aaa;border-radius:12px;min-width:0;box-sizing:border-box;width:100%}output{display:block;overflow-wrap:anywhere}</style><div id="root"></div><script src="/app.js"></script></html>');}
    });
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    browser = await chromium.launch({headless:true});
    for(const width of [375,390,768,1024,1440]){
      const page=await browser.newPage({viewport:{width,height:1000}});
      await page.addInitScript(()=>{window.requests=[];window.fetch=async(url,init)=>{if(init?.method==='POST'){const body=JSON.parse(init.body);window.requests.push(body);return Response.json({applied:true,totalAmount:'105.00',revision:'v2'})}return Response.json({bookingRevision:'v1',originalTotal:100,currency:'INR',picks:[{passengerId:'p1',baggage:[]}],segments:[{key:'out',origin:'BOM',destination:'DXB',options:[{code:'B5',amount:5,desc:'Fixture baggage'}]}]})}});
      await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const select=page.getByRole('combobox',{name:'Traveller 1 baggage out'});await expect(select).toBeVisible();
      await expect(page.getByRole('button',{name:'Continue fixture'})).toBeDisabled();
      await select.selectOption('B5');await page.getByRole('button',{name:'Apply baggage and update total'}).click();
      await expect(page.locator('output')).toHaveText('105.00');await expect(page.getByRole('button',{name:'Continue fixture'})).toBeEnabled();
      assert.deepEqual(await page.evaluate(()=>window.requests[0]),{revision:'v1',passengers:[{passengerId:'p1',baggage:[{key:'out',code:'B5'}]}]});
      await select.selectOption('');await expect(page.getByRole('button',{name:'Continue fixture'})).toBeDisabled();
      await page.close();console.log(`PASS: baggage apply/version/dirty checkout controls at ${width}px`);
    }
  } finally {await browser?.close();if(server) await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
