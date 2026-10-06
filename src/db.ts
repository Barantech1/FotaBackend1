import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Uses Node's built-in node:sqlite (real SQLite, no native module/compiler
// toolchain required) instead of better-sqlite3 - this machine has no C++
// build tools installed for node-gyp, and "keep the MVP deliberately
// simple" argues against introducing one just for two small tables.
// Currently marked experimental by Node itself; stable enough for this
// local-only MVP, and trivially swappable later if that changes.
//
// Fetched via process.getBuiltinModule() rather than a static
// `import ... from 'node:sqlite'` - vitest/vite's dependency transform in
// the installed version doesn't yet recognize this newer builtin and
// mis-resolves the bare specifier as an npm package; this runtime lookup
// sidesteps that entirely (verified directly - a static import fails
// under `npm test` but works fine under plain `node`).
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FOTA_DATA_DIR ?? path.join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'fota.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS dev_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS firmware (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    version TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firmware_id INTEGER NOT NULL REFERENCES firmware(id),
    user_email TEXT NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_user_active
    ON assignments(user_email, is_active);

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );

  -- Admin-curated list of expected end users (renters). Add-only for the
  -- MVP per Ariel: no removal/deactivation flow yet. Deliberately separate
  -- from dev_users, which the mobile app populates automatically on first
  -- check-in - a tenant can be entered here before they've ever opened the
  -- app.
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per GET /fota/check call - the "User Activity" log shown in
  -- the admin UI. update_available/firmware_id capture what that specific
  -- check saw, so history stays accurate even after later reassignment.
  -- checked_in_at/downloaded_at below use strftime(...,'%f') for
  -- millisecond precision, not datetime('now')'s whole-second resolution -
  -- the activity log's "downloaded as of this check-in" comparison
  -- (routes/admin.ts) needs to tell apart a check-in and a download that
  -- land in the same second, which happens often in practice (the mobile
  -- app can check-in and download back to back).
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    checked_in_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    update_available INTEGER NOT NULL,
    firmware_id INTEGER REFERENCES firmware(id)
  );

  -- One row per completed GET /fota/download/:id. This is the backend's
  -- only real signal for "downloaded" - it has no equivalent signal for
  -- "written to the lock", since that event happens entirely on the phone
  -- and is never reported back (see routes/admin.ts activity endpoint).
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    firmware_id INTEGER NOT NULL REFERENCES firmware(id),
    downloaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );
`);

// Columns added after the first deployment. CREATE TABLE IF NOT EXISTS
// above never alters an existing table, so they are added here when missing.
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// admins.env_password_hash: salted hash of the FOTA_ADMIN_CREDENTIALS
// password last applied at boot, so a restart only re-applies the env
// password when the env value itself changed - a password changed in the
// admin UI survives restarts (see bootstrapAdmins in adminAuth.ts).
// admins.session_epoch: embedded in each session cookie and bumped on every
// password change, which invalidates all sessions issued before it.
addColumnIfMissing('admins', 'env_password_hash', 'TEXT');
addColumnIfMissing('admins', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0');

export interface FirmwareRow {
  id: number;
  filename: string;
  version: string;
  file_path: string;
  file_size_bytes: number;
  checksum_sha256: string;
  uploaded_at: string;
  is_active: number;
}

export interface AssignmentRow {
  id: number;
  firmware_id: number;
  user_email: string;
  assigned_at: string;
  is_active: number;
}

export interface DevUserRow {
  id: number;
  email: string;
  token: string;
  created_at: string;
}

export interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  env_password_hash: string | null;
  session_epoch: number;
}

export interface TenantRow {
  id: number;
  email: string;
  added_at: string;
}

export interface CheckinRow {
  id: number;
  user_email: string;
  checked_in_at: string;
  update_available: number;
  firmware_id: number | null;
}

export interface DownloadRow {
  id: number;
  user_email: string;
  firmware_id: number;
  downloaded_at: string;
}
