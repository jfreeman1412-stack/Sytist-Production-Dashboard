// orderStatusService — Phase 28 + Phase 30
//
// Centralizes all status transitions for orders (ship, unship, batch
// ship). Responsibilities:
//
//   1. Read shipping-related settings (shippedStatusId, eligibility set)
//      from processing-settings.json
//   2. Validate transitions and call sytistDb.updateOrderStatus
//   3. Log every transition to the local SQLite `order_status_audit`
//      table so we have a history of "who shipped what when"
//   4. Phase 30: derive and write shipping metadata to ms_orders
//      (date, tracking, carrier, cost) alongside the status flip.
//      Pulls tracking and carrier from the SS link row when present;
//      cost is fetched live from the ShipStation API.
//
// All writes still go through sytistDbService. Phase 30 expanded the
// writable column set from just order_open_status to also include the
// four shipping columns (order_shipped_date, order_shipped_track,
// order_shipped_by, order_shipped_by_id, order_ship_cost).
//
// Eligibility model:
//   - Configured set: shipEligibleFromStatusIds = [40] by default
//     (40 = Printing). An order's order_open_status must be in this
//     set to ship via the normal path.
//   - force=true bypasses eligibility — used for manual overrides
//     by an admin who knows what they're doing.
//   - Unship has no eligibility check; it's the override path.

const fs = require('fs');
const path = require('path');
const databaseService = require('./database');
const sytistDb = require('./sytistDbService');

// Phase 30: optional dependencies for shipping-field derivation.
// Loaded lazily inside the helpers so a missing module here doesn't
// break the whole orderStatusService module load. In practice both
// of these are always present in the dashboard, but the defensive
// pattern protects against deploy-order issues during upgrades.
function _getShipstationLinkService() {
  try {
    return require('./shipstationLinkService');
  } catch (err) {
    return null;
  }
}
function _getShipstationService() {
  try {
    return require('./shipstationService');
  } catch (err) {
    return null;
  }
}

const SETTINGS_PATH = path.join(
  __dirname,
  '..',
  'config',
  'processing-settings.json'
);

const DEFAULT_SHIPPED_STATUS_ID = 39;
const DEFAULT_ELIGIBLE_FROM = [40]; // Printing

// ─── Settings ──────────────────────────────────────────────

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      autoStatusUpdate: !!parsed.autoStatusUpdate,
      targetStatusId:
        parsed.targetStatusId === undefined ? null : parsed.targetStatusId,
      shippedStatusId:
        typeof parsed.shippedStatusId === 'number'
          ? parsed.shippedStatusId
          : DEFAULT_SHIPPED_STATUS_ID,
      shipEligibleFromStatusIds:
        Array.isArray(parsed.shipEligibleFromStatusIds) &&
        parsed.shipEligibleFromStatusIds.length > 0
          ? parsed.shipEligibleFromStatusIds
              .map((v) => parseInt(v, 10))
              .filter((n) => !Number.isNaN(n))
          : DEFAULT_ELIGIBLE_FROM,
    };
  } catch (err) {
    // Settings file missing or unparseable: fall back to defaults.
    return {
      autoStatusUpdate: false,
      targetStatusId: null,
      shippedStatusId: DEFAULT_SHIPPED_STATUS_ID,
      shipEligibleFromStatusIds: DEFAULT_ELIGIBLE_FROM,
    };
  }
}

// ─── Phase 30: shipping field derivation ──────────────────────
//
// When we ship an order we want to write four shipping columns to
// ms_orders alongside the status flip. The values depend on whether
// the order has a ShipStation link (auto-pulled) or not (zero
// defaults — Sytist columns are NOT NULL with zero-defaults).

/**
 * Map a ShipStation carrier_code to a human-readable carrier name
 * that Sytist's order_shipped_by column expects (USPS, UPS, FEDEX,
 * etc). ShipStation's carrier codes are lowercase and granular
 * (e.g. 'stamps_com', 'endicia') — multiple codes can resolve to
 * the same network (USPS).
 *
 * Unknown codes fall back to the uppercased code. That's good enough
 * for visibility in Sytist; the operator can clean it up by hand if
 * a new carrier shows up that we don't have a mapping for yet, and
 * we add the mapping here.
 */
const CARRIER_CODE_MAP = {
  // USPS-network carriers
  stamps_com: 'USPS',
  usps: 'USPS',
  endicia: 'USPS',

  // UPS
  ups: 'UPS',
  ups_walleted: 'UPS',

  // FedEx
  fedex: 'FEDEX',
  fedex_walleted: 'FEDEX',

  // DHL family
  dhl_express_worldwide: 'DHL',
  dhl_global_mail: 'DHL',
  dhl_ecommerce: 'DHL',
  dhl_express: 'DHL',

  // Other carriers we've seen in the wild
  ontrac: 'OnTrac',
  apc: 'APC',
  globegistics: 'Globegistics',
  asendia: 'Asendia',
};

function mapCarrierCode(code) {
  if (!code) return '';
  const lower = String(code).toLowerCase();
  if (CARRIER_CODE_MAP[lower]) return CARRIER_CODE_MAP[lower];
  return String(code).toUpperCase();
}

/**
 * Builds the shipping-field payload to write to ms_orders for a
 * ship action. Always returns an object with all 5 fields populated
 * (using Sytist's zero-defaults when we don't have the real value).
 *
 *   - shippedDate: today's date (YYYY-MM-DD — Sytist column is DATE)
 *   - trackingNumber: from SS link if present, else ''
 *   - carrier: mapped from SS link.carrier_code via CARRIER_CODE_MAP
 *   - shippedById: always 0 per project convention (dashboard user
 *                   IDs are not the same namespace as Sytist users)
 *   - shipCost: fetched live from ShipStation API when a link
 *                exists; 0.00 otherwise. The API call is wrapped
 *                in try/catch so a failure here (timeout, auth, etc.)
 *                doesn't block the ship — we just write 0 and log.
 *
 * @returns {Promise<{shippedDate, trackingNumber, carrier, shippedById, shipCost}>}
 */
async function buildShippingFieldsForShip(orderId) {
  // Sytist's order_shipped_date is a DATE column (not DATETIME) so
  // we just need YYYY-MM-DD. Using toISOString().slice(0,10) for UTC
  // is fine — date semantics here are "what day was this shipped",
  // and a 12-hour timezone drift on the boundary is acceptable. If
  // operators end up wanting strict local-time dates, we can switch
  // to formatting `new Date()` via Intl in their tz.
  const shippedDate = new Date().toISOString().slice(0, 10);

  const fields = {
    shippedDate,
    trackingNumber: '',
    carrier: '',
    shippedById: 0,
    shipCost: 0,
  };

  // Look up SS link in local SQLite. No-op if no link.
  const linkService = _getShipstationLinkService();
  if (!linkService) return fields;

  let link;
  try {
    link = linkService.getByOrderId(orderId);
  } catch (err) {
    console.warn(
      `[orderStatusService] SS link lookup failed for ${orderId}: ${err.message}`
    );
    return fields;
  }
  if (!link) return fields;

  // Populate tracking + carrier from the link row.
  if (link.tracking_number) fields.trackingNumber = String(link.tracking_number);
  if (link.carrier_code) fields.carrier = mapCarrierCode(link.carrier_code);

  // Fetch cost from ShipStation API. The /orders/{id} response
  // includes a shipmentCost field on shipped orders. We bound this
  // with a short timeout (handled by the shipstationService axios
  // client) so a slow API doesn't stall the ship action — failure
  // is non-fatal, we just leave cost at 0.
  if (link.ss_order_id) {
    const ssService = _getShipstationService();
    if (ssService && typeof ssService.getOrder === 'function') {
      try {
        const ssOrder = await ssService.getOrder(link.ss_order_id);
        const cost = ssOrder?.shipmentCost;
        if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
          fields.shipCost = cost;
        } else if (typeof cost === 'string') {
          const parsed = parseFloat(cost);
          if (Number.isFinite(parsed) && parsed >= 0) fields.shipCost = parsed;
        }
      } catch (err) {
        console.warn(
          `[orderStatusService] SS cost fetch failed for order ${orderId} (SS#${link.ss_order_id}): ${err.message}`
        );
      }
    }
  }

  return fields;
}

/**
 * Builds the zero-default shipping-field payload for an unship
 * action. All five fields reset to Sytist's zero-defaults so the
 * order looks unshipped again.
 */
function buildShippingFieldsForUnship() {
  return {
    shippedDate: '0000-00-00',
    trackingNumber: '',
    carrier: '',
    shippedById: 0,
    shipCost: 0,
  };
}

// ─── Audit table ───────────────────────────────────────────

function ensureAuditTable() {
  const db = databaseService.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_status_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      order_id INTEGER NOT NULL,
      from_status INTEGER,
      to_status INTEGER NOT NULL,
      source TEXT NOT NULL,
      user_id INTEGER,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_order ON order_status_audit(order_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON order_status_audit(ts DESC);
  `);

  // Phase 30: lazy-add shipping_fields_json column. ALTER TABLE ADD
  // COLUMN is idempotent-safe only via a try/catch on "duplicate
  // column" since SQLite doesn't support IF NOT EXISTS for columns.
  try {
    db.exec(`ALTER TABLE order_status_audit ADD COLUMN shipping_fields_json TEXT`);
  } catch (err) {
    // "duplicate column name" means the migration already ran. Any
    // other error is logged but non-fatal — auditing isn't critical
    // path.
    if (!/duplicate column/i.test(err.message)) {
      console.warn(
        `[orderStatusService] could not add shipping_fields_json column: ${err.message}`
      );
    }
  }
}

let _auditTableEnsured = false;

function logAudit({ orderId, fromStatus, toStatus, source, userId, notes, shippingFields }) {
  try {
    if (!_auditTableEnsured) {
      ensureAuditTable();
      _auditTableEnsured = true;
    }
    const db = databaseService.getDb();
    db.prepare(
      `INSERT INTO order_status_audit
         (order_id, from_status, to_status, source, user_id, notes, shipping_fields_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      parseInt(orderId, 10),
      fromStatus == null ? null : parseInt(fromStatus, 10),
      parseInt(toStatus, 10),
      String(source || 'unknown'),
      userId == null ? null : parseInt(userId, 10),
      notes == null ? null : String(notes),
      shippingFields ? JSON.stringify(shippingFields) : null
    );
  } catch (err) {
    // Don't let an audit failure break the operation. Log the issue.
    console.warn(
      `[orderStatusService] audit log insert failed for order ${orderId}: ${err.message}`
    );
  }
}

// ─── Status read helper ────────────────────────────────────

/**
 * Fetch an order's current order_open_status without going through
 * the full canonical getOrderById pipeline (which is slow). We use
 * the sytist pool directly for a tiny SELECT.
 */
async function getCurrentStatus(orderId) {
  const id = parseInt(orderId, 10);
  if (Number.isNaN(id) || id <= 0) {
    throw new Error('Invalid order ID');
  }
  const pool = sytistDb.getPool();
  const [[row]] = await pool.query(
    `SELECT order_id, order_open_status, order_erased
     FROM ms_orders
     WHERE order_id = ?
     LIMIT 1`,
    [id]
  );
  if (!row) return null;
  if (row.order_erased) return { erased: true };
  return {
    orderId: row.order_id,
    statusId:
      row.order_open_status == null ? 0 : Number(row.order_open_status),
  };
}

// ─── Ship / Unship ──────────────────────────────────────────

/**
 * Mark an order shipped.
 *
 * @param {object} opts
 * @param {number} opts.orderId
 * @param {boolean} [opts.force]   — bypass eligibility check
 * @param {string}  [opts.source]  — 'manual'|'bulk'|'scan'|'shipstation_auto'
 * @param {number}  [opts.userId]
 * @returns {Promise<{ ok: boolean, orderId: number, fromStatus: number,
 *   toStatus: number } | { ok: false, error: string, code: string,
 *   currentStatus?: number, eligibleStatuses?: number[] }>}
 */
async function shipOrder({ orderId, force, source, userId, userDisplayName, userIp }) {
  const settings = loadSettings();
  const targetStatus = settings.shippedStatusId;
  const eligible = settings.shipEligibleFromStatusIds;

  let current;
  try {
    current = await getCurrentStatus(orderId);
  } catch (err) {
    return { ok: false, error: err.message, code: 'invalid_order' };
  }

  if (!current) {
    return {
      ok: false,
      error: `Order ${orderId} not found`,
      code: 'not_found',
    };
  }
  if (current.erased) {
    return {
      ok: false,
      error: `Order ${orderId} is erased`,
      code: 'erased',
    };
  }

  // Already shipped? No-op success — idempotent.
  if (current.statusId === targetStatus) {
    return {
      ok: true,
      orderId: current.orderId,
      fromStatus: current.statusId,
      toStatus: targetStatus,
      noop: true,
    };
  }

  if (!force && !eligible.includes(current.statusId)) {
    return {
      ok: false,
      error: `Order ${orderId} is not eligible for shipping (current status ${current.statusId}, eligible: ${eligible.join(', ')})`,
      code: 'not_eligible',
      currentStatus: current.statusId,
      eligibleStatuses: eligible,
    };
  }

  try {
    // Phase 30: derive shipping fields (date, tracking, carrier,
    // cost) and write them alongside the status flip in a single
    // UPDATE on ms_orders.
    const shippingFields = await buildShippingFieldsForShip(current.orderId);
    await sytistDb.updateOrderStatus(orderId, targetStatus, shippingFields);

    logAudit({
      orderId: current.orderId,
      fromStatus: current.statusId,
      toStatus: targetStatus,
      source: source || 'manual',
      userId,
      shippingFields,
    });

    // Phase 36: also append a row to Sytist's ms_notes so the
    // shipment shows up in Sytist's order detail "Notes" section
    // alongside Sytist-native entries. Non-fatal — a notes failure
    // doesn't undo the ship.
    try {
      const isAuto = source === 'shipstation_auto';
      let noteText = 'Sytist Dashboard: Order Has been changed to Shipped';
      if (isAuto) {
        noteText += ' (auto-detected from ShipStation)';
      }
      // Append non-empty shipping context inline so a Sytist
      // operator viewing the note can see what we wrote without
      // looking in note_data.
      const bits = [];
      if (shippingFields.trackingNumber)
        bits.push(`Tracking: ${shippingFields.trackingNumber}`);
      if (shippingFields.carrier)
        bits.push(`Carrier: ${shippingFields.carrier}`);
      if (shippingFields.shipCost && shippingFields.shipCost > 0)
        bits.push(`Cost: $${parseFloat(shippingFields.shipCost).toFixed(2)}`);
      if (bits.length > 0) noteText += ' — ' + bits.join(', ');

      await sytistDb.insertNote({
        orderId: current.orderId,
        noteText,
        who: userDisplayName || (isAuto ? 'sytist-dashboard' : 'dashboard'),
        ip: userIp || '',
        isManual: false,
      });
    } catch (noteErr) {
      console.warn(
        `[orderStatusService] ms_notes insert failed for ship of ${orderId}: ${noteErr.message}`
      );
    }

    return {
      ok: true,
      orderId: current.orderId,
      fromStatus: current.statusId,
      toStatus: targetStatus,
      shippingFields,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Status update failed: ${err.message}`,
      code: 'update_failed',
    };
  }
}

/**
 * Reverse a shipped order (override). No eligibility check.
 * Defaults the target back to the first configured eligible status
 * (typically 40 = Printing) but caller can specify any.
 */
async function unshipOrder({ orderId, targetStatusId, source, userId, notes, userDisplayName, userIp }) {
  const settings = loadSettings();
  const fallbackTarget = settings.shipEligibleFromStatusIds[0] || 40;
  const targetStatus =
    targetStatusId == null ? fallbackTarget : parseInt(targetStatusId, 10);

  let current;
  try {
    current = await getCurrentStatus(orderId);
  } catch (err) {
    return { ok: false, error: err.message, code: 'invalid_order' };
  }

  if (!current) {
    return {
      ok: false,
      error: `Order ${orderId} not found`,
      code: 'not_found',
    };
  }
  if (current.erased) {
    return { ok: false, error: 'Order is erased', code: 'erased' };
  }

  if (current.statusId === targetStatus) {
    return {
      ok: true,
      orderId: current.orderId,
      fromStatus: current.statusId,
      toStatus: targetStatus,
      noop: true,
    };
  }

  try {
    // Phase 30: reset all shipping fields to Sytist zero-defaults so
    // the order looks unshipped again. Without this, a re-shipped
    // order would retain stale tracking/date from the previous ship.
    const shippingFields = buildShippingFieldsForUnship();
    await sytistDb.updateOrderStatus(orderId, targetStatus, shippingFields);

    logAudit({
      orderId: current.orderId,
      fromStatus: current.statusId,
      toStatus: targetStatus,
      source: source || 'manual_override',
      userId,
      notes,
      shippingFields,
    });

    // Phase 36: append a row to ms_notes so the reversal shows up
    // in Sytist's order detail. Non-fatal.
    try {
      let noteText = 'Sytist Dashboard: Order Has been changed to Printing';
      if (notes) noteText += ` — Reason: ${notes}`;
      await sytistDb.insertNote({
        orderId: current.orderId,
        noteText,
        who: userDisplayName || 'dashboard',
        ip: userIp || '',
        isManual: false,
      });
    } catch (noteErr) {
      console.warn(
        `[orderStatusService] ms_notes insert failed for unship of ${orderId}: ${noteErr.message}`
      );
    }

    return {
      ok: true,
      orderId: current.orderId,
      fromStatus: current.statusId,
      toStatus: targetStatus,
      shippingFields,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Status update failed: ${err.message}`,
      code: 'update_failed',
    };
  }
}

/**
 * Batch-ship multiple orders. Each is checked independently — the
 * batch doesn't fail if one order is ineligible.
 *
 * @param {object} opts
 * @param {Array<number|string>} opts.orderIds
 * @param {boolean} [opts.force]
 * @param {string}  [opts.source]
 * @param {number}  [opts.userId]
 * @returns {Promise<{
 *   results: Array<{ orderId, ok, fromStatus?, toStatus?, error?, code? }>,
 *   shippedCount: number,
 *   skippedCount: number,
 * }>}
 */
async function batchShipOrders({ orderIds, force, source, userId, userDisplayName, userIp }) {
  const ids = Array.isArray(orderIds)
    ? orderIds.map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n > 0)
    : [];

  const results = [];
  let shippedCount = 0;
  let skippedCount = 0;

  for (const id of ids) {
    const r = await shipOrder({
      orderId: id,
      force,
      source: source || 'bulk',
      userId,
      userDisplayName,
      userIp,
    });
    if (r.ok) {
      shippedCount += 1;
    } else {
      skippedCount += 1;
    }
    results.push({ orderId: id, ...r });
  }

  return { results, shippedCount, skippedCount };
}

// Recent audit query for diagnostics (not exposed yet; reserved for
// a future "order history" UI).
function getRecentAudit({ limit = 50 } = {}) {
  try {
    const db = databaseService.getDb();
    return db
      .prepare(
        `SELECT id, ts, order_id, from_status, to_status, source, user_id, notes, shipping_fields_json
         FROM order_status_audit
         ORDER BY ts DESC, id DESC
         LIMIT ?`
      )
      .all(parseInt(limit, 10));
  } catch (err) {
    return [];
  }
}

module.exports = {
  loadSettings,
  ensureAuditTable,
  shipOrder,
  unshipOrder,
  batchShipOrders,
  getRecentAudit,
  // Phase 30 helpers — exposed for testing and for the future
  // scan-out page that may want to preview what we're about to
  // write before actually shipping.
  mapCarrierCode,
  buildShippingFieldsForShip,
  buildShippingFieldsForUnship,
};
