import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteBaggage} from '../src/lib/baggage-quote.js';
const now=Date.parse('2026-10-30T12:00:00Z');
function fixture(roundtrip=false):any {
 const segments=(roundtrip?['out','back']:['out']).map(key=>({key,ssr:{baggage:[{code:'B5',amount:500,desc:'Fixture only'}],meal:[],extra:[]}}));
 return {booking:{status:'PAYMENT_PENDING',supplier:'TRIPJACK',currency:'INR',baseFare:'10000.00',totalAmount:'10000.00',updatedAt:new Date(now),flightData:{checkoutPriceProtocol:1,tripjack:{reviewBookingId:'r1',pax:[{type:'ADULT',firstName:'Fixture',lastName:'Only'}]}}},passengers:[{id:'p1',passengerType:'ADULT',firstName:'Fixture',lastName:'Only'}],review:{summary:{bookingId:'r1',conditions:{sessionSeconds:600},segments},createdAt:new Date(now).toISOString()},picks:[],hasPayments:false,now};
}
for(const trip of ['ONEWAY','ROUNDTRIP'])for(const extra of [false,true])test(`${trip} quote ${extra?'with':'without'} baggage uses only stored supplier prices`,()=>{
 const f=fixture(trip==='ROUNDTRIP');f.picks=[{passengerId:'p1',baggage:extra?f.review.summary.segments.map((s:any)=>({key:s.key,code:'B5'})):[]}];
 const q=quoteBaggage(f);assert.equal(q.total,10000+(extra?500*f.review.summary.segments.length:0));assert.equal(q.commitAllowed,true);assert.equal(q.selected[0].ssr.baggage.length,extra?f.review.summary.segments.length:0);assert.equal(f.booking.totalAmount,'10000.00');
});
test('rejects expired/wrong review and any existing payment',()=>{
 for(const edit of [(f:any)=>f.now+=600001,(f:any)=>f.hasPayments=true,(f:any)=>f.review.summary.bookingId='other',(f:any)=>f.booking.status='CONFIRMED',(f:any)=>f.booking.supplier='AKBAR']){const f=fixture();edit(f);assert.throws(()=>quoteBaggage(f));}
});
test('rejects unknown passenger, wrong segment, invented code and duplicate picks',()=>{
 for(const picks of [[{passengerId:'other',baggage:[]}],[{passengerId:'p1',baggage:[{key:'other',code:'B5'}]}],[{passengerId:'p1',baggage:[{key:'out',code:'invented'}]}],[{passengerId:'p1',baggage:[{key:'out',code:'B5'},{key:'out',code:'B5'}]}],[{passengerId:'p1',baggage:[]},{passengerId:'p1',baggage:[]}]]){const f=fixture();f.picks=picks;assert.throws(()=>quoteBaggage(f));}
});
test('retains selected meal prices and replaces existing baggage rather than double-charging',()=>{
 const f=fixture();f.review.summary.segments[0].ssr.meal=[{code:'M1',amount:200}];f.booking.totalAmount='10700';f.booking.flightData.tripjack.pax[0].ssr={baggage:[{key:'out',code:'B5'}],meal:[{key:'out',code:'M1'}]};
 const without=quoteBaggage(f);assert.equal(without.total,10200);assert.deepEqual(without.selected[0].ssr.meal,[{key:'out',code:'M1'}]);f.picks=[{passengerId:'p1',baggage:[{key:'out',code:'B5'}]}];assert.equal(quoteBaggage(f).total,10700);
});
test('ambiguous passenger identities and infant baggage fail closed',()=>{
 const f=fixture();f.passengers.push({...f.passengers[0],id:'p2'});assert.throws(()=>quoteBaggage(f));
 const g=fixture();g.passengers[0].passengerType='INFANT';g.booking.flightData.tripjack.pax[0].type='INFANT';g.picks=[{passengerId:'p1',baggage:[{key:'out',code:'B5'}]}];assert.throws(()=>quoteBaggage(g));
});
test('HTTP quote route enforces signed session, tenant and strict request fields',async()=>{
 const {Hono}=await import('hono');const {checkoutRoutes,signToken}=await import('../src/routes/checkout.js');
 const {bookings,payments}=await import('@zamrabooking/db/schema');const f=fixture();f.review.createdAt=new Date().toISOString();f.booking.id='b1';
 const app=new Hono();let reads=0,writes=0;
 app.use('*',async(c,next)=>{c.set('tenantId','t1');c.set('db',{execute:async()=>{writes++;return {rows:[{id:'b1'}]}},select:()=>({from:(table:any)=>({where:()=>{reads++;const rows=table===bookings?[f.booking]:table===payments?[]:f.passengers;return {limit:async()=>rows,then:(r:any)=>Promise.resolve(rows).then(r)};}})}),update:()=>{throw Error('writes forbidden')},insert:()=>{throw Error('writes forbidden')}});await next();});app.route('/checkout',checkoutRoutes);
 const secret='local-fixture-not-a-secret', exp=Math.floor(Date.now()/1000)+300;
 const token=await signToken({sub:'b1',tenantId:'t1',exp},secret);
 const env:any={JWT_SECRET:secret,SESSIONS_KV:{get:async(key:string)=>key.startsWith('checkout:')?JSON.stringify({token,used:false}):f.review}};
 const send=(t:string,body:unknown)=>app.request(`/checkout/session/${t}/baggage-quote`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},env);
 assert.equal((await send('invalid',{passengers:[]})).status,401);assert.equal(reads,0);
 const other=await signToken({sub:'b1',tenantId:'t2',exp},secret);assert.equal((await send(other,{passengers:[]})).status,403);assert.equal(reads,0);
 assert.equal((await send(token,{passengers:[],total:1})).status,400);assert.equal(reads,0);
 const result=await send(token,{passengers:[{passengerId:'p1',baggage:[{key:'out',code:'B5'}]}]});assert.equal(result.status,200);assert.equal((await result.json() as any).commitAllowed,true);assert.equal(writes,0);
 const apply=await app.request(`/checkout/session/${token}/baggage-apply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:f.booking.updatedAt.toISOString(),passengers:[{passengerId:'p1',baggage:[{key:'out',code:'B5'}]}]})},env);
 assert.equal(apply.status,200);assert.equal((await apply.json() as any).totalAmount,'10500.00');assert.equal(writes,1);
});
