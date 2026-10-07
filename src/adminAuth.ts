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

export function createSessionCookieValue(email: string, epoch: number): string {
  // JSON-encoded rather than a naive "email.expiresAt" join - an email
  // address itself contains dots, which would otherwise corrupt a
  // delimiter-based split on decode.
  const payload = JSON.stringify({ email, epoch, expiresAt: Date.now() + SESSION_TTL_MS });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

function verifySessionCookieValue(cookieValue: string): { email: string; epoch: number } | null {
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
    const { email, epoch, expiresAt } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      email?: string;
      epoch?: number;
      expiresAt?: number;
    };
    if (!email || !Number.isFinite(expiresAt) || Date.now() > expiresAt!) return null;
    // Cookies issued before session epochs existed carry none: epoch 0.
    return { email, epoch: Number.isInteger(epoch) ? epoch! : 0 };
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

/**
 * The signed-in admin's email, or null. Besides the signature and expiry,
 * the admin must still exist and the cookie's epoch must match the admin's
 * current session_epoch - so a password change (which bumps the epoch)
 * signs out every session issued before it.
 */
export function getSessionEmail(req: FastifyRequest): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const session = verifySessionCookieValue(raw);
  if (!session) return null;
  const admin = findAdminByEmail(session.email);
  if (!admin || admin.session_epoch !== session.epoch) return null;
  return admin.email;
}

export function setSessionCookie(reply: FastifyReply, email: string, epoch: number): void {
  const value = createSessionCookieValue(email, epoch);
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

// A real hash of a random password, verified against when the email is
// unknown, so a login for an unknown email costs the same scrypt work as a
// wrong password and response timing doesn't reveal which emails are admins.
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString('hex'));

/** The admin for these credentials, or null - same work either way. */
export function verifyAdminLogin(email: string, password: string): AdminRow | null {
  const admin = findAdminByEmail(email);
  const valid = verifyPassword(password, admin?.password_hash ?? DUMMY_PASSWORD_HASH);
  return admin && valid ? admin : null;
}

export function findAdminByEmail(email: string): AdminRow | undefined {
  return db.prepare('SELECT * FROM admins WHERE email = ?').get(email.trim().toLowerCase()) as
    | AdminRow
    | undefined;
}

/**
 * Creates/updates admins from FOTA_ADMIN_CREDENTIALS
 * ("email1:pass1,email2:pass2") on every boot. The env password is applied
 * only when it differs from the one last applied (admins.env_password_hash),
 * so a password changed in the admin UI survives restarts and redeploys,
 * while setting a NEW value in the env var still works as a reset (for a
 * forgotten password). A reset also bumps session_epoch, signing everyone
 * out. Env passwords can't contain "," or ":" (the separators above).
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
    const existing = findAdminByEmail(email);
    if (!existing) {
      const passwordHash = hashPassword(password);
      db.prepare(
        'INSERT INTO admins (email, password_hash, env_password_hash) VALUES (?, ?, ?)',
      ).run(email, passwordHash, hashPassword(password));
    } else if (existing.env_password_hash === null) {
      // Row from before env_password_hash existed: its password always came
      // from the env var (re-applied on every boot), so re-apply it once and
      // record the fingerprint. Same password, so sessions stay valid.
      db.prepare('UPDATE admins SET password_hash = ?, env_password_hash = ? WHERE id = ?').run(
        hashPassword(password),
        hashPassword(password),
        existing.id,
      );
    } else if (!verifyPassword(password, existing.env_password_hash)) {
      db.prepare(
        `UPDATE admins SET password_hash = ?, env_password_hash = ?, session_epoch = session_epoch + 1
         WHERE id = ?`,
      ).run(hashPassword(password), hashPassword(password), existing.id);
      console.log(`[admin bootstrap] password reset from FOTA_ADMIN_CREDENTIALS for ${email}`);
    }
  }
}

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 128;

/**
 * Policy for a password set through the admin UI: length over composition
 * rules (a long password-manager password or a passphrase of several random
 * words is what's recommended). Returns an error message, or null if valid.
 */
export function validateNewAdminPassword(newPassword: string, currentPassword: string): string | null {
  const length = [...newPassword].length;
  if (length < ADMIN_PASSWORD_MIN_LENGTH) {
    return `The new password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (length > ADMIN_PASSWORD_MAX_LENGTH) {
    return `The new password must be at most ${ADMIN_PASSWORD_MAX_LENGTH} characters long.`;
  }
  if (newPassword.trim() !== newPassword) {
    return 'The new password must not start or end with a space.';
  }
  if (newPassword === currentPassword) {
    return 'The new password must be different from the current one.';
  }
  return null;
}

/** Sets a new password and bumps session_epoch; returns the new epoch. */
export function changeAdminPassword(adminId: number, newPassword: string): number {
  db.prepare('UPDATE admins SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(
    hashPassword(newPassword),
    adminId,
  );
  const row = db.prepare('SELECT session_epoch FROM admins WHERE id = ?').get(adminId) as { session_epoch: number };
  return row.session_epoch;
}
