import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function readConfig(env = process.env) {
  const config = {
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET,
    autoReply: env.AUTO_REPLY === 'true',
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.META_GRAPH_API_VERSION,
    allowedRecipients: new Set((env.ALLOWED_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean)),
  };
  if (!config.verifyToken || !config.appSecret) throw new Error('Set WHATSAPP_VERIFY_TOKEN and META_APP_SECRET.');
  if (config.autoReply && (!config.accessToken || !/^\d+$/.test(config.phoneNumberId || '') ||
      !/^v\d+\.\d+$/.test(config.apiVersion || '') || !config.allowedRecipients.size)) {
    throw new Error('Auto reply requires access token, numeric Phone Number ID, API version (vXX.X), and ALLOWED_RECIPIENTS.');
  }
  return config;
}

function validSignature(body, signature, secret) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

function replyText(message) {
  const text = message.text?.body?.trim().toLowerCase() || '';
  if (['hi', 'hello', 'hey'].includes(text)) {
    return 'Hi! Welcome to the Greytt Journeys demo. Which destination are you interested in? This is an automated demo; no booking is being made.';
  }
  return 'Thanks for contacting Greytt Journeys! Please tell us your destination, travel dates, number of travellers, and approximate budget. This demo does not confirm prices or bookings.';
}

export function createApp(config, { fetchImpl = fetch, log = console.log } = {}) {
  // Demo-only deduplication: bounded, in-memory, lost on restart.
  const seen = new Map();
  let pending = 0;

  async function processEvent(event) {
    for (const entry of event.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        for (const status of value.statuses || []) {
          log(JSON.stringify({ event: 'delivery_status', status: status.status }));
        }
        for (const message of value.messages || []) {
          if (!message.id || !message.from) continue;
          const now = Date.now();
          for (const [id, expiry] of seen) if (expiry < now) seen.delete(id);
          if (seen.has(message.id)) continue;
          seen.set(message.id, now + 86400000);
          if (seen.size > 10000) seen.delete(seen.keys().next().value);
          log(JSON.stringify({ event: 'incoming_message', type: message.type, autoReply: config.autoReply }));
          if (!config.autoReply || !config.allowedRecipients.has(message.from) ||
              value.metadata?.phone_number_id !== config.phoneNumberId) continue;
          const response = await fetchImpl(
            `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ messaging_product: 'whatsapp', to: message.from,
                type: 'text', text: { body: replyText(message) } }),
              signal: AbortSignal.timeout(10000),
            },
          );
          // Do not log response bodies: they can contain customer data.
          if (!response.ok) log(JSON.stringify({ event: 'reply_failed', httpStatus: response.status }));
          else log(JSON.stringify({ event: 'reply_sent' }));
        }
      }
    }
  }

  return createServer(async (req, res) => {
    const send = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok');
      if (url.pathname !== '/webhooks/whatsapp') return send(404, 'Not found');
      if (req.method === 'GET') {
        if (url.searchParams.get('hub.mode') === 'subscribe' &&
            url.searchParams.get('hub.verify_token') === config.verifyToken && url.searchParams.has('hub.challenge')) {
          return send(200, url.searchParams.get('hub.challenge'));
        }
        return send(403, 'Verification failed');
      }
      if (req.method !== 'POST') return send(405, 'Method not allowed');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) return send(413, 'Payload too large');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) return send(401, 'Invalid signature');
      let event;
      try { event = JSON.parse(raw.toString('utf8')); } catch { return send(400, 'Invalid JSON'); }
      if (!event || event.object !== 'whatsapp_business_account' || !Array.isArray(event.entry)) return send(400, 'Invalid event');
      if (pending >= 100) return send(503, 'Busy; retry later');
      pending++;
      // Acknowledge promptly; work is not durable. See README before production use.
      send(200, 'EVENT_RECEIVED');
      void processEvent(event).catch(() => log(JSON.stringify({ event: 'processing_failed' }))).finally(() => pending--);
    } catch {
      if (!res.headersSent) send(500, 'Internal error');
    }
  });
}
