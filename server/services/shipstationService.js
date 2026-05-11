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
              console.error(
                `[ShipStation] createOrder ${res.statusCode}: ${
                  body || '(empty body)'
                }`
              );
              console.error(`[ShipStation] Request body:`, jsonBody);
              reject(
                new Error(
                  `ShipStation ${res.statusCode}: ${body || '(empty)'}`
                )
              );
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

    // ─── Build items ────────────────────────────────────
    // For 13a we don't have per-item packaging weights (that's the
    // packaging engine in 13b). Set name/SKU/qty without weights and
    // let the order-level weight stand. Once 13b lands we'll populate
    // weight per item to dodge the SS line-item-sum truncation issue.
    const items = shippable.map((li) => {
      // ShipStation displays the `name` field on packing slips and in
      // the orders list. Combining productName with the photo filename
      // gives operators enough to verify the right item is being shipped.
      const namePieces = [];
      if (li.productName) namePieces.push(li.productName);
      if (li.photo?.originalFilename)
        namePieces.push(li.photo.originalFilename);
      const name = namePieces.join(' · ') || 'Photo Product';

      return {
        lineItemKey: String(li.cartId || ''),
        sku: String(li.sku || ''),
        name,
        quantity: li.qty || 1,
        unitPrice: typeof li.price === 'number' ? li.price : 0,
        options: [
          { name: 'CartId', value: String(li.cartId || '') },
          li.subGalleryName
            ? { name: 'Team', value: String(li.subGalleryName) }
            : null,
        ].filter(Boolean),
      };
    });

    // ─── Order-level fields ─────────────────────────────
    const customerEmail = customer.email || '';

    // Notes — operators / lab staff see these in the ShipStation UI.
    // Include enough to trace back to Sytist if something looks wrong.
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
    ]
      .filter(Boolean)
      .join(' | ');

    // ─── Weight + dimensions (manual for 13a) ───────────
    // Defaults come from appSettings; overrides win.
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
      appSettings.getRawValueSync('defaultService') || 'usps_first_class_mail';
    const defaultPackage =
      appSettings.getRawValueSync('defaultPackageCode') ||
      'large_envelope_or_flat';

    const weightOz =
      overrides.weight?.value != null
        ? parseFloat(overrides.weight.value)
        : defaultWeightOz;
    const weightG = Math.max(1, Math.round(weightOz * OZ_TO_G));

    const dimensions = overrides.dimensions || {
      length: defaultLength,
      width: defaultWidth,
      height: defaultHeight,
      units: 'inches',
    };

    const carrierCode = overrides.carrierCode || defaultCarrier;
    const serviceCode = overrides.serviceCode || defaultService;
    const packageCode = overrides.packageCode || defaultPackage;

    // ─── Final payload ──────────────────────────────────
    return {
      orderNumber: order.orderNumber || String(order.orderId),
      orderKey: String(order.orderId),
      orderDate: order.orderDate || new Date().toISOString(),
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
}

module.exports = new ShipStationService();
