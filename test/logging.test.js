import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './src/app.js';

test('logs inbound content, outbound content, API message ID and status', async () => {
  const logs = [];
  const app = createApp({ verifyToken: 'verify', autoReply: true, allowedRecipients: new Set(['1234']),
    phoneNumberId: '5678', apiVersion: 'v99.0', accessToken: 'SECRET_TOKEN' }, {
    log: line => logs.push(JSON.parse(line)),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'out-1' }] }) }),
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    await fetch(`http://127.0.0.1:${app.address().port}/webhooks/whatsapp`, {
      method: 'POST', body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba',
        changes: [{ value: { metadata: { phone_number_id: '5678', display_phone_number: '5555' },
          contacts: [{ wa_id: '1234', profile: { name: 'Demo User' } }],
          messages: [{ id: 'in-1', from: '1234', type: 'text', text: { body: 'hello' } }],
          statuses: [{ id: 'older-out', recipient_id: '1234', status: 'delivered' }],
        } }] }] }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.find(l => l.event === 'incoming_message').text, 'hello');
    assert.equal(logs.find(l => l.event === 'incoming_message').name, 'Demo User');
    assert.match(logs.find(l => l.event === 'outgoing_message_attempt').message.text.body, /Greytt/);
    assert.equal(logs.find(l => l.event === 'outgoing_message_accepted').messageId, 'out-1');
    assert.equal(logs.find(l => l.event === 'message_status').status, 'delivered');
    assert.equal(JSON.stringify(logs).includes('SECRET_TOKEN'), false);
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
