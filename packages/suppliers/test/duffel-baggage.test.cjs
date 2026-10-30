const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
function moduleUrl(file){const source=fs.readFileSync(path.join(__dirname,file),'utf8');let output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;output=output.replace(/from "(\.[^"]+\.js)"/g,(_,dep)=>'from '+JSON.stringify(moduleUrl(path.join(path.dirname(file),dep.replace(/\.js$/,'.ts')))));return 'data:text/javascript;base64,'+Buffer.from(output).toString('base64');}
const service={id:'svc',type:'baggage',total_amount:'5.25',total_currency:'INR',maximum_quantity:2,passenger_ids:['p1'],segment_ids:['s1']};
const offer={id:'offer',total_amount:'100.00',total_currency:'INR',passengers:[{id:'p1'}],available_services:[service],slices:[{segments:[{id:'s1'}]}]};
for(const extra of [false,true])test(`Duffel ${extra?'with':'without'} baggage maps current supplier services/amount`,async(t)=>{
 const {DuffelAdapter}=await import(moduleUrl('../src/duffel/adapter.ts'));const old=global.fetch;t.after(()=>global.fetch=old);let post;
 global.fetch=async(url,init)=>{if(!init?.method){assert.match(url,/return_available_services=true/);return Response.json({data:offer});}post=JSON.parse(init.body).data;return Response.json({data:{id:'order',booking_reference:'MOCK',services:extra?[{...service,quantity:2}]:[],documents:[{type:'electronic_ticket',unique_identifier:'ticket-fixture'},{type:'electronic_miscellaneous_document_associated',unique_identifier:'emd-fixture'}]}});};
 const adapter=new DuffelAdapter({apiKey:'fixture',baseUrl:'https://fixture.invalid'});
 const result=await adapter.book({fareId:'offer',passengers:[{type:'ADULT',firstName:'Fixture',lastName:'Only'}],contactPhone:'000000000',contactEmail:'fixture@example.invalid',paymentAmount:extra?110.5:100,...(extra?{duffelServices:[{id:'svc',quantity:2}]}:{})});
 assert.equal(post.payments[0].amount,extra?'110.50':'100.00');assert.deepEqual(post.services,extra?[{id:'svc',quantity:2}]:undefined);assert.equal(result.ancillaryServices.length,extra?1:0);assert.deepEqual(result.ticketNumbers,['ticket-fixture']);
});
test('Duffel rejects invented/ineligible services, mixed currency, quantities and changed paid amount before order POST',async(t)=>{
 const {duffelBaggage}=await import(moduleUrl('../src/duffel/baggage.ts'));
 for(const pick of [{id:'unknown',quantity:1},{id:'svc',quantity:0},{id:'svc',quantity:3}])assert.throws(()=>duffelBaggage(offer,[pick]));
 assert.throws(()=>duffelBaggage({...offer,available_services:[{...service,total_currency:'USD'}]},[{id:'svc',quantity:1}]));
 assert.throws(()=>duffelBaggage({...offer,available_services:[{...service,segment_ids:['foreign']}]},[{id:'svc',quantity:1}]));
 const {DuffelAdapter}=await import(moduleUrl('../src/duffel/adapter.ts'));const old=global.fetch;t.after(()=>global.fetch=old);global.fetch=async(url,init)=>{assert.notEqual(init?.method,'POST');return Response.json({data:offer});};
 await assert.rejects(new DuffelAdapter({apiKey:'fixture',baseUrl:'https://fixture.invalid'}).book({fareId:'offer',passengers:[{}],duffelServices:[{id:'svc',quantity:1}],paymentAmount:100}),/reprice/);
});
