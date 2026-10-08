import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { pathToFileURL } from 'node:url';
import { adminRoutes } from './routes/admin.js';
import { adminUiRoutes } from './routes/admin-ui.js';
import { fotaRoutes } from './routes/fota.js';
import { TRUSTED_PROXY_HOPS } from './proxyLayout.js';

export function buildServer() {
  // Trusts Railway's two proxy hops (socket peer + edge), so req.ip is the
  // client - see proxyLayout.ts for the verified layout. Locally (no proxy
  // header) req.ip is the socket address.
  const app = Fastify({ logger: false, trustProxy: TRUSTED_PROXY_HOPS });
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
