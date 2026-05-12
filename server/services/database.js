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
    this._migrateJsonConfigs();

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

    // ─── Phase 16: config tables (migrated from JSON) ────────
    //
    // Three configs move from JSON files to SQLite:
    //   - addon_mappings (was addon-mappings.json)
    //   - packages + package_items (was package-contents.json)
    //   - order_overrides (already SQLite from Phase 11; we just
    //     add the existing schema definition here for visibility —
    //     CREATE IF NOT EXISTS is a no-op since the orderOverride
    //     service already created the table)
    //
    // All three share a unified config_history table keyed by
    // (config_type, entity_id).

    // Addon mappings — see addonMappingsService for shape rationale.
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS addon_mappings (
        opt_id      TEXT PRIMARY KEY NOT NULL,
        type        TEXT NOT NULL DEFAULT 'product',
        name        TEXT NOT NULL DEFAULT '',
        sku         TEXT,
        qty         INTEGER NOT NULL DEFAULT 1,
        suffix      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by  TEXT
      )
    `).run();

    // Packages: one row per package SKU.
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS packages (
        package_sku TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by  TEXT
      )
    `).run();

    // Package items: N rows per package. Delete a package and its
    // items cascade.
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS package_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        package_sku TEXT NOT NULL,
        item_sku    TEXT NOT NULL,
        qty         INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (package_sku) REFERENCES packages(package_sku) ON DELETE CASCADE,
        UNIQUE (package_sku, item_sku)
      )
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_pkg_items_pkg ON package_items(package_sku)
    `).run();

    // Unified history table. Polymorphic on config_type:
    //   - 'addon_mapping' — entity_id is opt_id
    //   - 'package'       — entity_id is package_sku
    //   - 'order_override'— entity_id is "<orderId>:<cartId>"
    // prev_value and new_value are JSON snapshots of the full entity
    // state (for packages, that includes its items).
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS config_history (
        history_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        config_type TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        action      TEXT NOT NULL,
        prev_value  TEXT,
        new_value   TEXT,
        changed_at  TEXT NOT NULL DEFAULT (datetime('now')),
        changed_by  TEXT
      )
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_config_history_entity
      ON config_history(config_type, entity_id, changed_at DESC)
    `).run();

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_config_history_recent
      ON config_history(changed_at DESC)
    `).run();
  }

  // Phase 16: one-time migration of JSON configs into SQLite. Runs
  // on every boot AFTER _createSchema(). Idempotent: skips if the
  // SQLite tables already have data, OR if the JSON file has
  // already been renamed to *.migrated. Wraps each config import
  // in a transaction so partial failures roll back cleanly.
  _migrateJsonConfigs() {
    const configDir = path.dirname(DB_PATH);

    // Helper: rename JSON to *.migrated so the import is one-way.
    // If the rename fails (e.g. permissions), log but don't roll
    // back the data import — the data is in SQLite either way and
    // a second boot just sees the data already present and skips.
    const archiveJson = (jsonPath) => {
      try {
        const archived = jsonPath + '.migrated';
        fs.renameSync(jsonPath, archived);
        console.log(`[Database] Archived ${path.basename(jsonPath)} to ${path.basename(archived)}`);
      } catch (err) {
        console.warn(`[Database] Could not archive ${jsonPath}: ${err.message}`);
      }
    };

    // ─── addon-mappings.json → addon_mappings table ────────
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM addon_mappings').get().n;
      const jsonPath = path.join(configDir, 'addon-mappings.json');
      if (count === 0 && fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed || {});
        if (entries.length > 0) {
          const insert = this.db.prepare(`
            INSERT INTO addon_mappings (opt_id, type, name, sku, qty, suffix, updated_at, updated_by)
            VALUES (@opt_id, @type, @name, @sku, @qty, @suffix, @updated_at, @updated_by)
          `);
          const tx = this.db.transaction((rows) => {
            for (const row of rows) insert.run(row);
          });
          const now = new Date().toISOString();
          const rows = entries.map(([optId, m]) => {
            const isModifier = m?.type === 'modifier';
            return {
              opt_id: String(optId),
              type: isModifier ? 'modifier' : 'product',
              name: typeof m?.name === 'string' ? m.name : '',
              sku: isModifier ? null : (m?.sku ? String(m.sku) : null),
              qty: isModifier ? 1 : Math.max(1, parseInt(m?.qty, 10) || 1),
              suffix: isModifier ? (typeof m?.suffix === 'string' ? m.suffix : '') : null,
              updated_at: now,
              updated_by: 'migration',
            };
          });
          tx(rows);
          console.log(`[Database] Migrated ${rows.length} addon mappings from JSON`);
          archiveJson(jsonPath);
        } else if (entries.length === 0) {
          // Empty JSON object — just archive
          archiveJson(jsonPath);
        }
      }
    } catch (err) {
      console.error(`[Database] addon-mappings.json migration failed: ${err.message}`);
    }

    // ─── package-contents.json → packages + package_items ──
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM packages').get().n;
      const jsonPath = path.join(configDir, 'package-contents.json');
      if (count === 0 && fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed || {});
        if (entries.length > 0) {
          const insertPkg = this.db.prepare(`
            INSERT INTO packages (package_sku, name, updated_at, updated_by)
            VALUES (?, ?, ?, ?)
          `);
          const insertItem = this.db.prepare(`
            INSERT INTO package_items (package_sku, item_sku, qty, sort_order)
            VALUES (?, ?, ?, ?)
          `);
          const tx = this.db.transaction((rows) => {
            for (const { pkg, items } of rows) {
              insertPkg.run(pkg.package_sku, pkg.name, pkg.updated_at, pkg.updated_by);
              items.forEach((it, idx) => {
                insertItem.run(pkg.package_sku, it.item_sku, it.qty, idx);
              });
            }
          });
          const now = new Date().toISOString();
          const rows = entries.map(([pkgSku, def]) => ({
            pkg: {
              package_sku: String(pkgSku),
              name: typeof def?.name === 'string' ? def.name : `Package ${pkgSku}`,
              updated_at: now,
              updated_by: 'migration',
            },
            items: (def?.items || [])
              .filter((it) => it && it.sku != null)
              .map((it) => ({
                item_sku: String(it.sku),
                qty: Math.max(1, parseInt(it.qty, 10) || 1),
              })),
          }));
          tx(rows);
          const totalItems = rows.reduce((sum, r) => sum + r.items.length, 0);
          console.log(
            `[Database] Migrated ${rows.length} packages (${totalItems} items) from JSON`
          );
          archiveJson(jsonPath);
        } else if (entries.length === 0) {
          archiveJson(jsonPath);
        }
      }
    } catch (err) {
      console.error(`[Database] package-contents.json migration failed: ${err.message}`);
    }

    // ─── order_overrides ─────────────────────────────────────
    //
    // No migration needed — orderOverrideService has stored its
    // data in SQLite since Phase 11. We just want to confirm the
    // table exists. If orderOverrideService hasn't been init'd yet,
    // we create the table here so config_history references stay
    // valid. (orderOverrideService.init() is idempotent — it'll
    // see the existing table and continue.)
    try {
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS order_overrides (
          order_id INTEGER NOT NULL,
          cart_id INTEGER NOT NULL,
          layout_id TEXT NOT NULL,
          variant TEXT NOT NULL,
          layout_snapshot TEXT NOT NULL,
          original_composite_filename TEXT,
          reprint_composite_filename TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT,
          updated_at TEXT,
          PRIMARY KEY (order_id, cart_id)
        )
      `).run();
    } catch (err) {
      console.warn(`[Database] order_overrides table check: ${err.message}`);
    }
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
