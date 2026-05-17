// server/services/orderOverrideService.js
//
// Phase 11: per-order, per-cart-line layout overrides.
//
// When a customer's photo is positioned poorly by the standard
// layout, an operator can open the override editor and nudge slot
// positions/sizes for THAT cart line only. This service stores the
// override snapshots and tracks the on-disk filenames the override
// produced.
//
// STORAGE: a new SQLite table `order_overrides` in the existing
// dashboard auth database (server/config/sytist-dashboard.db).
// We're not touching the Sytist MySQL DB at all — it's read-only.
//
// SCHEMA (created on first init() call, idempotent):
//   order_overrides:
//     order_id INTEGER NOT NULL
//     cart_id  INTEGER NOT NULL
//     layout_id TEXT NOT NULL
//     variant TEXT NOT NULL  -- 'vertical' or 'horizontal'
//     layout_snapshot TEXT NOT NULL  -- full layout JSON, snapshotted
//     original_composite_filename TEXT  -- so pre-print rerender can overwrite
//     reprint_composite_filename TEXT   -- set when one-off reprint generated
//     created_at TEXT NOT NULL
//     created_by TEXT
//     updated_at TEXT
//     PRIMARY KEY (order_id, cart_id)
//
// At most one ACTIVE override per cart line. Re-saving updates the
// existing row in place rather than appending.
//
// LAYOUT-CHANGES-AFTER-OVERRIDE: snapshot semantics. The full layout
// JSON is captured at override creation time. Later changes to the
// base layout don't disturb the override. The UI shows a banner when
// it detects drift between snapshot and current base layout, with a
// "discard override and start fresh" option.

const path = require('path');
const fs = require('fs');

let Database = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // better-sqlite3 not installed yet — service will throw on use.
  // Auth DB exists in production already so this should never happen.
  console.warn(
    '[orderOverrideService] better-sqlite3 not loadable; service disabled'
  );
}

class OrderOverrideService {
  constructor() {
    this._db = null;
    this._stmts = null;
  }

  // Idempotent. Safe to call multiple times. Path defaults to the
  // existing auth DB so we share one file. Different DB would be a
  // mistake — adds another file to back up, no benefit.
  init() {
    if (this._db) return this._db;
    if (!Database) {
      throw new Error(
        'better-sqlite3 not available — cannot init OrderOverrideService'
      );
    }
    const dbPath = path.join(
      __dirname,
      '..',
      'config',
      'sytist-dashboard.db'
    );
    // Ensure the dir exists; in fresh installs it might not.
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');

    this._db.exec(`
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
      );
    `);

    // Prepare statements once, reuse forever. Faster + safer.
    this._stmts = {
      get: this._db.prepare(
        `SELECT * FROM order_overrides WHERE order_id = ? AND cart_id = ?`
      ),
      listByOrder: this._db.prepare(
        `SELECT order_id, cart_id, layout_id, variant, created_at, updated_at,
                original_composite_filename, reprint_composite_filename
         FROM order_overrides WHERE order_id = ?`
      ),
      // Phase 52: full rows incl. layout_snapshot, for the
      // process-time batch load (one indexed query per order →
      // Map<cartId, override>, instead of an N-line-item .get() fan-out).
      listByOrderFull: this._db.prepare(
        `SELECT * FROM order_overrides WHERE order_id = ?`
      ),
      // UPSERT: insert or update on conflict
      upsert: this._db.prepare(`
        INSERT INTO order_overrides (
          order_id, cart_id, layout_id, variant, layout_snapshot,
          original_composite_filename, reprint_composite_filename,
          created_at, created_by, updated_at
        ) VALUES (
          @order_id, @cart_id, @layout_id, @variant, @layout_snapshot,
          @original_composite_filename, @reprint_composite_filename,
          @created_at, @created_by, @updated_at
        )
        ON CONFLICT(order_id, cart_id) DO UPDATE SET
          layout_id = excluded.layout_id,
          variant = excluded.variant,
          layout_snapshot = excluded.layout_snapshot,
          original_composite_filename = COALESCE(
            excluded.original_composite_filename,
            order_overrides.original_composite_filename
          ),
          reprint_composite_filename = excluded.reprint_composite_filename,
          updated_at = excluded.updated_at
      `),
      delete: this._db.prepare(
        `DELETE FROM order_overrides WHERE order_id = ? AND cart_id = ?`
      ),
      // Just update the reprint filename (after a reprint render)
      setReprintFilename: this._db.prepare(`
        UPDATE order_overrides
        SET reprint_composite_filename = ?, updated_at = ?
        WHERE order_id = ? AND cart_id = ?
      `),
    };

    console.log('[orderOverrideService] Initialized at', dbPath);
    return this._db;
  }

  /**
   * Get the override row for a cart line, or null if none exists.
   * Returns the parsed layout snapshot inline.
   */
  get(orderId, cartId) {
    this.init();
    const row = this._stmts.get.get(
      Number(orderId),
      Number(cartId)
    );
    if (!row) return null;
    return {
      orderId: row.order_id,
      cartId: row.cart_id,
      layoutId: row.layout_id,
      variant: row.variant,
      layoutSnapshot: JSON.parse(row.layout_snapshot),
      originalCompositeFilename: row.original_composite_filename,
      reprintCompositeFilename: row.reprint_composite_filename,
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
    };
  }

  /**
   * List overrides for an order. Useful for the order detail page
   * to show which line items have overrides. Returns light rows
   * (no layout_snapshot — that's heavy and not needed for listing).
   */
  listByOrder(orderId) {
    this.init();
    return this._stmts.listByOrder.all(Number(orderId));
  }

  /**
   * Phase 52: every override for an order WITH its parsed snapshot.
   * One query; same per-row shape as get(). processingService builds
   * a Map<String(cartId), override> from this once per order so the
   * composite loop pays a single indexed read, not one per line item.
   */
  listByOrderWithSnapshots(orderId) {
    this.init();
    const rows = this._stmts.listByOrderFull.all(Number(orderId));
    return rows.map((row) => ({
      orderId: row.order_id,
      cartId: row.cart_id,
      layoutId: row.layout_id,
      variant: row.variant,
      layoutSnapshot: JSON.parse(row.layout_snapshot),
      originalCompositeFilename: row.original_composite_filename,
      reprintCompositeFilename: row.reprint_composite_filename,
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Create or update an override. layoutSnapshot must be the full
   * layout JSON (variants, slots, dpi, sheet dimensions, etc.) —
   * not a delta. originalCompositeFilename is set on first create
   * and preserved across updates.
   */
  upsert({
    orderId,
    cartId,
    layoutId,
    variant,
    layoutSnapshot,
    originalCompositeFilename = null,
    reprintCompositeFilename = null,
    createdBy = null,
    username = null,
  }) {
    this.init();
    const now = new Date().toISOString();
    const existing = this._stmts.get.get(Number(orderId), Number(cartId));
    this._stmts.upsert.run({
      order_id: Number(orderId),
      cart_id: Number(cartId),
      layout_id: String(layoutId),
      variant: String(variant),
      layout_snapshot: JSON.stringify(layoutSnapshot),
      // First write wins for original_composite_filename. Subsequent
      // updates COALESCE to keep the original.
      original_composite_filename:
        existing && existing.original_composite_filename
          ? existing.original_composite_filename
          : originalCompositeFilename,
      reprint_composite_filename: reprintCompositeFilename,
      created_at: existing ? existing.created_at : now,
      created_by: existing ? existing.created_by : createdBy,
      updated_at: now,
    });

    // Phase 16: audit-history hook. Record after the write so the
    // snapshot reflects the new state. The layout snapshot itself
    // is excluded from the history JSON (large, rarely useful) —
    // we just record the metadata diff.
    this._recordHistory({
      orderId,
      cartId,
      action: existing ? 'update' : 'insert',
      prev: existing
        ? {
            layoutId: existing.layout_id,
            variant: existing.variant,
            originalCompositeFilename: existing.original_composite_filename,
            reprintCompositeFilename: existing.reprint_composite_filename,
            updatedAt: existing.updated_at,
          }
        : null,
      next: {
        layoutId: String(layoutId),
        variant: String(variant),
        originalCompositeFilename:
          existing && existing.original_composite_filename
            ? existing.original_composite_filename
            : originalCompositeFilename,
        reprintCompositeFilename,
        updatedAt: now,
      },
      username,
    });

    return this.get(orderId, cartId);
  }

  /**
   * Mark a reprint filename on an existing override (after a
   * successful reprint render).
   */
  setReprintFilename(orderId, cartId, filename, { username = null } = {}) {
    this.init();
    const now = new Date().toISOString();
    const existing = this._stmts.get.get(Number(orderId), Number(cartId));
    this._stmts.setReprintFilename.run(
      filename,
      now,
      Number(orderId),
      Number(cartId)
    );
    if (existing) {
      this._recordHistory({
        orderId,
        cartId,
        action: 'update',
        prev: {
          layoutId: existing.layout_id,
          variant: existing.variant,
          reprintCompositeFilename: existing.reprint_composite_filename,
        },
        next: {
          layoutId: existing.layout_id,
          variant: existing.variant,
          reprintCompositeFilename: filename,
        },
        username,
      });
    }
  }

  /**
   * Remove an override row. Returns true if a row was deleted.
   * The on-disk image isn't touched here — that's the caller's
   * responsibility (typically: re-render with the original layout
   * to overwrite the bad output).
   */
  remove(orderId, cartId, { username = null } = {}) {
    this.init();
    const existing = this._stmts.get.get(Number(orderId), Number(cartId));
    const result = this._stmts.delete.run(
      Number(orderId),
      Number(cartId)
    );
    if (result.changes > 0 && existing) {
      this._recordHistory({
        orderId,
        cartId,
        action: 'delete',
        prev: {
          layoutId: existing.layout_id,
          variant: existing.variant,
          originalCompositeFilename: existing.original_composite_filename,
          reprintCompositeFilename: existing.reprint_composite_filename,
        },
        next: null,
        username,
      });
    }
    return result.changes > 0;
  }

  // Phase 16: write one row to config_history. Lazy-loaded to avoid
  // a require cycle at module load (database.js depends on this file
  // not existing yet on first migration boot).
  _recordHistory({ orderId, cartId, action, prev, next, username }) {
    try {
      const configHistory = require('./configHistoryService');
      configHistory.record({
        configType: 'order_override',
        entityId: `${orderId}:${cartId}`,
        action,
        prevValue: prev,
        newValue: next,
        username,
      });
    } catch (err) {
      // Don't let history failures break the primary write. Log and
      // move on — the data change committed in its own transaction.
      console.warn(
        `[orderOverrideService] history record failed: ${err.message}`
      );
    }
  }
}

module.exports = new OrderOverrideService();
