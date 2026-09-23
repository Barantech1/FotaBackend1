import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Verifies the mobile app's own Cognito ID token - the same session
 * already established for its main-app sign-in, via aws-amplify/auth's
 * fetchAuthSession() - instead of trusting a client-supplied email. This
 * brings POST /admin/users in line with the same "identity always
 * server-verified, never client-supplied" invariant src/auth.ts already
 * documents for /fota/check and /fota/download (Implementation Plan v0.2,
 * Section 10/16); POST /admin/users was the one endpoint that didn't yet
 * follow it (security review, 2026-09-17).
 */
declare module 'fastify' {
  interface FastifyRequest {
    verifiedFotaEmail?: string;
  }
}

// Same tenant-prefixed username convention previously handled client-side
// (mobile app's src/features/fota/slices/fota/fota.ts, now removed from
// there) - moved server-side because identity now derives from the
// verified token's email claim, not a value the client computes and sends.
const TENANT_PREFIXED_EMAIL_PATTERN =
  /^tenant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i;

export function stripTenantPrefix(rawEmail: string): string {
  const match = TENANT_PREFIXED_EMAIL_PATTERN.exec(rawEmail);
  return match ? match[1]! : rawEmail;
}

type Verifier = ReturnType<typeof CognitoJwtVerifier.create>;
let verifier: Verifier | undefined;

// Lazy singleton rather than a module-load-time call: reading these env
// vars at import time would make them required before tests get a chance
// to set them, the same reason tests/fota.test.ts sets FOTA_DATA_DIR
// before importing server.js.
function getVerifier(): Verifier {
  if (!verifier) {
    const userPoolId = process.env.FOTA_COGNITO_USER_POOL_ID;
    const clientId = process.env.FOTA_COGNITO_CLIENT_ID;
    if (!userPoolId || !clientId) {
      throw new Error(
        'FOTA_COGNITO_USER_POOL_ID and FOTA_COGNITO_CLIENT_ID must both be set to verify the mobile app identity.',
      );
    }
    verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId });
  }
  return verifier;
}

// Exposed only so tests can seed a self-signed test JWKS via
// verifier.cacheJwks(...) - this lets tests exercise real signature/
// issuer/audience/token_use verification against a locally generated
// keypair, with no network call to the real Cognito JWKS endpoint.
export function getCognitoVerifierForTesting(): Verifier {
  return getVerifier();
}

export async function requireCognitoIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  let cognitoVerifier: Verifier;
  try {
    cognitoVerifier = getVerifier();
  } catch {
    // Server misconfiguration (missing env vars), not a bad caller - a
    // distinct status from 401 so it's not mistaken for "your token was
    // rejected" during setup/deploy.
    reply.code(503).send({
      error: 'SERVICE_UNAVAILABLE',
      message: 'FOTA_COGNITO_USER_POOL_ID and FOTA_COGNITO_CLIENT_ID must be configured.',
    });
    return;
  }

  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing bearer token.' });
    return;
  }

  let email: string | undefined;
  try {
    const payload = await cognitoVerifier.verify(token);
    email = payload.email as string | undefined;
  } catch {
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid Cognito ID token.' });
    return;
  }

  if (!email) {
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Token has no email claim.' });
    return;
  }

  req.verifiedFotaEmail = stripTenantPrefix(email);
}
