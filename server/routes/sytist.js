// Routes that talk to the Sytist MySQL database.
// All require auth — we don't expose Sytist data to unauthenticated callers.

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
    res.status(503).json({
      ok: false,
      error: err.message,
      code: err.code,
    });
  }
});

/**
 * GET /api/sytist/_describe?table=ms_order_status
 * Dev-only debug endpoint — returns column info for any ms_* table.
 * Used during phase 2b development to align queries with reality.
 * Will be removed in phase 3.
 */
router.get('/_describe', async (req, res) => {
  try {
    const table = req.query.table;
    if (!table || !/^ms_[a-z_]+$/i.test(table)) {
      return res
        .status(400)
        .json({ error: 'table query param required, must match ms_*' });
    }
    const pool = sytistDb.getPool();
    const [rows] = await pool.query(`DESCRIBE \`${table}\``);
    res.json({ table, columns: rows });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

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
      meta: {
        count: galleries.length,
        monthsBack,
        elapsedMs,
      },
    });
  } catch (err) {
    console.error('[sytist/galleries]', err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
