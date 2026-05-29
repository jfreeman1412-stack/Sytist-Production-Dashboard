// server/services/packagingService.js
//
// Phase 13b: packaging rules engine. Ported from the PhotoDay
// dashboard with three adaptations:
//   1. Sytist's field names (sku/qty/cartId) instead of PhotoDay's
//      (externalId/quantity/id). The internal logic is identical;
//      only the data shape adapter changed.
//   2. Built-in `fs` instead of fs-extra (matches Sytist's other
//      services after the hotfix-5 lesson).
//   3. Config defaults match what's been working in the PhotoDay
//      lab — SKUs are identical between the two systems so the
//      product weight + packaging type tables port unchanged.
//
// PURPOSE
//
// Given a Sytist order, return:
//   { packageType, packageTypeName, dimensions, weight, carrierCode,
//     serviceCode, packageCode, notes[], itemWeights[] }
//
// Used by shipstationService.buildOrderFromSytist to pre-populate
// the SS payload. The operator can still override any value via the
// ShippingBlock form on the order detail page before sending.
//
// PRIORITY ORDER of packaging decisions:
//   1. Framed 10x30 pano → pano_frame_lg (UPS Ground Saver)
//   2. Framed 8x24 pano → pano_frame_sm (UPS Ground Saver)
//   3. Coffee mug alone → small box; with others → large box
//   4. Pano (32/33) alone → pano tube; with others → medium box
//   5. Rigid items (plaques + configured boxRouteSKUs):
//        1 rigid item  → medium box
//        2+ rigid items → large box
//   6. Mouse pad → medium box
//   7. Category rigid/bulky/pano → 9x11 flat-as-package (Phase 66 — the
//      category dropdown is the source of truth; replaces forcePackageSKUs)
//   8. Magnet threshold (3+ across magnet SKUs) → 9x11 flat-as-package
//   9. Has any 8x10-size product (SKUs 6/8/9/22) or package bundle →
//      9x11 flat mailer
//  10. Default → 6x8 flat mailer
//
// PER-ITEM WEIGHTS
//
// ShipStation sums line-item weights and replaces the order weight
// with that sum when any line-item SKU has Product Defaults stored
// in SS. To stay correct in that case, the engine emits per-item
// weights (in oz) totaling exactly the order weight. The packaging
// baseWeight + the floor-rounding delta gets rolled onto the first
// non-digital line item so the math works out exactly.
//
// Phase 58: weights are FLOORED to whole oz (Math.max(1, Math.floor)),
// not ceiled. USPS gives a 1oz grace per package, so an 8.7oz package
// labeled 8oz is safe and saves a rate tier. The delta is negative
// (we shed the fractional bit) — the absorbing item gets
// `+baseWeight − |fraction|` instead of `+baseWeight + |fraction|`.
// `_buildItemWeights` clamps the absorbing item to ≥1oz so a
// degenerate baseWeight=0 config can't drive it negative.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'packaging-config.json');

// ─── Default config ──────────────────────────────────────────
// Phase 13b hotfix #1: values taken directly from PhotoDay's LIVE
// production packaging-config.json — the file that's been driving
// real ShipStation creates for the PhotoDay lab. Sytist's earlier
// defaults were my guesses; they were significantly off for plaques,
// pano frames, collector cards, magnets, and many other SKUs.
// First-run creates this file if absent. Operators can still edit
// it via the Settings → Packaging page once the defaults are loaded.

const DEFAULT_CONFIG = {
  // SKU → { weight (oz), display name, category }
  // Categories: flat, rigid, pano, bulky, digital
  productWeights: {
    '6':  { weight: 0.5,  name: 'Memory Mate',          category: 'flat' },
    '7':  { weight: 0.2,  name: 'Key Chain',            category: 'rigid' },
    '8':  { weight: 0.5,  name: '8x10 Individual',      category: 'flat' },
    '9':  { weight: 0.5,  name: '8x10 Team Photo',      category: 'flat' },
    '10': { weight: 0.1,  name: '5x7 Individual Print', category: 'flat' },
    '11': { weight: 0.1,  name: '5x7 Team Photo',       category: 'flat' },
    '12': { weight: 0.5,  name: '8 Wallets',            category: 'flat' },
    '13': { weight: 4,    name: 'Collector Cards',      category: 'rigid' },
    '14': { weight: 0,    name: 'Statuette',            category: 'flat' },
    '15': { weight: 1.7,  name: '2 Large Magnets',      category: 'flat' },
    '16': { weight: 0.6,  name: 'Photo Button',         category: 'bulky' },
    '17': { weight: 1.7,  name: '4 Mini Magnets',       category: 'flat' },
    '18': { weight: 1,    name: 'Bagtag',               category: 'rigid' },
    '19': { weight: 5,    name: 'Mouse Pad',            category: 'rigid' },
    '20': { weight: 11.5, name: 'Coffee Mug',           category: 'bulky' },
    '21': { weight: 13.4, name: '5x7 Plaque',           category: 'rigid' },
    '22': { weight: 32,   name: '8x10 Plaque',          category: 'rigid' },
    '25': { weight: 0,    name: 'Digital Download',     category: 'digital' },
    '26': { weight: 0,    name: 'Acrylic Ornament',     category: 'flat' },
    '27': { weight: 0.5,  name: '4-3.5x5 Prints',       category: 'flat' },
    '32': { weight: 2,    name: '8x24 Pano',            category: 'pano' },
    '33': { weight: 2.8,  name: '10x30 Pano',           category: 'pano' },
    '34': { weight: 2.8,  name: '12x36 Pano',           category: 'pano' },
    '35': { weight: 3,    name: 'Trading Cards',        category: 'rigid' },
    '36': { weight: 32,   name: 'Item 36',              category: 'rigid' },
    '45': { weight: 0.2,  name: 'Item 45',              category: 'flat' },
  },

  // Bundle SKUs (Gold/Silver/Bronze).
  //
  // Phase 13b hotfix #3: weights set to the SUM of constituent item
  // weights, since Sytist's bundles are single line items (not
  // decomposed into multiple line items like PhotoDay's are).
  //
  //   Gold   = Memory Mate + 8x10 + 5x7 + 5x7 team + 8 wallets +
  //            8 trading cards + 2 magnets + button + digital
  //          = 0.5 + 0.5 + 0.1 + 0.1 + 0.5 + 3 + 1.7 + 0.6 + 0
  //          = 7.0 oz
  //   Silver = same as Gold minus trading cards + button
  //          = 0.5 + 0.5 + 0.1 + 0.1 + 0.5 + 1.7 + 0
  //          = 3.4 oz
  //   Bronze = 4 small prints + 8 wallets
  //          = 0.5 + 0.5 = 1.0 oz
  //
  // forcePackage:true on Gold routes it to Package service (not flat
  // envelope) because of the magnets/button rigid items inside.
  //
  // If your lab's package contents change, edit these via
  // Settings → Packaging → Package bundles. Don't change the SKU IDs
  // (1/2/3) — those are Sytist's product IDs for the packages.
  packageBundles: {
    '1': { name: 'Gold Package',   weight: 7.0, forcePackage: true },
    '2': { name: 'Silver Package', weight: 3.4, forcePackage: false },
    '3': { name: 'Bronze Package', weight: 1.0, forcePackage: false },
  },

  // Packaging type templates. baseWeight = empty packaging weight
  // (box + foam + tape + label etc.) added on top of line items.
  // Values from PD's live config — pano frames especially are MUCH
  // heavier than my earlier guesses (30/44 oz vs 8/10).
  packagingTypes: {
    'flat_6x8':      { name: '6x8 Flat Mailer',  length: 6,  width: 8,  height: 0.5, baseWeight: 1.5, service: 'large_envelope_or_flat' },
    'flat_9x11':     { name: '9x11 Flat Mailer', length: 9,  width: 11, height: 0.5, baseWeight: 3,   service: 'large_envelope_or_flat' },
    'pano_tube':     { name: 'Pano Tube',        length: 12, width: 2,  height: 2,   baseWeight: 2.6, service: 'package' },
    'small_box':     { name: 'Small Box',        length: 6,  width: 6,  height: 6,   baseWeight: 3.5, service: 'package' },
    'medium_box':    { name: 'Medium Box',       length: 12, width: 10, height: 2,   baseWeight: 5.5, service: 'package' },
    'pano_frame_sm': { name: '8x24 Pano Frame',  length: 26, width: 10, height: 2,   baseWeight: 30,  service: 'package' },
    'pano_frame_lg': { name: '10x30 Pano Frame', length: 31, width: 11, height: 2,   baseWeight: 44,  service: 'package' },
    'large_box':     { name: 'Large Box',        length: 14, width: 10, height: 6,   baseWeight: 9,   service: 'package' },
  },

  // Phase 66: forcePackageSKUs RETIRED. "Force Package service" is now
  // driven entirely by productWeights[sku].category (rigid/bulky/pano) — see
  // the force-package loop in determinePackaging. No parallel SKU list to
  // keep in sync.

  // Combined-count rule: if sum of quantities across the listed
  // SKUs ≥ threshold, force PACKAGE service. PD's live config
  // counts magnets and mini-magnets together.
  magnetThreshold: {
    skus: ['15', '17'],
    threshold: 3,
  },

  // Framed pano SKUs. PD's live config has dimension-string entries
  // ("26x10x2", "31x11x2") that never match real SKUs — effectively
  // disabling these rules in production. Sytist starts empty; add
  // real framed-pano SKUs here when you stock them.
  framedPanoSmallSKUs: [],
  framedPanoLargeSKUs: [],

  // SKUs that need a box rather than flat mailer. From PD's live
  // config: Item 36 (32oz rigid), Trading Cards (3oz), Items 38/41/
  // 42/45/46, Mouse Pad. 1 rigid item → medium box, 2+ → large box.
  // (SKUs 21/22 are also boxed via the legacy plaque rule.)
  boxRouteSKUs: ['36', '35', '38', '41', '42', '45', '46', '19'],

  // Packing slip weight (oz). Added to every order's total.
  packingSlipWeightOz: 0.4,

  // Slip placement in the Darkroom .txt — 'first' or 'last'.
  // PD's live config uses 'last' (slip prints at the end of the
  // batch); Sytist's previous default was 'first'. Changed to
  // match PD; flip back if your Darkroom workflow expects 'first'.
  packingSlipPosition: 'last',
};

// ─── Small JSON helpers (built-in fs, no fs-extra) ───────────

async function readJsonAsync(file) {
  const buf = await fsp.readFile(file, 'utf8');
  return JSON.parse(buf);
}
async function writeJsonAsync(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}
function writeJsonSync(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Service ─────────────────────────────────────────────────

class PackagingService {
  constructor() {
    this._ensureConfig();
  }

  _ensureConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
      // Make sure parent dir exists. /server/config should already
      // be there from other services, but be defensive.
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      writeJsonSync(CONFIG_PATH, DEFAULT_CONFIG);
      console.log(
        `[PackagingService] Created default config at ${CONFIG_PATH}`
      );
    }
  }

  // ─── Config read/write ──────────────────────────────────────

  async getConfig() {
    const config = await readJsonAsync(CONFIG_PATH);
    return this._migrateConfig(config);
  }

  /**
   * Apply backward-compatible migrations to a loaded config.
   * Currently only ensures required fields exist on partial files
   * (so manual edits that omit a section don't crash the engine).
   */
  _migrateConfig(config) {
    let dirty = false;
    if (!config.magnetThreshold) {
      config.magnetThreshold = { skus: ['15'], threshold: 3 };
      dirty = true;
    }
    if (!Array.isArray(config.magnetThreshold.skus)) {
      config.magnetThreshold.skus = [];
      dirty = true;
    }
    if (!Array.isArray(config.boxRouteSKUs)) {
      config.boxRouteSKUs = [];
      dirty = true;
    }
    if (!Array.isArray(config.framedPanoSmallSKUs)) {
      config.framedPanoSmallSKUs = [];
      dirty = true;
    }
    if (!Array.isArray(config.framedPanoLargeSKUs)) {
      config.framedPanoLargeSKUs = [];
      dirty = true;
    }
    // Phase 66: forcePackageSKUs retired — no longer seeded or read. An
    // existing key left in a config file is harmless (nothing reads it); we
    // intentionally do NOT strip it here to keep migration non-destructive.
    if (config.packingSlipPosition === undefined) {
      config.packingSlipPosition = 'first';
      dirty = true;
    }
    if (config.packingSlipWeightOz === undefined) {
      config.packingSlipWeightOz = 0.4;
      dirty = true;
    }
    if (dirty) {
      writeJsonAsync(CONFIG_PATH, config).catch((err) => {
        console.warn(
          `[PackagingService] Migration write failed: ${err.message}`
        );
      });
    }
    return config;
  }

  async updateConfig(updates) {
    const config = await this.getConfig();
    Object.assign(config, updates);
    await writeJsonAsync(CONFIG_PATH, config);
    return config;
  }

  // ─── Product weights CRUD (used by the Packaging settings UI) ─

  async getProductWeights() {
    const config = await this.getConfig();
    return config.productWeights || {};
  }

  // Phase 45: returns true if the SKU's productWeights entry has
  // category='digital'. Sytist doesn't reliably set cart_download=1
  // for digital-package SKUs like 5D, so the SS filter can't lean
  // on flags.download alone. Lookup is case-tolerant: tries the
  // uppercased SKU first (matches how digital entries are stored),
  // falls back to the raw key (preserves behavior for legacy
  // numeric SKUs and any future lowercased config entry).
  async isDigital(sku) {
    if (!sku) return false;
    const weights = await this.getProductWeights();
    const raw = String(sku);
    const upper = raw.toUpperCase();
    const entry = weights[upper] || (raw !== upper ? weights[raw] : null);
    return !!(entry && entry.category === 'digital');
  }

  // Phase 60a: returns true if the SKU's productWeights entry has
  // instantPackEligible === true. Default-deny: a missing entry or a
  // missing/false flag means NOT eligible (so an order containing a SKU
  // the operator hasn't explicitly marked is never instant-pack eligible).
  // Lookup is case-tolerant in the same way as isDigital so the two stay
  // in lockstep — sytistDbService._makePackagingPredicates reimplements
  // this exact lookup synchronously over a pre-loaded productWeights map,
  // and the offline harness exercises the same rule.
  async isInstantPackEligible(sku) {
    if (!sku) return false;
    const weights = await this.getProductWeights();
    const raw = String(sku);
    const upper = raw.toUpperCase();
    const entry = weights[upper] || (raw !== upper ? weights[raw] : null);
    return !!(entry && entry.instantPackEligible === true);
  }

  async setProductWeight(sku, data) {
    const config = await this.getConfig();
    // Phase 60a: preserve instantPackEligible when the caller omits it
    // (e.g. a future programmatic upsert that only touches weight/name).
    // The PackagingPage row sends it on every save, so the operator's
    // checkbox is authoritative there; an omitted field keeps the prior
    // value rather than silently flipping it to default-deny false.
    const existing = config.productWeights[String(sku)] || {};
    config.productWeights[String(sku)] = {
      weight: parseFloat(data.weight) || 0,
      name: data.name || '',
      category: data.category || 'flat',
      instantPackEligible:
        data.instantPackEligible === undefined
          ? !!existing.instantPackEligible
          : !!data.instantPackEligible,
    };
    await writeJsonAsync(CONFIG_PATH, config);
    return config.productWeights;
  }

  async deleteProductWeight(sku) {
    const config = await this.getConfig();
    delete config.productWeights[String(sku)];
    await writeJsonAsync(CONFIG_PATH, config);
    return config.productWeights;
  }

  async getPackagingTypes() {
    const config = await this.getConfig();
    return config.packagingTypes || {};
  }

  async setPackagingType(typeId, data) {
    const config = await this.getConfig();
    config.packagingTypes[String(typeId)] = {
      name: data.name || typeId,
      length: parseFloat(data.length) || 0,
      width: parseFloat(data.width) || 0,
      height: parseFloat(data.height) || 0,
      baseWeight: parseFloat(data.baseWeight) || 0,
      service: data.service || 'package',
    };
    await writeJsonAsync(CONFIG_PATH, config);
    return config.packagingTypes;
  }

  async setPackageBundle(sku, data) {
    const config = await this.getConfig();
    if (!config.packageBundles) config.packageBundles = {};
    config.packageBundles[String(sku)] = {
      name: data.name || '',
      weight: parseFloat(data.weight) || 0,
      forcePackage: !!data.forcePackage,
    };
    await writeJsonAsync(CONFIG_PATH, config);
    return config.packageBundles;
  }

  async deletePackageBundle(sku) {
    const config = await this.getConfig();
    if (config.packageBundles) {
      delete config.packageBundles[String(sku)];
      await writeJsonAsync(CONFIG_PATH, config);
    }
    return config.packageBundles || {};
  }

  // ─── Core engine ────────────────────────────────────────────

  /**
   * Determine packaging for a Sytist order. The order is expected
   * to be the shape returned by sytistDbService.getOrderById —
   * with .lineItems[] each having .sku, .qty, .cartId, .productName.
   *
   * Returns:
   *   {
   *     packageType: string,
   *     packageTypeName: string,
   *     dimensions: { length, width, height, units: 'inches' },
   *     weight: { value, units: 'ounces' },
   *     carrierCode, serviceCode, packageCode,
   *     notes: string[],         -- human-readable rule trace
   *     itemWeights: [{ lineItemKey, sku, weightOz }],
   *   }
   *
   * Notes:
   *   - Caller is responsible for filtering drop-shipped items
   *     BEFORE calling (shipstationService does this). The engine
   *     filters digital category internally for weight purposes.
   *   - itemWeights are in OUNCES; shipstationService.buildOrder
   *     converts to grams for the SS payload.
   */
  async determinePackaging(order) {
    const config = await this.getConfig();
    const items = order.lineItems || [];

    // Phase 38: filter out items that should NOT influence packaging.
    //
    // The original filter (Phase 13) kept items with unknown SKUs at
    // a fallback weight of 1oz, which meant any uncategorized SKU
    // (digital downloads, gift certificates, unmapped products) got
    // treated as physical and could push a digital-only order into
    // a "Medium Box" bundle. The fix: be conservative — only items
    // we KNOW are physical influence packaging.
    //
    // Five filter cases, in order of cheapness:
    //
    //   1. Missing/empty SKU                    → skip
    //   2. Digital download flag                → skip
    //      (lineItem.flags.download = true, set by sytistDbService
    //      from Sytist's cart_download column AND from digital
    //      package constituents)
    //   3. Package header row                   → KEEP for routing
    //      (forcePackage rules look at it; weight loop zero-weights
    //      it to avoid double-counting against exploded constituents)
    //   4. Known SKU with category 'digital'    → skip
    //   5. Unknown SKU (not in productWeights)  → skip
    //
    // Anything that survives all 5 is a known physical SKU OR a
    // package header. Both legitimately influence packaging.
    const physicalItems = items.filter((item) => {
      const sku = String(item.sku || '').trim();

      // 1. Missing SKU
      if (!sku) return false;

      // 2. Digital download flag
      if (item.flags?.download) return false;

      // 3. Package header — keep for forcePackage routing
      if (item.flags?.isPackageHeader) return true;

      // 4 + 5. Look up in config
      const pw = config.productWeights[sku];
      if (!pw) return false;                    // unknown SKU
      if (pw.category === 'digital') return false; // known digital

      return true;
    });

    if (physicalItems.length === 0) {
      return this._buildResult(
        'flat_9x11',
        config,
        4,
        ['Digital-only order, using default 9x11 flat'],
        order
      );
    }

    // SKU → quantity map for the routing rules
    const skuMap = {};
    for (const item of physicalItems) {
      const sku = String(item.sku || '');
      skuMap[sku] = (skuMap[sku] || 0) + (item.qty || 1);
    }
    const skuSet = new Set(Object.keys(skuMap));

    const notes = [];

    // ─── Calculate total weight ────────────────────────────
    // Phase 13b hotfix #2: also build a structured weightBreakdown
    // so the operator can audit the math. The engine reports both
    // the final total AND every component that went into it — items,
    // slip, mailer baseWeight, rounding delta. This is the data
    // backing the Test Calculator's "Weight breakdown" panel and
    // the [Packaging Trace] server log.
    const weightBreakdown = {
      items: [],         // [{ sku, name, qty, unitWeightOz, lineWeightOz, source: 'productWeights'|'packageBundle'|'fallback' }]
      itemsSubtotalOz: 0,
      packingSlipOz: 0,
      packagingBaseWeightOz: 0,
      packagingTypeId: null,   // populated by _buildResult
      packagingTypeName: null, // populated by _buildResult
      preRoundingOz: 0,        // populated by _buildResult
      roundingDeltaOz: 0,      // populated by _buildResult — sign-carrying (negative under Phase 58 floor)
      finalOz: 0,              // populated by _buildResult
    };

    let totalWeight = 0;
    for (const item of physicalItems) {
      const sku = String(item.sku || '');
      const qty = item.qty || 1;

      // Phase 15a: package header rows contribute no weight — their
      // constituent items (already in physicalItems thanks to the
      // explosion in sytistDbService) carry the real weights. Without
      // this skip, we'd double-count: bundle.weight on the header
      // PLUS each constituent's weight. The header still drives
      // routing (forcePackage check below) but not weight.
      if (item.flags?.isPackageHeader) {
        weightBreakdown.items.push({
          sku,
          name: (config.packageBundles[sku] || {}).name || `Package ${sku}`,
          qty,
          unitWeightOz: 0,
          lineWeightOz: 0,
          source: 'packageHeaderSkipped',
        });
        continue;
      }

      const bundle = config.packageBundles[sku];
      let unitWeight;
      let source;
      let name;
      if (bundle) {
        unitWeight = bundle.weight || 0;
        source = 'packageBundle';
        name = bundle.name;
      } else {
        const pw = config.productWeights[sku];
        if (pw) {
          unitWeight = pw.weight || 0;
          source = 'productWeights';
          name = pw.name;
        } else {
          unitWeight = 1;
          source = 'fallback';
          name = item.productNameDisplay || `Unknown SKU ${sku}`;
        }
      }
      const lineWeight = unitWeight * qty;
      totalWeight += lineWeight;
      weightBreakdown.items.push({
        sku,
        name,
        qty,
        unitWeightOz: unitWeight,
        lineWeightOz: lineWeight,
        source,
      });
    }
    weightBreakdown.itemsSubtotalOz = totalWeight;

    // 5x8 packing slip ships with every order.
    const packingSlipWeightOz = config.packingSlipWeightOz ?? 0.4;
    if (packingSlipWeightOz > 0) {
      totalWeight += packingSlipWeightOz;
      weightBreakdown.packingSlipOz = packingSlipWeightOz;
      notes.push(`+${packingSlipWeightOz}oz packing slip`);
    }

    // ─── Priority-ordered routing decisions ────────────────

    // 1. Framed Large Pano (10x30)
    const hasFramedLargePano = (config.framedPanoLargeSKUs || []).some(
      (s) => skuSet.has(s)
    );
    if (hasFramedLargePano) {
      notes.push('Framed 10x30 Pano detected');
      return this._buildResult(
        'pano_frame_lg',
        config,
        totalWeight,
        notes,
        order,
        weightBreakdown
      );
    }

    // 2. Framed Small Pano (8x24)
    const hasFramedSmallPano = (config.framedPanoSmallSKUs || []).some(
      (s) => skuSet.has(s)
    );
    if (hasFramedSmallPano) {
      notes.push('Framed 8x24 Pano detected');
      return this._buildResult(
        'pano_frame_sm',
        config,
        totalWeight,
        notes,
        order,
        weightBreakdown
      );
    }

    // 3. Coffee Mug
    const hasMug = skuSet.has('20');
    if (hasMug) {
      const otherPhysical = physicalItems.filter(
        (i) =>
          String(i.sku) !== '20' &&
          config.productWeights[String(i.sku)]?.category !== 'digital'
      );
      if (otherPhysical.length === 0) {
        notes.push('Coffee Mug alone → Small Box');
        return this._buildResult(
          'small_box',
          config,
          totalWeight,
          notes,
          order,
          weightBreakdown
        );
      } else {
        notes.push('Coffee Mug + other items → Large Box');
        return this._buildResult(
          'large_box',
          config,
          totalWeight,
          notes,
          order,
          weightBreakdown
        );
      }
    }

    // 4. Pano (32 or 33)
    const hasPano32 = skuSet.has('32');
    const hasPano33 = skuSet.has('33');
    const hasPano = hasPano32 || hasPano33;

    if (hasPano) {
      const nonPanoPhysical = physicalItems.filter((i) => {
        const sku = String(i.sku);
        const pw = config.productWeights[sku];
        return (
          sku !== '32' &&
          sku !== '33' &&
          sku !== '25' &&
          pw?.category !== 'digital'
        );
      });
      if (nonPanoPhysical.length === 0) {
        notes.push('Pano alone → Pano Tube');
        return this._buildResult(
          'pano_tube',
          config,
          totalWeight,
          notes,
          order,
          weightBreakdown
        );
      } else {
        notes.push('Pano + other items → Medium Box');
        return this._buildResult(
          'medium_box',
          config,
          totalWeight,
          notes,
          order,
          weightBreakdown
        );
      }
    }

    // 5. Box-route items. Legacy plaques (21/22) + any configured.
    const legacyPlaqueSkus = ['21', '22'];
    const configuredBoxRouteSkus = (config.boxRouteSKUs || []).map(String);
    const allBoxRouteSkus = new Set([
      ...legacyPlaqueSkus,
      ...configuredBoxRouteSkus,
    ]);

    let rigidItemCount = 0;
    const rigidItemDescriptions = [];
    for (const item of physicalItems) {
      const sku = String(item.sku || '');
      if (allBoxRouteSkus.has(sku)) {
        const qty = item.qty || 1;
        rigidItemCount += qty;
        const desc = item.productNameDisplay || `SKU ${sku}`;
        rigidItemDescriptions.push(qty > 1 ? `${qty}× ${desc}` : desc);
      }
    }

    if (rigidItemCount >= 2) {
      notes.push(
        `${rigidItemCount} rigid items (${rigidItemDescriptions.join(
          ', '
        )}) → Large Box`
      );
      return this._buildResult(
        'large_box',
        config,
        totalWeight,
        notes,
        order,
        weightBreakdown
      );
    }
    if (rigidItemCount === 1) {
      notes.push(
        `Rigid item (${rigidItemDescriptions[0]}) → Medium Box`
      );
      return this._buildResult(
        'medium_box',
        config,
        totalWeight,
        notes,
        order,
        weightBreakdown
      );
    }

    // 6. Mouse Pad (19) — medium box
    if (skuSet.has('19')) {
      notes.push('Mouse Pad → Medium Box');
      return this._buildResult(
        'medium_box',
        config,
        totalWeight,
        notes,
        order,
        weightBreakdown
      );
    }

    // ─── Flat vs Package determination ─────────────────────

    // Phase 66: category is the SINGLE source of truth for "force Package
    // service". Any physical SKU whose productWeights.category is rigid /
    // bulky / pano ships as packageCode='package' — a flat mailer can't
    // protect it. This REPLACES the retired forcePackageSKUs list, which had
    // to be hand-kept in sync with the category dropdown and drifted (e.g.
    // SKU 18 Bagtag was category 'rigid' but absent from the list, so it
    // shipped as a flat). Box SIZING above (boxRouteSKUs → Medium/Large) is
    // untouched: a boxed SKU already returned earlier with service=package, so
    // this only catches items that would otherwise fall to the flat default.
    // The bundle forcePackage override below and the magnet count rule are
    // also untouched.
    const PACKAGE_CATEGORIES = new Set(['rigid', 'bulky', 'pano']);
    let forcePackage = false;
    for (const sku of skuSet) {
      const pw = config.productWeights[sku];
      if (pw && PACKAGE_CATEGORIES.has(pw.category)) {
        notes.push(
          `SKU ${sku} (${pw.name || 'unknown'}) category '${pw.category}' → Package service`
        );
        forcePackage = true;
      }
      const bundle = config.packageBundles[sku];
      if (bundle?.forcePackage) {
        notes.push(
          `${bundle.name} (SKU ${sku}) forces Package service`
        );
        forcePackage = true;
      }
    }

    // Magnet threshold across the listed SKUs
    const magnetRule = config.magnetThreshold || {
      skus: [],
      threshold: Infinity,
    };
    const magnetSkus = Array.isArray(magnetRule.skus)
      ? magnetRule.skus.map(String)
      : [];
    const magnetThreshold = magnetRule.threshold || 0;
    if (magnetSkus.length > 0 && magnetThreshold > 0) {
      const combinedMagnetCount = magnetSkus.reduce(
        (sum, sku) => sum + (skuMap[sku] || 0),
        0
      );
      if (combinedMagnetCount >= magnetThreshold) {
        notes.push(
          `${combinedMagnetCount} magnet set(s) across [${magnetSkus.join(
            ', '
          )}] (≥${magnetThreshold}) → Package service`
        );
        forcePackage = true;
      }
    }

    if (forcePackage) {
      notes.push('Using 9x11 as Package');
      const result = this._buildResult(
        'flat_9x11',
        config,
        totalWeight,
        notes,
        order,
        weightBreakdown
      );
      result.serviceCode = this._getServiceCode(
        result.weight.value,
        'package',
        result.carrierCode
      );
      result.packageCode = 'package';
      result.dimensions.height = 0.5;
      return result;
    }

    // ─── Default flat mailer: 6x8 or 9x11 based on largest item ─
    // Consult the imposition engine when available. If a SKU's
    // imposition layout has a sheet > 6×8, we need the 9×11 mailer.
    // Falls back to SKU heuristic when imposition isn't available
    // or the SKU has no layout.

    const FLAT_6X8_MAX_DIM = 8; // longest side that fits in 6×8 mailer
    const FLAT_6X8_SHORT_DIM = 6;
    let hasLargeItem = false;
    let largeReason = '';

    let impositionService;
    try {
      impositionService = require('./impositionService');
    } catch (e) {
      // Optional dependency — engine works without it.
      impositionService = null;
    }

    for (const item of physicalItems) {
      const sku = String(item.sku || '');

      let layout = null;
      if (impositionService && typeof impositionService.findRule === 'function') {
        try {
          layout = await impositionService.findRule(sku);
        } catch (e) {
          // Corrupt/missing imposition data — fall through to heuristic.
        }
      }

      if (layout) {
        const longSide = Math.max(
          layout.sheetWidth || 0,
          layout.sheetHeight || 0
        );
        const shortSide = Math.min(
          layout.sheetWidth || 0,
          layout.sheetHeight || 0
        );
        if (longSide > FLAT_6X8_MAX_DIM || shortSide > FLAT_6X8_SHORT_DIM) {
          hasLargeItem = true;
          largeReason = `SKU ${sku} imposed on ${layout.sheetWidth}x${layout.sheetHeight} sheet`;
          break;
        }
        continue; // Imposition layout fits in 6x8 — no need for heuristic
      }

      // SKU heuristic for 8x10-size products
      if (['6', '8', '9', '22'].includes(sku)) {
        hasLargeItem = true;
        largeReason = `SKU ${sku} is an 8x10-size product`;
        break;
      }
      // Package bundles contain 8x10 items
      if (config.packageBundles[sku]) {
        hasLargeItem = true;
        largeReason = `SKU ${sku} (${config.packageBundles[sku].name}) bundle contains 8x10 items`;
        break;
      }
    }

    if (hasLargeItem) {
      notes.push(`${largeReason} → 9x11 Flat Mailer`);
      return this._buildResult(
        'flat_9x11',
        config,
        totalWeight,
        notes,
        order,
        weightBreakdown
      );
    }

    notes.push('All items fit in 6x8 → 6x8 Flat Mailer');
    return this._buildResult(
      'flat_6x8',
      config,
      totalWeight,
      notes,
      order,
      weightBreakdown
    );
  }

  // ─── Result construction ─────────────────────────────────────

  /**
   * Build per-item weight map. Packaging baseWeight + ceiling
   * rounding gets rolled onto the first physical line item so
   * the sum equals targetTotalOz exactly. This is what defeats
   * SS's per-line oz truncation / product-default override.
   *
   * Returns: { items: [{lineItemKey, sku, weightOz}], totalOz }
   */
  _buildItemWeights(order, config, targetTotalOz) {
    const items = order?.lineItems || [];
    const result = [];
    let firstPhysicalIndex = -1;
    let physicalSubtotal = 0;

    for (const item of items) {
      const sku = String(item.sku || '');
      const qty = item.qty || 1;
      const lineItemKey = String(item.cartId || '');
      const pw = config.productWeights[sku];
      const bundle = config.packageBundles[sku];

      if (pw?.category === 'digital') {
        result.push({ lineItemKey, sku, weightOz: 0 });
        continue;
      }

      let unitWeight;
      if (bundle) {
        unitWeight = bundle.weight || 0;
      } else {
        unitWeight = pw?.weight ?? 1;
      }

      const lineWeight = unitWeight * qty;
      if (firstPhysicalIndex === -1) firstPhysicalIndex = result.length;
      physicalSubtotal += lineWeight;
      result.push({ lineItemKey, sku, weightOz: lineWeight });
    }

    // Sum mismatch → roll the remainder onto the first physical item.
    // Phase 58 (floor): the remainder can be NEGATIVE — we floored the
    // target below items+baseWeight — so the absorber loses the
    // fractional bit. Clamp to ≥1oz so a degenerate baseWeight=0
    // config can't drive a single-item order negative. With realistic
    // baseWeights (≥1.5oz for flat_6x8, larger for boxes) the
    // negative-remainder magnitude is bounded by ~1oz and the absorber
    // stays well above 1.
    if (firstPhysicalIndex >= 0) {
      const remainder = targetTotalOz - physicalSubtotal;
      if (Math.abs(remainder) > 0.0001) {
        const next = result[firstPhysicalIndex].weightOz + remainder;
        result[firstPhysicalIndex].weightOz = Math.max(1, next);
      }
    }

    const totalOz = result.reduce((s, r) => s + r.weightOz, 0);
    return { items: result, totalOz };
  }

  _buildResult(packageTypeId, config, itemWeight, notes, order, weightBreakdown = null) {
    // Build a stub breakdown if none was provided (e.g. the digital-only
    // early-exit path). This keeps the return shape consistent regardless
    // of which routing branch produced the result.
    if (!weightBreakdown) {
      weightBreakdown = {
        items: [],
        itemsSubtotalOz: itemWeight,
        packingSlipOz: 0,
        packagingBaseWeightOz: 0,
        packagingTypeId: null,
        packagingTypeName: null,
        preRoundingOz: itemWeight,
        roundingDeltaOz: 0,
        finalOz: 0,
      };
    }

    const pkgType = config.packagingTypes[packageTypeId];
    if (!pkgType) {
      // Unknown packaging type — emit a safe fallback (9x11 flat)
      // rather than throw. Notes record the situation.
      // Phase 58: floor to whole oz (min 1) — USPS 1oz grace.
      const fallbackTotal = Math.max(1, Math.floor(itemWeight + 2));
      const itemWeightInfo = this._buildItemWeights(
        order,
        config,
        fallbackTotal
      );
      weightBreakdown.packagingTypeId = 'flat_9x11';
      weightBreakdown.packagingTypeName = 'Default 9x11 Flat (fallback)';
      weightBreakdown.packagingBaseWeightOz = 2;
      weightBreakdown.preRoundingOz = itemWeight + 2;
      weightBreakdown.roundingDeltaOz = fallbackTotal - (itemWeight + 2);
      weightBreakdown.finalOz = fallbackTotal;
      return {
        packageType: 'flat_9x11',
        packageTypeName: 'Default 9x11 Flat',
        dimensions: { length: 9, width: 11, height: 0.5, units: 'inches' },
        weight: { value: fallbackTotal, units: 'ounces' },
        carrierCode: 'stamps_com',
        serviceCode: 'usps_first_class_mail',
        packageCode: 'large_envelope_or_flat',
        notes: [
          ...notes,
          `Packaging type "${packageTypeId}" not found; using fallback`,
        ],
        itemWeights: itemWeightInfo.items,
        weightBreakdown,
      };
    }

    const baseWeight = pkgType.baseWeight || 0;
    const preRoundingOz = itemWeight + baseWeight;
    // Phase 58: floor to whole oz (min 1) — USPS 1oz grace.
    const totalWeight = Math.max(1, Math.floor(preRoundingOz));
    const carrierCode = this._getCarrierCode(totalWeight, packageTypeId);
    const serviceCode = this._getServiceCode(
      totalWeight,
      pkgType.service,
      carrierCode
    );

    const itemWeightInfo = this._buildItemWeights(
      order,
      config,
      totalWeight
    );

    weightBreakdown.packagingTypeId = packageTypeId;
    weightBreakdown.packagingTypeName = pkgType.name;
    weightBreakdown.packagingBaseWeightOz = baseWeight;
    weightBreakdown.preRoundingOz = preRoundingOz;
    weightBreakdown.roundingDeltaOz = totalWeight - preRoundingOz;
    weightBreakdown.finalOz = totalWeight;

    return {
      packageType: packageTypeId,
      packageTypeName: pkgType.name,
      dimensions: {
        length: pkgType.length,
        width: pkgType.width,
        height: pkgType.height,
        units: 'inches',
      },
      weight: { value: totalWeight, units: 'ounces' },
      carrierCode,
      serviceCode,
      packageCode:
        pkgType.service === 'large_envelope_or_flat'
          ? 'large_envelope_or_flat'
          : 'package',
      notes,
      itemWeights: itemWeightInfo.items,
      weightBreakdown,
    };
  }

  /**
   * Carrier selection. Framed panos and very heavy orders go UPS,
   * everything else USPS via Stamps.com.
   */
  _getCarrierCode(weightOz, packageTypeId) {
    if (
      packageTypeId === 'pano_frame_sm' ||
      packageTypeId === 'pano_frame_lg'
    ) {
      return 'ups_walleted';
    }
    if (weightOz > 48) {
      return 'ups_walleted';
    }
    return 'stamps_com';
  }

  /**
   * Service selection paired with the chosen carrier. ShipStation
   * rejects mismatched carrier/service pairs with a 400.
   */
  _getServiceCode(weightOz, defaultService, carrierCode) {
    if (carrierCode === 'ups_walleted') {
      return 'ups_ground_saver';
    }
    // USPS path. First Class is < 13oz only.
    if (weightOz > 13) {
      return 'usps_ground_advantage';
    }
    return 'usps_first_class_mail';
  }
}

module.exports = new PackagingService();
