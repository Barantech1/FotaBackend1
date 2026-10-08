import type { FastifyRequest } from 'fastify';

/**
 * Railway's proxy layout, observed live on 2026-10-07 (11 requests, one
 * client, edge europe-west4): client -> Railway edge (152.233.x.x, varies)
 * -> internal proxy (100.64.0.x, varies, the socket peer) -> app. The edge
 * sends X-Forwarded-For as "client, edge", drops any X-Forwarded-For the
 * client sent, and overwrites X-Real-IP.
 *
 * Fastify's trustProxy: 2 trusts the socket peer and the edge entry, so
 * req.ip is the client entry. A forged entry further left is never reached,
 * even if Railway stopped dropping it. If Railway added a hop, req.ip would
 * become a shared Railway address (not spoofable, but the per-IP cap would
 * then count every client together) - which warnOnUnexpectedProxyLayout
 * flags.
 */
export const TRUSTED_PROXY_HOPS = 2;
export const EXPECTED_FORWARDED_FOR_ENTRIES = 2;

/**
 * Warns when a request's X-Forwarded-For doesn't have the expected number of
 * entries - with the count only, never the addresses. Warning only: nothing
 * else changes. No header at all is normal locally, so that is only flagged
 * in production.
 */
export function warnOnUnexpectedProxyLayout(req: FastifyRequest): void {
  const header = req.headers['x-forwarded-for'];
  if (header === undefined && process.env.NODE_ENV !== 'production') return;
  const entries = [header ?? []]
    .flat()
    .flatMap((value) => value.split(','))
    .filter((entry) => entry.trim() !== '').length;
  if (entries !== EXPECTED_FORWARDED_FOR_ENTRIES) {
    console.warn(
      `[proxy layout] X-Forwarded-For has ${entries} entries, expected ${EXPECTED_FORWARDED_FOR_ENTRIES}; req.ip may not be the client`,
    );
  }
}
