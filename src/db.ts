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
`);

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
