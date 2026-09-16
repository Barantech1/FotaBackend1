import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, type AdminRow } from './db.js';

/**
 * Cookie-session auth for the admin UI, kept deliberately dependency-free
 * (no @fastify/session) - a signed, stateless cookie is enough for a
 * single admin, single-process MVP, and avoids adding a session-store
 * concern for a Railway deployment that may restart the process.
 *
 * Session secret: FOTA_ADMIN_SESSION_SECRET should be set in production
 * (Railway) so sessions survive a redeploy; if unset, a random secret is
 * generated at boot, which simply means everyone gets signed out on
 * restart - acceptable for local dev, called out in README.
 */
const SESSION_SECRET = process.env.FOTA_ADMIN_SESSION_SECRET ?? randomBytes(32).toString('hex');
const SESSION_COOKIE = 'fota_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sign(value: string): string {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

export function createSessionCookieValue(email: string): string {
  // JSON-encoded rather than a naive "email.expiresAt" join - an email
  // address itself contains dots, which would otherwise corrupt a
  // delimiter-based split on decode.
  const payload = JSON.stringify({ email, expiresAt: Date.now() + SESSION_TTL_MS });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

function verifySessionCookieValue(cookieValue: string): string | null {
  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const payloadB64 = cookieValue.slice(0, dotIndex);
  const signature = cookieValue.slice(dotIndex + 1);
  if (!payloadB64 || !signature) return null;

  const expected = sign(payloadB64);
  const sigBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const { email, expiresAt } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      email?: string;
      expiresAt?: number;
    };
    if (!email || !Number.isFinite(expiresAt) || Date.now() > expiresAt!) return null;
    return email;
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function getSessionEmail(req: FastifyRequest): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  return verifySessionCookieValue(raw);
}

export function setSessionCookie(reply: FastifyReply, email: string): void {
  const value = createSessionCookieValue(email);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** preHandler for JSON admin/api/* routes: 401 JSON if not signed in. */
export function requireAdminSession(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const email = getSessionEmail(req);
  if (!email) {
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Not signed in.' });
    return;
  }
  req.adminEmail = email;
  done();
}

declare module 'fastify' {
  interface FastifyRequest {
    adminEmail?: string;
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function findAdminByEmail(email: string): AdminRow | undefined {
  return db.prepare('SELECT * FROM admins WHERE email = ?').get(email.trim().toLowerCase()) as
    | AdminRow
    | undefined;
}

/**
 * Upserts admins from FOTA_ADMIN_CREDENTIALS ("email1:pass1,email2:pass2")
 * on every boot. Re-hashes and overwrites the password each time, so
 * changing the env var and restarting the process is how a password gets
 * changed for this MVP - there is no in-app "change password" flow.
 */
export function bootstrapAdmins(): void {
  const raw = process.env.FOTA_ADMIN_CREDENTIALS;
  if (!raw) {
    console.warn(
      'FOTA_ADMIN_CREDENTIALS is not set - no admin can log in. Format: "email1:pass1,email2:pass2".',
    );
    return;
  }
  for (const pair of raw.split(',')) {
    const [emailRaw, password] = pair.split(':');
    const email = emailRaw?.trim().toLowerCase();
    if (!email || !password) continue;
    const passwordHash = hashPassword(password);
    db.prepare(
      `INSERT INTO admins (email, password_hash) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`,
    ).run(email, passwordHash);
  }
}
