import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, type DevUserRow } from './db.js';

/**
 * MVP dev-only authentication: an opaque per-user bearer token maps
 * server-side to exactly one email. The critical invariant (Implementation
 * Plan v0.2, Section 10/16): identity ALWAYS comes from this lookup, never
 * from a client-supplied field. No route handler ever reads an email out
 * of a request body/query for the purpose of deciding "whose firmware is
 * this" - see routes/fota.ts.
 */
declare module 'fastify' {
  interface FastifyRequest {
    authenticatedEmail?: string;
  }
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing bearer token.' });
    return;
  }
  const user = db.prepare('SELECT * FROM dev_users WHERE token = ?').get(token) as
    | DevUserRow
    | undefined;
  if (!user) {
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid token.' });
    return;
  }
  req.authenticatedEmail = user.email;
  done();
}
