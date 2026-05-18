// Phase 57A — composite-layout variant split: copy-down migration.
//
// Background: until Phase 57 the layout-level properties (sheetWidth,
// sheetHeight, dpi, backgroundColor, graphics) lived ONLY at the layout
// root and were shared by both variants. Phase 57 makes vertical and
// horizontal fully independent designs. This script performs the
// one-time, lossless "copy-down": for every populated variant it copies
// the current root value of each of those keys INTO the variant, so the
// variant now owns its own (initially identical) value and can later be
// diverged in the designer (Phase 57B).
//
// Invariants (signed off before implementation):
//   - NON-DESTRUCTIVE: root keys are copied, never deleted. They remain
//     as the deprecated fallback compositeService reads when a variant
//     has no own key. An interrupted/partial migration still renders
//     correctly; there is no flag day.
//   - ONLY POPULATED VARIANTS: a variant is touched only if it has a
//     slots array with >= 1 slot. Empty/absent variants are left alone
//     so pickVariant's vertical-only fallback is unchanged (7 of 10
//     layouts are vertical-only).
//   - IDEMPOTENT: a variant that already owns a key is left as-is
//     (respects an already-diverged value). Re-running is a verified
//     no-op (keysCopied === 0, output deep-equals input).
//   - ATOMIC: the file is written via tmp + rename, never in place.
//
// Usage:
//   node scripts/migrate-layout-variant-copydown.js            # migrate
//   node scripts/migrate-layout-variant-copydown.js --dry-run  # preview
//   node scripts/migrate-layout-variant-copydown.js --check    # exit 1
//                                                  if migration needed
//
// The pure transform (migrateLayoutsData / migrateOneLayout) is exported
// so the Phase 57A verification harness can exercise it in-memory,
// including the double-run idempotency assertion.

const fs = require('fs');
const path = require('path');
const compositeService = require('../services/compositeService');

// The layout-level keys that move from the root into each populated
// variant. Order matters only for readability of the written JSON
// (these land before `slots`, mirroring the root key order).
const COPY_KEYS = [
  'sheetWidth',
  'sheetHeight',
  'dpi',
  'backgroundColor',
  'graphics',
];

function deepClone(value) {
  // structuredClone is available on Node 18+ (this repo runs 22). Used
  // for `graphics` so a variant never shares the root object reference.
  return structuredClone(value);
}

// Migrate a single layout object in place. Returns the number of
// (variant, key) pairs copied for this layout. A variant is rebuilt so
// the copied keys appear before `slots` (matching root key order and
// the schema example signed off with the operator); any pre-existing
// variant keys are preserved in their relative order.
function migrateOneLayout(layout) {
  if (!layout || typeof layout !== 'object' || !layout.variants) return 0;

  let copied = 0;

  for (const variantName of Object.keys(layout.variants)) {
    const variant = layout.variants[variantName];

    // Skip degenerate/empty variants — never fabricate or populate a
    // variant that has no real slots (preserves pickVariant fallback).
    if (
      !variant ||
      typeof variant !== 'object' ||
      !Array.isArray(variant.slots) ||
      variant.slots.length < 1
    ) {
      continue;
    }

    // Resolve, in COPY_KEYS order, what each layout-level key should be
    // for this variant: the variant's own value if it already has one
    // (idempotency — do not clobber a diverged value), otherwise a copy
    // of the root value if the root defines that key.
    const resolvedLeadingKeys = {};
    for (const key of COPY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(variant, key)) {
        resolvedLeadingKeys[key] = variant[key];
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(layout, key)) {
        resolvedLeadingKeys[key] =
          key === 'graphics' ? deepClone(layout[key]) : layout[key];
        copied += 1;
      }
    }

    // Rebuild the variant: resolved layout-level keys first, then every
    // remaining key the variant already had (slots, and anything else)
    // in its original order. Root keys are NOT deleted from the layout.
    const rebuilt = { ...resolvedLeadingKeys };
    for (const k of Object.keys(variant)) {
      if (!Object.prototype.hasOwnProperty.call(rebuilt, k)) {
        rebuilt[k] = variant[k];
      }
    }
    layout.variants[variantName] = rebuilt;
  }

  return copied;
}

// Pure transform over the whole `{ layouts: [...] }` document. Mutates
// and returns the passed object; callers that need the original should
// clone first (the harness does). Returns a summary for reporting and
// for the idempotency assertion.
function migrateLayoutsData(data) {
  const layouts =
    data && Array.isArray(data.layouts)
      ? data.layouts
      : Array.isArray(data)
        ? data
        : null;

  if (!layouts) {
    throw new Error(
      'Unexpected composite-layouts shape — expected { layouts: [...] } or [...]'
    );
  }

  const perLayout = [];
  let keysCopied = 0;
  let layoutsChanged = 0;

  for (const layout of layouts) {
    const copied = migrateOneLayout(layout);
    keysCopied += copied;
    if (copied > 0) layoutsChanged += 1;
    perLayout.push({ id: layout && layout.id, copied });
  }

  return { data, summary: { layoutsChanged, keysCopied, perLayout } };
}

function readLayoutsFile() {
  const raw = fs.readFileSync(compositeService.LAYOUTS_PATH, 'utf8');
  return JSON.parse(raw);
}

// Match the existing file's formatting: 2-space indent, no trailing
// newline (confirmed: the file ends with `}`), written atomically.
function writeLayoutsFileAtomic(data) {
  const target = compositeService.LAYOUTS_PATH;
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}`
  );
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const checkOnly = process.argv.includes('--check');

  const data = readLayoutsFile();
  const { summary } = migrateLayoutsData(data);

  console.log('[Phase57A migrate] layouts touched:', summary.layoutsChanged);
  console.log('[Phase57A migrate] (variant,key) pairs copied:', summary.keysCopied);
  for (const r of summary.perLayout) {
    console.log(`  - ${r.id}: ${r.copied} copied`);
  }

  if (checkOnly) {
    if (summary.keysCopied > 0) {
      console.log('[Phase57A migrate] --check: migration IS needed (exit 1)');
      process.exit(1);
    }
    console.log('[Phase57A migrate] --check: already migrated, no-op (exit 0)');
    process.exit(0);
  }

  if (summary.keysCopied === 0) {
    console.log('[Phase57A migrate] NO-OP: already migrated, file untouched.');
    return;
  }

  if (dryRun) {
    console.log('[Phase57A migrate] --dry-run: NOT writing the file.');
    return;
  }

  writeLayoutsFileAtomic(data);
  console.log('[Phase57A migrate] ✅ wrote', compositeService.LAYOUTS_PATH);
}

if (require.main === module) {
  main();
}

module.exports = { migrateLayoutsData, migrateOneLayout, COPY_KEYS };
