import type { FastifyInstance } from 'fastify';
import { ADMIN_UI_HTML } from '../adminUiHtml.js';

/**
 * Serves the admin UI as one static page at GET /admin. The page itself
 * is a small client-side script that calls GET /admin/api/session to
 * decide whether to show the login form or the dashboard - no server-side
 * templating or separate login route needed.
 */
export async function adminUiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin', async (_req, reply) => {
    reply.type('text/html').send(ADMIN_UI_HTML);
  });
}
