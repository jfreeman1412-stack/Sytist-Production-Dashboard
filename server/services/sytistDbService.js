// Sytist MySQL data layer.
//
// Phase 2a: connection pool + healthCheck.
// Phase 2b Step 1: simple lookup queries (statuses + galleries).
// Phase 2b Step 2: getOrdersByWorkflow — assembles the canonical order shape.
// Phase 2c (later): updateOrderStatus.

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Display name for production status 0. Sytist has no row in ms_order_status
// for status 0; we synthesize a label for it. Internal Sytist convention
// historically called this "Queue"; Sportsline operationally calls it "Open".
const STATUS_OPEN_NAME = 'Open';

// ─── Shipping option mapping ──────────────────────────────
// Loaded once at module init; reload by restarting the server.
const SHIPPING_MAPPING_PATH = path.join(
  __dirname,
  '..',
  'config',
  'shipping-option-mappings.json'
);

// Phase 60: digital-only order detection for workflow classification.
// A customer who orders only digital downloads pays no shipping ($0.00,
// empty shipping option), which used to fall through categorizeShipping's
// numeric fallback into ship_to_league. Such an order has nothing physical
// to ship, so it now goes to its own 'digital' workflow bucket instead.
const PACKAGING_CONFIG_PATH = path.join(
  __dirname,
  '..',
  'config',
  'packaging-config.json'
);

// Returns a SQL-safe, uppercased, single-quoted, comma-joined list of the
// SKUs flagged category='digital' in packaging-config.json — e.g.
// "'3D','5D','20D'" — or null when none. Inlined into SQL (not a bound
// param) because the same clause is reused at many query positions
// (predicate + computed SELECT columns) and param-array juggling across
// those positions is error-prone; the source is trusted LOCAL config and
// every SKU is validated against [A-Z0-9 _-] so there is no injection
// surface. Read fresh each call so operator edits to packaging-config take
// effect without a restart (matching packagingService.getConfig's contract).
function _loadDigitalSkuList() {
  try {
    const cfg = JSON.parse(fs.readFileSync(PACKAGING_CONFIG_PATH, 'utf8'));
    const weights = cfg.productWeights || {};
    const skus = Object.keys(weights)
      .filter((k) => weights[k] && weights[k].category === 'digital')
      .map((s) => String(s).toUpperCase())
      .filter((s) => /^[A-Z0-9 _-]+$/.test(s));
    return skus.length ? skus.map((s) => `'${s}'`).join(',') : null;
  } catch {
    return null;
  }
}

// SQL fragment: TRUE when the order has at least one PHYSICAL (shippable)
// line item. Physical = a cart row that is neither a Sytist download
// (cart_download=1) nor a digital-by-config SKU (Phase 45: digital packages
// like 5D carry cart_download=0, so the SKU list is required to catch them).
// Checks BOTH ms_cart and ms_cart_archive since an order's rows live in one
// or the other (mirrors the gallery-filter EXISTS pattern). Param-free —
// the digital SKU list is the validated inline string from
// _loadDigitalSkuList(). The negation (NOT this) is "digital-only".
function _physicalItemExistsSql(digitalSkuList) {
  const skuLive = digitalSkuList ? ` AND UPPER(c.cart_sku) NOT IN (${digitalSkuList})` : '';
  const skuArch = digitalSkuList ? ` AND UPPER(ca.cart_sku) NOT IN (${digitalSkuList})` : '';
  return (
    `(EXISTS (SELECT 1 FROM ms_cart c WHERE c.cart_order = o.order_id AND c.cart_download = 0${skuLive})` +
    ` OR EXISTS (SELECT 1 FROM ms_cart_archive ca WHERE ca.cart_order = o.order_id AND ca.cart_download = 0${skuArch}))`
  );
}

// ─── Phase 60a: instant-pack eligibility ──────────────────────────────
//
// Per-SKU "instant-pack eligible" classification (default-deny), stored as
// productWeights[sku].instantPackEligible in packaging-config.json. This is
// a DISPLAY-ONLY badge in 60a — there is no orders-list filter tab and no
// count badge, so (unlike Phase 60's isDigitalOnly) it can be computed
// entirely in JS over the already-expanded canonical line items, in both
// getOrdersByWorkflow and getOrderById. There is deliberately NO SQL-side
// predicate. When 60b adds a filter tab / count badge, THAT is when a
// _buildWorkflowSqlPredicate-style SQL parity becomes mandatory — flagged so
// a future change doesn't ship a tab whose count disagrees with the badge.

// Flags that mean a line item is NOT a physical lab item for instant-pack
// purposes (a download, a gift cert, a credit product, a booking, a pre-sell
// placeholder). Mirrors the base SS SKIP_FLAGS. NOTE: specialty and drop-ship
// are deliberately ABSENT — those items DO physically ship, so they pass the
// isPhysical predicate below and must themselves be on the eligible list.
// Default-deny means they aren't (and a drop-ship SKU shouldn't be markable),
// which correctly disqualifies any order containing one.
const INSTANT_PACK_SKIP_FLAGS = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell', 'preRegister'];

// Build synchronous SKU→classification predicates from a pre-loaded
// productWeights map. Reimplements packagingService.isDigital /
// isInstantPackEligible's case-tolerant lookup (uppercase first, raw
// fallback) so the badge classification matches the async service exactly —
// they MUST agree (the service powers the SS filter / packing slip; this
// powers the orders-list badge and the order-detail shape).
function _makePackagingPredicates(productWeights) {
  const weights = productWeights || {};
  const lookup = (sku) => {
    if (!sku) return null;
    const raw = String(sku);
    const upper = raw.toUpperCase();
    return weights[upper] || (raw !== upper ? weights[raw] : null) || null;
  };
  return {
    isDigitalSku: (sku) => {
      const e = lookup(sku);
      return !!(e && e.category === 'digital');
    },
    isEligibleSku: (sku) => {
      const e = lookup(sku);
      return !!(e && e.instantPackEligible === true);
    },
  };
}

// Pure eligibility computation over expanded canonical line items. Predicates
// are injected so the offline harness runs without a DB or config.
//
// A line item PHYSICALLY SHIPS (and so must be eligible) iff it is not a
// package header, carries none of INSTANT_PACK_SKIP_FLAGS, and is not a
// digital-by-config SKU. Modifier-type add-ons never become line items, so
// they are ignored for free. Package constituents and product-type add-ons
// are evaluated by their OWN sku (each synthetic line item carries its own).
//
// An order is instant-pack eligible iff it has ≥1 physical item AND every
// physical item's sku is on the eligible list. blockingSkus lists the
// physical SKUs that are NOT eligible (deduped, in first-seen order) — these
// are exactly why an order with a physical item fails, including specialty /
// drop-ship SKUs that pass isPhysical but are default-deny-ineligible.
function _computeInstantPackEligibility(lineItems, predicates) {
  const isDigitalSku = (predicates && predicates.isDigitalSku) || (() => false);
  const isEligibleSku = (predicates && predicates.isEligibleSku) || (() => false);

  const physical = [];
  for (const li of lineItems || []) {
    const flags = (li && li.flags) || {};
    if (flags.isPackageHeader) continue;
    if (INSTANT_PACK_SKIP_FLAGS.some((f) => flags[f])) continue;
    if (isDigitalSku(li.sku)) continue;
    physical.push(li);
  }

  const blockingSkus = [];
  const seen = new Set();
  for (const li of physical) {
    if (isEligibleSku(li.sku)) continue;
    const key = String(li.sku == null ? '' : li.sku);
    if (seen.has(key)) continue;
    seen.add(key);
    blockingSkus.push(li.sku);
  }

  const eligible = physical.length >= 1 && blockingSkus.length === 0;
  return { eligible, physicalCount: physical.length, blockingSkus };
}

let SHIPPING_MAP = {
  ship_to_home: [],
  ship_to_managers: [],
  ship_to_league: [],
};

// Phase 58c: derive a leaf-only display name from Sytist's `>`-delimited
// product hierarchy (e.g. "Print Packages > Silver Package > 8x10" →
// "8x10"). Every line item gets BOTH `productName` (the full hierarchy
// string, unchanged — the identifier consumers like darkroomService
// template lookup, specialtyService path construction, and any
// operator-edited config in template-mappings.json / specialty-
// products.json continue to read this) AND `productNameDisplay` (the
// leaf, for every render/display site: dashboard UI, packing slip JPG,
// ShipStation payload, ms_notes audit text, imposition `{item_
// description}` token, log lines).
//
// Edge-case guard: if the split-and-trim yields an empty string (e.g.
// "Print Packages > " with a trailing `>`), fall back to the original
// string so we never render an empty product name. Display sites still
// guard with `|| '(no name)'` etc., but the helper itself never emits ''.
function deriveDisplayName(productName) {
  const raw = String(productName == null ? '' : productName);
  if (!raw) return raw;
  const leaf = raw.split('>').pop().trim();
  return leaf || raw;
}
try {
  const raw = fs.readFileSync(SHIPPING_MAPPING_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  SHIPPING_MAP = {
    ship_to_home: parsed.ship_to_home || [],
    ship_to_managers: parsed.ship_to_managers || [],
    ship_to_league: parsed.ship_to_league || [],
  };
  console.log(
    `[SytistDB] Loaded shipping mappings: ${SHIPPING_MAP.ship_to_home.length} home, ${SHIPPING_MAP.ship_to_managers.length} managers, ${SHIPPING_MAP.ship_to_league.length} league`
  );
} catch (err) {
  console.warn(
    `[SytistDB] Could not load ${SHIPPING_MAPPING_PATH}: ${err.message}`
  );
  console.warn('[SytistDB] All orders will hit numeric fallback.');
}

/**
 * Map an order_shipping_option string + cost to a workflow bucket.
 *
 * 1. Explicit mapping wins (config-file driven).
 * 2. Falls back to numeric rule based on shipping cost.
 * 3. Returns { workflow, uncategorized: bool } so UI can show warning badge.
 */
function categorizeShipping(optionName, cost, isDigitalOnly = false) {
  const opt = (optionName || '').trim();

  // A configured option-name match ALWAYS wins, regardless of cost or
  // digital status. A digital-only order that still carries an explicit
  // "USPS-Ship to Home" option stays home — the customer/gallery tagged it.
  if (SHIPPING_MAP.ship_to_home.includes(opt)) {
    return { workflow: 'ship_to_home', uncategorized: false };
  }
  if (SHIPPING_MAP.ship_to_managers.includes(opt)) {
    return { workflow: 'ship_to_managers', uncategorized: false };
  }
  if (SHIPPING_MAP.ship_to_league.includes(opt)) {
    return { workflow: 'ship_to_league', uncategorized: false };
  }

  // Numeric fallback. Operator should add this option to the JSON.
  const n = Number(cost) || 0;

  // Phase 60: a digital-only order (no physical item) at $0.00 has nothing
  // to ship — it must NOT be lumped into ship_to_league by the cost rule.
  // It only reaches here when its option name is unmapped AND cost isn't
  // >1.01 or =1.00 (i.e. the exact misclassification case). Unlike the other
  // fallback buckets this is a DETERMINISTIC classification — there's no
  // shipping option to add to the mapping — so it is NOT flagged
  // uncategorized (no misleading "add to config" ⚠ on the badge).
  if (!(n > 1.01) && n !== 1.0 && isDigitalOnly) {
    return { workflow: 'digital', uncategorized: false };
  }

  let workflow;
  if (n > 1.01) workflow = 'ship_to_home';
  else if (n === 1.0) workflow = 'ship_to_managers';
  else workflow = 'ship_to_league'; // n <= 0.99 (or anything weird)

  return { workflow, uncategorized: true };
}

// Phase 14a: SQL predicate equivalent of categorizeShipping(), for use
// in the WHERE clause when filtering by workflow. Must match the JS
// function's behavior exactly so that the workflow-filtered list,
// the order-counts endpoint, and per-order categorization all agree.
//
// The shape of the predicate is:
//   (option_name IN (mapped names for this workflow))
//   OR
//   (option_name NOT IN (any mapped name) AND
//      <numeric fallback predicate for this workflow>)
//
// The fallback bucket boundaries come from categorizeShipping:
//   cost > 1.01    → ship_to_home
//   cost === 1.0   → ship_to_managers
//   cost <= 0.99   → ship_to_league
//
// Returns { sql, params } where `sql` is a single parenthesized
// expression suitable for AND-joining into a WHERE clause. Returns
// null if the workflow string isn't recognized.
//
// Phase 60: `digitalSkuList` is the inline SQL list from
// _loadDigitalSkuList() (may be null). It powers the 'digital' bucket and
// the digital-only carve-out of the ship_to_league fallback. Must be kept
// in lockstep with categorizeShipping's `isDigitalOnly` branch — the JS
// path and this SQL path classify the SAME orders identically.
function _buildWorkflowSqlPredicate(workflow, digitalSkuList = null) {
  const allMappedNames = [
    ...SHIPPING_MAP.ship_to_home,
    ...SHIPPING_MAP.ship_to_managers,
    ...SHIPPING_MAP.ship_to_league,
  ];
  const physicalExists = _physicalItemExistsSql(digitalSkuList);

  // Phase 60: 'digital' bucket — option name unmapped AND free/cheap (the
  // old league-fallback cost band) AND NO physical item. Mirrors
  // categorizeShipping's `else if (isDigitalOnly) → 'digital'` branch,
  // which only fires after the >1.01 and =1.00 checks fail (so the cost
  // band here is the same `< 1.00 OR IS NULL` league fallback band).
  if (workflow === 'digital') {
    const notIn =
      allMappedNames.length > 0 ? 'o.order_shipping_option NOT IN (?) AND ' : '';
    const params = allMappedNames.length > 0 ? [allMappedNames] : [];
    const sql = `((${notIn}(o.order_shipping < 1.00 OR o.order_shipping IS NULL)) AND NOT ${physicalExists})`;
    return { sql, params };
  }

  // Fallback predicates for orders whose option name isn't in any
  // configured list. The 'else' bucket in categorizeShipping is
  // ship_to_league, which means anything < 1.0 (and the operator
  // didn't map). We use cost <= 0.99 to match the JS check that
  // n is treated as `n <= 0.99` after the >1.01 and ===1.0 checks
  // fail. Anything between 0.99 and 1.0 exclusive ends up in league
  // per the JS logic, so we include that interval too.
  const fallbackByWorkflow = {
    ship_to_home: 'o.order_shipping > 1.01',
    ship_to_managers: 'o.order_shipping = 1.00',
    ship_to_league: 'o.order_shipping < 1.00 OR o.order_shipping IS NULL',
  };

  const mappedNames = SHIPPING_MAP[workflow];
  const fallback = fallbackByWorkflow[workflow];
  if (!mappedNames || !fallback) return null;

  const params = [];
  const parts = [];

  // Branch 1: option name is explicitly in this workflow's mapping.
  if (mappedNames.length > 0) {
    // mysql2's pool.query() expands (?) when given an array, so we
    // pass the array as a single param and emit a single placeholder.
    parts.push('o.order_shipping_option IN (?)');
    params.push(mappedNames);
  }

  // Branch 2: option name is NOT in any mapping → use numeric fallback.
  // If the mapped-names list is empty for ALL workflows the user has
  // a misconfigured shipping map, but the SQL still works (every order
  // hits the fallback bucket).
  const notInClause =
    allMappedNames.length > 0 ? 'o.order_shipping_option NOT IN (?) AND ' : '';
  if (allMappedNames.length > 0) {
    params.push(allMappedNames);
  }

  // Phase 60: the ship_to_league FALLBACK branch now requires a physical
  // item — digital-only orders in that cost band go to the 'digital'
  // bucket instead. The name-matched league branch (Branch 1) is
  // untouched: a digital order with an explicit league option stays
  // league (option-name match wins, exactly as in categorizeShipping).
  const fallbackExpr =
    workflow === 'ship_to_league'
      ? `(${fallback}) AND ${physicalExists}`
      : `(${fallback})`;
  parts.push(`(${notInClause}${fallbackExpr})`);

  // Final predicate joins the branches with OR. Wrapped in parens so
  // it composes safely with AND-joined siblings.
  return { sql: `(${parts.join(' OR ')})`, params };
}

// ─── Subject field normalization ──────────────────────────
//
// Sytist stores extra fields as label/value pairs in 5 slots:
//   order_extra_field_N (label), order_extra_val_N (value)
// Labels often include trailing colons ("Athlete's Name:"). Strip those.
function normalizeSubjectFields(orderRow) {
  const fields = [];
  for (let i = 1; i <= 5; i++) {
    const rawLabel = orderRow[`order_extra_field_${i}`] || '';
    const value = orderRow[`order_extra_val_${i}`] || '';
    const label = rawLabel.replace(/[:\s]+$/, '').trim();
    if (label) {
      fields.push({ label, value });
    }
  }
  return fields;
}

// ─── Phase 15a: package explosion ─────────────────────────
//
// Sytist stores a customer's package order as a single ms_cart row
// with cart_package > 0 (e.g. "Gold Package" with one photo). The
// rest of the production pipeline (composite, imposition, darkroom,
// slip) operates on individual products, so we expand the package
// row into synthetic line items right after the cart→lineItems
// stitching in both getOrdersByWorkflow and getOrderById.
//
// Behavior:
//   - For each line item where flags.package === true, look up the
//     package's contents from packageContentsService.
//   - If contents are configured: emit the original package row as
//     a "header" (flags.isPackageHeader = true, used by the
//     processing pipeline to skip producing prints for the package
//     row itself), then emit synthetic line items for each constituent.
//   - If contents are NOT configured: pass the package row through
//     unchanged, the existing behavior (one print of the photo).
//     The Settings UI surfaces this as a config gap so operators
//     notice.
//   - Synthetic constituents inherit photo, gallery, sub-gallery
//     from the parent package row. They get a synthetic cartId
//     ("<parentCartId>-pkg-<sku>") and flags.isPackageItem = true
//     plus flags.packageParentCartId for traceability.
//   - If the package row's qty > 1 (rare), the constituent qty is
//     multiplied. Same photo though — Sytist doesn't track separate
//     photos per qty.
//
// We do this in a free function rather than a method on the service
// to keep it pure and easy to test. The caller supplies the resolved
// content map (so async config-loading happens once per query, not
// per line item).

function _expandPackageLineItems(lineItems, packageContentsMap) {
  if (!packageContentsMap) return lineItems;
  const out = [];
  for (const li of lineItems) {
    // Phase 39: Sytist's cart_package column turns out to be unreliable
    // — it's typically 0 even on rows that ARE packages (verified
    // across the dataset). So we no longer trust flags.package as
    // the trigger. Instead, the dashboard's Settings → Packages
    // config is the source of truth: if a line item's SKU has
    // entries in packageContentsMap, treat it as a package and
    // expand it.
    //
    // Trade-off: if an SKU is configured as a package but is later
    // sold standalone (an unusual case), this would still expand.
    // Operators control Settings → Packages, so the risk is low and
    // self-correctable. The previous behavior — trusting Sytist's
    // flag — silently failed to expand real packages, which is
    // strictly worse than this trade-off.
    const sytistFlaggedAsPackage = !!li.flags?.package;
    const sku = String(li.sku || '');
    const contents = sku ? packageContentsMap[sku] : null;
    const configuredAsPackage = !!(contents && contents.length > 0);

    if (!configuredAsPackage) {
      // Not a package by dashboard config. Pass through unchanged.
      // (Sytist's flag is no longer consulted; see comment above.)
      out.push(li);
      continue;
    }

    // Phase 39: log when we expand based on dashboard config alone
    // (Sytist's flag was missing). Makes the silent-failure case
    // observable: an admin scanning logs sees these and can verify
    // that Sytist's data really is what we think.
    if (!sytistFlaggedAsPackage) {
      console.warn(
        `[SytistDB] cart ${li.cartId} sku=${sku} (${li.productNameDisplay || 'unnamed'}): ` +
          `Sytist's cart_package=0 but SKU is configured as a package in dashboard ` +
          `settings. Expanding using dashboard config (${contents.length} constituents).`
      );
    }

    // Emit header: keep the original row but mark it.
    // Phase 39: also set flags.package = true (forces the Package
    // chip on the UI even when Sytist didn't flag it), and
    // packageExpansionSource so the UI can surface a banner about
    // config-driven expansion.
    out.push({
      ...li,
      flags: {
        ...li.flags,
        package: true,
        isPackageHeader: true,
        packageExpansionSource: sytistFlaggedAsPackage
          ? 'sytist_flag'
          : 'dashboard_config',
      },
    });
    // Emit synthetic constituents inheriting the parent's photo,
    // gallery, sub-gallery. cartId is a string so it never collides
    // with real numeric cart IDs.
    //
    // Phase 42 diagnostic: log the parent's green-screen state so we
    // can see if it propagates correctly to constituents. If the
    // parent has flags.greenScreen=true but its backgroundPhoto
    // resolved to null (e.g. ms_photos row missing for cart_photo_bg),
    // constituents inherit a broken state and Step 1.4 will skip them
    // silently. This log lets us catch that case at the source.
    if (li.flags?.greenScreen || li.backgroundPhoto) {
      console.log(
        `[SytistDB] Package cart ${li.cartId} sku=${li.sku} expansion: ` +
          `parent greenScreen=${!!li.flags?.greenScreen} ` +
          `parent backgroundPhoto=${li.backgroundPhoto ? 'present' : 'NULL'} ` +
          `parent bgFullUrl=${li.backgroundPhoto?.fullUrl ? 'set' : 'missing'} ` +
          `(propagating to ${contents.length} constituent${contents.length === 1 ? '' : 's'})`
      );
    }

    const packageQty = Math.max(1, li.qty || 1);
    for (const item of contents) {
      const itemQty = (item.qty || 1) * packageQty;
      // If the constituent is digital (per packaging-config's
      // productWeights.category), flag it as download so the
      // existing pipeline (processingService, packingSlipService)
      // skips it the same way an explicitly-ordered digital line
      // would be skipped. Without this, a Gold Package's bundled
      // Digital Download (SKU 25) would erroneously go through
      // imposition, composite, and darkroom .txt writes.
      const isDigital = item.category === 'digital';
      out.push({
        cartId: `${li.cartId}-pkg-${item.sku}`,
        productName: item.name || `SKU ${item.sku}`,
        productNameDisplay: deriveDisplayName(item.name || `SKU ${item.sku}`),
        sku: String(item.sku),
        qty: itemQty,
        price: 0, // bundled into parent package
        photoProductId: li.photoProductId, // inherit; pipeline doesn't
                                            // distinguish per constituent
        galleryId: li.galleryId,
        galleryName: li.galleryName,
        subGalleryId: li.subGalleryId,
        subGalleryName: li.subGalleryName,
        photo: li.photo,
        backgroundPhoto: li.backgroundPhoto,
        flags: {
          // Inherit workflow-relevant flags from parent (giftCert,
          // creditProduct, booking, preSell — all package-level
          // concepts that propagate to constituents).
          ...li.flags,
          // Per-constituent overrides:
          package: false, // the constituent itself isn't a package
          isPackageHeader: false,
          isPackageItem: true,
          packageParentCartId: li.cartId,
          packageParentSku: li.sku,
          // Phase 43 hotfix 1: download is determined ONLY by the
          // constituent's own SKU category, NOT inherited from the
          // parent package. The parent package may include a download
          // (e.g. Silver Package gives the customer one digital
          // download bonus) but that doesn't make the physical print
          // constituents (Memory Mate, 8x10, etc.) downloads too.
          // Inheriting would cause the packaging engine to skip the
          // whole order as "no shippable items" and the UI to show
          // misleading "Includes Download" badges on every line.
          download: isDigital,
        },
        options: [], // constituents have no per-line options
        thumbPath: li.thumbPath,
        notes: '',
      });
    }
  }
  return out;
}

// ─── Phase 15b: add-on explosion ──────────────────────────
//
// Sytist add-ons live in ms_cart_options rows attached to a parent
// ms_cart row. Each option has a co_opt_id (Sytist's identifier for
// the add-on type) and co_price (what the customer paid for the
// add-on). They're typically discounted "and one of these too" items:
// order a Memory Mate, add 2 Magnets for $8.49.
//
// Without explosion, the production pipeline never sees the add-on
// — the magnets don't get printed, the slip doesn't list them, the
// .txt file is silent. After explosion, each MAPPED add-on becomes
// a synthetic line item the existing pipeline handles naturally.
//
// Differences from package explosion:
//   - The PARENT line item is NOT skipped. It's a real product the
//     customer paid for and must be produced.
//   - The synthetic item gets its `price` from the add-on's co_price
//     (whereas package constituents are price=0 since the parent
//     carries the bundled price).
//   - The mapping is keyed by co_opt_id (Sytist option ID), not by
//     parent SKU.
//   - Options WITHOUT a mapping stay as text on the parent line's
//     options array — they still show on the slip/order detail as
//     informational text, just don't get expanded into producible
//     items.
//
// Synthetic constituent shape:
//   - cartId = "<parentCartId>-addon-<coId>"   (string)
//   - sku    = the mapping's sku
//   - qty    = 1                                (always)
//   - price  = the option's co_price
//   - photo / gallery / sub-gallery inherited from parent
//   - flags.isAddonItem = true
//   - flags.addonParentCartId = parent
//   - flags.addonOptId = co_opt_id
//   - flags.download = true if mapped SKU is digital (same digital-
//     skip story as package constituents)

function _expandAddonLineItems(lineItems, addonMap, productCategoriesBySku) {
  if (!addonMap || Object.keys(addonMap).length === 0) return lineItems;
  const out = [];
  for (const li of lineItems) {
    // Phase 15c: two kinds of add-on mappings:
    //
    //   product  — expands into a synthetic line item with sku+qty.
    //              Same as phase 15b behavior, now with qty support.
    //
    //   modifier — does NOT expand. Appends a suffix to the parent's
    //              productName so it flows through to slip + Darkroom
    //              .txt; also recorded in a parent-line modifiers[]
    //              array so the slip can highlight it visually.
    //
    // We process the parent line's options to build:
    //   1. parentModifiers — list of {name, suffix, price} that the
    //      slip/UI uses to render highlights
    //   2. parentSuffixes  — concatenated suffix text appended to
    //      productName so it shows on the .txt directly
    //   3. syntheticItems  — new line items for product-type mappings,
    //      emitted AFTER the (modified) parent

    if (!Array.isArray(li.options) || li.options.length === 0) {
      out.push(li);
      continue;
    }

    const parentModifiers = [];
    const parentSuffixes = [];
    const syntheticItems = [];

    for (const opt of li.options) {
      if (!opt.optId) continue;
      const mapping = addonMap[String(opt.optId)];
      if (!mapping) continue;

      if (mapping.type === 'modifier') {
        if (!mapping.suffix) continue; // half-configured; ignore
        parentSuffixes.push(mapping.suffix);
        parentModifiers.push({
          optId: String(opt.optId),
          name: mapping.name || opt.name || `Modifier ${opt.optId}`,
          suffix: mapping.suffix,
          price: Number(opt.price) || 0,
        });
        continue;
      }

      // product type (or legacy entry without explicit type)
      if (!mapping.sku) continue;
      const qty = Math.max(1, parseInt(mapping.qty, 10) || 1);
      const targetSku = String(mapping.sku);
      const category = productCategoriesBySku
        ? productCategoriesBySku[targetSku] || null
        : null;
      const isDigital = category === 'digital';
      syntheticItems.push({
        cartId: `${li.cartId}-addon-${opt.coId || opt.optId}`,
        productName: mapping.name || opt.name || `Add-on ${opt.optId}`,
        productNameDisplay: deriveDisplayName(
          mapping.name || opt.name || `Add-on ${opt.optId}`
        ),
        sku: targetSku,
        qty,
        price: opt.price || 0,
        photoProductId: li.photoProductId,
        galleryId: li.galleryId,
        galleryName: li.galleryName,
        subGalleryId: li.subGalleryId,
        subGalleryName: li.subGalleryName,
        photo: li.photo,
        backgroundPhoto: li.backgroundPhoto,
        flags: {
          ...li.flags,
          package: false,
          isPackageHeader: false,
          isPackageItem: false,
          isAddonItem: true,
          addonParentCartId: li.cartId,
          addonOptId: String(opt.optId),
          // Phase 43 hotfix 1: same fix as package constituents —
          // download is determined by the addon's own SKU category,
          // not inherited from the parent product.
          download: isDigital,
        },
        options: [], // synthetic items don't carry options
        thumbPath: li.thumbPath,
        notes: '',
      });
    }

    // Emit the (possibly modified) parent. We don't mutate the
    // original object — clone if there's anything to add. Otherwise
    // pass through by reference so callers can rely on identity.
    if (parentSuffixes.length > 0 || parentModifiers.length > 0) {
      const nextProductName = li.productName + parentSuffixes.join('');
      out.push({
        ...li,
        productName: nextProductName,
        // Phase 58c: re-derive display from the full suffixed string so
        // the sibling team-suffix (e.g. " (Team A)") appears in the
        // leaf alongside the product name — split on '>' is preserved
        // because suffixes never contain '>'.
        productNameDisplay: deriveDisplayName(nextProductName),
        modifiers: parentModifiers,
      });
    } else {
      out.push(li);
    }

    // Then the synthetic product-type addons
    for (const syn of syntheticItems) out.push(syn);
  }
  return out;
}

// ─── Photo URL assembly ───────────────────────────────────
//
// Photos live on S3. The full URL is:
//   https://{pic_amazon_endpoint}/{pic_bucket}/{pic_bucket_folder}/{filename}
// Where filename varies by size:
//   pic_full   — original (use this for production prints)
//   pic_large  — display size
//   pic_th     — thumbnail (use this for UI)
//
// When pic_amazon = 0 the photo is local to the Sytist server (rare in prod).
function buildPhotoUrls(photoRow) {
  if (!photoRow) return null;

  if (photoRow.pic_amazon !== 1) {
    // Non-S3 photo. Phase 4 needs to handle this; for Phase 2b we just flag it.
    return {
      isS3: false,
      originalFilename: photoRow.pic_org || '',
      width: photoRow.pic_width || 0,
      height: photoRow.pic_height || 0,
    };
  }

  const baseUrl = `https://${photoRow.pic_amazon_endpoint}/${photoRow.pic_bucket}/${photoRow.pic_bucket_folder}`;

  return {
    isS3: true,
    originalFilename: photoRow.pic_org || '',
    width: photoRow.pic_width || 0,
    height: photoRow.pic_height || 0,
    fullUrl: photoRow.pic_full ? `${baseUrl}/${photoRow.pic_full}` : null,
    largeUrl: photoRow.pic_large ? `${baseUrl}/${photoRow.pic_large}` : null,
    thumbUrl: photoRow.pic_th ? `${baseUrl}/${photoRow.pic_th}` : null,
  };
}

// ──────────────────────────────────────────────────────────

class SytistDbService {
  constructor() {
    this.pool = null;
    this._lastError = null;
  }

  init() {
    if (this.pool) return this.pool;

    const config = {
      host: process.env.SYTIST_DB_HOST,
      port: parseInt(process.env.SYTIST_DB_PORT || '3306', 10),
      user: process.env.SYTIST_DB_USER,
      password: process.env.SYTIST_DB_PASSWORD,
      database: process.env.SYTIST_DB_NAME,
      connectionLimit: 5,
      queueLimit: 0,
      waitForConnections: true,
      charset: 'utf8mb4',
      connectTimeout: 10_000,
      dateStrings: true,
    };

    if (!config.host || !config.user || !config.database) {
      throw new Error(
        'SYTIST_DB_HOST, SYTIST_DB_USER, and SYTIST_DB_NAME must be set in .env'
      );
    }

    this.pool = mysql.createPool(config);
    console.log(
      `[SytistDB] Pool created → ${config.user}@${config.host}:${config.port}/${config.database}`
    );
    return this.pool;
  }

  getPool() {
    if (!this.pool) this.init();
    return this.pool;
  }

  async healthCheck() {
    const pool = this.getPool();
    const start = Date.now();

    try {
      const [[ping]] = await pool.query('SELECT 1 AS ok');
      const [[ident]] = await pool.query(
        'SELECT DATABASE() AS db, VERSION() AS version, USER() AS user'
      );
      const elapsedMs = Date.now() - start;

      this._lastError = null;
      return {
        ok: ping.ok === 1,
        database: ident.db,
        version: ident.version,
        user: ident.user,
        elapsedMs,
      };
    } catch (err) {
      this._lastError = err;
      const safeMsg = String(err.message || err)
        .replace(/password=[^&\s]+/gi, 'password=***')
        .replace(/PASSWORD\s*=\s*'[^']*'/gi, "PASSWORD='***'");
      const wrapped = new Error(`Sytist DB health check failed: ${safeMsg}`);
      wrapped.code = err.code;
      throw wrapped;
    }
  }

  // ─── Lookup queries (Step 1) ───────────────────────────

  async getOrderStatuses() {
    const pool = this.getPool();
    const [rows] = await pool.query(
      `SELECT status_id, status_name, status_descr, status_show_order
       FROM ms_order_status
       ORDER BY status_show_order, status_name`
    );
    return rows.map((r) => ({
      id: r.status_id,
      name: r.status_name,
      description: r.status_descr || '',
      showOrder: r.status_show_order,
    }));
  }

  /**
   * Phase 38 follow-up: lightweight status_id → status_name lookup.
   * Used by ms_notes writers so audit entries can show "Printing
   * and Production" instead of just "40". Returns the friendly
   * name, or a fallback string ('Status N') if the lookup fails
   * or returns no row. Never throws — used in non-fatal note paths.
   */
  async getStatusName(statusId) {
    const id = parseInt(statusId, 10);
    if (Number.isNaN(id)) return String(statusId);
    if (id === 0) return STATUS_OPEN_NAME;
    try {
      const pool = this.getPool();
      const [[row]] = await pool.query(
        'SELECT status_name FROM ms_order_status WHERE status_id = ? LIMIT 1',
        [id]
      );
      if (row && row.status_name) return row.status_name;
      return `Status ${id}`;
    } catch (err) {
      console.warn(`[SytistDB] getStatusName(${id}) failed: ${err.message}`);
      return `Status ${id}`;
    }
  }

  async getGalleryHierarchy({ monthsBack = 18 } = {}) {
    const pool = this.getPool();
    const dateFilter =
      monthsBack > 0
        ? `AND o.order_date >= DATE_SUB(NOW(), INTERVAL ? MONTH)`
        : '';
    const dateParams = monthsBack > 0 ? [monthsBack] : [];

    const [galleries] = await pool.query(
      `
      SELECT
        cal.date_id        AS galleryId,
        cal.date_title     AS galleryName,
        cat.cat_id         AS categoryId,
        cat.cat_name       AS categoryName,
        COUNT(DISTINCT o.order_id) AS orderCount,
        MAX(o.order_date)  AS lastOrderDate
      FROM ms_calendar cal
      LEFT JOIN ms_blog_categories cat ON cat.cat_id = cal.date_cat
      INNER JOIN ms_cart c   ON c.cart_pic_date_id = cal.date_id
      INNER JOIN ms_orders o ON o.order_id = c.cart_order
      WHERE o.order_status = 0
        AND o.order_open_status = 0
        AND o.order_erased = 0
        AND o.order_payment_status = 'Completed'
        ${dateFilter}
      GROUP BY cal.date_id, cal.date_title, cat.cat_id, cat.cat_name
      ORDER BY MAX(o.order_date) DESC
      `,
      dateParams
    );

    if (galleries.length === 0) return [];

    const galleryIds = galleries.map((g) => g.galleryId);
    const [subRows] = await pool.query(
      `
      SELECT
        sub.sub_id          AS subId,
        sub.sub_date_id     AS galleryId,
        sub.sub_name        AS subName,
        COUNT(DISTINCT o.order_id) AS orderCount,
        MAX(o.order_date)   AS lastOrderDate
      FROM ms_sub_galleries sub
      INNER JOIN ms_cart c   ON c.cart_sub_gal_id = sub.sub_id
      INNER JOIN ms_orders o ON o.order_id = c.cart_order
      WHERE sub.sub_date_id IN (?)
        AND o.order_status = 0
        AND o.order_open_status = 0
        AND o.order_erased = 0
        AND o.order_payment_status = 'Completed'
        ${dateFilter}
      GROUP BY sub.sub_id, sub.sub_date_id, sub.sub_name
      ORDER BY sub.sub_name
      `,
      [galleryIds, ...dateParams]
    );

    const subsByGallery = new Map();
    for (const s of subRows) {
      const list = subsByGallery.get(s.galleryId) || [];
      list.push({
        subId: s.subId,
        subName: s.subName,
        orderCount: Number(s.orderCount),
        lastOrderDate: s.lastOrderDate,
      });
      subsByGallery.set(s.galleryId, list);
    }

    return galleries.map((g) => ({
      galleryId: g.galleryId,
      galleryName: g.galleryName,
      categoryId: g.categoryId,
      categoryName: g.categoryName,
      orderCount: Number(g.orderCount),
      lastOrderDate: g.lastOrderDate,
      subGalleries: subsByGallery.get(g.galleryId) || [],
    }));
  }

  // ─── Order queries (Step 2) ────────────────────────────

  /**
   * Returns an array of canonical-shaped orders matching the given filter.
   *
   * Strategy: three queries (orders → cart lines → cart options) joined in JS
   * to avoid Cartesian explosion. Cart vs cart_archive handled via UNION ALL
   * with the order_archive_table flag matching the right table.
   *
   * Options:
   *   workflow         — 'ship_to_home' | 'ship_to_managers' | 'ship_to_league' | 'all' (default 'all')
   *   productionStatus — number | 'all' (default 0 = "Queue")
   *   limit            — pagination size (default 50, max 1000)
   *   offset           — pagination offset (default 0)
   *   galleryId        — optional ms_calendar.date_id filter
   *   subGalleryId     — optional ms_sub_galleries.sub_id filter
   *
   * Returns:
   *   { orders: [...], total: number, elapsedMs: number }
   */
  async getOrdersByWorkflow(opts = {}) {
    const {
      workflow = 'all',
      productionStatus = 0,
      limit = 50,
      offset = 0,
      galleryId = null,
      subGalleryId = null,
      shippingOption = null,
      sort = 'date_asc',  // 'date_asc' (oldest first) | 'date_desc' (newest first)
    } = opts;

    const pool = this.getPool();
    const start = Date.now();

    // ─── Build the shared WHERE clause ─────────────────────
    //
    // Phase 14a fix: workflow filter must happen in SQL so that LIMIT
    // and OFFSET work correctly. Previously this filter ran in JS
    // AFTER the LIMITed result was already returned, which meant:
    //   (1) Asking for ship_to_home with default LIMIT 50 would
    //       fetch 50 orders of ANY workflow, then keep only the
    //       ship_to_home ones — usually far fewer than 50.
    //   (2) `total` reported `orders.length` (post-JS-filter), so
    //       the UI couldn't tell how many ship_to_home orders
    //       actually existed.
    //
    // The fix uses the SHIPPING_MAP option-name lists to build an
    // IN(...) predicate, plus a numeric-cost predicate for the
    // uncategorized fallback path (matching categorizeShipping's
    // n>1.01 / n===1.0 / n<=0.99 buckets exactly).
    const where = [
      "o.order_payment_status = 'Completed'",
      'o.order_status = 0',
      'o.order_erased = 0',
    ];
    const params = [];

    if (productionStatus !== 'all') {
      where.push('o.order_open_status = ?');
      params.push(productionStatus);
    }

    if (shippingOption) {
      where.push('o.order_shipping_option = ?');
      params.push(shippingOption);
    }

    // Phase 60: digital-only orders divert from the league fallback to the
    // 'digital' bucket. The predicate and the isDigitalOnly SELECT column
    // below both use this list, so they classify identically.
    const digitalSkuList = _loadDigitalSkuList();

    // Workflow filter — in SQL now (Phase 14a fix).
    if (workflow !== 'all') {
      const wfPredicate = _buildWorkflowSqlPredicate(workflow, digitalSkuList);
      if (wfPredicate) {
        where.push(wfPredicate.sql);
        params.push(...wfPredicate.params);
      }
    }

    // Gallery filter requires a join to ms_cart, so we use EXISTS to avoid
    // duplicating order rows.
    if (galleryId) {
      where.push(
        '(EXISTS (SELECT 1 FROM ms_cart c WHERE c.cart_order = o.order_id AND c.cart_pic_date_id = ?)' +
          ' OR EXISTS (SELECT 1 FROM ms_cart_archive ca WHERE ca.cart_order = o.order_id AND ca.cart_pic_date_id = ?))'
      );
      params.push(galleryId, galleryId);
    }
    if (subGalleryId) {
      where.push(
        '(EXISTS (SELECT 1 FROM ms_cart c WHERE c.cart_order = o.order_id AND c.cart_sub_gal_id = ?)' +
          ' OR EXISTS (SELECT 1 FROM ms_cart_archive ca WHERE ca.cart_order = o.order_id AND ca.cart_sub_gal_id = ?))'
      );
      params.push(subGalleryId, subGalleryId);
    }

    const limitSafe = Math.max(1, Math.min(parseInt(limit, 10) || 50, 1000));
    const offsetSafe = Math.max(0, parseInt(offset, 10) || 0);

    // Sort: only two options for now. Default ASC (oldest first) since the
    // operator workflow is "process older orders first".
    const orderByClause =
      sort === 'date_desc' ? 'o.order_date DESC' : 'o.order_date ASC';

    // ─── Query 0: TRUE total matching the filters ──────────
    //
    // Counts orders that match the full WHERE clause (now including
    // workflow). Used by the UI to render "Showing X-Y of Z" so
    // operators can see how many pages remain.
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM ms_orders o WHERE ${where.join(' AND ')}`,
      params
    );
    const totalMatching = Number(countRows[0]?.total || 0);

    // ─── Query 1: orders matching base filter ──────────────
    // Phase 60: isDigitalOnly is computed via the SAME physical-item SQL
    // the workflow predicate uses, so the row's badge (set from this
    // column) and the workflow filter never disagree.
    const [orderRows] = await pool.query(
      `
      SELECT
        o.*,
        st.status_name AS productionStatusName,
        (NOT ${_physicalItemExistsSql(digitalSkuList)}) AS isDigitalOnly
      FROM ms_orders o
      LEFT JOIN ms_order_status st ON st.status_id = o.order_open_status
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderByClause}
      LIMIT ? OFFSET ?
      `,
      [...params, limitSafe, offsetSafe]
    );

    if (orderRows.length === 0) {
      return { orders: [], total: totalMatching, elapsedMs: Date.now() - start };
    }

    // Workflow categorization is still applied in JS for the canonical
    // shape (each order's `shipping.workflow` field). The SQL filter
    // above ensures LIMIT/OFFSET respect the workflow, but the
    // per-order categorization still needs to run so each returned
    // order carries its workflow tag.
    const orderRowsByWorkflow = orderRows;

    if (orderRowsByWorkflow.length === 0) {
      return { orders: [], total: 0, elapsedMs: Date.now() - start };
    }

    const orderIds = orderRowsByWorkflow.map((r) => r.order_id);

    // Phase 15a: load package contents map once for the whole query.
    // Each order's lineItems build will consult this when expanding
    // package rows into their constituent items.
    // Phase 15b: also load the addon mappings here. Both maps are
    // singleton-cached so this is cheap.
    const { packageContentsMap, productCategoriesBySku } =
      await this._loadPackageMap();
    const { addonMap } = await this._loadAddonMap();

    // Phase 60a: load productWeights once for the whole page and build the
    // synchronous instant-pack predicates. Loaded independently of
    // _loadPackageMap (which short-circuits when no packages are configured)
    // so eligibility is computed for every order, package or not. Empty map
    // on failure → default-deny → no order shows the badge (safe).
    let instantPackPredicates = _makePackagingPredicates({});
    try {
      const productWeights = await require('./packagingService').getProductWeights();
      instantPackPredicates = _makePackagingPredicates(productWeights);
    } catch (e) {
      console.warn(`[SytistDB] instant-pack predicates unavailable (default-deny): ${e.message}`);
    }

    // ─── Query 2: cart lines for those orders ──────────────
    //
    // UNION ALL across ms_cart and ms_cart_archive. Only orders with
    // order_archive_table = 1 will have lines in archive; the WHERE clauses
    // ensure we don't double-fetch.
    const archiveOrderIds = orderRowsByWorkflow
      .filter((r) => r.order_archive_table === 1)
      .map((r) => r.order_id);
    const liveOrderIds = orderRowsByWorkflow
      .filter((r) => r.order_archive_table !== 1)
      .map((r) => r.order_id);

    const cartUnionSql = [];
    const cartUnionParams = [];

    if (liveOrderIds.length > 0) {
      cartUnionSql.push(`
        SELECT
          c.cart_id, c.cart_order,
          c.cart_product_name, c.cart_sku, c.cart_qty, c.cart_price,
          c.cart_photo_prod, c.cart_photo_prod_connect,
          c.cart_pic_id, c.cart_pic_org,
          c.cart_pic_date_id, c.cart_pic_date_org,
          c.cart_sub_gal_id,
          c.cart_download, c.cart_package, c.cart_gift_certificate,
          c.cart_credit_product, c.cart_booking, c.cart_photo_bg,
          c.cart_pre_sell, c.cart_pre_sold, c.cart_pre_sold_gallery,
          c.cart_pre_register_id,
          c.cart_thumb, c.cart_notes,
          c.cart_frame_size, c.cart_canvas_id,
          0 AS fromArchive
        FROM ms_cart c
        WHERE c.cart_order IN (?)
      `);
      cartUnionParams.push(liveOrderIds);
    }

    if (archiveOrderIds.length > 0) {
      cartUnionSql.push(`
        SELECT
          ca.cart_id, ca.cart_order,
          ca.cart_product_name, ca.cart_sku, ca.cart_qty, ca.cart_price,
          ca.cart_photo_prod, ca.cart_photo_prod_connect,
          ca.cart_pic_id, ca.cart_pic_org,
          ca.cart_pic_date_id, ca.cart_pic_date_org,
          ca.cart_sub_gal_id,
          ca.cart_download, ca.cart_package, ca.cart_gift_certificate,
          ca.cart_credit_product, ca.cart_booking, ca.cart_photo_bg,
          ca.cart_pre_sell, ca.cart_pre_sold, ca.cart_pre_sold_gallery,
          ca.cart_pre_register_id,
          ca.cart_thumb, ca.cart_notes,
          ca.cart_frame_size, ca.cart_canvas_id,
          1 AS fromArchive
        FROM ms_cart_archive ca
        WHERE ca.cart_order IN (?)
      `);
      cartUnionParams.push(archiveOrderIds);
    }

    const [cartRows] = await pool.query(
      cartUnionSql.join(' UNION ALL ') +
        ' ORDER BY cart_order, cart_id',
      cartUnionParams
    );

    // ─── Query 3: photos referenced by cart lines ──────────
    // Phase 10: also pull background photos referenced via
    // cart_photo_bg. Same ms_photos table, same query — just
    // expand the IN list to include both pic IDs. One round trip.
    const picIds = [
      ...new Set([
        ...cartRows.map((r) => r.cart_pic_id).filter((id) => id > 0),
        ...cartRows.map((r) => r.cart_photo_bg).filter((id) => id > 0),
      ]),
    ];
    let photosById = new Map();
    if (picIds.length > 0) {
      const [photoRows] = await pool.query(
        `
        SELECT
          pic_id, pic_org, pic_full, pic_large, pic_th,
          pic_amazon, pic_amazon_endpoint, pic_bucket, pic_bucket_folder,
          pic_width, pic_height
        FROM ms_photos
        WHERE pic_id IN (?)
        `,
        [picIds]
      );
      photosById = new Map(photoRows.map((p) => [p.pic_id, p]));
    }

    // ─── Query 4: sub-galleries referenced by cart lines ───
    const subIds = [
      ...new Set(cartRows.map((r) => r.cart_sub_gal_id).filter((id) => id > 0)),
    ];
    let subsById = new Map();
    if (subIds.length > 0) {
      const [subRows] = await pool.query(
        `
        SELECT sub_id, sub_name
        FROM ms_sub_galleries
        WHERE sub_id IN (?)
        `,
        [subIds]
      );
      subsById = new Map(subRows.map((s) => [s.sub_id, s.sub_name]));
    }

    // ─── Query 5: cart options for cart lines ──────────────
    const cartIdsList = cartRows.map((r) => r.cart_id);
    let optionsByCartId = new Map();
    if (cartIdsList.length > 0) {
      const [optRows] = await pool.query(
        `
        SELECT co_id, co_cart_id, co_opt_id, co_opt_name, co_select_name, co_price
        FROM ms_cart_options
        WHERE co_cart_id IN (?)
        ORDER BY co_id
        `,
        [cartIdsList]
      );
      for (const o of optRows) {
        const list = optionsByCartId.get(o.co_cart_id) || [];
        list.push({
          // Phase 15b: include co_id and co_opt_id so the addon
          // explosion can synthesize unique cartIds and look up
          // option mappings. Existing consumers of `options` only
          // read name/selectedValue/price so adding fields is safe.
          coId: o.co_id,
          optId: o.co_opt_id != null ? String(o.co_opt_id) : null,
          name: o.co_opt_name || '',
          selectedValue: o.co_select_name || '',
          price: Number(o.co_price) || 0,
        });
        optionsByCartId.set(o.co_cart_id, list);
      }
    }

    // ─── Stitch into canonical shape ───────────────────────
    const cartByOrderId = new Map();
    for (const c of cartRows) {
      const list = cartByOrderId.get(c.cart_order) || [];
      list.push(c);
      cartByOrderId.set(c.cart_order, list);
    }

    const orders = orderRowsByWorkflow.map((o) => {
      const lines = cartByOrderId.get(o.order_id) || [];

      const lineItems = lines.map((c) => {
        const photoRow = c.cart_pic_id > 0 ? photosById.get(c.cart_pic_id) : null;
        // Phase 10: pull the background photo when cart_photo_bg points
        // at a real ms_photos row. Same shape as `photo`, just a
        // separate field on the line item. processingService picks this
        // up for layouts that have a `playerBackground` slot.
        const bgPhotoRow =
          c.cart_photo_bg > 0 ? photosById.get(c.cart_photo_bg) : null;
        return {
          cartId: c.cart_id,
          productName: c.cart_product_name || '',
          productNameDisplay: deriveDisplayName(c.cart_product_name || ''),
          sku: c.cart_sku || '',
          qty: Number(c.cart_qty) || 0,
          price: Number(c.cart_price) || 0,
          photoProductId: c.cart_photo_prod || 0,

          galleryId: c.cart_pic_date_id || 0,
          galleryName: c.cart_pic_date_org || '',
          subGalleryId: c.cart_sub_gal_id || 0,
          subGalleryName:
            c.cart_sub_gal_id > 0
              ? subsById.get(c.cart_sub_gal_id) || ''
              : '',

          photo: photoRow
            ? buildPhotoUrls({
                ...photoRow,
                pic_id: c.cart_pic_id,
              })
            : null,

          backgroundPhoto: bgPhotoRow
            ? buildPhotoUrls({
                ...bgPhotoRow,
                pic_id: c.cart_photo_bg,
              })
            : null,

          flags: {
            download: c.cart_download === 1,
            package: c.cart_package > 0,
            giftCert: c.cart_gift_certificate === 1,
            creditProduct: c.cart_credit_product > 0,
            booking: c.cart_booking > 0,
            greenScreen: c.cart_photo_bg > 0,
            framed: c.cart_frame_size > 0,
            canvas: c.cart_canvas_id > 0,
            preSell: c.cart_pre_sell === 1,
            preSold: c.cart_pre_sold === 1,
            // Phase 64: pre-registration placeholder line (Sytist
            // cart_pre_register_id > 0). No SKU, no photo, $0 — not a
            // printable/shippable product. It carries NO other skip-flag, so
            // without this it false-blocked the fail-closed gate as a
            // "printable item with no photo" (order 112376). Treated as a
            // skip-flag everywhere booking/preSell are.
            preRegister: c.cart_pre_register_id > 0,
            fromArchive: c.fromArchive === 1,
          },

          options: optionsByCartId.get(c.cart_id) || [],

          thumbPath: c.cart_thumb || '',
          notes: c.cart_notes || '',
        };
      });

      // Phase 15a: expand package rows into their constituent items.
      // No-op if packageContentsMap is null (no config) or if no line
      // has flags.package true.
      const packageExpanded = _expandPackageLineItems(
        lineItems,
        packageContentsMap
      );

      // Phase 15b: expand add-on options (ms_cart_options) into
      // synthetic line items so the production pipeline materializes
      // them. Runs AFTER package expansion so package constituents
      // (which have options: []) are correctly no-op'd, and so that
      // an add-on attached to a regular line item still expands. Add-
      // ons attached to a package row itself currently expand too —
      // unusual but allowed; the operator will see them as items
      // hanging off the package header.
      const expandedLineItems = _expandAddonLineItems(
        packageExpanded,
        addonMap,
        productCategoriesBySku
      );

      // Order-level gallery: take the first cart line's gallery as primary.
      // Sibling detection: distinct sub-galleries across lines.
      const distinctSubGalleries = new Set(
        expandedLineItems
          .map((li) => li.subGalleryId)
          .filter((id) => id > 0)
      );
      const isSibling = distinctSubGalleries.size > 1;

      const primaryGallery =
        expandedLineItems.find((li) => li.galleryId > 0) || null;

      const shipping = categorizeShipping(
        o.order_shipping_option,
        o.order_shipping,
        !!o.isDigitalOnly
      );

      // Phase 60a: instant-pack eligibility over the expanded line items.
      const instantPack = _computeInstantPackEligibility(
        expandedLineItems,
        instantPackPredicates
      );

      return {
        source: 'sytist',
        orderId: String(o.order_id),
        orderNumber: String(o.order_id),
        orderDate: o.order_date,
        paymentStatus: o.order_payment_status,
        productionStatus: {
          id: o.order_open_status || 0,
          name: o.productionStatusName || (o.order_open_status === 0 ? STATUS_OPEN_NAME : ''),
        },
        orderStatus: o.order_status,
        orderArchiveTable: o.order_archive_table === 1,

        customer: {
          firstName: o.order_first_name || '',
          lastName: o.order_last_name || '',
          email: o.order_email || '',
          phone: o.order_phone || '',
          businessName: o.order_business_name || '',
        },

        shipTo: {
          firstName: o.order_ship_first_name || '',
          lastName: o.order_ship_last_name || '',
          address1: o.order_ship_address || '',
          address2: o.order_ship_addres_2 || '',
          city: o.order_ship_city || '',
          state: o.order_ship_state || '',
          zip: o.order_ship_zip || '',
          country: o.order_ship_country || '',
          phone: o.order_phone || '',
          businessName: o.order_ship_business || '',
        },

        shipping: {
          cost: Number(o.order_shipping) || 0,
          optionName: o.order_shipping_option || '',
          workflow: shipping.workflow,
          uncategorized: shipping.uncategorized,
        },

        totals: {
          subtotal: Number(o.order_sub_total) || 0,
          tax: Number(o.order_tax) || 0,
          total: Number(o.order_total) || 0,
          paymentFee: Number(o.order_payment_fee) || 0,
        },

        subject: {
          fields: normalizeSubjectFields(o),
        },

        galleryId: primaryGallery ? primaryGallery.galleryId : 0,
        galleryName: primaryGallery ? primaryGallery.galleryName : '',
        subGalleryId: primaryGallery ? primaryGallery.subGalleryId : 0,
        subGalleryName: primaryGallery ? primaryGallery.subGalleryName : '',

        lineItems: expandedLineItems,
        isSibling,
        // Phase 60a: display-only badge driven from packaging-config's
        // per-SKU instantPackEligible flag (default-deny). No SQL filter
        // tab in 60a, so this is computed purely in JS here.
        isInstantPackEligible: instantPack.eligible,

        dueDate:
          o.order_due_date && o.order_due_date !== '0000-00-00'
            ? o.order_due_date
            : null,
        customerNotes: o.order_notes || '',
        adminNotes: o.order_admin_notes || '',

        cardLastFour: o.order_card_last_four || '',
        payType: o.order_pay_type || '',
      };
    });

    return {
      orders,
      // Phase 14a fix: report the SQL COUNT(*) of the filtered set,
      // not orders.length. orders.length is just the page size; the
      // UI needs the absolute total to render "X-Y of Z" and decide
      // whether to enable the Next button.
      total: totalMatching,
      pageSize: orders.length,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Phase 14b: find the previous + next order IDs for a given order
   * within a filtered/sorted set. Powers the Prev/Next navigation on
   * the order detail page.
   *
   * Takes the same filter options as getOrdersByWorkflow (workflow,
   * productionStatus, galleryId, subGalleryId, shippingOption, sort)
   * PLUS the current orderId. Returns:
   *   {
   *     previousOrderId: string|null,  // null at first row
   *     nextOrderId: string|null,      // null at last row
   *     position: number,              // 1-based index in filtered set
   *     total: number,                 // total in filtered set
   *   }
   *
   * If the current order is OUTSIDE the filter (e.g. operator filters
   * to ship_to_home but the detail page is a ship_to_managers order),
   * position = 0 and both prev/next return null. The UI should handle
   * that as "not in this list" — the operator may want to clear
   * filters.
   *
   * Implementation: rather than fetching all IDs and finding adjacents
   * in JS, we run three small SQL queries:
   *   1. Look up the anchor's (date, order_id) tuple to know "where
   *      we are in the sort order"
   *   2. SELECT * WHERE filters AND (date,id) > anchor LIMIT 1 → next
   *   3. SELECT * WHERE filters AND (date,id) < anchor LIMIT 1 → prev
   *   4. COUNT(*) + COUNT(* WHERE before anchor) → position + total
   *
   * Stable tiebreaker: orders with the same order_date are tied. We
   * break ties with order_id so the navigation is deterministic.
   * Direction of tiebreaker flips with sort (asc vs desc).
   */
  async getOrderNeighbors(orderId, opts = {}) {
    const {
      workflow = 'all',
      productionStatus = 'all',  // detail-page default: all statuses
      galleryId = null,
      subGalleryId = null,
      shippingOption = null,
      sort = 'date_asc',
    } = opts;

    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('Invalid order ID');
    }

    const pool = this.getPool();
    const isDesc = sort === 'date_desc';

    // Build the same WHERE clause as getOrdersByWorkflow. We need the
    // base filters (paid/non-erased/order_status=0) regardless — they
    // define what "the list" even is. Same shape, just refactored from
    // the inlined version above. This duplication is intentional: any
    // future filter added to getOrdersByWorkflow must be added here
    // too, and the SQL stays straightforward.
    const baseWhere = [
      "o.order_payment_status = 'Completed'",
      'o.order_status = 0',
      'o.order_erased = 0',
    ];
    const baseParams = [];

    if (productionStatus !== 'all') {
      baseWhere.push('o.order_open_status = ?');
      baseParams.push(productionStatus);
    }
    if (shippingOption) {
      baseWhere.push('o.order_shipping_option = ?');
      baseParams.push(shippingOption);
    }
    if (workflow !== 'all') {
      // Phase 60: same digital-aware predicate as the list query, so
      // next/prev navigation stays consistent with the filtered list.
      const wfPred = _buildWorkflowSqlPredicate(workflow, _loadDigitalSkuList());
      if (wfPred) {
        baseWhere.push(wfPred.sql);
        baseParams.push(...wfPred.params);
      }
    }
    if (galleryId) {
      baseWhere.push(
        '(EXISTS (SELECT 1 FROM ms_cart c WHERE c.cart_order = o.order_id AND c.cart_pic_date_id = ?)' +
          ' OR EXISTS (SELECT 1 FROM ms_cart_archive ca WHERE ca.cart_order = o.order_id AND ca.cart_pic_date_id = ?))'
      );
      baseParams.push(galleryId, galleryId);
    }
    if (subGalleryId) {
      baseWhere.push(
        '(EXISTS (SELECT 1 FROM ms_cart c WHERE c.cart_order = o.order_id AND c.cart_sub_gal_id = ?)' +
          ' OR EXISTS (SELECT 1 FROM ms_cart_archive ca WHERE ca.cart_order = o.order_id AND ca.cart_sub_gal_id = ?))'
      );
      baseParams.push(subGalleryId, subGalleryId);
    }

    const baseWhereSql = baseWhere.join(' AND ');

    // ─── 1. Anchor lookup ──────────────────────────────────
    //
    // We need (order_date, order_id) of the current order so we can
    // compare against it in the prev/next queries. We DON'T require
    // the anchor to be in the filtered set — operators can click into
    // a ship_to_managers order from elsewhere even if their list was
    // filtered to ship_to_home. In that case position=0 and both
    // neighbors come back null.
    const [anchorRows] = await pool.query(
      `SELECT order_id, order_date FROM ms_orders WHERE order_id = ? AND order_erased = 0 LIMIT 1`,
      [id]
    );
    if (anchorRows.length === 0) {
      return {
        previousOrderId: null,
        nextOrderId: null,
        position: 0,
        total: 0,
      };
    }
    const anchorDate = anchorRows[0].order_date;
    const anchorId = anchorRows[0].order_id;

    // ─── 2. Total in filtered set ─────────────────────────
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM ms_orders o WHERE ${baseWhereSql}`,
      baseParams
    );
    const total = Number(totalRows[0]?.total || 0);

    // ─── 3. Is the anchor IN the filtered set? ────────────
    //
    // If not, return null neighbors with position=0. The UI shows
    // a "this order isn't in your filtered list" note in that case.
    const [inSetRows] = await pool.query(
      `SELECT 1 FROM ms_orders o WHERE ${baseWhereSql} AND o.order_id = ? LIMIT 1`,
      [...baseParams, id]
    );
    if (inSetRows.length === 0) {
      return {
        previousOrderId: null,
        nextOrderId: null,
        position: 0,
        total,
      };
    }

    // ─── 4. Position (1-based index of anchor in the set) ─
    //
    // Count how many rows come BEFORE the anchor in the chosen sort
    // order. Position is that count + 1.
    //   asc: rows with (date < anchorDate) OR (date == anchorDate AND id < anchorId)
    //   desc: rows with (date > anchorDate) OR (date == anchorDate AND id < anchorId)
    // The id-tiebreaker direction stays consistent (ASC) regardless
    // of date direction — pick one and stick with it.
    const beforePredicate = isDesc
      ? '(o.order_date > ? OR (o.order_date = ? AND o.order_id < ?))'
      : '(o.order_date < ? OR (o.order_date = ? AND o.order_id < ?))';
    // 'before' is a reserved word in MySQL — must alias with backticks
    // or pick a non-reserved name. Going with the latter.
    const [beforeRows] = await pool.query(
      `SELECT COUNT(*) AS before_count FROM ms_orders o WHERE ${baseWhereSql} AND ${beforePredicate}`,
      [...baseParams, anchorDate, anchorDate, anchorId]
    );
    const position = Number(beforeRows[0]?.before_count || 0) + 1;

    // ─── 5. Next neighbor ──────────────────────────────────
    //
    // First row strictly after the anchor in sort order.
    //   asc: date > anchorDate OR (date == anchorDate AND id > anchorId)
    //   desc: date < anchorDate OR (date == anchorDate AND id > anchorId)
    const nextPredicate = isDesc
      ? '(o.order_date < ? OR (o.order_date = ? AND o.order_id > ?))'
      : '(o.order_date > ? OR (o.order_date = ? AND o.order_id > ?))';
    const nextOrderBy = isDesc
      ? 'o.order_date DESC, o.order_id ASC'
      : 'o.order_date ASC, o.order_id ASC';
    const [nextRows] = await pool.query(
      `SELECT o.order_id FROM ms_orders o WHERE ${baseWhereSql} AND ${nextPredicate} ORDER BY ${nextOrderBy} LIMIT 1`,
      [...baseParams, anchorDate, anchorDate, anchorId]
    );
    const nextOrderId = nextRows[0] ? String(nextRows[0].order_id) : null;

    // ─── 6. Previous neighbor ─────────────────────────────
    //
    // First row strictly before the anchor. Sort order flips so the
    // closest predecessor comes first.
    const prevPredicate = isDesc
      ? '(o.order_date > ? OR (o.order_date = ? AND o.order_id < ?))'
      : '(o.order_date < ? OR (o.order_date = ? AND o.order_id < ?))';
    const prevOrderBy = isDesc
      ? 'o.order_date ASC, o.order_id DESC'
      : 'o.order_date DESC, o.order_id DESC';
    const [prevRows] = await pool.query(
      `SELECT o.order_id FROM ms_orders o WHERE ${baseWhereSql} AND ${prevPredicate} ORDER BY ${prevOrderBy} LIMIT 1`,
      [...baseParams, anchorDate, anchorDate, anchorId]
    );
    const previousOrderId = prevRows[0] ? String(prevRows[0].order_id) : null;

    return {
      previousOrderId,
      nextOrderId,
      position,
      total,
    };
  }

  /**
   * Returns a single canonical-shaped order, or null if not found.
   *
   * Uses the same stitching logic as getOrdersByWorkflow but filters down to
   * a single order ID. Bypasses the workflow filter (returns the order even
   * if its workflow is something we don't normally show).
   *
   * Pagination/status filters are also bypassed — we want this exact order
   * regardless of whether it's open, archived, or in any production status.
   */
  async getOrderById(orderId) {
    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('Invalid order ID');
    }

    const pool = this.getPool();

    // Single-order query — bypass the open/paid filters since the caller
    // explicitly asked for THIS order, whatever state it's in.
    // Phase 60: isDigitalOnly via the same physical-item SQL the list +
    // counts use, so the detail-page workflow badge agrees with the list.
    const [orderRows] = await pool.query(
      `
      SELECT
        o.*,
        st.status_name AS productionStatusName,
        (NOT ${_physicalItemExistsSql(_loadDigitalSkuList())}) AS isDigitalOnly
      FROM ms_orders o
      LEFT JOIN ms_order_status st ON st.status_id = o.order_open_status
      WHERE o.order_id = ?
        AND o.order_erased = 0
      LIMIT 1
      `,
      [id]
    );

    if (orderRows.length === 0) return null;

    // Reuse the multi-order pipeline by calling getOrdersByWorkflow with a
    // filter that matches just this one order... actually no, easier to just
    // assemble inline. The cart/photo/options query logic is identical but
    // for a single ID we can simplify.
    //
    // Implementation note: rather than duplicate the stitching logic, we
    // shortcut by going through getOrdersByWorkflow with productionStatus
    // = 'all' AND a fake workflow that matches everything. But filtering
    // by orderId isn't currently a parameter. So we duplicate the stitching
    // here. The duplication is a real cost but keeps each method clean.

    const o = orderRows[0];

    // Cart lines from correct table.
    const fromArchive = o.order_archive_table === 1;
    const cartTable = fromArchive ? 'ms_cart_archive' : 'ms_cart';
    const cartAlias = fromArchive ? 'ca' : 'c';

    const [cartRows] = await pool.query(
      `
      SELECT
        ${cartAlias}.cart_id, ${cartAlias}.cart_order,
        ${cartAlias}.cart_product_name, ${cartAlias}.cart_sku, ${cartAlias}.cart_qty, ${cartAlias}.cart_price,
        ${cartAlias}.cart_photo_prod, ${cartAlias}.cart_photo_prod_connect,
        ${cartAlias}.cart_pic_id, ${cartAlias}.cart_pic_org,
        ${cartAlias}.cart_pic_date_id, ${cartAlias}.cart_pic_date_org,
        ${cartAlias}.cart_sub_gal_id,
        ${cartAlias}.cart_download, ${cartAlias}.cart_package, ${cartAlias}.cart_gift_certificate,
        ${cartAlias}.cart_credit_product, ${cartAlias}.cart_booking, ${cartAlias}.cart_photo_bg,
        ${cartAlias}.cart_pre_sell, ${cartAlias}.cart_pre_sold, ${cartAlias}.cart_pre_sold_gallery,
        ${cartAlias}.cart_pre_register_id,
        ${cartAlias}.cart_thumb, ${cartAlias}.cart_notes,
        ${cartAlias}.cart_frame_size, ${cartAlias}.cart_canvas_id,
        ${fromArchive ? 1 : 0} AS fromArchive
      FROM ${cartTable} ${cartAlias}
      WHERE ${cartAlias}.cart_order = ?
      ORDER BY ${cartAlias}.cart_id
      `,
      [id]
    );

    // Photos.
    // Phase 10: include both player and background pic IDs.
    const picIds = [
      ...new Set([
        ...cartRows.map((r) => r.cart_pic_id).filter((p) => p > 0),
        ...cartRows.map((r) => r.cart_photo_bg).filter((p) => p > 0),
      ]),
    ];
    let photosById = new Map();
    if (picIds.length > 0) {
      const [photoRows] = await pool.query(
        `
        SELECT
          pic_id, pic_org, pic_full, pic_large, pic_th,
          pic_amazon, pic_amazon_endpoint, pic_bucket, pic_bucket_folder,
          pic_width, pic_height
        FROM ms_photos
        WHERE pic_id IN (?)
        `,
        [picIds]
      );
      photosById = new Map(photoRows.map((p) => [p.pic_id, p]));
    }

    // Sub-galleries.
    const subIds = [
      ...new Set(cartRows.map((r) => r.cart_sub_gal_id).filter((sid) => sid > 0)),
    ];
    let subsById = new Map();
    if (subIds.length > 0) {
      const [subRows] = await pool.query(
        `SELECT sub_id, sub_name FROM ms_sub_galleries WHERE sub_id IN (?)`,
        [subIds]
      );
      subsById = new Map(subRows.map((s) => [s.sub_id, s.sub_name]));
    }

    // Cart options.
    const cartIdsList = cartRows.map((r) => r.cart_id);
    let optionsByCartId = new Map();
    if (cartIdsList.length > 0) {
      const [optRows] = await pool.query(
        `
        SELECT co_id, co_cart_id, co_opt_id, co_opt_name, co_select_name, co_price
        FROM ms_cart_options
        WHERE co_cart_id IN (?)
        ORDER BY co_id
        `,
        [cartIdsList]
      );
      for (const op of optRows) {
        const list = optionsByCartId.get(op.co_cart_id) || [];
        list.push({
          // Phase 15b: include co_id and co_opt_id (see getOrdersByWorkflow)
          coId: op.co_id,
          optId: op.co_opt_id != null ? String(op.co_opt_id) : null,
          name: op.co_opt_name || '',
          selectedValue: op.co_select_name || '',
          price: Number(op.co_price) || 0,
        });
        optionsByCartId.set(op.co_cart_id, list);
      }
    }

    // Stitch line items.
    const lineItems = cartRows.map((c) => {
      const photoRow = c.cart_pic_id > 0 ? photosById.get(c.cart_pic_id) : null;
      // Phase 10: background photo (cart_photo_bg → ms_photos)
      const bgPhotoRow =
        c.cart_photo_bg > 0 ? photosById.get(c.cart_photo_bg) : null;
      return {
        cartId: c.cart_id,
        productName: c.cart_product_name || '',
        // Phase 58c hotfix: this is the SECOND cart-row mapper in this
        // file (the first is in getOrdersByWorkflow at L1054). The
        // original Phase 58c audit's `grep | head -25` cut off before
        // reaching this site, so productNameDisplay was only set in
        // the list-page path — leaving the order DETAIL page receiving
        // line items with undefined productNameDisplay and rendering
        // every name as the fallback "(no name)".
        productNameDisplay: deriveDisplayName(c.cart_product_name || ''),
        sku: c.cart_sku || '',
        qty: Number(c.cart_qty) || 0,
        price: Number(c.cart_price) || 0,
        photoProductId: c.cart_photo_prod || 0,

        galleryId: c.cart_pic_date_id || 0,
        galleryName: c.cart_pic_date_org || '',
        subGalleryId: c.cart_sub_gal_id || 0,
        subGalleryName:
          c.cart_sub_gal_id > 0 ? subsById.get(c.cart_sub_gal_id) || '' : '',

        photo: photoRow
          ? buildPhotoUrls({ ...photoRow, pic_id: c.cart_pic_id })
          : null,

        backgroundPhoto: bgPhotoRow
          ? buildPhotoUrls({ ...bgPhotoRow, pic_id: c.cart_photo_bg })
          : null,

        flags: {
          download: c.cart_download === 1,
          package: c.cart_package > 0,
          giftCert: c.cart_gift_certificate === 1,
          creditProduct: c.cart_credit_product > 0,
          booking: c.cart_booking > 0,
          greenScreen: c.cart_photo_bg > 0,
          framed: c.cart_frame_size > 0,
          canvas: c.cart_canvas_id > 0,
          preSell: c.cart_pre_sell === 1,
          preSold: c.cart_pre_sold === 1,
          // Phase 64: pre-registration placeholder (cart_pre_register_id > 0).
          // See the getOrderById flags block for the full rationale.
          preRegister: c.cart_pre_register_id > 0,
          fromArchive: c.fromArchive === 1,
        },

        options: optionsByCartId.get(c.cart_id) || [],
        thumbPath: c.cart_thumb || '',
        notes: c.cart_notes || '',
      };
    });

    // Phase 15a: expand package rows. Same logic as
    // getOrdersByWorkflow — load the contents map, walk lineItems,
    // emit synthetic constituents for each configured package row.
    // Phase 15b: chain add-on explosion afterwards.
    const { packageContentsMap, productCategoriesBySku } =
      await this._loadPackageMap();
    const { addonMap } = await this._loadAddonMap();
    const packageExpanded = _expandPackageLineItems(
      lineItems,
      packageContentsMap
    );
    const expandedLineItems = _expandAddonLineItems(
      packageExpanded,
      addonMap,
      productCategoriesBySku
    );

    const distinctSubGalleries = new Set(
      expandedLineItems.map((li) => li.subGalleryId).filter((sid) => sid > 0)
    );
    const isSibling = distinctSubGalleries.size > 1;
    const primaryGallery = expandedLineItems.find((li) => li.galleryId > 0) || null;
    const shipping = categorizeShipping(o.order_shipping_option, o.order_shipping, !!o.isDigitalOnly);

    // Phase 60a: instant-pack eligibility — same JS computation the list uses,
    // over this order's expanded line items, so the detail-page shape and the
    // orders-list badge can't disagree. Predicates from a one-off productWeights
    // load (default-deny on failure).
    let instantPackPredicates = _makePackagingPredicates({});
    try {
      const productWeights = await require('./packagingService').getProductWeights();
      instantPackPredicates = _makePackagingPredicates(productWeights);
    } catch (e) {
      console.warn(`[SytistDB] instant-pack predicates unavailable (default-deny): ${e.message}`);
    }
    const instantPack = _computeInstantPackEligibility(expandedLineItems, instantPackPredicates);

    return {
      source: 'sytist',
      orderId: String(o.order_id),
      orderNumber: String(o.order_id),
      orderDate: o.order_date,
      paymentStatus: o.order_payment_status,
      productionStatus: {
        id: o.order_open_status || 0,
        name: o.productionStatusName || (o.order_open_status === 0 ? STATUS_OPEN_NAME : ''),
      },
      orderStatus: o.order_status,
      orderArchiveTable: o.order_archive_table === 1,

      customer: {
        firstName: o.order_first_name || '',
        lastName: o.order_last_name || '',
        email: o.order_email || '',
        phone: o.order_phone || '',
        businessName: o.order_business_name || '',
      },

      shipTo: {
        firstName: o.order_ship_first_name || '',
        lastName: o.order_ship_last_name || '',
        address1: o.order_ship_address || '',
        address2: o.order_ship_addres_2 || '',
        city: o.order_ship_city || '',
        state: o.order_ship_state || '',
        zip: o.order_ship_zip || '',
        country: o.order_ship_country || '',
        phone: o.order_phone || '',
        businessName: o.order_ship_business || '',
      },

      shipping: {
        cost: Number(o.order_shipping) || 0,
        optionName: o.order_shipping_option || '',
        workflow: shipping.workflow,
        uncategorized: shipping.uncategorized,
      },

      totals: {
        subtotal: Number(o.order_sub_total) || 0,
        tax: Number(o.order_tax) || 0,
        total: Number(o.order_total) || 0,
        paymentFee: Number(o.order_payment_fee) || 0,
      },

      subject: { fields: normalizeSubjectFields(o) },

      galleryId: primaryGallery ? primaryGallery.galleryId : 0,
      galleryName: primaryGallery ? primaryGallery.galleryName : '',
      subGalleryId: primaryGallery ? primaryGallery.subGalleryId : 0,
      subGalleryName: primaryGallery ? primaryGallery.subGalleryName : '',

      lineItems: expandedLineItems,
      isSibling,
      // Phase 60a: instant-pack eligibility badge (default-deny). Same JS
      // computation as the orders list, so detail and list never disagree.
      isInstantPackEligible: instantPack.eligible,

      dueDate:
        o.order_due_date && o.order_due_date !== '0000-00-00'
          ? o.order_due_date
          : null,
      customerNotes: o.order_notes || '',
      adminNotes: o.order_admin_notes || '',

      cardLastFour: o.order_card_last_four || '',
      payType: o.order_pay_type || '',
    };
  }

  /**
   * Updates the production status of a single order.
   *
   * Writes ONLY to ms_orders.order_open_status. Does NOT write to
   * ms_order_status_logs (owned by the existing Sytist automation).
   *
   * Validates statusId against ms_order_status (or 0 for "Queue") before
   * writing. Reads the previous value first so the caller can confirm what
   * changed.
   *
   * Returns:
   *   {
   *     orderId,
   *     previousStatus: { id, name },
   *     newStatus:      { id, name },
   *     affectedRows
   *   }
   *
   * Throws:
   *   - Order not found
   *   - Order erased (soft-deleted)
   *   - Invalid statusId (not 0 and not in ms_order_status)
   */
  async updateOrderStatus(orderId, statusId, shippingFields = null) {
    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('Invalid order ID');
    }

    const newStatusId = parseInt(statusId, 10);
    if (Number.isNaN(newStatusId) || newStatusId < 0) {
      throw new Error('Invalid status ID');
    }

    const pool = this.getPool();

    // 1. Validate the new status exists (or is 0 = Queue).
    let newStatusName = '';
    if (newStatusId === 0) {
      newStatusName = STATUS_OPEN_NAME;
    } else {
      const [[statusRow]] = await pool.query(
        'SELECT status_id, status_name FROM ms_order_status WHERE status_id = ?',
        [newStatusId]
      );
      if (!statusRow) {
        throw new Error(`Status ID ${newStatusId} does not exist in ms_order_status`);
      }
      newStatusName = statusRow.status_name;
    }

    // 2. Read current state. Confirm order exists and isn't erased.
    const [[currentRow]] = await pool.query(
      `
      SELECT
        o.order_id, o.order_open_status, o.order_erased,
        st.status_name AS currentStatusName
      FROM ms_orders o
      LEFT JOIN ms_order_status st ON st.status_id = o.order_open_status
      WHERE o.order_id = ?
      `,
      [id]
    );

    if (!currentRow) {
      throw new Error(`Order ${id} not found`);
    }
    if (currentRow.order_erased === 1) {
      throw new Error(`Order ${id} is erased; refusing to update`);
    }

    const previousStatusId = currentRow.order_open_status || 0;
    const previousStatusName =
      previousStatusId === 0 ? STATUS_OPEN_NAME : currentRow.currentStatusName || '';

    // 3. The actual write. Single row, by primary key, no triggers we control.
    //
    // Phase 30: when `shippingFields` is provided, write the shipping
    // columns alongside order_open_status in a single UPDATE. When it's
    // null (existing callers like the PUT /orders/:id/status endpoint),
    // just write order_open_status as before. The expanded write is
    // opt-in so callers that aren't shipping-related don't accidentally
    // clobber shipping state.
    if (shippingFields) {
      console.log(
        `[SytistDB] updateOrderStatus (with shipping): order ${id}: ${previousStatusId} (${previousStatusName}) → ${newStatusId} (${newStatusName}), tracking=${shippingFields.trackingNumber || ''}, carrier=${shippingFields.carrier || ''}, cost=${shippingFields.shipCost}`
      );

      const [result] = await pool.query(
        `UPDATE ms_orders SET
           order_open_status   = ?,
           order_shipped_date  = ?,
           order_shipped_track = ?,
           order_shipped_by    = ?,
           order_shipped_by_id = ?,
           order_ship_cost     = ?
         WHERE order_id = ?`,
        [
          newStatusId,
          shippingFields.shippedDate || '0000-00-00',
          shippingFields.trackingNumber || '',
          shippingFields.carrier || '',
          parseInt(shippingFields.shippedById, 10) || 0,
          parseFloat(shippingFields.shipCost) || 0,
          id,
        ]
      );

      return {
        orderId: id,
        previousStatus: { id: previousStatusId, name: previousStatusName },
        newStatus: { id: newStatusId, name: newStatusName },
        shippingFields,
        affectedRows: result.affectedRows,
      };
    }

    // Legacy single-column path. Used by the PUT /orders/:id/status
    // endpoint which doesn't know about shipping at all.
    console.log(
      `[SytistDB] updateOrderStatus: order ${id}: ${previousStatusId} (${previousStatusName}) → ${newStatusId} (${newStatusName})`
    );

    const [result] = await pool.query(
      'UPDATE ms_orders SET order_open_status = ? WHERE order_id = ?',
      [newStatusId, id]
    );

    return {
      orderId: id,
      previousStatus: { id: previousStatusId, name: previousStatusName },
      newStatus: { id: newStatusId, name: newStatusName },
      affectedRows: result.affectedRows,
    };
  }

  /**
   * Returns aggregate counts for the home dashboard cards.
   *
   * Three groupings, all over open + paid orders:
   *   - byStatus:   counts keyed by order_open_status (0 = Queue, 12, 40, etc.)
   *   - byWorkflow: counts keyed by workflow bucket (ship_to_home/managers/league)
   *                 — only counts the QUEUE (order_open_status = 0), since that's
   *                 the actionable bucket; "shipped" and "in production" are tracked
   *                 by the byStatus card row instead.
   *   - total:      sum of all open + paid orders regardless of status
   *
   * Single round-trip: one query for status counts (cheap — indexed), one for
   * workflow assembly (slightly more work — needs the option string + cost so
   * we can apply categorizeShipping in JS).
   *
   * Shape:
   *   {
   *     total: 12345,
   *     byStatus:   { "0": 5894, "40": 257, "12": 4, ... },
   *     byWorkflow: { "ship_to_home": 4500, "ship_to_managers": 600, "ship_to_league": 794, "uncategorized": 0 },
   *     elapsedMs: 89
   *   }
   */
  async getOrderCounts() {
    const pool = this.getPool();
    const start = Date.now();

    // 1. Counts grouped by production status.
    const [statusRows] = await pool.query(
      `
      SELECT order_open_status AS statusId, COUNT(*) AS count
      FROM ms_orders
      WHERE order_payment_status = 'Completed'
        AND order_status = 0
        AND order_erased = 0
      GROUP BY order_open_status
      `
    );

    const byStatus = {};
    let total = 0;
    for (const r of statusRows) {
      const id = String(r.statusId == null ? 0 : r.statusId);
      const n = Number(r.count) || 0;
      byStatus[id] = n;
      total += n;
    }

    // 2. Workflow counts — restricted to queue (order_open_status = 0) since
    //    that's the actionable view operators care about.
    //    Phase 60: group by a computed isDigitalOnly so the per-(option,cost)
    //    buckets split into physical vs digital-only, feeding the same
    //    categorizeShipping(isDigitalOnly) branch the list + detail use.
    //    Aliased `o` because the physical-item SQL references o.order_id.
    const digitalSkuList = _loadDigitalSkuList();
    const [workflowRows] = await pool.query(
      `
      SELECT o.order_shipping_option AS optionName, o.order_shipping AS cost,
             (NOT ${_physicalItemExistsSql(digitalSkuList)}) AS isDigitalOnly,
             COUNT(*) AS count
      FROM ms_orders o
      WHERE o.order_payment_status = 'Completed'
        AND o.order_status = 0
        AND o.order_erased = 0
        AND o.order_open_status = 0
      GROUP BY o.order_shipping_option, o.order_shipping, isDigitalOnly
      `
    );

    const byWorkflow = {
      ship_to_home: 0,
      ship_to_managers: 0,
      ship_to_league: 0,
      digital: 0,
      uncategorized: 0,
    };

    for (const r of workflowRows) {
      const cat = categorizeShipping(r.optionName, r.cost, !!r.isDigitalOnly);
      const n = Number(r.count) || 0;
      byWorkflow[cat.workflow] += n;
      if (cat.uncategorized) {
        byWorkflow.uncategorized += n;
      }
    }

    return {
      total,
      byStatus,
      byWorkflow,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Phase 8a: locate a team photo for a sub-gallery.
   *
   * Used by the composite engine to find the team photo to layer onto
   * memory mates. The discovery rule is structural — we don't pattern-
   * match filenames or derive orientation from metadata; we just look
   * for a photo assigned to the team-photo price list AND linked to the
   * sub-gallery.
   *
   *   ms_blog_photos.bp_pl  = listId       (price list discriminator)
   *   ms_blog_photos.bp_sub = subGalleryId (which team)
   *
   * Returns the same shape as buildPhotoUrls() — { isS3, originalFilename,
   * width, height, fullUrl, largeUrl, thumbUrl } — or null if no match.
   *
   * @param {object} opts
   * @param {number} opts.subGalleryId  ms_sub_galleries.sub_id
   * @param {number} opts.listId        ms_photo_products_list.list_id
   *                                    (default: 268, configurable per
   *                                    teamPhotoService settings)
   */
  /**
   * Phase 8a-hotfix: list every sub-gallery in a gallery, no order
   * filter applied.
   *
   * Different from getGalleryHierarchy() which filters sub-galleries
   * to those with paid/open/non-erased orders. The verification UI
   * needs to look up team photos for sub-galleries that may not have
   * orders yet (typical at gallery setup time, before customers buy).
   *
   * NOT a replacement for getGalleryHierarchy in the orders/dashboard
   * flow — those should stay filtered. Only the team photo lookup
   * tester should call this.
   */
  async getAllSubGalleries(galleryId) {
    if (!galleryId || galleryId <= 0) return [];
    const pool = this.getPool();
    const [rows] = await pool.query(
      `
      SELECT
        sub_id   AS subGalleryId,
        sub_name AS subGalleryName
      FROM ms_sub_galleries
      WHERE sub_date_id = ?
      ORDER BY sub_name
      `,
      [galleryId]
    );
    return rows.map((r) => ({
      subGalleryId: r.subGalleryId,
      subGalleryName: r.subGalleryName,
    }));
  }

  async findTeamPhoto({ subGalleryId, listId = 268 }) {
    if (!subGalleryId || subGalleryId <= 0) return null;
    const pool = this.getPool();

    // Phase 8b: LIMIT 2 (rather than 1) so the caller can detect when
    // multiple team photos exist for the same sub-gallery. We still
    // return only the most-recently-added photo (ORDER BY bp_id DESC),
    // but we surface candidateCount so the caller can warn the operator.
    // This addresses the legacy data where some old sub-galleries have
    // multiple photos on the team-photo price list.
    const [rows] = await pool.query(
      `
      SELECT
        p.pic_id,
        p.pic_org,
        p.pic_full,
        p.pic_large,
        p.pic_th,
        p.pic_amazon,
        p.pic_amazon_endpoint,
        p.pic_bucket,
        p.pic_bucket_folder,
        p.pic_width,
        p.pic_height,
        bp.bp_blog AS galleryId,
        bp.bp_sub  AS subGalleryId,
        bp.bp_id   AS bpId
      FROM ms_blog_photos bp
      INNER JOIN ms_photos p ON p.pic_id = bp.bp_pic
      WHERE bp.bp_pl  = ?
        AND bp.bp_sub = ?
      ORDER BY bp.bp_id DESC
      LIMIT 2
      `,
      [listId, subGalleryId]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    const photo = buildPhotoUrls(row);
    if (!photo) return null;

    // Annotate with the IDs we matched on so callers can verify the
    // lookup hit the row they expected. candidateCount tells the caller
    // whether multiple matches existed (≥2 means there's a tiebreaker
    // situation worth surfacing).
    return {
      ...photo,
      photoId: row.pic_id,
      galleryId: row.galleryId,
      subGalleryId: row.subGalleryId,
      bpId: row.bpId,
      candidateCount: rows.length, // 1 = clean match, 2 = multi-match (we returned newest)
    };
  }

  /**
   * Phase 15a: load the package-contents map and a SKU→name lookup
   * once per query, so _expandPackageLineItems can resolve SKUs
   * efficiently. Both services are singletons with their own caches;
   * calling them is cheap.
   *
   * Returns:
   *   {
   *     packageContentsMap: { [packageSku]: [{ sku, qty, name }, ...] },
   *     // null if no package contents are configured at all — caller
   *     // can short-circuit and skip _expandPackageLineItems entirely.
   *   }
   */
  async _loadPackageMap() {
    let packageContentsService;
    let packagingService;
    try {
      packageContentsService = require('./packageContentsService');
    } catch {
      return { packageContentsMap: null };
    }
    let contentsConfig;
    try {
      contentsConfig = await packageContentsService.getConfig();
    } catch (err) {
      console.warn(
        `[SytistDB] Could not load package contents config: ${err.message}`
      );
      return { packageContentsMap: null };
    }
    if (!contentsConfig || Object.keys(contentsConfig).length === 0) {
      return { packageContentsMap: null };
    }

    // Build SKU→name and SKU→category lookups from packaging-config.
    // The category lookup is used by _expandPackageLineItems to set
    // flags.download for digital constituents — so e.g. the Gold
    // Package's bundled Digital Download (SKU 25) gets flagged the
    // same way an explicitly-ordered digital line item would, and
    // the production pipeline correctly skips it.
    let productNames = {};
    let productCategories = {};
    try {
      packagingService = require('./packagingService');
      const pkgCfg = await packagingService.getConfig();
      for (const [sku, def] of Object.entries(pkgCfg.productWeights || {})) {
        if (def && def.name) productNames[String(sku)] = def.name;
        if (def && def.category) productCategories[String(sku)] = def.category;
      }
      // Also pull names from packageBundles in case a package SKU
      // itself appears as a constituent (unusual but allowed).
      for (const [sku, def] of Object.entries(pkgCfg.packageBundles || {})) {
        if (def && def.name) productNames[String(sku)] = def.name;
      }
    } catch {
      // packagingService unavailable — names will fall back to "SKU N"
    }

    // Decorate contents map with names + categories for synthetic
    // productName and digital-flag inference.
    const packageContentsMap = {};
    for (const [pkgSku, pkg] of Object.entries(contentsConfig)) {
      packageContentsMap[pkgSku] = (pkg.items || []).map((item) => ({
        sku: String(item.sku),
        qty: Math.max(1, parseInt(item.qty, 10) || 1),
        name: productNames[String(item.sku)] || `SKU ${item.sku}`,
        category: productCategories[String(item.sku)] || null,
      }));
    }
    // Phase 15b: also return productCategories so the addon
    // explosion in the same query can infer the digital flag for
    // mapped add-on SKUs without re-loading packagingService.
    return { packageContentsMap, productCategoriesBySku: productCategories };
  }

  /**
   * Phase 15b: load the addon-mappings config once per query for
   * use by _expandAddonLineItems. Returns { addonMap } where
   * addonMap[optId] = { name, sku } for every configured mapping.
   * Empty/null when no mappings are configured.
   */
  async _loadAddonMap() {
    let addonMappingsService;
    try {
      addonMappingsService = require('./addonMappingsService');
    } catch {
      return { addonMap: null };
    }
    try {
      const cfg = await addonMappingsService.getConfig();
      if (!cfg || Object.keys(cfg).length === 0) {
        return { addonMap: null };
      }
      // Phase 15c: two mapping types. Pass through only "complete"
      // mappings:
      //   - product mappings need a non-empty sku
      //   - modifier mappings need a non-empty suffix
      // Half-configured entries are dropped here so the explosion
      // logic doesn't have to recheck completeness per option.
      const out = {};
      for (const [optId, mapping] of Object.entries(cfg)) {
        if (!mapping) continue;
        const type = mapping.type === 'modifier' ? 'modifier' : 'product';
        if (type === 'modifier') {
          if (!mapping.suffix) continue;
          out[String(optId)] = {
            type: 'modifier',
            name: mapping.name || '',
            suffix: mapping.suffix,
          };
        } else {
          if (!mapping.sku) continue;
          out[String(optId)] = {
            type: 'product',
            name: mapping.name || '',
            sku: String(mapping.sku),
            qty: Math.max(1, parseInt(mapping.qty, 10) || 1),
          };
        }
      }
      return { addonMap: Object.keys(out).length > 0 ? out : null };
    } catch (err) {
      console.warn(
        `[SytistDB] Could not load addon mappings: ${err.message}`
      );
      return { addonMap: null };
    }
  }

  /**
   * Phase 20: global order search.
   *
   * Matches any of: order_id (the Sytist order number — there is
   * no separate order_number column), customer first/last name,
   * email, phone. Returns up to 10 results.
   *
   * Scope is the same as the orders list: paid + non-erased.
   *
   * @param {string} query  raw user input
   * @returns {Promise<Array<{
   *   orderId: number,
   *   orderNumber: string,
   *   orderDate: string,
   *   customerName: string,
   *   email: string,
   *   phone: string,
   *   total: number,
   *   productionStatusId: number,
   *   productionStatusName: string,
   * }>>}
   */
  async searchOrders(query) {
    const q = String(query || '').trim();
    if (!q) return [];

    const pool = this.getPool();

    // Build WHERE clause. All matches are ORed together but the
    // base "paid + non-erased" filter is always applied.
    //
    // Order ID: try EXACT match first (most common case — operator
    // types 110643 and wants exactly that). order_id is an INT, so
    // we cast it to CHAR for LIKE matching.
    //
    // Customer name: match against CONCAT(first, ' ', last) so
    // typing "Jessica Foss" returns Jessica Foss; "Foss" returns
    // anything with last name containing Foss; "Jess" matches
    // first name.
    //
    // Email / phone: LIKE %q%.
    //
    // Old MySQL on the droplet handles CONCAT in WHERE fine; the
    // pattern matches what other queries here do.
    const isOrderNumberLike = /^[0-9]{3,8}$/.test(q);
    const likeQ = `%${q}%`;

    // Strip non-digit chars for phone matching so "(763) 639-9351"
    // and "7636399351" both match.
    const phoneDigits = q.replace(/[^0-9]/g, '');
    const phoneLike = phoneDigits.length >= 4 ? `%${phoneDigits}%` : null;

    const orClauses = [];
    const orParams = [];

    if (isOrderNumberLike) {
      // Exact order_id match — highest priority via ORDER BY below.
      orClauses.push('o.order_id = ?');
      orParams.push(parseInt(q, 10));
    }
    // Partial order_id match (always — covers typing partials).
    // CAST to CHAR so LIKE works against the integer column.
    orClauses.push('CAST(o.order_id AS CHAR) LIKE ?');
    orParams.push(likeQ);

    // Customer name (concat of first + last).
    orClauses.push(
      "CONCAT_WS(' ', o.order_first_name, o.order_last_name) LIKE ?"
    );
    orParams.push(likeQ);

    // Email.
    orClauses.push('o.order_email LIKE ?');
    orParams.push(likeQ);

    // Phone (raw and stripped).
    orClauses.push('o.order_phone LIKE ?');
    orParams.push(likeQ);
    if (phoneLike) {
      orClauses.push("REPLACE(REPLACE(REPLACE(REPLACE(o.order_phone, '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?");
      orParams.push(phoneLike);
    }

    const sql = `
      SELECT
        o.order_id,
        o.order_date,
        o.order_first_name,
        o.order_last_name,
        o.order_email,
        o.order_phone,
        o.order_total,
        o.order_open_status,
        st.status_name AS productionStatusName,
        ${isOrderNumberLike ? '(o.order_id = ?) AS exact_match,' : '0 AS exact_match,'}
        (CAST(o.order_id AS CHAR) LIKE ?) AS partial_order_match
      FROM ms_orders o
      LEFT JOIN ms_order_status st ON st.status_id = o.order_open_status
      WHERE o.order_payment_status = 'Completed'
        AND o.order_erased = 0
        AND (${orClauses.join(' OR ')})
      ORDER BY exact_match DESC, partial_order_match DESC, o.order_date DESC
      LIMIT 10
    `;

    // Params order: ranking ORs first (for the SELECT expressions),
    // then the WHERE-clause params.
    const params = [];
    if (isOrderNumberLike) params.push(parseInt(q, 10)); // exact_match select expr
    params.push(likeQ); // partial_order_match select expr
    params.push(...orParams);

    const [rows] = await pool.query(sql, params);

    return rows.map((r) => ({
      orderId: r.order_id,
      // orderNumber is the same as orderId for Sytist — keep the
      // field name for the client UI which renders it as "#{number}".
      orderNumber: String(r.order_id),
      orderDate:
        typeof r.order_date === 'string'
          ? r.order_date.split(' ')[0]
          : '',
      customerName: [r.order_first_name, r.order_last_name]
        .filter(Boolean)
        .join(' ')
        .trim(),
      email: r.order_email || '',
      phone: r.order_phone || '',
      total: parseFloat(r.order_total) || 0,
      productionStatusId: r.order_open_status,
      productionStatusName:
        r.productionStatusName || (r.order_open_status === 0 ? 'Queue' : ''),
    }));
  }

  // ─── Phase 36: ms_notes — order activity log ──────────────
  //
  // Sytist has a polymorphic ms_notes table that backs the "Notes"
  // section on its order detail page. Every order action Sytist
  // itself does (status changes, emails, invoices, etc.) writes a
  // row here. We extend the dashboard's Sytist write allow-list to
  // include INSERT INTO ms_notes (append-only) so our actions also
  // show up in Sytist's UI, alongside Sytist's own notes.
  //
  // Schema reminder (Sytist's columns are NOT NULL with defaults):
  //   note_id           int PK auto_increment
  //   note_date         datetime          (we set NOW())
  //   note_table        varchar(100)      ('ms_orders' for orders)
  //   note_table_id     int               (order_id)
  //   note_note         text              (the human-readable body)
  //   note_delete       int               (0 = active, 1 = soft-deleted)
  //   note_who          varchar(100)      (Sytist user display name)
  //   note_edited       datetime          (we write '0000-00-00 00:00:00')
  //   note_edited_who   varchar(100)      ('')
  //   note_ip           varchar(200)      (client IP if available, else '')
  //   note_admin        int               (1 = staff/dashboard, 0 = customer)
  //   note_is_note      int               (1 = manual operator note,
  //                                        0 = system log event)
  //   note_log          int               (1 = log event, 0 = manual note)
  //   note_data         text              (we leave empty per project policy)
  //
  // Flag conventions (matches what Sytist itself uses, inferred from
  // sampled rows):
  //   - System/automated events:  admin=1, is_note=0, log=1, data=''
  //   - Manual operator notes:    admin=1, is_note=1, log=0, data=''
  //   - Customer-triggered:       admin=0, is_note=0, log=1  (we don't emit these)
  //
  // Failure handling: every method is best-effort. The caller's
  // primary action MUST NOT be blocked by an ms_notes failure —
  // errors are logged and swallowed inside the orchestrating
  // services (orderStatusService, processingService, etc.). At this
  // layer we just throw so the wrapper can decide.

  /**
   * Insert a row into ms_notes. Used both for system log events
   * (default flags) and manual operator notes (flags inverted via
   * the isManual option).
   *
   * @param {object} opts
   * @param {string|number} opts.orderId   Sytist order_id (or any int PK)
   * @param {string} opts.noteText         What appears in note_note
   * @param {string} opts.who              Display name (e.g. "Joey")
   * @param {string} [opts.ip='']          Client IP
   * @param {boolean} [opts.isManual=false] true → operator-typed note;
   *                                        false → system log event
   * @param {string} [opts.table='ms_orders']
   * @returns {Promise<{ noteId: number }>}
   */
  async insertNote({
    orderId,
    noteText,
    who,
    ip = '',
    isManual = false,
    table = 'ms_orders',
  }) {
    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('insertNote requires a valid orderId');
    }
    if (!noteText || typeof noteText !== 'string') {
      throw new Error('insertNote requires noteText');
    }

    // Flag triple per the convention discovered from Sytist's own
    // rows: log events have is_note=0 / log=1, manual notes have
    // is_note=1 / log=0. Both are admin=1 (visible to staff only,
    // not customer-facing).
    const note_admin = 1;
    const note_is_note = isManual ? 1 : 0;
    const note_log = isManual ? 0 : 1;

    const pool = this.getPool();
    // Phase 36 fix (hotfix 2): the Sytist schema declares some
    // columns NOT NULL with no usable default for INSERT under
    // MySQL strict mode. We MUST list those columns and provide
    // explicit values:
    //   - note_data        TEXT NOT NULL, no default → pass ''
    //   - note_delete      INT NOT NULL → pass 0
    //   - note_edited_who  VARCHAR NOT NULL, no default → pass ''
    //
    // But note_edited (datetime) is different — strict mode rejects
    // the literal '0000-00-00 00:00:00' even though that's the
    // column's own DEFAULT. We omit note_edited from the INSERT and
    // let MySQL apply the default; the default IS the zero-date but
    // applied implicitly it passes the NO_ZERO_DATE check (this is
    // an old MySQL quirk).
    const [result] = await pool.query(
      `INSERT INTO ms_notes
         (note_date, note_table, note_table_id, note_note, note_delete,
          note_who, note_edited_who, note_ip,
          note_admin, note_is_note, note_log, note_data)
       VALUES (NOW(), ?, ?, ?, 0,
               ?, '', ?,
               ?, ?, ?, '')`,
      [
        String(table).slice(0, 100),
        id,
        String(noteText).slice(0, 65535), // text column
        String(who || 'sytist-dashboard').slice(0, 100),
        String(ip || '').slice(0, 200),
        note_admin,
        note_is_note,
        note_log,
      ]
    );

    return { noteId: result.insertId };
  }

  /**
   * Phase 36 hotfix 3: find the operator who last did a Sytist Dashboard
   * action on this order. Used by the scheduler so its auto-detected
   * Shipped notes can be attributed to the operator who originally
   * processed the order, rather than the generic 'sytist-dashboard'
   * fallback.
   *
   * Search criteria:
   *   - note_table = 'ms_orders' AND note_table_id = orderId
   *   - note_delete = 0
   *   - note_note starts with 'Sytist Dashboard:' (our prefix)
   *   - note_who != 'sytist-dashboard' (skip any prior scheduler events)
   *   - Most recent first
   *
   * Returns the display name string, or null if no prior dashboard
   * activity exists for this order.
   *
   * Single LIMIT 1 query so it's cheap even on busy servers.
   */
  async findOriginalOperator(orderId) {
    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) return null;

    try {
      const pool = this.getPool();
      const [rows] = await pool.query(
        `SELECT note_who
           FROM ms_notes
           WHERE note_table = 'ms_orders'
             AND note_table_id = ?
             AND note_delete = 0
             AND note_note LIKE 'Sytist Dashboard:%'
             AND note_who != 'sytist-dashboard'
             AND note_who != ''
           ORDER BY note_date DESC, note_id DESC
           LIMIT 1`,
        [id]
      );
      if (rows && rows.length > 0 && rows[0].note_who) {
        return String(rows[0].note_who);
      }
      return null;
    } catch (err) {
      // Don't propagate — the scheduler should still write a note
      // (just with the fallback who) even if this lookup fails.
      console.warn(
        `[SytistDB] findOriginalOperator(${id}) failed: ${err.message}`
      );
      return null;
    }
  }

  /**
   * List ms_notes rows for an order, newest first. By default
   * excludes soft-deleted rows (note_delete=1).
   *
   * Returns rows shaped for the UI:
   *   { id, date, body, who, type, deleted, ip }
   * where type is 'note' (manual) or 'log' (system event).
   */
  async listNotes(orderId, { includeDeleted = false, limit = 200 } = {}) {
    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('listNotes requires a valid orderId');
    }

    const pool = this.getPool();
    const sql = `
      SELECT note_id, note_date, note_note, note_who, note_ip,
             note_admin, note_is_note, note_log, note_delete
      FROM ms_notes
      WHERE note_table = 'ms_orders'
        AND note_table_id = ?
        ${includeDeleted ? '' : 'AND note_delete = 0'}
      ORDER BY note_date DESC, note_id DESC
      LIMIT ?
    `;
    const [rows] = await pool.query(sql, [id, parseInt(limit, 10) || 200]);

    return rows.map((r) => ({
      id: r.note_id,
      date: r.note_date,
      body: r.note_note || '',
      who: r.note_who || '',
      ip: r.note_ip || '',
      // is_note=1 means manual operator note; otherwise it's a system log entry
      type: r.note_is_note === 1 ? 'note' : 'log',
      admin: r.note_admin === 1,
      deleted: r.note_delete === 1,
    }));
  }

  /**
   * Soft-delete a note. Sets note_delete=1 + note_edited / _who so
   * we have provenance on who removed it. We don't hard-delete
   * because Sytist's UI may expect rows to stick around (and an
   * audit trail of "Joey removed a note" is more useful than a
   * silent disappearance).
   *
   * Only the row's own author OR an admin should be allowed to do
   * this — that authorization decision lives at the route layer,
   * not here.
   */
  async softDeleteNote(noteId, { editedWho = '' } = {}) {
    const id = parseInt(noteId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('softDeleteNote requires a valid noteId');
    }
    const pool = this.getPool();
    const [result] = await pool.query(
      `UPDATE ms_notes
         SET note_delete = 1,
             note_edited = NOW(),
             note_edited_who = ?
       WHERE note_id = ?
         AND note_delete = 0`,
      [String(editedWho || '').slice(0, 100), id]
    );
    return { affectedRows: result.affectedRows };
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

const _instance = new SytistDbService();
// Phase 60: expose the pure shipping-classification function for offline
// tests. It's a module-level function (not an instance method); attaching it
// here lets verify-shipping-classify.js exercise the REAL decision logic
// without a DB connection. The SQL parity (_buildWorkflowSqlPredicate vs this
// function) is verified live against the database.
_instance._categorizeShipping = categorizeShipping;
// Phase 60a: expose the pure instant-pack helpers for the offline harness
// (verify-instant-pack-eligible.js). _computeInstantPackEligibility takes
// injected predicates so it runs with no DB/config; _makePackagingPredicates
// builds those predicates from a productWeights map for in-harness realism.
_instance._computeInstantPackEligibility = _computeInstantPackEligibility;
_instance._makePackagingPredicates = _makePackagingPredicates;
module.exports = _instance;
