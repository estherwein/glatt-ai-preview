import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import '../../assets/leads-core.js';
import '../../assets/leads-form.js';
import {input, ORIGIN} from './helpers.mjs';
const create = globalThis.GlattLeadForm.createSubmission;
const confirmed = payload => ({ok:true, saved:true, requestId:payload.requestId, leadId:randomUUID()});
const digest = async value => createHash('sha256').update(value).digest('hex');
const options = overrides => ({uuid:randomUUID, digest, send:async payload => confirmed(payload), ...overrides});

test('double click is ignored while first request is in progress', async () => {
  let release, calls=0; const saved=[];
  const controller = create(options({send:payload => {calls++;return new Promise(r => {release=() => r(confirmed(payload));});}, onSaved:r=>saved.push(r)}));
  const first=controller.submit(input(),ORIGIN);
  await Promise.resolve();
  assert.deepEqual(await controller.submit(input(),ORIGIN),{ignored:true});
  release(); assert.equal((await first).ok,true); assert.equal(calls,1); assert.equal(saved.length,1);
  assert.deepEqual(await controller.submit(input(),ORIGIN),{ignored:true});
});
test('network retry preserves request ID and form input', async () => {
  const ids=[];const original=input();const serialized=JSON.stringify(original);const states=[];
  const controller=create(options({send:async p=>{ids.push(p.requestId);if(ids.length===1)throw new Error('network');return confirmed(p);},onBusy:v=>states.push(v)}));
  assert.equal((await controller.submit(original,ORIGIN)).ok,false);
  assert.equal((await controller.submit(original,ORIGIN)).ok,true);
  assert.equal(ids[0],ids[1]);assert.equal(JSON.stringify(original),serialized);assert.deepEqual(states,[true,false,true,false]);
});
test('reload retains only request metadata, not personal input', async () => {
  const store=new Map();const storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  const ids=[];
  await create(options({storage,send:async p=>{ids.push(p.requestId);throw new Error('lost response');}})).submit(input(),ORIGIN);
  const persisted=[...store.values()].join('');
  assert(!persisted.includes('ישראל'));assert(!persisted.includes('050'));assert(!persisted.includes('test@example.com'));
  await create(options({storage,send:async p=>{ids.push(p.requestId);return confirmed(p);}})).submit(input(),ORIGIN);
  assert.equal(ids[0],ids[1]);
});
test('changed content gets a new request ID after an unsuccessful submission', async () => {
  const ids=[];const controller=create(options({send:async p=>{ids.push(p.requestId);throw new Error('network');}}));
  await controller.submit(input(),ORIGIN);
  await controller.submit({...input(),lead:{...input().lead,process:'תהליך אחר'}},ORIGIN);
  assert.notEqual(ids[0],ids[1]);
});
test('ambiguous response and false success never call the success UI', async () => {
  for(const value of [{ok:true},{ok:true,saved:true,requestId:'wrong',leadId:randomUUID()},null]){
    let saved=false;const controller=create(options({send:async()=>value,onSaved:()=>{saved=true;}}));
    assert.equal((await controller.submit(input(),ORIGIN)).ok,false);assert.equal(saved,false);
  }
});
test('invalid phone/email and honeypot fail before transport', async () => {
  let sent=false;const controller=create(options({send:async()=>{sent=true;}}));
  for(const value of [{...input(),lead:{...input().lead,phone:'abc'}},{...input(),lead:{...input().lead,email:'bad'}},{...input(),website:'bot'}]){
    assert.equal((await controller.submit(value,ORIGIN)).ok,false);
  }
  assert.equal(sent,false);
});
test('empty email/process accepted; phone normalized and fields bounded', async () => {
  let captured;const controller=create(options({send:async p=>{captured=p;return confirmed(p);}}));
  assert.equal((await controller.submit({...input(),lead:{...input().lead,email:'',process:''}},ORIGIN)).ok,true);
  assert.equal(captured.lead.phone,'+972501234567');
  assert.throws(()=>globalThis.GlattLeads.lead({...input().lead,name:'x'.repeat(121)},ORIGIN));
});
test('storage blocked by browser still allows retry using in-memory request ID', async () => {
  const ids=[];const storage={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}};
  const controller=create(options({storage,send:async p=>{ids.push(p.requestId);throw new Error('network');}}));
  await controller.submit(input(),ORIGIN);await controller.submit(input(),ORIGIN);assert.equal(ids[0],ids[1]);
});
test('explicit reset allows a new intentional enquiry', async () => {
  const ids=[];const controller=create(options({send:async p=>{ids.push(p.requestId);return confirmed(p);}}));
  await controller.submit(input(),ORIGIN);controller.reset();await controller.submit(input(),ORIGIN);assert.notEqual(ids[0],ids[1]);
});
