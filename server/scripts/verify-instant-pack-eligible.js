// Phase 60a verification harness — instant-pack eligibility classification.
// Exercises the REAL pure functions (exposed as
// sytistDbService._computeInstantPackEligibility +
// sytistDbService._makePackagingPredicates) without a DB.
//
// The rule under test:
//   An order is instant-pack eligible IFF it has ≥1 PHYSICAL item AND every
//   physical item's SKU is marked instantPackEligible in packaging-config
//   (default-deny). A line item is PHYSICAL iff: not a package header, none
//   of INSTANT_PACK_SKIP_FLAGS (download/giftCert/creditProduct/booking/
//   preSell), and not a digital-by-config SKU. Modifier-type add-ons never
//   become line items, so they're ignored for free.
//
// Decision (Phase 60a): specialty + drop-ship items are NOT skip-flagged —
// they physically ship, so they pass the physical predicate and must be on
// the eligible list. Default-deny means they aren't (and a drop-ship SKU
// shouldn't be markable), which correctly disqualifies the order. The
// eligibility function has NO specialty/drop-ship awareness; correctness
// comes entirely from default-deny + a physical SKU not being on the list.
//
// NOTE: this tests the JS decision only. There is deliberately no SQL
// predicate in 60a (display-only badge, no filter tab / count). When 60b
// adds a tab/count, a SQL parity check must be added — see SPEC §60a.

// Minimal env so the module's pool init doesn't throw on require.
process.env.SYTIST_DB_HOST = process.env.SYTIST_DB_HOST || 'offline';
process.env.SYTIST_DB_USER = process.env.SYTIST_DB_USER || 'offline';
process.env.SYTIST_DB_NAME = process.env.SYTIST_DB_NAME || 'offline';

const sytistDb = require('../services/sytistDbService');
const compute = sytistDb._computeInstantPackEligibility;
const makePredicates = sytistDb._makePackagingPredicates;

if (typeof compute !== 'function' || typeof makePredicates !== 'function') {
  console.error('FAIL: sytistDbService instant-pack helpers are not exposed');
  process.exit(1);
}

// Synthetic productWeights fixture — mirrors packaging-config.json shape.
// The harness drives the REAL case-tolerant lookup, so '5D' (uppercase
// digital package) and the eligible/ineligible mix are all exercised.
const productWeights = {
  '8':  { weight: 0.5, name: '8x10 Individual', category: 'flat',  instantPackEligible: true },
  '10': { weight: 0.1, name: '5x7 Print',       category: 'flat',  instantPackEligible: true },
  '12': { weight: 0.5, name: '8 Wallets',       category: 'flat',  instantPackEligible: true },  // eligible product add-on SKU
  '19': { weight: 5,   name: 'Mouse Pad',       category: 'rigid', instantPackEligible: false }, // ineligible product add-on SKU
  '20': { weight: 11.5, name: 'Coffee Mug',     category: 'bulky', instantPackEligible: false }, // physical, not eligible
  '14': { weight: 0,   name: 'Statuette',       category: 'flat' }, // "specialty" item — physical, no eligible flag (default-deny)
  '36': { weight: 32,  name: 'Item 36',         category: 'rigid' }, // "drop-ship" item — physical, no eligible flag
  '25': { weight: 0,   name: 'Digital Download', category: 'digital' }, // ignored (digital-by-config)
  '5D': { weight: 0,   name: '5 Digitals',      category: 'digital' }, // ignored (digital PACKAGE, cart_download=0)
};

const predicates = makePredicates(productWeights);

// Line-item builder: minimal canonical shape (only sku + flags matter here).
function li(sku, flags = {}) {
  return { sku, flags };
}

// [name, lineItems, wantEligible, blockingMustContain?]
const cases = [
  // 1. Digital-only → NOT eligible. Exercises BOTH the download flag path
  //    (SKU 25 with cart_download=1) AND the digital-by-config path (5D,
  //    which carries cart_download=0 — the Phase 45 landmine).
  ['digital-only (download flag + digital package) → not eligible',
    [li('25', { download: true }), li('5D', {})], false, []],

  // 2. Prints-only, all eligible → eligible.
  ['prints-only, all eligible → eligible',
    [li('8', {}), li('10', {})], true, []],

  // 3. Prints + a physical NON-print item that is NOT eligible → not eligible.
  ['prints + ineligible physical (mug) → not eligible',
    [li('8', {}), li('20', {})], false, ['20']],

  // 4. Prints + modifier-type add-on → eligible. Modifier add-ons never
  //    become line items (folded into the parent's productName), so the
  //    order's lineItems are just the print. The `modifiers` array on the
  //    parent is illustrative; the eligibility function ignores it.
  ['prints + modifier add-on (not a line item) → eligible',
    [{ sku: '8', flags: {}, modifiers: [{ optId: '99', suffix: 'GiftWrapped' }] }], true, []],

  // 5. Prints + product-type add-on that IS eligible → eligible. The add-on
  //    is a synthetic line item (isAddonItem) evaluated by its own SKU.
  ['prints + eligible product add-on → eligible',
    [li('8', {}), li('12', { isAddonItem: true })], true, []],

  // 6. Prints + product-type add-on that is NOT eligible → not eligible.
  ['prints + ineligible product add-on → not eligible',
    [li('8', {}), li('19', { isAddonItem: true })], false, ['19']],

  // 7. Empty / no items → not eligible (needs ≥1 physical item).
  ['empty order → not eligible', [], false, []],

  // 8. Package header is ignored; eligible constituents make the order
  //    eligible. The header SKU ('1') is not in productWeights and carries
  //    no eligible flag, but it's skipped as a header so never blocks.
  ['package header ignored + eligible constituents → eligible',
    [li('1', { isPackageHeader: true, package: true }), li('8', { isPackageItem: true }), li('10', { isPackageItem: true })],
    true, []],

  // 9. Specialty item in order → NOT eligible, specialty SKU in blockingSkus.
  ['prints + specialty item (statuette) → not eligible, SKU blocks',
    [li('8', {}), li('14', {})], false, ['14']],

  // 10. Drop-ship item in order → NOT eligible, drop-ship SKU in blockingSkus.
  ['prints + drop-ship item → not eligible, SKU blocks',
    [li('8', {}), li('36', {})], false, ['36']],

  // 11. Eligible print alongside a digital → eligible (digital ignored, does
  //     not disqualify, and a single physical item satisfies the ≥1 rule).
  ['eligible print + digital download → eligible (digital ignored)',
    [li('8', {}), li('25', { download: true })], true, []],
];

let pass = 0;
const fails = [];
for (const [name, items, wantEligible, blockingMustContain] of cases) {
  const got = compute(items, predicates);
  let ok = got.eligible === wantEligible;
  // When the case names blocking SKUs, every one must appear in blockingSkus.
  if (ok && Array.isArray(blockingMustContain) && blockingMustContain.length) {
    ok = blockingMustContain.every((s) => got.blockingSkus.map(String).includes(String(s)));
  }
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`         got ${JSON.stringify(got)} want eligible=${wantEligible}` +
      (blockingMustContain && blockingMustContain.length ? ` blockingSkus⊇${JSON.stringify(blockingMustContain)}` : ''));
  }
}

console.log(`\n${pass}/${cases.length} instant-pack eligibility cases pass`);
if (fails.length) {
  console.error('FAILURES:\n  ' + fails.join('\n  '));
  process.exit(1);
}
process.exit(0);
