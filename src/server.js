import { createApp, readConfig } from './app.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const app = createApp(readConfig());
app.listen(port, '0.0.0.0', () => console.log(`Greytt WhatsApp demo listening on port ${port}`));
