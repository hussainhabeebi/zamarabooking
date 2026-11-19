// Included baggage on the website (app/lib/baggage.ts): same answers as the API's reader
// (packages/suppliers/src/baggage.ts) on the real Akbar texts, the "With baggage" filters,
// fare-option perks and the e-ticket-free cases. No live calls.
const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);
const load=(rel)=>{const file=path.resolve(__dirname,rel),m=new Module(file,module);m.paths=Module._nodeModulePaths(path.dirname(file));m.filename=file;m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);return m.exports;};
const web=load('../app/lib/baggage.ts');
const api=load('../../../packages/suppliers/src/baggage.ts');
const {filterJourneyFares}=load('../app/search/journey/filters.ts');
const {optionPerks,checkedPerk,cabinPerk}=load('../app/lib/fare-options.ts');
const samples=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../api/test/fixtures/akbar-baggage-samples.json'),'utf8'));

test('the website copy is the API reader, word for word (except the website-only helpers)',()=>{
  const apiSrc=fs.readFileSync(path.resolve(__dirname,'../../../packages/suppliers/src/baggage.ts'),'utf8');
  const webSrc=fs.readFileSync(path.resolve(__dirname,'../app/lib/baggage.ts'),'utf8');
  const body=(s)=>s.split('\nexport type BaggageStatus')[1].split('\n// ── Website only')[0];
  assert.equal(body(webSrc),body(apiSrc));
});

test('real Akbar texts: same split and status on the website and in the API',()=>{
  for(const s of samples.search){
    const a=api.akbarBaggage(s.baggage),w=web.akbarBaggage(s.baggage);
    assert.deepEqual(w,a,JSON.stringify(s.baggage));
    assert.deepEqual(w,{checked:s.checked,cabin:s.cabin,checkedStatus:s.checkedStatus,cabinStatus:s.cabinStatus},JSON.stringify(s.baggage));
  }
});

test('search results from before the API change (Akbar "25 Kg,7 Kg", "As per airline") are split on the website',()=>{
  const v=web.fareBaggageView({id:'AK|t|1',supplier:'AKBAR',baggage:{checked:'25 Kg,7 Kg',cabin:'As per airline'}});
  assert.deepEqual([v.checked.text,v.cabin.text],['25 kg','7 kg']);
  const none=web.fareBaggageView({supplier:'AKBAR',baggage:{checked:'N,7 kg + Personal item(max 3 kg)',cabin:'As per airline'}});
  assert.equal(none.checked.status,'NONE');
  assert.equal(web.checkedTag(none),'No check-in bag');
  const unknown=web.fareBaggageView({supplier:'AKBAR',baggage:{checked:'As per airline',cabin:'As per airline'}});
  assert.equal(web.checkedTag(unknown),null);                        // no tag
  assert.equal(web.allowanceLabel(unknown.checked),'Allowance not confirmed');
  assert.deepEqual(web.carriedBaggage(v),{checked:'25 kg',cabin:'7 kg',checkedStatus:'INCLUDED',cabinStatus:'INCLUDED'});
});

test('"With baggage" keeps only a confirmed check-in bag',()=>{
  const base={airlineName:'X',stops:0,departureTime:'2026-12-20T10:00:00',duration:120,totalFare:100,isRefundable:true};
  const fares=samples.search.map((s,i)=>({...base,id:`AK|t|${i}`,supplier:'AKBAR',baggage:api.akbarBaggage(s.baggage),_want:s.checkedStatus==='INCLUDED'}));
  // plus results from before the API change, and other suppliers' text
  fares.push({...base,id:'AK|t|old1',supplier:'AKBAR',baggage:{checked:'0Kg',cabin:'As per airline'},_want:false});
  fares.push({...base,id:'AK|t|old2',supplier:'AKBAR',baggage:{checked:'N,7 kg + Personal item(max 3 kg)',cabin:'As per airline'},_want:false});
  fares.push({...base,id:'AK|t|old3',supplier:'AKBAR',baggage:{checked:'25 Kg,7 Kg',cabin:'As per airline'},_want:true});
  fares.push({...base,id:'M1',supplier:'MANUAL',baggage:{checked:'As per airline',cabin:'As per airline'},_want:false});
  fares.push({...base,id:'D1',supplier:'DUFFEL',baggage:{checked:'Not included',cabin:'7 KG'},_want:false});
  fares.push({...base,id:'T1',supplier:'TRIPJACK',baggage:{checked:'20 Kilograms',cabin:'7 Kg'},_want:true});
  const kept=filterJourneyFares(fares,new URLSearchParams('baggage=1'));
  assert.deepEqual(kept.map(f=>f.id),fares.filter(f=>f._want).map(f=>f.id));
  assert.equal(filterJourneyFares(fares,new URLSearchParams()).length,fares.length);   // no filter → everything
});

test('fare option perks: clean words, unknown left out, no "No check-in bag check-in"',()=>{
  const p=optionPerks({id:'AK|t|1',supplier:'AKBAR',baggage:api.akbarBaggage('N,7 kg + Personal item(max 3 kg)')});
  assert.equal(checkedPerk(p.checked),'No check-in bag');
  assert.equal(cabinPerk(p.cabin),'7 kg + Personal item (max 3 kg) cabin');
  const q=optionPerks({id:'AK|t|2',supplier:'AKBAR',baggage:api.akbarBaggage('25 Kg,7 Kg')});
  assert.deepEqual([checkedPerk(q.checked),cabinPerk(q.cabin)],['25 kg check-in','7 kg cabin']);
  const u=optionPerks({id:'AK|t|3',supplier:'AKBAR',baggage:api.akbarBaggage(null)});
  assert.deepEqual([checkedPerk(u.checked),cabinPerk(u.cabin)],['','']);
});
