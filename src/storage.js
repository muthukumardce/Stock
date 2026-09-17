import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const sensitive = /password|secret|token|authorization|cookie|checksum|api_key/i;
export class Store {
  constructor(filename, secrets = []) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.secrets = new Set(secrets.filter(Boolean).map(String));
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT NOT NULL,kind TEXT NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT NOT NULL,mode TEXT NOT NULL,equity REAL NOT NULL);`);
  }
  add_secret(value) { if (value) this.secrets.add(String(value)); }
  redact(value) {
    if (Array.isArray(value)) return value.map(item => this.redact(item));
    if (value && typeof value === 'object') {
      if (value instanceof Date) return value.toISOString();
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : this.redact(item)]));
    }
    if (typeof value === 'string') {
      for (const secret of this.secrets) value = value.replaceAll(secret, '[redacted]');
      return value.replace(/(request_token|access_token|api_secret|password|authorization|checksum)=([^&\s]+)/gi, '$1=[redacted]');
    }
    return value;
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) {
    const text = JSON.stringify(value, (_key, item) => { if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Cannot persist a nonfinite value'); return item; });
    this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, text);
  }
  delete(key) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  event(kind, message, data = {}, level = 'info') {
    if (level && typeof level === 'object') level = level.level || 'info';
    return Number(this.db.prepare('INSERT INTO events(timestamp,kind,level,message,data) VALUES(?,?,?,?,?)').run(new Date().toISOString(), kind, level, this.redact(String(message)), JSON.stringify(this.redact(data || {}))).lastInsertRowid);
  }
  events(after = 0, limit = 200) { return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, Math.min(2000, Math.max(1, limit))).map(row => ({ ...row, data: JSON.parse(row.data) })); }
  latest_events(limit = 100) { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Math.min(2000, Math.max(1, limit))).reverse().map(row => ({ ...row, data: JSON.parse(row.data) })); }
  new_session(digest, csrf, expires) { this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()/1000); this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest, csrf, expires); }
  session(digest) { return this.db.prepare('SELECT * FROM sessions WHERE digest=? AND expires>?').get(digest, Date.now()/1000) || null; }
  drop_session(digest) { this.db.prepare('DELETE FROM sessions WHERE digest=?').run(digest); }
  revoke_sessions() { this.db.exec("DELETE FROM sessions; DELETE FROM kv WHERE key LIKE 'oauth:%';"); }
  sample(mode, equity) {
    this.db.prepare('INSERT INTO samples(timestamp,mode,equity) VALUES(?,?,?)').run(new Date().toISOString(), mode, equity);
    this.db.exec('DELETE FROM samples WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM samples)');
  }
  samples(mode) { return this.db.prepare('SELECT timestamp,equity FROM samples WHERE mode=? ORDER BY id DESC LIMIT 180').all(mode).reverse(); }
  close() { this.db.close(); }
}
