// server/services/configHistoryService.js
//
// Phase 16: shared audit-history helper for config tables.
//
// Three configs use it:
//   addon_mapping  — entity_id is opt_id (e.g. "2007")
//   package        — entity_id is package_sku (e.g. "1")
//   order_override — entity_id is "<orderId>:<cartId>" (e.g. "110633:1502")
//
// Each write records one row in config_history with:
//   - action: 'insert' | 'update' | 'delete'
//   - prev_value: JSON snapshot of the previous state (null for insert)
//   - new_value: JSON snapshot of the new state (null for delete)
//   - changed_by: username from session (null if no auth context)
//
// Caller pattern (service):
//   const prev = readCurrentState(...);
//   db.transaction(() => {
//     applyWrite(...);
//     const next = readCurrentState(...);
//     configHistory.record({
//       configType, entityId,
//       action: prev ? 'update' : 'insert',
//       prevValue: prev, newValue: next,
//       username,
//     });
//   })();

const databaseService = require('./database');

const CONFIG_TYPES = new Set(['addon_mapping', 'package', 'order_override']);

class ConfigHistoryService {
  /**
   * Write a single history row. Call inside the same transaction
   * that did the data change so they commit together.
   */
  record({ configType, entityId, action, prevValue, newValue, username }) {
    if (!CONFIG_TYPES.has(configType)) {
      throw new Error(`Unknown config_type: ${configType}`);
    }
    if (!['insert', 'update', 'delete'].includes(action)) {
      throw new Error(`Unknown action: ${action}`);
    }
    const db = databaseService.getDb();
    db.prepare(
      `INSERT INTO config_history
        (config_type, entity_id, action, prev_value, new_value, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      configType,
      String(entityId),
      action,
      prevValue != null ? JSON.stringify(prevValue) : null,
      newValue != null ? JSON.stringify(newValue) : null,
      username || null
    );
  }

  /**
   * Fetch history rows for an entity. Most recent first. Limit
   * defaults to 50; cap at 500.
   */
  list({ configType, entityId, limit }) {
    if (!CONFIG_TYPES.has(configType)) {
      throw new Error(`Unknown config_type: ${configType}`);
    }
    const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const db = databaseService.getDb();
    const rows = db
      .prepare(
        `SELECT history_id, config_type, entity_id, action,
                prev_value, new_value, changed_at, changed_by
         FROM config_history
         WHERE config_type = ? AND entity_id = ?
         ORDER BY changed_at DESC, history_id DESC
         LIMIT ?`
      )
      .all(configType, String(entityId), lim);
    return rows.map((r) => ({
      historyId: r.history_id,
      configType: r.config_type,
      entityId: r.entity_id,
      action: r.action,
      prevValue: r.prev_value ? JSON.parse(r.prev_value) : null,
      newValue: r.new_value ? JSON.parse(r.new_value) : null,
      changedAt: r.changed_at,
      changedBy: r.changed_by,
    }));
  }

  /**
   * Recent history across all entities for a config type. Useful
   * for an "all recent changes" overview view.
   */
  recent({ configType, limit }) {
    if (!CONFIG_TYPES.has(configType)) {
      throw new Error(`Unknown config_type: ${configType}`);
    }
    const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const db = databaseService.getDb();
    const rows = db
      .prepare(
        `SELECT history_id, config_type, entity_id, action,
                prev_value, new_value, changed_at, changed_by
         FROM config_history
         WHERE config_type = ?
         ORDER BY changed_at DESC, history_id DESC
         LIMIT ?`
      )
      .all(configType, lim);
    return rows.map((r) => ({
      historyId: r.history_id,
      configType: r.config_type,
      entityId: r.entity_id,
      action: r.action,
      prevValue: r.prev_value ? JSON.parse(r.prev_value) : null,
      newValue: r.new_value ? JSON.parse(r.new_value) : null,
      changedAt: r.changed_at,
      changedBy: r.changed_by,
    }));
  }
}

module.exports = new ConfigHistoryService();
