import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type DB = Database.Database;

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB, dir = MIGRATIONS_DIR): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM _migrations").pluck().all() as string[]);
  const applied: string[] = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    })();
    applied.push(name);
  }
  return applied;
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : fallback;
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(key, JSON.stringify(value));
}

/** Read-through cache in SQLite. */
export async function cached<T>(db: DB, key: string, ttlMs: number, now: number, fn: () => Promise<T>): Promise<T> {
  const row = db.prepare("SELECT body, expires_at FROM http_cache WHERE key = ?").get(key) as { body: string; expires_at: number } | undefined;
  if (row && row.expires_at > now) return JSON.parse(row.body) as T;
  const value = await fn();
  db.prepare("INSERT INTO http_cache (key, body, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at").run(
    key,
    JSON.stringify(value),
    now + ttlMs,
  );
  return value;
}
