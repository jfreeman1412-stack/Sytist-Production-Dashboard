// server/services/packageContentsService.js
//
// Phase 16: SQLite-backed (was JSON file in 15a).
//
// Public API unchanged:
//   getConfig() → { "1": { name, items: [{sku, qty}, ...] }, ... }
//   updateConfig(newConfig)
//   updatePackage(packageSku, packageDef)
//   deletePackage(packageSku)
//   getContentsForPackage(packageSku)
//   isPackageSku(sku)
//
// Storage: packages table + package_items table (1:N). Foreign-key
// cascade ensures deleting a package removes its items.
//
// History: every write to a package (insert/update/delete) records
// a snapshot of the full package shape (name + items[]) so the
// audit UI can show "Gold Package went from 9 items to 10 items".

const databaseService = require('./database');
const configHistory = require('./configHistoryService');

class PackageContentsService {
  /**
   * Returns the full config in the legacy shape:
   *   { "1": { name, items: [{sku, qty}, ...] }, ... }
   */
  async getConfig() {
    const db = databaseService.getDb();
    const pkgRows = db
      .prepare(`SELECT package_sku, name FROM packages ORDER BY package_sku`)
      .all();
    const itemsBy = new Map();
    if (pkgRows.length > 0) {
      const itemRows = db
        .prepare(
          `SELECT package_sku, item_sku, qty, sort_order
           FROM package_items
           ORDER BY package_sku, sort_order, id`
        )
        .all();
      for (const r of itemRows) {
        const list = itemsBy.get(r.package_sku) || [];
        list.push({ sku: r.item_sku, qty: Math.max(1, r.qty || 1) });
        itemsBy.set(r.package_sku, list);
      }
    }
    const out = {};
    for (const pkg of pkgRows) {
      out[pkg.package_sku] = {
        name: pkg.name || `Package ${pkg.package_sku}`,
        items: itemsBy.get(pkg.package_sku) || [],
      };
    }
    return out;
  }

  /**
   * Replace the entire config. Inside a transaction:
   *   1. Snapshot existing state for diffing.
   *   2. DELETE everything (items cascade with packages).
   *   3. INSERT new packages + their items.
   *   4. Record one history row per package that changed.
   */
  async updateConfig(newConfig, { username } = {}) {
    const db = databaseService.getDb();
    const normalized = this._normalize(newConfig);
    const prev = await this.getConfig();

    const tx = db.transaction(() => {
      // Clear all. items cascade.
      db.prepare(`DELETE FROM packages`).run();

      const insertPkg = db.prepare(`
        INSERT INTO packages (package_sku, name, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
      `);
      const insertItem = db.prepare(`
        INSERT INTO package_items (package_sku, item_sku, qty, sort_order)
        VALUES (?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const [pkgSku, def] of Object.entries(normalized)) {
        insertPkg.run(pkgSku, def.name, now, username || null);
        def.items.forEach((it, idx) =>
          insertItem.run(pkgSku, it.sku, it.qty, idx)
        );
      }

      // History
      const allIds = new Set([
        ...Object.keys(prev),
        ...Object.keys(normalized),
      ]);
      for (const pkgSku of allIds) {
        const before = prev[pkgSku] || null;
        const after = normalized[pkgSku] || null;
        if (this._equalPackages(before, after)) continue;
        const action = !before ? 'insert' : !after ? 'delete' : 'update';
        configHistory.record({
          configType: 'package',
          entityId: pkgSku,
          action,
          prevValue: before,
          newValue: after,
          username,
        });
      }
    });
    tx();
    return this.getConfig();
  }

  /**
   * Upsert one package. Records one history row if the shape changed.
   */
  async updatePackage(packageSku, packageDef, { username } = {}) {
    const id = String(packageSku);
    const next = this._normalizeOne(packageDef);
    const db = databaseService.getDb();
    const prevConfig = await this.getConfig();
    const prev = prevConfig[id] || null;

    const tx = db.transaction(() => {
      // Upsert the package row
      db.prepare(`
        INSERT INTO packages (package_sku, name, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(package_sku) DO UPDATE SET
          name = excluded.name,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(id, next.name, new Date().toISOString(), username || null);

      // Replace items wholesale (simpler than diffing)
      db.prepare(`DELETE FROM package_items WHERE package_sku = ?`).run(id);
      const insertItem = db.prepare(`
        INSERT INTO package_items (package_sku, item_sku, qty, sort_order)
        VALUES (?, ?, ?, ?)
      `);
      next.items.forEach((it, idx) =>
        insertItem.run(id, it.sku, it.qty, idx)
      );

      if (!this._equalPackages(prev, next)) {
        configHistory.record({
          configType: 'package',
          entityId: id,
          action: prev ? 'update' : 'insert',
          prevValue: prev,
          newValue: next,
          username,
        });
      }
    });
    tx();
    return this.getConfig();
  }

  async deletePackage(packageSku, { username } = {}) {
    const id = String(packageSku);
    const db = databaseService.getDb();
    const prevConfig = await this.getConfig();
    const prev = prevConfig[id] || null;

    const tx = db.transaction(() => {
      const result = db
        .prepare(`DELETE FROM packages WHERE package_sku = ?`)
        .run(id);
      if (result.changes > 0 && prev) {
        configHistory.record({
          configType: 'package',
          entityId: id,
          action: 'delete',
          prevValue: prev,
          newValue: null,
          username,
        });
      }
    });
    tx();
    return this.getConfig();
  }

  async getContentsForPackage(packageSku) {
    const cfg = await this.getConfig();
    const pkg = cfg[String(packageSku)];
    return pkg ? pkg.items : null;
  }

  async isPackageSku(sku) {
    const db = databaseService.getDb();
    const r = db
      .prepare(`SELECT 1 FROM packages WHERE package_sku = ?`)
      .get(String(sku));
    return !!r;
  }

  // ─── internal helpers ────────────────────────────────────

  _normalize(config) {
    const out = {};
    for (const [pkgSku, def] of Object.entries(config || {})) {
      if (!def || typeof def !== 'object') continue;
      out[String(pkgSku)] = this._normalizeOne(def, pkgSku);
    }
    return out;
  }

  _normalizeOne(def, fallbackSku) {
    return {
      name:
        typeof def?.name === 'string'
          ? def.name
          : `Package ${fallbackSku || ''}`.trim(),
      items: Array.isArray(def?.items)
        ? def.items
            .filter((it) => it && it.sku != null)
            .map((it) => ({
              sku: String(it.sku),
              qty: Math.max(1, parseInt(it.qty, 10) || 1),
            }))
        : [],
    };
  }

  _equalPackages(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a.name !== b.name) return false;
    const ai = a.items || [];
    const bi = b.items || [];
    if (ai.length !== bi.length) return false;
    for (let i = 0; i < ai.length; i++) {
      if (ai[i].sku !== bi[i].sku || ai[i].qty !== bi[i].qty) return false;
    }
    return true;
  }
}

module.exports = new PackageContentsService();
