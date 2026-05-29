// server/routes/shipstation.js
//
// Phase 13a: REST endpoints for the ShipStation integration. Adapted
// from the PhotoDay routes file.
//
// Auth: requireAuth is applied to ALL routes here via router.use()
// below — every endpoint reads or writes either credentials or live
// ShipStation state, so none of them should be public. Following the
// same pattern sytist.js uses.

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const shipstationService = require('../services/shipstationService');
const shipstationLinkService = require('../services/shipstationLinkService');
const sytistDb = require('../services/sytistDbService');
const appSettings = require('../config/appSettings');

// Initialize the link service early so the table exists before any
// request hits it. Service init is idempotent so this is safe.
try {
  shipstationLinkService.init();
} catch (e) {
  console.warn('[shipstation] link service init failed:', e.message);
}

// Gate every route below this with auth — no public endpoints in this
// file. (If we ever add one — e.g. a webhook callback from ShipStation
// — move it ABOVE this line and verify it with a different mechanism
// like signature verification.)
router.use(requireAuth);

// ─── APP SETTINGS (API KEYS, ETC.) ─────────────────────────
// We expose these under /api/shipstation/app-settings rather than
// /api/settings/app-settings to keep the ShipStation feature
// self-contained. If/when we add other API-keyed integrations we'll
// extract these into a shared route.

router.get('/app-settings', async (req, res) => {
  try {
    const settings = await appSettings.getSettings();
    const fields = appSettings.getFieldDefinitions();
    res.json({ settings, fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/app-settings', async (req, res) => {
  try {
    const updates = req.body || {};
    const updated = await appSettings.updateSettings(updates);
    res.json({ settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PER-ORDER SHIPPING STATE ──────────────────────────────
// The order detail page hits this to render the Ship card. Returns
// either { linked: true, link: {...} } (already sent) or
// { linked: false, eligibility: {...} } (showing whether the order
// can be sent and why/why-not).

router.get('/orders/:orderId/status', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const link = shipstationLinkService.getByOrderId(orderId);
    if (link) {
      return res.json({
        linked: true,
        link: _maskLink(link),
      });
    }
    // Not linked yet — compute eligibility so the UI can show the
    // operator what the situation is before they pick "Send."
    const order = await sytistDb.getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const eligibility = await _computeEligibility(order);

    // Phase 13b: if the order is eligible, also include the packaging
    // engine's suggestion so the UI can pre-populate the Ship form
    // with what the rules engine decided. Ineligible orders skip
    // this — there's no shippable content to preview.
    let packaging = null;
    if (eligibility.eligible) {
      try {
        const preview = await shipstationService.previewPackagingForOrder(
          order
        );
        packaging = preview.ok ? preview.packaging : null;
      } catch (err) {
        console.warn(
          `[shipstation] packaging preview failed for ${orderId}: ${err.message}`
        );
      }
    }

    res.json({
      linked: false,
      eligibility,
      order: _orderSummary(order),
      packaging,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eligibility check exposed standalone — used by the orders list /
// dashboard if it wants to render badges in the future.
router.get('/orders/:orderId/eligibility', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const eligibility = await _computeEligibility(order);
    res.json({ eligibility, order: _orderSummary(order) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE ORDER IN SHIPSTATION ───────────────────────────
// Single-order send. Body shape (all optional — falls back to defaults):
//   { carrierCode, serviceCode, packageCode, weight: {value, units},
//     dimensions: {length, width, height, units} }

router.post('/orders/:orderId/create', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    // Already linked? Don't create a duplicate — return the existing
    // link with a clear status. Operator can delete + re-create if
    // they really want a fresh one.
    const existing = shipstationLinkService.getByOrderId(orderId);
    if (existing) {
      return res.status(409).json({
        error: 'Order already sent to ShipStation',
        link: _maskLink(existing),
      });
    }
    const order = await sytistDb.getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Phase 43 hotfix 2: hydrate composedImageUrl from the SQLite
    // cache. processOrder's Step 1.4 writes URLs to this cache when
    // green-screen items are composed and uploaded to S3. Without
    // hydration here, the SS payload's imageUrl falls back to
    // Sytist's raw thumbUrl — which is the keyed-out subject without
    // background. The cache is keyed by (orderId, cartId); for
    // package constituents the cart_id is the synthetic string like
    // "482071-pkg-27".
    try {
      const composedThumbnailCacheService = require('../services/composedThumbnailCacheService');
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
            `[shipstation create:${orderId}] hydrated composedImageUrl on ${hydrated} line item(s) from cache`
          );
        }
      }
    } catch (cacheErr) {
      console.warn(
        `[shipstation create:${orderId}] thumbnail cache read failed (non-fatal): ${cacheErr.message}`
      );
    }

    const overrides = req.body || {};

    // Phase 43 hotfix 2: support retry-with-modified-orderKey. When
    // SS rejects a fresh-create with 404 and we suspect orderKey
    // tombstoning, the client can re-submit with retryOrderKeySuffix
    // set, which we append to BOTH orderKey and orderNumber to make
    // the request look brand-new to ShipStation. orderNumber stays
    // searchable (we'll keep the original ID at the start) and the
    // suffix is short enough to fit in SS's orderNumber field
    // (typically 50 chars).
    const retrySuffix =
      typeof overrides.retryOrderKeySuffix === 'string' &&
      overrides.retryOrderKeySuffix.trim()
        ? overrides.retryOrderKeySuffix.trim()
        : null;
    // Remove the retry field from overrides so it doesn't leak into
    // the SS payload as an unknown field.
    delete overrides.retryOrderKeySuffix;

    const payload = await shipstationService.buildOrderFromSytist(
      order,
      overrides
    );

    // Builder may signal that there's nothing to ship (all digital, all
    // drop-shipped, etc.). Surface the reason and skip the API call.
    if (payload && payload.__skipShipStation) {
      return res.status(400).json({
        error: 'Order not eligible for ShipStation',
        reason: payload.reason,
        message: payload.message,
        skipped: payload.skipped,
      });
    }

    // Apply retry suffix BEFORE the lookup so the lookup matches the
    // payload we'll actually send.
    if (retrySuffix) {
      const safeSuffix = retrySuffix.replace(/[^A-Za-z0-9-]/g, '');
      payload.orderKey = `${payload.orderKey}-${safeSuffix}`;
      payload.orderNumber = `${payload.orderNumber}-${safeSuffix}`;
      // Note in internal notes so the recreation is auditable.
      payload.internalNotes =
        (payload.internalNotes ? payload.internalNotes + ' | ' : '') +
        `Recreated after 404 with suffix "${safeSuffix}"`;
      console.log(
        `[shipstation create:${orderId}] retry mode — orderKey=${payload.orderKey} orderNumber=${payload.orderNumber}`
      );
    }

    // Belt + suspenders: ShipStation can also return a duplicate
    // error if for some reason a row exists in SS but not in our DB.
    // Look up by orderNumber first to detect that case.
    try {
      const lookup = await shipstationService.listOrders({
        orderNumber: payload.orderNumber,
      });
      const found = (lookup?.orders || []).find(
        (o) => o.orderNumber === payload.orderNumber
      );
      if (found) {
        const link = shipstationLinkService.create({
          orderId,
          ssOrderId: found.orderId,
          ssOrderNumber: found.orderNumber,
          ssOrderStatus: found.orderStatus || 'awaiting_shipment',
          carrierCode: found.carrierCode || payload.carrierCode,
          serviceCode: found.serviceCode || payload.serviceCode,
          packageCode: found.packageCode || payload.packageCode,
          payload,
        });
        return res.json({
          linked: true,
          adopted: true,
          link: _maskLink(link),
          message: 'Existing ShipStation order adopted (not re-created)',
        });
      }
    } catch (lookupErr) {
      // Lookup failure is non-fatal; we'll still try createOrder, which
      // is the actual important call. Log so we know the lookup path
      // had a hiccup.
      console.warn(
        `[shipstation] pre-create lookup failed: ${lookupErr.message}`
      );
    }

    let result;
    try {
      result = await shipstationService.createOrder(payload);
    } catch (sendErr) {
      // Phase 43 hotfix 2: detect the 404-empty-body pattern that
      // typically means "orderKey is in a state ShipStation can't
      // resolve" — usually a previously-deleted order. Return a
      // specific code the UI can use to prompt for a retry with a
      // modified orderKey.
      //
      // We ONLY trigger the retry-eligible flow if:
      //   - the response status was 404
      //   - the response body was empty (not a real error message)
      //   - we weren't already on a retry attempt (avoid loops)
      const is404Empty =
        sendErr.statusCode === 404 &&
        (!sendErr.responseBody || sendErr.responseBody.trim() === '');
      if (is404Empty && !retrySuffix) {
        console.warn(
          `[shipstation create:${orderId}] got 404 with empty body from SS — likely orderKey tombstone. Returning retry-eligible error.`
        );
        return res.status(409).json({
          error:
            'ShipStation rejected the create with 404. The orderKey may be tombstoned from a previous deletion.',
          code: 'orderkey_tombstone_suspected',
          retryEligible: true,
          suggestedSuffix: `r${Date.now()}`,
          orderId,
        });
      }
      // Any other error: pass through.
      console.error(
        `[shipstation create:${orderId}] createOrder failed: ${sendErr.message}`
      );
      return res.status(502).json({
        error: sendErr.message,
        code: 'ss_error',
        statusCode: sendErr.statusCode || null,
      });
    }

    const link = shipstationLinkService.create({
      orderId,
      ssOrderId: result.orderId,
      ssOrderNumber: result.orderNumber || payload.orderNumber,
      ssOrderStatus: result.orderStatus || 'awaiting_shipment',
      carrierCode: result.carrierCode || payload.carrierCode,
      serviceCode: result.serviceCode || payload.serviceCode,
      packageCode: result.packageCode || payload.packageCode,
      payload,
    });
    res.json({
      linked: true,
      link: _maskLink(link),
      result,
      recreated: !!retrySuffix,
      recreatedSuffix: retrySuffix || null,
    });
  } catch (err) {
    console.error('[shipstation] create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── REFRESH STATUS FROM SHIPSTATION ───────────────────────
// Pulls the latest order state from SS and updates our local link
// row. The UI calls this when the operator clicks "Re-fetch status."

router.post('/orders/:orderId/refresh', async (req, res) => {
  try {
    const link = shipstationLinkService.getByOrderId(req.params.orderId);
    if (!link) {
      return res.status(404).json({ error: 'No ShipStation link for this order' });
    }
    let ssOrder;
    try {
      ssOrder = await shipstationService.getOrder(link.ss_order_id);
    } catch (err) {
      return res.status(502).json({
        error: `ShipStation lookup failed: ${err.message}`,
      });
    }
    // Status, tracking, and carrier may have changed since create.
    const updated = shipstationLinkService.update(req.params.orderId, {
      ssOrderStatus: ssOrder.orderStatus,
      trackingNumber:
        ssOrder.trackingNumber ||
        ssOrder.shipments?.[ssOrder.shipments.length - 1]?.trackingNumber ||
        null,
      carrierCode: ssOrder.carrierCode || null,
      serviceCode: ssOrder.serviceCode || null,
      packageCode: ssOrder.packageCode || null,
      shippedAt:
        ssOrder.orderStatus === 'shipped'
          ? ssOrder.shipDate ||
            ssOrder.shipments?.[ssOrder.shipments.length - 1]?.shipDate ||
            new Date().toISOString()
          : null,
    });
    res.json({ link: _maskLink(updated), ssOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE FROM SHIPSTATION ───────────────────────────────
// Removes the order from ShipStation AND clears the local link, so
// the operator can re-create it cleanly.

router.delete('/orders/:orderId/link', async (req, res) => {
  try {
    const link = shipstationLinkService.getByOrderId(req.params.orderId);
    if (!link) {
      return res.status(404).json({ error: 'No ShipStation link for this order' });
    }
    try {
      await shipstationService.deleteOrder(link.ss_order_id);
    } catch (err) {
      console.warn(
        `[shipstation] delete ${link.ss_order_id} on SS side failed: ${err.message}`
      );
      // We still clear the local link — operator's intent was to wipe
      // and re-create. If SS still has the order, they can delete it
      // there manually. Better than leaving the dashboard claiming a
      // link to a non-existent SS order.
    }
    shipstationLinkService.delete(req.params.orderId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MARK SHIPPED ──────────────────────────────────────────
// Manual mark-as-shipped. Body: { carrierCode, trackingNumber, shipDate? }.
// Updates SS and our local link row.

router.post('/orders/:orderId/mark-shipped', async (req, res) => {
  try {
    const { carrierCode, trackingNumber, shipDate, notifyCustomer } =
      req.body || {};
    if (!trackingNumber) {
      return res.status(400).json({ error: 'trackingNumber is required' });
    }
    const link = shipstationLinkService.getByOrderId(req.params.orderId);
    if (!link) {
      return res.status(404).json({ error: 'No ShipStation link for this order' });
    }
    const ssResult = await shipstationService.markAsShipped({
      orderId: link.ss_order_id,
      carrierCode: (carrierCode || link.carrier_code || 'usps').toLowerCase(),
      trackingNumber,
      shipDate: shipDate || new Date().toISOString(),
      notifyCustomer: notifyCustomer === undefined ? true : !!notifyCustomer,
    });
    const updated = shipstationLinkService.update(req.params.orderId, {
      ssOrderStatus: 'shipped',
      trackingNumber,
      carrierCode: carrierCode || link.carrier_code,
      shippedAt: shipDate || new Date().toISOString(),
    });
    res.json({ link: _maskLink(updated), shipstation: ssResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CARRIERS / SERVICES (for dropdown population) ─────────

router.get('/carriers', async (req, res) => {
  try {
    const carriers = await shipstationService.listCarriers();
    res.json({ carriers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/carriers/:carrierCode/services', async (req, res) => {
  try {
    const services = await shipstationService.listServices(
      req.params.carrierCode
    );
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PACKAGING ENGINE — config + preview ───────────────────
// Phase 13b. The packaging rules engine lives in
// server/services/packagingService.js with its config persisted to
// server/config/packaging-config.json. These endpoints expose the
// config for editing via the Settings → Packaging UI, and a
// per-order preview for the test calculator.

const packagingService = require('../services/packagingService');

// GET /packaging/config — full config dump.
router.get('/packaging/config', async (req, res) => {
  try {
    const config = await packagingService.getConfig();
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /packaging/config — replace top-level fields.
// Body: any subset of { productWeights, packagingTypes, packageBundles,
//   forcePackageSKUs, magnetThreshold, framedPanoSmallSKUs,
//   framedPanoLargeSKUs, boxRouteSKUs, packingSlipWeightOz,
//   packingSlipPosition }. Unrecognized keys are dropped.
router.put('/packaging/config', async (req, res) => {
  try {
    const allowed = [
      'productWeights',
      'packagingTypes',
      'packageBundles',
      'forcePackageSKUs',
      'magnetThreshold',
      'framedPanoSmallSKUs',
      'framedPanoLargeSKUs',
      'boxRouteSKUs',
      'packingSlipWeightOz',
      'packingSlipPosition',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body && req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }
    const config = await packagingService.updateConfig(updates);
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /packaging/product-weights/:sku — upsert one weight row.
// Body: { weight, name, category }
router.put('/packaging/product-weights/:sku', async (req, res) => {
  try {
    const weights = await packagingService.setProductWeight(
      req.params.sku,
      req.body || {}
    );
    res.json({ productWeights: weights });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /packaging/product-weights/:sku
router.delete('/packaging/product-weights/:sku', async (req, res) => {
  try {
    const weights = await packagingService.deleteProductWeight(
      req.params.sku
    );
    res.json({ productWeights: weights });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /packaging/types/:typeId — upsert a packaging type template.
// Body: { name, length, width, height, baseWeight, service }
router.put('/packaging/types/:typeId', async (req, res) => {
  try {
    const types = await packagingService.setPackagingType(
      req.params.typeId,
      req.body || {}
    );
    res.json({ packagingTypes: types });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /packaging/bundles/:sku — upsert a package bundle.
// Body: { name, weight, forcePackage }
router.put('/packaging/bundles/:sku', async (req, res) => {
  try {
    const bundles = await packagingService.setPackageBundle(
      req.params.sku,
      req.body || {}
    );
    res.json({ packageBundles: bundles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /packaging/bundles/:sku
router.delete('/packaging/bundles/:sku', async (req, res) => {
  try {
    const bundles = await packagingService.deletePackageBundle(
      req.params.sku
    );
    res.json({ packageBundles: bundles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /packaging/preview/:orderId — run the engine on an order
// without sending anything. Used by the test calculator on the
// Settings → Packaging page and the ShippingBlock pre-population.
router.get('/packaging/preview/:orderId', async (req, res) => {
  try {
    const order = await sytistDb.getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const preview = await shipstationService.previewPackagingForOrder(
      order
    );
    res.json({
      orderId: order.orderId,
      orderSummary: _orderSummary(order),
      ...preview,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PHASE 13d/e/f: LINKS + RETRY + POLLER ─────────────────

// GET /links — list local SS links with simple filtering.
// Query params:
//   status: 'pending' | 'shipped' | 'cancelled' | 'all'  (default: 'all')
//   limit:  number of rows to return (default: 200; max: 500)
//   since:  ISO date string — only return links updated after this
//
// 'pending' includes any status that isn't 'shipped' or 'cancelled'.
// The dedicated ShipStation page uses this for its Pending tab.
// Default ordering: most recently updated first.
router.get('/links', async (req, res) => {
  try {
    const status = (req.query.status || 'all').toLowerCase();
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(
      500,
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200
    );
    const sinceIso = req.query.since || null;

    let links = shipstationLinkService.listAll();

    if (status === 'pending') {
      links = links.filter(
        (l) => l.ss_order_status !== 'shipped' && l.ss_order_status !== 'cancelled'
      );
    } else if (status === 'shipped') {
      links = links.filter((l) => l.ss_order_status === 'shipped');
    } else if (status === 'cancelled') {
      links = links.filter((l) => l.ss_order_status === 'cancelled');
    }

    if (sinceIso) {
      const sinceTs = Date.parse(sinceIso);
      if (Number.isFinite(sinceTs)) {
        links = links.filter((l) => {
          const u = Date.parse(l.updated_at || l.created_at || 0);
          return Number.isFinite(u) && u >= sinceTs;
        });
      }
    }

    // Sort: shipped tab wants shipped_at desc; everything else updated_at desc.
    const sortKey = status === 'shipped' ? 'shipped_at' : 'updated_at';
    links.sort((a, b) => {
      const ka = Date.parse(a[sortKey] || a.updated_at || 0);
      const kb = Date.parse(b[sortKey] || b.updated_at || 0);
      return kb - ka;
    });

    const trimmed = links.slice(0, limit);

    // Mask payload_json — it can be large and we don't need to ship
    // every payload back to the list view. Detail page already has
    // a way to fetch the link directly if needed.
    const masked = trimmed.map((l) => {
      const { payload_json, ...rest } = l; // eslint-disable-line no-unused-vars
      return rest;
    });

    res.json({
      links: masked,
      total: links.length,
      returned: masked.length,
      status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /orders/:orderId/retry-send — retry just the ShipStation step
// for an order whose Process succeeded but SS create failed (or for
// an order the operator wants to send without re-running processing).
//
// This uses processingService.retryShipStationForOrder which handles
// the lookup-by-orderNumber adoption path, the link table, and the
// status update gating. The operator doesn't need to think about any
// of that.
router.post('/orders/:orderId/retry-send', async (req, res) => {
  try {
    const processingService = require('../services/processingService');
    const result = await processingService.retryShipStationForOrder(
      req.params.orderId
    );
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /scheduler/status — poller health for the UI footer / debug.
router.get('/scheduler/status', async (req, res) => {
  try {
    const schedulerService = require('../services/schedulerService');
    res.json({ status: schedulerService.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /scheduler/poll — trigger an on-demand poll. Operator-driven.
// Useful when an order's ShipStation status changed RIGHT NOW and the
// operator doesn't want to wait for the next scheduled tick.
router.post('/scheduler/poll', async (req, res) => {
  try {
    const schedulerService = require('../services/schedulerService');
    const summary = await schedulerService._pollOnce();
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── helpers ───────────────────────────────────────────────

/**
 * Compute eligibility. Mirrors the same filter logic as
 * shipstationService.buildOrderFromSytist but returns a structured
 * summary instead of building a payload. Used to render the order
 * detail page's Ship card without actually firing a create.
 */
async function _computeEligibility(order) {
  const specialtyService = require('../services/specialtyService');
  const packagingService = require('../services/packagingService');
  const items = order.lineItems || [];
  let digitalCount = 0;
  let dropShippedCount = 0;
  let giftCertCount = 0;
  let otherSkippedCount = 0;
  let shippableCount = 0;
  for (const li of items) {
    const flags = li.flags || {};
    if (flags.download) {
      digitalCount += 1;
      continue;
    }
    if (flags.giftCert) {
      giftCertCount += 1;
      continue;
    }
    if (flags.creditProduct || flags.booking || flags.preSell || flags.preRegister) {
      // Phase 64: preRegister — $0 pre-registration placeholder, not shippable.
      otherSkippedCount += 1;
      continue;
    }
    try {
      const isDrop = await specialtyService.isDropShipped(li.sku);
      if (isDrop) {
        dropShippedCount += 1;
        continue;
      }
    } catch (e) {
      // Defensive: treat as shippable
    }
    // Phase 45: mirror buildOrderFromSytist's digital-by-config check
    // so the UI's eligibility preview matches the real SS filter.
    try {
      if (await packagingService.isDigital(li.sku)) {
        digitalCount += 1;
        continue;
      }
    } catch (e) {
      // Defensive: treat as shippable
    }
    shippableCount += 1;
  }

  const eligible = shippableCount > 0;
  // Compose a human-readable reason string explaining the situation.
  // Used by the UI in both the eligible and ineligible cases.
  let reason;
  if (!eligible) {
    const parts = [];
    if (digitalCount > 0) parts.push(`${digitalCount} digital`);
    if (dropShippedCount > 0)
      parts.push(`${dropShippedCount} drop-shipped`);
    if (giftCertCount > 0) parts.push(`${giftCertCount} gift cert`);
    if (otherSkippedCount > 0)
      parts.push(`${otherSkippedCount} non-physical`);
    reason = `All items are ${parts.join(', ')}.`;
  } else {
    reason = `${shippableCount} shippable item${shippableCount === 1 ? '' : 's'}`;
    const skippedTotal =
      digitalCount + dropShippedCount + giftCertCount + otherSkippedCount;
    if (skippedTotal > 0) {
      reason += `, ${skippedTotal} skipped`;
    }
  }
  return {
    eligible,
    reason,
    shippableCount,
    digitalCount,
    dropShippedCount,
    giftCertCount,
    otherSkippedCount,
    workflow: order.shipping?.workflow || null,
  };
}

/** Summary fields for the UI — avoids dumping the whole order across the wire. */
function _orderSummary(order) {
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    customer: order.customer
      ? `${order.customer.firstName || ''} ${order.customer.lastName || ''}`.trim()
      : '',
    shipTo: order.shipTo
      ? `${order.shipTo.firstName || ''} ${order.shipTo.lastName || ''}`.trim()
      : '',
    city: order.shipTo?.city || '',
    state: order.shipTo?.state || '',
    workflow: order.shipping?.workflow || null,
  };
}

/** Don't leak the full payload_json over the wire — too noisy. */
function _maskLink(link) {
  if (!link) return null;
  const { payload_json, ...rest } = link;
  return rest;
}

module.exports = router;
