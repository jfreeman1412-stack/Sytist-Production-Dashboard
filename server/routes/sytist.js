// Routes that talk to the Sytist MySQL database.
// All require auth.

const express = require('express');
const router = express.Router();

const sytistDb = require('../services/sytistDbService');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/health', async (req, res) => {
  try {
    const result = await sytistDb.healthCheck();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, code: err.code });
  }
});

// ─── Dev-only debug endpoints (removed in phase 3) ─────────

router.get('/_describe', async (req, res) => {
  try {
    const table = req.query.table;
    if (!table || !/^ms_[a-z_]+$/i.test(table)) {
      return res.status(400).json({ error: 'table query param required, must match ms_*' });
    }
    const pool = sytistDb.getPool();
    const [rows] = await pool.query(`DESCRIBE \`${table}\``);
    res.json({ table, columns: rows });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.get('/_sample', async (req, res) => {
  try {
    const { table, where = '1=1' } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '2', 10), 5);

    if (!table || !/^ms_[a-z_]+$/i.test(table)) {
      return res.status(400).json({ error: 'table query param required, must match ms_*' });
    }
    if (/[;]|--|\/\*|\bunion\b/i.test(where)) {
      return res.status(400).json({ error: 'where clause contains forbidden tokens' });
    }

    const pool = sytistDb.getPool();
    const [rows] = await pool.query(
      `SELECT * FROM \`${table}\` WHERE ${where} ORDER BY 1 DESC LIMIT ${limit}`
    );

    const truncated = rows.map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'string' && v.length > 250) {
          out[k] = v.slice(0, 250) + `…[+${v.length - 250} chars]`;
        } else {
          out[k] = v;
        }
      }
      return out;
    });

    res.json({ table, where, limit, rows: truncated });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.get('/_shipping-options', async (req, res) => {
  try {
    const monthsBack = parseInt(req.query.monthsBack || '18', 10);
    const pool = sytistDb.getPool();
    const [rows] = await pool.query(
      `
      SELECT
        order_shipping_option AS optionName,
        COUNT(*)              AS orderCount,
        MIN(order_shipping)   AS minShipping,
        MAX(order_shipping)   AS maxShipping,
        AVG(order_shipping)   AS avgShipping,
        MAX(order_date)       AS lastOrderDate
      FROM ms_orders
      WHERE order_payment_status = 'Completed'
        AND order_status = 0
        AND order_erased = 0
        AND order_date >= DATE_SUB(NOW(), INTERVAL ? MONTH)
      GROUP BY order_shipping_option
      ORDER BY orderCount DESC
      `,
      [monthsBack]
    );
    res.json({
      meta: { monthsBack, distinctOptions: rows.length },
      options: rows.map((r) => ({
        optionName: r.optionName,
        orderCount: Number(r.orderCount),
        shipping: {
          min: Number(r.minShipping),
          max: Number(r.maxShipping),
          avg: Number(Number(r.avgShipping).toFixed(2)),
        },
        lastOrderDate: r.lastOrderDate,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// ─── Real endpoints ────────────────────────────────────────

router.get('/order-statuses', async (req, res) => {
  try {
    const statuses = await sytistDb.getOrderStatuses();
    res.json({ statuses });
  } catch (err) {
    console.error('[sytist/order-statuses]', err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

router.get('/galleries', async (req, res) => {
  try {
    const monthsBack =
      req.query.monthsBack !== undefined
        ? parseInt(req.query.monthsBack, 10)
        : 18;
    if (Number.isNaN(monthsBack) || monthsBack < 0) {
      return res
        .status(400)
        .json({ error: 'monthsBack must be a non-negative integer' });
    }

    const start = Date.now();
    const galleries = await sytistDb.getGalleryHierarchy({ monthsBack });
    const elapsedMs = Date.now() - start;

    res.json({
      galleries,
      meta: { count: galleries.length, monthsBack, elapsedMs },
    });
  } catch (err) {
    console.error('[sytist/galleries]', err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

/**
 * GET /api/sytist/orders
 *
 * Real orders endpoint. Returns canonical-shaped orders.
 *
 * Query params:
 *   workflow         — 'ship_to_home' | 'ship_to_managers' | 'ship_to_league' | 'all'
 *   productionStatus — number (default 0 = Queue) or 'all'
 *   limit            — pagination size (default 50, max 1000)
 *   offset           — pagination offset (default 0)
 *   galleryId        — optional filter
 *   subGalleryId     — optional filter
 */
router.get('/orders', async (req, res) => {
  try {
    const opts = {};
    if (req.query.workflow) opts.workflow = req.query.workflow;
    if (req.query.productionStatus !== undefined) {
      opts.productionStatus =
        req.query.productionStatus === 'all'
          ? 'all'
          : parseInt(req.query.productionStatus, 10);
    }
    if (req.query.limit) opts.limit = parseInt(req.query.limit, 10);
    if (req.query.offset) opts.offset = parseInt(req.query.offset, 10);
    if (req.query.galleryId) opts.galleryId = parseInt(req.query.galleryId, 10);
    if (req.query.subGalleryId)
      opts.subGalleryId = parseInt(req.query.subGalleryId, 10);

    const result = await sytistDb.getOrdersByWorkflow(opts);
    res.json(result);
  } catch (err) {
    console.error('[sytist/orders]', err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

/**
 * GET /api/sytist/orders/test
 *
 * Convenience endpoint — returns 5 most recent open paid orders with full
 * canonical shape. Used during phase 2b development for visual inspection.
 *
 * Will be kept through phase 3 for debugging; removed before phase 4.
 */
router.get('/orders/test', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '5', 10), 20);
    const result = await sytistDb.getOrdersByWorkflow({
      workflow: 'all',
      productionStatus: 'all',
      limit,
    });
    res.json(result);
  } catch (err) {
    console.error('[sytist/orders/test]', err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
