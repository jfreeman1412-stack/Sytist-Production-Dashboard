// ─────────────────────────────────────────────────────────────
// composedThumbnailCacheService.js — SQLite cache mapping
// (orderId, cartId) → composed thumbnail public URL
// ─────────────────────────────────────────────────────────────
//
// Phase 43. Why this exists:
//
// composedThumbnailService.publish() uploads a composed JPEG to S3
// (or wherever the configured backend stores it) and returns a
// public URL. That URL gets attached to the line item as
// `li.composedImageUrl` for the duration of the Process call.
//
// But Push Packaging is a separate code path that:
//   - reads order state fresh from Sytist
//   - rebuilds the SS payload
//   - doesn't run Step 1.4 (no compose, no S3 upload)
//
// Without a cache, Push Packaging can't know about previously
// published thumbnails — `li.composedImageUrl` is always
// undefined, and we'd fall back to the raw thumbUrl (the
// keyed-out subject without background).
//
// This cache stores the URL produced during Process so any later
// code path — Push Packaging, but also potentially a future
// "preview SS payload" view — can hydrate the URL onto the line
// item without re-doing the compose work.
//
// Lifetime: rows are written during processOrder Step 1.4. They
// stay until the scheduler detects the order's status flip to
// Shipped, at which point cleanup() removes them (along with the
// S3 objects via composedThumbnailService.cleanup).
//
// Schema is intentionally narrow: cart_id is TEXT because package
// constituents have synthetic IDs like "482071-pkg-27" that aren't
// valid integers.

const path = require('path');
const fs = require('fs');

let Database;
try {
  // eslint-disable-next-line global-require
  Database = require('better-sqlite3');
} catch (e) {
  console.warn(
    '[composedThumbnailCacheService] better-sqlite3 not loadable; cache disabled'
  );
}

class ComposedThumbnailCacheService {
  constructor() {
    this._db = null;
    this._stmts = null;
  }

  init() {
    if (this._db) return this._db;
    if (!Database) {
      throw new Error(
        'better-sqlite3 not available — cannot init composedThumbnailCacheService'
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

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS composed_thumbnails (
        order_id    TEXT NOT NULL,
        cart_id     TEXT NOT NULL,
        public_url  TEXT NOT NULL,
        backend     TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT,
        PRIMARY KEY (order_id, cart_id)
      );
      CREATE INDEX IF NOT EXISTS composed_thumbnails_order_idx
        ON composed_thumbnails(order_id);
    `);

    this._stmts = {
      upsert: this._db.prepare(`
        INSERT INTO composed_thumbnails
          (order_id, cart_id, public_url, backend, created_at, updated_at)
        VALUES
          (@order_id, @cart_id, @public_url, @backend, @now, @now)
        ON CONFLICT(order_id, cart_id) DO UPDATE SET
          public_url = excluded.public_url,
          backend    = excluded.backend,
          updated_at = excluded.updated_at
      `),
      listByOrder: this._db.prepare(
        `SELECT cart_id, public_url, backend
         FROM composed_thumbnails
         WHERE order_id = ?`
      ),
      deleteByOrder: this._db.prepare(
        `DELETE FROM composed_thumbnails WHERE order_id = ?`
      ),
      deleteOne: this._db.prepare(
        `DELETE FROM composed_thumbnails
         WHERE order_id = ? AND cart_id = ?`
      ),
    };

    console.log(
      `[composedThumbnailCacheService] Initialized at ${dbPath}`
    );
    return this._db;
  }

  /**
   * Store the public URL for a (orderId, cartId) pair. Idempotent:
   * re-calling overwrites the existing row. The cart_id is coerced
   * to a string to handle both numeric Sytist IDs and synthetic
   * package-constituent IDs like "482071-pkg-27".
   */
  upsert({ orderId, cartId, publicUrl, backend }) {
    this.init();
    const now = new Date().toISOString();
    this._stmts.upsert.run({
      order_id: String(orderId),
      cart_id: String(cartId),
      public_url: String(publicUrl),
      backend: backend || null,
      now,
    });
  }

  /**
   * Get all cached thumbnail URLs for an order. Returns an array
   * (possibly empty). Used by Push Packaging to hydrate
   * composedImageUrl onto line items before SS payload build.
   */
  listByOrder(orderId) {
    this.init();
    return this._stmts.listByOrder.all(String(orderId));
  }

  /**
   * Get a single cached URL by (orderId, cartId). Returns null if
   * not cached.
   */
  getUrl(orderId, cartId) {
    const rows = this.listByOrder(orderId);
    const found = rows.find((r) => r.cart_id === String(cartId));
    return found ? found.public_url : null;
  }

  /**
   * Delete all rows for an order. Called by the scheduler after a
   * successful sync to Shipped (along with the S3 cleanup itself).
   */
  deleteByOrder(orderId) {
    this.init();
    const r = this._stmts.deleteByOrder.run(String(orderId));
    return r.changes;
  }

  /**
   * Delete a single row. Called when an individual (orderId,
   * cartId) is re-processed and we want to invalidate the cache
   * before the new compose runs. (We could rely on upsert to
   * overwrite, but explicit deletion is clearer when the new
   * compose fails — the stale URL won't linger.)
   */
  deleteOne(orderId, cartId) {
    this.init();
    const r = this._stmts.deleteOne.run(
      String(orderId),
      String(cartId)
    );
    return r.changes;
  }
}

module.exports = new ComposedThumbnailCacheService();
