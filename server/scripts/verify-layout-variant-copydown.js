// Phase 57A — verification harness for the variant-split copy-down.
//
// This is the gate between render-correctness (Phase 57A) and operator
// divergence (Phase 57B). It must pass before Phase 57A ships. It
// proves the migration + the compositeService variant-first/root-
// fallback are a pure no-op on render output for every populated
// (layout, variant) case, plus the structural and idempotency
// invariants that were signed off.
//
// For each layout it constructs:
//   preLayout  = the layout with variant-level copy-keys stripped
//                (canonical pre-migration shape — robust whether or not
//                the on-disk file has already been migrated). Rendering
//                this exercises the root-fallback path.
//   postLayout = migrateOneLayout(clone(preLayout)) — variant now owns
//                its copied keys. Rendering this exercises the
//                variant-first path.
// Identical synthetic inputs are rendered through both; the JPEG bytes
// must be identical (same inputs + same code path + variant value ==
// root value ⇒ deterministic equality).
//
// Asserts per layout:
//   1. RENDER: for each populated variant, pre vs post buffers are
//      byte-identical and same dimensions.
//   2. STRUCTURAL: root copy-keys unchanged by migration; every
//      populated variant gained each root-present copy-key with a value
//      deep-equal to the root; variant-name set unchanged (no fabricated
//      variant); empty/0-slot variants untouched.
//   3. IDEMPOTENT: migrating an already-migrated layout copies 0 keys
//      and leaves it deep-equal (the operator-requested double-run
//      test), plus a document-level double-run check.
//
// Run from server/:  node scripts/verify-layout-variant-copydown.js
// Exit code 0 = all green (safe to ship 57A); 1 = a failure (do NOT
// ship, do NOT let operators diverge layouts).

const fs = require('fs');
const { isDeepStrictEqual } = require('util');
const sharp = require('sharp');
const compositeService = require('../services/compositeService');
const {
  migrateLayoutsData,
  migrateOneLayout,
  COPY_KEYS,
} = require('./migrate-layout-variant-copydown');

function clone(v) {
  return structuredClone(v);
}

// A populated variant has a real, non-empty slots array. Only these are
// render-verified and only these are touched by the migration.
function isPopulated(variant) {
  return (
    variant &&
    typeof variant === 'object' &&
    Array.isArray(variant.slots) &&
    variant.slots.length >= 1
  );
}

// Canonical pre-migration shape: strip variant-level copy-keys so the
// render goes through the root fallback regardless of disk state.
function stripVariantCopyKeys(layout) {
  const out = clone(layout);
  for (const vName of Object.keys(out.variants || {})) {
    const v = out.variants[vName];
    if (!v || typeof v !== 'object') continue;
    for (const k of COPY_KEYS) delete v[k];
  }
  return out;
}

// Deterministic, self-contained inputs — solid-colour JPEGs. Same bytes
// fed to the pre and post render, so any placeholder/missing-token
// behaviour is identical on both sides by construction.
async function solid(width, height, rgb) {
  return sharp({
    create: { width, height, channels: 3, background: rgb },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function buildInputs() {
  const [playerPhoto, teamPhoto, logo, playerBackground] = await Promise.all([
    solid(2400, 2400, { r: 200, g: 40, b: 40 }),
    solid(2400, 2400, { r: 40, g: 160, b: 60 }),
    solid(1200, 1200, { r: 40, g: 80, b: 200 }),
    solid(2400, 2400, { r: 120, g: 120, b: 120 }),
  ]);
  return { playerPhoto, teamPhoto, logo, playerBackground };
}

async function renderCase(layout, variant, inputs) {
  const res = await compositeService.buildSheetBuffer({
    layout,
    variant,
    playerPhoto: inputs.playerPhoto,
    teamPhoto: inputs.teamPhoto,
    logo: inputs.logo,
    playerBackground: inputs.playerBackground,
    tokens: { overlays: {} },
  });
  return res;
}

async function main() {
  const raw = fs.readFileSync(compositeService.LAYOUTS_PATH, 'utf8');
  const doc = JSON.parse(raw);
  const layouts = Array.isArray(doc.layouts) ? doc.layouts : doc;
  const inputs = await buildInputs();

  const rows = [];
  let fail = 0;
  let renderCases = 0;

  for (const onDisk of layouts) {
    const preLayout = stripVariantCopyKeys(onDisk);
    const postLayout = clone(preLayout);
    migrateOneLayout(postLayout);

    // ── STRUCTURAL ──────────────────────────────────────────
    let structural = 'ok';

    // Root copy-keys must be untouched by the migration.
    for (const k of COPY_KEYS) {
      if (!isDeepStrictEqual(postLayout[k], preLayout[k])) {
        structural = `root.${k} mutated`;
      }
    }
    // Variant-name set unchanged — no fabricated variant.
    if (
      !isDeepStrictEqual(
        Object.keys(preLayout.variants || {}).sort(),
        Object.keys(postLayout.variants || {}).sort()
      )
    ) {
      structural = 'variant set changed';
    }
    for (const vName of Object.keys(preLayout.variants || {})) {
      const preV = preLayout.variants[vName];
      const postV = postLayout.variants[vName];
      if (!isPopulated(preV)) {
        // Empty/0-slot variant must be byte-for-byte untouched.
        if (!isDeepStrictEqual(preV, postV)) {
          structural = `empty variant ${vName} mutated`;
        }
        continue;
      }
      // Populated: every root-present copy-key copied down, equal value.
      for (const k of COPY_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(preLayout, k)) continue;
        if (!Object.prototype.hasOwnProperty.call(postV, k)) {
          structural = `${vName} missing ${k}`;
        } else if (!isDeepStrictEqual(postV[k], preLayout[k])) {
          structural = `${vName}.${k} != root`;
        }
      }
    }

    // ── IDEMPOTENT (per-layout double run) ──────────────────
    const post2 = clone(postLayout);
    const copiedOnSecondRun = migrateOneLayout(post2);
    const idempotent =
      copiedOnSecondRun === 0 && isDeepStrictEqual(postLayout, post2)
        ? 'ok'
        : `2nd run copied ${copiedOnSecondRun}`;

    // ── RENDER (per populated variant) ──────────────────────
    for (const vName of Object.keys(preLayout.variants || {})) {
      if (!isPopulated(preLayout.variants[vName])) continue;
      renderCases += 1;

      let render = 'ok';
      try {
        const a = await renderCase(preLayout, vName, inputs);
        const b = await renderCase(postLayout, vName, inputs);
        const sameBytes = Buffer.compare(a.buffer, b.buffer) === 0;
        const sameDims = isDeepStrictEqual(a.dimensions, b.dimensions);
        if (!sameBytes || !sameDims) {
          render = `MISMATCH bytes=${sameBytes} dims=${sameDims} ` +
            `(${a.dimensions.width}x${a.dimensions.height} vs ` +
            `${b.dimensions.width}x${b.dimensions.height})`;
        }
      } catch (err) {
        render = `THREW: ${err.message}`;
      }

      const ok =
        render === 'ok' && structural === 'ok' && idempotent === 'ok';
      if (!ok) fail += 1;
      rows.push({
        layout: onDisk.id,
        variant: vName,
        slots: preLayout.variants[vName].slots.length,
        render,
        structural,
        idempotent,
        ok,
      });
    }
  }

  // ── Document-level idempotency: migrate twice, 2nd is a no-op ──
  const docA = migrateLayoutsData(clone(doc)).data;
  const second = migrateLayoutsData(clone(docA));
  const docIdempotent =
    second.summary.keysCopied === 0 && isDeepStrictEqual(docA, second.data);
  if (!docIdempotent) fail += 1;

  // ── Report ──────────────────────────────────────────────
  console.log('Phase 57A — variant-split copy-down verification\n');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad('LAYOUT', 14),
    pad('VARIANT', 12),
    pad('SLOTS', 6),
    pad('RENDER', 10),
    pad('STRUCT', 10),
    pad('IDEMPOT', 10)
  );
  console.log('-'.repeat(70));
  for (const r of rows) {
    console.log(
      pad(r.layout, 14),
      pad(r.variant, 12),
      pad(r.slots, 6),
      pad(r.render === 'ok' ? 'ok' : 'FAIL', 10),
      pad(r.structural === 'ok' ? 'ok' : 'FAIL', 10),
      pad(r.idempotent === 'ok' ? 'ok' : 'FAIL', 10)
    );
    if (!r.ok) {
      if (r.render !== 'ok') console.log(`    render:    ${r.render}`);
      if (r.structural !== 'ok') console.log(`    structural: ${r.structural}`);
      if (r.idempotent !== 'ok') console.log(`    idempotent: ${r.idempotent}`);
    }
  }
  console.log('-'.repeat(70));
  console.log(
    `render cases: ${renderCases}  |  ` +
      `doc-level idempotent: ${docIdempotent ? 'ok' : 'FAIL'}  |  ` +
      `failures: ${fail}`
  );

  if (fail > 0) {
    console.log('\n❌ FAIL — do NOT ship Phase 57A, do NOT diverge layouts.');
    process.exit(1);
  }
  console.log('\n✅ PASS — migration + fallback is a render no-op on all cases.');
}

main().catch((err) => {
  console.error('verify harness crashed:', err);
  process.exit(1);
});
