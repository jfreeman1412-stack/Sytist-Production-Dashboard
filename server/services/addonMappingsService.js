// server/services/addonMappingsService.js
//
// Phase 16: SQLite-backed (was JSON file in 15b/c).
//
// Public API unchanged — getConfig/updateConfig/updateMapping/
// deleteMapping/getMappingForOpt — so consumers in sytistDbService
// and the route layer don't need to change. The internals now read
// and write to the addon_mappings table.
//
// Audit history: every write records a row in config_history via
// configHistoryService, attributed to req.user?.username when
// available.
//
// Backward compat: async API preserved so callers' `await` keeps
// working. Internally we use synchronous better-sqlite3 calls
// (which is what _the existing pattern in databaseService does_),
// and just resolve the result.

const databaseService = require('./database');
const configHistory = require('./configHistoryService');

class AddonMappingsService {
  /**
   * Returns the full config in the legacy shape:
   *   { "2007": { type, name, sku, qty, suffix }, ... }
   *
   * Modifier rows have type='modifier' + suffix; product rows have
   * type='product' + sku + qty. Half-configured rows are still
   * returned (caller decides whether they're "complete" — see
   * getMappingForOpt for the completeness gate).
   */
  async getConfig() {
    const db = databaseService.getDb();
    const rows = db
      .prepare(
        `SELECT opt_id, type, name, sku, qty, suffix
         FROM addon_mappings
         ORDER BY opt_id`
      )
      .all();
    const out = {};
    for (const r of rows) {
      if (r.type === 'modifier') {
        out[r.opt_id] = {
          type: 'modifier',
          name: r.name || '',
          suffix: r.suffix || '',
        };
      } else {
        out[r.opt_id] = {
          type: 'product',
          name: r.name || '',
          sku: r.sku || '',
          qty: Math.max(1, r.qty || 1),
        };
      }
    }
    return out;
  }

  /**
   * Replace the entire config in one shot. Used by the bulk PUT
   * endpoint and the import-from-JSON flow. Inside a transaction:
   *   1. Snapshot existing state for history.
   *   2. DELETE FROM addon_mappings.
   *   3. INSERT each entry.
   *   4. Record one history row per affected entity (those that
   *      changed, were added, or were removed).
   */
  async updateConfig(newConfig, { username } = {}) {
    const db = databaseService.getDb();
    const normalized = this._normalize(newConfig);

    const tx = db.transaction(() => {
      const prevRows = db
        .prepare(`SELECT * FROM addon_mappings`)
        .all();
      const prevById = new Map(prevRows.map((r) => [r.opt_id, r]));

      // Wipe + reinsert. Cleaner than computing diffs.
      db.prepare(`DELETE FROM addon_mappings`).run();
      const insert = db.prepare(`
        INSERT INTO addon_mappings (opt_id, type, name, sku, qty, suffix, updated_at, updated_by)
        VALUES (@opt_id, @type, @name, @sku, @qty, @suffix, @updated_at, @updated_by)
      `);
      const now = new Date().toISOString();
      const newIds = new Set();
      for (const [optId, m] of Object.entries(normalized)) {
        newIds.add(optId);
        insert.run({
          opt_id: optId,
          type: m.type,
          name: m.name,
          sku: m.type === 'product' ? (m.sku || null) : null,
          qty: m.type === 'product' ? m.qty : 1,
          suffix: m.type === 'modifier' ? (m.suffix || '') : null,
          updated_at: now,
          updated_by: username || null,
        });
      }

      // History — record only entries that changed identity, value,
      // or existence. Diffing here keeps the audit log signal-y
      // instead of recording untouched rows on every bulk-save.
      for (const [optId, next] of Object.entries(normalized)) {
        const prev = prevById.get(optId);
        const prevShape = this._rowToShape(prev);
        if (!this._equalShapes(prevShape, next)) {
          configHistory.record({
            configType: 'addon_mapping',
            entityId: optId,
            action: prev ? 'update' : 'insert',
            prevValue: prevShape,
            newValue: next,
            username,
          });
        }
      }
      for (const [optId, prev] of prevById.entries()) {
        if (!newIds.has(optId)) {
          configHistory.record({
            configType: 'addon_mapping',
            entityId: optId,
            action: 'delete',
            prevValue: this._rowToShape(prev),
            newValue: null,
            username,
          });
        }
      }
    });
    tx();
    return this.getConfig();
  }

  /**
   * Upsert a single mapping. Records one history row.
   */
  async updateMapping(optId, mapping, { username } = {}) {
    const id = String(optId);
    const next = this._normalizeOne(mapping);
    const db = databaseService.getDb();

    const tx = db.transaction(() => {
      const prevRow = db
        .prepare(`SELECT * FROM addon_mappings WHERE opt_id = ?`)
        .get(id);
      const prevShape = this._rowToShape(prevRow);

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO addon_mappings (opt_id, type, name, sku, qty, suffix, updated_at, updated_by)
        VALUES (@opt_id, @type, @name, @sku, @qty, @suffix, @updated_at, @updated_by)
        ON CONFLICT(opt_id) DO UPDATE SET
          type = excluded.type,
          name = excluded.name,
          sku = excluded.sku,
          qty = excluded.qty,
          suffix = excluded.suffix,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run({
        opt_id: id,
        type: next.type,
        name: next.name,
        sku: next.type === 'product' ? (next.sku || null) : null,
        qty: next.type === 'product' ? next.qty : 1,
        suffix: next.type === 'modifier' ? (next.suffix || '') : null,
        updated_at: now,
        updated_by: username || null,
      });

      if (!this._equalShapes(prevShape, next)) {
        configHistory.record({
          configType: 'addon_mapping',
          entityId: id,
          action: prevRow ? 'update' : 'insert',
          prevValue: prevShape,
          newValue: next,
          username,
        });
      }
    });
    tx();
    return this.getConfig();
  }

  /**
   * Delete a single mapping. Records a delete history row.
   * Returns the new config (without the deleted entry).
   */
  async deleteMapping(optId, { username } = {}) {
    const id = String(optId);
    const db = databaseService.getDb();

    const tx = db.transaction(() => {
      const prevRow = db
        .prepare(`SELECT * FROM addon_mappings WHERE opt_id = ?`)
        .get(id);
      if (!prevRow) return;
      db.prepare(`DELETE FROM addon_mappings WHERE opt_id = ?`).run(id);
      configHistory.record({
        configType: 'addon_mapping',
        entityId: id,
        action: 'delete',
        prevValue: this._rowToShape(prevRow),
        newValue: null,
        username,
      });
    });
    tx();
    return this.getConfig();
  }

  /**
   * Used by sytistDbService to decide whether an option should
   * trigger explosion. Returns the mapping if complete, else null:
   *   - product: needs non-empty sku
   *   - modifier: needs non-empty suffix
   */
  async getMappingForOpt(optId) {
    const db = databaseService.getDb();
    const r = db
      .prepare(`SELECT * FROM addon_mappings WHERE opt_id = ?`)
      .get(String(optId));
    if (!r) return null;
    const shape = this._rowToShape(r);
    if (!shape) return null;
    if (shape.type === 'modifier') return shape.suffix ? shape : null;
    return shape.sku ? shape : null;
  }

  // ─── internal helpers ─────────────────────────────────────

  _rowToShape(row) {
    if (!row) return null;
    if (row.type === 'modifier') {
      return {
        type: 'modifier',
        name: row.name || '',
        suffix: row.suffix || '',
      };
    }
    return {
      type: 'product',
      name: row.name || '',
      sku: row.sku || '',
      qty: Math.max(1, row.qty || 1),
    };
  }

  _equalShapes(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a.type !== b.type) return false;
    if (a.name !== b.name) return false;
    if (a.type === 'modifier') return a.suffix === b.suffix;
    return a.sku === b.sku && a.qty === b.qty;
  }

  _normalize(config) {
    const out = {};
    for (const [optId, m] of Object.entries(config || {})) {
      if (!m || typeof m !== 'object') continue;
      out[String(optId)] = this._normalizeOne(m);
    }
    return out;
  }

  _normalizeOne(m) {
    const type = m?.type === 'modifier' ? 'modifier' : 'product';
    const name = typeof m?.name === 'string' ? m.name : '';
    if (type === 'modifier') {
      return {
        type: 'modifier',
        name,
        suffix: typeof m?.suffix === 'string' ? m.suffix : '',
      };
    }
    return {
      type: 'product',
      name,
      sku:
        m?.sku == null || String(m.sku).trim() === '' ? '' : String(m.sku),
      qty: Math.max(1, parseInt(m?.qty, 10) || 1),
    };
  }
}

module.exports = new AddonMappingsService();
