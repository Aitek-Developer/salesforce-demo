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
