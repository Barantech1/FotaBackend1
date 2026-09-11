import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Point at a fresh, disposable SQLite file per test run BEFORE importing
// anything that touches the db module (module-level side effects run on
// first import).
const testDataDir = mkdtempSync(path.join(tmpdir(), 'fota-backend-test-'));
process.env.FOTA_DATA_DIR = testDataDir;

const { buildServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');

function resetDb() {
  db.exec('DELETE FROM assignments; DELETE FROM firmware; DELETE FROM dev_users;');
}

async function createUser(app: Awaited<ReturnType<typeof buildServer>>, email: string) {
  const res = await app.inject({ method: 'POST', url: '/admin/users', payload: { email } });
  return res.json().token as string;
}

async function uploadFirmware(
  app: Awaited<ReturnType<typeof buildServer>>,
  version: string,
  content: string,
) {
  const boundary = '----testboundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="version"\r\n\r\n${version}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="fw.delta"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n` +
    `--${boundary}--\r\n`;
  const res = await app.inject({
    method: 'POST',
    url: '/admin/firmware',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  return res.json();
}

describe('FOTA backend', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    resetDb();
    app = buildServer();
    await app.ready();
  });

  afterAll(() => {
    db.close(); // Windows holds the SQLite/WAL file open until this runs, blocking the rmSync below
    rmSync(testDataDir, { recursive: true, force: true });
  });

  it('provisions a dev user and returns a stable token on repeat calls', async () => {
    const token1 = await createUser(app, 'alice@example.com');
    const token2 = await createUser(app, 'alice@example.com');
    expect(token1).toBe(token2);
    expect(token1.length).toBeGreaterThan(20);
  });

  it('uploads firmware and records a server-computed SHA-256 checksum', async () => {
    const content = 'fake-delta-bytes';
    const expectedHash = createHash('sha256').update(content).digest('hex');
    const fw = await uploadFirmware(app, '1.0.0', content);
    expect(fw.version).toBe('1.0.0');
    expect(fw.checksumSha256).toBe(expectedHash);
    expect(fw.fileSizeBytes).toBe(content.length);
  });

  it('GET /fota/check reports no update when nothing is assigned', async () => {
    const token = await createUser(app, 'bob@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/fota/check',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()).toEqual({ updateAvailable: false });
  });

  it('assigns firmware to a user and GET /fota/check reports it', async () => {
    const token = await createUser(app, 'carol@example.com');
    const fw = await uploadFirmware(app, '2.0.0', 'patch-bytes');
    await app.inject({
      method: 'POST',
      url: '/admin/assignments',
      payload: { firmwareId: fw.id, userEmail: 'carol@example.com' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/fota/check',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    expect(body.updateAvailable).toBe(true);
    expect(body.firmware.version).toBe('2.0.0');
  });

  it('IDENTITY INVARIANT: a caller cannot obtain another user\'s assigned firmware by any means - only their own token\'s assignment is ever visible or downloadable', async () => {
    const tokenA = await createUser(app, 'dave@example.com');
    await createUser(app, 'erin@example.com');
    const fw = await uploadFirmware(app, '3.0.0', 'daves-patch');
    await app.inject({
      method: 'POST',
      url: '/admin/assignments',
      payload: { firmwareId: fw.id, userEmail: 'dave@example.com' },
    });

    // erin's own token must never see dave's assignment, regardless of
    // what firmwareId or email she might try to reference.
    const erinCheck = await app.inject({
      method: 'GET',
      url: '/fota/check',
      headers: { authorization: `Bearer ${await createUser(app, 'erin@example.com')}` },
    });
    expect(erinCheck.json()).toEqual({ updateAvailable: false });

    // A request with NO token at all must be rejected outright - there is
    // no path by which an unauthenticated caller can specify "give me
    // dave's firmware".
    const noAuth = await app.inject({ method: 'GET', url: '/fota/check' });
    expect(noAuth.statusCode).toBe(401);

    // The download endpoint enforces the same rule even when the correct
    // firmwareId is guessed: dave's own token may download it...
    const daveDownload = await app.inject({
      method: 'GET',
      url: `/fota/download/${fw.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(daveDownload.statusCode).toBe(200);
    expect(daveDownload.body).toBe('daves-patch');

    // ...but erin's token, even knowing dave's real firmwareId, may not.
    const erinDownload = await app.inject({
      method: 'GET',
      url: `/fota/download/${fw.id}`,
      headers: { authorization: `Bearer ${await createUser(app, 'erin2@example.com')}` },
    });
    expect(erinDownload.statusCode).toBe(403);
  });

  it('one active assignment per user: assigning a new firmware supersedes the previous one, never deletes history', async () => {
    const token = await createUser(app, 'frank@example.com');
    const fwOld = await uploadFirmware(app, '1.0.0', 'old');
    const fwNew = await uploadFirmware(app, '1.1.0', 'new');

    await app.inject({
      method: 'POST',
      url: '/admin/assignments',
      payload: { firmwareId: fwOld.id, userEmail: 'frank@example.com' },
    });
    await app.inject({
      method: 'POST',
      url: '/admin/assignments',
      payload: { firmwareId: fwNew.id, userEmail: 'frank@example.com' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/fota/check',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().firmware.version).toBe('1.1.0');

    const allAssignments = db
      .prepare('SELECT * FROM assignments WHERE user_email = ?')
      .all('frank@example.com') as Array<{ is_active: number; firmware_id: number }>;
    expect(allAssignments).toHaveLength(2); // history preserved, not deleted
    expect(allAssignments.filter((a) => a.is_active === 1)).toHaveLength(1); // exactly one active
  });

  it('downloading firmware not assigned to the caller is forbidden even with a valid token', async () => {
    const fw = await uploadFirmware(app, '1.0.0', 'x');
    const token = await createUser(app, 'grace@example.com'); // no assignment at all
    const res = await app.inject({
      method: 'GET',
      url: `/fota/download/${fw.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/fota/check',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
