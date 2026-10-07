import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { pathToFileURL } from 'node:url';
import { adminRoutes } from './routes/admin.js';
import { adminUiRoutes } from './routes/admin-ui.js';
import { fotaRoutes } from './routes/fota.js';

export function buildServer() {
  // trustProxy: 1 - req.ip is the rightmost X-Forwarded-For entry. On
  // Railway this was verified (2026-10-07) NOT to be the client: it is one
  // of several Railway proxy addresses (152.233.x.x), so req.ip must not be
  // used to tell clients apart until the right source is confirmed (see
  // loginRateLimit.ts). Locally (no proxy header) req.ip is the socket
  // address.
  const app = Fastify({ logger: false, trustProxy: 1 });
  app.register(multipart);
  app.register(adminRoutes);
  app.register(adminUiRoutes);
  app.register(fotaRoutes);
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 4100);
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen({ port, host }).then(() => {
    console.log(`FOTA backend listening on http://${host}:${port}`);
    console.log('Local-only MVP: no cloud infrastructure, no production auth. See FOTA_MVP_Implementation_Plan_v0.2.md.');
  });
}
