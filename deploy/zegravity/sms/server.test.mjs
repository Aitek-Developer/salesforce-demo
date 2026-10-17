import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { composeText, createHandler, e164FromLead, keywordOf, loadConfig, signatureValid, twilioSignature } from './server.mjs';

const LEAD_ID = '1a57c45a-95d7-4079-bf99-4c4c86426293';
const TEXT_ID = '2b57c45a-95d7-4079-bf99-4c4c86426293';
const env = {
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'auth-token', TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
  SMS_CRM_API_KEY: 'crm-key', SMS_CRM_URL: 'http://crm.test', SMS_PUBLIC_URL: 'https://crm.zegravity.com',
};
const NOON_CHICAGO = new Date('2026-10-17T17:00:00Z');

function lead(overrides = {}) {
  return { id: LEAD_ID, name: 'Maria Lopez', ownerId: 'owner-1', sequenceStatus: 'NOT_STARTED', smsConsent: true, smsOptOut: false,
    phones: { primaryPhoneNumber: '5125550142', primaryPhoneCallingCode: '+1', primaryPhoneCountryCode: 'US' }, ...overrides };
}

// A fake CRM REST API and Twilio API in one request function.
function pendingText(overrides = {}) {
  return { id: TEXT_ID, leadId: LEAD_ID, direction: 'OUTBOUND', deliveryStatus: 'pending', twilioSid: null, body: 'Your audit is ready.',
    createdAt: new Date(NOON_CHICAGO.getTime() - 30000).toISOString(), ...overrides };
}

function fakeApis({ crmLead = lead(), earlierTexts = [], twilioStatus = 201, pending = pendingText() } = {}) {
  const calls = [];
  const request = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body, headers: init.headers });
    const json = (status, data) => new Response(JSON.stringify(data), { status });
    if (url.startsWith('https://api.twilio.com')) {
      return twilioStatus === 201 ? json(201, { sid: 'SM123', status: 'queued' }) : json(twilioStatus, { code: 21610, message: 'Attempt to send to unsubscribed recipient' });
    }
    const path = decodeURIComponent(url.replace('http://crm.test/rest/', ''));
    if (method === 'GET' && path.startsWith(`leads/${LEAD_ID}`)) return json(200, { data: { lead: crmLead } });
    if (method === 'GET' && path.startsWith('leads?')) return json(200, { data: { leads: crmLead ? [crmLead] : [] } });
    if (method === 'GET' && path === `textMessages/${TEXT_ID}`) return json(200, { data: { textMessage: pending } });
    if (method === 'GET' && path.startsWith('textMessages?')) return json(200, { data: { textMessages: path.includes('twilioSid[eq]') ? [{ id: 'tm-1' }] : earlierTexts } });
    if (method === 'POST' && path === 'textMessages') return json(201, { data: { createTextMessage: { id: 'tm-new' } } });
    if (method === 'POST' && path === 'tasks') return json(201, { data: { createTask: { id: 'task-1' } } });
    if (method === 'POST' && path === 'taskTargets') return json(201, { data: { createTaskTarget: { id: 'tt-1' } } });
    if (method === 'PATCH') return json(200, { data: {} });
    return json(404, {});
  };
  return { calls, request };
}

async function serve(t, apis, { now = NOON_CHICAGO, envOverrides = {} } = {}) {
  const { config, missing } = loadConfig({ ...env, ...envOverrides });
  const server = createServer(createHandler(config, missing, { request: apis.request, now: () => now, log: { info() {}, warn() {}, error() {} } }));
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const sendText = (base, body = { textMessageId: TEXT_ID }) => fetch(`${base}/sms/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function twilioPost(base, path, params, signature) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature ?? twilioSignature('auth-token', `https://crm.zegravity.com${path}`, params) },
    body: new URLSearchParams(params).toString(),
  });
}

const crmWrites = (calls, path) => calls.filter((c) => c.method !== 'GET' && c.url.endsWith(path)).map((c) => JSON.parse(c.body));

test('reports which settings are missing and refuses to work until configured', async (t) => {
  const { missing } = loadConfig({});
  assert.deepEqual(missing, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER', 'SMS_CRM_API_KEY']);
  const base = await serve(t, fakeApis(), { envOverrides: { TWILIO_AUTH_TOKEN: '' } });
  assert.equal((await fetch(`${base}/sms/health`)).status, 503);
  assert.equal((await sendText(base)).status, 503);
});

test('phone numbers, keywords and message text follow carrier rules', () => {
  assert.equal(e164FromLead({ primaryPhoneNumber: '(512) 555-0142', primaryPhoneCallingCode: '+1' }), '+15125550142');
  assert.equal(e164FromLead({ primaryPhoneNumber: '555', primaryPhoneCallingCode: '+1' }), null);
  assert.equal(keywordOf(' stop. '), 'STOP');
  assert.equal(composeText('Hi Maria', { brand: 'ZeGravity', firstText: true }), 'ZeGravity: Hi Maria Reply STOP to opt out.');
  assert.equal(composeText('ZeGravity here', { brand: 'ZeGravity', firstText: false }), 'ZeGravity here');
  assert.ok(signatureValid('t', 'https://x/y', { b: '2', a: '1' }, twilioSignature('t', 'https://x/y', { a: '1', b: '2' })));
  assert.ok(!signatureValid('t', 'https://x/y', { a: '1' }, 'forged'));
});

test('sends the pending text through the messaging service and records the result on it', async (t) => {
  const apis = fakeApis();
  const base = await serve(t, apis);
  const response = await sendText(base);
  assert.equal(response.status, 200);
  const twilio = apis.calls.find((c) => c.url.startsWith('https://api.twilio.com'));
  const form = new URLSearchParams(twilio.body);
  assert.equal(form.get('To'), '+15125550142');
  assert.equal(form.get('MessagingServiceSid'), 'MGtest');
  assert.equal(form.get('Body'), 'ZeGravity: Your audit is ready. Reply STOP to opt out.');
  assert.equal(form.get('StatusCallback'), 'https://crm.zegravity.com/sms/twilio/status');
  const [claimed, done] = crmWrites(apis.calls, `textMessages/${TEXT_ID}`);
  assert.deepEqual(claimed, { deliveryStatus: 'sending' });
  assert.equal(done.twilioSid, 'SM123');
  assert.equal(done.deliveryStatus, 'queued');
  assert.equal(done.phone, '+15125550142');
  assert.ok(!JSON.stringify(apis.calls.filter((c) => !c.url.startsWith('https://api.twilio.com'))).includes('auth-token'));
});

test('later texts skip the opt-out line', async (t) => {
  const apis = fakeApis({ earlierTexts: [{ id: 'old' }] });
  const base = await serve(t, apis);
  await sendText(base);
  const form = new URLSearchParams(apis.calls.find((c) => c.url.startsWith('https://api.twilio.com')).body);
  assert.equal(form.get('Body'), 'ZeGravity: Your audit is ready.');
});

test('never texts without consent, after STOP, outside hours, or for a stale or reused record', async (t) => {
  for (const [crmLead, now, reason] of [
    [lead({ smsConsent: false }), NOON_CHICAGO, /not agreed/],
    [lead({ smsOptOut: true }), NOON_CHICAGO, /opted out/],
    [lead({ phones: { primaryPhoneNumber: '' } }), NOON_CHICAGO, /no valid phone/],
    [lead(), new Date('2026-10-17T03:00:00Z'), /Central time/],
  ]) {
    const pending = pendingText({ createdAt: new Date(now.getTime() - 30000).toISOString() });
    const apis = fakeApis({ crmLead, pending });
    const base = await serve(t, apis, { now });
    const response = await sendText(base);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, reason);
    assert.ok(!apis.calls.some((c) => c.url.startsWith('https://api.twilio.com')));
    assert.match(crmWrites(apis.calls, `textMessages/${TEXT_ID}`).at(-1).deliveryStatus, /^not sent: /);
  }
  for (const pending of [pendingText({ deliveryStatus: 'sending' }), pendingText({ twilioSid: 'SMold' }),
    pendingText({ direction: 'INBOUND' }), pendingText({ createdAt: '2026-10-17T16:00:00Z' })]) {
    const apis = fakeApis({ pending });
    const base = await serve(t, apis);
    assert.equal((await sendText(base)).status, 409);
    assert.equal(apis.calls.filter((c) => c.method !== 'GET').length, 0);
  }
  const apis = fakeApis();
  const base = await serve(t, apis);
  assert.equal((await sendText(base, { textMessageId: 'x' })).status, 400);
  assert.equal(apis.calls.length, 0);
});

test('a Twilio refusal is recorded on the text with the reason', async (t) => {
  const apis = fakeApis({ twilioStatus: 400 });
  const base = await serve(t, apis);
  const response = await sendText(base);
  assert.equal(response.status, 502);
  assert.match(crmWrites(apis.calls, `textMessages/${TEXT_ID}`).at(-1).deliveryStatus, /unsubscribed recipient \(code 21610\)/);
});

test('a reply is logged, stops the email sequence and creates a task for the owner', async (t) => {
  const apis = fakeApis({ crmLead: lead({ smsConsent: false, sequenceStatus: 'ACTIVE' }) });
  const base = await serve(t, apis);
  const response = await twilioPost(base, '/sms/twilio/inbound', { From: '+15125550142', Body: 'Yes, call me tomorrow', MessageSid: 'SMin' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Response><\/Response>/);
  assert.equal(crmWrites(apis.calls, 'textMessages')[0].direction, 'INBOUND');
  const [update] = crmWrites(apis.calls, `leads/${LEAD_ID}`);
  assert.deepEqual(update, { smsConsent: true, sequenceStatus: 'REPLIED' });
  const [task] = crmWrites(apis.calls, 'tasks');
  assert.equal(task.assigneeId, 'owner-1');
  assert.match(task.title, /Maria Lopez/);
  assert.deepEqual(crmWrites(apis.calls, 'taskTargets')[0], { taskId: 'task-1', targetLeadId: LEAD_ID });
});

test('STOP marks the lead opted out and creates no task', async (t) => {
  const apis = fakeApis();
  const base = await serve(t, apis);
  await twilioPost(base, '/sms/twilio/inbound', { From: '+15125550142', Body: 'Stop', MessageSid: 'SMstop' });
  assert.deepEqual(crmWrites(apis.calls, `leads/${LEAD_ID}`)[0], { smsOptOut: true });
  assert.equal(crmWrites(apis.calls, 'tasks').length, 0);
});

test('unsigned or forged webhooks are refused before touching the CRM', async (t) => {
  const apis = fakeApis();
  const base = await serve(t, apis);
  const response = await twilioPost(base, '/sms/twilio/inbound', { From: '+15125550142', Body: 'hi' }, 'forged');
  assert.equal(response.status, 403);
  assert.equal(apis.calls.length, 0);
});

test('delivery updates are written to the logged text', async (t) => {
  const apis = fakeApis();
  const base = await serve(t, apis);
  await twilioPost(base, '/sms/twilio/status', { MessageSid: 'SM123', MessageStatus: 'undelivered', ErrorCode: '30007' });
  assert.deepEqual(crmWrites(apis.calls, 'textMessages/tm-1')[0], { deliveryStatus: 'undelivered (error 30007)' });
});

// Calling
const CALL_ID = '3c57c45a-95d7-4079-bf99-4c4c86426293';
const voiceEnv = { TWILIO_VOICE_NUMBER: '+18723287888', VOICE_AGENT_PHONE: '+13125550100' };

function pendingCall(overrides = {}) {
  return { id: CALL_ID, leadId: LEAD_ID, direction: 'OUTBOUND', callStatus: 'pending', twilioCallSid: null, name: 'Call to Maria Lopez',
    createdAt: new Date(NOON_CHICAGO.getTime() - 30000).toISOString(), ...overrides };
}

function voiceApis({ crmLead = lead(), record = pendingCall(), twilioStatus = 201 } = {}) {
  const base = fakeApis({ crmLead });
  const request = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const json = (status, data) => new Response(JSON.stringify(data), { status });
    const path = decodeURIComponent(url.replace('http://crm.test/rest/', ''));
    if (url.includes('/Calls.json')) {
      base.calls.push({ url, method, body: init.body });
      return twilioStatus === 201 ? json(201, { sid: 'CA123', status: 'queued' }) : json(twilioStatus, { code: 21215, message: 'Geo permission denied' });
    }
    if (method === 'GET' && path === `phoneCalls/${CALL_ID}`) { base.calls.push({ url, method }); return json(200, { data: { phoneCall: record } }); }
    if (method === 'POST' && path === 'phoneCalls') { base.calls.push({ url, method, body: init.body }); return json(201, { data: { createPhoneCall: { id: CALL_ID } } }); }
    return base.request(url, init);
  };
  return { calls: base.calls, request };
}

const placeCall = (base, body = { phoneCallId: CALL_ID }) => fetch(`${base}/sms/call`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('calling stays off until the business number and the owner phone are set; texting still works', async (t) => {
  const base = await serve(t, voiceApis());
  const health = await (await fetch(`${base}/sms/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.calling, false);
  assert.equal((await placeCall(base)).status, 503);
});

test('click-to-call rings the owner first, then connects the lead from the business number', async (t) => {
  const apis = voiceApis();
  const base = await serve(t, apis, { envOverrides: voiceEnv });
  const response = await placeCall(base);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sid: 'CA123', to: '+15125550142' });
  const twilio = new URLSearchParams(apis.calls.find((c) => c.url.includes('Calls.json')).body);
  assert.equal(twilio.get('To'), '+13125550100');
  assert.equal(twilio.get('From'), '+18723287888');
  assert.equal(twilio.get('Url'), `https://crm.zegravity.com/sms/twilio/voice/connect?call=${CALL_ID}`);
  const writes = crmWrites(apis.calls, `phoneCalls/${CALL_ID}`);
  assert.equal(writes[0].callStatus, 'calling you');
  assert.equal(writes.at(-1).twilioCallSid, 'CA123');

  // The owner answered: Twilio fetches the connect step, which must be signed with its query string.
  const path = `/sms/twilio/voice/connect?call=${CALL_ID}`;
  assert.equal((await twilioPost(base, path, { CallStatus: 'in-progress' }, 'bad')).status, 403);
  const connect = await twilioPost(base, path, { CallStatus: 'in-progress' });
  const xmlBody = await connect.text();
  assert.equal(connect.status, 200);
  assert.match(xmlBody, /<Say>Connecting you to Maria Lopez\.<\/Say>/);
  assert.match(xmlBody, /<Dial callerId="\+18723287888"[^>]*><Number>\+15125550142<\/Number><\/Dial>/);
  assert.doesNotMatch(xmlBody, /record/i);

  const dialed = await twilioPost(base, `/sms/twilio/voice/dialed?call=${CALL_ID}`, { DialCallStatus: 'completed', DialCallDuration: '95' });
  assert.match(await dialed.text(), /<Hangup\/>/);
  const last = crmWrites(apis.calls, `phoneCalls/${CALL_ID}`).at(-1);
  assert.equal(last.callStatus, 'completed');
  assert.equal(last.durationSeconds, 95);
});

test('does not place a call to a do-not-call lead, outside calling hours, or twice', async (t) => {
  const noCall = voiceApis({ crmLead: lead({ doNotCall: true }) });
  let base = await serve(t, noCall, { envOverrides: voiceEnv });
  assert.equal((await placeCall(base)).status, 409);
  assert.equal(noCall.calls.some((c) => c.url.includes('Calls.json')), false);
  assert.match(crmWrites(noCall.calls, `phoneCalls/${CALL_ID}`).at(-1).callStatus, /Do not call/);

  const late = voiceApis();
  base = await serve(t, late, { envOverrides: voiceEnv, now: new Date('2026-10-18T03:00:00Z') });
  assert.equal((await placeCall(base)).status, 409);
  assert.equal(late.calls.some((c) => c.url.includes('Calls.json')), false);

  const again = voiceApis({ record: pendingCall({ callStatus: 'completed', twilioCallSid: 'CA1' }) });
  base = await serve(t, again, { envOverrides: voiceEnv });
  assert.equal((await placeCall(base)).status, 409);
});

test('an inbound call rings the owner and a missed one becomes a task on the lead', async (t) => {
  const apis = voiceApis({ record: pendingCall({ direction: 'INBOUND', callStatus: 'ringing you', name: 'Call from Maria Lopez', phone: '+15125550142' }) });
  const base = await serve(t, apis, { envOverrides: voiceEnv });
  const inbound = await twilioPost(base, '/sms/twilio/voice/inbound', { From: '+15125550142', CallSid: 'CA9' });
  assert.match(await inbound.text(), /<Dial callerId="\+15125550142"[^>]*><Number>\+13125550100<\/Number><\/Dial>/);
  const created = JSON.parse(apis.calls.find((c) => c.method === 'POST' && c.url.endsWith('/phoneCalls')).body);
  assert.equal(created.direction, 'INBOUND');
  assert.equal(created.leadId, LEAD_ID);

  const done = await twilioPost(base, `/sms/twilio/voice/inbound-done?call=${CALL_ID}`, { DialCallStatus: 'no-answer', From: '+15125550142' });
  assert.match(await done.text(), /will call you back/);
  assert.equal(crmWrites(apis.calls, `phoneCalls/${CALL_ID}`).at(-1).callStatus, 'missed (no-answer)');
  assert.match(crmWrites(apis.calls, 'tasks')[0].title, /Missed call: Maria Lopez/);
  assert.equal(crmWrites(apis.calls, 'taskTargets')[0].targetLeadId, LEAD_ID);
});
