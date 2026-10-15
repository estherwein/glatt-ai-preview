import test from 'node:test';
import assert from 'node:assert/strict';
import {gasHarness, envelope, lead, REQUEST_ID, SECRET, env, request, ORIGIN} from './helpers.mjs';
import {handleRequest, hmac} from '../../lead-gateway/worker.mjs';

test('real Worker HMAC verifies in Apps Script, saves before mail, returns confirmed ID', async () => {
  const h = gasHarness();
  const result = await handleRequest(request(), env(), async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.signature, await hmac(SECRET, h.context.GlattLeads.signingText(body)));
    return Response.json(h.post(body));
  });
  const body = await result.json();
  assert.equal(body.ok, true); assert.equal(body.saved, true); assert.equal(body.requestId, REQUEST_ID);
  assert.equal(h.state.rows.length, 2); assert.equal(h.state.rows[1][7], 'חדש');
  assert.equal(h.state.rows[1][2], '+972501234567'); assert.equal(h.state.rows[1][11], 'sent');
  assert.equal(h.state.mails.length, 1); assert.match(h.state.mails[0].body, /https:\/\/wa.me\/972501234567/);
});

test('exact replay acknowledges durable row without appending or sending mail again', () => {
  const h = gasHarness(); const signed = envelope(h);
  assert.deepEqual(h.post(signed), h.post(signed));
  assert.equal(h.state.appendCalls, 1); assert.equal(h.state.mails.length, 1);
});
test('freshly signed legitimate retry works after old signature expires', () => {
  const h = gasHarness(); const signed = envelope(h); const first = h.post(signed);
  h.state.now += 600000;
  assert.equal(h.post(signed).code, 'AUTH_FAILED');
  assert.deepEqual(h.post(envelope(h)), first);
  assert.equal(h.state.rows.length, 2); assert.equal(h.state.mails.length, 1);
});
test('same request ID with changed content is rejected', () => {
  const h = gasHarness(); h.post(envelope(h));
  assert.equal(h.post(envelope(h, {}, {lead:{...lead(), name:'שם אחר'}})).code, 'ID_CONFLICT');
  assert.equal(h.state.rows.length, 2);
});
for (const field of ['payload', 'timestamp', 'requestId', 'environment', 'signature']) {
  test('signed envelope tampering rejected: ' + field, () => {
    const h = gasHarness(); const signed = envelope(h);
    signed[field] = field === 'timestamp' ? signed.timestamp + 1 : field === 'requestId' ? '12345678-1234-4123-8123-123456789abd' : 'tampered';
    assert.equal(h.post(signed).ok, false); assert.equal(h.state.rows.length, 1);
  });
}
test('old and future signatures rejected even when correctly signed', () => {
  const h = gasHarness();
  for (const offset of [-300001, 30001]) assert.equal(h.post(envelope(h, {timestamp:h.state.now + offset})).code, 'AUTH_FAILED');
});
test('server validates all inputs even with a valid signature', () => {
  for (const bad of [{name:''}, {phone:'abc'}, {email:'invalid'}, {background:'other'}, {process:'x'.repeat(1501)}, {page:'https://glattai.com/'}]) {
    const h = gasHarness(); assert.equal(h.post(envelope(h, {}, {lead:{...lead(), ...bad}})).code, 'INVALID_INPUT');
    assert.equal(h.state.rows.length, 1);
  }
});
test('server rejects honeypot, implausible timing, production origin and oversized requests', () => {
  const h = gasHarness();
  assert.equal(h.post(envelope(h, {}, {website:'bot'})).code, 'SPAM_REJECTED');
  assert.equal(h.post(envelope(h, {}, {elapsedMs:0})).code, 'SPAM_REJECTED');
  assert.equal(h.post(envelope(h, {}, {origin:'https://glattai.com'})).code, 'INVALID_INPUT');
  assert.equal(h.post(envelope(h, {payload:'x'.repeat(25000)})).code, 'INVALID_INPUT');
});
test('formula-like content stored as RAW text, HTML escaped in notifications', () => {
  const h = gasHarness(); const process = '=HYPERLINK("https://example.com", "<script>attack</script>")';
  assert.equal(h.post(envelope(h, {}, {lead:{...lead(), name:'=2+2', process}})).ok, true);
  assert.equal(h.state.rows[1][1], '=2+2'); assert.equal(h.state.rows[1][5], process);
  assert(!h.state.mails[0].htmlBody.includes('<script>'));
  assert(h.state.mails[0].htmlBody.includes('&lt;script&gt;'));
});
test('storage failure does not send email or confirm success', () => {
  const h = gasHarness(); h.state.failAppend = true;
  assert.equal(h.post(envelope(h)).code, 'STORAGE_ERROR'); assert.equal(h.state.mails.length, 0);
});
test('connection failure after append is recovered by retry without a duplicate', () => {
  const h = gasHarness(); h.state.failAfterAppend = true;
  assert.equal(h.post(envelope(h)).ok, false); assert.equal(h.state.rows.length, 2);
  h.state.failAfterAppend = false;
  assert.equal(h.post(envelope(h)).ok, true); assert.equal(h.state.appendCalls, 1);
  h.context.retryNotifications(); assert.equal(h.state.mails.length, 1);
});
test('concurrent attempts are serialized under the script lock', () => {
  const h = gasHarness(); let concurrent;
  h.state.onAppend = () => { concurrent = h.post(envelope(h)); };
  const first = h.post(envelope(h));
  assert.equal(first.ok, true); assert.equal(concurrent.code, 'BUSY');
  assert.deepEqual(h.post(envelope(h)), first); assert.equal(h.state.appendCalls, 1);
});
test('mail failure preserves lead and confirms success; trigger retries once due', () => {
  const h = gasHarness(); h.state.failMail = true;
  const first = h.post(envelope(h)); assert.equal(first.ok, true);
  assert.equal(h.state.rows[1][11], 'retry'); assert.equal(h.state.rows[1][15], 'MAIL_SEND_FAILED');
  assert(!JSON.stringify(h.state.rows).includes('Sensitive'));
  h.state.failMail = false; h.context.retryNotifications(); assert.equal(h.state.mails.length, 0);
  h.state.now += 300001; h.context.retryNotifications();
  assert.equal(h.state.rows[1][11], 'sent'); assert.equal(h.state.mails.length, 1);
  h.context.retryNotifications(); assert.equal(h.state.mails.length, 1);
});
test('exhausted email quota postpones notifications without losing lead or consuming attempts', () => {
  const h = gasHarness(); h.state.quota = 0;
  assert.equal(h.post(envelope(h)).ok, true); assert.equal(h.state.rows[1][15], 'EMAIL_QUOTA');
  assert.equal(h.state.rows[1][12], 0);
  h.state.quota = 1; h.state.now += 3600001; h.context.retryNotifications();
  assert.equal(h.state.mails.length, 1);
});
test('notification lease prevents concurrent sends and expires after interrupted completion', () => {
  const h = gasHarness(); h.state.failFinish = true;
  h.state.onMail = () => h.context.retryNotifications();
  assert.equal(h.post(envelope(h)).ok, true);
  assert.equal(h.state.mails.length, 1); assert.equal(h.state.rows[1][11], 'sending');
  h.state.failFinish = false; h.context.retryNotifications(); assert.equal(h.state.mails.length, 1);
  h.state.now += 600001; h.context.retryNotifications();
  assert.equal(h.state.mails.length, 2); // Documented at-least-once email recovery after ambiguous delivery.
  assert.equal(h.state.rows.length, 2); assert.equal(h.state.rows[1][11], 'sent');
});
test('notification retry budget is bounded and editor can explicitly requeue', () => {
  const h = gasHarness(); h.state.failMail = true; h.post(envelope(h));
  for (let i = 0; i < 8; i++) { h.state.now += 3600001; h.context.retryNotifications(); }
  assert.equal(h.state.rows[1][11], 'failed'); assert.equal(h.state.rows[1][12], 5);
  h.state.failMail = false; h.context.requeueFailedNotifications(); h.context.retryNotifications();
  assert.equal(h.state.rows[1][11], 'sent'); assert.equal(h.state.rows.length, 2);
});
test('setup is repeatable and refuses to replace existing sheet headers', () => {
  const h = gasHarness(); h.context.setupLeads(); assert.equal(h.state.triggers.length, 1);
  h.state.rows[0][0] = 'custom existing data';
  assert.throws(() => h.context.setupLeads(), /LEAD_SETUP_ERROR/);
  assert.equal(h.state.rows[0][0], 'custom existing data');
});
test('public endpoint cannot list leads or invoke administration', () => {
  const h = gasHarness(); assert.equal(JSON.parse(h.context.doGet()).ok, false);
  assert.equal(h.post({action:'retryNotifications'}).ok, false);
  h.props.ENABLED = 'false'; assert.equal(h.post(envelope(h)).code, 'UNAVAILABLE');
});
