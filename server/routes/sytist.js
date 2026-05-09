// Routes that talk to the Sytist MySQL database.
// All require auth.

const express = require('express');
const router = express.Router();

const sytistDb = require('../services/sytistDbService');
const pathsService = require('../services/pathsService');
const folderSortService = require('../services/folderSortService');
const darkroomService = require('../services/darkroomService');
const packingSlipService = require('../services/packingSlipService');
const teamDividerService = require('../services/teamDividerService');
const impositionService = require('../services/impositionService');
const processingService = require('../services/processingService');
const processHistoryService = require('../services/processHistoryService');
const specialtyService = require('../services/specialtyService');
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
 * GET /api/sytist/paths/config/full
 *
 * Returns the full paths config (templates for ALL modes, not just the
 * active one). Used by the Settings UI so operators can edit test +
 * production templates side by side.
 */
router.get('/paths/config/full', async (req, res) => {
  try {
    res.json(pathsService.describeFull());
  } catch (err) {
    console.error('[sytist/paths/config/full]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/sytist/paths/mode
 * Body: { mode: 'test' | 'production' }
 *
 * Switches the active path mode. Admin only — this is the safety switch
 * that determines whether files land in the test sandbox or on the live
 * Z: share.
 */
router.put(
  '/paths/mode',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!mode) {
        return res.status(400).json({ error: 'mode is required' });
      }
      const updated = pathsService.setMode(mode);
      res.json({ success: true, mode: updated });
    } catch (err) {
      console.error('[sytist/paths/mode]', err);
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * PUT /api/sytist/paths/templates/:mode/:outputType
 * Body: { template: '...' }
 *
 * Updates a single template under a specific mode. Admin only.
 */
router.put(
  '/paths/templates/:mode/:outputType',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { template } = req.body || {};
      if (typeof template !== 'string') {
        return res.status(400).json({ error: 'template is required (string)' });
      }
      const updated = pathsService.setTemplate(
        req.params.mode,
        req.params.outputType,
        template
      );
      res.json({ success: true, template: updated });
    } catch (err) {
      console.error('[sytist/paths/templates]', err);
      res.status(400).json({ error: err.message });
    }
  }
);

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
 * POST /api/sytist/paths/preflight
 * Body: { mode: 'test' | 'production' }
 *
 * Phase 4.7 — verifies write access for every output path under the
 * requested mode. Tests mkdir + write + read + delete on a small marker
 * file. Returns per-output-type results so the operator can see exactly
 * which paths are healthy before flipping modes.
 *
 * Admin only since this is part of the production-switch workflow.
 */
router.post(
  '/paths/preflight',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { mode } = req.body || {};
      const result = await pathsService.preflightCheck(mode || null);
      res.json(result);
    } catch (err) {
      console.error('[sytist/paths/preflight]', err);
      res.status(500).json({ error: err.message });
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

// ─── Phase 4.3: packing slip + team divider ───────────────
//
// Preview-by-default endpoints. The streaming preview routes return
// image/jpeg directly so the operator can open them in a new tab without
// any file landing on disk. The /save variants write to the test sandbox
// (same downloadBase tree the .txt would land in) so operators can sanity
// check what the actual file would look like in a folder.
//
// As with darkroom, neither writeSlipFile() nor writeDividerFile() is
// called from any "production write" route in 4.3. Phase 4.6 will
// orchestrate the real writes.

/**
 * GET /api/sytist/slip/preview/:orderId
 *
 * Streams a freshly-rendered slip JPG back as image/jpeg. Open in a new
 * tab to view, or right-click → save-as to grab a copy.
 *
 * Query params:
 *   teamSubGalleryId — when given, the slip only shows items belonging
 *                       to that sub-gallery (per-team chunk preview for
 *                       non-home siblings).
 */
router.get('/slip/preview/:orderId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const sortLevels = await folderSortService.getSortLevels();
    const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);

    let teamScope = null;
    if (req.query.teamSubGalleryId) {
      const id = parseInt(req.query.teamSubGalleryId, 10);
      if (!Number.isNaN(id)) {
        const matching = (order.lineItems || []).find((li) => li.subGalleryId === id);
        teamScope = {
          subGalleryId: id,
          subGalleryName: matching ? matching.subGalleryName : '',
        };
      }
    }

    const result = await packingSlipService.buildSlipBuffer(order, {
      sortSegments,
      teamScope,
    });

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Length', String(result.buffer.length));
    res.set('X-Slip-Filename', result.filename);
    res.set('X-Slip-Skipped-Count', String(result.meta.skippedCount));
    res.set('X-Slip-Warning-Count', String(result.warnings.length));
    res.set('Cache-Control', 'no-store');
    res.send(result.buffer);
  } catch (err) {
    console.error('[sytist/slip/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/slip/preview/:orderId/save
 *
 * Renders the slip and writes it under the test sandbox with a "_preview"
 * suffix (so it doesn't clobber a future production slip). Returns the
 * full path + meta so the UI can show "saved to X".
 *
 * Path mode is enforced — refuse to save when path-overrides.json mode is
 * "production", since this endpoint is explicitly for previewing.
 */
router.post('/slip/preview/:orderId/save', async (req, res) => {
  try {
    if (pathsService.getMode() === 'production') {
      return res.status(403).json({
        error:
          'Path mode is "production"; preview/save is sandbox-only. Switch path-overrides.json to mode "test" first.',
      });
    }

    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const sortLevels = await folderSortService.getSortLevels();
    const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);

    let teamScope = null;
    if (req.body && req.body.teamSubGalleryId) {
      const id = parseInt(req.body.teamSubGalleryId, 10);
      if (!Number.isNaN(id)) {
        const matching = (order.lineItems || []).find((li) => li.subGalleryId === id);
        teamScope = {
          subGalleryId: id,
          subGalleryName: matching ? matching.subGalleryName : '',
        };
      }
    }

    const built = await packingSlipService.buildSlipBuffer(order, {
      sortSegments,
      teamScope,
      filenameSuffix: '_preview',
    });
    const written = await packingSlipService.writeSlipFile(built);

    res.json({
      success: true,
      filePath: written.filePath,
      filename: written.filename,
      meta: built.meta,
      warnings: built.warnings,
      skippedItems: built.skippedItems,
    });
  } catch (err) {
    console.error('[sytist/slip/preview/save]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/slip/preview/:orderId/info
 *
 * Returns the slip preview metadata (filename, target path, warnings,
 * skipped items) WITHOUT the JPG buffer. Used by the order-detail UI to
 * show a summary block alongside the inline image preview without
 * double-rendering the slip.
 */
router.get('/slip/preview/:orderId/info', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const sortLevels = await folderSortService.getSortLevels();
    const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);

    let teamScope = null;
    if (req.query.teamSubGalleryId) {
      const id = parseInt(req.query.teamSubGalleryId, 10);
      if (!Number.isNaN(id)) {
        const matching = (order.lineItems || []).find((li) => li.subGalleryId === id);
        teamScope = {
          subGalleryId: id,
          subGalleryName: matching ? matching.subGalleryName : '',
        };
      }
    }

    const built = await packingSlipService.buildSlipBuffer(order, {
      sortSegments,
      teamScope,
    });

    // Return metadata only (omit buffer)
    res.json({
      filename: built.filename,
      filePath: built.filePath,
      targetDir: built.targetDir,
      printedItems: built.printedItems,
      skippedItems: built.skippedItems,
      warnings: built.warnings,
      meta: built.meta,
    });
  } catch (err) {
    console.error('[sytist/slip/preview/info]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/slip/config
 * GET /api/sytist/slip/config (PUT, admin) — update studio info / colors
 */
router.get('/slip/config', async (req, res) => {
  try {
    const cfg = await packingSlipService.getSlipConfig();
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/slip/config', requireRole('admin'), async (req, res) => {
  try {
    const updated = await packingSlipService.updateSlipConfig(req.body || {});
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Team divider ─────────────────────────────────────────

/**
 * GET /api/sytist/divider/preview
 *
 * Renders a divider JPG and streams it as image/jpeg. Standalone — no
 * order required. The preview UI uses this to show what a divider sheet
 * for a given team would look like.
 *
 * Query params:
 *   teamName       — required
 *   galleryName    — optional, italic line at bottom
 *   itemCount      — optional, joins the sub-line
 *   customerCount  — optional, joins the sub-line
 */
router.get('/divider/preview', async (req, res) => {
  try {
    const teamName = (req.query.teamName || '').toString().trim();
    if (!teamName) {
      return res.status(400).json({ error: 'teamName is required' });
    }

    const built = await teamDividerService.buildDividerBuffer(teamName, {
      galleryName: req.query.galleryName,
      itemCount:
        req.query.itemCount != null ? parseInt(req.query.itemCount, 10) : undefined,
      customerCount:
        req.query.customerCount != null
          ? parseInt(req.query.customerCount, 10)
          : undefined,
    });

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Length', String(built.buffer.length));
    res.set('X-Divider-Filename', built.filename);
    res.set('Cache-Control', 'no-store');
    res.send(built.buffer);
  } catch (err) {
    console.error('[sytist/divider/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/divider/preview/save
 * Body: { teamName, galleryName?, itemCount?, customerCount?, orderId? }
 *
 * Renders a divider and writes it to the test sandbox. When `orderId` is
 * provided, the divider is filed alongside that order's other artifacts;
 * otherwise it's filed under today's date partition.
 *
 * As with slip/save, refuses to write when mode === 'production'.
 */
router.post('/divider/preview/save', async (req, res) => {
  try {
    if (pathsService.getMode() === 'production') {
      return res.status(403).json({
        error:
          'Path mode is "production"; preview/save is sandbox-only. Switch path-overrides.json to mode "test" first.',
      });
    }

    const body = req.body || {};
    const teamName = (body.teamName || '').toString().trim();
    if (!teamName) {
      return res.status(400).json({ error: 'teamName is required' });
    }

    let orderForPath = null;
    let sortSegments = [];
    if (body.orderId) {
      const order = await sytistDb.getOrderById(body.orderId);
      if (!order) {
        return res.status(404).json({ error: `Order ${body.orderId} not found` });
      }
      orderForPath = order;
      const sortLevels = await folderSortService.getSortLevels();
      sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);
    } else {
      // Synthetic "order" giving a path resolver enough to land under today's date.
      orderForPath = {
        orderId: 'standalone',
        orderDate: new Date().toISOString().replace('T', ' ').slice(0, 19),
        galleryName: body.galleryName || '',
        subGalleryName: teamName,
        shipping: {},
      };
    }

    const built = await teamDividerService.buildDividerBuffer(teamName, {
      galleryName: body.galleryName,
      itemCount: body.itemCount != null ? parseInt(body.itemCount, 10) : undefined,
      customerCount:
        body.customerCount != null ? parseInt(body.customerCount, 10) : undefined,
      order: orderForPath,
      sortSegments,
      filenameSuffix: '_preview',
    });

    const written = await teamDividerService.writeDividerFile(built);
    res.json({
      success: true,
      filePath: written.filePath,
      filename: written.filename,
      meta: built.meta,
    });
  } catch (err) {
    console.error('[sytist/divider/preview/save]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Phase 4.4: imposition ────────────────────────────────
//
// Preview-by-default endpoints. The /preview route streams the imposed
// sheet back as image/jpeg directly. /preview/info returns metadata
// only (which layout matched, warnings, mapping fallback flags, etc.)
// for the UI to render alongside the inline image. /preview/save writes
// to the test sandbox so operators can verify a real file looks right.
//
// CRUD endpoints for layouts and mappings round out the API surface so
// the future settings UI can edit imposition configuration without code
// changes.
//
// composeSheetInPlace() (the photo-day-equivalent destructive overwrite)
// is NOT wired to any endpoint here. Phase 4.6 calls it after downloading
// pic_full from S3 to its target path.

/**
 * GET /api/sytist/imposition/preview/:orderId/:cartId
 *
 * Looks up the line item by cart ID, fetches its pic_full from S3, runs
 * imposition, and streams the result as image/jpeg. Auto-detects
 * orientation from the source image.
 *
 * Query params:
 *   orientation — override auto-detection ('vertical' | 'horizontal')
 */
router.get('/imposition/preview/:orderId/:cartId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const cartId = parseInt(req.params.cartId, 10);
    const lineItem = (order.lineItems || []).find((li) => li.cartId === cartId);
    if (!lineItem) {
      return res.status(404).json({ error: `Line item ${cartId} not found in order` });
    }
    if (!lineItem.photo || !lineItem.photo.fullUrl) {
      return res.status(400).json({
        error: `Line item ${cartId} has no photo URL to impose`,
      });
    }

    const orientation =
      req.query.orientation && ['vertical', 'horizontal'].includes(req.query.orientation)
        ? req.query.orientation
        : null;

    const ctx = impositionService.buildContext(order, lineItem);
    const result = await impositionService.composeFromUrl(
      lineItem.photo.fullUrl,
      lineItem.sku,
      ctx,
      orientation
    );

    if (!result.imposed) {
      return res.status(404).json({ error: result.reason });
    }

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Length', String(result.buffer.length));
    res.set('X-Imposition-Layout', result.layout.name);
    res.set('X-Imposition-Orientation', result.orientation || 'unknown');
    res.set('X-Imposition-Warning-Count', String(result.warnings.length));
    res.set('Cache-Control', 'no-store');
    res.send(result.buffer);
  } catch (err) {
    console.error('[sytist/imposition/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/imposition/preview/:orderId/:cartId/info
 *
 * Returns metadata about what layout would match the line item — without
 * fetching/rendering the image. Used by the UI to show layout name,
 * warnings, and mapping info ahead of (or instead of) loading the
 * rendered preview image.
 *
 * For real metadata we still need to detect orientation, which means
 * fetching the source image. To keep info cheap, we pass through the
 * orientation query param if given, and only auto-detect when missing.
 */
router.get('/imposition/preview/:orderId/:cartId/info', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const cartId = parseInt(req.params.cartId, 10);
    const lineItem = (order.lineItems || []).find((li) => li.cartId === cartId);
    if (!lineItem) {
      return res.status(404).json({ error: `Line item ${cartId} not found in order` });
    }

    const requestedOrientation =
      req.query.orientation && ['vertical', 'horizontal'].includes(req.query.orientation)
        ? req.query.orientation
        : null;

    // Try the requested orientation first; if absent, look up by SKU only
    // and report which mapping we'd land on.
    const sku = String(lineItem.sku || '');
    const rule = await impositionService.findRule(sku, requestedOrientation);

    if (!rule) {
      return res.json({
        cartId,
        sku,
        productName: lineItem.productName,
        hasRule: false,
        reason: `No imposition rule for SKU "${sku}"`,
        availableMappings: (await impositionService.getMappings()).filter(
          (m) => m.externalId === sku
        ),
      });
    }

    res.json({
      cartId,
      sku,
      productName: lineItem.productName,
      subGalleryName: lineItem.subGalleryName || '',
      hasRule: true,
      requestedOrientation,
      layout: {
        id: rule.id,
        name: rule.name,
        cols: rule.cols,
        rows: rule.rows,
        itemWidth: rule.itemWidth,
        itemHeight: rule.itemHeight,
        sheetWidth: rule.sheetWidth,
        sheetHeight: rule.sheetHeight,
        dpi: rule.dpi,
        textOverlayCount: (rule.textOverlays || []).length,
      },
      mapping: {
        externalId: rule.__mapping.externalId,
        orientation: rule.__mapping.orientation || null,
      },
      mappingFellBack: !!rule.__mappingFellBack,
      photo: {
        hasFullUrl: !!lineItem.photo?.fullUrl,
        thumbUrl: lineItem.photo?.thumbUrl || null,
      },
    });
  } catch (err) {
    console.error('[sytist/imposition/preview/info]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/imposition/preview/:orderId/:cartId/save
 *
 * Renders an imposed sheet and writes it to the test sandbox. Refuses
 * when path mode is "production" (preview/save is sandbox-only).
 */
router.post('/imposition/preview/:orderId/:cartId/save', async (req, res) => {
  try {
    if (pathsService.getMode() === 'production') {
      return res.status(403).json({
        error:
          'Path mode is "production"; preview/save is sandbox-only. Switch path-overrides.json to mode "test" first.',
      });
    }

    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const cartId = parseInt(req.params.cartId, 10);
    const lineItem = (order.lineItems || []).find((li) => li.cartId === cartId);
    if (!lineItem) {
      return res.status(404).json({ error: `Line item ${cartId} not found in order` });
    }
    if (!lineItem.photo || !lineItem.photo.fullUrl) {
      return res.status(400).json({
        error: `Line item ${cartId} has no photo URL to impose`,
      });
    }

    const orientation =
      (req.body && req.body.orientation) ||
      (req.query.orientation && ['vertical', 'horizontal'].includes(req.query.orientation)
        ? req.query.orientation
        : null);

    const ctx = impositionService.buildContext(order, lineItem);
    const result = await impositionService.composeFromUrl(
      lineItem.photo.fullUrl,
      lineItem.sku,
      ctx,
      orientation
    );

    if (!result.imposed) {
      return res.status(404).json({ error: result.reason });
    }

    // Resolve target path under downloadBase + sortSegments
    const sortLevels = await folderSortService.getSortLevels();
    const sortSegments = folderSortService.buildOrderPathSync(order, sortLevels);
    const targetDir = pathsService.resolveFullPath(
      'downloadBase',
      order,
      sortSegments
    );

    const safeLayoutName = (result.layout.name || 'sheet')
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, '_');
    const filename = `${order.orderNumber || order.orderId}_cart${cartId}_${safeLayoutName}_preview.jpg`;
    const filePath = require('path').win32.join(targetDir, filename);

    // Atomic write — same .tmp + rename pattern the other services use
    const fsp = require('fs').promises;
    await fsp.mkdir(targetDir, { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fsp.writeFile(tmpPath, result.buffer);
    await fsp.rename(tmpPath, filePath);

    res.json({
      success: true,
      filePath,
      filename,
      layout: result.layout,
      mapping: result.mapping,
      orientation: result.orientation,
      warnings: result.warnings,
      meta: result.meta,
    });
  } catch (err) {
    console.error('[sytist/imposition/preview/save]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Layout CRUD (admin only) ─────────────────────────────

router.get('/imposition/layouts', async (req, res) => {
  try {
    const layouts = await impositionService.getLayouts();
    res.json({ layouts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/imposition/layouts/:id', async (req, res) => {
  try {
    const layout = await impositionService.getLayout(req.params.id);
    if (!layout) return res.status(404).json({ error: 'Layout not found' });
    res.json({ layout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/imposition/layouts', requireRole('admin'), async (req, res) => {
  try {
    const layout = await impositionService.addLayout(req.body || {});
    res.json({ success: true, layout });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/imposition/layouts/:id', requireRole('admin'), async (req, res) => {
  try {
    const layout = await impositionService.updateLayout(req.params.id, req.body || {});
    res.json({ success: true, layout });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/imposition/layouts/:id', requireRole('admin'), async (req, res) => {
  try {
    const layouts = await impositionService.deleteLayout(req.params.id);
    res.json({ success: true, layouts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Mapping CRUD (admin only) ────────────────────────────

router.get('/imposition/mappings', async (req, res) => {
  try {
    const mappings = await impositionService.getMappings();
    res.json({ mappings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/imposition/mappings', requireRole('admin'), async (req, res) => {
  try {
    const { externalId, layoutId, orientation } = req.body || {};
    if (!externalId || !layoutId) {
      return res.status(400).json({ error: 'externalId and layoutId are required' });
    }
    const mappings = await impositionService.addMapping(
      externalId,
      layoutId,
      orientation || null
    );
    res.json({ success: true, mappings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/sytist/imposition/mappings/:externalId
 * Body: { oldOrientation?: string, layoutId?: string, orientation?: string }
 *
 * Updates an existing mapping. The mapping is located by
 * (externalId, oldOrientation) — pass empty string or omit oldOrientation
 * for an "any-orientation" mapping. Body's layoutId / orientation are the
 * new values.
 */
router.put(
  '/imposition/mappings/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { oldOrientation, layoutId, orientation } = req.body || {};
      const mappings = await impositionService.updateMapping(
        req.params.externalId,
        oldOrientation || null,
        { layoutId, orientation }
      );
      res.json({ success: true, mappings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * DELETE /api/sytist/imposition/mappings/:externalId
 * Query: ?orientation=vertical|horizontal (optional)
 *
 * If orientation is given, deletes only that orientation's mapping.
 * If omitted, deletes ALL mappings for this externalId.
 */
router.delete(
  '/imposition/mappings/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const orientation = req.query.orientation || null;
      const mappings = await impositionService.deleteMapping(
        req.params.externalId,
        orientation
      );
      res.json({ success: true, mappings });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.get('/imposition/text-variables', async (req, res) => {
  res.json({ variables: impositionService.getTextVariables() });
});

// ─── Phase 4.6: order processing orchestrator ─────────────
//
// "Process this order" — turns a canonical Sytist order into actual
// files on disk that the Darkroom watcher will pick up. Handles sibling
// chunking, specialty routing, atomic per-sub-order writes.
//
// Per-order: synchronous, returns full result.
// Batch:     async, returns jobId for polling.

/**
 * POST /api/sytist/process/order/:orderId
 * Body: { generateDivider?: boolean }
 *
 * Synchronously processes one order. Returns the full result with every
 * sub-order's outcome. Auth required (any role).
 */
router.post('/process/order/:orderId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const result = await processingService.processOrder(order, {
      generateDivider: !!(req.body && req.body.generateDivider),
    });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[sytist/process/order]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/process/batch
 * Body: { orderIds: string[], generateDivider?: boolean, generateQrSheet?: boolean }
 *
 * Kicks off a batch job and returns a jobId immediately. The job runs
 * in the background; clients poll /process/job/:jobId for progress.
 */
router.post('/process/batch', async (req, res) => {
  try {
    const { orderIds, generateDivider, generateQrSheet } = req.body || {};
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: 'orderIds (non-empty array) is required' });
    }
    if (orderIds.length > 500) {
      return res.status(400).json({
        error: `Batch too large (${orderIds.length}). Max 500 orders per batch.`,
      });
    }

    // Phase 4.7 — record who started the batch (for history audit)
    const username =
      req.user?.username ||
      req.user?.displayName ||
      null;

    const jobId = processingService.startBatchProcess(orderIds, {
      generateDivider: !!generateDivider,
      generateQrSheet: !!generateQrSheet,
      username,
    });
    res.json({ success: true, jobId, total: orderIds.length });
  } catch (err) {
    console.error('[sytist/process/batch]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/process/job/:jobId
 *
 * Polls a batch job's progress. Returns the current state of the job
 * including completed count, results so far, and overall status.
 */
router.get('/process/job/:jobId', async (req, res) => {
  try {
    const job = processingService.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    console.error('[sytist/process/job]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/process/job/:jobId/cancel
 *
 * Phase 4.7 — request graceful cancellation of an in-flight batch.
 * The currently-processing order finishes; subsequent orders are
 * skipped. Already-completed orders aren't rolled back.
 */
router.post('/process/job/:jobId/cancel', async (req, res) => {
  try {
    const job = processingService.cancelJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, job });
  } catch (err) {
    console.error('[sytist/process/job/cancel]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/process/history
 * Query: ?limit=50&offset=0
 *
 * Phase 4.7 — paginated list of completed batch jobs. Newest first.
 */
router.get('/process/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await processHistoryService.list({ limit, offset });
    res.json(result);
  } catch (err) {
    console.error('[sytist/process/history]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/process/history/:jobId
 *
 * Returns a specific historical job entry with full per-order summary.
 */
router.get('/process/history/:jobId', async (req, res) => {
  try {
    const entry = await processHistoryService.get(req.params.jobId);
    if (!entry) return res.status(404).json({ error: 'History entry not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/sytist/process/history (admin)
 *
 * Wipes the history. Useful if it gets cluttered with test runs.
 */
router.delete(
  '/process/history',
  requireRole('admin'),
  async (req, res) => {
    try {
      const result = await processHistoryService.clear();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET  /api/sytist/process/settings
 * PUT  /api/sytist/process/settings  (admin)
 *   Body: { autoStatusUpdate?: bool, targetStatusId?: number|null }
 */
router.get('/process/settings', async (req, res) => {
  try {
    const settings = await processingService.getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put(
  '/process/settings',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await processingService.updateSettings(req.body || {});
      res.json({ success: true, settings: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Specialty products CRUD (admin) ──────────────────────

/**
 * GET /api/sytist/specialty/config
 *
 * Returns the full specialty config: basePath, products list,
 * highlightColors. Used by the Settings page.
 */
router.get('/specialty/config', async (req, res) => {
  try {
    const config = await specialtyService.getConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/sytist/specialty/base-path
 * Body: { basePath: string }
 *
 * Sets the base path for specialty products. Empty string falls back to
 * downloadBase + "Specialty" at lookup time.
 */
router.put(
  '/specialty/base-path',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { basePath } = req.body || {};
      const updated = await specialtyService.setBasePath(basePath || '');
      res.json({ success: true, basePath: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * PUT /api/sytist/specialty/highlight-colors
 * Body: { specialty?: string, quantity?: string }
 */
router.put(
  '/specialty/highlight-colors',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await specialtyService.setHighlightColors(req.body || {});
      res.json({ success: true, highlightColors: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * POST /api/sytist/specialty/products
 * Body: { externalId, productName?, subfolder?, dropShipped? }
 */
router.post(
  '/specialty/products',
  requireRole('admin'),
  async (req, res) => {
    try {
      const products = await specialtyService.addProduct(req.body || {});
      res.json({ success: true, products });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.put(
  '/specialty/products/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await specialtyService.updateProduct(
        req.params.externalId,
        req.body || {}
      );
      res.json({ success: true, product: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.delete(
  '/specialty/products/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const products = await specialtyService.deleteProduct(req.params.externalId);
      res.json({ success: true, products });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

module.exports = router;
