# FOTA MVP Backend

Local-only backend for the Lockfinity FOTA MVP. Runs on Ariel's PC; no cloud infrastructure. See `FOTA_MVP_Implementation_Plan_v0.2.md` (tracked in Ariel's Orchestrator, project "FOTA MVP") for the full plan this implements — this repo is Phase 1 only.

## What this is

Four endpoints (Fastify + TypeScript + Node's built-in `node:sqlite`):

- `POST /admin/firmware` — upload a firmware/delta file (multipart: `version` field + `file`). Records filename, version, size, server-computed SHA-256, upload time.
- `POST /admin/assignments` — assign an uploaded firmware to a user's email. One active assignment per user; prior assignments are deactivated, never deleted.
- `GET /fota/check` — authenticated. Reports whether an update is available for the caller. Identity comes **only** from the bearer token, never from a client-supplied field.
- `GET /fota/download/:firmwareId` — authenticated. Serves the firmware only if it's the one currently assigned to the caller.

Plus `POST /admin/users` — provisions a dev-only identity (verified Cognito identity → opaque bearer token). Not one of the four endpoints above, but required to obtain a token in the first place. Authenticated by the caller's own Cognito ID token (see "Mobile identity verification" below) rather than a login flow of its own - a real admin login flow remains out of scope for the MVP (see the Implementation Plan, Section 16).

## Mobile identity verification

`POST /admin/users` requires `Authorization: Bearer <Cognito ID token>` - the same token already issued by the mobile app's existing Cognito sign-in (no separate login flow, no APK-embedded secret). The backend verifies the token's signature, issuer, audience, and `token_use=id` claim (via `aws-jwt-verify`), then derives the caller's identity from the token's own verified `email` claim - never from a client-supplied value. The tenant-prefixed username convention (`tenant-<uuid>-<real email>`) is stripped server-side from that verified claim.

```bash
FOTA_COGNITO_USER_POOL_ID="us-east-1_Nd6IAgnyc"      # must match the mobile app's EXPO_PUBLIC_AWS_COGNITO_USER_POOL_ID
FOTA_COGNITO_CLIENT_ID="481gc8ojk5tiiipvs0g0cfagkq"  # must match EXPO_PUBLIC_AWS_COGNITO_USER_POOL_CLIENT_ID
```

Neither value is a secret (both are already embedded in the mobile app's own public build config) - they just need to match the same Cognito User Pool/App Client the mobile app signs in against. If either is unset, `POST /admin/users` returns `503` (server misconfigured) rather than accepting any request.

## Admin UI

A small admin panel is served by this same service at `/admin` (e.g. `http://localhost:4100/admin`) - no separate frontend project or deploy. It's a single dependency-free HTML/CSS/JS page (`src/adminUiHtml.ts`) that calls the JSON API below.

- **Firmware** - list uploaded firmware, upload new ones.
- **Assignments** - see/change which firmware each user currently receives (edit supersedes the old assignment; history is kept, not deleted).
- **Tenants** - an admin-curated, add-only list of expected end users, used to populate the assignment dropdown.
- **User Activity** - one row per `GET /fota/check` call, sortable by email or time. "Downloaded" is real (backed by a `downloads` log written on every successful `GET /fota/download`). **"Written to lock" is always "Unknown"** - the mobile app never reports an NFC write outcome back to this backend today; that event lives only in the phone's local Redux state. Showing it truthfully would need a new mobile-app-to-backend reporting endpoint, which is out of scope until specifically approved.
- **Admins** - read-only list of who can sign in here.

**Auth**: a signed, `HttpOnly` session cookie (no session-store dependency - the signature alone proves validity, so it survives fine in a single-process deployment). Admin accounts are configured entirely via environment variable, not through the UI:

```bash
FOTA_ADMIN_CREDENTIALS="ariel@barantech.com:some-password,colleague@barantech.com:other-password"
FOTA_ADMIN_SESSION_SECRET="any-long-random-string"   # optional locally, required in production
```

On every boot, each `email:password` pair in `FOTA_ADMIN_CREDENTIALS` is hashed (scrypt) and upserted into the `admins` table - so changing a password is "edit the env var, restart the process." If `FOTA_ADMIN_SESSION_SECRET` is unset, a random one is generated at boot, which means every admin gets signed out on every restart - fine for local dev, but set it explicitly on Railway so a redeploy doesn't sign everyone out.

## Why `node:sqlite` instead of `better-sqlite3`

`better-sqlite3` needs native compilation (node-gyp) and this machine has no C++ build toolchain installed. Node's built-in `node:sqlite` (stable enough for this local MVP, currently marked experimental by Node itself) needs no native module at all. If that constraint changes, swapping back is a small, contained change (only `src/db.ts` touches the DB API directly).

## Run it

```bash
npm install
FOTA_ADMIN_CREDENTIALS="ariel@barantech.com:some-password" \
FOTA_COGNITO_USER_POOL_ID="us-east-1_Nd6IAgnyc" \
FOTA_COGNITO_CLIENT_ID="481gc8ojk5tiiipvs0g0cfagkq" \
npm run dev   # tsx watch, http://localhost:4100 by default
```

Set `PORT` / `HOST` env vars to change the bind address. The phone must reach this over your LAN — `localhost` on the phone means the phone itself, not this PC. Find this PC's LAN IP and configure the mobile app's `API_BASE_URL` to point at `http://<this-pc-lan-ip>:4100`. Open `http://<host>:4100/admin` for the admin UI - see "Admin UI" above for `FOTA_ADMIN_CREDENTIALS`.

## Test it

```bash
npm test        # vitest — identity-invariant, one-active-assignment-per-user, and admin-session/activity-log tests included
npm run typecheck
```

## Data

`data/fota.db` (SQLite, gitignored) and `firmware-storage/` (uploaded files, gitignored) are created on first run. Both are local-only and disposable — delete them to reset to a clean state.

## Explicitly out of scope for this MVP

No cloud hosting, no production authentication, no firmware validation/installation (the lock's own firmware doesn't implement that yet either — see the Implementation Plan's discovery findings). This backend's job ends at "the assigned firmware bytes were downloaded intact"; everything from NFC transfer onward is Phase 3/4, in the mobile app repository.
