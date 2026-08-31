// server/services/shipstationLinkService.js
//
// Phase 13a: tracks which Sytist orders have been sent to ShipStation
// and where the resulting SS order lives. Sits in the same SQLite
// file (server/config/sytist-dashboard.db) as order_overrides and
// the auth tables — one file to back up, prepared statements for
// speed, idempotent init.
//
// SCHEMA:
//   shipstation_links:
//     order_id TEXT PRIMARY KEY        -- Sytist orderId (string for safety
//                                          across very large numerics)
//     ss_order_id INTEGER NOT NULL    -- ShipStation's returned orderId
//     ss_order_number TEXT             -- echoed for convenience (matches
//                                          Sytist orderNumber currently)
//     ss_order_status TEXT             -- last known: awaiting_shipment,
//                                          shipped, on_hold, cancelled
//     tracking_number TEXT             -- once shipped
//     carrier_code TEXT
//     service_code TEXT
//     package_code TEXT
//     payload_json TEXT                -- the payload sent to SS, for
//                                          troubleshooting + re-create
//     shipped_at TEXT                  -- when SS reported shipped
//     created_at TEXT NOT NULL
//     updated_at TEXT
//
// A Sytist order maps to at most one SS order in this v1. If we
// later add per-team SS orders for ship_to_managers, we'll add a
// sub_key column and adjust the primary key.

const path = require('path');
const fs = require('fs');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn(
    '[shipstationLinkService] better-sqlite3 not loadable; service disabled'
  );
}

// Exported so the reconcile-queries verify harness can build a
// throwaway in-memory DB from the SAME schema the production init()
// uses. Copies-of-schemas-in-tests drift; single-source doesn't.
const SHIPSTATION_LINKS_CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS shipstation_links (
    order_id TEXT PRIMARY KEY,
    ss_order_id INTEGER NOT NULL,
    ss_order_number TEXT,
    ss_order_status TEXT,
    tracking_number TEXT,
    carrier_code TEXT,
    service_code TEXT,
    package_code TEXT,
    payload_json TEXT,
    shipped_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
`;

class ShipStationLinkService {
  constructor() {
    this._db = null;
    this._stmts = null;
  }

  init() {
    if (this._db) return this._db;
    if (!Database) {
      throw new Error(
        'better-sqlite3 not available — cannot init ShipStationLinkService'
      );
    }
    const dbPath = path.join(
      __dirname,
      '..',
      'config',
      'sytist-dashboard.db'
    );
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');

    this._db.exec(SHIPSTATION_LINKS_CREATE_TABLE_SQL);

    this._stmts = {
      get: this._db.prepare(
        `SELECT * FROM shipstation_links WHERE order_id = ?`
      ),
      getBySs: this._db.prepare(
        `SELECT * FROM shipstation_links WHERE ss_order_id = ?`
      ),
      listAll: this._db.prepare(
        `SELECT * FROM shipstation_links ORDER BY created_at DESC`
      ),
      insert: this._db.prepare(`
        INSERT INTO shipstation_links (
          order_id, ss_order_id, ss_order_number, ss_order_status,
          tracking_number, carrier_code, service_code, package_code,
          payload_json, shipped_at, created_at, updated_at
        ) VALUES (
          @order_id, @ss_order_id, @ss_order_number, @ss_order_status,
          @tracking_number, @carrier_code, @service_code, @package_code,
          @payload_json, @shipped_at, @created_at, @updated_at
        )
      `),
      // Updates only the columns provided; COALESCE keeps existing values
      // when a column is passed as NULL. Use this for partial updates
      // (e.g. "we just learned the order shipped, update tracking only").
      update: this._db.prepare(`
        UPDATE shipstation_links SET
          ss_order_id = COALESCE(@ss_order_id, ss_order_id),
          ss_order_number = COALESCE(@ss_order_number, ss_order_number),
          ss_order_status = COALESCE(@ss_order_status, ss_order_status),
          tracking_number = COALESCE(@tracking_number, tracking_number),
          carrier_code = COALESCE(@carrier_code, carrier_code),
          service_code = COALESCE(@service_code, service_code),
          package_code = COALESCE(@package_code, package_code),
          payload_json = COALESCE(@payload_json, payload_json),
          shipped_at = COALESCE(@shipped_at, shipped_at),
          updated_at = @updated_at
        WHERE order_id = @order_id
      `),
      delete: this._db.prepare(
        `DELETE FROM shipstation_links WHERE order_id = ?`
      ),
    };

    return this._db;
  }

  /** Read the link row for a Sytist order. Returns null if none. */
  getByOrderId(orderId) {
    this.init();
    const row = this._stmts.get.get(String(orderId));
    return row || null;
  }

  /** Reverse lookup — find which Sytist order corresponds to an SS order. */
  getBySsOrderId(ssOrderId) {
    this.init();
    const row = this._stmts.getBySs.get(parseInt(ssOrderId, 10));
    return row || null;
  }

  /** List all links, newest first. */
  listAll() {
    this.init();
    return this._stmts.listAll.all();
  }

  /**
   * Create a new link row. Throws if one already exists for this
   * orderId — the caller should look up first and decide whether to
   * update or report "already exists." Storing the payload as JSON
   * helps debugging — if SS later complains about the order shape,
   * the operator can inspect what we sent.
   */
  create({
    orderId,
    ssOrderId,
    ssOrderNumber,
    ssOrderStatus = 'awaiting_shipment',
    trackingNumber = null,
    carrierCode = null,
    serviceCode = null,
    packageCode = null,
    payload = null,
  }) {
    this.init();
    const now = new Date().toISOString();
    this._stmts.insert.run({
      order_id: String(orderId),
      ss_order_id: parseInt(ssOrderId, 10),
      ss_order_number: ssOrderNumber ? String(ssOrderNumber) : null,
      ss_order_status: ssOrderStatus,
      tracking_number: trackingNumber,
      carrier_code: carrierCode,
      service_code: serviceCode,
      package_code: packageCode,
      payload_json: payload ? JSON.stringify(payload) : null,
      shipped_at: null,
      created_at: now,
      updated_at: now,
    });
    return this.getByOrderId(orderId);
  }

  /**
   * Partial update. Pass only the fields you want to change; others
   * stay as-is via COALESCE in the SQL. `updated_at` is always set.
   */
  update(orderId, fields = {}) {
    this.init();
    const params = {
      order_id: String(orderId),
      ss_order_id: fields.ssOrderId != null ? parseInt(fields.ssOrderId, 10) : null,
      ss_order_number:
        fields.ssOrderNumber != null ? String(fields.ssOrderNumber) : null,
      ss_order_status: fields.ssOrderStatus || null,
      tracking_number: fields.trackingNumber || null,
      carrier_code: fields.carrierCode || null,
      service_code: fields.serviceCode || null,
      package_code: fields.packageCode || null,
      payload_json: fields.payload ? JSON.stringify(fields.payload) : null,
      shipped_at: fields.shippedAt || null,
      updated_at: new Date().toISOString(),
    };
    this._stmts.update.run(params);
    return this.getByOrderId(orderId);
  }

  /**
   * Set tracking_number ONLY IF the current stored value is NULL.
   * Purpose: the tracking-reconcile pass discovers a real tracking
   * number after the initial ship-scan wrote NULL. This must never
   * clobber a tracking number the initial capture happened to catch —
   * the initial write is trusted; reconcile only fills gaps.
   *
   * SQL enforces the guard (`WHERE ... AND tracking_number IS NULL`)
   * so a concurrent tick can't race us into overwriting.
   *
   * @returns {boolean} true if the row was updated, false if the row
   *   was missing OR already had a non-null tracking number.
   */
  setTrackingNumberIfNull(orderId, trackingNumber) {
    this.init();
    if (!trackingNumber || String(trackingNumber).trim() === '') {
      return false;
    }
    const now = new Date().toISOString();
    const result = this._db
      .prepare(
        `UPDATE shipstation_links
            SET tracking_number = @tracking_number,
                updated_at      = @updated_at
          WHERE order_id = @order_id
            AND tracking_number IS NULL`
      )
      .run({
        order_id: String(orderId),
        tracking_number: String(trackingNumber),
        updated_at: now,
      });
    return result.changes > 0;
  }

  /**
   * Delete the link. Useful when the operator deletes the SS order
   * (so the dashboard reflects the removal) or when reprocessing
   * needs to clear the old link first.
   */
  delete(orderId) {
    this.init();
    const result = this._stmts.delete.run(String(orderId));
    return result.changes > 0;
  }

  /**
   * Convenience: get many links by orderId list. Used by the orders
   * list / dashboard for showing per-row SS status badges.
   */
  getManyByOrderIds(orderIds) {
    this.init();
    if (!orderIds || orderIds.length === 0) return {};
    const placeholders = orderIds.map(() => '?').join(',');
    const rows = this._db
      .prepare(
        `SELECT * FROM shipstation_links WHERE order_id IN (${placeholders})`
      )
      .all(...orderIds.map(String));
    const byId = {};
    for (const row of rows) byId[row.order_id] = row;
    return byId;
  }
}

const instance = new ShipStationLinkService();
instance.SHIPSTATION_LINKS_CREATE_TABLE_SQL = SHIPSTATION_LINKS_CREATE_TABLE_SQL;
module.exports = instance;
module.exports.SHIPSTATION_LINKS_CREATE_TABLE_SQL = SHIPSTATION_LINKS_CREATE_TABLE_SQL;
