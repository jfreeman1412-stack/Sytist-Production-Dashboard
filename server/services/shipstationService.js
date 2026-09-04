// server/services/shipstationService.js
//
// Phase 13a: ShipStation V1 API client + payload builder for Sytist
// orders. Ported from the PhotoDay dashboard, with the orderBuilder
// rewritten for Sytist's order shape (sytistDbService.js).
//
// Authentication: HTTP Basic with apiKey:apiSecret (V1 API). Credentials
// come from appSettings (override > env > default). The settings store
// applies them to process.env at startup; we also re-read at call time
// in case the operator updated keys without restarting.
//
// The createOrder path uses raw https.request rather than axios — a
// workaround from the PhotoDay codebase that we preserve unchanged.
// Other endpoints use axios normally.
//
// Per-item AND order-level weights are sent in OUNCES with integer
// values (Phase 58 hotfix 2). The original Phase 13b switch to grams
// dodged SS's "truncate fractional oz per line" behaviour; under
// Phase 58 the order weight is whole-oz and the per-item rollup now
// distributes that whole-oz across physical lines as INTEGER oz
// (`distributeIntegerOzAcrossLines`), so there's no fraction to
// truncate. Integer oz also bypasses the lossy oz×28.3495 round-trip
// (a 4 oz floor → 113 g reverses to 3.99 oz in SS = 3 oz tier; a
// 5 oz floor → 142 g per-item sum 143 g reverses to 5.04 oz = 6 oz
// tier — both the exact failure mode Phase 58's floor was meant to
// prevent). See SPEC §58 hotfix 2 for the full diagnosis.

const axios = require('axios');
const appSettings = require('../config/appSettings');

// Distinct error class for HTTP 429 from ShipStation. Landed with
// Ship 2 followup 2026-09-04 after the shipment-id backfill's
// infinite-loop incident (36 rounds × 5 orders ~= 180 SS V1 calls
// in 72s, ~2.5 req/s sustained against V1's 40-per-40s ceiling —
// SS returned valid empty responses that time, so no 429 fired,
// but the calls were well within striking distance).
//
// Prior state: 429 was logged in the response interceptor and
// re-thrown as a generic axios error — indistinguishable from
// real failures. Callers couldn't tell "SS temporarily said
// slow down" from "SS is broken" or "order not found."
//
// Post-fix contract:
//   1. Interceptor auto-retries ONCE on 429 honoring Retry-After
//      (capped at 60s so a bad SS header can't stall the caller).
//   2. If the retry also 429s, THROW ShipStationRateLimitedError
//      so callers can catch it distinctly. Callers that don't care
//      still see it as an Error and reject the same way.
//
// See the CM-side V2 client (apps/api/src/services/shipstation/
// shipstationClient.ts) for the same pattern; kept in mirror for
// consistency across the two client codebases.
class ShipStationRateLimitedError extends Error {
  constructor(message, retryAfterSec) {
    super(message);
    this.name = 'ShipStationRateLimitedError';
    this.retryAfterSec = retryAfterSec;
    this.isRateLimited = true;
  }
}

function isShipStationRateLimitedError(e) {
  return e && e.name === 'ShipStationRateLimitedError';
}

// Cap the Retry-After honor at this many seconds. Prevents a
// server-side misconfiguration from stalling the poller loop.
const MAX_RETRY_AFTER_SECONDS = 60;

// Phase 58 hotfix 2: weights are sent to ShipStation in OUNCES with
// integer values — order-level AND per-item. The previous design
// converted whole-oz to grams (OZ_TO_G = 28.3495) and let SS reverse
// for display/billing; that round-trip is fundamentally lossy for
// most whole-oz values (e.g. 4 oz × 28.3495 = 113.398 → round 113 →
// reverse 3.99 oz → bills 3 oz tier instead of 4). Hotfix 1 swapped
// round→ceil which moved 4.0 oz to 4.02 but didn't fix the
// per-item-sum overshoot at 5 oz (5.04 oz → 6 oz tier). Sending
// integer oz directly bypasses the conversion entirely — SS sees
// exactly N oz and bills the N oz tier.
//
// The original Phase 13b reason for grams (SS truncates fractional
// oz per line) doesn't apply to integer oz — no fraction to
// truncate. distributeIntegerOzAcrossLines below splits the order's
// whole-oz floor across physical lines as integers summing exactly
// to the floor, using the same "first physical item absorbs" pattern
// the packaging engine uses for its fractional rollup.
//
// Helper is exported (module.exports.distributeIntegerOzAcrossLines)
// so the offline verification harness can test it without going
// through the SS payload path.
function distributeIntegerOzAcrossLines(itemWeights, orderFloorOz) {
  const out = {};
  let firstPhysicalKey = null;
  let nonAbsorberSum = 0;
  for (const iw of itemWeights || []) {
    const key = iw && iw.lineItemKey;
    if (!key) continue;
    const rawOz = iw.weightOz || 0;
    if (rawOz <= 0) {
      // Digital / zero-weight line — never the absorber, contributes
      // 0 to the order total (matches the engine's digital handling).
      out[key] = 0;
      continue;
    }
    if (firstPhysicalKey === null) {
      // First physical line is the absorber. Placeholder for now;
      // gets the floor − (non-absorber rounded sum) after the loop.
      firstPhysicalKey = key;
      out[key] = 0;
      continue;
    }
    const r = Math.round(rawOz);
    out[key] = r;
    nonAbsorberSum += r;
  }
  if (firstPhysicalKey !== null) {
    // Clamp to ≥0 — for the rare pathological combo (5+ items each
    // ~0.6 oz with effectively zero baseWeight) the non-absorber sum
    // can exceed the floor; the absorber goes to 0 and the line sum
    // over-shoots by a few oz. Bounded; very unlikely in production.
    out[firstPhysicalKey] = Math.max(0, orderFloorOz - nonAbsorberSum);
  }
  return out;
}
// Sytist line items can carry these flags; we don't ship the line item
// if any of these are true. Matches the SKIP_FLAGS used by the Phase 11
// processing pipeline. Phase 64: preRegister (cart_pre_register_id > 0) — a $0
// pre-registration placeholder, never a shippable line.
// Phase 69: coupon — cart_coupon > 0; non-shippable line, never on the SS payload.
const SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell', 'preRegister', 'coupon'];

// Phase 13a hotfix #6: ShipStation rejects country fields that aren't
// 2-letter ISO codes. Sytist orders can show up with "United States",
// "USA", or even empty. This normalizer maps common variants to ISO
// codes. Unknown values default to 'US' since this lab is US-domestic;
// when international shipping becomes a real case we'd extend the map
// or surface the unknown as an error rather than silently defaulting.
const COUNTRY_ALIASES = {
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'us': 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  'america': 'US',
  'canada': 'CA',
  'ca': 'CA',
  'mexico': 'MX',
  'mx': 'MX',
  'united kingdom': 'GB',
  'uk': 'GB',
  'great britain': 'GB',
  'gb': 'GB',
};
function normalizeCountry(raw) {
  if (!raw) return 'US';
  const trimmed = String(raw).trim();
  if (!trimmed) return 'US';
  // Already a 2-letter code? Pass through uppercase.
  if (trimmed.length === 2) return trimmed.toUpperCase();
  // Try the alias map (case-insensitive).
  const mapped = COUNTRY_ALIASES[trimmed.toLowerCase()];
  if (mapped) return mapped;
  // Unknown — default to US and log so we notice patterns over time.
  console.warn(
    `[ShipStation] Unknown country "${raw}" — defaulting to "US". ` +
      `Add to COUNTRY_ALIASES in shipstationService.js if this is recurring.`
  );
  return 'US';
}

// Phase 13b hotfix #2: pretty-print the packaging engine's math so
// operators can compare against scale weight. Output is grouped under
// one console.log call (single line per item + summary) so it stays
// readable when the server log is busy. Format:
//
//   [Packaging Trace] Order 110633
//     Items:
//       SKU 17 (4 Mini Magnets) × 1 = 1.7 oz [productWeights]
//       SKU 10 (5x7 Individual Print) × 1 = 0.1 oz [productWeights]
//     Items subtotal:    1.8 oz
//     Packing slip:     +0.4 oz
//     Packaging (6x8 Flat Mailer): +1.5 oz
//     Pre-rounding total: 3.7 oz
//     Floor rounding: -0.7 oz
//     ────────────────────────────
//     FINAL:             3 oz  →  carrier=stamps_com service=usps_first_class_mail
function _logPackagingTrace(orderId, packaging) {
  const wb = packaging.weightBreakdown;
  if (!wb) return;
  const lines = [];
  lines.push(`[Packaging Trace] Order ${orderId}`);
  lines.push('  Items:');
  if (wb.items.length === 0) {
    lines.push('    (none)');
  } else {
    for (const it of wb.items) {
      const flag =
        it.source === 'fallback'
          ? ' ⚠️ FALLBACK (no SKU config, defaulted to 1oz)'
          : ` [${it.source}]`;
      lines.push(
        `    SKU ${it.sku} (${it.name}) × ${it.qty} = ${_fmt(
          it.lineWeightOz
        )} oz${flag}`
      );
    }
  }
  lines.push(`  Items subtotal:    ${_fmt(wb.itemsSubtotalOz)} oz`);
  if (wb.packingSlipOz > 0) {
    lines.push(`  Packing slip:     +${_fmt(wb.packingSlipOz)} oz`);
  }
  if (wb.packagingTypeName) {
    lines.push(
      `  Packaging (${wb.packagingTypeName}): +${_fmt(
        wb.packagingBaseWeightOz
      )} oz`
    );
  }
  lines.push(`  Pre-rounding total: ${_fmt(wb.preRoundingOz)} oz`);
  if (Math.abs(wb.roundingDeltaOz) > 0.001) {
    // Phase 58: floor-to-whole-oz. roundingDeltaOz is sign-carrying;
    // negative is the dropped fraction. _fmt produces the leading "-".
    lines.push(`  Floor rounding: ${_fmt(wb.roundingDeltaOz)} oz`);
  }
  lines.push('  ────────────────────────────');
  lines.push(
    `  FINAL:             ${wb.finalOz} oz  →  carrier=${packaging.carrierCode} service=${packaging.serviceCode}`
  );
  console.log(lines.join('\n'));
}
function _fmt(n) {
  // Trim float noise without losing real precision on tiny values
  return Number(n).toFixed(2).replace(/\.?0+$/, '');
}

class ShipStationService {
  constructor() {
    // We re-build the axios client lazily so credential changes via the
    // settings UI take effect without restarting. _client() handles that.
    this._cachedClient = null;
    this._cachedCreds = '';
  }

  // ─── client setup ──────────────────────────────────────

  _creds() {
    const key = appSettings.getRawValueSync('shipstationApiKey') || '';
    const secret = appSettings.getRawValueSync('shipstationApiSecret') || '';
    const baseUrl =
      appSettings.getRawValueSync('shipstationBaseUrl') ||
      'https://ssapi.shipstation.com';
    return { key, secret, baseUrl };
  }

  _client() {
    const { key, secret, baseUrl } = this._creds();
    const credsKey = `${key}|${secret}|${baseUrl}`;
    if (this._cachedClient && this._cachedCreds === credsKey) {
      return this._cachedClient;
    }
    if (!key || !secret) {
      throw new Error(
        'ShipStation API credentials not set. Configure them at Settings → API Keys.'
      );
    }
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const client = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.Message || error.message;

        // 429 rate-limit path (Ship 2 followup 2026-09-04). Auto-
        // retry ONCE honoring Retry-After (capped). If the retry
        // also 429s, throw ShipStationRateLimitedError so callers
        // can catch distinctly. See class docstring at file top.
        if (status === 429) {
          const rawRetryAfter = Number(error.response.headers['retry-after']);
          const retryAfterSec = Number.isFinite(rawRetryAfter) && rawRetryAfter > 0
            ? Math.min(MAX_RETRY_AFTER_SECONDS, rawRetryAfter)
            : 30; // default when header missing / malformed
          // First-hit: sleep + retry once. Marker on error.config
          // prevents infinite recursion — the retry goes back through
          // THIS SAME client (so interceptors run again), and if the
          // retry also 429s, the marker sends it to the "give up +
          // throw the distinct class" branch below. Using
          // `client.request(error.config)` (not raw `axios(...)`) is
          // load-bearing: raw axios has no interceptors, so a wrapped
          // error would never fire and callers wouldn't see the class.
          if (error.config && !error.config._ssRateLimitRetried) {
            console.warn(
              `[ShipStation] 429 rate-limited — sleeping ${retryAfterSec}s then retrying once`
            );
            await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
            error.config._ssRateLimitRetried = true;
            return client.request(error.config);
          }
          // Second-hit: give up. Wrap in the distinct class.
          console.error(
            `[ShipStation] 429 rate-limited on retry as well — giving up (retryAfter was ${retryAfterSec}s)`
          );
          throw new ShipStationRateLimitedError(
            `ShipStation rate-limited: ${message}`,
            retryAfterSec
          );
        }

        console.error(`[ShipStation] ${status}: ${message}`);
        throw error;
      }
    );
    this._cachedClient = client;
    this._cachedCreds = credsKey;
    return client;
  }

  _stripNulls(obj) {
    if (Array.isArray(obj)) return obj.map((item) => this._stripNulls(item));
    if (obj && typeof obj === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== null && value !== undefined)
          result[key] = this._stripNulls(value);
      }
      return result;
    }
    return obj;
  }

  // ─── ORDERS ─────────────────────────────────────────────

  /**
   * Create a ShipStation order. Uses raw https.request rather than
   * axios — this is a workaround inherited from the PhotoDay codebase.
   * Comment from there didn't explain why, but the issue may relate
   * to how ShipStation handles content-length / chunked encoding.
   * Don't switch to axios without testing — the bug it works around
   * isn't documented.
   */
  async createOrder(orderData) {
    const cleaned = this._stripNulls(orderData);
    const jsonBody = JSON.stringify(cleaned);

    const https = require('https');
    const { key, secret, baseUrl } = this._creds();
    if (!key || !secret) {
      throw new Error(
        'ShipStation API credentials not set. Configure them at Settings → API Keys.'
      );
    }
    const url = new URL(`${baseUrl}/orders/createorder`);
    const authString = Buffer.from(`${key}:${secret}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: `Basic ${authString}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(jsonBody),
            Accept: 'application/json',
            'User-Agent': 'sytist-dashboard/1.0',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch {
                resolve(body);
              }
            } else {
              // Phase 43 hotfix 2: dump everything ShipStation gave us
              // when the request fails. SS's V1 createOrder endpoint
              // returns 404 with empty body for several distinct
              // failure modes (malformed JSON, unrecognized field,
              // tombstoned orderKey, etc.), and we need the response
              // headers to tell them apart.
              console.error(
                `[ShipStation] createOrder ${res.statusCode}: ${
                  body || '(empty body)'
                }`
              );
              console.error(
                `[ShipStation] response headers:`,
                JSON.stringify(res.headers, null, 2)
              );
              console.error(
                `[ShipStation] request body byte length:`,
                Buffer.byteLength(jsonBody)
              );
              // Sample of payload for forensics. Truncate giant payloads.
              const sample =
                jsonBody.length > 3000
                  ? jsonBody.slice(0, 3000) + '... (truncated)'
                  : jsonBody;
              console.error(`[ShipStation] Request body:`, sample);
              // Build an Error that carries the status code, response
              // headers, and body so route handlers can branch on
              // specific failure modes.
              const err = new Error(
                `ShipStation ${res.statusCode}: ${body || '(empty)'}`
              );
              err.statusCode = res.statusCode;
              err.responseBody = body || '';
              err.responseHeaders = res.headers || {};
              err.requestBody = jsonBody;
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(jsonBody);
      req.end();
    });
  }

  async getOrder(orderId) {
    const { data } = await this._client().get(`/orders/${orderId}`);
    return data;
  }

  async listOrders(params = {}) {
    const { data } = await this._client().get('/orders', { params });
    return data;
  }

  /**
   * GET /shipments — the authoritative source for shipment records.
   *
   * WHY IT EXISTS: tracking numbers live on shipments, not orders.
   * The `/orders/{id}` response has a `shipments[]` array but it
   * is empty in practice (confirmed by the Sep 2026 diagnostic on
   * order 117452: `/orders/554343421` returned `shipments.length=0`
   * and no `trackingNumber` field anywhere; `/shipments?orderId=
   * 554343421` returned the real tracking). Since Phase 13e, the
   * scheduler's `shipments[shipments.length-1].trackingNumber ||
   * ssOrder.trackingNumber || null` read has fallen through to
   * `null` on 100% of ~458 shipments — a silent-fallback bug that
   * masked the actual failure ("we're reading the wrong endpoint")
   * as "SS returned nothing." Do not read tracking from `/orders`
   * anywhere; use `getBestShipmentForOrder` below.
   *
   * Useful params: { orderId, orderNumber, pageSize (max 500),
   * sortBy: 'CreateDate'|'ShipDate', sortDir: 'DESC'|'ASC' }.
   * Returns { shipments: [...], total, page, pages }. Each
   * shipment carries: shipmentId, orderId, orderKey, orderNumber,
   * trackingNumber, carrierCode, serviceCode, packageCode,
   * shipDate, createDate, shipmentCost, voided, shipmentItems.
   */
  async listShipments(params = {}) {
    const { data } = await this._client().get('/shipments', { params });
    return data;
  }

  /**
   * Fetch ALL shipments for an SS order, following pagination.
   * Bounded to 10 pages of 500 (=5000 shipments/order) as a
   * runaway guard — one order having thousands of shipments would
   * be a data-modeling problem worth investigating rather than
   * silently paging through.
   */
  async _fetchAllShipmentsForOrder(ssOrderId) {
    const out = [];
    let page = 1;
    const HARD_PAGE_LIMIT = 10;
    for (;;) {
      const resp = await this.listShipments({
        orderId: ssOrderId,
        pageSize: 500,
        page,
        sortBy: 'CreateDate',
        sortDir: 'DESC',
      });
      const shipments = resp?.shipments || [];
      out.push(...shipments);
      const pages = resp?.pages || 1;
      if (page >= pages) break;
      if (page >= HARD_PAGE_LIMIT) {
        console.warn(
          `[shipstationService] order ${ssOrderId} has >${HARD_PAGE_LIMIT} pages of shipments; stopping paging (collected ${out.length})`
        );
        break;
      }
      page += 1;
    }
    return out;
  }

  /**
   * Pick the "best" shipment from a list — most recent non-voided.
   *
   * PURE FUNCTION. Extracted so verify-shipment-extraction.js can
   * exercise it without hitting SS. Do not add I/O here.
   *
   * Sort: we re-sort in JS by shipDate DESC (falling back to
   * createDate, then 0) even though the API call requests
   * sortDir=DESC. Rationale: API sort is best-effort — the API
   * decides the sort key, we don't control it after the request,
   * and a future API change to a different default could silently
   * flip which shipment we pick. Sorting locally on the fields we
   * care about is the invariant we control.
   *
   * Voided filter: strict `=== true`. Any other value (undefined,
   * null, "false", 0) is treated as non-voided — SS returns
   * `voided: false` as JSON boolean today, but the strict check
   * defends against future serialization changes making all
   * shipments look voided.
   */
  _pickBestShipment(shipments) {
    if (!Array.isArray(shipments) || shipments.length === 0) return null;
    const nonVoided = shipments.filter((s) => s && s.voided !== true);
    if (nonVoided.length === 0) return null;
    const sorted = [...nonVoided].sort((a, b) => {
      const da = Date.parse(a.shipDate || a.createDate || '') || 0;
      const db = Date.parse(b.shipDate || b.createDate || '') || 0;
      return db - da;
    });
    return sorted[0];
  }

  /**
   * Extract the fields we actually use from a shipment record.
   *
   * PURE FUNCTION. Normalizes:
   *   - trackingNumber: trim + reject empty + reject 000-prefix
   *     ('000...' is USPS flat "reference number", not real
   *     tracking — see CM's hasRealTracking in shippingMeta.ts).
   *   - shipmentCost: coerce number/numeric-string to number,
   *     reject negative + non-finite.
   *   - shipDate: fall back to createDate. Return raw ISO string;
   *     callers slice to YYYY-MM-DD for Sytist's DATE column.
   *   - carrierCode / serviceCode: pass through, null if missing.
   *   - voided: mirrored for the caller's logs.
   */
  _extractShipmentFields(shipment) {
    if (!shipment) return null;
    const rawTracking = shipment.trackingNumber;
    const trackingStr = rawTracking != null ? String(rawTracking).trim() : '';
    const trackingNumber =
      trackingStr !== '' && !/^0{3,}/.test(trackingStr) ? trackingStr : null;

    let shipmentCost = null;
    const rawCost = shipment.shipmentCost;
    if (typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0) {
      shipmentCost = rawCost;
    } else if (typeof rawCost === 'string' && rawCost.trim() !== '') {
      const parsed = parseFloat(rawCost);
      if (Number.isFinite(parsed) && parsed >= 0) shipmentCost = parsed;
    }

    return {
      shipmentId: shipment.shipmentId ?? null,
      trackingNumber,
      carrierCode: shipment.carrierCode || null,
      serviceCode: shipment.serviceCode || null,
      packageCode: shipment.packageCode || null,
      shipmentCost,
      shipDate: shipment.shipDate || shipment.createDate || null,
      voided: shipment.voided === true,
    };
  }

  /**
   * The one-stop lookup: fetch all shipments for an SS order,
   * filter voided, pick the most recent by shipDate, and return
   * the extracted fields. Returns null if no non-voided shipment
   * exists. Callers should treat null as "the order genuinely has
   * no live shipment yet" vs. "SS is broken" — SS/network errors
   * throw and are the caller's responsibility to catch.
   */
  async getBestShipmentForOrder(ssOrderId) {
    const shipments = await this._fetchAllShipmentsForOrder(ssOrderId);
    const best = this._pickBestShipment(shipments);
    return this._extractShipmentFields(best);
  }

  async deleteOrder(orderId) {
    const { data } = await this._client().delete(`/orders/${orderId}`);
    return data;
  }

  async markAsShipped(shipmentData) {
    // ShipStation requires this be in a specific shape:
    //   { orderId, carrierCode, trackingNumber, notifyCustomer, shipDate, ... }
    const { data } = await this._client().post(
      '/orders/markasshipped',
      shipmentData
    );
    return data;
  }

  // ─── CARRIERS / SERVICES ────────────────────────────────

  async listCarriers() {
    const { data } = await this._client().get('/carriers');
    return data;
  }

  async listServices(carrierCode) {
    const { data } = await this._client().get('/carriers/listservices', {
      params: { carrierCode },
    });
    return data;
  }

  async listPackages(carrierCode) {
    const { data } = await this._client().get('/carriers/listpackages', {
      params: { carrierCode },
    });
    return data;
  }

  // ─── PAYLOAD BUILDER ────────────────────────────────────

  /**
   * Build a ShipStation order payload from a Sytist order (the shape
   * returned by sytistDbService.getOrderById). Returns the payload
   * ready to pass to createOrder().
   *
   * Filters out:
   *   - line items with SKIP_FLAGS (downloads, gift certs, etc.)
   *   - drop-shipped line items (per specialtyService.isDropShipped)
   *
   * If after filtering nothing is shippable, returns:
   *   { __skipShipStation: true, reason, message, dropShippedItemCount }
   * — caller should detect this and skip the createOrder call.
   *
   * Overrides: caller can pass {carrierCode, serviceCode, packageCode,
   * weight, dimensions} to override the defaults. Phase 13b's packaging
   * engine will inject smarter values here; for 13a it's manual values
   * from the Ship form on the order detail page.
   */
  async buildOrderFromSytist(order, overrides = {}) {
    const specialtyService = require('./specialtyService');
    const packagingService = require('./packagingService');

    // ─── Filter line items ──────────────────────────────
    const allLineItems = order.lineItems || [];
    const shippable = [];
    const skipped = []; // [{cartId, reason}]

    for (const li of allLineItems) {
      // Check skip flags first — cheap, no I/O
      const flagSkip = SKIP_FLAGS.find((f) => li.flags && li.flags[f]);
      if (flagSkip) {
        skipped.push({ cartId: li.cartId, reason: flagSkip, sku: li.sku });
        continue;
      }
      // Drop-shipped check
      try {
        const isDropShipped = await specialtyService.isDropShipped(li.sku);
        if (isDropShipped) {
          skipped.push({
            cartId: li.cartId,
            reason: 'dropShipped',
            sku: li.sku,
          });
          continue;
        }
      } catch (e) {
        // Defensive: if the check throws, include the item.
        // Easier to refund a label than to fail to ship.
      }
      // Phase 45: digital-by-config check. Catches SKUs like 5D where
      // Sytist's cart_download=0 (so flags.download is false) but the
      // dashboard's packaging-config classifies the SKU as digital.
      try {
        if (await packagingService.isDigital(li.sku)) {
          skipped.push({ cartId: li.cartId, reason: 'digital', sku: li.sku });
          continue;
        }
      } catch (e) {
        // Same defensive fallback as drop-ship.
      }
      shippable.push(li);
    }

    if (shippable.length === 0) {
      const allReasons = skipped.reduce((acc, s) => {
        acc[s.reason] = (acc[s.reason] || 0) + 1;
        return acc;
      }, {});
      const reasonStr = Object.entries(allReasons)
        .map(([r, n]) => `${n} ${r}`)
        .join(', ');
      return {
        __skipShipStation: true,
        reason: 'no_shippable_items',
        message: `No shippable items in order ${order.orderId} (${reasonStr})`,
        skipped,
      };
    }

    // ─── Build ship-to / bill-to ────────────────────────
    const shipTo = order.shipTo || {};
    const customer = order.customer || {};

    // ShipStation wants `name` as a single string. Combine first+last
    // and fall back through several sources so we always have SOMETHING.
    const shipToName =
      [shipTo.firstName, shipTo.lastName].filter(Boolean).join(' ').trim() ||
      [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() ||
      customer.businessName ||
      'Customer';

    const shipToAddress = {
      name: shipToName,
      company: shipTo.businessName || '',
      street1: shipTo.address1 || '',
      street2: shipTo.address2 || null,
      city: shipTo.city || '',
      state: shipTo.state || '',
      postalCode: shipTo.zip || '',
      country: normalizeCountry(shipTo.country),
      phone: shipTo.phone || customer.phone || '',
    };

    // Bill-to mirrors ship-to unless the operator wires up something
    // smarter later. ShipStation accepts the same structure.
    const billToName =
      [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() ||
      shipToName;
    const billToAddress = {
      name: billToName,
      company: customer.businessName || '',
      street1: shipTo.address1 || '',
      street2: shipTo.address2 || null,
      city: shipTo.city || '',
      state: shipTo.state || '',
      postalCode: shipTo.zip || '',
      country: normalizeCountry(shipTo.country),
      phone: customer.phone || shipTo.phone || '',
    };

    // ─── Consult the packaging engine ───────────────────
    // Phase 13b: packagingService.determinePackaging analyzes the
    // filtered order and returns suggested carrier/service/package/
    // dimensions/weight + per-item weights. shipstationService keeps
    // its own SKIP filtering (drop-shipped + SKIP_FLAGS) before
    // handing the order off, since the engine doesn't know about
    // those concerns.
    //
    // Failure mode: if the engine throws (corrupt config etc.), fall
    // back to manual app-settings defaults. Operator can still ship,
    // they just don't get the rule-based suggestion.
    let packaging = null;
    try {
      const packagingService = require('./packagingService');
      packaging = await packagingService.determinePackaging({
        ...order,
        lineItems: shippable, // engine works on shippable items only
      });
    } catch (err) {
      console.warn(
        `[ShipStation] Packaging engine error for order ${order.orderId}: ${err.message} — falling back to defaults`
      );
    }

    // Phase 13b hotfix #2: log the weight breakdown so operators can
    // compare engine output against scale weight when investigating
    // ShipStation labels that don't match reality. The Test Calculator
    // shows the same data in the browser.
    if (packaging?.weightBreakdown) {
      _logPackagingTrace(order.orderId, packaging);
    }

    // ─── Build items with per-item weights from the engine ──
    // Phase 58 hotfix 2: resolve the order's whole-oz floor BEFORE the
    // line-item loop (this resolution used to run later, after the
    // loop, under hotfix 1) so we can distribute it across physical
    // lines as integer oz. Then build a per-line map of integer oz
    // summing exactly to the floor. SS gets `units: 'ounces'` integers
    // throughout — no oz↔g round-trip lossiness, exact rate-tier
    // billing. SS sums line-item weights if any SKU has Product
    // Defaults stored on its side, so the per-item sum must equal the
    // order weight (which the integer distribution guarantees).
    let weightOz;
    if (overrides.weight?.value != null) {
      weightOz = parseFloat(overrides.weight.value);
    } else if (packaging?.weight?.value != null) {
      weightOz = packaging.weight.value;
    } else {
      weightOz = parseFloat(
        appSettings.getRawValueSync('defaultWeightOz') || '4'
      );
    }
    weightOz = Math.max(1, Math.floor(weightOz));

    const integerOzByKey = distributeIntegerOzAcrossLines(
      packaging?.itemWeights || [],
      weightOz
    );

    const items = shippable.map((li) => {
      const namePieces = [];
      if (li.productNameDisplay) namePieces.push(li.productNameDisplay);
      if (li.photo?.originalFilename)
        namePieces.push(li.photo.originalFilename);
      const name = namePieces.join(' · ') || 'Photo Product';

      const lineItemKey = String(li.cartId || '');
      const qty = li.qty || 1;
      const lineIntegerOz = integerOzByKey[lineItemKey];

      const payload = {
        lineItemKey,
        sku: String(li.sku || ''),
        name,
        quantity: qty,
        unitPrice: typeof li.price === 'number' ? li.price : 0,
        options: [
          { name: 'CartId', value: String(li.cartId || '') },
          li.subGalleryName
            ? { name: 'Team', value: String(li.subGalleryName) }
            : null,
        ].filter(Boolean),
      };

      // Phase 41: per-item thumbnail in ShipStation's UI. ShipStation's
      // V1 API accepts `imageUrl` as a public URL string and fetches
      // it server-side to render the line-item thumbnail in their
      // order detail view. Useful for operators packing the box —
      // they can visually confirm the customer's photo without
      // cross-referencing against Sytist.
      //
      // Phase 42: prefer li.composedImageUrl if present. That's set
      // by processingService's Step 1.4 when green-screen items are
      // composed AND the configured composedThumbnailService backend
      // returns a usable public URL (i.e. S3 is configured). For
      // non-green-screen items it stays undefined, and we fall back
      // to Sytist's photo URLs.
      //
      // Why composedImageUrl matters: green-screen items have a
      // transparent PNG as their photo.thumbUrl (subject keyed out
      // with no background). Sending that to ShipStation gives a
      // misleading thumbnail. The composed thumbnail shows the
      // subject AND the customer's chosen background, matching what
      // will actually print.
      //
      // Omitted entirely (not sent as null) when no URL is available —
      // ShipStation's API has been observed to 400 on null imageUrl
      // in some accounts.
      //
      // Package constituents inherit their parent's photo via the
      // expansion in sytistDbService._expandPackageLineItems, so this
      // works for package orders without special-casing.
      const imageUrl =
        li.composedImageUrl ||
        li.photo?.thumbUrl ||
        li.photo?.largeUrl ||
        li.photo?.fullUrl ||
        null;
      if (imageUrl) {
        payload.imageUrl = imageUrl;
      }

      // Phase 58 hotfix 2: per-unit weight in OUNCES (integer). The
      // line's integer-oz contribution was computed once above via
      // `distributeIntegerOzAcrossLines`, so the sum across all
      // physical lines equals the order's whole-oz floor exactly —
      // no oz↔g round-trip lossiness (see SPEC §58 hotfix 2).
      // For qty=1 (the dominant case): per-unit = lineIntegerOz
      // exactly. For qty>1: SS computes line total as qty × per-unit
      // (integer), and Phase 13b's "SS truncates fractional oz per
      // line" still applies — so we Math.ceil per-unit, accepting a
      // bounded ≤(qty-1) oz over-shoot per such line. A console.warn
      // fires when this actually happens so we can quantify the
      // (probably rare) case in production.
      if (lineIntegerOz !== undefined && qty > 0) {
        let unitOz;
        if (qty === 1) {
          unitOz = lineIntegerOz;
        } else {
          unitOz = Math.ceil(lineIntegerOz / qty);
          if (unitOz * qty !== lineIntegerOz) {
            console.warn(
              `[SS] line ${lineItemKey} sku=${String(li.sku || '')} qty=${qty} lineIntegerOz=${lineIntegerOz}: per-unit ceil=${unitOz} → SS will compute ${unitOz * qty} oz (over by ${unitOz * qty - lineIntegerOz} oz). qty>1 with non-divisible integer-oz line — bounded; see SPEC §58 hotfix 2`
            );
          }
        }
        payload.weight = { value: unitOz, units: 'ounces' };
      }

      return payload;
    });

    // ─── Order-level fields ─────────────────────────────
    const customerEmail = customer.email || '';

    // Notes — operators / lab staff see these in the ShipStation UI.
    // Include enough to trace back to Sytist if something looks wrong.
    // Phase 13b: also surface the engine's chosen packaging type so
    // operators can sanity-check what the rules engine decided.
    const internalNotes = [
      `Sytist Order ID: ${order.orderId}`,
      `Workflow: ${order.shipping?.workflow || 'unknown'}`,
      order.galleryName ? `Gallery: ${order.galleryName}` : null,
      order.isSibling ? `Sibling order` : null,
      skipped.length > 0
        ? `${skipped.length} line item(s) skipped (${skipped
            .map((s) => s.reason)
            .join(',')})`
        : null,
      packaging
        ? `Pkg: ${packaging.packageTypeName} (${packaging.carrierCode}/${packaging.serviceCode}/${packaging.packageCode})`
        : null,
    ]
      .filter(Boolean)
      .join(' | ');

    // ─── Weight + dimensions ───────────────────────────
    // Precedence: explicit overrides > engine output > app-settings
    // defaults. Engine wins only when it produced a result; on
    // engine failure or a fresh install with no SKUs registered yet,
    // app-settings defaults take over.

    // Phase 58 hotfix 2: `defaultWeightOz` is no longer declared here;
    // the order-level weight resolution (overrides > engine > app-
    // settings default) was hoisted above the line-item loop and now
    // looks up `defaultWeightOz` inline at the resolution site so
    // `weightOz` is available for integer-oz per-line distribution.
    const defaultLength = parseFloat(
      appSettings.getRawValueSync('defaultLengthIn') || '10'
    );
    const defaultWidth = parseFloat(
      appSettings.getRawValueSync('defaultWidthIn') || '8'
    );
    const defaultHeight = parseFloat(
      appSettings.getRawValueSync('defaultHeightIn') || '0.5'
    );
    const defaultCarrier =
      appSettings.getRawValueSync('defaultCarrier') || 'stamps_com';
    const defaultService =
      appSettings.getRawValueSync('defaultService') ||
      'usps_first_class_mail';
    const defaultPackage =
      appSettings.getRawValueSync('defaultPackageCode') ||
      'large_envelope_or_flat';

    // Phase 58 hotfix 2: `weightOz` (whole-oz floor, applies to
    // overrides, engine output, and the no-engine `defaultWeightOz`
    // fallback equally) was resolved above, before the line-item
    // loop, so we could distribute it across physical lines as
    // integer oz (`integerOzByKey`). The grams conversion that lived
    // here (`weightG = Math.ceil(weightOz * OZ_TO_G)` under hotfix 1)
    // is gone — the payload sends `units: 'ounces'` directly.

    // Dimensions resolution: overrides > engine > app-settings.
    let dimensions;
    if (overrides.dimensions) {
      dimensions = overrides.dimensions;
    } else if (packaging?.dimensions) {
      dimensions = packaging.dimensions;
    } else {
      dimensions = {
        length: defaultLength,
        width: defaultWidth,
        height: defaultHeight,
        units: 'inches',
      };
    }

    const carrierCode =
      overrides.carrierCode || packaging?.carrierCode || defaultCarrier;
    const serviceCode =
      overrides.serviceCode || packaging?.serviceCode || defaultService;
    const packageCode =
      overrides.packageCode || packaging?.packageCode || defaultPackage;

    // ─── Final payload ──────────────────────────────────
    // Phase 43: ensure orderDate is in ISO 8601 format. Sytist's
    // MySQL returns DATETIME columns as strings in the form
    // "YYYY-MM-DD HH:MM:SS" (space separator), which ShipStation's
    // V1 API rejects with a confusing 404 / empty body. Convert
    // any truthy value through Date so the output is always ISO.
    let orderDateISO;
    try {
      orderDateISO = order.orderDate
        ? new Date(order.orderDate).toISOString()
        : new Date().toISOString();
    } catch (dateErr) {
      console.warn(
        `[ShipStation] orderDate "${order.orderDate}" couldn't be parsed; using current time: ${dateErr.message}`
      );
      orderDateISO = new Date().toISOString();
    }

    return {
      orderNumber: order.orderNumber || String(order.orderId),
      orderKey: String(order.orderId),
      orderDate: orderDateISO,
      orderStatus: 'awaiting_shipment',
      customerEmail,
      billTo: billToAddress,
      shipTo: shipToAddress,
      items,
      internalNotes,
      weight: { value: weightOz, units: 'ounces' },
      dimensions,
      confirmation: 'none',
      carrierCode,
      serviceCode,
      packageCode,
      requestedShippingService: serviceCode,
    };
  }

  /**
   * Preview-only path that returns the packaging engine's suggestion
   * for an order without building a full SS payload. Used by the
   * order detail page to pre-populate the Ship form, and by the
   * Settings → Packaging "test calculator" to inspect engine output.
   *
   * Applies the same SKIP_FLAGS + drop-shipped filter that the
   * real createOrder path does, so the preview matches reality.
   *
   * Returns:
   *   {
   *     ok: boolean,
   *     packaging: { ...engine result... } | null,
   *     skipped: [{ cartId, reason, sku }],
   *     shippableCount,
   *     error?: string,
   *   }
   */
  async previewPackagingForOrder(order) {
    const specialtyService = require('./specialtyService');
    const packagingService = require('./packagingService');

    const allLineItems = order.lineItems || [];
    const shippable = [];
    const skipped = [];
    for (const li of allLineItems) {
      const flagSkip = SKIP_FLAGS.find((f) => li.flags && li.flags[f]);
      if (flagSkip) {
        skipped.push({ cartId: li.cartId, reason: flagSkip, sku: li.sku });
        continue;
      }
      try {
        if (await specialtyService.isDropShipped(li.sku)) {
          skipped.push({
            cartId: li.cartId,
            reason: 'dropShipped',
            sku: li.sku,
          });
          continue;
        }
      } catch (e) {
        // Defensive — same fallback as buildOrderFromSytist
      }
      // Phase 45: mirror the digital-by-config check in buildOrderFromSytist
      // so the preview reflects the same eligibility the real path applies.
      try {
        if (await packagingService.isDigital(li.sku)) {
          skipped.push({ cartId: li.cartId, reason: 'digital', sku: li.sku });
          continue;
        }
      } catch (e) {
        // Same defensive fallback.
      }
      shippable.push(li);
    }

    if (shippable.length === 0) {
      return {
        ok: false,
        packaging: null,
        skipped,
        shippableCount: 0,
        error: 'No shippable items',
      };
    }

    try {
      const packaging = await packagingService.determinePackaging({
        ...order,
        lineItems: shippable,
      });
      return {
        ok: true,
        packaging,
        skipped,
        shippableCount: shippable.length,
      };
    } catch (err) {
      return {
        ok: false,
        packaging: null,
        skipped,
        shippableCount: shippable.length,
        error: err.message,
      };
    }
  }
}

module.exports = new ShipStationService();
// Phase 58 hotfix 2: export the integer-oz distribution helper for the
// offline verification harness (server/scripts/verify-weight-
// distribution.js). Singleton stays the default export; this is a
// named attach in the same pattern as compositeService's LAYOUTS_PATH.
module.exports.distributeIntegerOzAcrossLines = distributeIntegerOzAcrossLines;
// Ship 2 followup (2026-09-04): expose the 429 error class + guard
// so callers (reconcile, backfill CLI) can catch rate-limit distinctly
// from other axios errors. See class docstring at file top.
module.exports.ShipStationRateLimitedError = ShipStationRateLimitedError;
module.exports.isShipStationRateLimitedError = isShipStationRateLimitedError;
