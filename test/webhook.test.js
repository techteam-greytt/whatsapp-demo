import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';

test('verification, signatures, duplicate messages, allowlist and status-only events', async t => {
  const calls = [];
  const app = createApp({ verifyToken: 'test-verify', appSecret: 'test-secret', autoReply: true,
    accessToken: 'test-access', phoneNumberId: '123', apiVersion: 'v99.0', allowedRecipients: new Set(['919999999999']) },
  { fetchImpl: async (...args) => { calls.push(args); return { ok: true }; }, log: () => {} });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}/webhooks/whatsapp`;
  const verified = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345`);
  assert.equal(verified.status, 200);
  assert.equal(await verified.text(), '12345');
  assert.equal((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=wrong`)).status, 403);
  const makeBody = (from = '919999999999', id = 'message-1') => JSON.stringify({ object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123' },
      messages: [{ id, from, type: 'text', text: { body: 'hello' } }] } }] }] });
  const post = body => fetch(base, { method: 'POST', body, headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}` } });
  assert.equal((await fetch(base, { method: 'POST', body: makeBody() })).status, 401);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(makeBody())).status, 200);
  await post(makeBody());
  await post(makeBody('918888888888', 'message-2'));
  const statusBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ status: 'delivered' }] } }] }] });
  assert.equal((await post(statusBody)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0][1].body).to, '919999999999');
});
