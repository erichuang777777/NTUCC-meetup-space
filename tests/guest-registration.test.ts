import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import handler from '../netlify/functions/events-api.js';
const E='10000000-0000-4000-8000-000000000001';
test('guest API accepts no login, uses scoped secret, validates and rate limits',async()=>{
 const calls:any[]=[];let allow=true;
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 const counts=new Map<string,number>();
 const createKey=hash('guest-create:127.0.0.1');
 const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const data=JSON.parse(raw||'{}');calls.push({url:req.url,data});res.setHeader('Content-Type','application/json');
 if(req.url?.endsWith('/consume_guest_quota')) {
 const n=(counts.get(data.p_key)||0)+1;counts.set(data.p_key,n);
 res.end(JSON.stringify((allow||data.p_key!==createKey)&&n<=data.p_limit));
 }
 else if(req.url?.endsWith('/register_guest_event'))res.end(JSON.stringify({status:'registered',registration_id:E,ticket:{token:'ntucc_ticket_'+'b'.repeat(64)}}));
 else if(req.url?.endsWith('/access_guest_event')&&data.p_hash===hash('ntucc_guest_'+'d'.repeat(64))){res.statusCode=400;res.end(JSON.stringify({message:'INVALID_GUEST_TOKEN'}));}
 else if(req.url?.endsWith('/access_guest_event'))res.end(JSON.stringify({status:data.p_cancel?'cancelled':'registered',ticket:data.p_cancel?null:{token:'ntucc_ticket_'+'b'.repeat(64)}}));
 else{res.statusCode=500;res.end('{}');}
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 process.env.SUPABASE_URL=`http://127.0.0.1:${(server.address() as any).port}`;process.env.SUPABASE_SERVICE_ROLE_KEY='test';
 try{
 const call=(method:string,path='guest-registration',data?:any,headers:any={})=>handler(new Request(`https://test/api/v1/events/${E}/${path}`,{method,headers:{'Content-Type':'application/json',...headers},...(data?{body:JSON.stringify(data)}:{})}),{ip:'127.0.0.1'});
 const data={name:'Guest',organization:'臺大',contact_email:'personal@example.test'};
 const response=await call('POST',undefined,data,{'Idempotency-Key':'a'.repeat(64)});assert.equal(response.status,200);const result=await response.json();assert.equal(result.management_token,'ntucc_guest_'+'a'.repeat(64));assert.equal(result.calendar_url,`/api/v1/events/${E}/calendar`);
 assert(!calls.some(c=>c.url.includes('/auth/')));const rpc=calls.find(c=>c.url.endsWith('/register_guest_event'));assert.equal(rpc.data.p_user,undefined);assert.match(rpc.data.p_hash,/^[a-f0-9]{64}$/);assert.notEqual(rpc.data.p_hash,'a'.repeat(64));
 assert.equal((await call('GET')).status,401);
 assert.equal((await call('GET','guest-ticket',undefined,{Authorization:'Bearer '+result.management_token})).status,200);
 assert.equal((await call('DELETE',undefined,undefined,{Authorization:'Bearer '+result.management_token})).status,200);
 assert.equal((await call('POST',undefined,{...data,user_id:E})).status,400);
 assert.equal((await call('POST',undefined,data,{'Idempotency-Key':'guessable'})).status,400);
 // All clients share a hospital NAT. Exhausted create bucket must never
 // prevent already-issued capabilities from retrieving/cancelling tickets.
 allow=false;assert.equal((await call('POST',undefined,data)).status,429);
 const auth={Authorization:'Bearer '+result.management_token};
 assert.equal((await call('GET','guest-ticket',undefined,auth)).status,200);
 const readKey=hash(`guest-read:${E}:${hash(result.management_token)}`);
 counts.set(readKey,120);
 assert.equal((await call('GET','guest-ticket',undefined,auth)).status,429);
 assert.equal((await call('GET','guest-ticket',undefined,{Authorization:'Bearer ntucc_guest_'+'c'.repeat(64)})).status,200);
 assert.equal((await call('DELETE',undefined,undefined,auth)).status,200);
 assert.equal((await call('GET')).status,401);
 const quotaCalls=calls.filter(c=>c.url.endsWith('/consume_guest_quota')).length;
 assert.equal((await call('GET','guest-ticket',undefined,{Authorization:'Bearer ntucc_guest_'+'d'.repeat(64)})).status,401);
 assert.equal(calls.filter(c=>c.url.endsWith('/consume_guest_quota')).length,quotaCalls);
 assert(!calls.some(c=>c.url.endsWith('/consume_guest_quota')&&c.data.p_key===hash('guest:127.0.0.1')));
 }finally{server.close();}
});
test('unexpected request errors never log raw credentials',async()=>{
 const secret='ntucc_guest_'+'f'.repeat(64), logs:unknown[][]=[];
 const original=console.error;
 console.error=(...args)=>{logs.push(args);};
 try {
 const req=new Request(`https://test/api/v1/events/${E}/guest-registration`,{method:'POST'});
 Object.defineProperty(req,'url',{get(){throw Error(`Authorization: Bearer ${secret}`);}});
 const response=await handler(req);
 assert.equal(response.status,500);
 assert.equal(JSON.stringify(logs).includes(secret),false);
 assert.equal(JSON.stringify(logs).includes('Authorization'),false);
 assert.deepEqual(logs,[['Events API request failed']]);
 }finally{console.error=original;}
});
