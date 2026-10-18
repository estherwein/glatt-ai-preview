/* Run against an isolated headless Chrome at CDP_URL (default http://127.0.0.1:9338).
 * Uses local files and intercepted synthetic responses only. Never submits a real lead.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const original = execFileSync('git', ['show','HEAD:index.html'], {cwd:root, encoding:'utf8'});
const endpoint = 'https://glattai-leads-review.test.workers.dev/leads';
let origin, enabled = true, behavior = 'hold';
const requests = [];
const held = [];
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/original') {res.setHeader('Content-Type','text/html');res.end(original);return;}
  if (pathname === '/assets/leads-config.js') {
    res.setHeader('Content-Type','text/javascript');
    res.end('window.GLATT_LEADS_CONFIG=' + JSON.stringify({environment:'preview',enabled,allowedOrigins:[origin],endpoint,timeoutMs:200,privacy:{text:'',url:''}}));return;
  }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
origin = 'http://127.0.0.1:' + server.address().port;
const cdp = process.env.CDP_URL || 'http://127.0.0.1:9338';
const target = await (await fetch(cdp + '/json/new?about:blank',{method:'PUT'})).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open',resolve,{once:true}));
let serial=0;
const pending=new Map();
const send=(method,params={}) => new Promise((resolve,reject) => {
  const id=++serial; pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));
});
const run=async expression => {
  const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async expression=>{
  for(let i=0;i<100;i++){if(await run(expression))return;await delay(30);}throw new Error('Timed out: '+expression);
};
const fulfill=async(event,body,status=200)=>send('Fetch.fulfillRequest',{
  requestId:event.requestId,responseCode:status,
  responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin},
    {name:'Access-Control-Allow-Methods',value:'POST, OPTIONS'},{name:'Access-Control-Allow-Headers',value:'content-type'}],
  body:Buffer.from(JSON.stringify(body)).toString('base64')
});
const ack=body=>({ok:true,saved:true,requestId:body.requestId,leadId:'87654321-1234-4123-8123-123456789abc'});
socket.addEventListener('message',({data})=>{
  const message=JSON.parse(data);
  if(message.id){const p=pending.get(message.id);pending.delete(message.id);if(p)message.error?p.reject(message.error):p.resolve(message.result);return;}
  if(message.method!=='Fetch.requestPaused')return;
  const event=message.params;
  (async()=>{
    if(event.request.url.startsWith(origin)){await send('Fetch.continueRequest',{requestId:event.requestId});return;}
    if(event.request.url!==endpoint){await send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;}
    if(event.request.method==='OPTIONS'){await fulfill(event,{},204);return;}
    const body=JSON.parse(event.request.postData);requests.push(body);
    if(behavior==='hold'){held.push(event);return;}
    if(behavior==='network'){await send('Fetch.failRequest',{requestId:event.requestId,errorReason:'ConnectionFailed'});return;}
    if(behavior==='bad-ack'){await fulfill(event,{ok:true});return;}
    if(behavior==='rate'){await fulfill(event,{ok:false,code:'RATE_LIMITED'},429);return;}
    await fulfill(event,ack(body));
  })().catch(error=>{console.error('Mock transport failed',error.code || 'CDP');});
});
try {
  await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const navigate=async page=>{
    await send('Page.navigate',{url:origin+page});
    await waitFor(`location.pathname===${JSON.stringify(page)} && document.readyState==='complete' && !!document.getElementById('fitForm')`);
    if(page==='/')await waitFor(`!!document.getElementById('fitForm').dataset.leadsBound`);
  };
  const geometry=()=>run(`['.form-card','.frm-grid','#fname','#fphone','#fmail','#fproc','.frm-submit'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`);
  for(const width of [390,1440]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await navigate('/original');const before=await geometry();
    await navigate('/');assert.deepEqual(await geometry(),before);
    console.log(`PASS ${width}px: idle form geometry unchanged`);
  }
  const fill=()=>run(`document.getElementById('fname').value='משתמש בדיקה';document.getElementById('fphone').value='0501234567';document.getElementById('fmail').value='test@example.com';document.getElementById('fproc').value='בדיקת טופס';`);
  const submit=()=>run(`document.getElementById('fitForm').requestSubmit()`);
  const success=()=>run(`document.getElementById('formSuccess').classList.contains('show')`);
  await delay(1600);await fill();
  await run(`document.getElementById('fitForm').requestSubmit();document.getElementById('fitForm').requestSubmit()`);
  await waitFor(`document.querySelector('.frm-submit').disabled`);
  assert.equal(await success(),false);
  for(let i=0;i<30&&!held.length;i++)await delay(10);
  assert.equal(requests.length,1);
  await fulfill(held.shift(),{ok:false,code:'UPSTREAM_ERROR'},502);
  await waitFor(`!document.querySelector('.frm-submit').disabled`);
  assert.equal(await run(`document.getElementById('fname').value`),'משתמש בדיקה');
  assert.equal(await run(`document.getElementById('leadStatus').hidden`),false);
  behavior='success';await submit();await waitFor(`document.getElementById('formSuccess').classList.contains('show')`);
  assert.equal(requests[0].requestId,requests[1].requestId);
  assert.equal(await run(`document.activeElement.id`),'successBack');
  assert.equal(await run(`document.getElementById('fitForm').inert`),true);
  console.log('PASS browser double-submit, loading, failure preservation, same-ID retry and confirmed success');
  await run(`document.getElementById('successBack').click()`);
  assert.equal(await run(`document.getElementById('fname').value`),'');
  assert.equal(await success(),false);
  await fill();await delay(1600);
  for(const mode of ['network','bad-ack','rate','hold']){
    behavior=mode;await submit();await waitFor(`!document.querySelector('.frm-submit').disabled`);
    assert.equal(await success(),false);assert.equal(await run(`document.getElementById('leadStatus').hidden`),false);
    assert.equal(await run(`document.getElementById('fphone').value`),'0501234567');
    // A timeout does not turn a late response into a success screen.
    while(held.length){try{await fulfill(held.shift(),ack(requests.at(-1)));}catch(_){}}
    await delay(30);assert.equal(await success(),false);
  }
  console.log('PASS network failure, invalid acknowledgement, rate limit and timeout with late response');
  enabled=false;await navigate('/');await fill();await delay(1600);const sentBefore=requests.length;
  await submit();await waitFor(`!document.querySelector('.frm-submit').disabled`);
  assert.equal(requests.length,sentBefore);assert.equal(await success(),false);
  assert.match(await run(`document.getElementById('leadStatus').textContent`),/אינה זמינה/);
  console.log('PASS disabled preview configuration never submits');
} finally {
  await send('Browser.close').catch(()=>{});socket.close();server.closeAllConnections();server.close();
}
