// Disposable loopback fixture DB ONLY. No production DSN, migration runner or external calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const qa=Module.createRequire(path.resolve(process.argv[2],'package.json')), {Pool}=qa('pg');
const file=path.resolve(__dirname,'../src/lib/booking-price-lock.ts'),m=new Module(file,module);m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);
const {freezeBookingPrice:freeze,applyBookingBaggage:apply}=m.exports;
const apiRequire=Module.createRequire(file),{PgDialect}=apiRequire('drizzle-orm/pg-core'),dialect=new PgDialect();
const pool=new Pool({connectionString:'postgresql://baggage_test:isolated-fixture-only@127.0.0.1:5432/baggage_test',max:8});
const ns='baggage_'+require('node:crypto').randomUUID().replaceAll('-','');
(async()=>{let count=0;try{
 await pool.query(`CREATE SCHEMA "${ns}"`);
 async function session(fn){const c=await pool.connect();try{await c.query(`SET search_path TO "${ns}"`);return await fn(c,{execute:async sql=>{const q=dialect.sqlToQuery(sql);return c.query(q.sql,q.params)}});}finally{c.release();}}
 await session(async c=>{await c.query('CREATE TABLE bookings(id text primary key,tenant_id text,status text,currency text,total_amount numeric,base_fare numeric,flight_data jsonb,updated_at timestamptz,held_until timestamptz); CREATE TABLE payments(booking_id text)');});
 async function fresh(){const id='b'+(++count);await session(c=>c.query("INSERT INTO bookings VALUES($1,'t','PAYMENT_PENDING','INR',100,100,$2::jsonb,now(),NULL)",[id,JSON.stringify({checkoutPriceProtocol:1})]));return {id,totalAmount:'100',currency:'INR',flightData:{checkoutPriceProtocol:1}};}
 const next=(tag)=>({total:'150',baseFare:'150',flightData:{checkoutPriceProtocol:1,baggageVersion:tag},expiresAt:new Date(Date.now()+60000).toISOString()});
 for(let i=0;i<20;i++){
 const b=await fresh();const r=await Promise.allSettled([session((c,db)=>freeze(db,'t',b)),session((c,db)=>apply(db,'t',b,next('a')))]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 }
 let b=await fresh();let r=await Promise.allSettled([session((c,db)=>apply(db,'t',b,next('a'))),session((c,db)=>apply(db,'t',b,next('b')))]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(session((c,db)=>freeze(db,'t',b)));
 const row=await session(async c=>(await c.query('SELECT * FROM bookings WHERE id=$1',[b.id])).rows[0]);
 await session((c,db)=>freeze(db,'t',{...b,totalAmount:String(row.total_amount),flightData:row.flight_data}));
 await assert.rejects(session((c,db)=>apply(db,'t',{...b,totalAmount:String(row.total_amount),flightData:row.flight_data},next('stale'))));
 b=await fresh();r=await Promise.allSettled([session((c,db)=>freeze(db,'t',b)),session((c,db)=>freeze(db,'t',b))]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 b=await fresh();await session(c=>c.query('INSERT INTO payments VALUES($1)',[b.id]));await assert.rejects(session((c,db)=>apply(db,'t',b,next('paid'))));
 b=await fresh();await assert.rejects(session((c,db)=>apply(db,'other',b,next('tenant'))));await assert.rejects(session((c,db)=>apply(db,'t',b,{...next('expired'),expiresAt:'2000-01-01T00:00:00Z'})));
 console.log('PASS: 20 payment/reprice races; apply/apply and payment/payment races; stale revision, ledger, tenant and expiry guards');
 }finally{await pool.query(`DROP SCHEMA IF EXISTS "${ns}" CASCADE`);await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
