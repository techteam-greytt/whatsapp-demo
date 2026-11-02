# Greytt WhatsApp demo

Standalone Node.js 22+ backend, with no third-party dependencies. This demo verifies Meta's webhook, authenticates events, and optionally sends a fixed travel-enquiry reply. It has no AI, database, booking system, or human inbox.

## Files

```text
whatsapp-demo/
  .env.example
  .gitignore
  package.json
  render.yaml
  README.md
  src/
    app.js
    server.js
  test/
    webhook.test.js
```

## Run locally (PowerShell)

From this repository's root:

```powershell
cd demos/whatsapp-demo
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the generated value into WHATSAPP_VERIFY_TOKEN in .env. Set META_APP_SECRET to the secret for the same app whose webhook you are configuring (App settings > Basic). Keep AUTO_REPLY=false initially. Do not commit .env or share secrets in screenshots.

```powershell
npm test
npm start
```

Open http://localhost:3000/health. It should say `ok`. Localhost cannot be used directly as Meta's callback; deploy or use an HTTPS tunnel.

## Deploy on Render

1. Push these files to your GitHub repo. You may copy this folder's contents into a separate repo without changing the JavaScript.
2. Create a Render **Web Service**, connect your repo, and select the Node runtime.
3. Root Directory: `demos/whatsapp-demo` for this repo; leave blank for a separate repo with package.json at its root.
4. Build Command: `node --version` (no dependencies to install).
5. Start Command: `npm start`.
6. Health Check Path: `/health`.
7. Add environment variables: `NODE_VERSION=22`, your `WHATSAPP_VERIFY_TOKEN`, your `META_APP_SECRET`, and `AUTO_REPLY=false`.
8. Deploy. Open `https://YOUR-SERVICE.onrender.com/health`; expect `ok`.

Render sets PORT; the app listens on that port on 0.0.0.0. Pick hosting appropriate for webhook responsiveness; check the selected plan's idle/sleep behaviour. The included render.yaml is optional; if using a Blueprint, select that file and adjust rootDir if copied to a standalone repo.

## Connect Meta

In the app's WhatsApp production setup:

- Callback URL: `https://YOUR-SERVICE.onrender.com/webhooks/whatsapp`
- Verify token: the exact WHATSAPP_VERIFY_TOKEN configured on Render (not your access token).
- Leave the client-certificate setting at its default for this demo.

Click **Verify and save**. Subscribe to the **messages** field in webhook subscriptions. Use Meta's dashboard test action and check Render logs for `incoming_message` or `delivery_status`. No automatic reply is sent with AUTO_REPLY=false.

Your current Meta dashboard warns that unpublished apps only receive dashboard test webhooks. Follow the publication requirements displayed for your app before expecting real-user events. A verified callback alone does not publish the app or register a business phone number. Also confirm the app is subscribed to the relevant WhatsApp Business Account when moving to real messages.

## Enable a reply to your own phone

Set these additional Render environment variables, then redeploy:

| Variable | Value |
| --- | --- |
| AUTO_REPLY | true |
| WHATSAPP_ACCESS_TOKEN | Access token authorized to send WhatsApp messages; a temporary test token expires |
| WHATSAPP_PHONE_NUMBER_ID | Sending Phone Number ID from Meta, not the telephone number or WABA ID |
| META_GRAPH_API_VERSION | Supported Graph version copied from your dashboard's API example, such as vXX.X with actual digits |
| ALLOWED_RECIPIENTS | Your WhatsApp number with country code and digits only; comma-separated for multiple testers |

Keep the recipient verified in Meta when using its test number. Send a message from your allowlisted phone to the configured sending number. When Meta delivers the event, the app responds once. The incoming metadata Phone Number ID must match the configured ID. The reply is a free-form response to an incoming message; this demo does not initiate template messages outside the customer service window.

Logs deliberately exclude tokens, message text, and phone numbers. `reply_failed` includes HTTP status: check token validity, permissions, recipient eligibility, Phone Number ID, and API version. Status-only webhooks never trigger replies. Unsupported message types receive a generic text response.

## Demo limitations

Events are acknowledged immediately and processed in memory. Pending work can be lost on restart. Duplicate IDs are retained for up to 24 hours (maximum 10,000 entries), and deduplication resets on restart. Failed replies are logged and are not automatically retried. Run one instance for this demo. Before production, add durable queues, shared deduplication, controlled retries, persistent lead storage, monitoring, consent and human handover.

## References

- Meta's webhook handshake and signature behaviour: https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
- Meta Cloud API collection: https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
- Render deployment: https://render.com/docs/deploy-node-express-app
- Render port binding: https://render.com/docs/web-services#port-binding
