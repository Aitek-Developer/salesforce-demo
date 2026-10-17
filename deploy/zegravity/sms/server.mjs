// ZeGravity SMS bridge: sends texts to CRM leads through Twilio and records replies.
//
//   POST /sms/send             {textMessageId}  called by the CRM "Send text" workflow
//   POST /sms/twilio/inbound   Twilio incoming-message webhook (signature checked)
//   POST /sms/twilio/status    Twilio delivery-status callback (signature checked)
//   GET  /sms/health
//
// /sms/send needs no shared secret: it only sends a Text Message record that a CRM user
// created minutes ago with status "pending", read back through the bridge's own CRM key.
// Twilio keys and the CRM API key live only in the server's .env. No npm dependencies.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);
const MAX_BODY = 640;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export function loadConfig(env = process.env) {
  const config = {
    accountSid: env.TWILIO_ACCOUNT_SID?.trim() ?? '',
    authToken: env.TWILIO_AUTH_TOKEN?.trim() ?? '',
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? '',
    fromNumber: env.TWILIO_FROM_NUMBER?.trim() ?? '',
    crmUrl: (env.SMS_CRM_URL?.trim() || 'http://server:3000').replace(/\/+$/, ''),
    crmApiKey: env.SMS_CRM_API_KEY?.trim() ?? '',
    // Twilio signs the exact public URL it called, so it must match the proxy address.
    publicUrl: (env.SMS_PUBLIC_URL?.trim() || 'https://crm.zegravity.com').replace(/\/+$/, ''),
    brand: env.SMS_BRAND?.trim() || 'ZeGravity',
    // Sending window in Chicago time; 10:00-20:00 Central stays inside 8am-9pm for every US mainland zone.
    windowStartHour: Number(env.SMS_WINDOW_START_HOUR ?? 10),
    windowEndHour: Number(env.SMS_WINDOW_END_HOUR ?? 20),
  };
  const missing = [];
  if (!config.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.messagingServiceSid && !config.fromNumber) missing.push('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER');
  if (!config.crmApiKey) missing.push('SMS_CRM_API_KEY');
  return { config, missing };
}

export function digitsOf(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

// The CRM keeps US numbers as 10 national digits plus a +1 calling code.
export function e164FromLead(phones) {
  if (!phones) return null;
  const national = digitsOf(phones.primaryPhoneNumber);
  if (!national) return null;
  const calling = digitsOf(phones.primaryPhoneCallingCode) || '1';
  if (calling === '1') {
    if (national.length === 10) return `+1${national}`;
    if (national.length === 11 && national.startsWith('1')) return `+${national}`;
    return null;
  }
  return `+${calling}${national}`;
}

export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((text, key) => text + key + params[key], url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function signatureValid(authToken, url, params, received) {
  if (!received) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(String(received));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function keywordOf(body) {
  return String(body ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
}

export function chicagoHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(now));
}

// Carriers require the sender to be identified and the first text to explain opting out.
export function composeText(body, { brand, firstText }) {
  let text = String(body ?? '').trim();
  if (!text.toLowerCase().startsWith(brand.toLowerCase())) text = `${brand}: ${text}`;
  if (firstText && !/\bSTOP\b/.test(text)) text = `${text} Reply STOP to opt out.`;
  return text;
}

function preview(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

export function createBridge(config, { request = fetch, now = () => new Date(), log = console } = {}) {
  const crmHeaders = { Authorization: `Bearer ${config.crmApiKey}`, 'Content-Type': 'application/json' };

  async function crm(path, init = {}) {
    const response = await request(`${config.crmUrl}/rest/${path}`, { ...init, headers: crmHeaders, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`CRM ${init.method ?? 'GET'} ${path.split('?')[0]} answered ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async function recordText(record) {
    const created = await crm('textMessages', { method: 'POST', body: JSON.stringify(record) });
    return created?.data?.createTextMessage ?? null;
  }

  async function findLeadByPhone(phone) {
    const digits = digitsOf(phone);
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (national.length < 4) return null;
    const filter = encodeURIComponent(`phones.primaryPhoneNumber[like]:"%${national.slice(-4)}"`);
    const found = await crm(`leads?limit=50&filter=${filter}`);
    const leads = found?.data?.leads ?? [];
    return leads.find((lead) => {
      const stored = digitsOf(lead.phones?.primaryPhoneNumber);
      return stored === national || stored === digits || `1${stored}` === digits;
    }) ?? null;
  }

  async function send({ textMessageId }) {
    if (typeof textMessageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(textMessageId)) {
      return { status: 400, result: { ok: false, error: 'textMessageId is missing or not an id' } };
    }
    const pending = (await crm(`textMessages/${textMessageId}`))?.data?.textMessage;
    if (!pending) return { status: 404, result: { ok: false, error: 'Text message not found' } };
    const age = now().getTime() - new Date(pending.createdAt).getTime();
    if (pending.direction !== 'OUTBOUND' || pending.deliveryStatus !== 'pending' || pending.twilioSid || !(age >= 0 && age < PENDING_MAX_AGE_MS)) {
      return { status: 409, result: { ok: false, error: 'Only a new pending text can be sent' } };
    }
    const mark = (fields) => crm(`textMessages/${textMessageId}`, { method: 'PATCH', body: JSON.stringify(fields) });
    const refuse = async (reason, status = 409) => {
      await mark({ deliveryStatus: `not sent: ${reason}` });
      return { status, result: { ok: false, error: reason } };
    };
    // Claim the record first so a repeated call cannot send it twice.
    await mark({ deliveryStatus: 'sending' });

    const message = String(pending.body ?? '').trim();
    if (!message) return refuse('the message is empty', 400);
    if (message.length > MAX_BODY) return refuse(`the message is longer than ${MAX_BODY} characters`, 400);
    const lead = pending.leadId ? (await crm(`leads/${pending.leadId}`))?.data?.lead : null;
    if (!lead) return refuse('the text is not linked to a lead', 404);
    const to = e164FromLead(lead.phones);
    if (!to) return refuse('the lead has no valid phone number');
    if (lead.smsOptOut) return refuse('the lead opted out of texts (replied STOP)');
    if (!lead.smsConsent) return refuse('the lead has not agreed to texts ("Texting allowed" is off)');
    const hour = chicagoHour(now());
    if (hour < config.windowStartHour || hour >= config.windowEndHour) {
      return refuse(`texts go out only between ${config.windowStartHour}:00 and ${config.windowEndHour}:00 Central time`);
    }

    const earlier = await crm(`textMessages?limit=1&filter=${encodeURIComponent(`and(leadId[eq]:"${lead.id}",direction[eq]:"OUTBOUND",twilioSid[startsWith]:"SM")`)}`);
    const text = composeText(message, { brand: config.brand, firstText: (earlier?.data?.textMessages ?? []).length === 0 });

    const form = new URLSearchParams({ To: to, Body: text, StatusCallback: `${config.publicUrl}/sms/twilio/status` });
    if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
    else form.set('From', config.fromNumber);
    const twilio = await request(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const sent = await twilio.json().catch(() => ({}));
    if (!twilio.ok) {
      return refuse(`${sent.message ?? `Twilio answered ${twilio.status}`}${sent.code ? ` (code ${sent.code})` : ''}`, 502);
    }
    await mark({ name: `Sent: ${preview(text)}`, body: text, phone: to, deliveryStatus: sent.status ?? 'queued', twilioSid: sent.sid ?? '' });
    return { status: 200, result: { ok: true, sid: sent.sid, to, text } };
  }

  async function inbound(params) {
    const from = params.From ?? '';
    const body = params.Body ?? '';
    const lead = await findLeadByPhone(from);
    const keyword = keywordOf(body);
    const record = { name: `Received: ${preview(body)}`, body, direction: 'INBOUND', phone: from, deliveryStatus: 'received', twilioSid: params.MessageSid ?? '' };
    if (lead) record.leadId = lead.id;
    await recordText(record);
    if (!lead) {
      log.info?.(`inbound text from an unknown number ending ${digitsOf(from).slice(-4)}`);
      return;
    }
    if (STOP_WORDS.has(keyword)) {
      await crm(`leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ smsOptOut: true }) });
      return;
    }
    // Texting us is consent to a reply; START undoes an earlier STOP.
    const update = { smsConsent: true, ...(START_WORDS.has(keyword) ? { smsOptOut: false } : {}) };
    if (lead.sequenceStatus === 'ACTIVE') update.sequenceStatus = 'REPLIED';
    await crm(`leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify(update) });
    if (keyword === 'HELP' || START_WORDS.has(keyword)) return;
    const task = await crm('tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: `Lead texted back: ${lead.name ?? from}`,
        status: 'TODO',
        ...(lead.ownerId ? { assigneeId: lead.ownerId } : {}),
        dueAt: now().toISOString(),
        bodyV2: { markdown: `They texted: "${preview(body)}"\n\nReply from the lead's page with **Send text**, or call them. Their phone: ${from}` },
      }),
    });
    const taskId = task?.data?.createTask?.id;
    if (taskId) await crm('taskTargets', { method: 'POST', body: JSON.stringify({ taskId, targetLeadId: lead.id }) });
  }

  async function status(params) {
    const sid = params.MessageSid ?? params.SmsSid;
    if (!sid) return;
    const found = await crm(`textMessages?limit=1&filter=${encodeURIComponent(`twilioSid[eq]:"${sid}"`)}`);
    const message = found?.data?.textMessages?.[0];
    if (!message) return;
    const state = params.MessageStatus ?? params.SmsStatus ?? '';
    const detail = params.ErrorCode ? `${state} (error ${params.ErrorCode})` : state;
    await crm(`textMessages/${message.id}`, { method: 'PATCH', body: JSON.stringify({ deliveryStatus: detail }) });
  }

  return { send, inbound, status, findLeadByPhone };
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHandler(config, missing, deps = {}) {
  const bridge = createBridge(config, deps);
  const log = deps.log ?? console;
  const reply = (res, status, payload, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(payload) : payload);
  };

  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    try {
      if (req.method === 'GET' && path === '/sms/health') {
        return reply(res, missing.length ? 503 : 200, { ok: missing.length === 0, missing });
      }
      if (missing.length) return reply(res, 503, { ok: false, error: 'SMS bridge is not configured', missing });

      if (req.method === 'POST' && path === '/sms/send') {
        let input;
        try { input = JSON.parse(await readBody(req)); } catch { return reply(res, 400, { ok: false, error: 'Body must be JSON' }); }
        const { status, result } = await bridge.send(input ?? {});
        return reply(res, status, result);
      }

      if (req.method === 'POST' && (path === '/sms/twilio/inbound' || path === '/sms/twilio/status')) {
        const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
        if (!signatureValid(config.authToken, `${config.publicUrl}${path}`, params, req.headers['x-twilio-signature'])) {
          log.warn?.(`rejected unsigned request to ${path}`);
          return reply(res, 403, { ok: false, error: 'Invalid Twilio signature' });
        }
        if (path === '/sms/twilio/inbound') await bridge.inbound(params);
        else await bridge.status(params);
        // An empty TwiML response: STOP/HELP auto-replies come from Twilio's opt-out management.
        return reply(res, 200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 'text/xml');
      }
      return reply(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      log.error?.(`${req.method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      return reply(res, error?.statusCode ?? 500, { ok: false, error: 'The SMS bridge hit an error; see its log' });
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { config, missing } = loadConfig();
  if (missing.length) console.warn(`SMS bridge not configured yet; missing: ${missing.join(', ')}`);
  const port = Number(process.env.PORT ?? 8080);
  createServer(createHandler(config, missing)).listen(port, () => console.log(`SMS bridge listening on ${port}`));
}
