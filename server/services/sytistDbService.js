// Sytist MySQL data layer.
//
// Phase 2a: connection pool + healthCheck.
// Phase 2b Step 1: simple lookup queries — order statuses + galleries.
// Phase 2b Step 2/3 (next): order list + order detail.
// Phase 2c (later): updateOrderStatus.

const mysql = require('mysql2/promise');

class SytistDbService {
  constructor() {
    this.pool = null;
    this._lastError = null;
  }

  init() {
    if (this.pool) return this.pool;

    const config = {
      host: process.env.SYTIST_DB_HOST,
      port: parseInt(process.env.SYTIST_DB_PORT || '3306', 10),
      user: process.env.SYTIST_DB_USER,
      password: process.env.SYTIST_DB_PASSWORD,
      database: process.env.SYTIST_DB_NAME,
      connectionLimit: 5,
      queueLimit: 0,
      waitForConnections: true,
      charset: 'utf8mb4',
      connectTimeout: 10_000,
      // Sytist tables use '0000-00-00' default dates; return strings so we
      // can detect/handle these without timezone surprises.
      dateStrings: true,
    };

    if (!config.host || !config.user || !config.database) {
      throw new Error(
        'SYTIST_DB_HOST, SYTIST_DB_USER, and SYTIST_DB_NAME must be set in .env'
      );
    }

    this.pool = mysql.createPool(config);

    console.log(
      `[SytistDB] Pool created → ${config.user}@${config.host}:${config.port}/${config.database}`
    );
    return this.pool;
  }

  getPool() {
    if (!this.pool) this.init();
    return this.pool;
  }

  /**
   * Quick connectivity check.
   */
  async healthCheck() {
    const pool = this.getPool();
    const start = Date.now();

    try {
      const [[ping]] = await pool.query('SELECT 1 AS ok');
      const [[ident]] = await pool.query(
        'SELECT DATABASE() AS db, VERSION() AS version, USER() AS user'
      );
      const elapsedMs = Date.now() - start;

      this._lastError = null;
      return {
        ok: ping.ok === 1,
        database: ident.db,
        version: ident.version,
        user: ident.user,
        elapsedMs,
      };
    } catch (err) {
      this._lastError = err;
      const safeMsg = String(err.message || err)
        .replace(/password=[^&\s]+/gi, 'password=***')
        .replace(/PASSWORD\s*=\s*'[^']*'/gi, "PASSWORD='***'");
      const wrapped = new Error(`Sytist DB health check failed: ${safeMsg}`);
      wrapped.code = err.code;
      throw wrapped;
    }
  }

  // ─── Lookup queries ────────────────────────────────────

  /**
   * Returns all rows from ms_order_status.
   *
   * Actual columns (verified via DESCRIBE):
   *   status_id, status_name, status_descr, status_show_order
   *
   * Sorted by status_show_order (Sytist's own display order), then name.
   * Status 0 ("Queue") has no row — render it client-side when needed.
   */
  async getOrderStatuses() {
    const pool = this.getPool();
    const [rows] = await pool.query(
      `SELECT status_id, status_name, status_descr, status_show_order
       FROM ms_order_status
       ORDER BY status_show_order, status_name`
    );

    return rows.map((r) => ({
      id: r.status_id,
      name: r.status_name,
      description: r.status_descr || '',
      showOrder: r.status_show_order,
    }));
  }

  /**
   * Returns the gallery hierarchy for filter UI.
   *
   * Scope: galleries (ms_calendar rows) that have at least one order in the
   * last `monthsBack` months (default 18). Each gallery includes its category
   * name and any sub-galleries (teams) that also have order activity.
   *
   * Defaulting to 18 months captures all currently-relevant galleries without
   * dragging in years of stale data. Use { monthsBack: 0 } for unfiltered.
   *
   * Shape:
   *   [
   *     {
   *       galleryId: 12345,
   *       galleryName: "2026 PACT Trap Photo Day",
   *       categoryId: 678,
   *       categoryName: "PACT Charter School",
   *       orderCount: 14,
   *       lastOrderDate: "2026-05-08",
   *       subGalleries: [
   *         { subId: 99001, subName: "Pact Trap", orderCount: 8, lastOrderDate: "..." },
   *         ...
   *       ]
   *     },
   *     ...
   *   ]
   */
  async getGalleryHierarchy({ monthsBack = 18 } = {}) {
    const pool = this.getPool();

    const dateFilter =
      monthsBack > 0
        ? `AND o.order_date >= DATE_SUB(NOW(), INTERVAL ? MONTH)`
        : '';
    const dateParams = monthsBack > 0 ? [monthsBack] : [];

    // 1. Galleries with order activity, with their category info.
    //
    //    Joins ms_calendar.date_id ← ms_cart.cart_pic_date_id ← ms_orders.order_id.
    //    Restricted to order_status=0 (Open) and order_payment_status='Completed'
    //    so we don't count trashed/archived/unpaid orders.
    const [galleries] = await pool.query(
      `
      SELECT
        cal.date_id        AS galleryId,
        cal.date_title     AS galleryName,
        cat.cat_id         AS categoryId,
        cat.cat_name       AS categoryName,
        COUNT(DISTINCT o.order_id) AS orderCount,
        MAX(o.order_date)  AS lastOrderDate
      FROM ms_calendar cal
      LEFT JOIN ms_blog_categories cat ON cat.cat_id = cal.date_cat
      INNER JOIN ms_cart c   ON c.cart_pic_date_id = cal.date_id
      INNER JOIN ms_orders o ON o.order_id = c.cart_order
      WHERE o.order_status = 0
        AND o.order_payment_status = 'Completed'
        ${dateFilter}
      GROUP BY cal.date_id, cal.date_title, cat.cat_id, cat.cat_name
      ORDER BY MAX(o.order_date) DESC
      `,
      dateParams
    );

    if (galleries.length === 0) return [];

    // 2. Sub-galleries for those gallery IDs, also restricted to ones with
    //    order activity.
    const galleryIds = galleries.map((g) => g.galleryId);
    const [subRows] = await pool.query(
      `
      SELECT
        sub.sub_id          AS subId,
        sub.sub_date_id     AS galleryId,
        sub.sub_name        AS subName,
        COUNT(DISTINCT o.order_id) AS orderCount,
        MAX(o.order_date)   AS lastOrderDate
      FROM ms_sub_galleries sub
      INNER JOIN ms_cart c   ON c.cart_sub_gal_id = sub.sub_id
      INNER JOIN ms_orders o ON o.order_id = c.cart_order
      WHERE sub.sub_date_id IN (?)
        AND o.order_status = 0
        AND o.order_payment_status = 'Completed'
        ${dateFilter}
      GROUP BY sub.sub_id, sub.sub_date_id, sub.sub_name
      ORDER BY sub.sub_name
      `,
      [galleryIds, ...dateParams]
    );

    // Bucket subs by gallery for quick lookup.
    const subsByGallery = new Map();
    for (const s of subRows) {
      const list = subsByGallery.get(s.galleryId) || [];
      list.push({
        subId: s.subId,
        subName: s.subName,
        orderCount: Number(s.orderCount),
        lastOrderDate: s.lastOrderDate,
      });
      subsByGallery.set(s.galleryId, list);
    }

    return galleries.map((g) => ({
      galleryId: g.galleryId,
      galleryName: g.galleryName,
      categoryId: g.categoryId,
      categoryName: g.categoryName,
      orderCount: Number(g.orderCount),
      lastOrderDate: g.lastOrderDate,
      subGalleries: subsByGallery.get(g.galleryId) || [],
    }));
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = new SytistDbService();
