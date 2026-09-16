import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { db, type AssignmentRow, type FirmwareRow } from '../db.js';
import { requireAuth } from '../auth.js';

interface ActiveAssignmentJoin extends FirmwareRow {
  assignment_id: number;
  assigned_at: string;
}

function getActiveAssignment(email: string): ActiveAssignmentJoin | undefined {
  return db
    .prepare(
      `SELECT f.*, a.id AS assignment_id, a.assigned_at AS assigned_at
       FROM assignments a
       JOIN firmware f ON f.id = a.firmware_id
       WHERE a.user_email = ? AND a.is_active = 1
       ORDER BY a.assigned_at DESC
       LIMIT 1`,
    )
    .get(email) as ActiveAssignmentJoin | undefined;
}

/**
 * End-user routes. Both are authenticated, and both derive the caller's
 * identity exclusively from the bearer token (src/auth.ts) - neither ever
 * reads an email from a query/body parameter to decide whose firmware to
 * return. This is the hard invariant from Implementation Plan v0.2,
 * Section 10/16, and the single most important thing these two routes get
 * right or wrong.
 */
export async function fotaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fota/check', { preHandler: requireAuth }, async (req, reply) => {
    const email = req.authenticatedEmail!;
    const assignment = getActiveAssignment(email);

    // Logged unconditionally (update available or not) - this is what the
    // admin UI's "User Activity" log is built from, and "checked in, no
    // update pending" is itself a meaningful activity row.
    db.prepare(
      "INSERT INTO checkins (user_email, checked_in_at, update_available, firmware_id) VALUES (?, strftime('%Y-%m-%d %H:%M:%f', 'now'), ?, ?)",
    ).run(email, assignment ? 1 : 0, assignment?.id ?? null);

    if (!assignment) {
      return reply.send({ updateAvailable: false });
    }
    return reply.send({
      updateAvailable: true,
      firmware: {
        id: assignment.id,
        version: assignment.version,
        filename: assignment.filename,
        fileSizeBytes: assignment.file_size_bytes,
        checksumSha256: assignment.checksum_sha256,
        assignedAt: assignment.assigned_at,
      },
    });
  });

  app.get('/fota/download/:firmwareId', { preHandler: requireAuth }, async (req, reply) => {
    const email = req.authenticatedEmail!;
    const { firmwareId } = req.params as { firmwareId: string };

    // The caller may only ever download the firmware CURRENTLY actively
    // assigned to them - never an arbitrary firmwareId, even if it once
    // was assigned to them and has since been superseded, and never
    // another user's assignment regardless of what id is requested.
    const assignment = getActiveAssignment(email);
    if (!assignment || String(assignment.id) !== firmwareId) {
      return reply
        .code(403)
        .send({ error: 'FORBIDDEN', message: 'That firmware is not assigned to you.' });
    }

    const fileStat = await stat(assignment.file_path).catch(() => null);
    if (!fileStat) {
      return reply
        .code(500)
        .send({ error: 'STORAGE_ERROR', message: 'Assigned firmware file is missing on disk.' });
    }

    // Recorded on successful download only (after the assignment/ownership
    // checks above and the file-exists check below) - this is the
    // backend's only real signal for the "Downloaded" column in the admin
    // UI. There is no equivalent signal for "written to the lock": that
    // event happens entirely on the phone via NFC and is never reported
    // back to this backend today (see routes/admin.ts activity endpoint).
    db.prepare(
      "INSERT INTO downloads (user_email, firmware_id, downloaded_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))",
    ).run(email, assignment.id);

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${assignment.filename}"`);
    reply.header('Content-Length', fileStat.size);
    reply.header('X-Firmware-Checksum-Sha256', assignment.checksum_sha256);
    return reply.send(createReadStream(assignment.file_path));
  });
}
