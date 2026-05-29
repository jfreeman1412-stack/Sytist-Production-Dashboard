// Phase 66 verification harness — category drives "force Package service".
// Drives the REAL packagingService.determinePackaging with a controlled
// config (getConfig stubbed) and the imposition lookup neutralized, so the
// only thing under test is the routing decision. No DB, no network, no disk
// config dependency.
//
// Asserts:
//   1. rigid SKU (18 Bagtag)      → packageCode 'package'   (NEW: was flat)
//   2. bulky SKU (37 Team Mug)    → packageCode 'package'   (NEW: was flat)
//   3. pano  SKU (34 12x36 Pano)  → packageCode 'package'   (NEW: was flat)
//   4. flat  SKU (10 5x7 print)   → packageCode 'large_envelope_or_flat'
//   5. magnet qty 2               → flat   (count rule, unchanged)
//   5b. magnet qty 3              → package (count rule, unchanged)
//   6. Gold bundle forcePackage   → package (bundle override, unchanged)
//   7. boxRoute SKU (36) x1       → Medium Box (package); x2 → Large Box
//      (box SIZING is untouched by Phase 66)
//   8. SKU 45 (flat) NOT in boxRouteSKUs → flat (proves the separate 45
//      removal flips it back to flat)

const packagingService = require('../services/packagingService');
const impositionService = require('../services/impositionService');

// Neutralize imposition so flat 6x8-vs-9x11 sizing is deterministic. It never
// affects packageCode (flat stays large_envelope_or_flat either way), but
// keeps output stable.
impositionService.findRule = async () => null;

const PACKAGING_TYPES = {
  flat_6x8:      { name: '6x8 Flat Mailer',  length: 6,  width: 8,  height: 0.5, baseWeight: 1.5, service: 'large_envelope_or_flat' },
  flat_9x11:     { name: '9x11 Flat Mailer', length: 9,  width: 11, height: 0.5, baseWeight: 3,   service: 'large_envelope_or_flat' },
  pano_tube:     { name: 'Pano Tube',        length: 12, width: 2,  height: 2,   baseWeight: 2.6, service: 'package' },
  small_box:     { name: 'Small Box',        length: 6,  width: 6,  height: 6,   baseWeight: 3.5, service: 'package' },
  medium_box:    { name: 'Medium Box',       length: 12, width: 10, height: 2,   baseWeight: 5.5, service: 'package' },
  pano_frame_sm: { name: '8x24 Pano Frame',  length: 26, width: 10, height: 2,   baseWeight: 30,  service: 'package' },
  pano_frame_lg: { name: '10x30 Pano Frame', length: 31, width: 11, height: 2,   baseWeight: 44,  service: 'package' },
  large_box:     { name: 'Large Box',        length: 14, width: 10, height: 6,   baseWeight: 9,   service: 'package' },
};

// Test config mirrors the post-Phase-66 production shape: NO forcePackageSKUs
// key at all; categories carry the force-package intent. boxRouteSKUs holds
// only 36 (45 deliberately omitted — the "after removal" state).
const TEST_CONFIG = {
  productWeights: {
    '10': { weight: 0.1,  name: '5x7 Print',       category: 'flat' },
    '15': { weight: 1.7,  name: '2 Large Magnets', category: 'flat' },
    '18': { weight: 1,    name: 'Bagtag',          category: 'rigid' },
    '34': { weight: 2.8,  name: '12x36 Pano',      category: 'pano' },
    '36': { weight: 32,   name: 'Item 36',         category: 'rigid' },
    '37': { weight: 11.5, name: 'Team Coffee mug', category: 'bulky' },
    '45': { weight: 0.2,  name: 'Item 45',         category: 'flat' },
  },
  packagingTypes: PACKAGING_TYPES,
  packageBundles: {
    '1': { name: 'Gold Package', weight: 7, forcePackage: true },
  },
  magnetThreshold: { skus: ['15', '17'], threshold: 3 },
  framedPanoSmallSKUs: [],
  framedPanoLargeSKUs: [],
  boxRouteSKUs: ['36'],
  packingSlipWeightOz: 0.4,
  packingSlipPosition: 'last',
};

packagingService.getConfig = async () => JSON.parse(JSON.stringify(TEST_CONFIG));

function order(lineItems) {
  return { orderId: '1', orderNumber: '1', lineItems };
}
function li(sku, qty = 1, extra = {}) {
  return { sku, qty, productNameDisplay: `SKU ${sku}`, flags: {}, ...extra };
}

let pass = 0;
const fails = [];
async function expect(name, fn) {
  try {
    const ok = await fn();
    if (ok) { pass++; console.log(`  PASS  ${name}`); }
    else { fails.push(name); console.log(`  FAIL  ${name}`); }
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL  ${name} — threw ${e.message}\n${e.stack}`);
  }
}

(async () => {
  await expect('rigid SKU 18 (Bagtag) → packageCode package', async () => {
    const r = await packagingService.determinePackaging(order([li('18')]));
    return r.packageCode === 'package';
  });

  await expect('bulky SKU 37 (Team Mug) → packageCode package', async () => {
    const r = await packagingService.determinePackaging(order([li('37')]));
    return r.packageCode === 'package';
  });

  await expect('pano SKU 34 (12x36 Pano) → packageCode package', async () => {
    const r = await packagingService.determinePackaging(order([li('34')]));
    return r.packageCode === 'package';
  });

  await expect('flat SKU 10 → packageCode large_envelope_or_flat', async () => {
    const r = await packagingService.determinePackaging(order([li('10')]));
    return r.packageCode === 'large_envelope_or_flat';
  });

  await expect('magnet qty 2 → flat (count rule unchanged)', async () => {
    const r = await packagingService.determinePackaging(order([li('15', 2)]));
    return r.packageCode === 'large_envelope_or_flat';
  });

  await expect('magnet qty 3 → package (count rule unchanged)', async () => {
    const r = await packagingService.determinePackaging(order([li('15', 3)]));
    return r.packageCode === 'package';
  });

  await expect('Gold bundle (forcePackage) → package (bundle override unchanged)', async () => {
    const r = await packagingService.determinePackaging(
      order([li('1', 1, { flags: { isPackageHeader: true } })])
    );
    return r.packageCode === 'package';
  });

  await expect('boxRoute SKU 36 x1 → Medium Box (sizing untouched)', async () => {
    const r = await packagingService.determinePackaging(order([li('36', 1)]));
    return r.packageType === 'medium_box' && r.packageCode === 'package';
  });

  await expect('boxRoute SKU 36 x2 → Large Box (sizing untouched)', async () => {
    const r = await packagingService.determinePackaging(order([li('36', 2)]));
    return r.packageType === 'large_box' && r.packageCode === 'package';
  });

  await expect('SKU 45 (flat, not in boxRouteSKUs) → flat', async () => {
    const r = await packagingService.determinePackaging(order([li('45')]));
    return r.packageCode === 'large_envelope_or_flat';
  });

  console.log(`\n${pass}/${pass + fails.length} package-routing cases pass`);
  if (fails.length) {
    console.error('FAILURES:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  process.exit(0);
})();
