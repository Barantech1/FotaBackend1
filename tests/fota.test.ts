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
process.env.FOTA_ADMIN_CREDENTIALS = 'admin@example.com:test-password';

const { buildServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');

function resetDb() {
  // checkins/downloads reference firmware(id) - must be cleared before
  // firmware itself, or foreign_keys=ON rejects the delete.
  db.exec(
    'DELETE FROM checkins; DELETE FROM downloads; DELETE FROM assignments; DELETE FROM firmware; DELETE FROM dev_users; DELETE FROM tenants;',
  );
}

async function createUser(app: Awaited<ReturnType<typeof buildServer>>, email: string) {
  const res = await app.inject({ method: 'POST', url: '/admin/users', payload: { email } });
  return res.json().token as string;
}

// The admin session cookie for /admin/firmware and /admin/assignments -
// both now require an admin to be signed in (src/adminAuth.ts).
async function adminCookie(app: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/api/login',
    payload: { email: 'admin@example.com', password: 'test-password' },
  });
  const setCookie = res.headers['set-cookie'] as string;
  return setCookie.split(';')[0];
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
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: await adminCookie(app),
    },
    payload: body,
  });
  return res.json();
}

async function assignFirmware(
  app: Awaited<ReturnType<typeof buildServer>>,
  firmwareId: number,
  userEmail: string,
) {
  return app.inject({
    method: 'POST',
    url: '/admin/assignments',
    headers: { cookie: await adminCookie(app) },
    payload: { firmwareId, userEmail },
  });
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
    await assignFirmware(app, fw.id, 'carol@example.com');

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
    await assignFirmware(app, fw.id, 'dave@example.com');

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

    await assignFirmware(app, fwOld.id, 'frank@example.com');
    await assignFirmware(app, fwNew.id, 'frank@example.com');

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

  describe('admin UI', () => {
    it('rejects admin API/write routes without a session, and rejects a wrong password', async () => {
      const noSession = await app.inject({ method: 'GET', url: '/admin/api/firmware' });
      expect(noSession.statusCode).toBe(401);

      const wrongPassword = await app.inject({
        method: 'POST',
        url: '/admin/api/login',
        payload: { email: 'admin@example.com', password: 'not-the-password' },
      });
      expect(wrongPassword.statusCode).toBe(401);
    });

    it('logs in, reads a signed session back, and logs out', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/admin/api/login',
        payload: { email: 'admin@example.com', password: 'test-password' },
      });
      expect(login.statusCode).toBe(200);
      const cookie = (login.headers['set-cookie'] as string).split(';')[0];

      const session = await app.inject({
        method: 'GET',
        url: '/admin/api/session',
        headers: { cookie },
      });
      expect(session.json()).toEqual({ signedIn: true, email: 'admin@example.com' });

      const logout = await app.inject({
        method: 'POST',
        url: '/admin/api/logout',
        headers: { cookie },
      });
      expect(logout.statusCode).toBe(200);

      const sessionCookie = (logout.headers['set-cookie'] as string).split(';')[0];
      const afterLogout = await app.inject({
        method: 'GET',
        url: '/admin/api/session',
        headers: { cookie: sessionCookie },
      });
      expect(afterLogout.json().signedIn).toBe(false);
    });

    it('tenants are add-only and reject a duplicate email', async () => {
      const cookie = await adminCookie(app);
      const first = await app.inject({
        method: 'POST',
        url: '/admin/api/tenants',
        headers: { cookie },
        payload: { email: 'dana@example.com' },
      });
      expect(first.statusCode).toBe(201);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/admin/api/tenants',
        headers: { cookie },
        payload: { email: 'dana@example.com' },
      });
      expect(duplicate.statusCode).toBe(409);

      const list = await app.inject({ method: 'GET', url: '/admin/api/tenants', headers: { cookie } });
      expect(list.json()).toHaveLength(1);
    });

    it('records a User Activity check-in on every /fota/check call, and marks "downloaded" only after a real download', async () => {
      const token = await createUser(app, 'heidi@example.com');
      const fw = await uploadFirmware(app, '1.0.0', 'heidis-patch');
      await assignFirmware(app, fw.id, 'heidi@example.com');

      await app.inject({
        method: 'GET',
        url: '/fota/check',
        headers: { authorization: `Bearer ${token}` },
      });

      const cookie = await adminCookie(app);
      const beforeDownload = await app.inject({
        method: 'GET',
        url: '/admin/api/activity',
        headers: { cookie },
      });
      const rowsBefore = beforeDownload.json();
      expect(rowsBefore).toHaveLength(1);
      expect(rowsBefore[0]).toMatchObject({
        email: 'heidi@example.com',
        updateWasAvailable: true,
        downloaded: false,
        writtenToLock: null,
      });

      await app.inject({
        method: 'GET',
        url: `/fota/download/${fw.id}`,
        headers: { authorization: `Bearer ${token}` },
      });

      await app.inject({
        method: 'GET',
        url: '/fota/check',
        headers: { authorization: `Bearer ${token}` },
      });

      const afterDownload = await app.inject({
        method: 'GET',
        url: '/admin/api/activity?sortKey=time&sortDir=asc',
        headers: { cookie },
      });
      const rowsAfter = afterDownload.json() as Array<{ downloaded: boolean | null }>;
      expect(rowsAfter).toHaveLength(2);
      // "Downloaded" reflects status AS OF that check-in: the first
      // check-in happened before the download and stays "not yet"
      // forever (historical record); the second happened after the
      // download and sees it as already done.
      expect(rowsAfter[0].downloaded).toBe(false);
      expect(rowsAfter[1].downloaded).toBe(true);
    });
  });
});
