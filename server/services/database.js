// SQLite database for the dashboard's own state (auth, schedules, tracking).
//
// NOT used for caching Sytist data — that comes fresh from MySQL.
//
// Uses better-sqlite3 (synchronous, fast, no callback hell). Schema is created
// on first run and additive going forward (later phases add tables/columns).

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'config', 'sytist-dashboard.db');

class DatabaseService {
  constructor() {
    this.db = null;
  }

  init() {
    if (this.db) return this.db;

    // Ensure config directory exists
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(DB_PATH);

    // Reasonable defaults for a single-user dev setup
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this._createSchema();

    console.log(`[Database] Initialized at ${DB_PATH}`);
    return this.db;
  }

  _createSchema() {
    // Users table — auth credentials and roles.
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        username        TEXT NOT NULL UNIQUE,
        password_hash   TEXT NOT NULL,
        display_name    TEXT,
        role            TEXT NOT NULL DEFAULT 'operator',
        active          INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at   TEXT
      )
    `).run();

    // Sessions table — keyed by UUID, joined to user on validation.
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        expires_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)
    `).run();
  }

  getDb() {
    if (!this.db) this.init();
    return this.db;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = new DatabaseService();
