import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  NumberInput,
  Select,
  Button,
  StatusBanner,
} from '../../components/SettingsForm';
import LayoutCanvas, {
  PLACEHOLDER_TOKENS,
  DEFAULT_SNAP_STEP,
} from '../../components/LayoutCanvas';

/**
 * Phase 9b — full interactive layout designer.
 *
 * Three regions:
 *   - Top toolbar: variant tabs, save/discard, snap toggle, preview
 *     mode picker
 *   - Canvas (left): interactive SVG. Click slots to select. Drag to
 *     move. Resize handles on the selected slot's 8 corners/edges.
 *   - Property panel (right): edit selected slot's properties OR
 *     layout-level metadata when nothing selected. "Add slot" buttons
 *     at the bottom.
 *
 * Save model:
 *   - Edits are local until "Save" is clicked
 *   - "Unsaved changes" indicator appears when layout differs from
 *     saved version
 *   - "Discard" reverts to saved version
 *   - beforeunload warning if dirty
 *
 * Live preview:
 *   - Default: placeholder mode (gray rectangles, no real photos)
 *   - "Use order data" picker accepts orderId + cartId, fetches
 *     /composite/preview on every layout change with a 500ms debounce.
 *     The rendered JPG is shown as a backdrop behind the slot boxes
 *     so the operator can see the actual photos while editing.
 */
export default function LayoutDesignerPage() {
  const { layoutId } = useParams();
  const navigate = useNavigate();

  // Layout state
  const [layout, setLayout] = useState(null);
  const [originalJson, setOriginalJson] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  // Editor state
  const [variant, setVariant] = useState('vertical');
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [snapEnabled, setSnapEnabled] = useState(true);

  // Phase 9e: per-slot designer-only view state. Hide skips the slot
  // from canvas rendering; lock disables interaction (mouse drag,
  // resize, selection from canvas — though the layer card click still
  // works). Both transient — reset every time the layout opens.
  // Stored as { variantName: { slotIndex: true, ... } } so vertical
  // and horizontal variants have independent state. Per-variant
  // because slot indices have different meanings across variants.
  const [hiddenSlotsByVariant, setHiddenSlotsByVariant] = useState({
    vertical: {},
    horizontal: {},
  });
  const [lockedSlotsByVariant, setLockedSlotsByVariant] = useState({
    vertical: {},
    horizontal: {},
  });

  // Preview state
  const [previewMode, setPreviewMode] = useState('placeholder'); // 'placeholder' | 'order'
  const [previewOrderId, setPreviewOrderId] = useState('');
  const [previewCartId, setPreviewCartId] = useState('');
  const [previewImageDataUrl, setPreviewImageDataUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  // Phase 10a: order line-item picker state. After the operator types
  // an order ID and clicks "Load," we fetch the order via
  // GET /api/sytist/orders/:orderId and show its line items as a
  // selectable list with thumbnails. Picking a line item sets
  // previewCartId, which triggers the existing preview render flow.
  // orderLineItems is null when nothing is loaded, [] when an order
  // was loaded but had no photo line items, or an array of items
  // when valid.
  const [orderLineItems, setOrderLineItems] = useState(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderError, setOrderError] = useState(null);
  // Track which order ID's items are currently in `orderLineItems`,
  // so changing the order ID doesn't keep showing the old order's items.
  const [loadedOrderId, setLoadedOrderId] = useState('');

  // Phase 9c: graphics library for this layout. Loaded from
  // GET /composite/layouts/:id/graphics. Refreshed after every upload
  // or delete. graphicsBust is a counter that increments on each
  // refresh so <img> URLs include a cache-busting suffix and re-uploads
  // at the same key show fresh.
  const [graphicsLibrary, setGraphicsLibrary] = useState([]);
  // Phase 57B: graphics are per-variant. graphicsLibrary holds the
  // ACTIVE variant's own (namespaced) graphics; legacyGraphics holds
  // the deprecated root map the server returns separately so we can
  // render the read-only "Shared (legacy)" group.
  const [legacyGraphics, setLegacyGraphics] = useState([]);
  const [graphicsBust, setGraphicsBust] = useState(0);
  const [graphicsError, setGraphicsError] = useState(null);

  async function loadGraphicsLibrary() {
    try {
      const r = await api.get(
        `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}/graphics?variant=${encodeURIComponent(variant)}`
      );
      setGraphicsLibrary(r.graphics || []);
      setLegacyGraphics(r.legacyShared || []);
      setGraphicsBust((b) => b + 1);
      setGraphicsError(null);
    } catch (err) {
      setGraphicsError(err.message);
    }
  }

  // Phase 10a: load an order's line items so the operator can pick
  // one to preview against. Existing /api/sytist/orders/:id endpoint
  // returns the canonical order shape with line items including
  // photo URLs. We filter to line items that have a photo (skip
  // downloads, gift certs, etc. — they'd never preview meaningfully).
  async function loadOrderLineItems(orderId) {
    if (!orderId) return;
    setOrderLoading(true);
    setOrderError(null);
    setOrderLineItems(null);
    try {
      const r = await api.get(
        `/api/sytist/orders/${encodeURIComponent(orderId)}`
      );
      const order = r.order;
      if (!order) {
        setOrderError('Order not found');
        return;
      }
      const items = (order.lineItems || []).filter(
        (li) => li.photo && li.photo.fullUrl
      );
      setOrderLineItems(items);
      setLoadedOrderId(String(orderId));
      // If exactly one photo line item, auto-select it. Saves a click
      // on simple single-photo orders.
      if (items.length === 1) {
        setPreviewCartId(String(items[0].cartId));
      } else if (items.length === 0) {
        setOrderError('Order has no photo line items');
      }
    } catch (err) {
      setOrderError(err.message);
    } finally {
      setOrderLoading(false);
    }
  }

  // ─── Load layout from server ─────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get(`/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}`)
      .then((data) => {
        if (cancelled) return;
        setLayout(data);
        setOriginalJson(JSON.stringify(data));
        if (!data.variants?.vertical && data.variants?.horizontal) {
          setVariant('horizontal');
        }
        // Phase 9c: also load the graphics library. Non-fatal if it
        // fails — the page still works, static graphics just won't
        // render their thumbnails.
        loadGraphicsLibrary().catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutId]);

  // Reset selection when variant changes (slot indices are per-variant)
  useEffect(() => {
    setSelectedIndex(null);
    // Phase 57B: graphics are per-variant — reload the library scoped to
    // the now-active variant (and its legacy/shared group).
    if (layoutId) loadGraphicsLibrary().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  // ─── Dirty tracking + beforeunload guard ────────────────

  const isDirty = useMemo(() => {
    if (!layout || !originalJson) return false;
    return JSON.stringify(layout) !== originalJson;
  }, [layout, originalJson]);

  useEffect(() => {
    if (!isDirty) return;
    function handler(e) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // ─── Slot mutations ──────────────────────────────────────
  //
  // All mutations go through a single helper that produces the next
  // layout immutably. This keeps the dirty-detection and undo paths
  // simple — diff JSON.stringify(layout) vs originalJson and you have
  // your answer.

  function updateVariantSlots(updater) {
    setLayout((prev) => {
      if (!prev) return prev;
      const variantDef = prev.variants?.[variant] || { slots: [] };
      const nextSlots = updater(variantDef.slots || []);
      return {
        ...prev,
        variants: {
          ...prev.variants,
          [variant]: { ...variantDef, slots: nextSlots },
        },
      };
    });
  }

  function handleSlotChange(index, newSlot) {
    updateVariantSlots((slots) =>
      slots.map((s, i) => (i === index ? newSlot : s))
    );
  }

  function handleSlotDelete(index) {
    updateVariantSlots((slots) => slots.filter((_, i) => i !== index));
    setSelectedIndex(null);
    // Phase 9e: when a slot is deleted, every later index shifts down
    // by one. Re-key the visibility/lock maps to match.
    remapVariantStateOnDelete(index);
  }

  // ─── Phase 9e: hide/lock per-slot state helpers ─────────
  //
  // Both maps are keyed by slot index within a variant. When slots
  // are reordered or deleted, indices shift, so we must remap the
  // state to keep the right slots hidden/locked. These helpers
  // encapsulate that bookkeeping so the call sites don't need to
  // know about it.

  const hiddenSlots = hiddenSlotsByVariant[variant] || {};
  const lockedSlots = lockedSlotsByVariant[variant] || {};

  function toggleSlotHidden(index) {
    setHiddenSlotsByVariant((prev) => {
      const cur = prev[variant] || {};
      const next = { ...cur };
      if (next[index]) delete next[index];
      else next[index] = true;
      return { ...prev, [variant]: next };
    });
  }

  function toggleSlotLocked(index) {
    setLockedSlotsByVariant((prev) => {
      const cur = prev[variant] || {};
      const next = { ...cur };
      if (next[index]) delete next[index];
      else next[index] = true;
      return { ...prev, [variant]: next };
    });
  }

  // After a slot at `removedIndex` is deleted, remap the maps so
  // indices > removedIndex shift down by one.
  function remapVariantStateOnDelete(removedIndex) {
    const remap = (m) => {
      const out = {};
      for (const [kStr, v] of Object.entries(m || {})) {
        const k = Number(kStr);
        if (k === removedIndex) continue;
        const newKey = k > removedIndex ? k - 1 : k;
        out[newKey] = v;
      }
      return out;
    };
    setHiddenSlotsByVariant((prev) => ({
      ...prev,
      [variant]: remap(prev[variant]),
    }));
    setLockedSlotsByVariant((prev) => ({
      ...prev,
      [variant]: remap(prev[variant]),
    }));
  }

  // After slots are reordered (drag, ↑/↓), remap state to follow the
  // moved slot's new position. mapping is { oldIndex: newIndex } for
  // every slot whose index changed.
  function remapVariantStateOnReorder(mapping) {
    const remap = (m) => {
      const out = {};
      for (const [kStr, v] of Object.entries(m || {})) {
        const k = Number(kStr);
        const newKey = mapping[k] !== undefined ? mapping[k] : k;
        out[newKey] = v;
      }
      return out;
    };
    setHiddenSlotsByVariant((prev) => ({
      ...prev,
      [variant]: remap(prev[variant]),
    }));
    setLockedSlotsByVariant((prev) => ({
      ...prev,
      [variant]: remap(prev[variant]),
    }));
  }

  function handleAddSlot(kind) {
    if (!layout) return;
    // Phase 57B: place the new slot within the ACTIVE variant's canvas
    // (variant-first, root fallback), not the shared root — a slot added
    // on a 5×3.5 horizontal shouldn't be centered for a 3.5×5 sheet.
    const vd = layout.variants?.[variant];
    const w =
      vd && vd.sheetWidth != null ? vd.sheetWidth : layout.sheetWidth;
    const h =
      vd && vd.sheetHeight != null ? vd.sheetHeight : layout.sheetHeight;
    // Default size: 30% of sheet. Centered. Big enough to click but
    // not so big it occludes everything.
    const defaultW = w * 0.3;
    const defaultH = h * 0.3;
    const newSlot = makeDefaultSlot(kind, w / 2 - defaultW / 2, h / 2 - defaultH / 2, defaultW, defaultH);

    updateVariantSlots((slots) => {
      const nextSlots = [...slots, newSlot];
      // Select the newly added slot so the property panel shows it
      // immediately. New slot is appended → it's at the end of the
      // array → drawn last → on top of canvas → top of layers panel.
      setTimeout(() => setSelectedIndex(nextSlots.length - 1), 0);
      return nextSlots;
    });
  }

  // Phase 9b-hotfix: layer reorder helpers.
  //
  // The layers panel displays slots in REVERSED array order — the
  // last slot in the JSON is shown FIRST in the panel, because that's
  // the topmost layer on the canvas. Photoshop convention.
  //
  // "Move up" in the panel means "move toward the top of the canvas"
  //   = move the slot LATER in the JSON array.
  // "Move down" means the opposite.
  //
  // These functions take the JSON array index (not display index).

  function handleSlotMoveUp(index) {
    // Swap with slots[index + 1] — same slot just gets drawn later
    // (more on top in the canvas, which is "up" in the layers panel).
    updateVariantSlots((slots) => {
      if (index >= slots.length - 1) return slots; // already on top
      const next = [...slots];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      // Update selection to follow the moved slot to its new index
      setTimeout(() => setSelectedIndex(index + 1), 0);
      // Phase 9e: swap visibility/lock state along with the slots
      remapVariantStateOnReorder({
        [index]: index + 1,
        [index + 1]: index,
      });
      return next;
    });
  }

  function handleSlotMoveDown(index) {
    updateVariantSlots((slots) => {
      if (index <= 0) return slots; // already at bottom
      const next = [...slots];
      [next[index], next[index - 1]] = [next[index - 1], next[index]];
      setTimeout(() => setSelectedIndex(index - 1), 0);
      remapVariantStateOnReorder({
        [index]: index - 1,
        [index - 1]: index,
      });
      return next;
    });
  }

  // Phase 9b-hotfix2: drag-and-drop reorder.
  //
  // Inputs are in JSON-array space (NOT display space):
  //   fromJsonIdx — the slot being dragged
  //   targetJsonIdx — the slot it was dropped onto
  //   position — 'above' or 'below', interpreted in PANEL display terms
  //              (panel is reversed from JSON, so 'above target in
  //              panel' = 'after target in JSON array')
  //
  // The math:
  //   panel "above" → JSON insert position is `targetJsonIdx + 1`
  //   panel "below" → JSON insert position is `targetJsonIdx`
  //   then splice(fromJsonIdx, 1) and splice(insertPos, 0, item),
  //   adjusting insertPos if fromJsonIdx < insertPos (because the
  //   removal shifted later indices down by one).
  function handleSlotReorder(fromJsonIdx, targetJsonIdx, position) {
    if (fromJsonIdx === targetJsonIdx) return;
    updateVariantSlots((slots) => {
      if (fromJsonIdx < 0 || fromJsonIdx >= slots.length) return slots;
      if (targetJsonIdx < 0 || targetJsonIdx >= slots.length) return slots;

      // Compute insert position in the original array
      let insertPos = position === 'above'
        ? targetJsonIdx + 1   // panel-above = JSON-after
        : targetJsonIdx;      // panel-below = JSON-at-target

      // If we already are at the destination, nothing to do
      if (insertPos === fromJsonIdx || insertPos === fromJsonIdx + 1) {
        // Inserting just before or just after current position is a no-op
        return slots;
      }

      const next = [...slots];
      const [item] = next.splice(fromJsonIdx, 1);
      // After splice, indices > fromJsonIdx shifted down by 1
      const adjustedInsert = fromJsonIdx < insertPos ? insertPos - 1 : insertPos;
      next.splice(adjustedInsert, 0, item);

      // Selection follows the dragged item to its new position
      setTimeout(() => setSelectedIndex(adjustedInsert), 0);

      // Phase 9e: build a {oldIndex: newIndex} mapping for the reorder
      // and apply it to visibility/lock state.
      const mapping = {};
      // The moved item went from fromJsonIdx → adjustedInsert
      mapping[fromJsonIdx] = adjustedInsert;
      // Other slots' indices shift based on the splice direction
      const N = slots.length;
      for (let i = 0; i < N; i++) {
        if (i === fromJsonIdx) continue;
        let newI = i;
        // Removal step: indices > fromJsonIdx shift down by 1
        if (i > fromJsonIdx) newI = i - 1;
        // Insertion step: indices >= adjustedInsert shift up by 1
        if (newI >= adjustedInsert) newI += 1;
        if (newI !== i) mapping[i] = newI;
      }
      remapVariantStateOnReorder(mapping);

      return next;
    });
  }

  // Phase 57B: `name` is the only layout-meta field that stays at the
  // layout root (one identity across orientations). Canvas/dpi/background
  // are per-variant — see handleVariantMetaChange.
  function handleLayoutMetaChange(updates) {
    setLayout((prev) => (prev ? { ...prev, ...updates } : prev));
  }

  // Phase 57B: write a layout-meta scalar (sheetWidth/sheetHeight/dpi/
  // backgroundColor) into the ACTIVE variant, creating that variant if
  // it doesn't exist yet (same immutable pattern as updateVariantSlots).
  // This is the copy-on-write promotion: editing an inheriting field
  // gives the active variant its own value (no extra click).
  function handleVariantMetaChange(updates) {
    setLayout((prev) => {
      if (!prev) return prev;
      const variantDef = prev.variants?.[variant] || { slots: [] };
      return {
        ...prev,
        variants: {
          ...prev.variants,
          [variant]: { ...variantDef, ...updates },
        },
      };
    });
  }

  // Phase 57B: "Use shared default" — drop the active variant's own
  // copy of one meta key so it reverts to inheriting the (deprecated)
  // root value. Never touches slots or removes the variant itself.
  function handleVariantMetaReset(key) {
    setLayout((prev) => {
      if (!prev) return prev;
      const variantDef = prev.variants?.[variant];
      if (!variantDef || !(key in variantDef)) return prev;
      const nextVariant = { ...variantDef };
      delete nextVariant[key];
      return {
        ...prev,
        variants: { ...prev.variants, [variant]: nextVariant },
      };
    });
  }

  // ─── Save / discard ──────────────────────────────────────

  async function handleSave() {
    if (!isDirty || !layout) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      await api.put(
        `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}`,
        layout
      );
      setOriginalJson(JSON.stringify(layout));
      setSaveStatus({ kind: 'success', message: 'Saved' });
    } catch (err) {
      setSaveStatus({
        kind: 'error',
        message: `Save failed: ${err.message}`,
      });
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    if (!isDirty) return;
    if (
      !window.confirm(
        'Discard all unsaved changes and revert to the last saved version?'
      )
    ) {
      return;
    }
    setLayout(JSON.parse(originalJson));
    setSelectedIndex(null);
  }

  // ─── Phase 9c: graphics CRUD ────────────────────────────
  //
  // Upload writes file + updates layout.graphics on the server, then
  // refreshes the layout (server-side already merged it) and the
  // library list. The local "originalJson" updates too because the
  // server-side write is the canonical persistence — uploads are
  // intentionally not part of the unsaved-changes flow. The slot's
  // graphicKey field IS part of unsaved changes, but the file upload
  // itself is committed immediately.
  //
  // This deliberate split means: if you upload a graphic and then
  // click Discard, the file STAYS on the server (you can re-reference
  // it later), but any slot field changes (key references) revert.
  // Deleting an unused graphic to clean up requires explicit action
  // via the library section.

  async function handleUploadGraphic({ key, filename, dataBase64 }) {
    // Phase 57B: graphics are per-variant. Namespace the key so the
    // active variant owns it and it can't collide with the other
    // variant's same-named asset in the shared on-disk bucket. The
    // server validates this prefix and writes variants[variant].graphics.
    const namespacedKey = key.startsWith(variant + '__')
      ? key
      : `${variant}__${key}`;
    const r = await api.post(
      `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}/graphics/${encodeURIComponent(namespacedKey)}`,
      { dataBase64, filename, variant }
    );
    // Decision A: adopt ONLY the active variant's graphics map from the
    // server, preserving local slot/meta edits and EVERY other variant.
    // Same "uploads aren't unsaved changes, slot edits are" contract,
    // scoped to the variant.
    try {
      const fresh = await api.get(
        `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}`
      );
      const freshVarGraphics =
        (fresh.variants &&
          fresh.variants[variant] &&
          fresh.variants[variant].graphics) ||
        {};
      setLayout((prev) => {
        if (!prev) return fresh;
        const prevVar = (prev.variants && prev.variants[variant]) || {
          slots: [],
        };
        return {
          ...prev,
          variants: {
            ...(prev.variants || {}),
            [variant]: { ...prevVar, graphics: freshVarGraphics },
          },
        };
      });
      setOriginalJson((prev) => {
        if (!prev) return JSON.stringify(fresh);
        try {
          const o = JSON.parse(prev);
          o.variants = o.variants || {};
          o.variants[variant] = {
            ...(o.variants[variant] || { slots: [] }),
            graphics: freshVarGraphics,
          };
          return JSON.stringify(o);
        } catch {
          return JSON.stringify(fresh);
        }
      });
    } catch {
      // Non-fatal — library list refresh below still works
    }
    await loadGraphicsLibrary();
    return { ...r, namespacedKey };
  }

  async function handleDeleteGraphic(key) {
    if (
      !window.confirm(
        `Delete graphic "${key}" from the ${variant} variant? Slots that reference it will show a "missing graphic" warning until updated.`
      )
    ) {
      return;
    }
    // Phase 57B: per-variant delete. key is the variant's own namespaced
    // key (from the library list / slot picker); the server validates
    // the prefix and removes only variants[variant].graphics[key].
    await api.del(
      `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}/graphics/${encodeURIComponent(key)}`,
      { variant }
    );
    // Decision A: same per-variant adopt as upload — keep local slot/meta
    // edits and every other variant.
    try {
      const fresh = await api.get(
        `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}`
      );
      const freshVarGraphics =
        (fresh.variants &&
          fresh.variants[variant] &&
          fresh.variants[variant].graphics) ||
        {};
      setLayout((prev) => {
        if (!prev) return fresh;
        const prevVar = (prev.variants && prev.variants[variant]) || {
          slots: [],
        };
        return {
          ...prev,
          variants: {
            ...(prev.variants || {}),
            [variant]: { ...prevVar, graphics: freshVarGraphics },
          },
        };
      });
      setOriginalJson((prev) => {
        if (!prev) return JSON.stringify(fresh);
        try {
          const o = JSON.parse(prev);
          o.variants = o.variants || {};
          o.variants[variant] = {
            ...(o.variants[variant] || { slots: [] }),
            graphics: freshVarGraphics,
          };
          return JSON.stringify(o);
        } catch {
          return JSON.stringify(fresh);
        }
      });
    } catch {}
    await loadGraphicsLibrary();
  }

  // ─── Live preview (debounced) ────────────────────────────

  // Refs for the debounce timer + the latest in-flight request, so we
  // can cancel/replace as edits stream in
  const previewTimerRef = useRef(null);
  const previewSeqRef = useRef(0);

  useEffect(() => {
    if (previewMode !== 'order') {
      setPreviewImageDataUrl(null);
      return;
    }
    if (!previewOrderId || !previewCartId) {
      setPreviewError('Order ID and cart ID both required for live preview');
      return;
    }
    if (!layout) return;

    // Clear previous timer
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
    }

    previewTimerRef.current = setTimeout(async () => {
      const seq = ++previewSeqRef.current;
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        // Phase 10c: respect hidden-slot state in real-data preview.
        // Strip hidden slots from each variant's slots array before
        // sending the layout to the server. The server renders only
        // what it sees, so the backdrop will reflect the hidden state.
        // (Hide is still designer-only — never written to the saved
        // layout JSON. We're only filtering the in-flight preview
        // request payload.)
        const filteredLayout = {
          ...layout,
          variants: Object.fromEntries(
            Object.entries(layout.variants || {}).map(([vName, vDef]) => {
              const hideMap = hiddenSlotsByVariant[vName] || {};
              const filteredSlots = (vDef.slots || []).filter(
                (_, idx) => !hideMap[idx]
              );
              return [vName, { ...vDef, slots: filteredSlots }];
            })
          ),
        };
        const r = await api.post('/api/sytist/composite/preview', {
          orderId: previewOrderId,
          cartId: parseInt(previewCartId, 10),
          layout: filteredLayout, // inline — server uses this instead of saved version
        });
        // Only apply if this is still the latest request (otherwise an
        // older slow request could overwrite a newer fast one)
        if (seq === previewSeqRef.current) {
          setPreviewImageDataUrl(`data:image/jpeg;base64,${r.jpegBase64}`);
        }
      } catch (err) {
        if (seq === previewSeqRef.current) {
          setPreviewError(err.message);
        }
      } finally {
        if (seq === previewSeqRef.current) {
          setPreviewLoading(false);
        }
      }
    }, 500);

    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
    };
  }, [layout, previewMode, previewOrderId, previewCartId, hiddenSlotsByVariant]);

  // ─── Render ──────────────────────────────────────────────

  // Phase 9c: build a map of { graphicKey → preview URL } from the
  // library so the canvas can render uploaded graphics inline.
  //
  // Phase 9e-hotfix2: include the graphic's uploadedAt timestamp in
  // the URL as a cache buster. This is stronger than a render-counter
  // because the URL changes if and only if the file actually changed
  // — so re-uploads at the same key always force a fresh fetch, and
  // unchanged graphics keep their cache hit (faster).
  //
  // CRITICAL: this useMemo MUST be above the early returns below.
  // React's rules-of-hooks require hooks to run in the same order
  // every render — putting it below `if (loading) return` would
  // skip the hook on the first render but call it on subsequent
  // ones, breaking React's internal hook tracking.
  const graphicsUrls = useMemo(() => {
    const out = {};
    // Phase 57B: include the legacy/shared (root) graphics too so slots
    // still referencing a legacy key keep rendering their thumbnail.
    // Variant-own entries take precedence on key collision.
    const all = [...(graphicsLibrary || []), ...(legacyGraphics || [])];
    for (const g of all) {
      if (g.onDisk === false) continue;
      if (out[g.key]) continue;
      // Use uploadedAt + size as the buster; fall back to graphicsBust
      // counter if the metadata isn't present
      const bust = g.uploadedAt
        ? encodeURIComponent(g.uploadedAt) + '-' + (g.sizeBytes || 0)
        : graphicsBust;
      out[g.key] =
        `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}/graphics/${encodeURIComponent(g.key)}/preview?v=${bust}`;
    }
    return out;
  }, [graphicsLibrary, legacyGraphics, graphicsBust, layoutId]);

  // Phase 57B (decision B — per-key divergence): a legacy/shared graphic
  // is hidden from the active variant's library ONLY when that variant
  // has its own entry with the same BASE name (the variant key minus
  // the `${variant}__` prefix). Replacing one legacy asset never hides
  // the others the operator is still using.
  const visibleLegacyGraphics = useMemo(() => {
    const ownBaseNames = new Set(
      (graphicsLibrary || []).map((g) =>
        g.key.startsWith(variant + '__')
          ? g.key.slice(variant.length + 2)
          : g.key
      )
    );
    return (legacyGraphics || []).filter((g) => !ownBaseNames.has(g.key));
  }, [graphicsLibrary, legacyGraphics, variant]);

  // Phase 26: responsive canvas sizing. The ref + state + effect
  // MUST be declared before any early returns below, otherwise
  // React's hooks rules are violated (different hook count between
  // first render — when loading=true — and later renders).
  const leftColRef = useRef(null);
  const [leftColWidth, setLeftColWidth] = useState(1100);
  useEffect(() => {
    if (!leftColRef.current) return undefined;
    const el = leftColRef.current;
    function measure() {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setLeftColWidth(w);
    }
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (loading) {
    return (
      <div>
        <PageHeader title="Layout Designer" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Layout Designer" />
        <StatusBanner kind="error" message={error} />
      </div>
    );
  }
  if (!layout) return null;

  const variantDef = layout.variants?.[variant];
  const slots = variantDef?.slots || [];

  // Phase 57B: the editing canvas/preview must reflect the ACTIVE
  // variant's own canvas (variant-first, deprecated-root fallback) —
  // same resolution as compositeService (57A), LayoutCanvas and the
  // meta editor — so setting Horizontal to 5×3.5 re-orients the editor
  // surface instead of staying on the vertical canvas.
  const effSheetWidth =
    variantDef && variantDef.sheetWidth != null
      ? variantDef.sheetWidth
      : layout.sheetWidth;
  const effSheetHeight =
    variantDef && variantDef.sheetHeight != null
      ? variantDef.sheetHeight
      : layout.sheetHeight;
  const effDpi = (variantDef && variantDef.dpi) || layout.dpi || 300;

  // Phase 26: canvas dimensions derived from leftColWidth (measured
  // above by ResizeObserver). Canvas height bumped 50% vs natural
  // aspect fit so there's more vertical room for bleed area work.
  const aspect = effSheetWidth / effSheetHeight;
  // Canvas width: use the full left column. Then bump height by 50%
  // compared to natural aspect fit so the canvas is taller — operator
  // requested ~50% more vertical room for bleed work.
  const HEIGHT_BUMP = 1.5;
  // Width target = column width (minus small padding for the wrapper).
  // Height target derived from aspect; then we apply HEIGHT_BUMP and
  // also recompute width if the bumped height would exceed something
  // reasonable.
  const baseLong = Math.max(900, leftColWidth - 24);
  const canvasWidth =
    aspect >= 1 ? baseLong : baseLong * aspect;
  const canvasHeight =
    (aspect >= 1 ? baseLong / aspect : baseLong) * HEIGHT_BUMP;

  return (
    <div>
      <PageHeader
        title={`Designer: ${layout.name}`}
        subtitle={`Drag slots to reposition. Click to select; drag corners or edges to resize. ${snapEnabled ? `Snapping to ${DEFAULT_SNAP_STEP}″ grid.` : 'Free-form positioning.'}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isDirty && (
              <span
                style={{
                  fontSize: 11,
                  color: '#e0b341',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                ● Unsaved changes
              </span>
            )}
            <Button
              variant="ghost"
              onClick={handleDiscard}
              disabled={!isDirty || saving}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!isDirty || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (
                  isDirty &&
                  !window.confirm('Discard unsaved changes and leave?')
                ) {
                  return;
                }
                navigate('/settings/composites');
              }}
            >
              ← Back
            </Button>
          </div>
        }
      />

      {saveStatus && (
        <StatusBanner
          kind={saveStatus.kind}
          message={saveStatus.message}
          onDismiss={() => setSaveStatus(null)}
        />
      )}

      <div
        style={{
          display: 'grid',
          // Phase 26: 7:3 ratio so right column is ~30% of the row.
          // Designer fills the full left column. Preview controls
          // (CanvasFooterToolbar) moved from below the canvas to
          // the right column under Layers.
          gridTemplateColumns: '7fr 3fr',
          gap: 16,
        }}
      >
        {/* LEFT: variant tabs + canvas (Phase 26: preview toolbar
            moved to the right column). */}
        <div ref={leftColRef}>
          <VariantTabs
            layout={layout}
            current={variant}
            onChange={setVariant}
          />
          <LayoutCanvas
            layout={layout}
            variant={variant}
            selectedIndex={selectedIndex}
            onSlotSelect={setSelectedIndex}
            onSlotChange={handleSlotChange}
            width={canvasWidth}
            height={canvasHeight}
            sampleTokens={{
              ...PLACEHOLDER_TOKENS,
              __dpi: effDpi,
            }}
            snapEnabled={snapEnabled}
            backgroundImageDataUrl={
              previewMode === 'order' ? previewImageDataUrl : null
            }
            graphicsUrls={graphicsUrls}
            hiddenSlots={hiddenSlots}
            lockedSlots={lockedSlots}
          />
        </div>

        {/* RIGHT: layers panel + layout meta + preview controls */}
        <div>
          <LayoutMetaEditor
            layout={layout}
            variant={variant}
            onNameChange={(name) => handleLayoutMetaChange({ name })}
            onVariantChange={handleVariantMetaChange}
            onVariantReset={handleVariantMetaReset}
            collapsed={selectedIndex !== null}
          />
          <GraphicsLibrarySection
            layoutId={layoutId}
            variant={variant}
            graphicsLibrary={graphicsLibrary}
            legacyGraphics={visibleLegacyGraphics}
            graphicsBust={graphicsBust}
            graphicsError={graphicsError}
            onUpload={handleUploadGraphic}
            onDelete={handleDeleteGraphic}
            onRefresh={loadGraphicsLibrary}
            collapsedDefault={true}
          />
          <LayersPanel
            slots={slots}
            selectedIndex={selectedIndex}
            variantName={variant}
            sheetWidth={effSheetWidth}
            sheetHeight={effSheetHeight}
            onSelect={setSelectedIndex}
            onChange={handleSlotChange}
            onDelete={handleSlotDelete}
            onMoveUp={handleSlotMoveUp}
            onMoveDown={handleSlotMoveDown}
            onReorder={handleSlotReorder}
            onAdd={handleAddSlot}
            disabled={!variantDef}
            layoutId={layoutId}
            variant={variant}
            graphicsLibrary={graphicsLibrary}
            legacyGraphics={legacyGraphics}
            onUploadGraphic={handleUploadGraphic}
            graphicsBust={graphicsBust}
            hiddenSlots={hiddenSlots}
            lockedSlots={lockedSlots}
            onToggleHidden={toggleSlotHidden}
            onToggleLocked={toggleSlotLocked}
          />
          <CanvasFooterToolbar
            snapEnabled={snapEnabled}
            onSnapToggle={() => setSnapEnabled((v) => !v)}
            previewMode={previewMode}
            onPreviewModeChange={setPreviewMode}
            previewOrderId={previewOrderId}
            previewCartId={previewCartId}
            onPreviewOrderIdChange={(v) => {
              // When the typed order ID changes, drop any previously
              // loaded line items — they were for the old order.
              setPreviewOrderId(v);
              if (String(v) !== loadedOrderId) {
                setOrderLineItems(null);
                setOrderError(null);
                setPreviewCartId('');
              }
            }}
            onPreviewCartIdChange={setPreviewCartId}
            previewLoading={previewLoading}
            previewError={previewError}
            // Phase 10a: line-item picker
            orderLineItems={orderLineItems}
            orderLoading={orderLoading}
            orderError={orderError}
            loadedOrderId={loadedOrderId}
            onLoadOrder={() => loadOrderLineItems(previewOrderId)}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Variant tabs ─────────────────────────────────────────

function VariantTabs({ layout, current, onChange }) {
  const tabs = ['vertical', 'horizontal'];
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 8 }}>
      {tabs.map((t) => {
        const exists = !!layout.variants?.[t];
        const isCurrent = t === current;
        const slotCount = layout.variants?.[t]?.slots?.length || 0;
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: isCurrent ? 'var(--bg-card)' : 'transparent',
              border: '1px solid var(--border-color)',
              borderBottom: isCurrent
                ? '1px solid var(--bg-card)'
                : '1px solid var(--border-color)',
              borderRight: t === 'vertical' ? 'none' : '1px solid var(--border-color)',
              borderRadius: t === 'vertical' ? '6px 0 0 0' : '0 6px 0 0',
              color: isCurrent
                ? 'var(--text-primary)'
                : 'var(--text-muted)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: isCurrent ? 600 : 400,
              textTransform: 'capitalize',
              position: 'relative',
              top: isCurrent ? 1 : 0,
            }}
          >
            {t}
            <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
              ({exists ? `${slotCount} slot${slotCount === 1 ? '' : 's'}` : 'not defined'})
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Canvas footer toolbar ─────────────────────────────────

function CanvasFooterToolbar({
  snapEnabled,
  onSnapToggle,
  previewMode,
  onPreviewModeChange,
  previewOrderId,
  previewCartId,
  onPreviewOrderIdChange,
  onPreviewCartIdChange,
  previewLoading,
  previewError,
  // Phase 10a: order line-item picker
  orderLineItems,
  orderLoading,
  orderError,
  loadedOrderId,
  onLoadOrder,
}) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={snapEnabled}
            onChange={onSnapToggle}
          />
          Snap to {DEFAULT_SNAP_STEP}″ grid
        </label>

        <div
          style={{
            height: 16,
            width: 1,
            background: 'var(--border-color)',
          }}
        />

        <span
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
          }}
        >
          Preview:
        </span>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <input
            type="radio"
            name="previewMode"
            checked={previewMode === 'placeholder'}
            onChange={() => onPreviewModeChange('placeholder')}
          />
          Placeholder
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <input
            type="radio"
            name="previewMode"
            checked={previewMode === 'order'}
            onChange={() => onPreviewModeChange('order')}
          />
          Use real order data
        </label>
      </div>

      {previewMode === 'order' && (
        <div style={{ marginTop: 8 }}>
          {/* Order ID input + Load button. Phase 10a: cart ID is no
              longer typed — it's selected from the loaded order's
              line items below. */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-end',
            }}
          >
            <div style={{ flex: 1 }}>
              <FormRow label="Order ID" hint="Enter an order, then click Load (or press Enter)">
                <input
                  type="text"
                  value={previewOrderId}
                  onChange={(e) => onPreviewOrderIdChange(e.target.value)}
                  onKeyDown={(e) => {
                    // Phase 23: Enter loads the order. Useful for
                    // barcode scanners that auto-send a CR at end of
                    // input, and for the operator who wants to keep
                    // hands on the keyboard.
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (previewOrderId && !orderLoading) {
                        onLoadOrder();
                      }
                    }
                  }}
                  placeholder="e.g. 110855"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: 13,
                    fontFamily: 'var(--font-mono, monospace)',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 4,
                    color: 'var(--text-primary)',
                    boxSizing: 'border-box',
                  }}
                />
              </FormRow>
            </div>
            <button
              type="button"
              onClick={onLoadOrder}
              disabled={!previewOrderId || orderLoading}
              style={{
                padding: '8px 14px',
                background: 'var(--accent, #4a7fc1)',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: orderLoading || !previewOrderId ? 'default' : 'pointer',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                opacity: orderLoading || !previewOrderId ? 0.5 : 1,
                marginBottom: 18,  // align with input baseline (FormRow has hint below)
                whiteSpace: 'nowrap',
              }}
            >
              {orderLoading ? 'Loading…' : 'Load'}
            </button>
          </div>

          {orderError && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: '#dc3545',
              }}
            >
              {orderError}
            </div>
          )}

          {/* Line items picker. Renders only when an order has been
              successfully loaded and has photo line items. */}
          {orderLineItems && orderLineItems.length > 0 && (
            <LineItemsPicker
              items={orderLineItems}
              selectedCartId={previewCartId}
              onSelect={(cartId) => onPreviewCartIdChange(String(cartId))}
            />
          )}
        </div>
      )}

      {previewMode === 'order' && previewLoading && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}
        >
          Rendering preview…
        </div>
      )}
      {previewMode === 'order' && previewError && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: '#dc3545',
          }}
        >
          {previewError}
        </div>
      )}
    </div>
  );
}

// ─── Line items picker (Phase 10a) ────────────────────────
//
// Renders a scrollable list of an order's photo line items.
// Each row shows a small photo thumbnail, the product name,
// SKU, and (subtly) the cart ID for operator reference.
// Click anywhere in a row to select that line item — sets
// previewCartId, which triggers the existing preview render.

function LineItemsPicker({ items, selectedCartId, onSelect }) {
  const selectedNum = parseInt(selectedCartId, 10);
  return (
    <div
      style={{
        marginTop: 10,
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        background: 'var(--bg-input)',
        maxHeight: 240,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--bg-card)',
          position: 'sticky',
          top: 0,
        }}
      >
        Line items ({items.length}) — click one to preview
      </div>
      {items.map((li) => {
        const isSelected = li.cartId === selectedNum;
        const thumbUrl = li.photo?.thumbUrl || li.photo?.largeUrl || null;
        return (
          <div
            key={li.cartId}
            onClick={() => onSelect(li.cartId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              cursor: 'pointer',
              borderBottom: '1px solid var(--border-color)',
              background: isSelected
                ? 'rgba(74,127,193,0.15)'
                : 'transparent',
              borderLeft: isSelected
                ? '3px solid #4a7fc1'
                : '3px solid transparent',
            }}
          >
            {/* Thumbnail */}
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                style={{
                  width: 48,
                  height: 48,
                  objectFit: 'cover',
                  borderRadius: 3,
                  background: '#222',
                  flexShrink: 0,
                }}
                onError={(e) => {
                  // If thumb fails, fall back to a colored placeholder
                  e.target.style.display = 'none';
                }}
              />
            ) : (
              <div
                style={{
                  width: 48,
                  height: 48,
                  background: '#444',
                  borderRadius: 3,
                  flexShrink: 0,
                }}
              />
            )}
            {/* Text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {li.productNameDisplay || '(unnamed product)'}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono, monospace)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {li.sku || '(no SKU)'}
                {li.photo?.originalFilename
                  ? ` · ${li.photo.originalFilename}`
                  : ''}
                {' · cart '}
                {li.cartId}
                {li.backgroundPhoto ? ' · 🖼️ has BG' : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Slot editor (right panel when slot selected) ──────────

function SlotEditorBody({
  slot,
  sheetWidth,
  sheetHeight,
  onChange,
  // Phase 9c: graphics library context for staticGraphic slots
  layoutId,
  variant,
  graphicsLibrary,
  legacyGraphics,
  onUploadGraphic,
  graphicsBust,
}) {
  function update(field, value) {
    // Phase 9c-hotfix2: coerce numeric slot fields. NumberInput emits
    // an empty string when the user clears a field; if we stored that,
    // downstream code (drag math, .toFixed displays, SVG attributes)
    // would break. For numeric fields, an empty input means "0".
    const numericFields = new Set(['x', 'y', 'w', 'h', 'fontSize', 'rotation']);
    let v = value;
    if (numericFields.has(field)) {
      const n = Number(v);
      v = Number.isFinite(n) ? n : 0;
    }
    onChange({ ...slot, [field]: v });
  }

  const isText = slot.kind === 'text';
  const isStaticGraphic = slot.kind === 'staticGraphic' || slot.kind === 'overlay';
  const isImage = ['playerPhoto', 'playerBackground', 'teamPhoto', 'logo', 'staticGraphic', 'overlay'].includes(slot.kind);

  return (
    <div>
      <FormRow label="Kind">
        <Select
          value={slot.kind === 'overlay' ? 'staticGraphic' : slot.kind}
          onChange={(v) => update('kind', v)}
          options={[
            { value: 'playerPhoto', label: 'Player photo' },
            { value: 'teamPhoto', label: 'Team photo' },
            { value: 'logo', label: 'Logo' },
            { value: 'staticGraphic', label: 'Static graphic' },
            { value: 'text', label: 'Text' },
          ]}
        />
      </FormRow>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        <FormRow label="X (in)" hint={`0 to ${fmt((Number(sheetWidth) || 0) - (Number(slot.w) || 0))}`}>
          <NumberInput
            value={slot.x ?? 0}
            onChange={(v) => update('x', v)}
            step="0.05"
          />
        </FormRow>
        <FormRow label="Y (in)" hint={`0 to ${fmt((Number(sheetHeight) || 0) - (Number(slot.h) || 0))}`}>
          <NumberInput
            value={slot.y ?? 0}
            onChange={(v) => update('y', v)}
            step="0.05"
          />
        </FormRow>
        <FormRow label="Width (in)">
          <NumberInput
            value={slot.w ?? 0}
            onChange={(v) => update('w', v)}
            step="0.05"
          />
        </FormRow>
        <FormRow label="Height (in)">
          <NumberInput
            value={slot.h ?? 0}
            onChange={(v) => update('h', v)}
            step="0.05"
          />
        </FormRow>
      </div>

      {isImage && (
        <FormRow
          label="Fit mode"
          hint={
            slot.fit === 'cover' || !slot.fit
              ? 'Cover: image FILLS the slot. Crops edges if aspect ratios differ. Use for photos.'
              : slot.fit === 'contain'
                ? 'Contain: image FITS ENTIRELY in the slot. May leave empty bars on the sides. Use for logos and frames.'
                : slot.fit === 'fill'
                  ? 'Fill: stretches the image to fill the slot exactly. Distorts if aspect ratios differ.'
                  : slot.fit === 'inside'
                    ? 'Inside: like contain, but never enlarges a smaller image.'
                    : slot.fit === 'outside'
                      ? 'Outside: like cover, but never enlarges a smaller image.'
                      : ''
          }
        >
          <Select
            value={slot.fit || 'cover'}
            onChange={(v) => update('fit', v)}
            options={[
              { value: 'cover', label: 'cover — fill (may crop)' },
              { value: 'contain', label: 'contain — fit (may letterbox)' },
              { value: 'fill', label: 'fill — stretch (may distort)' },
              { value: 'inside', label: 'inside — fit, don\'t enlarge' },
              { value: 'outside', label: 'outside — fill, don\'t enlarge' },
            ]}
          />
        </FormRow>
      )}

      {isStaticGraphic && (
        <StaticGraphicSlotEditor
          slot={slot}
          layoutId={layoutId}
          variant={variant}
          graphicsLibrary={graphicsLibrary}
          legacyGraphics={legacyGraphics}
          onUploadGraphic={onUploadGraphic}
          onChange={update}
          graphicsBust={graphicsBust}
        />
      )}

      {isText && (
        <>
          <TextSlotContent
            slot={slot}
            update={update}
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
            }}
          >
            <FormRow
              label="Font size (px)"
              hint="At layout DPI. 24 = ~0.08″ at 300dpi."
            >
              <NumberInput
                value={slot.fontSize ?? 24}
                onChange={(v) => update('fontSize', v)}
                step="1"
              />
            </FormRow>
            <FormRow label="Font family">
              <TextInput
                value={slot.fontFamily || 'Arial'}
                onChange={(v) => update('fontFamily', v)}
              />
            </FormRow>
            <FormRow label="Color">
              <TextInput
                value={slot.color || '#000000'}
                onChange={(v) => update('color', v)}
                monospace
              />
            </FormRow>
            <FormRow label="Weight">
              <Select
                value={slot.weight || 'normal'}
                onChange={(v) => update('weight', v)}
                options={[
                  { value: 'normal', label: 'normal' },
                  { value: 'bold', label: 'bold' },
                  { value: '300', label: '300 (light)' },
                  { value: '500', label: '500 (medium)' },
                  { value: '700', label: '700 (bold)' },
                ]}
              />
            </FormRow>
            <FormRow label="Align">
              <Select
                value={slot.align || 'center'}
                onChange={(v) => update('align', v)}
                options={[
                  { value: 'left', label: 'left' },
                  { value: 'center', label: 'center' },
                  { value: 'right', label: 'right' },
                ]}
              />
            </FormRow>
            <FormRow
              label="Auto-fit"
              hint="Shrink font to fit width if needed"
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                  paddingTop: 8,
                }}
              >
                <input
                  type="checkbox"
                  checked={!!slot.autoFit}
                  onChange={(e) => update('autoFit', e.target.checked)}
                />
                Shrink to fit
              </label>
            </FormRow>
            <FormRow
              label="Rotation (°)"
              hint="0 = horizontal · 90 = sideways up · 180 = upside down · -90 / 270 = sideways down"
            >
              <NumberInput
                value={slot.rotation ?? 0}
                onChange={(v) => update('rotation', v)}
                step="1"
              />
            </FormRow>
          </div>
        </>
      )}

      <details style={{ marginTop: 16 }}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 11,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            fontWeight: 600,
          }}
        >
          Raw JSON
        </summary>
        <pre
          style={{
            marginTop: 8,
            padding: 8,
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            borderRadius: 4,
            fontSize: 10,
            fontFamily: 'var(--font-mono, monospace)',
            color: 'var(--text-secondary)',
            overflow: 'auto',
            maxHeight: 200,
          }}
        >
          {JSON.stringify(slot, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// ─── Static graphic slot editor (Phase 9c) ─────────────────
//
// Embedded inside SlotEditorBody when the selected slot is a Static
// Graphic. Three controls:
//   1. Graphic key — text input. The reference name. Kept short and
//      filename-safe (alphanumeric + hyphen + underscore). Operators
//      can change it; if they pick a key that already exists in the
//      library, the slot just references it (no upload needed).
//   2. Pick from library — dropdown of existing keys in this layout.
//      Quick way to reuse a graphic that's already been uploaded.
//   3. Upload button — file picker. Reads the file as base64 and
//      POSTs to the layout's graphics endpoint. On success, the
//      library refreshes and this slot's key is set automatically.
//
// Thumbnail of the currently-referenced graphic appears below if a
// file exists. Uses the preview endpoint with a cache-busting suffix
// so re-uploads at the same key show fresh.

// ─── Text slot content editor (Phase 9f) ──────────────────
//
// Wraps a plain text input with a row of token-insert buttons. Clicks
// on a token chip insert the {token.path} string at the input's
// current cursor position (or at the end if the input has never been
// focused). Operators don't have to memorize token names.
//
// The token catalog mirrors PLACEHOLDER_TOKENS from LayoutCanvas —
// kept in sync manually for now since it's a small, stable list.

const TEXT_TOKEN_CATALOG = [
  { token: '{subject.athleteName}', label: 'Athlete' },
  { token: '{subject.coachName}', label: 'Coach' },
  { token: '{subject.teamAndLevel}', label: 'Team' },
  { token: '{subject.jerseyNumber}', label: 'Jersey #' },
  { token: '{customer.firstName}', label: 'First name' },
  { token: '{customer.lastName}', label: 'Last name' },
  { token: '{galleryName}', label: 'Gallery' },
  { token: '{subGalleryName}', label: 'Sub-gallery' },
  { token: '{year}', label: 'Year' },
  { token: '{date}', label: 'Date' },
];

function TextSlotContent({ slot, update }) {
  const inputRef = useRef(null);
  // Track cursor position so we can insert at the right place. We
  // capture it on every keyup/click in the input. If the operator
  // never focused the input (e.g., clicked a chip first), we
  // append to the end.
  const cursorRef = useRef(null);

  function handleSelect(e) {
    cursorRef.current = {
      start: e.target.selectionStart,
      end: e.target.selectionEnd,
    };
  }

  function insertToken(token) {
    const current = slot.text || '';
    const cursor = cursorRef.current;
    let nextValue;
    let nextCursor;
    if (cursor && cursor.start != null) {
      const before = current.slice(0, cursor.start);
      const after = current.slice(cursor.end);
      nextValue = before + token + after;
      nextCursor = cursor.start + token.length;
    } else {
      nextValue = current + token;
      nextCursor = nextValue.length;
    }
    update('text', nextValue);
    cursorRef.current = { start: nextCursor, end: nextCursor };
    // Refocus the input so the operator can keep typing
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        try {
          inputRef.current.setSelectionRange(nextCursor, nextCursor);
        } catch {
          // Some browsers throw on setSelectionRange for certain inputs
        }
      }
    }, 0);
  }

  return (
    <FormRow
      label="Text content"
      hint="Type literal text or click a token below to insert."
    >
      <input
        ref={inputRef}
        type="text"
        value={slot.text || ''}
        onChange={(e) => update('text', e.target.value)}
        onSelect={handleSelect}
        onClick={handleSelect}
        onKeyUp={handleSelect}
        style={{
          width: '100%',
          padding: '8px 10px',
          fontSize: 13,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          color: 'var(--text-primary)',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          marginTop: 6,
        }}
      >
        {TEXT_TOKEN_CATALOG.map((t) => (
          <button
            key={t.token}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              insertToken(t.token);
            }}
            title={`Inserts ${t.token}`}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 12,
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
    </FormRow>
  );
}

function StaticGraphicSlotEditor({
  slot,
  layoutId,
  variant,
  graphicsLibrary,
  legacyGraphics,
  onUploadGraphic,
  onChange,
  graphicsBust,
}) {
  // Backward compat: accept legacy overlayId as the source of truth
  // when graphicKey isn't set
  const currentKey = slot.graphicKey || slot.overlayId || '';
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  function handleKeyChange(v) {
    // Sanitize key inline as the operator types — same rules as the
    // server-side validator
    const safe = String(v || '').replace(/[^A-Za-z0-9_-]/g, '');
    onChange('graphicKey', safe);
    // If they had a legacy overlayId, drop it now that we have a fresh
    // graphicKey set
    if (slot.overlayId) onChange('overlayId', undefined);
  }

  function handleLibraryPick(v) {
    if (!v) return;
    onChange('graphicKey', v);
    if (slot.overlayId) onChange('overlayId', undefined);
  }

  async function handleFileChange(e) {
    setUploadError(null);
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const isPng = file.type === 'image/png';
    const isJpg = file.type === 'image/jpeg';
    if (!isPng && !isJpg) {
      setUploadError('Only PNG and JPG files are accepted');
      e.target.value = '';
      return;
    }

    // Derive a key if the slot doesn't have one yet — use the filename
    // base (sanitized). Operator can rename later via the key field.
    let key = currentKey;
    if (!key) {
      const base = file.name.replace(/\.[^.]+$/, '');
      key = base.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60) || 'graphic';
    }

    setUploading(true);
    try {
      // Read file as base64 (matches the server's dataBase64 contract)
      const dataBase64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const result = r.result || '';
          const comma = String(result).indexOf(',');
          resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result));
        };
        r.onerror = () => reject(new Error('Failed to read file'));
        r.readAsDataURL(file);
      });

      // Phase 57B: the server stores under a variant-namespaced key;
      // point the slot at THAT key so render resolution finds it.
      const up = await onUploadGraphic({
        key,
        filename: file.name,
        dataBase64,
      });

      onChange('graphicKey', (up && up.namespacedKey) || key);
      if (slot.overlayId) onChange('overlayId', undefined);
    } catch (err) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      // Allow re-uploading the same file
      if (e.target) e.target.value = '';
    }
  }

  // Build the preview URL for the currently-referenced graphic.
  // Phase 9e-hotfix2: cache-bust with the file's uploadedAt+size from
  // the library entry, falling back to the graphicsBust counter.
  // Phase 57B: a slot may reference a variant-own (namespaced) key or a
  // legacy/shared key — search both for the preview cache-buster.
  const currentLibEntry = [
    ...(graphicsLibrary || []),
    ...(legacyGraphics || []),
  ].find((g) => g.key === currentKey);
  const previewBust =
    currentLibEntry && currentLibEntry.uploadedAt
      ? encodeURIComponent(currentLibEntry.uploadedAt) +
        '-' +
        (currentLibEntry.sizeBytes || 0)
      : graphicsBust;
  const previewUrl =
    layoutId && currentKey
      ? `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}/graphics/${encodeURIComponent(currentKey)}/preview?v=${previewBust}`
      : null;

  // Phase 57B: the picker offers this variant's own graphics first,
  // then a labelled "shared (legacy)" group (decision C — legacy stays
  // selectable so an existing slot can still point at a root graphic).
  const libraryEntries = (graphicsLibrary || []).filter(
    (g) => g.onDisk !== false
  );
  const legacyEntries = legacyGraphics || [];

  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        background: 'rgba(184, 136, 208, 0.08)',
        border: '1px solid rgba(184, 136, 208, 0.3)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: '#b888d0',
          marginBottom: 8,
        }}
      >
        Static graphic
      </div>

      <FormRow
        label="Graphic key"
        hint="Reference name. Letters, digits, hyphen, underscore only."
      >
        <TextInput
          value={currentKey}
          onChange={handleKeyChange}
          placeholder="frame-1"
          monospace
        />
      </FormRow>

      {(libraryEntries.length > 0 || legacyEntries.length > 0) && (
        <FormRow
          label="Pick from library"
          hint={`This ${variant || ''} variant's graphics, then shared (legacy) ones.`}
        >
          <Select
            value=""
            onChange={handleLibraryPick}
            options={[
              { value: '', label: '— pick a graphic —' },
              ...libraryEntries.map((g) => ({
                value: g.key,
                label: `${g.key} (${g.mimeType?.replace('image/', '') || '?'}, ${formatBytes(g.sizeBytes)})`,
              })),
              ...(legacyEntries.length > 0
                ? [
                    {
                      value: '',
                      label: '──── shared (legacy) ────',
                      disabled: true,
                    },
                    ...legacyEntries.map((g) => ({
                      value: g.key,
                      label: `(legacy) ${g.key} (${g.mimeType?.replace('image/', '') || '?'}, ${formatBytes(g.sizeBytes)})`,
                    })),
                  ]
                : []),
            ]}
          />
        </FormRow>
      )}

      <div style={{ marginTop: 8 }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        <Button
          variant="ghost"
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          disabled={uploading}
        >
          {uploading
            ? 'Uploading…'
            : currentKey
              ? `Upload / replace "${currentKey}"`
              : 'Upload graphic'}
        </Button>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10,
            color: 'var(--text-muted)',
          }}
        >
          PNG or JPG · max 10 MB
        </span>
      </div>

      {uploadError && (
        <div
          style={{
            marginTop: 6,
            padding: 6,
            background: 'rgba(220,53,69,0.08)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 4,
            color: '#dc3545',
            fontSize: 11,
          }}
        >
          {uploadError}
        </div>
      )}

      {previewUrl && (
        <div
          style={{
            marginTop: 8,
            padding: 6,
            background: 'rgba(0,0,0,0.15)',
            border: '1px solid var(--border-color)',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <img
            src={previewUrl}
            alt={`Graphic ${currentKey}`}
            style={{
              maxWidth: 80,
              maxHeight: 80,
              objectFit: 'contain',
              background:
                'repeating-conic-gradient(#444 0% 25%, #333 0% 50%) 50% / 12px 12px',
            }}
            onError={(e) => {
              // Hide if file doesn't exist (key references a missing file)
              e.currentTarget.style.display = 'none';
            }}
          />
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
            }}
          >
            <div>
              Currently referenced: <code>{currentKey}</code>
            </div>
            <div>
              {libraryEntries.find((g) => g.key === currentKey)
                ? '✓ File on disk'
                : '⚠ File not found — upload one'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(n) {
  if (typeof n !== 'number') return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Safe numeric formatter for slot dimensions. Layer card summaries
// display position/size at 2 decimal places. Anywhere these values
// could be undefined, null, or transiently '' (NumberInput emits the
// empty string when the user clears a field), fall back to 0.
function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0.00';
  return x.toFixed(2);
}

// ─── Graphics library section (Phase 9c) ──────────────────
//
// Layout-wide list of uploaded static graphics. Lives at the top of
// the right panel above the layers stack. Collapsed by default — the
// per-slot editor is the primary way operators interact with graphics
// (upload directly while editing a slot). This section is for
// management: see what's uploaded, delete unused ones, refresh the
// listing if something looks off.

function GraphicsLibrarySection({
  layoutId,
  variant,
  graphicsLibrary,
  legacyGraphics,
  graphicsBust,
  graphicsError,
  onUpload,
  onDelete,
  onRefresh,
  collapsedDefault,
}) {
  const [collapsed, setCollapsed] = useState(!!collapsedDefault);
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [pendingKey, setPendingKey] = useState('');

  async function handleFile(e) {
    setUploadError(null);
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setUploadError('Only PNG and JPG accepted');
      e.target.value = '';
      return;
    }
    let key = (pendingKey || '').trim();
    if (!key) {
      const base = file.name.replace(/\.[^.]+$/, '');
      key = base.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60) || 'graphic';
    }
    setUploading(true);
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const result = r.result || '';
          const comma = String(result).indexOf(',');
          resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result));
        };
        r.onerror = () => reject(new Error('Failed to read file'));
        r.readAsDataURL(file);
      });
      await onUpload({ key, filename: file.name, dataBase64 });
      setPendingKey('');
    } catch (err) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (e.target) e.target.value = '';
    }
  }

  return (
    <Section
      title={`Graphics library — ${variant || ''} (${(graphicsLibrary || []).length})`}
      description={
        collapsed
          ? null
          : `This ${variant || ''} variant's own graphics. Uploads land in this variant; shared (legacy) graphics below are read-only and disappear here once this variant has its own version.`
      }
      actions={
        <Button variant="ghost" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? 'Expand' : 'Collapse'}
        </Button>
      }
    >
      {!collapsed && (
        <>
          {graphicsError && (
            <div
              style={{
                padding: 8,
                background: 'rgba(220,53,69,0.08)',
                border: '1px solid rgba(220,53,69,0.3)',
                borderRadius: 4,
                color: '#dc3545',
                fontSize: 11,
                marginBottom: 8,
              }}
            >
              {graphicsError}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr auto',
              gap: 8,
              alignItems: 'end',
              marginBottom: 8,
            }}
          >
            <FormRow label="Upload as key" hint="Leave blank to derive from filename">
              <TextInput
                value={pendingKey}
                onChange={setPendingKey}
                placeholder="frame-1"
                monospace
              />
            </FormRow>
            <FormRow label="">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                onChange={handleFile}
                style={{ display: 'none' }}
              />
              <Button
                variant="primary"
                onClick={() => fileInputRef.current && fileInputRef.current.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            </FormRow>
            <FormRow label="">
              <Button variant="ghost" onClick={onRefresh}>
                ↻ Refresh
              </Button>
            </FormRow>
          </div>

          {uploadError && (
            <div
              style={{
                padding: 6,
                background: 'rgba(220,53,69,0.08)',
                border: '1px solid rgba(220,53,69,0.3)',
                borderRadius: 4,
                color: '#dc3545',
                fontSize: 11,
                marginBottom: 8,
              }}
            >
              {uploadError}
            </div>
          )}

          {(graphicsLibrary || []).length === 0 ? (
            <div
              style={{
                padding: 12,
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: 12,
              }}
            >
              No graphics for this {variant || ''} variant yet.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 8,
              }}
            >
              {graphicsLibrary.map((g) => (
                <GraphicLibraryThumb
                  key={g.key}
                  layoutId={layoutId}
                  graphic={g}
                  bust={graphicsBust}
                  onDelete={() => onDelete(g.key)}
                />
              ))}
            </div>
          )}

          {/* Phase 57B (decision B+C): read-only shared/legacy group —
              root graphics not yet replaced for THIS variant. Each entry
              disappears individually once this variant uploads its own
              same-base-name version. Never deletable from here. */}
          {(legacyGraphics || []).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-muted)',
                  marginBottom: 6,
                }}
              >
                Shared (legacy) — read-only
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'repeat(auto-fill, minmax(120px, 1fr))',
                  gap: 8,
                  opacity: 0.85,
                }}
              >
                {legacyGraphics.map((g) => (
                  <GraphicLibraryThumb
                    key={`legacy-${g.key}`}
                    layoutId={layoutId}
                    graphic={g}
                    bust={graphicsBust}
                    readOnly
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function GraphicLibraryThumb({ layoutId, graphic, bust, onDelete, readOnly }) {
  // Phase 9e-hotfix2: prefer uploadedAt+size as cache buster — changes
  // only when the file changes. Falls back to the bust counter.
  const effectiveBust = graphic.uploadedAt
    ? encodeURIComponent(graphic.uploadedAt) + '-' + (graphic.sizeBytes || 0)
    : bust;
  const url = `/api/sytist/composite/layouts/${encodeURIComponent(layoutId)}/graphics/${encodeURIComponent(graphic.key)}/preview?v=${effectiveBust}`;
  return (
    <div
      style={{
        padding: 6,
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <img
        src={url}
        alt={graphic.key}
        style={{
          width: '100%',
          height: 60,
          objectFit: 'contain',
          background:
            'repeating-conic-gradient(#444 0% 25%, #333 0% 50%) 50% / 10px 10px',
        }}
        onError={(e) => {
          e.currentTarget.style.opacity = 0.3;
        }}
      />
      <div
        style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono, monospace)',
          color: 'var(--text-primary)',
          textAlign: 'center',
          width: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={graphic.key}
      >
        {graphic.key}
      </div>
      <div
        style={{
          fontSize: 9,
          color: 'var(--text-muted)',
        }}
      >
        {graphic.mimeType?.replace('image/', '') || '?'} · {formatBytes(graphic.sizeBytes)}
      </div>
      {readOnly ? (
        <div
          style={{
            fontSize: 9,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}
        >
          shared (legacy)
        </div>
      ) : (
        <Button variant="danger" onClick={onDelete}>
          Delete
        </Button>
      )}
    </div>
  );
}

function LayoutMetaEditor({
  layout,
  variant,
  onNameChange,
  onVariantChange,
  onVariantReset,
  collapsed: collapsedDefault,
}) {
  // Local state, but seeded from the prop so the parent can hint at
  // initial collapse state (collapsed=true when a slot is selected and
  // we want to give the layers panel visual priority).
  const [collapsed, setCollapsed] = useState(!!collapsedDefault);

  // When the prop transitions from false → true (slot selected), auto-
  // collapse. But don't fight the user — if they manually expand it,
  // a subsequent slot selection won't re-collapse it.
  // Actually, simplest: just sync to the prop on change. Most operators
  // won't be obsessing over this.
  useEffect(() => {
    setCollapsed(!!collapsedDefault);
  }, [collapsedDefault]);

  // Phase 57B: canvas/dpi/background are per-variant. A field "owns" a
  // value if the active variant has its own key; otherwise it inherits
  // the (deprecated) layout-root value — the same variant-first /
  // root-fallback resolution compositeService uses at render time (57A).
  const variantDef =
    (layout.variants && layout.variants[variant]) || null;

  const META = [
    { key: 'sheetWidth', label: 'Sheet width (in)', step: '0.25', def: 0, kind: 'num' },
    { key: 'sheetHeight', label: 'Sheet height (in)', step: '0.25', def: 0, kind: 'num' },
    {
      key: 'dpi',
      label: 'DPI',
      step: '50',
      def: 300,
      kind: 'num',
      hint: '300 is typical for print',
    },
    { key: 'backgroundColor', label: 'Background', def: '#ffffff', kind: 'text' },
  ];

  const owns = (k) =>
    !!variantDef && Object.prototype.hasOwnProperty.call(variantDef, k);
  const effective = (k, def) => {
    if (owns(k)) return variantDef[k];
    if (layout[k] !== undefined && layout[k] !== null) return layout[k];
    return def;
  };

  const ownCount = META.filter((m) => owns(m.key)).length;
  const inheritCount = META.length - ownCount;
  const variantLabel =
    variant.charAt(0).toUpperCase() + variant.slice(1);

  return (
    <Section
      title={`Layout properties — ${variantLabel}`}
      description={
        collapsed
          ? null
          : `Canvas / DPI / background for the ${variant} variant — independent per orientation. Name is shared across both variants.`
      }
      actions={
        <Button variant="ghost" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? 'Expand' : 'Collapse'}
        </Button>
      }
    >
      {collapsed ? (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span>{layout.name || '(unnamed)'}</span>
          <span>·</span>
          <span style={{ textTransform: 'capitalize' }}>{variant}</span>
          <span>·</span>
          <span>
            {effective('sheetWidth', 0)}″ × {effective('sheetHeight', 0)}″
          </span>
          <span>·</span>
          <span>{effective('dpi', 300)}dpi</span>
          <span>·</span>
          <span>
            {ownCount}/{META.length} own
          </span>
        </div>
      ) : (
        <>
          <div
            style={{
              fontSize: 11,
              marginBottom: 10,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              color: 'var(--text-muted)',
            }}
          >
            <strong
              style={{ color: 'var(--text)', textTransform: 'capitalize' }}
            >
              {variant}
            </strong>
            <span>
              {ownCount} independent · {inheritCount} inheriting shared
              default
            </span>
          </div>

          <FormRow label="Name" hint="Shared across both variants">
            <TextInput
              value={layout.name || ''}
              onChange={(v) => onNameChange(v)}
            />
          </FormRow>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
            }}
          >
            {META.map((m) => {
              const isOwn = owns(m.key);
              const val = effective(m.key, m.def);
              return (
                <FormRow key={m.key} label={m.label} hint={m.hint}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 4,
                    }}
                  >
                    {isOwn ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: '#1d4ed8',
                          background: 'rgba(29,78,216,0.12)',
                          padding: '1px 6px',
                          borderRadius: 999,
                        }}
                      >
                        ● Own
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10,
                          fontStyle: 'italic',
                          color: 'var(--text-muted)',
                        }}
                      >
                        Inherited (shared default)
                      </span>
                    )}
                    {isOwn && (
                      <button
                        type="button"
                        onClick={() => onVariantReset(m.key)}
                        style={{
                          fontSize: 10,
                          color: 'var(--text-muted)',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                      >
                        Use shared default
                      </button>
                    )}
                  </div>
                  {m.kind === 'num' ? (
                    <NumberInput
                      value={val || 0}
                      onChange={(v) =>
                        onVariantChange({ [m.key]: Number(v) || m.def })
                      }
                      step={m.step}
                    />
                  ) : (
                    <TextInput
                      value={val || m.def}
                      onChange={(v) => onVariantChange({ [m.key]: v })}
                      monospace
                    />
                  )}
                </FormRow>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}

// ─── Layers panel ──────────────────────────────────────────
//
// Photoshop-style stack of slot cards. Each card represents one slot;
// cards are listed in REVERSE JSON-array order, so the topmost slot in
// the canvas (last in JSON) appears at the top of the panel.
//
// Each card:
//   - Header: kind icon + label + up/down/delete buttons (always visible)
//   - Body: the full property editor (only when card is selected/expanded)
//
// Selection ↔ canvas: clicking a card header selects the slot on the
// canvas and vice versa. The selected card is the only expanded one.
//
// Add buttons sit in the panel header so operators can build up a
// layout with one obvious "where do new slots come from?" affordance.

function LayersPanel({
  slots,
  selectedIndex,
  variantName,
  sheetWidth,
  sheetHeight,
  onSelect,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onReorder,
  onAdd,
  disabled,
  // Phase 9c: graphics library for staticGraphic slot editing
  layoutId,
  variant,
  graphicsLibrary,
  legacyGraphics,
  onUploadGraphic,
  graphicsBust,
  // Phase 9e: per-slot hide/lock state + togglers
  hiddenSlots,
  lockedSlots,
  onToggleHidden,
  onToggleLocked,
}) {
  const slotTypes = [
    { kind: 'playerPhoto', label: 'Player' },
    // Phase 10: per-order customer-selected background photo.
    // Drawn behind the player photo (added later in array → drawn
    // earlier → on bottom). Operators add this BEFORE the player
    // for correct stacking, OR add it after and use the down arrow.
    { kind: 'playerBackground', label: 'BG' },
    { kind: 'teamPhoto', label: 'Team' },
    { kind: 'logo', label: 'Logo' },
    { kind: 'staticGraphic', label: 'Graphic' },
    { kind: 'text', label: 'Text' },
  ];

  // Display order = reverse of JSON array order. We map over the
  // reversed array but pass the ORIGINAL JSON index to handlers.
  // displayOrder[0] = slots[slots.length - 1] → top of canvas.
  const displayList = slots
    .map((slot, idx) => ({ slot, jsonIndex: idx }))
    .reverse();

  // Drag state: which jsonIdx is currently being dragged, and which
  // jsonIdx (+ position 'above'/'below') is the current drop target.
  // The drop indicator (a colored bar) renders based on these values.
  const [dragJsonIdx, setDragJsonIdx] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  // dropTarget: { jsonIdx, position: 'above'|'below' } | null

  function handleDragStart(jsonIdx) {
    setDragJsonIdx(jsonIdx);
  }

  function handleDragOver(e, targetJsonIdx) {
    if (dragJsonIdx === null) return;
    e.preventDefault(); // allow drop
    e.dataTransfer.dropEffect = 'move';

    // Compute "above" or "below" based on cursor Y vs target's
    // bounding box midpoint
    const rect = e.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const position = e.clientY < midpoint ? 'above' : 'below';

    // Avoid no-op state updates that would re-render every mousemove
    setDropTarget((prev) => {
      if (prev && prev.jsonIdx === targetJsonIdx && prev.position === position) {
        return prev;
      }
      return { jsonIdx: targetJsonIdx, position };
    });
  }

  function handleDragEnd() {
    setDragJsonIdx(null);
    setDropTarget(null);
  }

  function handleDrop(e, targetJsonIdx) {
    e.preventDefault();
    if (dragJsonIdx === null) {
      handleDragEnd();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const position = e.clientY < midpoint ? 'above' : 'below';
    onReorder && onReorder(dragJsonIdx, targetJsonIdx, position);
    handleDragEnd();
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Panel header — title + add buttons. Sticky so the "Add" buttons
          stay visible even when the cards body grows tall (selected card
          expands inline showing the full editor). */}
      <div
        style={{
          padding: '12px 16px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: '6px 6px 0 0',
          borderBottom: 'none',
          position: 'sticky',
          top: 0,
          zIndex: 5,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 8,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Layers ({slots.length})
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                color: 'var(--text-muted)',
                fontWeight: 400,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              {variantName}
            </span>
          </h3>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            marginBottom: 8,
          }}
        >
          Top of list = top layer on canvas. Drag the ⋮⋮ handle to reorder, or use ↑/↓.
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {slotTypes.map((t) => (
            <Button
              key={t.kind}
              variant="ghost"
              onClick={() => onAdd(t.kind)}
              disabled={disabled}
            >
              + {t.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Layer cards */}
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: '0 0 6px 6px',
        }}
      >
        {displayList.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}
          >
            No layers yet — use the buttons above to add one.
          </div>
        ) : (
          displayList.map(({ slot, jsonIndex }, displayIdx) => {
            const isDropAbove =
              dropTarget &&
              dropTarget.jsonIdx === jsonIndex &&
              dropTarget.position === 'above';
            const isDropBelow =
              dropTarget &&
              dropTarget.jsonIdx === jsonIndex &&
              dropTarget.position === 'below';
            const isDragging = dragJsonIdx === jsonIndex;
            return (
              <LayerCard
                key={jsonIndex}
                slot={slot}
                jsonIndex={jsonIndex}
                displayIndex={displayIdx}
                isLast={displayIdx === displayList.length - 1}
                isFirst={displayIdx === 0}
                isSelected={selectedIndex === jsonIndex}
                isDragging={isDragging}
                isDropAbove={isDropAbove}
                isDropBelow={isDropBelow}
                sheetWidth={sheetWidth}
                sheetHeight={sheetHeight}
                onSelect={() => onSelect(jsonIndex)}
                onCollapse={() => onSelect(null)}
                onChange={(newSlot) => onChange(jsonIndex, newSlot)}
                onDelete={() => onDelete(jsonIndex)}
                onMoveUp={() => onMoveUp(jsonIndex)}
                onMoveDown={() => onMoveDown(jsonIndex)}
                onDragStart={() => handleDragStart(jsonIndex)}
                onDragOver={(e) => handleDragOver(e, jsonIndex)}
                onDragEnd={handleDragEnd}
                onDrop={(e) => handleDrop(e, jsonIndex)}
                layoutId={layoutId}
                variant={variant}
                graphicsLibrary={graphicsLibrary}
                legacyGraphics={legacyGraphics}
                onUploadGraphic={onUploadGraphic}
                graphicsBust={graphicsBust}
                isHidden={!!(hiddenSlots && hiddenSlots[jsonIndex])}
                isLocked={!!(lockedSlots && lockedSlots[jsonIndex])}
                onToggleHidden={() =>
                  onToggleHidden && onToggleHidden(jsonIndex)
                }
                onToggleLocked={() =>
                  onToggleLocked && onToggleLocked(jsonIndex)
                }
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function LayerCard({
  slot,
  jsonIndex,
  displayIndex,
  isFirst,
  isLast,
  isSelected,
  isDragging,
  isDropAbove,
  isDropBelow,
  sheetWidth,
  sheetHeight,
  onSelect,
  onCollapse,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  // Phase 9c
  layoutId,
  variant,
  graphicsLibrary,
  legacyGraphics,
  onUploadGraphic,
  graphicsBust,
  // Phase 9e
  isHidden,
  isLocked,
  onToggleHidden,
  onToggleLocked,
}) {
  // HTML5 drag-and-drop only fires when the element has draggable=true
  // at dragstart time. To restrict drag to the handle (vs anywhere on
  // the card), we toggle the draggable attribute via a ref that's set
  // when the user mousedowns on the handle and cleared on mouseup or
  // dragend. The `draggable` attribute is read fresh on dragstart so
  // a transient state flag works.
  const dragArmedRef = useRef(false);

  function handleDragHandleMouseDown() {
    dragArmedRef.current = true;
  }

  function handleCardDragStart(e) {
    if (!dragArmedRef.current) {
      e.preventDefault();
      return;
    }
    // Most browsers need *some* data on the drag for it to fire.
    e.dataTransfer.setData('text/plain', String(jsonIndex));
    e.dataTransfer.effectAllowed = 'move';
    onDragStart && onDragStart();
  }

  function handleCardDragEnd() {
    dragArmedRef.current = false;
    onDragEnd && onDragEnd();
  }

  // Compute a quick label for the collapsed card. Text slots show their
  // text content (truncated); image slots show their kind name.
  const label = (() => {
    if (slot.kind === 'text') {
      const t = slot.text || '(empty)';
      return t.length > 30 ? t.slice(0, 27) + '…' : t;
    }
    return SLOT_KIND_LABELS[slot.kind] || slot.kind;
  })();

  const swatchColor = SLOT_KIND_COLORS[slot.kind] || '#888';

  return (
    <div
      // Draggable card. Drag-init is gated by dragArmedRef which is
      // only true when the user mousedown'd on the ⋮⋮ handle.
      draggable
      onDragStart={handleCardDragStart}
      onDragOver={onDragOver}
      onDragEnd={handleCardDragEnd}
      onDrop={onDrop}
      style={{
        borderTop: displayIndex > 0 ? '1px solid var(--border-color)' : 'none',
        background: isSelected ? 'rgba(74,127,193,0.05)' : 'transparent',
        // Phase 9e: hidden cards dim noticeably. Locked cards keep
        // their normal background (the lock icon makes the state
        // obvious enough). Dragging takes precedence over both.
        opacity: isDragging ? 0.4 : isHidden ? 0.45 : 1,
        position: 'relative',
      }}
    >
      {/* Drop indicator lines — colored bars that show where the
          dragged card will land. Rendered as absolutely-positioned
          divs at the top or bottom edge of the target card. */}
      {isDropAbove && (
        <div
          style={{
            position: 'absolute',
            top: -1,
            left: 0,
            right: 0,
            height: 2,
            background: '#4a7fc1',
            zIndex: 2,
            pointerEvents: 'none',
          }}
        />
      )}
      {isDropBelow && (
        <div
          style={{
            position: 'absolute',
            bottom: -1,
            left: 0,
            right: 0,
            height: 2,
            background: '#4a7fc1',
            zIndex: 2,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Card header — always visible. Phase 9f: tighter padding so
          cards are more compact, leaving more vertical space for
          the editor body when expanded. */}
      <div
        onClick={onSelect}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          cursor: 'pointer',
          borderLeft: isSelected ? '3px solid #4a7fc1' : '3px solid transparent',
        }}
      >
        {/* Drag handle. Mousedown here arms the drag-init. Click event
            still fires through to the card header (selecting the slot)
            unless an actual drag begins. */}
        <span
          onMouseDown={handleDragHandleMouseDown}
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
          style={{
            cursor: 'grab',
            color: 'var(--text-muted)',
            fontSize: 13,
            fontWeight: 700,
            userSelect: 'none',
            padding: '0 3px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ⋮⋮
        </span>

        {/* Color swatch indicating the slot kind */}
        <div
          style={{
            width: 12,
            height: 12,
            background: swatchColor,
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 3,
            flexShrink: 0,
          }}
        />

        {/* Kind + label */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </div>
          <div
            style={{
              fontSize: 9,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono, monospace)',
            }}
          >
            {slot.kind} · {fmt(slot.x)}″,{fmt(slot.y)}″ · {fmt(slot.w)}×{fmt(slot.h)}
          </div>
        </div>

        {/* Reorder + delete buttons. Stop propagation so clicking these
            doesn't also select the card (which would expand it after
            clicking up/down — confusing). */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {/* Phase 9e: hide/lock toggles. Visible per-card icons that
              flip designer-only view state. */}
          <IconButton
            label={isHidden ? 'Show this layer' : 'Hide this layer'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden && onToggleHidden();
            }}
          >
            {isHidden ? '⊘' : '👁'}
          </IconButton>
          <IconButton
            label={isLocked ? 'Unlock this layer' : 'Lock this layer'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleLocked && onToggleLocked();
            }}
          >
            {isLocked ? '🔒' : '🔓'}
          </IconButton>
          <IconButton
            label="Move up"
            disabled={isFirst}
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp();
            }}
          >
            ↑
          </IconButton>
          <IconButton
            label="Move down"
            disabled={isLast}
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown();
            }}
          >
            ↓
          </IconButton>
          <IconButton
            label="Delete"
            danger
            onClick={(e) => {
              e.stopPropagation();
              if (
                window.confirm(
                  `Delete this ${slot.kind} layer? You can also press Discard at the top of the page to revert.`
                )
              ) {
                onDelete();
              }
            }}
          >
            ✕
          </IconButton>
          <IconButton
            label={isSelected ? 'Collapse layer details' : 'Expand layer details'}
            onClick={(e) => {
              e.stopPropagation();
              if (isSelected) {
                onCollapse && onCollapse();
              } else {
                onSelect && onSelect();
              }
            }}
          >
            {isSelected ? '▼' : '▶'}
          </IconButton>
        </div>
      </div>

      {/* Card body — full editor, only when selected. Phase 9e: when
          the slot is locked, show a notice instead of the editor.
          Property-level changes are blocked while locked; the operator
          must unlock first. This matches the canvas behavior (locked
          slots can't be dragged) for consistency. */}
      {isSelected && (
        <div
          style={{
            padding: '8px 16px 16px 16px',
            borderTop: '1px solid var(--border-color)',
          }}
        >
          {isLocked ? (
            <div
              style={{
                padding: 12,
                background: 'rgba(255,255,255,0.04)',
                border: '1px dashed var(--border-color)',
                borderRadius: 4,
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: 12,
              }}
            >
              🔒 This layer is locked. Click the unlock icon above to
              edit its properties.
            </div>
          ) : (
            <SlotEditorBody
              slot={slot}
              sheetWidth={sheetWidth}
              sheetHeight={sheetHeight}
              onChange={onChange}
              layoutId={layoutId}
              variant={variant}
              graphicsLibrary={graphicsLibrary}
              legacyGraphics={legacyGraphics}
              onUploadGraphic={onUploadGraphic}
              graphicsBust={graphicsBust}
            />
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({ children, onClick, disabled, danger, label }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        background: 'transparent',
        border: '1px solid var(--border-color)',
        color: disabled
          ? 'var(--text-muted)'
          : danger
          ? '#dc3545'
          : 'var(--text-primary)',
        // Phase 9f: larger touch/click targets. Was 26×26 / fontSize 12.
        // Bumped to 30 to be more obvious without making card heights
        // dominate.
        width: 30,
        height: 30,
        borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 15,
        fontFamily: 'inherit',
        opacity: disabled ? 0.4 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

const SLOT_KIND_LABELS = {
  playerPhoto: 'Player photo',
  // Phase 10: customer-selected background photo, layered behind player.
  playerBackground: 'Player background',
  teamPhoto: 'Team photo',
  logo: 'Logo',
  // Phase 9c: rename Overlay → Static graphic. Persist legacy 'overlay'
  // → same label so existing layouts still display correctly.
  staticGraphic: 'Static graphic',
  overlay: 'Static graphic',
  text: 'Text',
};

const SLOT_KIND_COLORS = {
  playerPhoto: '#5d8fc4',
  // Phase 10
  playerBackground: '#5dc4b8',
  teamPhoto: '#c46060',
  logo: '#7cc46d',
  staticGraphic: '#b888d0',
  overlay: '#b888d0',
  text: '#888888',
};

// ─── Slot factories ────────────────────────────────────────

function makeDefaultSlot(kind, x, y, w, h) {
  const base = { kind, x, y, w, h };
  switch (kind) {
    case 'playerPhoto':
    case 'teamPhoto':
    case 'playerBackground':
      // Phase 10: backgrounds default to cover — they're meant to
      // fill behind the player photo.
      return { ...base, fit: 'cover' };
    case 'logo':
      return { ...base, fit: 'contain' };
    case 'staticGraphic':
      // Phase 9c: replaces 'overlay'. graphicKey is initially empty
      // — operator picks an existing graphic from the layout's library
      // or uploads a new one via the slot editor. Empty key renders
      // a placeholder rect labeled "Static graphic (no upload)".
      return { ...base, fit: 'contain', graphicKey: '' };
    case 'text':
      return {
        ...base,
        text: '{subject.athleteName}',
        fontSize: 24,
        fontFamily: 'Arial',
        color: '#000000',
        align: 'center',
        weight: 'normal',
      };
    default:
      return base;
  }
}
