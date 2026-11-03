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
  if (!config.verifyToken) throw new Error('Set WHATSAPP_VERIFY_TOKEN.');
  if (config.autoReply && (!config.accessToken || !/^\d+$/.test(config.phoneNumberId || '') ||
      !/^v\d+\.\d+$/.test(config.apiVersion || '') || !config.allowedRecipients.size)) {
    throw new Error('Auto reply requires access token, numeric Phone Number ID, API version (vXX.X), and ALLOWED_RECIPIENTS.');
  }
  return config;
}

function validSignature(body, signature, secret) {
  if (!secret) return true; // Optional signature check if secret not provided
  if (!/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

/**
 * What the customer said, as text: typed text, or the choice they tapped.
 * Null for anything else (voice notes, images, location, …).
 */
function incomingText(m) {
  if (m.type === 'text') return m.text?.body?.trim() || null;
  if (m.type === 'interactive') {
    const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
    const full = m.interactive?.list_reply?.description ?? r?.title;
    return full?.trim() || null;
  }
  if (m.type === 'button') return m.button?.text?.trim() || null;
  return null;
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
  const record = (event, details = {}) => log(JSON.stringify({
    loggedAt: new Date().toISOString(), event, ...details,
  }));

  async function processEvent(event) {
    record('webhook_received', { payload: event });

    if (event.object === 'whatsapp_business_account') {
      for (const entry of event.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const names = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile?.name ?? null]));

          for (const status of value.statuses || []) {
            record('message_status', {
              direction: 'outgoing', businessAccountId: entry.id,
              businessPhone: value.metadata?.display_phone_number,
              phoneNumberId: value.metadata?.phone_number_id,
              to: status.recipient_id, messageId: status.id,
              status: status.status, details: status,
            });
          }

          for (const message of value.messages || []) {
            if (!message.id || !message.from) continue;

            const now = Date.now();
            for (const [id, expiry] of seen) if (expiry < now) seen.delete(id);
            if (seen.has(message.id)) {
              record('duplicate_message_skipped', { messageId: message.id, from: message.from });
              continue;
            }
            seen.set(message.id, now + 86400000);
            if (seen.size > 10000) seen.delete(seen.keys().next().value);

            const messageDetails = {
              direction: 'incoming',
              businessAccountId: entry.id,
              to: value.metadata?.display_phone_number,
              phoneNumberId: value.metadata?.phone_number_id,
              id: message.id,
              from: message.from,
              name: names.get(message.from) ?? null,
              type: message.type,
              timestamp: message.timestamp,
              text: incomingText(message),
              message,
              contact: (value.contacts || []).find(c => c.wa_id === message.from) ?? null,
            };
            record('incoming_message', messageDetails);

            if (!config.autoReply || !config.allowedRecipients.has(message.from) ||
                value.metadata?.phone_number_id !== config.phoneNumberId) {
              record('auto_reply_skipped', { inReplyTo: message.id,
                reason: !config.autoReply ? 'disabled' : !config.allowedRecipients.has(message.from)
                  ? 'recipient_not_allowlisted' : 'phone_number_id_mismatch' });
              continue;
            }

            const outgoing = { messaging_product: 'whatsapp', to: message.from,
              type: 'text', text: { body: replyText(message) } };
            const outgoingDetails = {
              direction: 'outgoing', from: value.metadata?.display_phone_number,
              phoneNumberId: config.phoneNumberId, to: message.from,
              recipientName: names.get(message.from) ?? null,
              inReplyTo: message.id, message: outgoing,
            };
            record('outgoing_message_attempt', outgoingDetails);

            try {
            const response = await fetchImpl(
              `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(outgoing),
                signal: AbortSignal.timeout(10000),
              },
            );
            let apiResponse;
            try { apiResponse = await response.json(); }
            catch { apiResponse = { note: 'Response body unavailable or not JSON' }; }
            // Never log request headers or configuration: those contain credentials.
            record(response.ok ? 'outgoing_message_accepted' : 'outgoing_message_failed', {
              ...outgoingDetails, httpStatus: response.status,
              messageId: apiResponse.messages?.[0]?.id ?? null,
              apiResponse,
            });
            } catch (error) {
              record('outgoing_message_failed', { ...outgoingDetails,
                error: { name: error?.name, message: error?.message } });
            }
          }
        }
      }
    }
  }

  return createServer(async (req, res) => {
    const send = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok');

      // Support both /webhooks/whatsapp and /webhook
      if (url.pathname !== '/webhooks/whatsapp' && url.pathname !== '/webhook') {
        return send(404, 'Not found');
      }

      if (req.method === 'GET') {
        const verifyToken = url.searchParams.get('hub.verify_token') || '';
        const mode = url.searchParams.get('hub.mode');
        const challenge = url.searchParams.get('hub.challenge') || '';

        const tokenBuf = Buffer.from(verifyToken);
        const expectedBuf = Buffer.from(config.verifyToken || '');

        if (mode === 'subscribe' && expectedBuf.length && tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
          log('whatsapp: webhook verified');
          return send(200, challenge);
        }
        log('whatsapp: webhook verification failed');
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
      if (config.appSecret && !validSignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) {
        return send(401, 'Invalid signature');
      }

      let event;
      try { event = JSON.parse(raw.toString('utf8')); } catch { return send(400, 'Invalid JSON'); }
      if (!event || event.object !== 'whatsapp_business_account' || !Array.isArray(event.entry)) return send(400, 'Invalid event');
      if (pending >= 100) return send(503, 'Busy; retry later');
      pending++;
      send(200, 'EVENT_RECEIVED');
      void processEvent(event).catch((err) => log('whatsapp: processing_failed ' + (err?.message || err))).finally(() => pending--);
    } catch {
      if (!res.headersSent) send(500, 'Internal error');
    }
  });
}
