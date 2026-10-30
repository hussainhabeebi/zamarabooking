// Isolated component QA. No APIs, bookings or provider traffic.
const { createRequire } = require('node:module');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const qaRequire = createRequire(path.resolve(process.argv[2], 'package.json'));
const { chromium } = qaRequire('@playwright/test');
const { build } = qaRequire('esbuild');
(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamra-date-'));
  const component = path.resolve(__dirname, '../app/components/PassengerDateInput.tsx');
  const reactDir = path.resolve(__dirname, '../node_modules/react');
  const reactDomDir = path.resolve(__dirname, '../node_modules/react-dom');
  let server, browser;
  try {
    await build({ stdin: { contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import DateInput from ${JSON.stringify(component)};
      function App(){const [birth,b]=useState('1990-01-01'),[issue,i]=useState('2020-01-01'),[expiry,e]=useState('2030-04-23');return <form><label>Date of birth<DateInput required kind="birth" value={birth} onChange={b}/></label><label>Passport issue date<DateInput kind="issue" value={issue} onChange={i}/></label><label>Passport expiry<DateInput required kind="expiry" value={expiry} onChange={e}/></label><output>{JSON.stringify({birth,issue,expiry})}</output><button>Submit</button></form>};createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: path.dirname(component), loader: 'tsx' }, bundle: true, outfile: path.join(dir, 'app.js'), alias: { react: reactDir, 'react-dom': reactDomDir }, jsx: 'automatic' });
    server = http.createServer(async (req,res) => {
      if(req.url === '/app.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(path.join(dir,'app.js')));}
      else {res.setHeader('Content-Type','text/html');res.end('<html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px sans-serif;margin:16px}label{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}input{padding:12px;border:1px solid #aaa;border-radius:12px;min-width:0;box-sizing:border-box;width:100%}output{display:block;overflow-wrap:anywhere}</style><div id="root"></div><script src="/app.js"></script></html>');}
    });
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    browser = await chromium.launch({headless:true});
    for(const width of [375,390,768,1024,1440]){
      const page = await browser.newPage({viewport:{width,height:900}});
      await page.route('**/*',route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const expiry=page.getByLabel('Passport expiry');
      await expiry.fill('222222-04-23');
      assert.equal(await expiry.inputValue(),'2030-04-23','six-digit year must restore last date');
      await expiry.fill('12345-04-23');
      assert.equal(await expiry.inputValue(),'2030-04-23','five-digit year must restore last date');
      await expiry.fill('2032-02-29');
      assert.equal(await expiry.evaluate(e=>e.checkValidity()),true);
      await page.getByLabel('Date of birth').fill('2090-01-01');
      assert.equal(await page.getByLabel('Date of birth').evaluate(e=>e.checkValidity()),false);
      await page.getByLabel('Date of birth').fill('1990-01-01');
      await page.getByLabel('Passport issue date').fill('2090-01-01');
      assert.equal(await page.getByLabel('Passport issue date').evaluate(e=>e.checkValidity()),false);
      await expiry.fill('2020-01-01');
      assert.equal(await expiry.evaluate(e=>e.checkValidity()),false);
      await expiry.fill('2030-04-23');
      await page.getByLabel('Passport issue date').fill('2020-01-01');
      assert.equal(await page.locator('form').evaluate(e=>e.checkValidity()),true);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.close();
      console.log(`PASS: native date input guard, range rules and layout at ${width}px`);
    }
  } finally {await browser?.close();if(server) await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
