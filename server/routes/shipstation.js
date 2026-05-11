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
    res.json({ linked: false, eligibility, order: _orderSummary(order) });
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

    const overrides = req.body || {};
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

    const result = await shipstationService.createOrder(payload);
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
    res.json({ linked: true, link: _maskLink(link), result });
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

// ─── helpers ───────────────────────────────────────────────

/**
 * Compute eligibility. Mirrors the same filter logic as
 * shipstationService.buildOrderFromSytist but returns a structured
 * summary instead of building a payload. Used to render the order
 * detail page's Ship card without actually firing a create.
 */
async function _computeEligibility(order) {
  const specialtyService = require('../services/specialtyService');
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
    if (flags.creditProduct || flags.booking || flags.preSell) {
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
