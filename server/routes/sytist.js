// Routes that talk to the Sytist MySQL database.
// All require auth.

const express = require('express');
const router = express.Router();

const sytistDb = require('../services/sytistDbService');
const pathsService = require('../services/pathsService');
const folderSortService = require('../services/folderSortService');
const darkroomService = require('../services/darkroomService');
const { requireAuth, requireRole } = require('../middleware/auth');

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

/**
 * GET /api/sytist/shipping-options
 *
 * Real endpoint (promoted from debug). Returns the list of distinct
 * order_shipping_option strings seen in recent completed open orders, with
 * order count and last-seen date.
 *
 * Used by the orders list filter dropdown so the dashboard discovers any new
 * shipping options operators add in Sytist without a code change.
 *
 * Query params:
 *   monthsBack — how far back to scan (default 18, 0 = all-time)
 */
router.get('/shipping-options', async (req, res) => {
  try {
    const monthsBack = parseInt(req.query.monthsBack || '18', 10);
    const pool = sytistDb.getPool();
    const [rows] = await pool.query(
      `
      SELECT
        order_shipping_option AS optionName,
        COUNT(*)              AS orderCount,
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
        lastOrderDate: r.lastOrderDate,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

/**
 * GET /api/sytist/order-counts
 * Aggregates for the home dashboard stat cards. See sytistDbService for shape.
 */
router.get('/order-counts', async (req, res) => {
  try {
    const counts = await sytistDb.getOrderCounts();
    res.json(counts);
  } catch (err) {
    console.error('[sytist/order-counts]', err);
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
 * Returns canonical-shaped orders matching the filter. See sytistDbService
 * for the full param list.
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
    if (req.query.shippingOption) opts.shippingOption = req.query.shippingOption;
    if (req.query.sort) opts.sort = req.query.sort;

    const result = await sytistDb.getOrdersByWorkflow(opts);
    res.json(result);
  } catch (err) {
    console.error('[sytist/orders]', err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

/**
 * GET /api/sytist/orders/test
 * Convenience endpoint — returns recent open paid orders. Removed before phase 4.
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

/**
 * GET /api/sytist/orders/:orderId
 * Returns a single canonical-shaped order, or 404 if not found.
 */
router.get('/orders/:orderId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ order });
  } catch (err) {
    console.error('[sytist/orders/:orderId]', err);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

/**
 * PUT /api/sytist/orders/:orderId/status
 * Body: { statusId: number }
 *
 * Updates ms_orders.order_open_status. Requires admin or operator role.
 * Viewers cannot write.
 *
 * Response:
 *   {
 *     success: true,
 *     orderId: 110855,
 *     previousStatus: { id: 0, name: "Queue" },
 *     newStatus:      { id: 40, name: "Printing and Production" },
 *     affectedRows: 1
 *   }
 */
router.put(
  '/orders/:orderId/status',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const { statusId } = req.body || {};
      if (statusId === undefined || statusId === null) {
        return res
          .status(400)
          .json({ error: 'Request body must include { statusId: number }' });
      }

      const result = await sytistDb.updateOrderStatus(
        req.params.orderId,
        statusId
      );
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[sytist/orders/:orderId/status]', err);
      const isClientError =
        /not found|invalid|erased|does not exist/i.test(err.message);
      res.status(isClientError ? 400 : 500).json({
        error: err.message,
        code: err.code,
      });
    }
  }
);

// ─── Phase 4.1: paths + folder sort ────────────────────────
//
// Path resolution and folder-sort configuration. NO file writes happen here —
// these endpoints only compute where files WOULD land for a given order. The
// actual writes come in 4.2+ once we've verified the resolved paths look
// correct against real orders.

/**
 * GET /api/sytist/paths/config
 *
 * Returns the current paths + folder-sort config snapshot. Used by an admin
 * settings panel and as a sanity check ("which mode am I in right now?").
 */
router.get('/paths/config', async (req, res) => {
  try {
    const sortLevels = await folderSortService.getSortLevels();
    res.json({
      paths: pathsService.describe(),
      folderSort: {
        currentLevels: sortLevels,
        availableOptions: folderSortService.getSortOptions(),
      },
    });
  } catch (err) {
    console.error('[sytist/paths/config]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/sytist/paths/folder-sort
 * Body: { sortLevels: ["gallery", "sub_gallery"] }
 *
 * Updates the folder-sort config. Admin only — operators shouldn't be
 * changing where files land mid-shift.
 */
router.put(
  '/paths/folder-sort',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { sortLevels } = req.body || {};
      if (!Array.isArray(sortLevels)) {
        return res.status(400).json({
          error: 'Request body must include { sortLevels: string[] }',
        });
      }
      const updated = await folderSortService.setSortLevels(sortLevels);
      res.json({ success: true, sortLevels: updated });
    } catch (err) {
      console.error('[sytist/paths/folder-sort]', err);
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * GET /api/sytist/paths/preview/:orderId
 *
 * Returns where files WOULD land for the given order, without writing
 * anything. Pulls the canonical order, asks folderSortService for the
 * segments, then asks pathsService to compose them with the base templates.
 *
 * Response shape (excerpt):
 *   {
 *     mode: "test",
 *     orderId: "110855",
 *     orderDate: "2025-11-12 09:14:22",
 *     workflow: "ship_to_home",
 *     sortLevels: ["no_sort"],
 *     sortSegments: [],
 *     paths: {
 *       downloadBase: {
 *         template: "C:\\Users\\Sportsline\\Downloads\\sytist-dashboard-test-output\\{date}",
 *         base:     "C:\\Users\\Sportsline\\Downloads\\sytist-dashboard-test-output\\2025-11-12",
 *         full:     "C:\\Users\\Sportsline\\Downloads\\sytist-dashboard-test-output\\2025-11-12"
 *       },
 *       darkroomTxtBase:     { ... },
 *       packingSlipBase:     { ... },
 *       impositionBase:      { ... },
 *       darkroomTemplateBase: { ... }
 *     }
 *   }
 */
router.get('/paths/preview/:orderId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const sortLevels = await folderSortService.getSortLevels();
    const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);
    const preview = pathsService.buildPreview(order, sortSegments, sortLevels);

    res.json(preview);
  } catch (err) {
    console.error('[sytist/paths/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Phase 4.2: darkroom .txt preview + config ─────────────
//
// Preview-only endpoints. Nothing in this section writes files. The
// /darkroom/preview/:orderId endpoint renders the .txt body as a string
// alongside its target path; the config endpoints let operators inspect
// (and eventually edit, via the future settings UI) the size/template/
// filename mappings the service uses.
//
// The actual disk write — darkroomService.writeTxtFile() — exists but is
// not wired to any route. Phase 4.6 will add the "Process this order"
// orchestration that calls it.

/**
 * GET /api/sytist/darkroom/preview/:orderId
 *
 * Renders the .txt body for the given order without touching disk.
 *
 * Query params:
 *   slipPath         — optional absolute path to a packing slip JPG. When
 *                       given, a 5x8 line for it is included in the txt.
 *   slipPosition     — 'first' | 'last' (default 'last' — Sportsline
 *                       prints slip on top of the customer stack).
 *   teamSubGalleryId — when given, only line items belonging to that
 *                       sub-gallery are included (per-team chunk preview
 *                       for non-home sibling orders).
 *
 * Response:
 *   {
 *     filename, filePath, targetDir, imageDir,
 *     content: string,
 *     printItems: [...], skippedItems: [...], warnings: [...],
 *     packingSlip: { included, position, path },
 *     meta: { ... }
 *   }
 */
router.get('/darkroom/preview/:orderId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const sortLevels = await folderSortService.getSortLevels();
    const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);

    const slipPath = req.query.slipPath || null;
    const slipPosition =
      req.query.slipPosition === 'first' ? 'first' : 'last';

    let teamScope = null;
    if (req.query.teamSubGalleryId) {
      const id = parseInt(req.query.teamSubGalleryId, 10);
      if (!Number.isNaN(id)) {
        const matchingLine = (order.lineItems || []).find(
          (li) => li.subGalleryId === id
        );
        teamScope = {
          subGalleryId: id,
          subGalleryName: matchingLine ? matchingLine.subGalleryName : '',
        };
      }
    }

    const result = await darkroomService.buildOrderTxt(order, {
      sortSegments,
      packingSlipPath: slipPath,
      slipPosition,
      teamScope,
    });

    res.json({
      ...result,
      sortLevels,
      sortSegments,
    });
  } catch (err) {
    console.error('[sytist/darkroom/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/darkroom/config
 *
 * Returns the current size mappings, template mappings, and filename
 * config in one snapshot. Used by the settings UI (future) and as a
 * sanity-check endpoint.
 */
router.get('/darkroom/config', async (req, res) => {
  try {
    const [sizeMappings, templateMappings, filenameConfig] = await Promise.all([
      darkroomService.getSizeMappings(),
      darkroomService.getTemplateMappings(),
      darkroomService.getFilenameConfig(),
    ]);
    res.json({
      sizeMappings,
      templateMappings,
      filenameConfig,
      defaultSize: darkroomService.DEFAULT_SIZE,
      skipFlags: darkroomService.SKIP_FLAGS,
    });
  } catch (err) {
    console.error('[sytist/darkroom/config]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Size-mapping CRUD (admin only) ───────────────────────

router.post(
  '/darkroom/size-mappings',
  requireRole('admin'),
  async (req, res) => {
    try {
      const mappings = await darkroomService.addSizeMapping(req.body || {});
      res.json({ success: true, mappings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.put(
  '/darkroom/size-mappings/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await darkroomService.updateSizeMapping(
        req.params.externalId,
        req.body || {}
      );
      res.json({ success: true, mapping: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.delete(
  '/darkroom/size-mappings/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const mappings = await darkroomService.deleteSizeMapping(
        req.params.externalId
      );
      res.json({ success: true, mappings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Template-mapping CRUD (admin only) ───────────────────

router.post(
  '/darkroom/template-mappings',
  requireRole('admin'),
  async (req, res) => {
    try {
      const mappings = await darkroomService.addTemplateMapping(req.body || {});
      res.json({ success: true, mappings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.put(
  '/darkroom/template-mappings/:id',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await darkroomService.updateTemplateMapping(
        req.params.id,
        req.body || {}
      );
      res.json({ success: true, mapping: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.delete(
  '/darkroom/template-mappings/:id',
  requireRole('admin'),
  async (req, res) => {
    try {
      const mappings = await darkroomService.deleteTemplateMapping(
        req.params.id
      );
      res.json({ success: true, mappings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Filename config (admin only) ─────────────────────────

router.put(
  '/darkroom/filename-config',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await darkroomService.updateFilenameConfig(req.body || {});
      res.json({ success: true, filenameConfig: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

module.exports = router;
