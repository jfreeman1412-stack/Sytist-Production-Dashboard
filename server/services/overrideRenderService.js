// overrideRenderService.js
//
// Phase 52 — the shared "how a saved override feeds a render" policy
// layer. Both code paths that turn an (order, cart) into a composite
// call into here, so they can't drift:
//
//   1. processingService composite loop  (normal Process — the new
//      capability Phase 52 delivers; Phase 40 specified it but never
//      wired it, so Process silently ignored every override for months)
//   2. renderOverrideForOrder            (the editor's Apply Overwrite /
//      Apply Reprint, and the override-DELETE restore path)
//
// Two pure-ish functions, no DB access of their own — the caller passes
// the already-loaded override object in. That keeps orderOverrideService
// a thin SQLite wrapper (no coupling to compositeService here) and means
// this module never needs orderOverrideService.
//
// resolveLayoutAndVariant honors `override.variant` (the variant the
// operator actually edited in the editor). renderOverrideForOrder
// previously recomputed the variant via pickVariant and IGNORED
// override.variant — a latent bug: an override saved against the
// vertical variant would render against horizontal if the player photo
// happened to be landscape, silently dropping the operator's edits
// (incl. Phase 50 image overrides — the snapshot only populates the
// edited variant; the other is empty). Phase 52 fixes this for BOTH
// paths as a deliberate, documented side effect (SPEC §52).

const compositeService = require('./compositeService');
const orderAssetOverrideService = require('./orderAssetOverrideService');

// A snapshot is usable if it's a layout-shaped object with a non-empty
// variants map. The "does the chosen variant have slots" check happens
// in resolveLayoutAndVariant (it depends on which variant we pick).
function isUsableSnapshot(snap) {
  return !!(
    snap &&
    typeof snap === 'object' &&
    snap.variants &&
    typeof snap.variants === 'object' &&
    Object.keys(snap.variants).length > 0
  );
}

/**
 * Decide which layout + variant a render should use for one line item.
 *
 * Precedence: explicitLayout  >  usable override snapshot  >  SKU mapping.
 *
 * @param {object}  lineItem        canonical line item (needs .sku, .photo, .cartId)
 * @param {object?} override        full override row from orderOverrideService
 *                                   (.layoutSnapshot, .variant) or null
 * @param {object?} explicitLayout  caller-forced layout (override-DELETE restore)
 * @param {object?} mapping         pre-resolved composite mapping, if the caller
 *                                   already has it (processingService does — it
 *                                   gates the loop on it and needs it for
 *                                   chainToImposition). Avoids a double findMapping.
 *
 * @returns {{ layout, variant, layoutSource, mapping, warnings }}
 *   layout/variant null when nothing resolves — caller decides whether
 *   that's fatal (renderOverrideForOrder throws; processingService warns
 *   + continues). Never throws itself.
 */
async function resolveLayoutAndVariant({
  lineItem,
  override = null,
  explicitLayout = null,
  mapping = null,
}) {
  const warnings = [];
  const w = (lineItem && lineItem.photo && lineItem.photo.width) || 0;
  const h = (lineItem && lineItem.photo && lineItem.photo.height) || 0;

  // 1. Explicit layout — override-DELETE restore passes the original
  //    SKU-mapped layout to re-render the pre-override file.
  if (explicitLayout) {
    return {
      layout: explicitLayout,
      variant: compositeService.pickVariant(explicitLayout, w, h),
      layoutSource: 'explicit',
      mapping,
      warnings,
    };
  }

  // 2. Override snapshot, used WHOLESALE (Phase 11 snapshot semantics —
  //    a full copy precisely so base-layout edits never drift it;
  //    merging would reintroduce the drift the snapshot prevents).
  if (override && isUsableSnapshot(override.layoutSnapshot)) {
    const snap = override.layoutSnapshot;
    let variant = override.variant;
    const variantHasSlots =
      variant &&
      snap.variants[variant] &&
      Array.isArray(snap.variants[variant].slots) &&
      snap.variants[variant].slots.length > 0;
    if (!variantHasSlots) {
      // override.variant missing, or that variant isn't populated in
      // the snapshot (editor only populates the edited variant). Fall
      // back to orientation pick so we still render *something* sane.
      const picked = compositeService.pickVariant(snap, w, h);
      warnings.push({
        type: 'override_variant_fallback',
        message: `override.variant "${override.variant}" not usable in snapshot; picked "${picked}"`,
      });
      variant = picked;
    }
    return {
      layout: snap,
      variant,
      layoutSource: 'override',
      mapping,
      warnings,
    };
  }

  if (override && !isUsableSnapshot(override.layoutSnapshot)) {
    warnings.push({
      type: 'override_snapshot_invalid',
      message: `override for cart ${lineItem && lineItem.cartId} has an unusable layout_snapshot; falling back to SKU mapping`,
    });
  }

  // 3. SKU mapping (the default — what Process did before Phase 52, and
  //    the no-override branch of renderOverrideForOrder).
  let m = mapping;
  if (!m) {
    m = await compositeService.findMapping(lineItem.sku);
  }
  if (!m) {
    warnings.push({
      type: 'no_mapping',
      message: `No composite mapping for SKU "${lineItem && lineItem.sku}" and no usable override`,
    });
    return { layout: null, variant: null, layoutSource: 'none', mapping: null, warnings };
  }
  const layout = await compositeService.getLayout(m.layoutId);
  if (!layout) {
    warnings.push({
      type: 'layout_missing',
      message: `Mapped layout "${m.layoutId}" missing`,
    });
    return { layout: null, variant: null, layoutSource: 'none', mapping: m, warnings };
  }
  return {
    layout,
    variant: compositeService.pickVariant(layout, w, h),
    layoutSource: 'mapping',
    mapping: m,
    warnings,
  };
}

/**
 * Replace image-kind slot buffers with operator-uploaded overrides
 * (Phase 50 assets) before compositing. Lifted verbatim from the
 * inline loop that lived in renderOverrideForOrder so Process and
 * Apply apply image overrides identically.
 *
 * @param {number} orderId
 * @param {number} cartId
 * @param {object} layout    resolved layout (snapshot or mapped)
 * @param {string} variant   resolved variant
 * @param {object} buffers   { playerPhoto, teamPhoto, logo, playerBackground }
 *                            (any may be null — that's fine)
 * @returns {{ buffers, warnings }}  buffers is a new object; originals
 *          untouched. Missing-on-disk override → keep the default
 *          buffer + a warning (never throws, never fails the render —
 *          protects against backup/restore mismatch + manual deletion).
 */
async function applyImageOverrides({ orderId, cartId, layout, variant, buffers }) {
  const warnings = [];
  const out = { ...buffers };
  const slots = (layout && layout.variants && layout.variants[variant] && layout.variants[variant].slots) || [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot || !slot.overrideImage) continue;
    if (!orderAssetOverrideService.ELIGIBLE_SLOT_KINDS.includes(slot.kind)) {
      continue;
    }
    try {
      const got = await orderAssetOverrideService.readAssetBuffer({
        orderId,
        cartId,
        slotIndex: i,
        filename: slot.overrideImage.filename,
      });
      if (!got) {
        warnings.push({
          type: 'override_image_missing',
          message: `order=${orderId} cart=${cartId} slot=${i} kind=${slot.kind}: override file missing — using default`,
        });
        continue;
      }
      if (slot.kind === 'playerPhoto') out.playerPhoto = got.buffer;
      else if (slot.kind === 'teamPhoto') out.teamPhoto = got.buffer;
      else if (slot.kind === 'logo') out.logo = got.buffer;
      else if (slot.kind === 'playerBackground') out.playerBackground = got.buffer;
      console.log(
        `[OrderAsset] applied override order=${orderId} cart=${cartId} slot=${i} kind=${slot.kind} bytes=${got.buffer.length}`
      );
    } catch (err) {
      warnings.push({
        type: 'override_image_error',
        message: `order=${orderId} cart=${cartId} slot=${i}: ${err.message} — using default`,
      });
    }
  }
  return { buffers: out, warnings };
}

module.exports = {
  resolveLayoutAndVariant,
  applyImageOverrides,
  isUsableSnapshot,
};
