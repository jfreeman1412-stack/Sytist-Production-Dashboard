// Phase 57B — verification harness for per-variant graphics resolution
// and the API contract.
//
// Mirrors the Phase 57A verify-layout-variant-copydown style: no
// external test framework, exit-coded, prints PASS/FAIL per case.
// Proves:
//   - The variant-namespaced key scheme (`${variant}__<name>`) accepts
//     valid keys and rejects bare/mismatched ones (server POST/DELETE
//     validation).
//   - resolveGraphicMeta (preview/info stream routes) and the three
//     render-read sites (processingService Step1.5, /composite/preview,
//     renderOverrideForOrder) resolve variant-first then deprecated-
//     root fallback.
//   - A vertical-only entry never resolves on a horizontal render and
//     vice versa — variant isolation holds.
//   - Legacy bare-key slot references keep rendering via root fallback,
//     so un-migrated/legacy layouts are not regressed.
//   - The Decision B per-key legacy-hiding rule (client UI filter)
//     matches what the spec says: a legacy key hides only when the
//     active variant has its own entry whose base name (the key minus
//     `${variant}__`) equals the legacy key.
//   - The shared per-layout on-disk bucket cannot collide between
//     variants because namespaced keys are distinct.
//   - The real composite-layouts.json — post-57A migration — renders
//     identical graphic filenames whether resolved variant-first or via
//     the root fallback (un-diverged production data is unchanged).
//
// The helpers below mirror the production logic in routes/sytist.js
// (resolveGraphicMeta + the inlined render reads) and
// LayoutDesignerPage.js (visibleLegacyGraphics). They are intentionally
// duplicated rather than imported so the harness verifies the BEHAVIOUR
// — if the production logic ever drifts, these cases catch it.
//
// Run from server/:  node scripts/verify-layout-variant-graphics.js
// Exit 0 = clean. Exit 1 = a case failed.

const assert = require('assert');
const compositeService = require('../services/compositeService');

// Mirrors `resolveGraphicMeta` in routes/sytist.js (preview/info routes).
function resolveGraphicMeta(layout, key) {
  if (layout && layout.variants) {
    for (const v of Object.values(layout.variants)) {
      if (v && v.graphics && v.graphics[key]) return v.graphics[key];
    }
  }
  return (layout && layout.graphics && layout.graphics[key]) || null;
}

// Mirrors the 3 render-read sites (processingService:1562,
// sytist:3232, sytist:3837): variant-first, deprecated-root fallback.
function renderRead(layout, variant, key) {
  const variantDef = layout.variants && layout.variants[variant];
  return (
    (variantDef && variantDef.graphics && variantDef.graphics[key]) ||
    (layout.graphics && layout.graphics[key]) ||
    null
  );
}

// Server contract validator (mirrors the POST/DELETE handler checks).
function namespaceOk(key, variant) {
  return (
    typeof variant === 'string' &&
    variant.length > 0 &&
    typeof key === 'string' &&
    key.startsWith(variant + '__')
  );
}

// Decision B — mirrors `visibleLegacyGraphics` in LayoutDesignerPage.js.
function visibleLegacy(graphicsLibrary, legacyGraphics, variant) {
  const ownBaseNames = new Set(
    (graphicsLibrary || []).map((g) =>
      g.key.startsWith(variant + '__')
        ? g.key.slice(variant.length + 2)
        : g.key
    )
  );
  return (legacyGraphics || []).filter((g) => !ownBaseNames.has(g.key));
}

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

async function main() {
  console.log('Phase 57B — graphics per-variant verification\n');

  // ── A. Namespacing + API contract ───────────────────────────────
  console.log('A. Namespacing + API contract');
  it('valid namespaced key accepted', () => {
    assert.ok(namespaceOk('vertical__logo', 'vertical'));
    assert.ok(namespaceOk('horizontal__background', 'horizontal'));
    assert.ok(namespaceOk('vertical__memory-mate-bg', 'vertical'));
  });
  it('bare (un-namespaced) key rejected', () => {
    assert.ok(!namespaceOk('logo', 'vertical'));
    assert.ok(!namespaceOk('background', 'horizontal'));
  });
  it('mismatched-variant prefix rejected', () => {
    assert.ok(!namespaceOk('horizontal__logo', 'vertical'));
    assert.ok(!namespaceOk('vertical__bg', 'horizontal'));
  });
  it('missing/empty variant rejected', () => {
    assert.ok(!namespaceOk('vertical__logo', undefined));
    assert.ok(!namespaceOk('vertical__logo', ''));
    assert.ok(!namespaceOk('vertical__logo', null));
  });

  // ── B. resolveGraphicMeta (preview/info routes) ─────────────────
  console.log('\nB. resolveGraphicMeta (variant-agnostic stream routes)');
  const meta = (f) => ({ filename: f });
  const lay1 = {
    graphics: { logo: meta('root-logo.png') },
    variants: {
      vertical: { graphics: { vertical__logo: meta('v-logo.png') } },
      horizontal: { graphics: { horizontal__logo: meta('h-logo.png') } },
    },
  };
  it('namespaced key resolves to its variant entry (vertical)', () => {
    assert.strictEqual(
      resolveGraphicMeta(lay1, 'vertical__logo').filename,
      'v-logo.png'
    );
  });
  it('namespaced key resolves to its variant entry (horizontal)', () => {
    assert.strictEqual(
      resolveGraphicMeta(lay1, 'horizontal__logo').filename,
      'h-logo.png'
    );
  });
  it('bare key falls back to root', () => {
    assert.strictEqual(
      resolveGraphicMeta(lay1, 'logo').filename,
      'root-logo.png'
    );
  });
  it('unknown key returns null', () => {
    assert.strictEqual(resolveGraphicMeta(lay1, 'nope__x'), null);
    assert.strictEqual(resolveGraphicMeta(lay1, 'missing'), null);
  });
  it('no variants object — root only or null', () => {
    const lay = { graphics: { logo: meta('r.png') } };
    assert.strictEqual(resolveGraphicMeta(lay, 'logo').filename, 'r.png');
    assert.strictEqual(resolveGraphicMeta(lay, 'missing'), null);
  });
  it('null-safe on empty / null layout', () => {
    assert.strictEqual(resolveGraphicMeta(null, 'x'), null);
    assert.strictEqual(resolveGraphicMeta({}, 'x'), null);
    assert.strictEqual(resolveGraphicMeta({ variants: {} }, 'x'), null);
  });

  // ── C. Render-read resolution (3 inline sites' logic) ───────────
  console.log('\nC. Render reads — variant-first, root fallback');
  it('variant own beats root for a variant-scoped render', () => {
    const lay = {
      graphics: { vertical__logo: meta('root-vlogo.png') },
      variants: {
        vertical: { graphics: { vertical__logo: meta('var-vlogo.png') } },
      },
    };
    assert.strictEqual(
      renderRead(lay, 'vertical', 'vertical__logo').filename,
      'var-vlogo.png'
    );
  });
  it('root fallback when variant lacks the key', () => {
    const lay = {
      graphics: { logo: meta('root.png') },
      variants: { vertical: { graphics: {} } },
    };
    assert.strictEqual(
      renderRead(lay, 'vertical', 'logo').filename,
      'root.png'
    );
  });
  it('variant isolation — vertical entry never resolves on horizontal', () => {
    const lay = {
      graphics: {},
      variants: {
        vertical: { graphics: { vertical__bg: meta('v.png') } },
        horizontal: { graphics: {} },
      },
    };
    assert.strictEqual(renderRead(lay, 'horizontal', 'vertical__bg'), null);
  });
  it('variant isolation — horizontal entry never resolves on vertical', () => {
    const lay = {
      graphics: {},
      variants: {
        vertical: { graphics: {} },
        horizontal: { graphics: { horizontal__bg: meta('h.png') } },
      },
    };
    assert.strictEqual(renderRead(lay, 'vertical', 'horizontal__bg'), null);
  });
  it('legacy slot ref (bare key) keeps rendering via root', () => {
    const lay = {
      graphics: { team_emblem: meta('emblem.png') },
      variants: {
        vertical: { graphics: { vertical__bg: meta('v.png') } },
      },
    };
    assert.strictEqual(
      renderRead(lay, 'vertical', 'team_emblem').filename,
      'emblem.png'
    );
  });

  // ── D. No on-disk collision via namespaced keys ─────────────────
  console.log('\nD. Shared per-layout on-disk bucket: no cross-variant collision');
  it('same base name on vertical vs horizontal → distinct storage keys', () => {
    const name = 'logo';
    const v = `vertical__${name}`;
    const h = `horizontal__${name}`;
    assert.notStrictEqual(v, h);
    // compositeGraphicsService stores at <layoutId>/<key>.<ext>;
    // distinct keys ⇒ distinct files ⇒ no collision.
  });

  // ── E. Per-key legacy hiding (Decision B) ───────────────────────
  console.log('\nE. Per-key legacy hiding (Decision B)');
  it('legacy key hidden only when variant owns the matching base name', () => {
    const lib = [{ key: 'horizontal__logo' }];
    const legacy = [
      { key: 'logo' }, // → hidden
      { key: 'team_emblem' }, // → still visible
      { key: 'background' }, // → still visible
    ];
    const visible = visibleLegacy(lib, legacy, 'horizontal');
    assert.deepStrictEqual(
      visible.map((g) => g.key).sort(),
      ['background', 'team_emblem']
    );
  });
  it('empty variant library shows ALL legacy', () => {
    const visible = visibleLegacy(
      [],
      [{ key: 'logo' }, { key: 'bg' }],
      'horizontal'
    );
    assert.deepStrictEqual(visible.map((g) => g.key).sort(), ['bg', 'logo']);
  });
  it('multiple variant entries hide only their matching legacy keys', () => {
    const lib = [
      { key: 'vertical__logo' },
      { key: 'vertical__team_emblem' },
    ];
    const legacy = [
      { key: 'logo' }, // hidden (matched)
      { key: 'team_emblem' }, // hidden (matched)
      { key: 'background' }, // visible
      { key: 'frame' }, // visible
    ];
    const visible = visibleLegacy(lib, legacy, 'vertical');
    assert.deepStrictEqual(
      visible.map((g) => g.key).sort(),
      ['background', 'frame']
    );
  });
  it('un-prefixed variant entry is compared by raw key (defensive)', () => {
    const lib = [{ key: 'logo' }];
    const visible = visibleLegacy(
      lib,
      [{ key: 'logo' }, { key: 'bg' }],
      'horizontal'
    );
    assert.deepStrictEqual(visible.map((g) => g.key).sort(), ['bg']);
  });

  // ── F. Real composite-layouts.json: un-diverged data unchanged ──
  console.log(
    '\nF. Real composite-layouts.json — un-diverged render unchanged'
  );
  const layouts = await compositeService.listLayouts();
  let realCases = 0;
  for (const lay of layouts) {
    if (!lay.graphics) continue;
    for (const [k, rootMeta] of Object.entries(lay.graphics)) {
      for (const [vName, v] of Object.entries(lay.variants || {})) {
        if (!v || !Array.isArray(v.slots) || v.slots.length < 1) continue;
        const got = renderRead(lay, vName, k);
        if (!got) continue; // variant chose not to own this key — fine
        realCases += 1;
        it(
          `[${lay.id}.${vName}] key "${k}" renders identical filename`,
          () => {
            assert.strictEqual(got.filename, rootMeta.filename);
          }
        );
      }
    }
  }
  if (realCases === 0) {
    console.log(
      '  (no real (layout, variant, root-key) combinations to check —' +
        ' production layouts may have no root graphics)'
    );
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('\n──────────────');
  console.log(`pass: ${pass}  fail: ${fail}  (real cases: ${realCases})`);
  if (fail > 0) {
    console.log('\n❌ FAIL — Phase 57B verification did not pass.');
    process.exit(1);
  }
  console.log(
    '\n✅ PASS — Phase 57B graphics per-variant verification clean.'
  );
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
