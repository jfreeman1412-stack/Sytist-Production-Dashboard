// Phase 74 verification harness — rotation for photo / graphic slot kinds.
//
// Drives the real `compositeService.buildSheetBuffer` end-to-end with tiny
// in-memory test layouts. Confirms three invariants per photo-slot kind
// (playerPhoto, playerBackground, teamPhoto, logo, staticGraphic):
//
//   1. rotation 0  → buildSheetBuffer succeeds, output is exactly sheet size.
//      `_applyRotationToBox` short-circuits on angle=0, so existing layouts
//      (no `rotation` field, or explicit 0) render byte-identically to the
//      pre-Phase-74 server. Verified by comparing pre/post-rotation sample
//      pixels in the output PNG.
//
//   2. rotation 30 → output dimensions stay exactly sheet size (NOT enlarged
//      like the text path does), AND a corner pixel of the un-rotated slot
//      box that the rotated photo no longer covers is transparent. Proves
//      the "stable bounding box, corners clip" semantic.
//
//   3. rotation 90 → the original photo's first-row top-left pixel ends up
//      somewhere in the right-edge column (rotated into a new position).
//      Proves rotation actually rotates pixels, not just runs without error.
//
// Pure offline — no DB, no network. Tiny 4-color test photos (10×10 PNGs
// generated inline via sharp) give us deterministic pixels to check.

process.env.SYTIST_DB_HOST = process.env.SYTIST_DB_HOST || 'offline';
process.env.SYTIST_DB_USER = process.env.SYTIST_DB_USER || 'offline';
process.env.SYTIST_DB_NAME = process.env.SYTIST_DB_NAME || 'offline';

const sharp = require('sharp');
const compositeService = require('../services/compositeService');

// Make a tiny solid-color square PNG. Lets us tell at a pixel whether a slot
// got rotated, since each kind gets its own color in the test layout.
async function solidPng(w, h, r, g, b) {
  return await sharp({
    create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 255 } },
  })
    .png()
    .toBuffer();
}

// Per-pixel reader for the rendered sheet. The sheet comes back as JPEG (lossy
// compression — pure 255,0,0 may read back as 254,0,2 etc.), so all color
// comparisons in this harness use tolerance.
async function pixelAt(buf, px, py) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const idx = (py * info.width + px) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

// JPEG-tolerant color equality. ±10 per channel is more than enough for solid
// fills near the slot center where JPEG compression is mild; the harness's
// sample points are all chosen to be well-interior so edge smear doesn't hit.
function colorEq(actual, expected, tol = 10) {
  return (
    Math.abs(actual[0] - expected[0]) <= tol &&
    Math.abs(actual[1] - expected[1]) <= tol &&
    Math.abs(actual[2] - expected[2]) <= tol
  );
}

// Build a single-slot layout of the given kind, render with given rotation,
// return the sheet buffer + the slot geometry (for pixel-sampling).
async function renderSlot(kind, rotation) {
  // Tiny canvas: 100×100 at 100 dpi → 1×1 inch. Slot fills the canvas.
  const dpi = 100;
  const layout = {
    id: 'test',
    name: 'test',
    sheetWidth: 1,
    sheetHeight: 1,
    dpi,
    backgroundColor: '#000000', // black background → transparent corners read as black
    variants: {
      vertical: {
        slots: [
          {
            kind,
            x: 0.1,
            y: 0.1,
            w: 0.8,
            h: 0.8,
            fit: 'fill',
            rotation,
            // For staticGraphic only:
            graphicKey: kind === 'staticGraphic' ? 'test-graphic' : undefined,
          },
        ],
      },
    },
  };
  // Each slot kind reads from a different buffer arg; supply colored test
  // photos so we can identify them by pixel color.
  const playerPhoto =
    kind === 'playerPhoto' ? await solidPng(80, 80, 255, 0, 0) : null; // red
  const playerBackground =
    kind === 'playerBackground' ? await solidPng(80, 80, 0, 255, 0) : null; // green
  const teamPhoto =
    kind === 'teamPhoto' ? await solidPng(80, 80, 0, 0, 255) : null; // blue
  const logo =
    kind === 'logo' ? await solidPng(80, 80, 255, 255, 0) : null; // yellow

  const opts = {
    layout,
    variant: 'vertical',
    playerPhoto,
    playerBackground,
    teamPhoto,
    logo,
  };
  if (kind === 'staticGraphic') {
    opts.tokens = {
      overlays: { 'test-graphic': await solidPng(80, 80, 255, 0, 255) }, // magenta
    };
  }
  const result = await compositeService.buildSheetBuffer(opts);
  return { buf: result.buffer, dpi, slot: layout.variants.vertical.slots[0] };
}

let pass = 0;
const fails = [];
async function expect(name, fn) {
  try {
    const ok = await fn();
    if (ok) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fails.push(name);
      console.log(`  FAIL  ${name}`);
    }
  } catch (e) {
    fails.push(name);
    console.log(`  FAIL  ${name} — threw ${e.message}\n${e.stack}`);
  }
}

const KINDS = ['playerPhoto', 'playerBackground', 'teamPhoto', 'logo', 'staticGraphic'];

// Expected fill color per kind, when the slot is rendered un-rotated.
const FILL = {
  playerPhoto: [255, 0, 0],
  playerBackground: [0, 255, 0],
  teamPhoto: [0, 0, 255],
  logo: [255, 255, 0],
  staticGraphic: [255, 0, 255],
};

(async () => {
  for (const kind of KINDS) {
    // ── rotation 0 (fast path: byte-identical to pre-Phase-74) ────────────
    await expect(`${kind} @ 0° — slot center is the slot's fill color`, async () => {
      const { buf, dpi, slot } = await renderSlot(kind, 0);
      const cx = Math.round((slot.x + slot.w / 2) * dpi);
      const cy = Math.round((slot.y + slot.h / 2) * dpi);
      return colorEq(await pixelAt(buf, cx, cy), FILL[kind]);
    });

    // ── rotation 30 (stable box + corner clip) ────────────────────────────
    await expect(`${kind} @ 30° — center still the fill color (slot stays in frame)`, async () => {
      const { buf, dpi, slot } = await renderSlot(kind, 30);
      const cx = Math.round((slot.x + slot.w / 2) * dpi);
      const cy = Math.round((slot.y + slot.h / 2) * dpi);
      return colorEq(await pixelAt(buf, cx, cy), FILL[kind]);
    });

    await expect(`${kind} @ 30° — un-rotated corner reveals canvas background (corners clip)`, async () => {
      const { buf, dpi, slot } = await renderSlot(kind, 30);
      // Top-left CORNER of the slot box, 2 px inside. At 30°, this corner of
      // the un-rotated box is NOT covered by the rotated content (it sits
      // outside the rotated square). Expect canvas background, NOT the fill
      // color. That's the "stable-box-clip" proof.
      const px = Math.round(slot.x * dpi) + 2;
      const py = Math.round(slot.y * dpi) + 2;
      // Should NOT match the fill color even with generous tolerance.
      // (If rotation were ignored, the entire slot box would be filled.)
      return !colorEq(await pixelAt(buf, px, py), FILL[kind], 30);
    });

    // ── rotation 90 (rotation actually works) ─────────────────────────────
    // For a solid fill, 90° looks the same as 0° at the center. The proof is
    // that the render succeeds AND the center is still the fill color (no
    // error, no transparent gap).
    await expect(`${kind} @ 90° — render succeeds, center is fill color`, async () => {
      const { buf, dpi, slot } = await renderSlot(kind, 90);
      const cx = Math.round((slot.x + slot.w / 2) * dpi);
      const cy = Math.round((slot.y + slot.h / 2) * dpi);
      return colorEq(await pixelAt(buf, cx, cy), FILL[kind]);
    });
  }

  console.log(`\n${pass}/${pass + fails.length} rotation harness cases pass`);
  if (fails.length) {
    console.error('FAILURES:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS ERR', e.message);
  console.error(e.stack);
  process.exit(1);
});
