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
const teamPhotoService = require('../services/teamPhotoService');
const galleryAssetsService = require('../services/galleryAssetsService');
const compositeService = require('../services/compositeService');
const compositeGraphicsService = require('../services/compositeGraphicsService');
// Phase 11: per-order layout overrides
const orderOverrideService = require('../services/orderOverrideService');
const { requireAuth, requireRole } = require('../middleware/auth');

// Phase 36: small helper to pull the audit context (display name +
// IP) off req for downstream services. Falls back gracefully when
// any field is missing. Used by every action that writes to
// ms_notes — keeps the routes from having to repeat the same
// field-coalescing logic.
function userContextFromReq(req) {
  return {
    userId: req.user?.id ?? null,
    userDisplayName:
      req.user?.display_name ||
      req.user?.displayName ||
      req.user?.username ||
      'dashboard',
    userIp:
      req.ip ||
      req.connection?.remoteAddress ||
      req.headers?.['x-forwarded-for'] ||
      '',
  };
}

// ─── Public routes (registered before auth middleware) ───────
//
// Phase 9e-hotfix3: image preview endpoints serve files via SVG
// <image> and HTML <img> elements, which initiate native browser
// fetches. The dashboard's auth middleware appears to use a header
// token (or some non-cookie scheme) that native image fetches
// don't carry — so those requests fail with 401, leaving slot
// canvases blank.
//
// Solution: register the read-only image-preview endpoints BEFORE
// `router.use(requireAuth)`. The endpoints reveal images that the
// caller already has access to anyway (they need the layout ID
// and key to construct the URL), and the dashboard runs same-
// origin on localhost. Other routes still require auth.

/**
 * GET /api/sytist/composite/layouts/:layoutId/graphics/:key/preview
 * (Public.) Stream the actual image bytes of a stored static graphic.
 * Used by the designer canvas and library thumbnails.
 */
router.get(
  '/composite/layouts/:layoutId/graphics/:key/preview',
  async (req, res) => {
    try {
      const { layoutId, key } = req.params;
      const layout = await compositeService.getLayout(layoutId);
      if (!layout) {
        return res.status(404).json({ error: 'Layout not found' });
      }
      const meta = layout.graphics ? layout.graphics[key] : null;
      const opened = await compositeGraphicsService.openGraphicStream({
        layoutId,
        key,
        filename: meta && meta.filename,
      });
      if (!opened) {
        return res.status(404).json({ error: 'Graphic file not found' });
      }
      res.setHeader('Content-Type', opened.mimeType);
      res.setHeader('Content-Length', opened.sizeBytes);
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, max-age=0'
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      opened.stream.pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /api/sytist/gallery-assets/logos/:galleryId/preview
 * (Public.) Same rationale as the composite-graphics preview.
 */
router.get('/gallery-assets/logos/:galleryId/preview', async (req, res) => {
  try {
    const galleryId = parseInt(req.params.galleryId, 10);
    const meta = await galleryAssetsService.getLogo(galleryId);
    if (!meta) return res.status(404).json({ error: 'No logo set' });
    const buffer = await galleryAssetsService.readLogoBuffer(galleryId);
    if (!buffer) return res.status(404).json({ error: 'Logo file missing' });
    const ext = require('path').extname(meta.logoFilename || '').toLowerCase();
    const ct =
      ext === '.png' ? 'image/png' :
      ext === '.webp' ? 'image/webp' :
      'image/jpeg';
    res.set('Content-Type', ct);
    res.set(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, max-age=0'
    );
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
 * Phase 20: GET /api/sytist/orders/search?q=<query>
 *
 * Global order search by order number, customer name, email, or
 * phone. Returns at most 10 results, paid + non-erased only.
 *
 * Must be registered BEFORE /orders/:orderId so Express doesn't
 * route "search" through the param-matching handler.
 */
router.get('/orders/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.json({ results: [], query: '' });
    }
    if (q.length < 2) {
      // Avoid hammering the DB with a single character. Empty result.
      return res.json({ results: [], query: q, message: 'Query too short' });
    }
    const results = await sytistDb.searchOrders(q);
    res.json({ results, query: q });
  } catch (err) {
    console.error('[sytist/orders/search]', err);
    res.status(500).json({ error: err.message || 'Search failed' });
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
 * Phase 14b: GET /api/sytist/orders/:orderId/neighbors
 *
 * Returns the prev/next order IDs for navigating within a filtered
 * list. Accepts the same filter query params as GET /orders:
 *   workflow         — 'all' | 'ship_to_home' | 'ship_to_managers' | 'ship_to_league'
 *   productionStatus — number | 'all' (default: 'all' on detail page,
 *                      so direct-link / typed-URL access navigates
 *                      across all statuses unless caller specifies)
 *   galleryId        — number
 *   subGalleryId     — number
 *   shippingOption   — string
 *   sort             — 'date_asc' | 'date_desc'
 *
 * Response:
 *   {
 *     previousOrderId: '110632' | null,
 *     nextOrderId:     '110634' | null,
 *     position:        N      (1-based; 0 if anchor isn't in filtered set),
 *     total:           M      (total in filtered set),
 *   }
 *
 * Used by the order detail page's Prev/Next buttons.
 */
router.get('/orders/:orderId/neighbors', async (req, res) => {
  try {
    const opts = {};
    if (req.query.workflow) opts.workflow = req.query.workflow;
    if (req.query.productionStatus !== undefined) {
      opts.productionStatus =
        req.query.productionStatus === 'all'
          ? 'all'
          : parseInt(req.query.productionStatus, 10);
    }
    if (req.query.galleryId) opts.galleryId = parseInt(req.query.galleryId, 10);
    if (req.query.subGalleryId)
      opts.subGalleryId = parseInt(req.query.subGalleryId, 10);
    if (req.query.shippingOption) opts.shippingOption = req.query.shippingOption;
    if (req.query.sort) opts.sort = req.query.sort;

    const neighbors = await sytistDb.getOrderNeighbors(
      req.params.orderId,
      opts
    );
    res.json(neighbors);
  } catch (err) {
    console.error('[sytist/orders/:orderId/neighbors]', err);
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

// ─── Phase 28: shipping status transitions ───────────────────
//
// Three endpoints:
//   POST /orders/:orderId/ship        — mark a single order shipped
//   POST /orders/batch-ship           — mark many orders shipped at once
//   POST /orders/:orderId/unship      — manual override; reverse to Printing
//
// All check eligibility (status must be in shipEligibleFromStatusIds,
// configured in processing-settings.json) unless force=true. Every
// transition is logged to the local SQLite order_status_audit table.
//
// The eligibility model lets us prevent operator mistakes like
// "Mark Shipped" on an order still in Queue. The override (unship)
// bypasses this for admin corrections.
const orderStatusService = require('../services/orderStatusService');

router.post(
  '/orders/:orderId/ship',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const ctx = userContextFromReq(req);
      const result = await orderStatusService.shipOrder({
        orderId: req.params.orderId,
        force: !!req.body?.force,
        source: 'manual',
        userId: ctx.userId,
        userDisplayName: ctx.userDisplayName,
        userIp: ctx.userIp,
      });
      if (!result.ok) {
        const status =
          result.code === 'not_found'
            ? 404
            : result.code === 'not_eligible'
              ? 409
              : 400;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error('[sytist/orders/:orderId/ship]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

router.post(
  '/orders/batch-ship',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const orderIds = Array.isArray(req.body?.orderIds)
        ? req.body.orderIds
        : [];
      if (orderIds.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: 'orderIds array required' });
      }
      const ctx = userContextFromReq(req);
      const result = await orderStatusService.batchShipOrders({
        orderIds,
        force: !!req.body?.force,
        source: 'bulk',
        userId: ctx.userId,
        userDisplayName: ctx.userDisplayName,
        userIp: ctx.userIp,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[sytist/orders/batch-ship]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

router.post(
  '/orders/:orderId/unship',
  requireRole('admin'),
  async (req, res) => {
    try {
      const ctx = userContextFromReq(req);
      const result = await orderStatusService.unshipOrder({
        orderId: req.params.orderId,
        targetStatusId: req.body?.targetStatusId,
        source: 'manual_override',
        userId: ctx.userId,
        userDisplayName: ctx.userDisplayName,
        userIp: ctx.userIp,
        notes: req.body?.notes,
      });
      if (!result.ok) {
        const status = result.code === 'not_found' ? 404 : 400;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error('[sytist/orders/:orderId/unship]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ─── Phase 36: ms_notes endpoints ──────────────────────────────
//
// These let the dashboard's order detail page read and write the
// Sytist activity log. INSERTs are append-only (a new row each
// call) and DELETE is a soft-delete (sets note_delete=1 + records
// who/when in note_edited / note_edited_who).
//
// Auth: any authenticated user can list and add notes. Only the
// note's own author (matched on display name) or an admin can
// soft-delete; the rule lives here at the route layer rather than
// in sytistDbService.

/**
 * GET /api/sytist/orders/:orderId/notes
 *
 * Lists ms_notes rows for this order, newest-first, excluding
 * soft-deleted ones. Returns the UI-shaped rows from
 * sytistDb.listNotes().
 */
router.get('/orders/:orderId/notes', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const includeDeleted = req.query.includeDeleted === '1';
    const notes = await sytistDb.listNotes(orderId, { includeDeleted });
    res.json({ ok: true, notes });
  } catch (err) {
    console.error('[sytist/orders/:orderId/notes GET]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/sytist/orders/:orderId/notes
 * Body: { noteText: string }
 *
 * Adds a manual operator note. Stored with the manual flag triple
 * (admin=1, is_note=1, log=0) so Sytist's UI styles it as a real
 * "Note" rather than a system log event.
 *
 * Returns the new note shape so the client can append it to its
 * local state without re-fetching.
 */
router.post('/orders/:orderId/notes', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const noteText = req.body && req.body.noteText
      ? String(req.body.noteText).trim()
      : '';
    if (!noteText) {
      return res.status(400).json({ ok: false, error: 'noteText required' });
    }
    const ctx = userContextFromReq(req);
    const { noteId } = await sytistDb.insertNote({
      orderId,
      noteText,
      who: ctx.userDisplayName,
      ip: ctx.userIp,
      isManual: true,
    });
    res.json({
      ok: true,
      note: {
        id: noteId,
        date: new Date(),
        body: noteText,
        who: ctx.userDisplayName,
        ip: ctx.userIp,
        type: 'note',
        admin: true,
        deleted: false,
      },
    });
  } catch (err) {
    console.error('[sytist/orders/:orderId/notes POST]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/sytist/orders/:orderId/notes/:noteId
 *
 * Soft-deletes a single note. Authorization:
 *   - Admins can delete any note
 *   - Non-admins can only delete notes they themselves authored
 *
 * Author matching is done on display name. Logged-in user's
 * display name must equal note_who on the existing row, else we
 * 403. We don't allow deleting system log events (log=1) at all
 * since those are the audit trail — the only way to "remove" one
 * would be a manual operator note explaining what happened.
 */
router.delete('/orders/:orderId/notes/:noteId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const noteId = req.params.noteId;
    const ctx = userContextFromReq(req);
    const role = req.user?.role || '';
    const isAdmin = role === 'admin';

    // Find the note first so we can apply authorization.
    const notes = await sytistDb.listNotes(orderId, {
      includeDeleted: false,
      limit: 1000,
    });
    const target = notes.find((n) => String(n.id) === String(noteId));
    if (!target) {
      return res.status(404).json({ ok: false, error: 'Note not found' });
    }
    if (target.type === 'log') {
      return res
        .status(403)
        .json({ ok: false, error: 'System log entries cannot be deleted' });
    }
    if (!isAdmin && target.who !== ctx.userDisplayName) {
      return res
        .status(403)
        .json({ ok: false, error: 'Only the author or an admin can delete this note' });
    }

    const result = await sytistDb.softDeleteNote(noteId, {
      editedWho: ctx.userDisplayName,
    });
    res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (err) {
    console.error('[sytist/orders/:orderId/notes DELETE]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Phase 33: manual "Push packaging to ShipStation" ──────────
//
// Opt-in re-push for orders that ALREADY exist in ShipStation
// (have a local link row). Recomputes the packaging payload from
// the order's current Sytist state and upserts it to SS via
// /orders/createorder.
//
// Why this exists: by default, reprocessing an order does NOT
// push to ShipStation (Phase 33 reversed Phase 31's auto-push).
// When the operator legitimately needs to update SS — e.g. they
// changed a product weight, edited an addon, or the engine now
// recommends a different package — they click "Push packaging
// to ShipStation" on the order detail page, which hits this
// endpoint.
//
// Also updates the local link row to reflect what was pushed
// (carrier/service/package codes, payload snapshot).
// ─── COMPOSED THUMBNAIL URL LOOKUP (Phase 44) ──────────────────
// Returns the cached public URL(s) for an order's composite/composed
// thumbnails, keyed by cart_id. The dashboard's order detail page
// calls this to show the rendered composite (Memory Mate, etc.) as
// the line item card's thumbnail when one exists, falling back to
// the raw photo otherwise.
//
// Rows are written during processOrder (Step 1.4 green-screen
// compose AND the composite-engine render step) and cleared by
// the scheduler when an order ships.
//
// Returns:
//   { ok: true, thumbnails: { [cart_id]: public_url, ... } }
router.get('/orders/:orderId/composed-thumbnails', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const composedThumbnailCacheService = require('../services/composedThumbnailCacheService');
    const rows = composedThumbnailCacheService.listByOrder(orderId);
    const thumbnails = {};
    for (const r of rows) {
      thumbnails[r.cart_id] = r.public_url;
    }
    res.json({ ok: true, thumbnails });
  } catch (err) {
    // Non-fatal — UI falls back to its existing photo thumbnail.
    console.warn(
      `[sytist/orders/${req.params.orderId}/composed-thumbnails] read failed: ${err.message}`
    );
    res.json({ ok: true, thumbnails: {} });
  }
});

router.post(
  '/orders/:orderId/push-packaging',
  requireRole('admin', 'operator'),
  async (req, res) => {
    const orderId = req.params.orderId;
    const tag = `[push-packaging:${orderId}]`;
    try {
      const shipstationService = require('../services/shipstationService');
      const shipstationLinkService = require('../services/shipstationLinkService');
      const composedThumbnailCacheService = require('../services/composedThumbnailCacheService');

      // 1. Must have an existing link. If not, the operator should
      // just process the order normally (which creates fresh).
      const link = shipstationLinkService.getByOrderId(orderId);
      if (!link) {
        return res.status(404).json({
          ok: false,
          error:
            'No ShipStation link exists for this order. Process the order first to create one.',
          code: 'no_link',
        });
      }

      // 2. Load the order fresh from Sytist + build the payload.
      const order = await sytistDb.getOrderById(orderId);
      if (!order) {
        return res.status(404).json({
          ok: false,
          error: `Order ${orderId} not found in Sytist`,
          code: 'not_found',
        });
      }

      // Phase 43: hydrate composedImageUrl onto each line item from
      // the SQLite cache. processOrder Step 1.4 wrote these URLs
      // when the order was processed; without hydration, the SS
      // payload would fall back to Sytist's raw thumbUrl (the keyed
      // out subject without background) for green-screen items.
      try {
        const cachedRows = composedThumbnailCacheService.listByOrder(orderId);
        if (cachedRows.length > 0) {
          const byCartId = new Map(
            cachedRows.map((r) => [String(r.cart_id), r.public_url])
          );
          let hydrated = 0;
          for (const li of order.lineItems || []) {
            const url = byCartId.get(String(li.cartId));
            if (url) {
              li.composedImageUrl = url;
              hydrated += 1;
            }
          }
          if (hydrated > 0) {
            console.log(
              `${tag} hydrated composedImageUrl on ${hydrated} line item(s) from cache`
            );
          }
        }
      } catch (cacheErr) {
        // Non-fatal — cache miss just means we fall back to thumbUrl.
        console.warn(
          `${tag} thumbnail cache read failed (non-fatal): ${cacheErr.message}`
        );
      }

      let payload;
      try {
        payload = await shipstationService.buildOrderFromSytist(order, {});
      } catch (err) {
        console.error(`${tag} buildOrderFromSytist failed: ${err.message}`);
        return res.status(500).json({
          ok: false,
          error: `Payload build failed: ${err.message}`,
        });
      }

      if (payload && payload.__skipShipStation) {
        return res.status(400).json({
          ok: false,
          error: `Packaging engine says order is not shippable: ${payload.message}`,
          code: 'not_shippable',
        });
      }

      // Phase 43: pre-check whether the linked SS order still exists.
      // If the operator deleted it externally (or it was purged on
      // SS's side), we'd get a confusing 404 from createOrder when
      // we try to UPDATE it. Detect that case upfront and switch to
      // fresh-create mode.
      //
      // Lookup is by orderNumber (the Sytist order ID) — same key
      // used by Process's phantom check. Non-fatal: if listOrders
      // itself fails, we proceed with the update path and let the
      // auto-retry below catch any 404.
      let ssOrderExists = true;
      try {
        const orderNumStr = payload.orderNumber || String(order.orderId);
        const lookup = await shipstationService.listOrders({
          orderNumber: orderNumStr,
        });
        const matches = (lookup?.orders || []).filter(
          (o) => o.orderNumber === orderNumStr
        );
        if (matches.length === 0) {
          ssOrderExists = false;
          console.log(
            `${tag} pre-check: SS#${link.ss_order_id} not found via listOrders (operator likely deleted it). Will create fresh.`
          );
        } else {
          // Sanity check: does at least one match have the SS ID we
          // think we're linked to? If not, the link is stale but a
          // different SS order with the same orderNumber exists —
          // adopt the existing one rather than creating a duplicate.
          const exactMatch = matches.find(
            (o) => o.orderId === link.ss_order_id
          );
          if (!exactMatch) {
            const adopted = matches[0];
            console.log(
              `${tag} pre-check: SS#${link.ss_order_id} not found but SS#${adopted.orderId} has the same orderNumber. Re-linking and updating.`
            );
            shipstationLinkService.update(orderId, {
              ssOrderId: adopted.orderId,
              ssOrderNumber: adopted.orderNumber,
              ssOrderStatus: adopted.orderStatus,
            });
            link.ss_order_id = adopted.orderId;
          }
        }
      } catch (lookupErr) {
        console.warn(
          `${tag} listOrders pre-check failed (non-fatal): ${lookupErr.message}`
        );
      }

      console.log(
        `${tag} pushing payload — weight=${payload.weight?.value}${payload.weight?.units || 'oz'}, ` +
          `dims=${payload.dimensions?.length}x${payload.dimensions?.width}x${payload.dimensions?.height}${payload.dimensions?.units || 'in'}, ` +
          `carrier=${payload.carrierCode}/${payload.serviceCode}, package=${payload.packageCode} → ` +
          (ssOrderExists
            ? `SS#${link.ss_order_id} (update)`
            : 'fresh create (link was stale)')
      );

      // 3. Push. If SS exists, send orderId to UPDATE; otherwise
      // omit it for a fresh CREATE. Belt-and-suspenders: if the
      // UPDATE returns 404 (e.g. our pre-check was wrong, or the
      // order got deleted between pre-check and push), auto-retry
      // as fresh-create.
      let ssResult;
      let pathTaken = ssOrderExists ? 'update' : 'fresh_create';
      try {
        const sendPayload = ssOrderExists
          ? { ...payload, orderId: link.ss_order_id }
          : payload;
        ssResult = await shipstationService.createOrder(sendPayload);
      } catch (err) {
        const is404 =
          /\b404\b/.test(err.message) ||
          /not\s*found/i.test(err.message);
        if (is404 && ssOrderExists) {
          console.warn(
            `${tag} update returned 404 — SS order was deleted between pre-check and push. Retrying as fresh create.`
          );
          try {
            ssResult = await shipstationService.createOrder(payload);
            pathTaken = 'fresh_create_after_404';
          } catch (retryErr) {
            console.error(
              `${tag} fresh-create retry also failed: ${retryErr.message}`
            );
            return res.status(502).json({
              ok: false,
              error: `ShipStation rejected both update and fresh create: ${retryErr.message}`,
              code: 'ss_error',
            });
          }
        } else {
          console.error(`${tag} createOrder failed: ${err.message}`);
          return res.status(502).json({
            ok: false,
            error: `ShipStation rejected the ${pathTaken}: ${err.message}`,
            code: 'ss_error',
          });
        }
      }

      const storedPkg = ssResult.packageCode;
      const drift = payload.packageCode !== storedPkg;
      console.log(
        `${tag} createOrder OK (${pathTaken}) → SS#${ssResult.orderId} packageCode=${storedPkg}${drift ? ` (⚠ drift from sent=${payload.packageCode})` : ''}`
      );

      // 4. Update the local link row's metadata so the UI reflects
      // what's now in SS. If the SS order ID changed (we created
      // fresh after a stale link), this re-points the link too.
      try {
        const linkUpdate = {
          ssOrderStatus: ssResult.orderStatus,
          carrierCode: payload.carrierCode,
          serviceCode: payload.serviceCode,
          packageCode: storedPkg,
          payload,
        };
        if (ssResult.orderId !== link.ss_order_id) {
          linkUpdate.ssOrderId = ssResult.orderId;
          linkUpdate.ssOrderNumber = ssResult.orderNumber;
        }
        shipstationLinkService.update(orderId, linkUpdate);
      } catch (linkErr) {
        console.warn(`${tag} link update failed (SS update succeeded): ${linkErr.message}`);
      }

      // Phase 36: append to ms_notes so the push shows up in
      // Sytist's order detail. Non-fatal.
      try {
        const ctx = userContextFromReq(req);
        let noteText = 'Sytist Dashboard: Packaging pushed to ShipStation';
        const bits = [];
        if (payload.weight?.value) bits.push(`${payload.weight.value}oz`);
        if (storedPkg) bits.push(storedPkg);
        if (payload.carrierCode && payload.serviceCode)
          bits.push(`${payload.carrierCode}/${payload.serviceCode}`);
        if (bits.length > 0) noteText += ' — ' + bits.join(', ');
        if (drift) noteText += ' (⚠ SS reassigned package code)';
        if (pathTaken !== 'update') noteText += ' (recreated)';
        await sytistDb.insertNote({
          orderId,
          noteText,
          who: ctx.userDisplayName,
          ip: ctx.userIp,
          isManual: false,
        });
      } catch (noteErr) {
        console.warn(`${tag} ms_notes insert failed: ${noteErr.message}`);
      }

      res.json({
        ok: true,
        orderId: ssResult.orderId,
        orderNumber: ssResult.orderNumber,
        orderStatus: ssResult.orderStatus,
        packageCodeSent: payload.packageCode,
        packageCodeStored: storedPkg,
        packageCodeDrift: drift,
        carrierCode: payload.carrierCode,
        serviceCode: payload.serviceCode,
        weightOz: payload.weight?.value,
        pathTaken, // 'update' | 'fresh_create' | 'fresh_create_after_404'
      });
    } catch (err) {
      console.error(`${tag} unexpected error:`, err);
      res.status(500).json({ ok: false, error: err.message });
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

    // Phase 17: green-screen background compositing for the preview.
    // If this line is green-screen with a chosen background, fetch
    // the subject + background, composite them, and feed the result
    // straight into the imposition layer (bypassing the URL-fetch
    // path because we already have the bytes in memory).
    //
    // Non-green-screen lines go through composeFromUrl as before.
    const greenscreenService = require('../services/greenscreenService');
    let result;
    if (greenscreenService.shouldComposite(lineItem)) {
      try {
        const subjectResp = await fetch(lineItem.photo.fullUrl);
        if (!subjectResp.ok) {
          throw new Error(`Failed to fetch subject: HTTP ${subjectResp.status}`);
        }
        const subjectBuffer = Buffer.from(await subjectResp.arrayBuffer());
        const { buffer: composedBuffer, warnings: gsWarnings } =
          await greenscreenService.composeWithBackground(
            subjectBuffer,
            lineItem.backgroundPhoto.fullUrl,
            { outputFormat: 'jpeg', jpegQuality: 92 }
          );
        if (gsWarnings && gsWarnings.length > 0) {
          for (const w of gsWarnings) {
            console.warn(
              `[imposition/preview] greenscreen ${w.type}: ${w.message}`
            );
          }
        }
        result = await impositionService.buildSheetBuffer(
          composedBuffer,
          lineItem.sku,
          ctx,
          orientation
        );
      } catch (gsErr) {
        // Fall back to subject-only on green-screen errors so the
        // preview still renders something. Log loudly so the operator
        // notices something went wrong.
        console.warn(
          `[imposition/preview] greenscreen failed for ${req.params.orderId}/${req.params.cartId}: ${gsErr.message} — falling back to subject-only`
        );
        result = await impositionService.composeFromUrl(
          lineItem.photo.fullUrl,
          lineItem.sku,
          ctx,
          orientation
        );
      }
    } else {
      result = await impositionService.composeFromUrl(
        lineItem.photo.fullUrl,
        lineItem.sku,
        ctx,
        orientation
      );
    }

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

    // Phase 17: green-screen compositing for the save path too.
    // Same logic as the GET /preview endpoint above.
    const greenscreenService = require('../services/greenscreenService');
    let result;
    if (greenscreenService.shouldComposite(lineItem)) {
      try {
        const subjectResp = await fetch(lineItem.photo.fullUrl);
        if (!subjectResp.ok) {
          throw new Error(`Failed to fetch subject: HTTP ${subjectResp.status}`);
        }
        const subjectBuffer = Buffer.from(await subjectResp.arrayBuffer());
        const { buffer: composedBuffer, warnings: gsWarnings } =
          await greenscreenService.composeWithBackground(
            subjectBuffer,
            lineItem.backgroundPhoto.fullUrl,
            { outputFormat: 'jpeg', jpegQuality: 92 }
          );
        if (gsWarnings && gsWarnings.length > 0) {
          for (const w of gsWarnings) {
            console.warn(
              `[imposition/preview/save] greenscreen ${w.type}: ${w.message}`
            );
          }
        }
        result = await impositionService.buildSheetBuffer(
          composedBuffer,
          lineItem.sku,
          ctx,
          orientation
        );
      } catch (gsErr) {
        console.warn(
          `[imposition/preview/save] greenscreen failed for ${req.params.orderId}/${req.params.cartId}: ${gsErr.message} — falling back to subject-only`
        );
        result = await impositionService.composeFromUrl(
          lineItem.photo.fullUrl,
          lineItem.sku,
          ctx,
          orientation
        );
      }
    } else {
      result = await impositionService.composeFromUrl(
        lineItem.photo.fullUrl,
        lineItem.sku,
        ctx,
        orientation
      );
    }

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
 * Body: { generateDivider?: boolean, reprint?: boolean, reason?: string }
 *
 * Synchronously processes one order. Returns the full result with every
 * sub-order's outcome. Auth required (any role).
 *
 * Phase 35: when reprint=true, the order is processed as a REPRINT —
 * outputs land with a _REPRINT[_N] filename suffix, Sytist status is
 * not changed, ShipStation is skipped. Useful for re-running a print
 * job after damage/lost item without disturbing the original.
 */
router.post('/process/order/:orderId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const ctx = userContextFromReq(req);
    const result = await processingService.processOrder(order, {
      generateDivider: !!(req.body && req.body.generateDivider),
      reprint: !!(req.body && req.body.reprint),
      reason: req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null,
      userId: ctx.userId,
      userDisplayName: ctx.userDisplayName,
      userIp: ctx.userIp,
    });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[sytist/process/order]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/process/order/:orderId/reprint-item/:cartId
 * Body: { reason?: string }
 *
 * Phase 35: reprint a SINGLE line item of an order. Useful when one
 * print got damaged or lost and only that line needs to be redone.
 * Output filenames include both the reprint suffix and (implicitly,
 * via the photo-filename pattern) the cartId so multiple single-item
 * reprints can coexist.
 *
 * NO packing slip is produced for a single-item reprint — the
 * operator already knows what they're reprinting. Just the .txt and
 * the imposed sheet for that one line.
 *
 * Sytist status: untouched (matches whole-order reprint behavior).
 * ShipStation: skipped (matches whole-order reprint behavior).
 */
router.post(
  '/process/order/:orderId/reprint-item/:cartId',
  async (req, res) => {
    try {
      const order = await sytistDb.getOrderById(req.params.orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const cartId = String(req.params.cartId);
      const hasLine = (order.lineItems || []).some(
        (li) => String(li.cartId) === cartId
      );
      if (!hasLine) {
        return res.status(404).json({
          error: `Order ${order.orderId} has no line item with cartId ${cartId}`,
        });
      }

      const ctx = userContextFromReq(req);
      const result = await processingService.processOrder(order, {
        reprint: true,
        lineItemFilter: [cartId],
        reason:
          req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null,
        userId: ctx.userId,
        userDisplayName: ctx.userDisplayName,
        userIp: ctx.userIp,
      });
      res.json({ success: true, result });
    } catch (err) {
      console.error('[sytist/process/order/reprint-item]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

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

// ─── Phase 8a: composite engine (verification phase) ─────
//
// 8a ships the data layer + verification UI. The orchestrator does NOT
// yet route SKUs through compositeService — that's 8b after we've
// confirmed the team photo discovery and asset management work right.
//
// Endpoints below cover:
//   - team photo settings (the listId)
//   - team photo lookup (verification — "what would you find for this team?")
//   - composite layouts CRUD
//   - composite mappings CRUD
//   - composite preview (render a sample for any order, no disk write)
//   - gallery assets CRUD (logo upload via base64, list, delete)

// ─── Team photo settings ─────────────────────────────────

router.get('/team-photo/settings', async (req, res) => {
  try {
    res.json(await teamPhotoService.getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put(
  '/team-photo/settings',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await teamPhotoService.updateSettings(req.body || {});
      res.json({ success: true, settings: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * GET /api/sytist/galleries/:galleryId/sub-galleries
 *
 * Phase 8a-hotfix: returns ALL sub-galleries for a gallery, no order
 * filter. Used by the team photo lookup tester so verification works
 * for galleries that haven't had orders yet.
 */
router.get('/galleries/:galleryId/sub-galleries', async (req, res) => {
  try {
    const galleryId = parseInt(req.params.galleryId, 10);
    if (!galleryId || galleryId <= 0) {
      return res.status(400).json({ error: 'galleryId must be a positive integer' });
    }
    const subGalleries = await sytistDb.getAllSubGalleries(galleryId);
    res.json({ galleryId, subGalleries });
  } catch (err) {
    console.error('[sytist/galleries/:id/sub-galleries]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/team-photo/lookup?subGalleryId=44384
 *
 * Verification endpoint: returns what the team photo discovery would
 * find for a given sub-gallery, without doing anything else. Used by
 * the Settings UI's spot-check tool.
 */
router.get('/team-photo/lookup', async (req, res) => {
  try {
    const subGalleryId = parseInt(req.query.subGalleryId, 10);
    const listId = req.query.listId
      ? parseInt(req.query.listId, 10)
      : undefined;
    if (!subGalleryId || subGalleryId <= 0) {
      return res
        .status(400)
        .json({ error: 'subGalleryId is required (positive integer)' });
    }
    const result = await teamPhotoService.findTeamPhoto(subGalleryId, {
      listId,
    });
    res.json(result);
  } catch (err) {
    console.error('[sytist/team-photo/lookup]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/team-photo/cache/clear', async (req, res) => {
  res.json(teamPhotoService.clearCache());
});

router.get('/team-photo/cache/stats', async (req, res) => {
  res.json(teamPhotoService.getCacheStats());
});

// ─── Composite layouts CRUD ──────────────────────────────

router.get('/composite/layouts', async (req, res) => {
  try {
    const layouts = await compositeService.listLayouts();
    res.json({ layouts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/composite/layouts/:id', async (req, res) => {
  try {
    const layout = await compositeService.getLayout(req.params.id);
    if (!layout) return res.status(404).json({ error: 'Layout not found' });
    res.json(layout);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post(
  '/composite/layouts',
  requireRole('admin'),
  async (req, res) => {
    try {
      const layout = await compositeService.addLayout(req.body || {});
      res.json({ success: true, layout });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.put(
  '/composite/layouts/:id',
  requireRole('admin'),
  async (req, res) => {
    try {
      const layout = await compositeService.updateLayout(
        req.params.id,
        req.body || {}
      );
      res.json({ success: true, layout });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.delete(
  '/composite/layouts/:id',
  requireRole('admin'),
  async (req, res) => {
    try {
      const result = await compositeService.deleteLayout(req.params.id);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Composite mappings CRUD ────────────────────────────

router.get('/composite/mappings', async (req, res) => {
  try {
    const mappings = await compositeService.listMappings();
    res.json({ mappings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post(
  '/composite/mappings',
  requireRole('admin'),
  async (req, res) => {
    try {
      const mapping = await compositeService.addMapping(req.body || {});
      res.json({ success: true, mapping });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.put(
  '/composite/mappings/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const updated = await compositeService.updateMapping(
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
  '/composite/mappings/:externalId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const result = await compositeService.deleteMapping(
        req.params.externalId
      );
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * POST /api/sytist/composite/preview
 * Body: { orderId, cartId, layoutId? }
 *
 * Renders a composite for a specific line item of a real order, but
 * does NOT write anything to disk. Used by the verification UI to spot-
 * check that team photo discovery + asset resolution + variant
 * selection all work end-to-end. Returns the rendered JPG bytes as
 * base64.
 *
 * If layoutId is omitted, the SKU's mapped layout is used. If no
 * mapping exists for that SKU, returns 400 — caller must specify
 * layoutId explicitly.
 */
router.post('/composite/preview', async (req, res) => {
  try {
    const { orderId, cartId, layoutId, layout: inlineLayout } = req.body || {};
    if (!orderId || !cartId) {
      return res.status(400).json({
        error: 'orderId and cartId are required',
      });
    }

    const order = await sytistDb.getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: `Order ${orderId} not found` });
    }
    const lineItem = (order.lineItems || []).find(
      (li) => String(li.cartId) === String(cartId)
    );
    if (!lineItem) {
      return res.status(404).json({
        error: `cartId ${cartId} not found in order ${orderId}`,
      });
    }
    if (!lineItem.photo || !lineItem.photo.fullUrl) {
      return res.status(400).json({
        error: `Line item has no player photo URL`,
      });
    }

    // Resolve which layout to use:
    //   - inline layout in request body wins (used by Phase 9b designer
    //     to preview unsaved changes without round-tripping to disk)
    //   - else layoutId (loaded from disk)
    //   - else SKU's mapped layout
    let layout = null;
    if (inlineLayout) {
      // Validate the inline layout passes the same checks save() applies.
      // Reuse compositeService's validator by calling _validateLayout
      // through a thin wrapper — it throws on bad input.
      try {
        // The validator is private but compositeService exposes the
        // same checks via addLayout/updateLayout. We can't call those
        // here (they'd persist) so we duplicate the minimal validation:
        // ensure variants object + at least one slot array.
        if (!inlineLayout.variants ||
            (!Array.isArray(inlineLayout.variants.vertical?.slots) &&
             !Array.isArray(inlineLayout.variants.horizontal?.slots))) {
          throw new Error('Inline layout must have variants.vertical.slots or variants.horizontal.slots');
        }
        layout = inlineLayout;
      } catch (err) {
        return res.status(400).json({ error: `Invalid inline layout: ${err.message}` });
      }
    } else if (layoutId) {
      layout = await compositeService.getLayout(layoutId);
      if (!layout) {
        return res
          .status(404)
          .json({ error: `Layout "${layoutId}" not found` });
      }
    } else {
      const mapping = await compositeService.findMapping(lineItem.sku);
      if (!mapping) {
        return res.status(400).json({
          error: `No composite mapping for SKU "${lineItem.sku}". Pass layoutId explicitly to preview.`,
        });
      }
      layout = await compositeService.getLayout(mapping.layoutId);
      if (!layout) {
        return res
          .status(404)
          .json({ error: `Mapped layout "${mapping.layoutId}" missing` });
      }
    }

    // Fetch player photo
    const playerResp = await fetch(lineItem.photo.fullUrl);
    if (!playerResp.ok) {
      return res.status(502).json({
        error: `Player photo fetch failed: HTTP ${playerResp.status}`,
      });
    }
    const playerPhoto = Buffer.from(await playerResp.arrayBuffer());

    // Pick variant from player orientation
    const variant = compositeService.pickVariant(
      layout,
      lineItem.photo.width || 0,
      lineItem.photo.height || 0
    );

    // Resolve team photo via teamPhotoService
    const teamLookup = await teamPhotoService.findTeamPhoto(
      lineItem.subGalleryId
    );
    let teamPhotoBuffer = null;
    if (teamLookup.found && teamLookup.photo.fullUrl) {
      try {
        const tpResp = await fetch(teamLookup.photo.fullUrl);
        if (tpResp.ok) {
          teamPhotoBuffer = Buffer.from(await tpResp.arrayBuffer());
        }
      } catch (err) {
        console.warn(`[Composite preview] team photo fetch: ${err.message}`);
      }
    }

    // Resolve logo via galleryAssetsService — uses the order's gallery
    // (we look it up by the line item's date_id / parent gallery)
    let logoBuffer = null;
    const galleryId = lineItem.galleryId || order.galleryId || null;
    if (galleryId) {
      logoBuffer = await galleryAssetsService.readLogoBuffer(galleryId);
    }

    // Phase 10b: resolve customer-selected background photo if the
    // layout has a playerBackground slot AND the line item has a
    // backgroundPhoto from cart_photo_bg. Mirrors the logic in
    // processingService for the production pipeline.
    const variantDef = layout.variants?.[variant] || { slots: [] };
    let playerBackgroundBuffer = null;
    const layoutHasBackgroundSlot = (variantDef.slots || []).some(
      (s) => s.kind === 'playerBackground'
    );
    if (layoutHasBackgroundSlot && lineItem.backgroundPhoto?.fullUrl) {
      try {
        const bgResp = await fetch(lineItem.backgroundPhoto.fullUrl);
        if (bgResp.ok) {
          playerBackgroundBuffer = Buffer.from(await bgResp.arrayBuffer());
        } else {
          console.warn(
            `[Composite preview] background photo HTTP ${bgResp.status}`
          );
        }
      } catch (err) {
        console.warn(
          `[Composite preview] background photo fetch: ${err.message}`
        );
      }
    }

    const tokens = compositeService.buildTokensFromOrder(order, lineItem);

    // Phase 9c: load any static graphics referenced by the chosen
    // variant's slots and pass them via tokens.overlays. Same logic
    // as in processingService Step 1.5 — loads from disk under the
    // layout's graphics dir.
    const graphicsMap = {};
    const seenKeys = new Set();
    for (const s of variantDef.slots || []) {
      if (s.kind !== 'staticGraphic' && s.kind !== 'overlay') continue;
      const key = s.graphicKey || s.overlayId;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const meta = layout.graphics ? layout.graphics[key] : null;
      try {
        const buf = await compositeGraphicsService.readGraphicBuffer({
          layoutId: layout.id,
          key,
          filename: meta && meta.filename,
        });
        if (buf) graphicsMap[key] = buf;
      } catch {
        // Continue — render will warn per-slot
      }
    }
    tokens.overlays = graphicsMap;

    const result = await compositeService.buildSheetBuffer({
      layout,
      variant,
      playerPhoto,
      teamPhoto: teamPhotoBuffer,
      logo: logoBuffer,
      playerBackground: playerBackgroundBuffer,
      tokens,
    });

    res.json({
      success: true,
      orderId,
      cartId,
      sku: lineItem.sku,
      layoutId: layout.id,
      layoutName: layout.name,
      variant: result.variant,
      dimensions: result.dimensions,
      teamPhotoFound: teamLookup.found,
      teamPhotoReason: teamLookup.found ? null : teamLookup.reason,
      logoFound: !!logoBuffer,
      warnings: [
        ...result.warnings,
        ...(teamLookup.warnings || []),
      ],
      // base64 for inline preview in the UI
      jpegBase64: result.buffer.toString('base64'),
      sizeBytes: result.buffer.length,
    });
  } catch (err) {
    console.error('[sytist/composite/preview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Phase 11: per-order, per-cart-line layout overrides ──────
//
// When a customer's photo is positioned poorly by the standard layout,
// an operator opens the override editor and nudges slot positions/sizes
// for THAT cart line only. The original layout stays untouched. Other
// orders keep using it normally.
//
// Endpoints:
//   GET    /overrides/:orderId/:cartId       — fetch existing override
//   POST   /overrides/:orderId/:cartId       — save (create or update)
//   DELETE /overrides/:orderId/:cartId       — remove the override
//   POST   /overrides/:orderId/:cartId/render — apply override and write
//                                              composite + .txt files.
//                                              Body: { mode: 'overwrite'|'reprint' }
//   GET    /overrides/by-order/:orderId      — list overrides for an order

/**
 * GET /api/sytist/overrides/:orderId/:cartId
 * Returns the override or null if none exists.
 */
router.get('/overrides/:orderId/:cartId', async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId, 10);
    const cartId = parseInt(req.params.cartId, 10);
    const override = orderOverrideService.get(orderId, cartId);
    res.json({ override });
  } catch (err) {
    console.error('[sytist/overrides GET]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/overrides/by-order/:orderId
 * Light list of overrides for an order — no full snapshots. For
 * UI badges showing which cart lines have overrides.
 */
router.get('/overrides/by-order/:orderId', async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId, 10);
    const overrides = orderOverrideService.listByOrder(orderId);
    res.json({ overrides });
  } catch (err) {
    console.error('[sytist/overrides by-order GET]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/overrides/:orderId/:cartId
 * Body: { layoutId, variant, layoutSnapshot, originalCompositeFilename? }
 *
 * Creates or updates an override. layoutSnapshot is the entire layout
 * JSON, snapshotted at edit time. Original composite filename is set
 * on first create and preserved across updates.
 */
router.post(
  '/overrides/:orderId/:cartId',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId, 10);
      const cartId = parseInt(req.params.cartId, 10);
      const {
        layoutId,
        variant,
        layoutSnapshot,
        originalCompositeFilename,
      } = req.body || {};
      if (!layoutId || !variant || !layoutSnapshot) {
        return res.status(400).json({
          error: 'layoutId, variant, layoutSnapshot are required',
        });
      }
      const override = orderOverrideService.upsert({
        orderId,
        cartId,
        layoutId,
        variant,
        layoutSnapshot,
        originalCompositeFilename,
        createdBy: req.user?.username || null,
      });
      res.json({ success: true, override });
    } catch (err) {
      console.error('[sytist/overrides POST]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * DELETE /api/sytist/overrides/:orderId/:cartId
 * Removes the override row. If body has rerenderOriginal=true, also
 * re-renders the cart line using the ORIGINAL layout (the one mapped
 * to the SKU) so the on-disk image is restored to a pre-override
 * state.
 */
router.delete(
  '/overrides/:orderId/:cartId',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId, 10);
      const cartId = parseInt(req.params.cartId, 10);
      const { rerenderOriginal } = req.body || {};

      // Capture the override before deleting so we know what filename
      // to overwrite if rerenderOriginal is requested.
      const before = orderOverrideService.get(orderId, cartId);
      const removed = orderOverrideService.remove(orderId, cartId);

      let restoreResult = null;
      if (removed && rerenderOriginal && before) {
        try {
          restoreResult = await renderOverrideForOrder({
            orderId,
            cartId,
            layout: null, // null → use SKU's mapped layout (original)
            mode: 'overwrite',
            // Use the captured original filename so we overwrite the
            // right file, not whatever the renderer would compute.
            forcedOutputFilename:
              before.originalCompositeFilename || null,
          });
        } catch (err) {
          // The override IS removed at this point — surface the
          // restore failure but don't undo the delete.
          return res.json({
            success: true,
            removed: true,
            restoreError: err.message,
          });
        }
      }

      res.json({
        success: true,
        removed,
        restored: !!restoreResult,
        restoreResult,
      });
    } catch (err) {
      console.error('[sytist/overrides DELETE]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/sytist/overrides/:orderId/:cartId/render
 * Body: { mode: 'overwrite' | 'reprint' }
 *
 * Apply the saved override and write the composite (and .txt for
 * reprint) to disk.
 *
 *   mode='overwrite': writes the composite to the original filename
 *     under the global output path. The existing whole-order .txt file
 *     already references that filename, so no .txt change needed.
 *
 *   mode='reprint': writes a new composite with _REPRINT suffix in the
 *     same folder, plus a single-item .txt file pointing to it. The
 *     reprint qty matches the original cart line's qty.
 */
router.post(
  '/overrides/:orderId/:cartId/render',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId, 10);
      const cartId = parseInt(req.params.cartId, 10);
      const { mode } = req.body || {};
      if (mode !== 'overwrite' && mode !== 'reprint') {
        return res.status(400).json({
          error: "mode must be 'overwrite' or 'reprint'",
        });
      }
      const result = await renderOverrideForOrder({
        orderId,
        cartId,
        mode,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[sytist/overrides render POST]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * Shared renderer used by override save+render and override delete+restore.
 * Pulls the order, line item, photos, and layout (overridden or original);
 * runs the composite engine; writes outputs.
 *
 * Args:
 *   orderId, cartId — what to render
 *   layout — optional explicit layout. If null, uses override (if exists)
 *            else SKU's mapped layout.
 *   mode — 'overwrite' (replace original file) or 'reprint' (new _REPRINT
 *          file + single-item .txt)
 *   forcedOutputFilename — optional. If set, overrides the computed
 *                          filename. Used for restore-after-delete.
 *
 * Returns: { mode, compositeFilename, compositePath, txtPath?, warnings }
 */
async function renderOverrideForOrder({
  orderId,
  cartId,
  layout: explicitLayout = null,
  mode,
  forcedOutputFilename = null,
}) {
  const path = require('path');
  const fsp = require('fs').promises;

  // ─── Resolve order and line item ──────────────────────
  const order = await sytistDb.getOrderById(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  const lineItem = (order.lineItems || []).find(
    (li) => String(li.cartId) === String(cartId)
  );
  if (!lineItem) {
    throw new Error(`Cart ${cartId} not found in order ${orderId}`);
  }
  if (!lineItem.photo || !lineItem.photo.fullUrl) {
    throw new Error(`Line item has no player photo URL`);
  }

  // ─── Resolve layout: explicit > override > mapping ─────
  let layout = explicitLayout;
  if (!layout) {
    const override = orderOverrideService.get(orderId, cartId);
    if (override) {
      layout = override.layoutSnapshot;
    } else {
      const mapping = await compositeService.findMapping(lineItem.sku);
      if (!mapping) {
        throw new Error(
          `No composite mapping for SKU "${lineItem.sku}" and no override exists`
        );
      }
      layout = await compositeService.getLayout(mapping.layoutId);
      if (!layout) {
        throw new Error(`Mapped layout "${mapping.layoutId}" missing`);
      }
    }
  }

  // ─── Fetch player photo, team photo, logo, background ──
  const playerResp = await fetch(lineItem.photo.fullUrl);
  if (!playerResp.ok) {
    throw new Error(`Player photo fetch failed: HTTP ${playerResp.status}`);
  }
  const playerPhoto = Buffer.from(await playerResp.arrayBuffer());

  const variant = compositeService.pickVariant(
    layout,
    lineItem.photo.width || 0,
    lineItem.photo.height || 0
  );

  const teamLookup = await teamPhotoService.findTeamPhoto(
    lineItem.subGalleryId
  );
  let teamPhotoBuffer = null;
  if (teamLookup.found && teamLookup.photo.fullUrl) {
    try {
      const tpResp = await fetch(teamLookup.photo.fullUrl);
      if (tpResp.ok) {
        teamPhotoBuffer = Buffer.from(await tpResp.arrayBuffer());
      }
    } catch (err) {
      console.warn(`[Override render] team photo fetch: ${err.message}`);
    }
  }

  let logoBuffer = null;
  const galleryId = lineItem.galleryId || order.galleryId || null;
  if (galleryId) {
    logoBuffer = await galleryAssetsService.readLogoBuffer(galleryId);
  }

  // Background photo (Phase 10 / 10b pattern)
  const variantDef = layout.variants?.[variant] || { slots: [] };
  let playerBackgroundBuffer = null;
  const layoutHasBackgroundSlot = (variantDef.slots || []).some(
    (s) => s.kind === 'playerBackground'
  );
  if (layoutHasBackgroundSlot && lineItem.backgroundPhoto?.fullUrl) {
    try {
      const bgResp = await fetch(lineItem.backgroundPhoto.fullUrl);
      if (bgResp.ok) {
        playerBackgroundBuffer = Buffer.from(await bgResp.arrayBuffer());
      }
    } catch (err) {
      console.warn(
        `[Override render] background photo fetch: ${err.message}`
      );
    }
  }

  const tokens = compositeService.buildTokensFromOrder(order, lineItem);

  // Static graphics
  const graphicsMap = {};
  const seenKeys = new Set();
  for (const s of variantDef.slots || []) {
    if (s.kind !== 'staticGraphic' && s.kind !== 'overlay') continue;
    const key = s.graphicKey || s.overlayId;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const meta = layout.graphics ? layout.graphics[key] : null;
    try {
      const buf = await compositeGraphicsService.readGraphicBuffer({
        layoutId: layout.id,
        key,
        filename: meta && meta.filename,
      });
      if (buf) graphicsMap[key] = buf;
    } catch {}
  }
  tokens.overlays = graphicsMap;

  const result = await compositeService.buildSheetBuffer({
    layout,
    variant,
    playerPhoto,
    teamPhoto: teamPhotoBuffer,
    logo: logoBuffer,
    playerBackground: playerBackgroundBuffer,
    tokens,
  });

  // ─── Determine output path + filename ─────────────────
  // Use the SAME path resolver that the production pipeline uses.
  // This way overrides land in the same place as normal output.
  const outputDir = pathsService.resolveFullPath(
    'downloadBase',
    order,
    [] // no folder-sort segments — overrides go to the order's root output
  );
  await fsp.mkdir(outputDir, { recursive: true });

  // Compute filenames.
  const baseFilename =
    forcedOutputFilename ||
    `${orderId}_${cartId}_composite_${layout.id}.jpg`;
  const compositeFilename =
    mode === 'reprint'
      ? baseFilename.replace(/\.jpg$/i, '_REPRINT.jpg')
      : baseFilename;
  const compositePath = path.win32.join(outputDir, compositeFilename);

  // Write image atomically
  const tmpPath = compositePath + '.tmp';
  await fsp.writeFile(tmpPath, result.buffer);
  await fsp.rename(tmpPath, compositePath);

  // ─── For reprint mode, also write a single-item .txt ───
  let txtPath = null;
  if (mode === 'reprint') {
    // Build a single-line-item view of the order so darkroom's
    // buildOrderTxt only emits one Qty/Size/Filepath block. Qty is
    // preserved from the original cart line — operator's intent is
    // "reprint exactly what the customer ordered, with the corrected
    // image".
    const reprintLineItem = {
      ...lineItem,
      // Swap the photo's filename so darkroom's Filepath= uses the new
      // _REPRINT image we just wrote.
      photo: {
        ...lineItem.photo,
        originalFilename: compositeFilename,
      },
    };
    const reprintOrder = {
      ...order,
      lineItems: [reprintLineItem],
    };

    const txtBuild = await darkroomService.buildOrderTxt(reprintOrder, {});
    if (txtBuild) {
      // Rename the .txt's path to include a _REPRINT suffix and the
      // cart ID (so two reprints from the same order don't collide
      // and so it's distinguishable from the original whole-order .txt).
      const origTxtPath = txtBuild.filePath;
      const ext = path.win32.extname(origTxtPath);
      const baseNoExt = origTxtPath.slice(0, -ext.length);
      const reprintTxtPath = `${baseNoExt}_${cartId}_REPRINT${ext}`;
      const reprintTxtFilename = path.win32.basename(reprintTxtPath);
      const txtBuildAdjusted = {
        ...txtBuild,
        filePath: reprintTxtPath,
        filename: reprintTxtFilename,
      };
      const txtResult = await darkroomService.writeTxtFile(
        txtBuildAdjusted,
        {}
      );
      txtPath = txtResult ? txtResult.filePath : null;
    }

    // Update the override row with the reprint filename for tracking
    try {
      orderOverrideService.setReprintFilename(
        orderId,
        cartId,
        compositeFilename
      );
    } catch (e) {
      // Non-fatal — the file is written, the override row just won't
      // record it. Surface in warnings.
      result.warnings = [
        ...(result.warnings || []),
        {
          type: 'override_record_update_failed',
          message: `Could not record reprint filename: ${e.message}`,
        },
      ];
    }
  }

  return {
    mode,
    compositeFilename,
    compositePath,
    txtPath,
    variant,
    warnings: result.warnings || [],
  };
}

// ─── Composite graphics (Phase 9c) ────────────────────────
//
// Per-layout static graphics (formerly "overlays" in slot kind
// terminology). Files live under server/config/composite-graphics/<layoutId>/
// and are referenced by `graphicKey` from layout slots.
//
// CRUD lives here rather than embedded in compositeService because the
// upload requires the request body (HTTP-aware) and the service stays
// pure (filesystem only).

/**
 * GET /api/sytist/composite/layouts/:layoutId/graphics
 * Returns metadata for all graphics in this layout's library.
 * Reconciles the layout JSON's `graphics` map against the on-disk
 * directory so callers see an accurate picture even if they ever
 * drift apart.
 */
router.get(
  '/composite/layouts/:layoutId/graphics',
  async (req, res) => {
    try {
      const layout = await compositeService.getLayout(req.params.layoutId);
      if (!layout) {
        return res.status(404).json({ error: 'Layout not found' });
      }
      const onDisk = await compositeGraphicsService.listGraphicsOnDisk(
        layout.id
      );
      const inJson = layout.graphics || {};

      // Merge: prefer JSON metadata (has uploadedAt etc.), fall back to
      // on-disk-only entries
      const byKey = {};
      for (const item of onDisk) {
        byKey[item.key] = {
          key: item.key,
          filename: item.filename,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          inJson: false,
        };
      }
      for (const [key, meta] of Object.entries(inJson)) {
        byKey[key] = {
          ...byKey[key],
          ...meta,
          key,
          inJson: true,
          onDisk: !!byKey[key],
        };
      }
      res.json({
        layoutId: layout.id,
        graphics: Object.values(byKey),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/sytist/composite/layouts/:layoutId/graphics/:key
 * Upload (or replace) a graphic file under the given key.
 * Body: { dataBase64, filename }
 *
 * Updates layout.graphics[key] in the layout JSON to reflect the new
 * file. Both writes happen in this handler — service stays decoupled.
 *
 * Phase 9e-hotfix: per-route body-parser with 15 MB limit. The default
 * express.json() middleware caps at 100kb which silently truncates
 * large image uploads. 15 MB = enough headroom for a 10 MB binary
 * base64-encoded (~13.3 MB) plus JSON overhead. Without this, an 8×10
 * @ 300 DPI PNG (3-7 MB raw, 4-9 MB base64) would either fail with a
 * 413 or come through empty depending on Express version.
 */
const graphicUploadJsonParser = express.json({ limit: '15mb' });

router.post(
  '/composite/layouts/:layoutId/graphics/:key',
  requireRole('admin'),
  graphicUploadJsonParser,
  async (req, res) => {
    try {
      const { layoutId, key } = req.params;
      const { dataBase64, filename } = req.body || {};
      if (!dataBase64) {
        return res.status(400).json({ error: 'dataBase64 is required' });
      }
      const layout = await compositeService.getLayout(layoutId);
      if (!layout) {
        return res.status(404).json({ error: 'Layout not found' });
      }
      const fileBuffer = Buffer.from(dataBase64, 'base64');

      // Phase 9e-hotfix: log byte counts so size mismatches are obvious
      // in server logs. If the browser sent N bytes of base64 but we
      // decoded < N * 0.75, the body got truncated somewhere.
      console.log(
        `[composite/graphics POST] layout=${layoutId} key=${key} base64Length=${dataBase64.length} decodedBytes=${fileBuffer.length} filename=${filename || '?'}`
      );

      // Save the file
      const meta = await compositeGraphicsService.saveGraphic({
        layoutId,
        key,
        fileBuffer,
        uploadedBy: req.user?.username || null,
      });

      // Update layout.graphics map
      const updatedLayout = {
        ...layout,
        graphics: {
          ...(layout.graphics || {}),
          [key]: {
            filename: meta.filename,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            uploadedAt: meta.uploadedAt,
            uploadedBy: meta.uploadedBy,
            originalFilename: filename || null,
          },
        },
      };
      await compositeService.updateLayout(layoutId, updatedLayout);

      res.json({
        success: true,
        graphic: { key, ...updatedLayout.graphics[key] },
      });
    } catch (err) {
      console.error('[sytist/composite/graphics POST]', err);
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * DELETE /api/sytist/composite/layouts/:layoutId/graphics/:key
 * Remove a graphic from the library. Slots that referenced this
 * key will render with a "missing_graphic" warning until updated.
 */
router.delete(
  '/composite/layouts/:layoutId/graphics/:key',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { layoutId, key } = req.params;
      const layout = await compositeService.getLayout(layoutId);
      if (!layout) {
        return res.status(404).json({ error: 'Layout not found' });
      }
      await compositeGraphicsService.deleteGraphicFile({ layoutId, key });
      const nextGraphics = { ...(layout.graphics || {}) };
      delete nextGraphics[key];
      await compositeService.updateLayout(layoutId, {
        ...layout,
        graphics: nextGraphics,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// (Public composite-graphics preview lives at the top of this file —
// before the auth middleware — see Phase 9e-hotfix3.)


/**
 * GET /api/sytist/composite/layouts/:layoutId/graphics/:key/info
 * Phase 9e-hotfix diagnostic: return metadata about a stored graphic
 * file — file size, mime type, JSON-recorded metadata. Used to debug
 * upload pipeline issues. If saved file size doesn't match what was
 * uploaded, the upload pipeline is corrupting bytes somewhere.
 */
router.get(
  '/composite/layouts/:layoutId/graphics/:key/info',
  async (req, res) => {
    try {
      const { layoutId, key } = req.params;
      const layout = await compositeService.getLayout(layoutId);
      if (!layout) {
        return res.status(404).json({ error: 'Layout not found' });
      }
      const meta = layout.graphics ? layout.graphics[key] : null;
      const opened = await compositeGraphicsService.openGraphicStream({
        layoutId,
        key,
        filename: meta && meta.filename,
      });
      if (!opened) {
        return res.status(404).json({
          error: 'Graphic file not found on disk',
          jsonMeta: meta,
        });
      }
      // Drain the stream just to compute size; don't return the bytes
      let actualSize = 0;
      for await (const chunk of opened.stream) {
        actualSize += chunk.length;
      }
      res.json({
        layoutId,
        key,
        onDisk: {
          mimeType: opened.mimeType,
          headerSizeBytes: opened.sizeBytes,
          streamedBytes: actualSize,
        },
        jsonMeta: meta,
        sizeMatches: meta ? meta.sizeBytes === actualSize : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Gallery assets (logos + overlays) ───────────────────

router.get('/gallery-assets/stats', async (req, res) => {
  try {
    res.json(await galleryAssetsService.getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gallery-assets/logos', async (req, res) => {
  try {
    res.json({ logos: await galleryAssetsService.listLogos() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sytist/gallery-assets/logos/:galleryId/exists
 *
 * Phase 12: lightweight check used by the order-detail page to warn
 * the operator BEFORE they hit Process if the order's gallery has
 * no logo set. Returns { exists, filename? } — no image bytes, so
 * cheap to call on page load.
 */
router.get('/gallery-assets/logos/:galleryId/exists', async (req, res) => {
  try {
    const galleryId = parseInt(req.params.galleryId, 10);
    if (!galleryId || galleryId <= 0) {
      return res
        .status(400)
        .json({ error: 'galleryId must be a positive integer' });
    }
    const meta = await galleryAssetsService.getLogo(galleryId);
    if (!meta) {
      return res.json({ exists: false });
    }
    res.json({ exists: true, filename: meta.logoFilename || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sytist/gallery-assets/logos/:galleryId
 * Body: { filename: 'logo.png', dataBase64: '...' }
 *
 * Upload a logo for a gallery via base64-in-JSON. Avoids needing a
 * multipart parser; payload is small (logos cap at 10MB).
 */
router.post(
  '/gallery-assets/logos/:galleryId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { filename, dataBase64 } = req.body || {};
      if (!filename || !dataBase64) {
        return res
          .status(400)
          .json({ error: 'filename and dataBase64 are required' });
      }
      const fileBuffer = Buffer.from(dataBase64, 'base64');
      const galleryId = parseInt(req.params.galleryId, 10);
      const entry = await galleryAssetsService.setLogo({
        galleryId,
        fileBuffer,
        filename,
        uploadedBy: req.user?.username || null,
      });
      res.json({ success: true, logo: entry });
    } catch (err) {
      console.error('[sytist/gallery-assets/logos POST]', err);
      res.status(400).json({ error: err.message });
    }
  }
);

router.delete(
  '/gallery-assets/logos/:galleryId',
  requireRole('admin'),
  async (req, res) => {
    try {
      const galleryId = parseInt(req.params.galleryId, 10);
      const result = await galleryAssetsService.deleteLogo(galleryId);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * GET /api/sytist/gallery-assets/logos/:galleryId/preview
 *
 * (Public — see Phase 9e-hotfix3. Duplicate registration above the
 * auth middleware takes precedence over this one. Left here as
 * dead code documentation; can be removed in a future cleanup.)
 */
// router.get('/gallery-assets/logos/:galleryId/preview', ...) — handled above

router.get('/gallery-assets/overlays', async (req, res) => {
  try {
    res.json({ overlays: await galleryAssetsService.listOverlays() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post(
  '/gallery-assets/overlays',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { name, filename, dataBase64 } = req.body || {};
      if (!name || !filename || !dataBase64) {
        return res
          .status(400)
          .json({ error: 'name, filename, dataBase64 are required' });
      }
      const fileBuffer = Buffer.from(dataBase64, 'base64');
      const entry = await galleryAssetsService.addOverlay({
        name,
        fileBuffer,
        filename,
        uploadedBy: req.user?.username || null,
      });
      res.json({ success: true, overlay: entry });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

router.delete(
  '/gallery-assets/overlays/:id',
  requireRole('admin'),
  async (req, res) => {
    try {
      const result = await galleryAssetsService.deleteOverlay(req.params.id);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ──────────────────────────────────────────────────────────
// PHASE 15a: PACKAGE CONTENTS
// ──────────────────────────────────────────────────────────
//
// CRUD for the per-package-SKU contents config that drives the
// explosion of package line items in sytistDbService. Read access
// for any logged-in user; write access for admin/operator only.

// GET /api/sytist/package-contents — full config
router.get('/package-contents', async (req, res) => {
  try {
    const packageContentsService = require('../services/packageContentsService');
    const config = await packageContentsService.getConfig();
    res.json({ packages: config });
  } catch (err) {
    console.error('[sytist/package-contents]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sytist/package-contents — replace the entire config
// Body: { packages: { "1": { name, items: [{sku, qty}, ...] }, ... } }
router.put(
  '/package-contents',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const packageContentsService = require('../services/packageContentsService');
      const incoming = (req.body && req.body.packages) || req.body || {};
      const saved = await packageContentsService.updateConfig(incoming, {
        username: req.user?.username,
      });
      res.json({ packages: saved });
    } catch (err) {
      console.error('[sytist/package-contents PUT]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// PUT /api/sytist/package-contents/:sku — update a single package
// Body: { name, items: [{sku, qty}, ...] }
router.put(
  '/package-contents/:sku',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const packageContentsService = require('../services/packageContentsService');
      const saved = await packageContentsService.updatePackage(
        req.params.sku,
        req.body || {},
        { username: req.user?.username }
      );
      res.json({ packages: saved });
    } catch (err) {
      console.error('[sytist/package-contents/:sku PUT]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /api/sytist/package-contents/:sku
router.delete(
  '/package-contents/:sku',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const packageContentsService = require('../services/packageContentsService');
      const saved = await packageContentsService.deletePackage(
        req.params.sku,
        { username: req.user?.username }
      );
      res.json({ packages: saved });
    } catch (err) {
      console.error('[sytist/package-contents/:sku DELETE]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/sytist/package-contents/lint — sanity check the config
// against current packaging-config + composite/imposition mappings.
// Returns warnings the Settings UI surfaces inline:
//   - Items missing from packaging-config's productWeights
//   - Items with no composite mapping AND no imposition mapping
//     (those will produce a full-size print instead of the intended
//     product, e.g. trading cards without an imposition rule)
//
// Phase 15a hotfix-1: composite and imposition mappings store their
// SKU under `externalId` (not `sku`). The first cut keyed by `m.sku`
// which silently returned undefined for every SKU, causing every
// item to warn as if it had no mapping. Now we key by externalId.
router.get('/package-contents/lint', async (req, res) => {
  try {
    const packageContentsService = require('../services/packageContentsService');
    const packagingService = require('../services/packagingService');
    const compositeService = require('../services/compositeService');
    const impositionService = require('../services/impositionService');

    const config = await packageContentsService.getConfig();
    const packagingCfg = await packagingService.getConfig();
    const productWeights = packagingCfg.productWeights || {};

    // Composite mappings: listMappings() returns an array of
    // { externalId, layoutId, chainToImposition }. Key by externalId.
    let compositeMappings = {};
    try {
      const list = await compositeService.listMappings();
      const arr = Array.isArray(list) ? list : [];
      for (const m of arr) {
        if (m && m.externalId != null) {
          compositeMappings[String(m.externalId)] = m;
        }
      }
    } catch (err) {
      console.warn('[lint] composite mappings load failed:', err.message);
    }

    // Imposition mappings: getMappings() returns an array of
    // { externalId, layoutId, orientation?, layoutName }. Key by
    // externalId. Note: a SKU can appear multiple times (different
    // orientations) — any one entry counts as "has a mapping" for
    // this check.
    let impositionMappings = {};
    try {
      const list = await impositionService.getMappings();
      const arr = Array.isArray(list) ? list : [];
      for (const m of arr) {
        if (m && m.externalId != null) {
          impositionMappings[String(m.externalId)] = m;
        }
      }
    } catch (err) {
      console.warn('[lint] imposition mappings load failed:', err.message);
    }

    const warnings = [];
    for (const [pkgSku, pkg] of Object.entries(config)) {
      for (const item of pkg.items || []) {
        const itemSku = String(item.sku);
        const w = productWeights[itemSku];
        const hasComposite = !!compositeMappings[itemSku];
        const hasImposition = !!impositionMappings[itemSku];
        const isDigital = w && w.category === 'digital';

        if (!w) {
          warnings.push({
            severity: 'error',
            packageSku: pkgSku,
            packageName: pkg.name,
            itemSku,
            message: `SKU ${itemSku} is not in Settings → Packaging → Product weights. Add it so the engine knows its weight.`,
          });
        }
        if (!isDigital && !hasComposite && !hasImposition) {
          warnings.push({
            severity: 'warning',
            packageSku: pkgSku,
            packageName: pkg.name,
            itemSku,
            itemName: w?.name || `SKU ${itemSku}`,
            message: `SKU ${itemSku} has no composite or imposition mapping — will print as one full-size copy of the photo instead of the intended product.`,
          });
        }
      }
    }

    res.json({ warnings });
  } catch (err) {
    console.error('[sytist/package-contents/lint]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// PHASE 15b: ADDON MAPPINGS
// ──────────────────────────────────────────────────────────
//
// CRUD for the co_opt_id → SKU mappings used by the order pipeline
// to expand ms_cart_options rows into synthetic line items.
// Plus an auto-discovery endpoint that scans recent orders for
// unmapped option IDs.

// GET /api/sytist/addon-mappings — full config
router.get('/addon-mappings', async (req, res) => {
  try {
    const addonMappingsService = require('../services/addonMappingsService');
    const mappings = await addonMappingsService.getConfig();
    res.json({ mappings });
  } catch (err) {
    console.error('[sytist/addon-mappings]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sytist/addon-mappings — replace the entire config
// Body: { mappings: { "2007": { name, sku }, ... } }
router.put(
  '/addon-mappings',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const addonMappingsService = require('../services/addonMappingsService');
      const incoming = (req.body && req.body.mappings) || req.body || {};
      const saved = await addonMappingsService.updateConfig(incoming, {
        username: req.user?.username,
      });
      res.json({ mappings: saved });
    } catch (err) {
      console.error('[sytist/addon-mappings PUT]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// PUT /api/sytist/addon-mappings/:optId — update a single mapping
// Body: { name, sku }
router.put(
  '/addon-mappings/:optId',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const addonMappingsService = require('../services/addonMappingsService');
      const saved = await addonMappingsService.updateMapping(
        req.params.optId,
        req.body || {},
        { username: req.user?.username }
      );
      res.json({ mappings: saved });
    } catch (err) {
      console.error('[sytist/addon-mappings/:optId PUT]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /api/sytist/addon-mappings/:optId
router.delete(
  '/addon-mappings/:optId',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const addonMappingsService = require('../services/addonMappingsService');
      const saved = await addonMappingsService.deleteMapping(
        req.params.optId,
        { username: req.user?.username }
      );
      res.json({ mappings: saved });
    } catch (err) {
      console.error('[sytist/addon-mappings/:optId DELETE]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/sytist/addon-mappings/discovery
// Scans recent (completed) orders for ms_cart_options.co_opt_id
// values and returns those not yet in the mapping config, ranked by
// occurrence count. Useful for "what add-ons have customers actually
// ordered that I haven't configured yet."
//
// Query params:
//   limit — number of recent orders to scan (default 200, max 1000)
//
// Response:
//   { unmappedOptions: [{ optId, optName, occurrences, samplePrice }, ...] }
router.get('/addon-mappings/discovery', async (req, res) => {
  const t0 = Date.now();
  console.log('[discovery] start');
  try {
    const addonMappingsService = require('../services/addonMappingsService');
    const sytistDb = require('../services/sytistDbService');
    const pool = sytistDb.getPool();

    const limit = Math.min(
      5000,
      Math.max(50, parseInt(req.query.limit, 10) || 500)
    );

    // Phase 15b hotfix-1: split into two queries because old MySQL
    // rejects LIMIT inside IN subqueries.
    console.log('[discovery] querying recent orders, limit=' + limit);
    const [recentOrderRows] = await pool.query(
      `SELECT order_id FROM ms_orders
       WHERE order_payment_status = 'Completed'
         AND order_erased = 0
       ORDER BY order_date DESC
       LIMIT ?`,
      [limit]
    );
    const recentOrderIds = recentOrderRows.map((r) => r.order_id);
    console.log('[discovery] got ' + recentOrderIds.length + ' order ids in ' + (Date.now() - t0) + 'ms');
    if (recentOrderIds.length === 0) {
      return res.json({ unmappedOptions: [], scannedOrders: limit });
    }

    const sql = `
      SELECT co.co_opt_id, co.co_opt_name,
             COUNT(*) AS occurrences,
             AVG(co.co_price) AS avg_price
      FROM ms_cart_options co
      JOIN ms_cart c ON c.cart_id = co.co_cart_id
      WHERE c.cart_order IN (?)
      GROUP BY co.co_opt_id, co.co_opt_name
      ORDER BY occurrences DESC
    `;
    console.log('[discovery] querying options for ' + recentOrderIds.length + ' orders');
    const [rows] = await pool.query(sql, [recentOrderIds]);
    console.log('[discovery] got ' + rows.length + ' option rows in ' + (Date.now() - t0) + 'ms total');

    const config = await addonMappingsService.getConfig();
    const unmappedOptions = [];
    for (const row of rows) {
      const optId = row.co_opt_id != null ? String(row.co_opt_id) : null;
      if (!optId) continue;
      // Phase 15c hotfix-2: completeness depends on type.
      //   product type:  needs sku
      //   modifier type: needs suffix
      // Phase 15b checked only sku, which meant modifier mappings
      // (suffix-only, no sku) still appeared as "unmapped" in
      // discovery even after being saved.
      const m = config[optId];
      if (m) {
        const isModifier = m.type === 'modifier';
        const complete = isModifier ? !!m.suffix : !!m.sku;
        if (complete) continue;
      }
      unmappedOptions.push({
        optId,
        optName: row.co_opt_name || '',
        occurrences: Number(row.occurrences || 0),
        samplePrice: Number(row.avg_price || 0),
      });
    }
    console.log('[discovery] done, ' + unmappedOptions.length + ' unmapped in ' + (Date.now() - t0) + 'ms');
    res.json({ unmappedOptions, scannedOrders: limit });
  } catch (err) {
    console.error('[discovery] ERROR after ' + (Date.now() - t0) + 'ms:', err.message);
    console.error('[discovery] stack:', err.stack);
    console.error('[discovery] code:', err.code, 'errno:', err.errno);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// ──────────────────────────────────────────────────────────
// PHASE 16: CONFIG HISTORY + EXPORT/IMPORT
// ──────────────────────────────────────────────────────────

// GET /api/sytist/config-history?type=&id=&limit=
//
// Audit trail for a single config entity. Both query params required.
//   type — 'addon_mapping' | 'package' | 'order_override'
//   id   — entity identifier (opt_id, package_sku, or "<orderId>:<cartId>")
//   limit — optional, 1-500, defaults to 50
router.get('/config-history', async (req, res) => {
  try {
    const configHistory = require('../services/configHistoryService');
    const { type, id, limit } = req.query;
    if (!type || !id) {
      return res.status(400).json({
        error: "Both 'type' and 'id' query params are required",
      });
    }
    const history = configHistory.list({
      configType: String(type),
      entityId: String(id),
      limit,
    });
    res.json({ history });
  } catch (err) {
    console.error('[sytist/config-history]', err);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/sytist/config-history/recent?type=&limit=
//
// Recent changes across all entities of a config type. Useful for
// a "what's changed lately" overview.
router.get('/config-history/recent', async (req, res) => {
  try {
    const configHistory = require('../services/configHistoryService');
    const { type, limit } = req.query;
    if (!type) {
      return res.status(400).json({ error: "'type' query param is required" });
    }
    const history = configHistory.recent({
      configType: String(type),
      limit,
    });
    res.json({ history });
  } catch (err) {
    console.error('[sytist/config-history/recent]', err);
    res.status(400).json({ error: err.message });
  }
});

// ─── Export / import: addon mappings ─────────────────────

// GET /api/sytist/addon-mappings/export
//   Downloads the full config as a JSON file.
router.get('/addon-mappings/export', async (req, res) => {
  try {
    const addonMappingsService = require('../services/addonMappingsService');
    const cfg = await addonMappingsService.getConfig();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="addon-mappings-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`
    );
    res.send(JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[sytist/addon-mappings/export]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sytist/addon-mappings/import
//   Body: full JSON config in the same shape as export.
//   Replaces the entire config.
router.put(
  '/addon-mappings/import',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const addonMappingsService = require('../services/addonMappingsService');
      const incoming = req.body || {};
      // Tolerate either { mappings: {...} } or the flat shape itself
      const cfg = incoming.mappings || incoming;
      const saved = await addonMappingsService.updateConfig(cfg, {
        username: req.user?.username,
      });
      res.json({ mappings: saved });
    } catch (err) {
      console.error('[sytist/addon-mappings/import]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Export / import: package contents ───────────────────

router.get('/package-contents/export', async (req, res) => {
  try {
    const packageContentsService = require('../services/packageContentsService');
    const cfg = await packageContentsService.getConfig();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="package-contents-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`
    );
    res.send(JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[sytist/package-contents/export]', err);
    res.status(500).json({ error: err.message });
  }
});

router.put(
  '/package-contents/import',
  requireRole('admin', 'operator'),
  async (req, res) => {
    try {
      const packageContentsService = require('../services/packageContentsService');
      const incoming = req.body || {};
      const cfg = incoming.packages || incoming;
      const saved = await packageContentsService.updateConfig(cfg, {
        username: req.user?.username,
      });
      res.json({ packages: saved });
    } catch (err) {
      console.error('[sytist/package-contents/import]', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
