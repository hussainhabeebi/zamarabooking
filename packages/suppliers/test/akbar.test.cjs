const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function moduleUrl(file) {
 const output = ts.transpileModule(fs.readFileSync(path.join(__dirname,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return 'data:text/javascript;base64,'+Buffer.from(output.replace(/from ['"](\.[^'"]+\.js)['"]/g,(_,d)=>'from '+JSON.stringify(moduleUrl(path.join(path.dirname(file),d.replace(/\.js$/,'.ts')))))).toString('base64');
}
const params={origin:'COK',destination:'DXB',departureDate:'2027-01-10',adults:1,children:0,infants:0,cabinClass:'ECONOMY',tripType:'ONEWAY',currency:'INR'};
// Synthetic, sanitized values following the inspected Benzy schema, NOT recorded live flights.
const secrets={merchantId:'mock-merchant',apiKey:'mock-key',clientId:'mock-user',password:'mock-password',agentCode:'',browserKey:'mock-browser'};
const row={Index:'6E|mock-1',NetFare:5290,GrossFare:5421,Inclusions:{Baggage:'15 Kg'}};
function priced(round=false){
 const flight=(back=false)=>({MAC:'6E',Airline:'IndiGo|IndiGo|IndiGo',FlightNo:back?'1235':'1234',DepartureCode:back?'DXB':'COK',ArrivalCode:back?'COK':'DXB',DepartureTime:back?'2027-01-20T10:00:00':'2027-01-10T10:00:00',ArrivalTime:back?'2027-01-20T14:00:00':'2027-01-10T14:00:00',Duration:'04h 00m ',Cabin:'E',Refundable:'N',FareClass:'R'});
 const trip=(back=false)=>({Journey:[{Duration:'04h 00m ',Stops:0,Segments:[{Flight:flight(back),Fares:{TotalBaseFare:4500,TotalTax:831}}]}]});
 return {Code:'200',TUI:'mock-price',CurrencyCode:'INR',GrossAmount:round?10842:5421,Trips:round?[trip(),trip(true)]:[trip()]};
}
function harness(overrides={},options={}) {
 const calls=[];let refresh=0;
 const transport={kind:'mock',request:async(op,body,headers,signal)=>{
  calls.push({op,body,headers,signal});
  if(overrides[op])return overrides[op](body,headers,calls);
  if(op==='Signature'){refresh++;return {status:200,body:{Code:'200',Token:'mock-token-'+refresh,ClientID:'mock-encrypted-client'}}}
  const round=options.round;
  return {status:200,body:op==='ExpressSearch'?{Code:'200',TUI:'mock-search'}:op==='GetExpSearch'?{Code:'200',TUI:'mock-search',Completed:'True',Trips:round?[{Journey:[row]},{Journey:[{...row,Index:'6E|mock-2'}]}]:[{Journey:[row]}]}:op==='SmartPricer'?{Code:'200',TUI:'mock-price'}:priced(round)};
 }};
 return {calls,transport};
}

test('Akbar documented mock-only contract',async(t)=>{
 const originalFetch=global.fetch; global.fetch=()=>{throw new Error('Network forbidden in mock suite')}; t.after(()=>{global.fetch=originalFetch});
 const {AkbarClient,akbarSecretsFromEnv}=await import(moduleUrl('../src/akbar/client.ts'));
 const {AkbarAdapter,akbarSearchBody,normalizeAkbarItinerary}=await import(moduleUrl('../src/akbar/adapter.ts'));
 const adapter=(h,o={})=>new AkbarAdapter(new AkbarClient(secrets,h.transport),{mode:'mock',pollMs:0,...o});
 await t.test('server environment secrets stay server-side and missing values fail closed',()=>{assert.throws(()=>akbarSecretsFromEnv({}),/AUTH/);const e=akbarSecretsFromEnv({AKBAR_MERCHANT_ID:'mock',AKBAR_API_KEY:'mock',AKBAR_CLIENT_ID:'mock',AKBAR_PASSWORD:'mock',AKBAR_BROWSER_KEY:'mock'});assert.equal(e.agentCode,'')});
 await t.test('one-way IndiGo, bearer and encrypted ClientID, exact request keys, gross/base/tax/fees',async()=>{
  const h=harness();const f=await adapter(h).search(params);
  assert.equal(h.calls[0].op,'Signature');assert.deepEqual(Object.keys(h.calls[0].body).sort(),['AgentCode','ApiKey','BrowserKey','ClientID','MerchantID','Password'].sort());
  assert.equal(h.calls[1].headers.Authorization,'Bearer mock-token-1');assert.equal(h.calls[1].body.ClientID,'mock-encrypted-client');
  assert.equal(h.calls[1].body.FareType,'ON');assert.equal(h.calls[1].body.Cabin,'E');assert.equal(h.calls[3].body.Trips[0].Amount,5290);assert.equal(h.calls[3].body.Options,'A');
  assert.equal(f[0].airline,'6E');assert.equal(f[0].airlineName,'IndiGo');assert.equal(f[0].baseFare,4500);assert.equal(f[0].taxes,831);assert.equal(f[0].totalFare,5421);assert.equal(f[0].raw.chargesAndMarkup,90);assert.equal(f[0].baggage.checked,'15 Kg');assert.equal(f[0].baggage.cabin,'Not provided');assert.equal(f[0].isBookable,false);assert.equal(f[0].supplier,'AKBAR');assert(!JSON.stringify(f).includes('mock-token'));assert(!JSON.stringify(f).includes('mock-password'));
 });
 await t.test('round-trip selects both directions and normalizes combined amount',async()=>{const h=harness({}, {round:true});const f=await adapter(h).search({...params,tripType:'ROUNDTRIP',returnDate:'2027-01-20'});assert.equal(h.calls[1].body.FareType,'RT');assert.equal(h.calls[3].body.Trips.length,2);assert.equal(f[0].segments.length,2);assert.equal(f[0].segments[1].isReturn,true);assert.equal(f[0].tripKey,'COMBO');assert.equal(f[0].destination,'DXB');assert.equal(f[0].totalFare,10842)});
 await t.test('multi-city requires explicit documented IM/DM mode, never infers countries',()=>{assert.throws(()=>akbarSearchBody({...params,tripType:'MULTICITY'}),/UNSUPPORTED/);assert.equal(akbarSearchBody({...params,tripType:'MULTICITY',legs:[{origin:'COK',destination:'DXB',date:'2027-01-10'},{origin:'DXB',destination:'DEL',date:'2027-01-20'}]},'IM').FareType,'IM')});
 await t.test('partial result polling, completed snapshots only',async()=>{let count=0;const h=harness({GetExpSearch:()=>({status:200,body:{Code:'200',TUI:'mock-search',Completed:++count>1,Trips:count>1?[{Journey:[row]}]:[]}})});assert.equal((await adapter(h).search(params)).length,1);assert.equal(count,2)});
 await t.test('empty results do not price or book',async()=>{const h=harness({GetExpSearch:()=>({status:200,body:{Code:'200',TUI:'mock-search',Completed:true,Trips:[]}})});assert.deepEqual(await adapter(h).search(params),[]);assert.equal(h.calls.length,3)});
 await t.test('invalid credentials are not retried or leaked',async()=>{const h=harness({Signature:()=>({status:200,body:{Code:'5073',Msg:['private credential data']}})});await assert.rejects(adapter(h).search(params),e=>e.code==='AUTH'&&!e.message.includes('private'));assert.equal(h.calls.length,1)});
 await t.test('401 refreshes token once then fails closed',async()=>{const h=harness({ExpressSearch:()=>({status:401,body:{}})});await assert.rejects(adapter(h).search(params),/AUTH/);assert.equal(h.calls.filter(c=>c.op==='Signature').length,2)});
 await t.test('expired token renews and in-flight authentication is shared',async()=>{let now=0;const h=harness();const c=new AkbarClient(secrets,h.transport,()=>now);await Promise.all([c.call('ExpressSearch',{},1e9),c.call('ExpressSearch',{},1e9)]);assert.equal(h.calls.filter(c=>c.op==='Signature').length,1);now=48*60*60*1000;await c.call('ExpressSearch',{},now+5000);assert.equal(h.calls.filter(c=>c.op==='Signature').length,2)});
 await t.test('timeout aborts transport and never retries Signature',async()=>{let signal;const h=harness({Signature:(_b,_h,calls)=>{signal=calls.at(-1).signal;return new Promise(()=>{})}});await assert.rejects(adapter(h,{budgetMs:15}).search(params),/TIMEOUT/);assert.equal(signal.aborted,true)});
 await t.test('read retrieval retries once, initiation never retries on 500',async()=>{const h=harness({ExpressSearch:()=>({status:500,body:{}})});await assert.rejects(adapter(h).search(params),/UPSTREAM/);assert.equal(h.calls.filter(c=>c.op==='ExpressSearch').length,1);let n=0;const r=harness({GetExpSearch:()=>({status:++n===1?503:200,body:{Code:'200',TUI:'mock-search',Completed:true,Trips:[]}})});assert.deepEqual(await adapter(r).search(params),[]);assert.equal(n,2)});
 await t.test('malformed/negative/nonfinite fares rejected; unknown tax is not invented',()=>{for(const v of [NaN,-1,Infinity])assert.throws(()=>normalizeAkbarItinerary({...priced(),GrossAmount:v},'mock','',0),/INVALID_RESPONSE/);const d=priced();delete d.Trips[0].Journey[0].Segments[0].Fares.TotalTax;assert.throws(()=>normalizeAkbarItinerary(d,'mock','',0),/INVALID_RESPONSE/)});
 await t.test('runtime operation allowlist rejects booking even without TypeScript',async()=>{const h=harness();const c=new AkbarClient(secrets,h.transport);await assert.rejects(c.call('CreateItinerary',{},Date.now()+5000),/DISABLED/);assert.equal(h.calls.length,0)});
 await t.test('unsupported currency, fares, invalid dates and passengers fail before auth',()=>{for(const p of [{...params,currency:'AED'},{...params,fareType:'STUDENT'},{...params,departureDate:'2027-02-30'},{...params,adults:0}])assert.throws(()=>akbarSearchBody(p))});
 await t.test('no booking/payment/cancel surface and no default HTTP transport',()=>{const a=adapter(harness());for(const method of ['book','hold','cancel','revalidate','getPNRStatus'])assert.equal(a[method],undefined);assert.throws(()=>new AkbarClient(secrets,{kind:'http'}),/DISABLED/);assert.throws(()=>new AkbarAdapter({}, {mode:'live'}),/DISABLED/)});
 await t.test('production router explicitly refuses Akbar and no mock fares can enter normal search',()=>{assert.match(fs.readFileSync(path.join(__dirname,'../src/router.ts'),'utf8'),/config.name === "AKBAR"\) throw new Error/);assert.match(fs.readFileSync(path.join(__dirname,'../../../apps/api/src/routes/admin/flight-sources.ts'),'utf8'),/enabled:\s+z.literal\(false\)/)});
});
