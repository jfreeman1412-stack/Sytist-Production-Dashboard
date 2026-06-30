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
// Phase 77 adds the SQL-parity section. Phase 60a's note ("when 60b adds a
// tab/count, a SQL parity check must be added") earned its keep here — the
// orders-list "⚡ Instant-Ship Only" toggle is the filter-tab case the
// landmine warned about. The SQL predicate
// (_buildInstantPackSqlPredicate, with its JS-side mirror
// _evaluateInstantPackSqlAlgorithmFromCartRows) MUST classify the same set
// the JS computation does on every non-addon fixture case. Addons are the
// documented A2-scope divergence; we exercise one explicit case so future
// readers see the divergence and don't "fix" it into a JS↔SQL drift.

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
  // Phase 79: every existing case is a SKU-rule test (the section above
  // covers the per-line physical / digital / package rules). Pass
  // workflow='ship_to_home' so the Phase 79 gate is satisfied and the
  // case exercises what it's intended to — the SKU logic. Workflow-gate
  // coverage lives in its own section below.
  const got = compute(items, predicates, 'ship_to_home');
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

// ─── Phase 79: workflow gate (JS-side _computeInstantPackEligibility) ─────
//
// The rule's first clause: workflow MUST be 'ship_to_home'. Literal allow-
// list (not a deny-list), default-deny on missing/unknown, matches Phase 60a's
// SKU default-deny discipline at a different layer. Explicit cases for each
// non-home workflow so the rule's intent is documented in the harness, not
// just implied by "not ship_to_home → fail".
console.log('\n--- Phase 79 JS workflow gate ---');
const workflowGateCases = [
  // Positive: ship_to_home + eligible SKUs → eligible.
  ['ship_to_home + eligible prints → eligible',
    'ship_to_home', [li('8', {}), li('10', {})], true],
  // The three non-home workflows: each ineligible regardless of SKU.
  ['ship_to_managers + eligible prints → ineligible (gate fires)',
    'ship_to_managers', [li('8', {}), li('10', {})], false],
  ['ship_to_league + eligible prints → ineligible (gate fires)',
    'ship_to_league', [li('8', {}), li('10', {})], false],
  ['digital + eligible prints → ineligible (gate fires; explicit allow-list)',
    'digital', [li('8', {}), li('10', {})], false],
  // Missing / unknown workflow: default-deny (the principal Phase 60a/79 rule).
  ['undefined workflow + eligible prints → ineligible (default-deny on missing)',
    undefined, [li('8', {}), li('10', {})], false],
  ['unknown workflow value + eligible prints → ineligible (default-deny on unknown)',
    'ship_to_custom', [li('8', {}), li('10', {})], false],
  // Combined: ship_to_home + ineligible SKU → still ineligible (rule 2 still fires
  // under rule 1; the workflow gate is the OUTER guard, not a bypass).
  ['ship_to_home + ineligible SKU (mug) → ineligible (rule 2 still applies)',
    'ship_to_home', [li('8', {}), li('20', {})], false],
];
let wfPass = 0;
const wfFails = [];
for (const [name, workflow, items, wantEligible] of workflowGateCases) {
  const got = compute(items, predicates, workflow);
  const ok = got.eligible === wantEligible;
  if (ok) {
    wfPass++;
    console.log(`  PASS  ${name}`);
  } else {
    wfFails.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`         got ${JSON.stringify(got)} want eligible=${wantEligible}`);
  }
}

console.log(`\n${pass}/${cases.length} instant-pack SKU-rule cases pass`);
console.log(`${wfPass}/${workflowGateCases.length} Phase 79 workflow-gate cases pass`);
pass += wfPass;
fails.push(...wfFails);
const totalCases = cases.length + workflowGateCases.length;
console.log(`\n${pass}/${totalCases} JS-side total`);

// ─── Phase 77: SQL-parity section ──────────────────────────────────────
//
// Each parity case carries:
//   - jsLineItems: what _computeInstantPackEligibility receives (after
//                   JS-side package + addon expansion)
//   - cartRows:    what the SQL predicate sees (raw ms_cart rows)
//   - wantEligible: the expected classification (JS = SQL, except for the
//                   one explicitly-divergent addon case below)
//
// The SQL evaluator (_evaluateInstantPackSqlAlgorithmFromCartRows) is the JS
// encoding of _buildInstantPackSqlPredicate's algorithm — same inputs the
// SQL would have, same boolean answer. The two are commented as parallel
// encodings; code review verifies they match, this harness verifies the JS
// encoding agrees with _computeInstantPackEligibility.

const sqlEval = sytistDb._evaluateInstantPackSqlAlgorithmFromCartRows;
if (typeof sqlEval !== 'function') {
  console.error('FAIL: sytistDbService._evaluateInstantPackSqlAlgorithmFromCartRows is not exposed');
  process.exit(1);
}

// Precomputed lists matching what _loadInstantPackEligibleSkuList /
// _loadDigitalSkuList would produce against the fixture's productWeights
// AND a fixture packages table:
//   Package '1'  → contents [8, 10]      — both individually eligible ⇒ '1' passes
//   Package 'GOLD' → contents [8, 25]    — 25 is digital; 8 is eligible ⇒ 'GOLD' passes (non-digital constituent is all-eligible)
//   Package 'BADPKG' → contents [8, 20]  — 20 is ineligible (Mouse Pad) ⇒ 'BADPKG' fails (a non-digital constituent is not eligible)
//   Package 'ALLDIGITAL' → contents [25, 5D] — every constituent is digital ⇒ 'ALLDIGITAL' fails (no non-digital constituents = no physical items)
// And a fixture addon_mappings shape:
//   opt_id '62' → product, sku '25' (digital — NOT blocking, addon would be skipped via download flag)
//   opt_id '70' → product, sku '19' (Mouse Pad — ineligible non-digital ⇒ BLOCKING)
//   opt_id '71' → product, sku '12' (8 Wallets — eligible ⇒ NOT blocking)
//   opt_id '99' → modifier (no sku, ignored)
const eligibleSkus = ['8', '10', '12', '1', 'GOLD'];
const digitalSkus = ['25', '5D'];
// Phase 77 Option X: the blocking-addon opt_ids the SQL predicate would
// receive from _loadInstantPackBlockingAddonOptIds against the fixture
// addon-mappings + the eligible/digital lists above. Only '70' qualifies:
// 62 maps to a digital sku (skipped), 71 maps to an eligible sku, 99 is a
// modifier (no sku, doesn't expand).
const blockingAddonOptIds = ['70'];

// Cart row builder — explicit zeros for every skip-flag column so the
// fixture is unambiguous. The seven columns mirror INSTANT_PACK_SKIP_FLAGS
// in lockstep. Adding a new skip flag means adding both: a column here AND
// the matching const _physicalForInstantPackSqlFragment column AND the
// matching INSTANT_PACK_SKIP_FLAGS entry — same maintenance contract as the
// Phase 64 non-product-line landmine.
//
// cart_id is required for the Phase 77 Option X addon-blocking check (the
// SQL JOIN on ms_cart_options.co_cart_id = ms_cart.cart_id). The harness
// auto-assigns sequential ids when not overridden — most non-addon cases
// don't care, but the addon-case fixture passes explicit ids to make the
// parent↔option relationship visible.
let _nextCartId = 1;
function row(sku, overrides = {}) {
  const cartId =
    overrides && Object.prototype.hasOwnProperty.call(overrides, 'cart_id')
      ? overrides.cart_id
      : _nextCartId++;
  return {
    cart_id: cartId,
    cart_sku: sku,
    cart_download: 0,
    cart_gift_certificate: 0,
    cart_credit_product: 0,
    cart_booking: 0,
    cart_pre_sell: 0,
    cart_pre_register_id: 0,
    cart_coupon: 0,
    ...overrides,
  };
}

// Phase 77 Option X: ms_cart_options row builder. co_cart_id links to a
// parent ms_cart row (use the same cart_id as the matching `row(...)`),
// co_opt_id is the addon mapping ID.
function opt(parentCartId, optId, overrides = {}) {
  return {
    co_cart_id: parentCartId,
    co_opt_id: optId,
    co_download: 0,
    ...overrides,
  };
}

// Fixture shape: each case is a tuple
//   [name, jsLineItems, cartRows, cartOptions, wantJsEligible, wantSqlEligible, knownDivergence?]
// cartOptions is optional — most cases pass []. Phase 77 Option X uses
// cartOptions for the addon-blocking-side check; the documented-divergence
// case still exists but now exercises the UNDERCOUNT direction only (the
// overcount direction it used to demonstrate is closed by Option X).
const parityCases = [
  // The bread-and-butter case: two prints, both eligible, both at cart level
  // and at expansion level — JS and SQL must agree.
  ['parity: two eligible prints',
    [li('8', {}), li('10', {})],
    [row('8'), row('10')], [], true, true, false],

  // Specialty SKU at the cart level — both sides see it directly, both
  // mark ineligible (default-deny means SKU 14 isn't in the passing list).
  ['parity: print + specialty (statuette) → both ineligible',
    [li('8', {}), li('14', {})],
    [row('8'), row('14')], [], false, false, false],

  // Skip-flag parity: a gift cert + a real print. The JS-side
  // INSTANT_PACK_SKIP_FLAGS rule and the SQL stricter-physical predicate
  // both skip the gift cert, so the order's eligibility hinges on the
  // print alone (eligible). This is the case Phase 64's landmine
  // protects — non-product line items must NOT block eligibility just
  // because the cart row exists.
  ['parity: gift cert + eligible print → both eligible (gift cert is skip-flagged in JS+SQL)',
    [li('8', {})],
    [row('8'), row('1', { cart_gift_certificate: 1 })], [], true, true, false],

  // Same shape, every skip-flag column — each must be checked or the JS↔SQL
  // gap re-opens.
  ['parity: every skip-flag column + eligible print → both eligible',
    [li('8', {})],
    [
      row('8'),
      row('downloadOnly',     { cart_download: 1 }),
      row('giftCertOnly',     { cart_gift_certificate: 1 }),
      row('creditProductOnly',{ cart_credit_product: 7 }),
      row('bookingOnly',      { cart_booking: 99 }),
      row('preSellOnly',      { cart_pre_sell: 1 }),
      row('preRegisterOnly',  { cart_pre_register_id: 42 }),
      row('couponOnly',       { cart_coupon: 5 }),
    ],
    [], true, true, false],

  ['parity: digital-by-config (5D) + eligible print → both eligible',
    [li('8', {}), li('5D', {})],
    [row('8'), row('5D')], [], true, true, false],

  ['parity: digital-only (5D alone) → both ineligible',
    [li('5D', {})],
    [row('5D')], [], false, false, false],

  ['parity: package parent (SKU 1, all-eligible constituents) → both eligible',
    [li('1', { isPackageHeader: true, package: true }),
     li('8', { isPackageItem: true }), li('10', { isPackageItem: true })],
    [row('1')], [], true, true, false],

  ['parity: package with digital constituent (GOLD = 8 + 25) → both eligible',
    [li('GOLD', { isPackageHeader: true, package: true }),
     li('8',  { isPackageItem: true }),
     li('25', { isPackageItem: true, download: true })],
    [row('GOLD')], [], true, true, false],

  ['parity: package with ineligible constituent (BADPKG = 8 + 20 mug) → both ineligible',
    [li('BADPKG', { isPackageHeader: true, package: true }),
     li('8',  { isPackageItem: true }),
     li('20', { isPackageItem: true })],
    [row('BADPKG')], [], false, false, false],

  ['parity: 100%-digital package (ALLDIGITAL = 25 + 5D) → both ineligible',
    [li('ALLDIGITAL', { isPackageHeader: true, package: true }),
     li('25', { isPackageItem: true, download: true }),
     li('5D', { isPackageItem: true, download: true })],
    [row('ALLDIGITAL')], [], false, false, false],

  // ── Phase 77 Option X: addon BLOCKING-SIDE strict parity ────────────
  //
  // The case that drove Option X: a Memory Mate (SKU 6) parent + a product-
  // type magnet addon (opt_id 70 → SKU 19 Mouse Pad ineligible). Without
  // Option X, the SQL saw only the eligible parent → SQL "eligible" while
  // JS correctly classified the addon synthetic line item as blocking →
  // 50% overcount in live data. With Option X's blocking-opt-ids list +
  // NOT EXISTS clauses, SQL also sees the blocking addon → both
  // ineligible. We exercise the magnet-on-Memory-Mate shape directly (the
  // most common in-filter case) using fixture SKUs that match the
  // canonical example — '6' isn't in the harness's productWeights as
  // eligible (so it stands for "would-be eligible" only inasmuch as we
  // care about parity; the fixture uses '8' since both 8 and Memory Mate
  // are eligible-list members in the real config).
  ['parity (Option X): eligible print + ineligible magnet addon → both ineligible (SQL catches via blocking-opt-ids)',
    [li('8', {}), li('19', { isAddonItem: true })],
    [row('8', { cart_id: 100 })],
    [opt(100, '70')],
    false, false, false],

  // Modifier addon (opt_id '99', no sku, doesn't expand) on an eligible
  // parent: JS ignores it (modifier addons never become line items), SQL
  // ignores it (modifiers aren't in the blocking-opt-id list because they
  // have no sku). Both eligible.
  ['parity (Option X): eligible print + modifier addon (opt 99) → both eligible',
    [li('8', {})],
    [row('8', { cart_id: 101 })],
    [opt(101, '99')],
    true, true, false],

  // Eligible product addon (opt_id '71' → SKU 12 Wallets, eligible). JS
  // sees the parent and addon both eligible. SQL sees the parent (eligible)
  // and the addon's opt_id is NOT in the blocking list. Both eligible.
  ['parity (Option X): eligible print + eligible product addon (opt 71 → Wallets) → both eligible',
    [li('8', {}), li('12', { isAddonItem: true })],
    [row('8', { cart_id: 102 })],
    [opt(102, '71')],
    true, true, false],

  // Digital product addon (opt_id '62' → SKU 25 Digital Download). JS sees
  // the addon synthetic with flags.download=true (set by _expandAddonLineItems'
  // isDigital override) → skipped → doesn't block. SQL sees the addon's
  // opt_id is NOT in the blocking list (digital SKUs are excluded by the
  // loader). Both eligible.
  ['parity (Option X): eligible print + digital product addon (opt 62 → 25) → both eligible',
    [li('8', {}), li('25', { isAddonItem: true, download: true })],
    [row('8', { cart_id: 103 })],
    [opt(103, '62')],
    true, true, false],

  // Skip-flag parent + ineligible product addon. The parent's skip flag
  // means the addon synthetic inherits it in JS (_expandAddonLineItems
  // spreads `...li.flags`) → addon synthetic is skip-flagged → JS skips
  // BOTH parent and addon → no physical items → JS INELIGIBLE.
  // SQL: parent isn't physical (skip flag) so the blocking-addon NOT
  // EXISTS clause's `physical predicate for parent` is false → addon is
  // ignored. The parent itself isn't blocking (it's skip-flagged so not
  // physical, doesn't trigger the (B) NOT EXISTS clause either). The (A)
  // ≥1 physical eligible check fails. SQL INELIGIBLE. Both agree.
  // This is the case where Option X correctly does NOT fire on a
  // skip-flagged parent — the addon would be skipped by JS too.
  ['parity (Option X): skip-flagged parent + ineligible addon → both ineligible (no physical items either side)',
    [li('downloadParent', { download: true })],
    [row('downloadParent', { cart_id: 104, cart_download: 1 })],
    [opt(104, '70')],
    false, false, false],

  // ── DOCUMENTED DIVERGENCE — the deferred undercount-only edge case ───
  //
  // Option X closes the OVERCOUNT direction (parent eligible + ineligible
  // addon, the 50%-in-filter case). The UNDERCOUNT direction stays open by
  // design: parent skip-flagged + ELIGIBLE product addon. JS sees the
  // parent skipped (skip flag) BUT the addon's synthetic inherits the
  // parent's flags (`...li.flags`) including the skip flag → addon
  // synthetic is also skipped in JS → no physical items → JS INELIGIBLE.
  // So this is actually NOT a divergence after all in our skip-flag
  // inheritance model — both sides reach the same answer via different
  // paths. Including this as a non-divergence sanity check:
  ['parity (verify undercount-non-case): skip-flagged parent + eligible addon → both ineligible',
    [li('downloadParent', { download: true })],
    [row('downloadParent', { cart_id: 105, cart_download: 1 })],
    [opt(105, '71')],
    false, false, false],
];

let parityPass = 0;
const parityFails = [];
console.log('\n--- Phase 77 Option X: JS↔SQL parity (addon-blocking-side closed) ---');
for (const [name, jsItems, cartRows, cartOptions, wantJs, wantSql, knownDivergence] of parityCases) {
  // Phase 79: every existing parity case targets SKU-rule parity. Pass
  // workflow='ship_to_home' on both sides so the Phase 79 gate is
  // satisfied; gate-specific parity coverage lives in the new section below.
  const jsRes = compute(jsItems, predicates, 'ship_to_home');
  const sqlRes = sqlEval(cartRows, {
    eligibleSkus,
    digitalSkus,
    cartOptions,
    blockingAddonOptIds,
    workflow: 'ship_to_home',
  });
  const jsOk = jsRes.eligible === wantJs;
  const sqlOk = sqlRes.eligible === wantSql;
  const parityOk = knownDivergence
    ? jsRes.eligible !== sqlRes.eligible // divergence cases REQUIRE disagreement
    : jsRes.eligible === sqlRes.eligible;
  const allOk = jsOk && sqlOk && parityOk;
  if (allOk) {
    parityPass++;
    const tag = knownDivergence ? '  PASS  (documented divergence)' : '  PASS ';
    console.log(`${tag} ${name}`);
  } else {
    parityFails.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`         js=${jsRes.eligible} want=${wantJs}; sql=${sqlRes.eligible} want=${wantSql}; parityOk=${parityOk}`);
  }
}

console.log(`\n${parityPass}/${parityCases.length} Phase 77 JS↔SQL parity cases pass`);

// ─── Phase 79: JS↔SQL workflow-gate parity ─────────────────────────────
//
// Eligible-SKU fixture intact (same cart row 8 used as the "would pass SKU
// rules" case). Each case asserts: JS gate result = SQL gate result for the
// given workflow value. The SKU rules are held constant (an eligible print);
// only the workflow varies. The four classified workflows + the undefined +
// the unknown-value case round out the gate's decision surface.
console.log('\n--- Phase 79: JS↔SQL workflow-gate parity ---');
const gateParityCases = [
  // workflow, wantJs, wantSql
  ['ship_to_home  → both eligible',      'ship_to_home',     true,  true],
  ['ship_to_managers → both ineligible', 'ship_to_managers', false, false],
  ['ship_to_league → both ineligible',   'ship_to_league',   false, false],
  ['digital → both ineligible',          'digital',          false, false],
  ['undefined → both ineligible (default-deny)', undefined,  false, false],
  ['unknown value → both ineligible (default-deny)', 'ship_to_custom', false, false],
];
let gatePass = 0;
const gateFails = [];
for (const [name, workflow, wantJs, wantSql] of gateParityCases) {
  const jsItems = [li('8', {})]; // eligible print, SKU rule satisfied
  const cartRows = [row('8', { cart_id: 200 })];
  const jsRes = compute(jsItems, predicates, workflow);
  const sqlRes = sqlEval(cartRows, {
    eligibleSkus,
    digitalSkus,
    cartOptions: [],
    blockingAddonOptIds,
    workflow,
  });
  const jsOk = jsRes.eligible === wantJs;
  const sqlOk = sqlRes.eligible === wantSql;
  const parityOk = jsRes.eligible === sqlRes.eligible;
  if (jsOk && sqlOk && parityOk) {
    gatePass++;
    console.log('  PASS  ' + name);
  } else {
    gateFails.push(name);
    console.log('  FAIL  ' + name);
    console.log(`         js=${jsRes.eligible} want=${wantJs}; sql=${sqlRes.eligible} want=${wantSql}; parityOk=${parityOk}`);
  }
}

console.log(`\n${gatePass}/${gateParityCases.length} Phase 79 workflow-gate parity cases pass`);

const totalPass = pass + parityPass + gatePass;
const totalCount = cases.length + workflowGateCases.length + parityCases.length + gateParityCases.length;
console.log(`\n${totalPass}/${totalCount} total instant-pack cases pass`);

if (fails.length || parityFails.length || gateFails.length) {
  console.error('FAILURES:\n  ' + [...fails, ...parityFails, ...gateFails].join('\n  '));
  process.exit(1);
}
process.exit(0);
