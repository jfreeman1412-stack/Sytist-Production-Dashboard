// Phase 58 hotfix 2 — verification harness for
// `distributeIntegerOzAcrossLines`. Pure-function tests for the
// integer-oz distribution that replaces the lossy oz→g grams round-
// trip at the SS payload boundary.
//
// Operator-specified verification matrix (locked before the diff):
//   1. Floor 5 oz, 2 items (1.7+1.7)            — the real-order
//                                                  regression that
//                                                  surfaced hotfix 2.
//   2. Floor 4 oz, single physical (1.7)        — single-item edge.
//   3. Floor 1 oz, 3 tiny items (0.1 each)      — small-floor edge.
//   4. Floor 7 oz, 4 items (0.5 each)           — typical multi-item.
//   5. Floor 3 oz, mixed digital + 1 physical   — digital skip.
//   6. Pathological 5×0.6 oz floor 3            — absorber clamp.
//   7. All-digital order                        — no absorber.
//   8. Empty itemWeights                        — empty out.
//
// The 1/4/7 case is the headline reproducer: pre-hotfix-2 it produced
// 142 g order-level + 143 g per-item sum → 5.04 oz in SS → 6 oz tier.
// Post-hotfix-2 the distribution returns [3, 2] integer oz summing to
// 5 — SS receives `units: 'ounces'` integers and bills 5 oz tier.
//
// Run from server/:  node scripts/verify-weight-distribution.js
// Exit 0 = clean. Exit 1 = a case failed.

const assert = require('assert');
const {
  distributeIntegerOzAcrossLines,
} = require('../services/shipstationService');

let pass = 0;
let fail = 0;
function it(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

// Sum the integer-oz output, treating undefined as 0.
function sumValues(map) {
  return Object.values(map).reduce((s, v) => s + (v || 0), 0);
}

console.log('Phase 58 hotfix 2 — distributeIntegerOzAcrossLines\n');

console.log('A. Operator-specified verification matrix');

it('case 1: floor 5 oz, 2 items (1.7+1.7) — real-order regression', () => {
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'k1', sku: '15', weightOz: 1.7 },
      { lineItemKey: 'k2', sku: '17', weightOz: 1.7 },
    ],
    5
  );
  // Absorber = k1 (first physical). Non-absorber k2 rounds 1.7 → 2.
  // Absorber = 5 − 2 = 3. Sum = 5. Sends [3 oz, 2 oz] to SS.
  assert.strictEqual(out.k1, 3, 'absorber should be 3 oz');
  assert.strictEqual(out.k2, 2, 'non-absorber should round to 2 oz');
  assert.strictEqual(sumValues(out), 5, 'sum must equal floor exactly');
});

it('case 2: floor 4 oz, single physical (raw 1.7)', () => {
  const out = distributeIntegerOzAcrossLines(
    [{ lineItemKey: 'only', sku: '15', weightOz: 1.7 }],
    4
  );
  // Single physical = absorber. No non-absorbers. Absorber = 4 − 0 = 4.
  assert.strictEqual(out.only, 4, 'single physical absorbs full floor');
  assert.strictEqual(sumValues(out), 4);
});

it('case 3: floor 1 oz, 3 tiny items (0.1 each)', () => {
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'a', sku: '10', weightOz: 0.1 },
      { lineItemKey: 'b', sku: '11', weightOz: 0.1 },
      { lineItemKey: 'c', sku: '12', weightOz: 0.1 },
    ],
    1
  );
  // Non-absorbers (b, c) round to 0 each → sum 0. Absorber a = 1 − 0 = 1.
  assert.strictEqual(out.a, 1);
  assert.strictEqual(out.b, 0);
  assert.strictEqual(out.c, 0);
  assert.strictEqual(sumValues(out), 1);
});

it('case 4: floor 7 oz, 4 items (0.5 each) — typical multi-item', () => {
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'a', sku: '10', weightOz: 0.5 },
      { lineItemKey: 'b', sku: '11', weightOz: 0.5 },
      { lineItemKey: 'c', sku: '12', weightOz: 0.5 },
      { lineItemKey: 'd', sku: '13', weightOz: 0.5 },
    ],
    7
  );
  // Non-absorbers (b, c, d) round to 1 each (Math.round(0.5) = 1 in
  // JS — round-half-away-from-zero for positives) → sum 3.
  // Absorber a = 7 − 3 = 4. Sends [4, 1, 1, 1].
  assert.strictEqual(out.a, 4, 'absorber takes the rounding remainder');
  assert.strictEqual(out.b, 1);
  assert.strictEqual(out.c, 1);
  assert.strictEqual(out.d, 1);
  assert.strictEqual(sumValues(out), 7);
});

it('case 5: floor 3 oz, 2 digital + 1 physical (raw 1.5)', () => {
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'dig1', sku: '25', weightOz: 0 },
      { lineItemKey: 'phys', sku: '15', weightOz: 1.5 },
      { lineItemKey: 'dig2', sku: '25', weightOz: 0 },
    ],
    3
  );
  // Digitals stay 0; physical is the first (and only) physical →
  // absorber. Absorber = 3 − 0 = 3.
  assert.strictEqual(out.dig1, 0, 'digital stays 0');
  assert.strictEqual(out.phys, 3, 'physical absorber takes full floor');
  assert.strictEqual(out.dig2, 0, 'digital stays 0');
  assert.strictEqual(sumValues(out), 3);
});

it('case 6: pathological 5×0.6 oz floor 3 — absorber clamps to 0', () => {
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'a', sku: '10', weightOz: 0.6 },
      { lineItemKey: 'b', sku: '11', weightOz: 0.6 },
      { lineItemKey: 'c', sku: '12', weightOz: 0.6 },
      { lineItemKey: 'd', sku: '13', weightOz: 0.6 },
      { lineItemKey: 'e', sku: '14', weightOz: 0.6 },
    ],
    3
  );
  // Non-absorbers (4 items) round to 1 each → sum 4. Absorber would
  // be 3 − 4 = −1; clamped to 0. Sum = 0 + 1 + 1 + 1 + 1 = 4
  // (over-shoots floor by 1). Bounded; very unlikely in production
  // (would require effectively zero baseWeight + ≥5 small items).
  assert.strictEqual(out.a, 0, 'absorber clamps to 0');
  assert.strictEqual(out.b, 1);
  assert.strictEqual(out.c, 1);
  assert.strictEqual(out.d, 1);
  assert.strictEqual(out.e, 1);
  assert.strictEqual(sumValues(out), 4, 'pathological sum over by 1');
});

console.log('\nB. Boundary / null-safety cases');

it('case 7: all-digital order — no absorber, all 0', () => {
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'dig1', sku: '25', weightOz: 0 },
      { lineItemKey: 'dig2', sku: '25', weightOz: 0 },
    ],
    1
  );
  // No physical items → no absorber → all entries 0. Sum (0) does NOT
  // match floor (1) — but that's expected for an all-digital order:
  // there's no physical line to attribute the order weight to, and
  // an all-digital order shouldn't have a meaningful shipping weight
  // anyway. Order-level payload still sends `weightOz` independently.
  assert.strictEqual(out.dig1, 0);
  assert.strictEqual(out.dig2, 0);
  assert.strictEqual(sumValues(out), 0);
});

it('case 8: empty itemWeights — empty map', () => {
  const out = distributeIntegerOzAcrossLines([], 4);
  assert.deepStrictEqual(out, {});
});

it('null-safe: undefined itemWeights', () => {
  const out = distributeIntegerOzAcrossLines(undefined, 4);
  assert.deepStrictEqual(out, {});
});

it('null-safe: lines without lineItemKey are skipped', () => {
  const out = distributeIntegerOzAcrossLines(
    [
      { sku: '15', weightOz: 1.7 }, // no key → skipped
      { lineItemKey: 'k', sku: '15', weightOz: 1.7 },
    ],
    3
  );
  assert.strictEqual(Object.keys(out).length, 1, 'only keyed lines kept');
  assert.strictEqual(out.k, 3, 'keyed line is the absorber');
});

console.log('\nC. Cross-check against the original 4 oz bug (hotfix 1 case)');

it('floor 4 oz, 2 items (3.5+0.5) — sums to 4, not the 113g/3.99oz bug', () => {
  // Hotfix 1 raised 4 oz → 114 g (was 113 g). Hotfix 2 sidesteps the
  // grams round-trip entirely: 3.5 → round 4 (non-absorber? no wait,
  // 3.5 is first → absorber). 0.5 → round 1. Absorber = 4 − 1 = 3.
  // Sends [3 oz, 1 oz]. SS sees 4 oz exactly, bills 4 oz tier.
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'k1', sku: '15', weightOz: 3.5 },
      { lineItemKey: 'k2', sku: '12', weightOz: 0.5 },
    ],
    4
  );
  assert.strictEqual(out.k1, 3);
  assert.strictEqual(out.k2, 1);
  assert.strictEqual(sumValues(out), 4);
});

it('floor 8 oz (round/ceil-agree value) — also exact', () => {
  // 8 oz was the SPEC §58 worked example that coincidentally passed
  // hotfix 1's grams round-trip. Under hotfix 2 it's also exact —
  // but verified explicitly so a regression at the "previously-safe"
  // values doesn't slip past.
  const out = distributeIntegerOzAcrossLines(
    [
      { lineItemKey: 'k1', sku: '20', weightOz: 11.5 },
    ],
    8
  );
  // Single physical absorbs full 8 oz; raw 11.5 is irrelevant for
  // distribution (engine's floor already capped the total).
  assert.strictEqual(out.k1, 8);
  assert.strictEqual(sumValues(out), 8);
});

console.log('\n──────────────');
console.log(`pass: ${pass}  fail: ${fail}`);
if (fail > 0) {
  console.log('\n❌ FAIL — Phase 58 hotfix 2 verification did not pass.');
  process.exit(1);
}
console.log(
  '\n✅ PASS — integer-oz distribution sums correctly across every case.'
);
