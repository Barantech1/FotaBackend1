# FOTA MVP Backend

Local-only backend for the Lockfinity FOTA MVP. Runs on Ariel's PC; no cloud infrastructure. See `FOTA_MVP_Implementation_Plan_v0.2.md` (tracked in Ariel's Orchestrator, project "FOTA MVP") for the full plan this implements — this repo is Phase 1 only.

## What this is

Four endpoints (Fastify + TypeScript + Node's built-in `node:sqlite`):

- `POST /admin/firmware` — upload a firmware/delta file (multipart: `version` field + `file`). Records filename, version, size, server-computed SHA-256, upload time.
- `POST /admin/assignments` — assign an uploaded firmware to a user's email. One active assignment per user; prior assignments are deactivated, never deleted.
- `GET /fota/check` — authenticated. Reports whether an update is available for the caller. Identity comes **only** from the bearer token, never from a client-supplied field.
- `GET /fota/download/:firmwareId` — authenticated. Serves the firmware only if it's the one currently assigned to the caller.

Plus `POST /admin/users` — provisions a dev-only identity (email → opaque bearer token). Not one of the four endpoints above, but required to obtain a token in the first place. This is intentionally minimal: a real login flow is out of scope for the MVP (see the Implementation Plan, Section 16).

## Why `node:sqlite` instead of `better-sqlite3`

`better-sqlite3` needs native compilation (node-gyp) and this machine has no C++ build toolchain installed. Node's built-in `node:sqlite` (stable enough for this local MVP, currently marked experimental by Node itself) needs no native module at all. If that constraint changes, swapping back is a small, contained change (only `src/db.ts` touches the DB API directly).

## Run it

```bash
npm install
npm run dev      # tsx watch, http://localhost:4100 by default
```

Set `PORT` / `HOST` env vars to change the bind address. The phone must reach this over your LAN — `localhost` on the phone means the phone itself, not this PC. Find this PC's LAN IP and configure the mobile app's `API_BASE_URL` to point at `http://<this-pc-lan-ip>:4100`.

## Test it

```bash
npm test        # vitest — identity-invariant and one-active-assignment-per-user tests included
npm run typecheck
```

## Data

`data/fota.db` (SQLite, gitignored) and `firmware-storage/` (uploaded files, gitignored) are created on first run. Both are local-only and disposable — delete them to reset to a clean state.

## Explicitly out of scope for this MVP

No cloud hosting, no production authentication, no firmware validation/installation (the lock's own firmware doesn't implement that yet either — see the Implementation Plan's discovery findings). This backend's job ends at "the assigned firmware bytes were downloaded intact"; everything from NFC transfer onward is Phase 3/4, in the mobile app repository.
