import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const dbPath = process.env.YT_NOTES_DB || path.join(process.cwd(), 'yt-notes.db');
export const db = new DatabaseSync(dbPath);

// WAL is faster but requires a "real" filesystem (fails on some mounts).
// Try WAL, fall back to default rollback journal if not supported.
try {
  db.exec('PRAGMA journal_mode = WAL');
} catch {
  db.exec('PRAGMA journal_mode = DELETE');
}
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    yt_account TEXT,
    source_videos TEXT,
    prompt_used TEXT,
    result_text TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_group ON items(group_id);
  CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);
`);

const DEFAULT_PROMPT = `You are a content curation assistant. The user will paste one or more YouTube video transcripts (auto-generated subtitles, possibly with disfluencies). Produce a structured learning note in markdown with these sections:

1. **Core ideas** (3-5 bullets, one sentence each)
2. **Key sections** (group by theme; under each, list the key arguments / claims)
3. **Actionable takeaways** (what the reader can do after reading)
4. **Notable quotes** (2-3 sentences worth preserving verbatim)

Important constraints:
- Ground every claim in the transcript. Do not invent facts.
- Strip filler words, false starts, and channel promo / sponsor reads.
- Output in markdown.`;

if (!db.prepare('SELECT value FROM settings WHERE key = ?').get('default_prompt')) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('default_prompt', DEFAULT_PROMPT);
}
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get('deepseek_model')) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('deepseek_model', 'deepseek-chat');
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Run multiple statements as a transaction. node:sqlite has no built-in tx wrapper. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** node:sqlite returns lastInsertRowid as bigint — convert for JSON safety. */
export function rowidToNum(id: bigint | number): number {
  return typeof id === 'bigint' ? Number(id) : id;
}
