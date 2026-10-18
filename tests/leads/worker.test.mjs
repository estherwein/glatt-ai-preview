import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest, readLimited} from '../../lead-gateway/worker.mjs';
import {env, request, input, ORIGIN, REQUEST_ID, SECRET} from './helpers.mjs';
const ack = () => ({ok:true, saved:true, requestId:REQUEST_ID, leadId:'87654321-1234-4123-8123-123456789abc'});
const success = async () => Response.json(ack());

test('exact allowed-origin CORS preflight succeeds without contacting Google', async () => {
  const r = new Request('https://worker.example/leads', {method:'OPTIONS', headers:{Origin:ORIGIN,
    'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'content-type'}});
  const result = await handleRequest(r, env(), () => {throw new Error('Must not fetch');});
  assert.equal(result.status, 204); assert.equal(result.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(result.headers.get('Access-Control-Allow-Credentials'), null);
});
test('production, wildcard-like origins and missing Origin rejected even if configured', async () => {
  for (const origin of ['https://glattai.com', 'https://www.glattai.com', 'https://estherwein.github.io', '', ORIGIN + '.evil.com']) {
    const cfg = env(); cfg.ALLOWED_ORIGINS = JSON.stringify([ORIGIN, origin]);
    const r = request(input(), {headers:{Origin:origin,'Content-Type':'application/json'}});
    const result = await handleRequest(r, cfg, success);
    assert.equal(result.status, 403); assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  }
});
test('disabled configuration, missing secret and missing rate binding fail closed', async () => {
  for (const change of [{ENABLED:'false'}, {ENVIRONMENT:'production'}, {HMAC_SECRET:''}, {LEAD_RATE_LIMITER:undefined}]) {
    assert.equal((await handleRequest(request(), {...env(), ...change}, success)).status, 503);
  }
});
test('rate binding blocks request before upstream; keys do not contain raw IPs', async () => {
  const cfg = env(); let key;
  cfg.LEAD_RATE_LIMITER.limit = async value => {key=value.key;return {success:false};};
  const result = await handleRequest(request(), cfg, () => {throw new Error('Must not fetch');});
  assert.equal(result.status, 429); assert.equal(result.headers.get('Retry-After'), '60');
  assert.match(key, /^[0-9a-f]{64}$/); assert(!key.includes('192.0.2.1'));
});
test('global binding blocks load and binding errors do not bypass protection', async () => {
  const cfg = env(); cfg.GLOBAL_RATE_LIMITER.limit = async () => ({success:false});
  assert.equal((await handleRequest(request(), cfg, success)).status, 429);
  cfg.GLOBAL_RATE_LIMITER.limit = async () => {throw new Error('binding offline');};
  assert.equal((await handleRequest(request(), cfg, success)).status, 503);
});
test('streaming size limit is enforced without Content-Length', async () => {
  const r = request(input(), {body:JSON.stringify({...input(), junk:'x'.repeat(17000)})});
  assert.equal((await handleRequest(r, env(), success)).status, 413);
  await assert.rejects(readLimited(new Response('א'.repeat(10)), 10), {code:'TOO_LARGE'});
});
test('invalid payload, JSON, content type and honeypot never reach Google', async () => {
  const never = () => {throw new Error('Unexpected upstream request');};
  for (const body of [{...input(), lead:{...input().lead, phone:'invalid'}}, {...input(), website:'spam'}, {...input(), elapsedMs:0}]) {
    assert.equal((await handleRequest(request(body), env(), never)).status, 400);
  }
  assert.equal((await handleRequest(request(input(), {body:'{'}), env(), never)).status, 400);
  assert.equal((await handleRequest(request(input(), {headers:{Origin:ORIGIN, 'Content-Type':'text/plain'}}), env(), never)).status, 415);
});
test('method, path and unexpected preflight headers rejected', async () => {
  assert.equal((await handleRequest(request(null, {method:'GET', body:undefined}), env(), success)).status, 405);
  const wrongPath = new Request('https://worker.example/admin', {headers:{Origin:ORIGIN}});
  assert.equal((await handleRequest(wrongPath, env(), success)).status, 404);
  const badPreflight = new Request('https://worker.example/leads', {method:'OPTIONS', headers:{Origin:ORIGIN,
    'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-secret'}});
  assert.equal((await handleRequest(badPreflight, env(), success)).status, 403);
});
test('network failure, timeout and non-JSON Google response produce no false success', async () => {
  for (const fetcher of [async () => {throw new Error('network');}, async () => {throw new DOMException('Timeout','AbortError');},
    async () => new Response('<html>Sign in</html>'), async () => new Response('Service unavailable', {status:503})]) {
    const result = await handleRequest(request(), env(), fetcher);
    assert.equal(result.status, 502); assert.equal((await result.json()).ok, false);
  }
});
test('HTTP 200 alone or a mismatched acknowledgement is insufficient', async () => {
  for (const value of [{ok:true}, {...ack(), saved:false}, {...ack(), requestId:'wrong'}, {...ack(), leadId:null}]) {
    assert.equal((await handleRequest(request(), env(), async () => Response.json(value))).status, 502);
  }
});
test('upstream secrets and private error messages are never forwarded', async () => {
  const result = await handleRequest(request(), env(), async () => Response.json({ok:false, code:'AUTH_FAILED', error:'test@example.com '+SECRET}));
  const body = await result.text(); assert(!body.includes(SECRET)); assert(!body.includes('test@example.com'));
});
test('server ID conflicts and busy locks become explicit retryable/error responses', async () => {
  for (const [code,status] of [['ID_CONFLICT',409],['BUSY',503]]) {
    const result = await handleRequest(request(), env(), async () => Response.json({ok:false,code}));
    assert.equal(result.status,status); assert.equal((await result.json()).code,code);
  }
});
