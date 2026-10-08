import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';

// Point at a fresh, disposable SQLite file per test run BEFORE importing
// anything that touches the db module (module-level side effects run on
// first import).
const testDataDir = mkdtempSync(path.join(tmpdir(), 'fota-backend-test-'));
process.env.FOTA_DATA_DIR = testDataDir;
process.env.FOTA_ADMIN_CREDENTIALS = 'admin@example.com:test-password';

// Fake but syntactically-valid Cognito identifiers (aws-jwt-verify's
// CognitoJwtVerifier.parseUserPoolId requires the real <region>_<id>
// shape) - never contacts real Cognito; see cacheJwks() below.
const TEST_USER_POOL_ID = 'us-east-1_TESTPOOL1';
const TEST_CLIENT_ID = 'test-client-id-123';
const TEST_ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${TEST_USER_POOL_ID}`;
const TEST_KID = 'test-signing-key-1';
process.env.FOTA_COGNITO_USER_POOL_ID = TEST_USER_POOL_ID;
process.env.FOTA_COGNITO_CLIENT_ID = TEST_CLIENT_ID;

const { buildServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { getCognitoVerifierForTesting } = await import('../src/cognitoAuth.js');

// Self-generated RSA keypair, cached directly into the verifier via
// cacheJwks() below - this exercises aws-jwt-verify's REAL signature,
// issuer, audience, and token_use verification end to end, against a
// locally-signed token, with no network call to the real Cognito JWKS
// endpoint.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
getCognitoVerifierForTesting().cacheJwks({
  keys: [{ ...(publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string }), kid: TEST_KID, alg: 'RS256', use: 'sig' }],
});

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signTestIdToken(
  claims: Record<string, unknown>,
  options?: { key?: KeyObject; kid?: string },
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: options?.kid ?? TEST_KID };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: TEST_ISSUER,
    aud: TEST_CLIENT_ID,
    token_use: 'id',
    sub: 'test-sub-0000',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    ...claims,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), options?.key ?? privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function resetDb() {
  // checkins/downloads reference firmware(id) - must be cleared before
  // firmware itself, or foreign_keys=ON rejects the delete.
  db.exec(
    'DELETE FROM checkins; DELETE FROM downloads; DELETE FROM assignments; DELETE FROM firmware; DELETE FROM dev_users; DELETE FROM tenants; DELETE FROM admins;',
  );
}

async function createUser(app: Awaited<ReturnType<typeof buildServer>>, email: string) {
  const idToken = signTestIdToken({ email });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/users',
    headers: { authorization: `Bearer ${idToken}` },
  });
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

    describe('login rate limiting', () => {
      const FIFTEEN_MINUTES = 15 * 60 * 1000;

      // Mirrors Railway's live layout (src/proxyLayout.ts): X-Forwarded-For
      // arrives as "client, edge" from an internal proxy (the socket peer).
      function attempt(email: string, password: string, opts: { client?: string; forwardedFor?: string } = {}) {
        return app.inject({
          method: 'POST',
          url: '/admin/api/login',
          remoteAddress: '100.64.0.2',
          headers: { 'x-forwarded-for': opts.forwardedFor ?? `${opts.client ?? '198.51.100.1'}, 152.233.12.245` },
          payload: { email, password },
        });
      }

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('locks an account after 5 failures, with the same message for wrong, unknown and locked', async () => {
        for (const email of ['admin@example.com', 'nobody@example.com']) {
          for (let i = 0; i < 5; i++) {
            const res = await attempt(email, 'wrong-password');
            expect(res.statusCode).toBe(401);
            expect(res.json().message).toBe('Invalid email or password.');
          }
          const locked = await attempt(email, 'wrong-password');
          expect(locked.statusCode).toBe(429);
          expect(locked.json().message).toBe('Invalid email or password.');
          expect(Number(locked.headers['retry-after'])).toBe(15 * 60);
        }
        // While locked, even the right password is refused, without a cookie.
        const rightPassword = await attempt('admin@example.com', 'test-password');
        expect(rightPassword.statusCode).toBe(429);
        expect(rightPassword.headers['set-cookie']).toBeUndefined();
        // The lockout is per account: other accounts are unaffected.
        expect((await attempt('other@example.com', 'wrong-password')).statusCode).toBe(401);
      });

      it('normalizes the email, so case and spaces do not get around a lockout', async () => {
        for (const email of ['Admin@Example.com', ' admin@example.com', 'ADMIN@EXAMPLE.COM', 'admin@example.com ', 'admin@Example.COM']) {
          expect((await attempt(email, 'wrong-password')).statusCode).toBe(401);
        }
        expect((await attempt('admin@example.com', 'test-password')).statusCode).toBe(429);
      });

      it('lifts the lockout after 15 minutes', async () => {
        for (let i = 0; i < 5; i++) await attempt('admin@example.com', 'wrong-password');
        vi.setSystemTime(Date.now() + FIFTEEN_MINUTES - 1000);
        expect((await attempt('admin@example.com', 'test-password')).statusCode).toBe(429);
        vi.setSystemTime(Date.now() + 1000);
        expect((await attempt('admin@example.com', 'test-password')).statusCode).toBe(200);
      });

      it('only counts failures within 15 minutes, and a success clears them', async () => {
        for (let i = 0; i < 4; i++) await attempt('admin@example.com', 'wrong-password');
        vi.setSystemTime(Date.now() + FIFTEEN_MINUTES);
        expect((await attempt('admin@example.com', 'wrong-password')).statusCode).toBe(401);
        expect((await attempt('admin@example.com', 'test-password')).statusCode).toBe(200);

        for (let i = 0; i < 4; i++) {
          expect((await attempt('admin@example.com', 'wrong-password')).statusCode).toBe(401);
        }
        expect((await attempt('admin@example.com', 'test-password')).statusCode).toBe(200);
      });

      it('takes the client from "client, edge" plus a socket peer (the live Railway layout)', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          await attempt('nobody@example.com', 'wrong-password', { forwardedFor: '62.90.131.230, 152.233.12.245' });
          expect(log).toHaveBeenCalledWith('[admin login] failed, status=401 ip=62.90.131.230');
        } finally {
          log.mockRestore();
        }
      });

      it('caps failures per client IP at 100 per 15 minutes, ignoring forged X-Forwarded-For entries', async () => {
        // 25 emails x 4 failures: 100 failures from one client, no account
        // locked, arriving through varying Railway edges as on the live site.
        for (let n = 0; n < 25; n++) {
          for (let i = 0; i < 4; i++) {
            const res = await attempt(`user${n}@example.com`, 'wrong-password', {
              forwardedFor: `203.0.113.7, 152.233.13.${164 + (i % 3)}`,
            });
            expect(res.statusCode).toBe(401);
          }
        }
        const blocked = await attempt('admin@example.com', 'test-password', { client: '203.0.113.7' });
        expect(blocked.statusCode).toBe(429);
        expect(blocked.json().message).toBe('Invalid email or password.');
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

        // A forged entry in front doesn't get the blocked client out...
        const forgedOut = await attempt('admin@example.com', 'test-password', {
          forwardedFor: '192.0.2.99, 203.0.113.7, 152.233.12.245',
        });
        expect(forgedOut.statusCode).toBe(429);
        // ...and naming the blocked IP doesn't get another client blocked.
        const forgedIn = await attempt('admin@example.com', 'test-password', {
          forwardedFor: '203.0.113.7, 198.51.100.2, 152.233.12.245',
        });
        expect(forgedIn.statusCode).toBe(200);
        expect((await attempt('admin@example.com', 'test-password', { client: '198.51.100.3' })).statusCode).toBe(200);

        vi.setSystemTime(Date.now() + FIFTEEN_MINUTES);
        expect((await attempt('admin@example.com', 'test-password', { client: '203.0.113.7' })).statusCode).toBe(200);
      }, 30_000);

      it('warns, with the count only, when X-Forwarded-For does not have 2 entries', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          await attempt('nobody@example.com', 'wrong-password', { forwardedFor: '62.90.131.230, 152.233.12.245' });
          expect(warn).not.toHaveBeenCalled();

          await attempt('nobody@example.com', 'wrong-password', {
            forwardedFor: '192.0.2.99, 62.90.131.230, 152.233.12.245',
          });
          await attempt('nobody@example.com', 'wrong-password', { forwardedFor: '62.90.131.230' });
          expect(warn.mock.calls.map((call) => call[0])).toEqual([
            '[proxy layout] X-Forwarded-For has 3 entries, expected 2; req.ip may not be the client',
            '[proxy layout] X-Forwarded-For has 1 entries, expected 2; req.ip may not be the client',
          ]);
        } finally {
          warn.mockRestore();
        }
      });
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

    describe('change password', () => {
      const NEW_PASSWORD = 'correct horse battery staple';

      async function login(server: typeof app, password: string) {
        return server.inject({
          method: 'POST',
          url: '/admin/api/login',
          payload: { email: 'admin@example.com', password },
        });
      }
      async function isSignedIn(server: typeof app, cookie: string) {
        const res = await server.inject({ method: 'GET', url: '/admin/api/session', headers: { cookie } });
        return res.json().signedIn as boolean;
      }
      async function changePassword(cookie: string, currentPassword: string, newPassword: string) {
        return app.inject({
          method: 'POST',
          url: '/admin/api/password',
          headers: { cookie },
          payload: { currentPassword, newPassword },
        });
      }

      it('changes the password, keeps this session, signs out other sessions', async () => {
        const cookie = await adminCookie(app);
        const otherSession = await adminCookie(app);

        const res = await changePassword(cookie, 'test-password', NEW_PASSWORD);
        expect(res.statusCode).toBe(200);
        const newCookie = (res.headers['set-cookie'] as string).split(';')[0];

        expect(await isSignedIn(app, newCookie)).toBe(true);
        expect(await isSignedIn(app, cookie)).toBe(false);
        expect(await isSignedIn(app, otherSession)).toBe(false);
        expect((await login(app, 'test-password')).statusCode).toBe(401);
        expect((await login(app, NEW_PASSWORD)).statusCode).toBe(200);
      });

      it('rejects no session, a wrong current password, and passwords that break the policy', async () => {
        const noSession = await app.inject({
          method: 'POST',
          url: '/admin/api/password',
          payload: { currentPassword: 'test-password', newPassword: NEW_PASSWORD },
        });
        expect(noSession.statusCode).toBe(401);

        const cookie = await adminCookie(app);
        expect((await changePassword(cookie, 'not-the-password', NEW_PASSWORD)).statusCode).toBe(403);
        expect((await changePassword(cookie, 'test-password', 'short-11ch')).statusCode).toBe(400);
        expect((await changePassword(cookie, 'test-password', 'x'.repeat(129))).statusCode).toBe(400);
        expect((await changePassword(cookie, 'test-password', ' leading-space-pw')).statusCode).toBe(400);
        expect((await changePassword(cookie, 'test-password', 'test-password')).statusCode).toBe(400);

        // Nothing changed: the original password and session still work.
        expect(await isSignedIn(app, cookie)).toBe(true);
        expect((await login(app, 'test-password')).statusCode).toBe(200);
      });

      it('a changed password survives a restart with the same FOTA_ADMIN_CREDENTIALS', async () => {
        const cookie = await adminCookie(app);
        expect((await changePassword(cookie, 'test-password', NEW_PASSWORD)).statusCode).toBe(200);

        const restarted = buildServer();
        await restarted.ready();
        expect((await login(restarted, NEW_PASSWORD)).statusCode).toBe(200);
        expect((await login(restarted, 'test-password')).statusCode).toBe(401);
        await restarted.close();
      });

      it('a NEW value in FOTA_ADMIN_CREDENTIALS resets the password and signs everyone out', async () => {
        const cookie = await adminCookie(app);
        const res = await changePassword(cookie, 'test-password', NEW_PASSWORD);
        const newCookie = (res.headers['set-cookie'] as string).split(';')[0];

        const original = process.env.FOTA_ADMIN_CREDENTIALS;
        process.env.FOTA_ADMIN_CREDENTIALS = 'admin@example.com:reset-from-env-123';
        try {
          const restarted = buildServer();
          await restarted.ready();
          expect((await login(restarted, 'reset-from-env-123')).statusCode).toBe(200);
          expect((await login(restarted, NEW_PASSWORD)).statusCode).toBe(401);
          expect(await isSignedIn(restarted, newCookie)).toBe(false);
          await restarted.close();
        } finally {
          process.env.FOTA_ADMIN_CREDENTIALS = original;
        }
      });

      it('an admin row from before env_password_hash existed takes the env password once', async () => {
        db.prepare("UPDATE admins SET password_hash = 'stale:stale', env_password_hash = NULL").run();

        const restarted = buildServer();
        await restarted.ready();
        expect((await login(restarted, 'test-password')).statusCode).toBe(200);
        const row = db.prepare('SELECT env_password_hash FROM admins').get() as { env_password_hash: string | null };
        expect(row.env_password_hash).not.toBeNull();
        await restarted.close();
      });
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

  describe('POST /admin/users - Cognito identity verification', () => {
    it('valid Cognito ID token: provisioning succeeds and a dev_users row is created for the verified email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: { authorization: `Bearer ${signTestIdToken({ email: 'ivy@example.com' })}` },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.email).toBe('ivy@example.com');
      expect(body.token.length).toBeGreaterThan(20);

      const row = db.prepare('SELECT * FROM dev_users WHERE email = ?').get('ivy@example.com');
      expect(row).toBeDefined();
    });

    it('missing token: rejected, no dev_users row created', async () => {
      const res = await app.inject({ method: 'POST', url: '/admin/users' });
      expect(res.statusCode).toBe(401);
      expect(db.prepare('SELECT COUNT(*) AS n FROM dev_users').get()).toEqual({ n: 0 });
    });

    it('invalid token (tampered signature): rejected, no dev_users row created', async () => {
      const validToken = signTestIdToken({ email: 'mallory@example.com' });
      const tamperedToken = validToken.slice(0, -4) + 'XXXX';
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: { authorization: `Bearer ${tamperedToken}` },
      });
      expect(res.statusCode).toBe(401);
      expect(db.prepare('SELECT COUNT(*) AS n FROM dev_users').get()).toEqual({ n: 0 });
    });

    it('wrong issuer: rejected, no dev_users row created', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: {
          authorization: `Bearer ${signTestIdToken({
            email: 'oscar@example.com',
            iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_WRONGPOOL',
          })}`,
        },
      });
      expect(res.statusCode).toBe(401);
      expect(db.prepare('SELECT COUNT(*) AS n FROM dev_users').get()).toEqual({ n: 0 });
    });

    it('wrong audience: rejected, no dev_users row created', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: {
          authorization: `Bearer ${signTestIdToken({
            email: 'peggy@example.com',
            aud: 'some-other-client-id',
          })}`,
        },
      });
      expect(res.statusCode).toBe(401);
      expect(db.prepare('SELECT COUNT(*) AS n FROM dev_users').get()).toEqual({ n: 0 });
    });

    it('wrong token_use (access token instead of id token): rejected, no dev_users row created', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: {
          authorization: `Bearer ${signTestIdToken({
            email: 'trent@example.com',
            token_use: 'access',
          })}`,
        },
      });
      expect(res.statusCode).toBe(401);
      expect(db.prepare('SELECT COUNT(*) AS n FROM dev_users').get()).toEqual({ n: 0 });
    });

    it('client-supplied email in the request body is ignored - the verified token identity always wins', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: { authorization: `Bearer ${signTestIdToken({ email: 'walter@example.com' })}` },
        payload: { email: 'attacker@evil.example.com' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe('walter@example.com');
      expect(
        db.prepare('SELECT * FROM dev_users WHERE email = ?').get('attacker@evil.example.com'),
      ).toBeUndefined();
    });

    it('tenant-prefix normalization still works on the verified email claim', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: {
          authorization: `Bearer ${signTestIdToken({
            email: 'tenant-fb67ce97-a4d2-4ffd-9aea-2f62fa4746b3-yolanda@example.com',
          })}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe('yolanda@example.com');
      expect(
        db.prepare('SELECT * FROM dev_users WHERE email = ?').get('yolanda@example.com'),
      ).toBeDefined();
    });

    it('mixed-case verified email is lowercased so it matches lowercased tenant/assignment emails', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/users',
        headers: {
          authorization: `Bearer ${signTestIdToken({
            email: 'tenant-fb67ce97-a4d2-4ffd-9aea-2f62fa4746b3-Zelda.Mixed+Case@Example.com',
          })}`,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe('zelda.mixed+case@example.com');
      expect(
        db.prepare('SELECT * FROM dev_users WHERE email = ?').get('zelda.mixed+case@example.com'),
      ).toBeDefined();
      expect(
        db.prepare('SELECT * FROM dev_users WHERE email = ?').get('Zelda.Mixed+Case@Example.com'),
      ).toBeUndefined();
    });
  });
});
