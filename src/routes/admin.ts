import { createHash, randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, type FirmwareRow, type TenantRow } from '../db.js';
import {
  bootstrapAdmins,
  changeAdminPassword,
  clearSessionCookie,
  findAdminByEmail,
  getSessionEmail,
  requireAdminSession,
  setSessionCookie,
  validateNewAdminPassword,
  verifyAdminLogin,
  verifyPassword,
} from '../adminAuth.js';
import { requireCognitoIdentity } from '../cognitoAuth.js';
import { createLoginRateLimiter } from '../loginRateLimit.js';

const LOGIN_FAILED_MESSAGE = 'Invalid email or password.';

// TEMPORARY diagnostic, to be removed once the client IP source on Railway
// is confirmed: the raw forwarding headers of a failed login, for the
// server log only. Only headers that carry client/proxy addresses are
// included (no cookies or auth), plus the socket's peer address.
const FORWARDING_HEADER = /forward|real-ip|client-ip|connecting-ip|true-client|envoy|^via$/i;
function forwardingHeaders(req: FastifyRequest): string {
  const found = Object.entries(req.headers)
    .filter(([name]) => FORWARDING_HEADER.test(name))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  return [`peer=${req.socket.remoteAddress}`, ...found].join(' ');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mirrors db.ts's FOTA_DATA_DIR override pattern - unset locally, so this
// resolves exactly as before; set on Railway to point at a mounted Volume
// so uploaded firmware survives a redeploy.
const FIRMWARE_DIR =
  process.env.FOTA_FIRMWARE_DIR ?? path.join(__dirname, '..', '..', 'firmware-storage');

/**
 * Admin/provisioning routes (Implementation Plan v0.2, Section 7).
 * POST /admin/users stays unauthenticated - it's called transparently by
 * the mobile app itself (via FotaAutoCheck), not by a human admin, so it
 * can't require an admin session. Every other /admin/* route below now
 * requires the cookie session set by POST /admin/api/login.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await mkdir(FIRMWARE_DIR, { recursive: true });
  bootstrapAdmins();
  const loginLimiter = createLoginRateLimiter({ enforceIpLimit: false });

  app.get('/admin/api/session', async (req, reply) => {
    const email = getSessionEmail(req);
    return reply.send({ signedIn: email != null, email: email ?? null });
  });

  app.post('/admin/api/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string } | undefined;
    const email = body?.email?.trim().toLowerCase();
    const password = body?.password;
    if (!email || !password) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'email and password are required.' });
    }
    // Wrong password, unknown email and a locked account all get the same
    // message; only the status (429 + Retry-After) tells a lockout apart.
    // req.ip is logged here, never sent back.
    const retryAfterMs = loginLimiter.retryAfterMs(email, req.ip);
    if (retryAfterMs > 0) {
      console.log(`[admin login] locked out, status=429 ip=${req.ip} ${forwardingHeaders(req)}`);
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
        .send({ error: 'TOO_MANY_REQUESTS', message: LOGIN_FAILED_MESSAGE });
    }
    const admin = verifyAdminLogin(email, password);
    if (!admin) {
      loginLimiter.recordFailure(email, req.ip);
      console.log(`[admin login] failed, status=401 ip=${req.ip} ${forwardingHeaders(req)}`);
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: LOGIN_FAILED_MESSAGE });
    }
    loginLimiter.recordSuccess(email);
    setSessionCookie(reply, admin.email, admin.session_epoch);
    return reply.send({ email: admin.email });
  });

  app.post('/admin/api/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // POST /admin/api/password - the signed-in admin changes their own
  // password. Requires the current password (a stolen session alone can't
  // lock the owner out). Signs out every other session for this admin and
  // re-issues this one's cookie. The admin is always the session's, never
  // a client-supplied email.
  app.post('/admin/api/password', { preHandler: requireAdminSession }, async (req, reply) => {
    const body = req.body as { currentPassword?: string; newPassword?: string } | undefined;
    const currentPassword = body?.currentPassword;
    const newPassword = body?.newPassword;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
      return reply
        .code(400)
        .send({ error: 'BAD_REQUEST', message: 'Current and new password are required.' });
    }
    const admin = findAdminByEmail(req.adminEmail!);
    if (!admin) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Not signed in.' });
    }
    if (!verifyPassword(currentPassword, admin.password_hash)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'The current password is incorrect.' });
    }
    const policyError = validateNewAdminPassword(newPassword, currentPassword);
    if (policyError) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: policyError });
    }
    const epoch = changeAdminPassword(admin.id, newPassword);
    setSessionCookie(reply, admin.email, epoch);
    return reply.send({ ok: true });
  });

  // Provisions a dev-only identity: maps the caller's VERIFIED Cognito
  // identity to an opaque bearer token the mobile app then sends as
  // Authorization: Bearer <token> to /fota/check and /fota/download.
  // Exists because those two endpoints presuppose *some* way to obtain a
  // token in the first place; not itself one of them, but required for
  // them to be usable at all.
  //
  // Identity comes exclusively from requireCognitoIdentity's verification
  // of the caller's own Cognito ID token (../cognitoAuth.ts) - never from
  // a client-supplied email in the request body. This endpoint has no
  // human-admin session (the mobile app calls it transparently, with no
  // login screen of its own), so a verified Cognito token is the
  // replacement for that missing admin gate, not an optional add-on.
  app.post('/admin/users', { preHandler: requireCognitoIdentity }, async (req, reply) => {
    const email = req.verifiedFotaEmail!;
    const existing = db.prepare('SELECT * FROM dev_users WHERE email = ?').get(email) as
      | { token: string }
      | undefined;
    if (existing) {
      return reply.send({ email, token: existing.token, created: false });
    }
    const token = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO dev_users (email, token) VALUES (?, ?)').run(email, token);
    return reply.code(201).send({ email, token, created: true });
  });

  // POST /admin/firmware - multipart upload. Fields: "version" (text),
  // "file" (the firmware/delta binary). Stores the file under
  // firmware-storage/, records metadata including a server-computed
  // SHA-256 (never trusting a client-supplied checksum).
  app.post('/admin/firmware', { preHandler: requireAdminSession }, async (req, reply) => {
    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'multipart file field "file" is required.' });
    }
    const versionField = data.fields.version as { value?: string } | undefined;
    const version = versionField?.value?.trim();
    if (!version) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'multipart text field "version" is required.' });
    }

    const buffer = await data.toBuffer();
    const checksumSha256 = createHash('sha256').update(buffer).digest('hex');
    const storedFilename = `${Date.now()}-${data.filename}`;
    const filePath = path.join(FIRMWARE_DIR, storedFilename);
    await writeFile(filePath, buffer);

    const result = db
      .prepare(
        `INSERT INTO firmware (filename, version, file_path, file_size_bytes, checksum_sha256, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(data.filename, version, filePath, buffer.length, checksumSha256);

    const firmware = db
      .prepare('SELECT * FROM firmware WHERE id = ?')
      .get(result.lastInsertRowid) as unknown as FirmwareRow;

    return reply.code(201).send({
      id: firmware.id,
      filename: firmware.filename,
      version: firmware.version,
      fileSizeBytes: firmware.file_size_bytes,
      checksumSha256: firmware.checksum_sha256,
      uploadedAt: firmware.uploaded_at,
      isActive: Boolean(firmware.is_active),
    });
  });

  // POST /admin/assignments - assigns an uploaded firmware to a user
  // email. One active assignment per user (Implementation Plan v0.2,
  // Section 7/15) - any prior active assignment for the same email is
  // deactivated, never deleted, so assignment history is preserved.
  app.post('/admin/assignments', { preHandler: requireAdminSession }, async (req, reply) => {
    const body = req.body as { firmwareId?: number; userEmail?: string } | undefined;
    const firmwareId = body?.firmwareId;
    const userEmail = body?.userEmail?.trim().toLowerCase();
    if (!firmwareId || !userEmail) {
      return reply
        .code(400)
        .send({ error: 'BAD_REQUEST', message: 'firmwareId and userEmail are required.' });
    }
    const firmware = db.prepare('SELECT * FROM firmware WHERE id = ?').get(firmwareId) as
      | FirmwareRow
      | undefined;
    if (!firmware) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'No firmware with that id.' });
    }

    // node:sqlite's DatabaseSync has no built-in transaction() helper
    // (unlike better-sqlite3) - explicit BEGIN/COMMIT/ROLLBACK instead.
    // Safe as a single logical unit here regardless: node:sqlite is
    // synchronous and this process is single-threaded, so nothing can
    // interleave between these two statements within one request.
    db.exec('BEGIN');
    let result;
    try {
      db.prepare('UPDATE assignments SET is_active = 0 WHERE user_email = ? AND is_active = 1').run(
        userEmail,
      );
      result = db
        .prepare('INSERT INTO assignments (firmware_id, user_email, is_active) VALUES (?, ?, 1)')
        .run(firmwareId, userEmail);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return reply.code(201).send({
      id: result.lastInsertRowid,
      firmwareId,
      userEmail,
      isActive: true,
    });
  });

  // GET /admin/api/firmware - full firmware list for the "Firmware" tab.
  app.get('/admin/api/firmware', { preHandler: requireAdminSession }, async (_req, reply) => {
    const rows = db
      .prepare('SELECT * FROM firmware ORDER BY uploaded_at DESC')
      .all() as unknown as FirmwareRow[];
    return reply.send(
      rows.map((f) => ({
        id: f.id,
        filename: f.filename,
        version: f.version,
        fileSizeBytes: f.file_size_bytes,
        checksumSha256: f.checksum_sha256,
        uploadedAt: f.uploaded_at,
        isActive: Boolean(f.is_active),
      })),
    );
  });

  // GET /admin/api/assignments - active assignments only, joined with
  // firmware so the UI can show version/filename without a second call.
  // Superseded assignments are intentionally omitted here (history is
  // still preserved in the table itself, just not surfaced in this list).
  app.get('/admin/api/assignments', { preHandler: requireAdminSession }, async (_req, reply) => {
    const rows = db
      .prepare(
        `SELECT a.id AS assignment_id, a.user_email, a.assigned_at, f.id AS firmware_id, f.version, f.filename
         FROM assignments a
         JOIN firmware f ON f.id = a.firmware_id
         WHERE a.is_active = 1
         ORDER BY a.assigned_at DESC`,
      )
      .all() as Array<{
      assignment_id: number;
      user_email: string;
      assigned_at: string;
      firmware_id: number;
      version: string;
      filename: string;
    }>;
    return reply.send(
      rows.map((r) => ({
        assignmentId: r.assignment_id,
        userEmail: r.user_email,
        assignedAt: r.assigned_at,
        firmwareId: r.firmware_id,
        firmwareVersion: r.version,
        firmwareFilename: r.filename,
      })),
    );
  });

  // GET/POST /admin/api/tenants - admin-curated list of expected end
  // users. Add-only for the MVP (Ariel: "strictly add-only"); emails need
  // not have appeared in the check-in log first (Ariel: "OK to add
  // upfront"), but ARE cross-referenced against it client-side so the
  // admin can double-check a real check-in exists before adding.
  app.get('/admin/api/tenants', { preHandler: requireAdminSession }, async (_req, reply) => {
    const rows = db
      .prepare('SELECT * FROM tenants ORDER BY added_at DESC')
      .all() as unknown as TenantRow[];
    return reply.send(rows.map((t) => ({ email: t.email, addedAt: t.added_at })));
  });

  app.post('/admin/api/tenants', { preHandler: requireAdminSession }, async (req, reply) => {
    const body = req.body as { email?: string } | undefined;
    const email = body?.email?.trim().toLowerCase();
    if (!email) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'email is required.' });
    }
    const existing = db.prepare('SELECT * FROM tenants WHERE email = ?').get(email);
    if (existing) {
      return reply.code(409).send({ error: 'CONFLICT', message: 'That tenant already exists.' });
    }
    db.prepare('INSERT INTO tenants (email) VALUES (?)').run(email);
    return reply.code(201).send({ email });
  });

  // GET /admin/api/admins - read-only list of who else can sign in.
  app.get('/admin/api/admins', { preHandler: requireAdminSession }, async (_req, reply) => {
    const rows = db.prepare('SELECT email FROM admins ORDER BY email ASC').all() as Array<{
      email: string;
    }>;
    return reply.send(rows.map((r) => r.email));
  });

  // GET /admin/api/activity - the "User Activity" log (formerly "Dev
  // Users"): one row per GET /fota/check call, sortable by email or time.
  // "downloaded" is real (joined against the downloads table - true if
  // this user had already downloaded that checkin's firmware by the time
  // of this check-in, so once true it stays true for every later
  // check-in too - a timeline, not a one-shot flag).
  // "writtenToLock" has NO real signal yet and is always null/unknown -
  // the mobile app never reports an NFC write outcome back to this
  // backend today. Surfaced honestly as "unknown" rather than guessed.
  app.get('/admin/api/activity', { preHandler: requireAdminSession }, async (req, reply) => {
    const query = req.query as { sortKey?: string; sortDir?: string };
    const sortKey = query.sortKey === 'email' ? 'user_email' : 'checked_in_at';
    const sortDir = query.sortDir === 'asc' ? 'ASC' : 'DESC';

    const rows = db
      .prepare(
        `SELECT c.id, c.user_email, c.checked_in_at, c.update_available, c.firmware_id,
                EXISTS(
                  SELECT 1 FROM downloads d
                  WHERE d.user_email = c.user_email
                    AND d.firmware_id = c.firmware_id
                    AND d.downloaded_at <= c.checked_in_at
                ) AS downloaded
         FROM checkins c
         ORDER BY ${sortKey} ${sortDir}`,
      )
      .all() as Array<{
      id: number;
      user_email: string;
      checked_in_at: string;
      update_available: number;
      firmware_id: number | null;
      downloaded: number;
    }>;

    return reply.send(
      rows.map((r) => ({
        email: r.user_email,
        checkedInAt: r.checked_in_at,
        updateWasAvailable: Boolean(r.update_available),
        downloaded: r.update_available ? Boolean(r.downloaded) : null,
        writtenToLock: null,
      })),
    );
  });
}
