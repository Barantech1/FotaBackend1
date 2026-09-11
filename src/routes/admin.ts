import { createHash, randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { db, type FirmwareRow } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIRMWARE_DIR = path.join(__dirname, '..', '..', 'firmware-storage');

/**
 * Admin/provisioning routes (Implementation Plan v0.2, Section 7). Not
 * authenticated by design for this local-only MVP - "admin" here means
 * "operated by Ariel directly on his own PC", not a role distinct from
 * end-user auth. No production hardening is implied or intended.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await mkdir(FIRMWARE_DIR, { recursive: true });

  // Provisions a dev-only identity: maps an email to an opaque bearer
  // token the mobile app then sends as Authorization: Bearer <token>.
  // Exists because the four endpoints in the approved plan presuppose
  // *some* way to obtain a token in the first place; not itself one of
  // the four, but required for them to be usable at all.
  app.post('/admin/users', async (req, reply) => {
    const body = req.body as { email?: string } | undefined;
    const email = body?.email?.trim().toLowerCase();
    if (!email) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'email is required.' });
    }
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
  app.post('/admin/firmware', async (req, reply) => {
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
  app.post('/admin/assignments', async (req, reply) => {
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
}
