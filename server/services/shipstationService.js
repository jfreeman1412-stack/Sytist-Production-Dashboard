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
// Per-item weights are sent in GRAMS (integers), not ounces. SS truncates
// fractional ounces per line item before summing them as the order
// weight, which can lose up to ~1oz on multi-line orders. Grams are
// integers so this lossy rounding can't bite us. The order-level weight
// is also converted to grams for the same reason.

const axios = require('axios');
const appSettings = require('../config/appSettings');

const OZ_TO_G = 28.3495;
// Sytist line items can carry these flags; we don't ship the line item
// if any of these are true. Matches the SKIP_FLAGS used by the Phase 11
// processing pipeline.
const SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell'];

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
//     Pre-ceiling total: 3.7 oz
//     Ceiling rounding: +0.3 oz
//     ────────────────────────────
//     FINAL:             4 oz  →  carrier=stamps_com service=usps_first_class_mail
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
  lines.push(`  Pre-ceiling total: ${_fmt(wb.preCeilingOz)} oz`);
  if (wb.ceilingRemainderOz > 0.001) {
    lines.push(`  Ceiling rounding: +${_fmt(wb.ceilingRemainderOz)} oz`);
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
      (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.Message || error.message;
        console.error(`[ShipStation] ${status}: ${message}`);
        if (status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 30;
          console.warn(
            `[ShipStation] Rate limited. Retry after ${retryAfter}s`
          );
        }
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
    // ShipStation sums line-item weights if any SKU has Product
    // Defaults stored on its side. The engine emits per-line weights
    // (in oz) that total exactly the order weight. We convert each
    // line's TOTAL weight (qty × unit) back to per-unit grams since
    // ShipStation multiplies its unit weight by quantity itself.
    const itemWeightByKey = {};
    if (packaging?.itemWeights) {
      for (const iw of packaging.itemWeights) {
        if (iw.lineItemKey) itemWeightByKey[iw.lineItemKey] = iw.weightOz;
      }
    }

    const items = shippable.map((li) => {
      const namePieces = [];
      if (li.productName) namePieces.push(li.productName);
      if (li.photo?.originalFilename)
        namePieces.push(li.photo.originalFilename);
      const name = namePieces.join(' · ') || 'Photo Product';

      const lineItemKey = String(li.cartId || '');
      const qty = li.qty || 1;
      const lineWeightOz = itemWeightByKey[lineItemKey];

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

      // Per-unit weight in grams. Engine gives us LINE total (qty×unit)
      // so divide back out first. Use grams because SS truncates
      // fractional ounces per line when summing.
      if (lineWeightOz !== undefined && qty > 0) {
        const unitWeightOz = lineWeightOz / qty;
        const unitWeightG = Math.max(1, Math.round(unitWeightOz * OZ_TO_G));
        payload.weight = { value: unitWeightG, units: 'grams' };
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

    const defaultWeightOz = parseFloat(
      appSettings.getRawValueSync('defaultWeightOz') || '4'
    );
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

    // Order-level weight resolution: overrides > engine > app-settings.
    let weightOz;
    if (overrides.weight?.value != null) {
      weightOz = parseFloat(overrides.weight.value);
    } else if (packaging?.weight?.value != null) {
      weightOz = packaging.weight.value;
    } else {
      weightOz = defaultWeightOz;
    }
    const weightG = Math.max(1, Math.round(weightOz * OZ_TO_G));

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
      weight: { value: weightG, units: 'grams' },
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
