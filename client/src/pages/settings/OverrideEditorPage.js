import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  NumberInput,
  Button,
  StatusBanner,
} from '../../components/SettingsForm';
import LayoutCanvas, {
  PLACEHOLDER_TOKENS,
  DEFAULT_SNAP_STEP,
  substituteTokens,
} from '../../components/LayoutCanvas';

/**
 * Phase 11 — Override editor.
 *
 * A trimmed-down version of the layout designer focused on fast,
 * surgical adjustments to one cart line's render. Differences from
 * the designer:
 *
 *   - Real-data preview is the DEFAULT view (the operator's whole
 *     reason for being here is to fix a specific customer's photo).
 *   - Mouse wheel scales the selected slot (LayoutCanvas's
 *     enableWheelScale prop).
 *   - Quick-edit property panel: only x/y/w/h for image slots, plus
 *     fontSize for text. No font family/color/weight changes — those
 *     should never need adjustment per-order; if they do, fix the
 *     layout instead.
 *   - Variant picker hidden — the variant was decided when the order
 *     was first rendered (by player photo orientation). Operators
 *     don't pick variants here.
 *   - Three primary actions:
 *       Apply (Overwrite): rerender, replace original file. Use
 *         when the order hasn't been printed yet.
 *       Apply (Reprint): rerender to a _REPRINT file with a new
 *         single-item .txt. Use after the order printed and one
 *         item needs a redo.
 *       Remove override: delete the override. By default, also
 *         re-renders with the original layout to restore the file.
 *
 * Drift detection: if the underlying base layout has been edited
 * since the override was snapshotted, a banner appears so the
 * operator knows. The override still works (snapshot semantics) —
 * the banner just informs.
 */
export default function OverrideEditorPage() {
  const { orderId, cartId } = useParams();
  const navigate = useNavigate();
  // Phase 48a: `?from=order` query param signals the operator arrived
  // from the order detail page's "Edit layout" button (single-item fix
  // flow). When set, Save (no render) auto-returns to that order on
  // success. When absent (Settings → Order Overrides search, internal
  // OrderSwitcher), Save stays on the editor to support batch-staging
  // multiple fixes in the same order. Query param chosen over
  // location.state so the signal survives a hard refresh — operator
  // who Ctrl+Shift+R's mid-edit doesn't silently lose the auto-return.
  const [searchParams] = useSearchParams();
  const fromOrder = searchParams.get('from') === 'order';

  // ─── Data state ─────────────────────────────────────────
  const [order, setOrder] = useState(null);
  const [lineItem, setLineItem] = useState(null);
  const [layout, setLayout] = useState(null);  // current working layout (mutable)
  const [baseLayout, setBaseLayout] = useState(null);  // layout from disk, for drift detection
  const [variant, setVariant] = useState('vertical');
  const [layoutSource, setLayoutSource] = useState(null); // 'override' | 'mapping'

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ─── UI state ──────────────────────────────────────────
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [snapEnabled, setSnapEnabled] = useState(true);

  // Phase 11c: per-variant per-slot lock state. Locked slots
  // can't be selected by canvas clicks AND don't intercept clicks
  // (they're pointer-events:none in the canvas). Used to prevent
  // accidentally grabbing the wrong layer when overlapping slots
  // exist. NOT persisted to the override snapshot — purely a UI
  // affordance for THIS editing session.
  //
  // Auto-lock policy on layout load: graphics and background photos
  // are locked by default because operators rarely adjust them
  // per-order. They can unlock via the layers panel if needed.
  const [lockedSlotsByVariant, setLockedSlotsByVariant] = useState({
    vertical: {},
    horizontal: {},
  });

  // ─── Action state ──────────────────────────────────────
  const [actionLoading, setActionLoading] = useState(null); // 'overwrite' | 'reprint' | 'remove' | 'save' | null
  const [actionResult, setActionResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  // ─── Team photo URL (Phase 11f) ────────────────────────
  // Fetched lazily once we have the line item. Used as a live
  // overlay on the canvas so the operator sees the team photo
  // following its slot, same as the player photo.
  const [teamPhotoUrl, setTeamPhotoUrl] = useState(null);

  // ─── Switcher state (Phase 11a) ─────────────────────────
  // Allow the operator to load a different order without going
  // back to the picker page. Type a new order ID + Load → picker
  // shows below → click a line item → navigate to that override
  // editor. State here is independent of the editor's active
  // (orderId, cartId) — it's a UI-only "let me browse orders".
  const [switcherOrderId, setSwitcherOrderId] = useState('');
  const [switcherLineItems, setSwitcherLineItems] = useState(null);
  const [switcherLoading, setSwitcherLoading] = useState(false);
  const [switcherError, setSwitcherError] = useState(null);
  const [switcherLoadedFor, setSwitcherLoadedFor] = useState('');

  async function loadSwitcherOrder(idStr) {
    const id = idStr || switcherOrderId;
    if (!id) return;
    setSwitcherLoading(true);
    setSwitcherError(null);
    setSwitcherLineItems(null);
    try {
      const r = await api.get(
        `/api/sytist/orders/${encodeURIComponent(id)}`
      );
      const o = r.order;
      if (!o) {
        setSwitcherError('Order not found');
        return;
      }
      const items = (o.lineItems || []).filter(
        (li) => li.photo && li.photo.fullUrl
      );
      if (items.length === 0) {
        setSwitcherError('Order has no photo line items');
        return;
      }
      setSwitcherLineItems(items);
      setSwitcherLoadedFor(String(id));
    } catch (err) {
      setSwitcherError(err.message);
    } finally {
      setSwitcherLoading(false);
    }
  }

  function switchTo(newCartId) {
    navigate(`/settings/overrides/${switcherLoadedFor}/${newCartId}`);
  }

  // ─── Initial load ──────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        // 1. Fetch the order + line item
        const orderResp = await api.get(
          `/api/sytist/orders/${encodeURIComponent(orderId)}`
        );
        const o = orderResp.order;
        if (!o) {
          if (!cancelled) setError(`Order ${orderId} not found`);
          return;
        }
        const li = (o.lineItems || []).find(
          (x) => String(x.cartId) === String(cartId)
        );
        if (!li) {
          if (!cancelled)
            setError(`Cart ${cartId} not found in order ${orderId}`);
          return;
        }

        if (cancelled) return;
        setOrder(o);
        setLineItem(li);

        // 2. Try to load an existing override
        const ovResp = await api.get(
          `/api/sytist/overrides/${encodeURIComponent(orderId)}/${encodeURIComponent(cartId)}`
        );
        const override = ovResp.override;

        if (override) {
          // Override exists — use its snapshot as the working layout
          if (cancelled) return;
          setLayout(override.layoutSnapshot);
          setVariant(override.variant);
          setLayoutSource('override');

          // Also fetch the CURRENT base layout (for drift detection).
          // The override's snapshot may be stale.
          try {
            const baseResp = await api.get(
              `/api/sytist/composite/layouts/${encodeURIComponent(override.layoutId)}`
            );
            // The layout endpoint returns the layout directly (not
            // wrapped in { layout: ... }). Same response shape as the
            // designer's layout loader uses.
            if (!cancelled && baseResp && baseResp.id) {
              setBaseLayout(baseResp);
            }
          } catch {
            // Base layout might have been deleted — non-fatal.
            // Override snapshot is self-contained, so the editor
            // still works.
          }
        } else {
          // No override — find the SKU's mapped layout
          const mappingResp = await api.get(
            `/api/sytist/composite/mappings`
          );
          const mappings = mappingResp.mappings || [];
          const m = mappings.find(
            (mm) => mm.externalId === li.sku
          );
          if (!m) {
            if (!cancelled)
              setError(
                `No composite mapping for SKU "${li.sku}" — can't determine which layout to override.`
              );
            return;
          }
          const layoutResp = await api.get(
            `/api/sytist/composite/layouts/${encodeURIComponent(m.layoutId)}`
          );
          // The layout endpoint returns the layout directly (not
          // wrapped in { layout: ... }).
          if (!cancelled && layoutResp && layoutResp.id) {
            setLayout(layoutResp);
            setBaseLayout(layoutResp);
            setLayoutSource('mapping');
            // Pick variant the same way the server would, so the
            // canvas matches what production will render.
            const photoW = li.photo?.width || 0;
            const photoH = li.photo?.height || 0;
            // Variant heuristic: if the layout has both, pick the
            // one matching photo orientation. Otherwise use whatever
            // exists.
            const hasV = !!layoutResp.variants?.vertical;
            const hasH = !!layoutResp.variants?.horizontal;
            if (hasV && hasH) {
              setVariant(photoW > photoH ? 'horizontal' : 'vertical');
            } else if (hasV) {
              setVariant('vertical');
            } else if (hasH) {
              setVariant('horizontal');
            }
          } else if (!cancelled) {
            // Defensive: if the layout came back in an unexpected shape,
            // surface that instead of going blank.
            setError(
              `Layout "${m.layoutId}" loaded with unexpected shape — cannot edit.`
            );
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [orderId, cartId]);

  // ─── Team photo URL fetch (Phase 11f) ───────────────────
  // Look up the team photo for this cart line's sub-gallery so
  // the canvas can render it as a live overlay. We only need the
  // URL; the canvas does the rest. Failure is non-fatal — team
  // photo just won't show as a live overlay, but the rest of the
  // editor works.
  useEffect(() => {
    if (!lineItem || !lineItem.subGalleryId) {
      setTeamPhotoUrl(null);
      return;
    }
    let cancelled = false;
    api
      .get(
        `/api/sytist/team-photo/lookup?subGalleryId=${lineItem.subGalleryId}`
      )
      .then((r) => {
        if (cancelled) return;
        if (r?.found && r?.photo?.fullUrl) {
          setTeamPhotoUrl(r.photo.fullUrl);
        }
      })
      .catch(() => {
        // Non-fatal — team photo just won't have a live overlay.
      });
    return () => {
      cancelled = true;
    };
  }, [lineItem]);

  // ─── Live preview (debounced) ──────────────────────────

  // ─── Live preview ───────────────────────────────────────
  //
  // Phase 11f: removed. Previously fired /composite/preview on every
  // layout change so a server-rendered backdrop could show under the
  // canvas. We now render everything live via SVG in the canvas
  // itself — graphics, logos, text, photos all as SVG <image>/<text>
  // elements at their slot coordinates. Faster (no server round-trip),
  // and crucially, no double-rendering of text/graphics when the
  // server's baked-in version overlaps with the live overlay.
  //
  // The Apply buttons still trigger server renders for the actual
  // output files — the SVG canvas is just the editor's visualization.


  // ─── Auto-lock graphics + backgrounds (Phase 11c) ────────
  //
  // Operators rarely adjust the static graphic frame or the
  // playerBackground per-order. Auto-lock those slot kinds when
  // a layout is first loaded so canvas clicks pass through them
  // to the layers underneath (player photo, team photo, text).
  //
  // Triggered ONLY when layout.id changes — otherwise every
  // slot change would re-seed the locks and overwrite manual
  // unlocks. Subsequent edits leave the lock map alone.
  const lastSeededLayoutIdRef = useRef(null);
  useEffect(() => {
    if (!layout || !layout.id) return;
    if (lastSeededLayoutIdRef.current === layout.id) return;
    lastSeededLayoutIdRef.current = layout.id;

    const seedFor = (variantName) => {
      const slots = layout.variants?.[variantName]?.slots || [];
      const locks = {};
      slots.forEach((s, i) => {
        if (
          s.kind === 'staticGraphic' ||
          s.kind === 'overlay' ||
          s.kind === 'playerBackground'
        ) {
          locks[i] = true;
        }
      });
      return locks;
    };
    setLockedSlotsByVariant({
      vertical: seedFor('vertical'),
      horizontal: seedFor('horizontal'),
    });
  }, [layout]);

  const lockedSlots = lockedSlotsByVariant[variant] || {};

  function toggleSlotLocked(index) {
    setLockedSlotsByVariant((prev) => {
      const current = prev[variant] || {};
      const next = { ...current };
      if (next[index]) {
        delete next[index];
      } else {
        next[index] = true;
      }
      return { ...prev, [variant]: next };
    });
  }

  // ─── Drift detection ───────────────────────────────────

  const layoutDrifted = useMemo(() => {
    if (layoutSource !== 'override') return false;
    if (!baseLayout || !layout) return false;
    // We compare ONLY the variant being edited — operator might
    // care about a horizontal/vertical drift but for now this
    // override is for one variant.
    const baseSlots = baseLayout.variants?.[variant]?.slots || [];
    const ourSlots = layout.variants?.[variant]?.slots || [];
    // Crude: same-length + same kinds in same order. Rough enough
    // for the warning banner — operator decides whether to act.
    if (baseSlots.length !== ourSlots.length) return true;
    for (let i = 0; i < baseSlots.length; i++) {
      if (baseSlots[i].kind !== ourSlots[i].kind) return true;
    }
    return false;
  }, [baseLayout, layout, variant, layoutSource]);

  // Phase 11f: build a graphics URL map from layout.graphics so
  // the canvas can render static graphic slots inline (the canvas
  // needs URLs per graphicKey). Each layout's graphics live at
  // /api/sytist/composite/layouts/{layoutId}/graphics/{key}/preview
  // (public, no auth needed — Phase 9e-hotfix3).
  //
  // Phase 11g: this useMemo MUST live above the early-return
  // guards below. Hooks called conditionally are a rules-of-hooks
  // violation. Returns {} when layout isn't loaded yet so callers
  // can safely use it before the layout is ready.
  const graphicsUrls = useMemo(() => {
    if (!layout?.id || !layout?.graphics) return {};
    const map = {};
    for (const key of Object.keys(layout.graphics)) {
      const meta = layout.graphics[key];
      const bust = meta?.uploadedAt
        ? `?v=${encodeURIComponent(meta.uploadedAt)}`
        : '';
      map[key] = `/api/sytist/composite/layouts/${encodeURIComponent(
        layout.id
      )}/graphics/${encodeURIComponent(key)}/preview${bust}`;
    }
    return map;
  }, [layout]);

  // ─── Slot edit handlers ────────────────────────────────

  function handleSlotChange(index, newSlot) {
    setLayout((prev) => {
      if (!prev) return prev;
      const variantDef = prev.variants?.[variant];
      if (!variantDef) return prev;
      const nextSlots = variantDef.slots.map((s, i) =>
        i === index ? newSlot : s
      );
      return {
        ...prev,
        variants: {
          ...prev.variants,
          [variant]: { ...variantDef, slots: nextSlots },
        },
      };
    });
  }

  // ─── Action handlers ───────────────────────────────────

  async function applyOverride(mode) {
    if (!layout) return;
    setActionLoading(mode);
    setActionError(null);
    setActionResult(null);
    try {
      // First save the override (so the snapshot reflects what the
      // operator sees on screen).
      await api.post(
        `/api/sytist/overrides/${encodeURIComponent(orderId)}/${encodeURIComponent(cartId)}`,
        {
          layoutId: layout.id,
          variant,
          layoutSnapshot: layout,
          // originalCompositeFilename: server preserves any existing
          // value, so we don't need to send it. The first save will
          // pick up the filename from the upcoming render.
        }
      );

      // Then trigger the render
      const r = await api.post(
        `/api/sytist/overrides/${encodeURIComponent(orderId)}/${encodeURIComponent(cartId)}/render`,
        { mode }
      );
      setActionResult({
        mode,
        compositeFilename: r.compositeFilename,
        compositePath: r.compositePath,
        txtPath: r.txtPath,
        warnings: r.warnings || [],
      });
      // Phase 47a: terminal actions (Overwrite / Reprint) navigate
      // back to the order detail page on success. The updated
      // thumbnail there is itself the confirmation — no need for the
      // operator to read filename detail on this page. Save (no
      // render) intentionally does NOT navigate, since it's a batch-
      // staging action where the operator typically wants to edit
      // additional items in the same order.
      navigate(`/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  // Phase 40: save the override WITHOUT triggering an immediate render.
  // Used when staging multiple tweaks: open editor → fix → Save → close
  // → fix another item → Save → ... → Process or Reprint the whole
  // order. The pipeline's composite-render loop picks up saved
  // overrides on the cart_ids that have them and uses the original
  // template for those that don't.
  async function saveOverrideOnly() {
    if (!layout) return;
    setActionLoading('save');
    setActionError(null);
    setActionResult(null);
    try {
      await api.post(
        `/api/sytist/overrides/${encodeURIComponent(orderId)}/${encodeURIComponent(cartId)}`,
        {
          layoutId: layout.id,
          variant,
          layoutSnapshot: layout,
        }
      );
      setActionResult({ mode: 'save' });
      // Phase 48a: when the operator arrived from a single-item fix
      // flow (`?from=order`), auto-return to the order detail page on
      // success — matches the Apply (Overwrite/Reprint) navigation
      // pattern from Phase 47a. The ⚠ Layout edited badge on the
      // order page is the in-context confirmation. When the param is
      // absent (Settings multi-item search, OrderSwitcher), Save
      // stays on the editor so batch-staging across cart lines works
      // as before.
      if (fromOrder) {
        navigate(`/orders/${encodeURIComponent(orderId)}`);
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function removeOverride() {
    if (
      !window.confirm(
        'Remove this override? The on-disk image will be re-rendered using the original layout to restore it.'
      )
    ) {
      return;
    }
    setActionLoading('remove');
    setActionError(null);
    setActionResult(null);
    try {
      // api.del() doesn't accept a body — use _fetch directly so we
      // can send rerenderOriginal: true. The server's DELETE handler
      // reads the body to decide whether to restore.
      const r = await api._fetch(
        `/api/sytist/overrides/${encodeURIComponent(orderId)}/${encodeURIComponent(cartId)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ rerenderOriginal: true }),
        }
      );
      setActionResult({
        mode: 'remove',
        removed: r.removed,
        restored: r.restored,
        restoreError: r.restoreError,
      });
      // After successful remove, navigate back to the picker
      setTimeout(() => navigate('/settings/overrides'), 1500);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  // ─── Render guards ─────────────────────────────────────

  if (loading) {
    return (
      <div>
        <PageHeader title="Override Editor" />
        <div style={{ padding: 20, color: 'var(--text-muted)' }}>
          Loading…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Override Editor" />
        <StatusBanner kind="error">{error}</StatusBanner>
        <Button onClick={() => navigate('/settings/overrides')}>
          ← Back
        </Button>
      </div>
    );
  }
  if (!layout || !lineItem || !order) {
    // Defensive — if we get here in production it means the loader
    // completed without throwing and without setting either an error
    // or the data. That used to render a blank page; now at least we
    // surface the situation so the operator can refresh or report.
    return (
      <div>
        <PageHeader title="Override Editor" />
        <StatusBanner kind="error">
          Could not load editor data. Please refresh; if this persists,
          there may be an issue with the order or its layout mapping.
        </StatusBanner>
        <Button onClick={() => navigate('/settings/overrides')}>
          ← Back to order picker
        </Button>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────

  const variantDef = layout.variants?.[variant];
  const slots = variantDef?.slots || [];
  const selectedSlot =
    selectedIndex !== null && selectedIndex < slots.length
      ? slots[selectedIndex]
      : null;

  // Real-data tokens for the canvas + text-content editor (Phase 48).
  // Mirrors server compositeService.buildTokensFromOrder so what the
  // operator sees in the preview matches what production will render.
  // PLACEHOLDER_TOKENS is the fallback for any keys an empty order
  // doesn't fill in.
  const sampleTokens = {
    ...PLACEHOLDER_TOKENS,
    ...buildTokensFromOrder(order, lineItem),
  };

  return (
    <div>
      <PageHeader
        title="Override Editor"
        subtitle={`Order ${orderId} · cart ${cartId} · ${lineItem.productName || lineItem.sku}`}
      />

      {/* Phase 11a: switcher — load a different order without going
          back to the picker page. */}
      <OrderSwitcher
        orderIdInput={switcherOrderId}
        onOrderIdInputChange={(v) => {
          setSwitcherOrderId(v);
          if (String(v) !== switcherLoadedFor) {
            setSwitcherLineItems(null);
            setSwitcherError(null);
          }
        }}
        onLoad={() => loadSwitcherOrder()}
        loading={switcherLoading}
        error={switcherError}
        lineItems={switcherLineItems}
        loadedOrderId={switcherLoadedFor}
        currentOrderId={orderId}
        currentCartId={cartId}
        onSelect={switchTo}
      />

      {layoutSource === 'override' && layoutDrifted && (
        <StatusBanner kind="warning">
          The base layout "{layout.name || layout.id}" has been
          modified since this override was created. Your override is
          using its own snapshot and is unaffected — but if you want
          to start fresh from the current layout, remove this
          override first.
        </StatusBanner>
      )}

      {layoutSource === 'mapping' && (
        <StatusBanner kind="info">
          No override exists yet for this cart line. The current
          layout for SKU "{lineItem.sku}" is loaded as the starting
          point. Make adjustments and click Apply to create the
          override.
        </StatusBanner>
      )}

      {actionResult && actionResult.mode === 'save' && (
        <StatusBanner kind="success">
          Override staged. The thumbnail on the order detail page will
          show a <strong>⚠ Layout edited</strong> badge until the next
          render — click <strong>Apply (Overwrite)</strong> or
          <strong> Apply (Reprint)</strong> here, or Process the order,
          to refresh it.
        </StatusBanner>
      )}
      {actionResult && actionResult.mode === 'overwrite' && (
        <StatusBanner kind="success">
          Override applied. Composite re-rendered:{' '}
          <code>{actionResult.compositeFilename}</code>
        </StatusBanner>
      )}
      {actionResult && actionResult.mode === 'reprint' && (
        <StatusBanner kind="success">
          Reprint generated. Composite:{' '}
          <code>{actionResult.compositeFilename}</code>
          {actionResult.txtPath && (
            <>
              <br />
              .txt file: <code>{actionResult.txtPath}</code>
            </>
          )}
        </StatusBanner>
      )}
      {actionResult && actionResult.mode === 'remove' && (
        <StatusBanner kind="success">
          Override removed.
          {actionResult.restored
            ? ' Original layout re-rendered to restore the on-disk image.'
            : ''}
          {actionResult.restoreError && (
            <>
              <br />
              <strong>Restore error:</strong>{' '}
              {actionResult.restoreError}
            </>
          )}
        </StatusBanner>
      )}

      {actionError && (
        <StatusBanner kind="error">{actionError}</StatusBanner>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 320px',
          gap: 16,
          marginTop: 16,
        }}
      >
        {/* LEFT: canvas */}
        <div>
          <Section title={`Variant: ${variant}`}>
            <div
              style={{
                background: '#1a1a1a',
                padding: 16,
                borderRadius: 6,
              }}
            >
              <LayoutCanvas
                layout={layout}
                variant={variant}
                selectedIndex={selectedIndex}
                onSlotSelect={setSelectedIndex}
                onSlotChange={handleSlotChange}
                width={700}
                height={Math.round(
                  700 * (layout.sheetHeight / layout.sheetWidth)
                )}
                sampleTokens={sampleTokens}
                snapEnabled={snapEnabled}
                snapStep={DEFAULT_SNAP_STEP}
                // Phase 11f: NO backdrop — render everything via live
                // SVG. Avoids the doubling problem where the backdrop's
                // baked-in text/graphics + the live overlays would both
                // render. The canvas is now pure WYSIWYG via SVG.
                backgroundImageDataUrl={null}
                enableWheelScale={true}
                lockedSlots={lockedSlots}
                livePhotoUrl={lineItem.photo?.fullUrl || null}
                liveBackgroundUrl={
                  lineItem.backgroundPhoto?.fullUrl || null
                }
                liveTeamPhotoUrl={teamPhotoUrl}
                logoUrl={
                  (lineItem.galleryId || order.galleryId)
                    ? `/api/sytist/gallery-assets/logos/${
                        lineItem.galleryId || order.galleryId
                      }/preview`
                    : null
                }
                graphicsUrls={graphicsUrls}
              />
            </div>
            <div
              style={{
                display: 'flex',
                gap: 16,
                marginTop: 8,
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              <label
                style={{ display: 'flex', gap: 6, alignItems: 'center' }}
              >
                <input
                  type="checkbox"
                  checked={snapEnabled}
                  onChange={(e) => setSnapEnabled(e.target.checked)}
                />
                Snap to {DEFAULT_SNAP_STEP}″ grid
              </label>
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 12,
                color: 'var(--text-muted)',
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: 'var(--text-primary)' }}>
                Tips:
              </strong>{' '}
              click a slot to select. Drag to move. Use mouse wheel
              over the canvas to scale the selected slot. Edge handles
              also work for resize.
            </div>
          </Section>
        </div>

        {/* RIGHT: layers + quick-edit panel + actions */}
        <div>
          <Section title="Layers">
            <LayersList
              slots={slots}
              baseSlots={baseLayout?.variants?.[variant]?.slots || null}
              selectedIndex={selectedIndex}
              onSelect={setSelectedIndex}
              lockedSlots={lockedSlots}
              onToggleLocked={toggleSlotLocked}
            />
          </Section>

          <Section title="Selected slot">
            {selectedSlot ? (
              lockedSlots[selectedIndex] ? (
                <div
                  style={{
                    padding: 12,
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    background: 'rgba(0,0,0,0.15)',
                    borderRadius: 4,
                    border: '1px dashed var(--border-color)',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    🔒 This layer is locked.
                  </div>
                  <div>
                    Click the 🔒 icon in the layers list to unlock it
                    if you need to make changes.
                  </div>
                </div>
              ) : (
                <QuickEditPanel
                  slot={selectedSlot}
                  baseSlot={
                    baseLayout?.variants?.[variant]?.slots?.[selectedIndex] || null
                  }
                  tokens={sampleTokens}
                  sheetWidth={layout.sheetWidth}
                  sheetHeight={layout.sheetHeight}
                  onChange={(newSlot) =>
                    handleSlotChange(selectedIndex, newSlot)
                  }
                />
              )
            ) : (
              <div
                style={{
                  padding: 12,
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}
              >
                Click a layer above, or click a slot in the canvas, to
                edit it.
              </div>
            )}
          </Section>

          <Section title="Actions">
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {/* Phase 40: Save (no render) — stage the override for
                  later batch processing. Use when tweaking multiple
                  items in one order and you want them ALL to apply
                  when you click Process or Reprint on the order. */}
              <button
                onClick={saveOverrideOnly}
                disabled={!!actionLoading}
                style={primaryBtnStyle(actionLoading === 'save')}
              >
                {actionLoading === 'save' ? 'Saving…' : 'Save (no render)'}
              </button>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  marginTop: -4,
                  marginBottom: 8,
                  lineHeight: 1.4,
                }}
              >
                Stages this override for later. When you Process or
                Reprint the order, the composite for this item will be
                rendered using the override layout. Use to tweak
                multiple items before printing.
              </div>

              <hr
                style={{
                  border: 'none',
                  borderTop: '1px solid var(--border-color)',
                  margin: '4px 0',
                }}
              />

              <button
                onClick={() => applyOverride('overwrite')}
                disabled={!!actionLoading}
                style={primaryBtnStyle(actionLoading === 'overwrite')}
              >
                {actionLoading === 'overwrite'
                  ? 'Re-rendering…'
                  : 'Apply (Overwrite original)'}
              </button>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  marginTop: -4,
                  marginBottom: 8,
                  lineHeight: 1.4,
                }}
              >
                Use before printing. Replaces the existing composite
                file with the corrected version. Existing whole-order
                .txt is unchanged.
              </div>

              <button
                onClick={() => applyOverride('reprint')}
                disabled={!!actionLoading}
                style={primaryBtnStyle(actionLoading === 'reprint')}
              >
                {actionLoading === 'reprint'
                  ? 'Re-rendering…'
                  : 'Apply (Reprint single item)'}
              </button>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  marginTop: -4,
                  marginBottom: 8,
                  lineHeight: 1.4,
                }}
              >
                Use after printing when one item needs a redo. Writes
                a _REPRINT image and a one-item .txt file. Original
                files untouched.
              </div>

              {layoutSource === 'override' && (
                <>
                  <hr
                    style={{
                      border: 'none',
                      borderTop: '1px solid var(--border-color)',
                      margin: '4px 0',
                    }}
                  />
                  <button
                    onClick={removeOverride}
                    disabled={!!actionLoading}
                    style={dangerBtnStyle(actionLoading === 'remove')}
                  >
                    {actionLoading === 'remove'
                      ? 'Removing…'
                      : 'Remove override'}
                  </button>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginTop: -4,
                      lineHeight: 1.4,
                    }}
                  >
                    Deletes the override and re-renders with the
                    original layout to restore the file.
                  </div>
                </>
              )}
            </div>
          </Section>

          <Section title="Navigate">
            <Button onClick={() => navigate('/settings/overrides')}>
              ← Back to order picker
            </Button>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─── Quick-edit panel ──────────────────────────────────────
//
// Trimmed-down property editor. Just enough to nudge what's wrong.
// Position + size for everything; fontSize for text.
//
// We deliberately don't expose font family, color, weight, fit
// mode, etc. Those are layout-level decisions. If they need to
// change for an order, the operator should fix the layout itself,
// not bake the change into a per-order override.

// ─── Order switcher (Phase 11a) ─────────────────────────────
//
// Compact "load a different order" UI that lives inside the editor.
// Operator types an order ID, clicks Load, sees its line items as a
// dropdown. Picking one navigates to that override editor — React
// Router triggers a re-mount with new params, useEffect re-fires,
// new order loads. Starts COLLAPSED to keep the editor clean; click
// the header to expand.

function OrderSwitcher({
  orderIdInput,
  onOrderIdInputChange,
  onLoad,
  loading,
  error,
  lineItems,
  loadedOrderId,
  currentOrderId,
  currentCartId,
  onSelect,
}) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: 6,
        marginBottom: 16,
        background: 'var(--bg-card)',
      }}
    >
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          padding: '12px 16px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {expanded ? '▼' : '▶'} Switch to a different order
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}
        >
          {expanded
            ? ''
            : '(click to expand — pick another order or cart line)'}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            padding: '0 16px 16px',
            borderTop: '1px solid var(--border-color)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-end',
              marginTop: 12,
            }}
          >
            <div style={{ flex: 1 }}>
              <FormRow label="Order ID" hint="">
                <TextInput
                  value={orderIdInput}
                  onChange={onOrderIdInputChange}
                  onKeyDown={(e) => {
                    // Phase 11h: Enter triggers Load.
                    if (
                      e.key === 'Enter' &&
                      !loading &&
                      orderIdInput
                    ) {
                      e.preventDefault();
                      onLoad();
                    }
                  }}
                  placeholder="e.g. 110951"
                  monospace
                  style={{
                    fontSize: 16,
                    padding: '10px 12px',
                  }}
                />
              </FormRow>
            </div>
            <button
              type="button"
              onClick={onLoad}
              disabled={!orderIdInput || loading}
              style={{
                padding: '11px 22px',
                background: 'var(--accent, #4a7fc1)',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: loading || !orderIdInput ? 'default' : 'pointer',
                fontFamily: 'inherit',
                fontSize: 15,
                fontWeight: 600,
                opacity: loading || !orderIdInput ? 0.5 : 1,
                marginBottom: 20,
                whiteSpace: 'nowrap',
              }}
            >
              {loading ? 'Loading…' : 'Load'}
            </button>
          </div>

          {error && (
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                color: '#dc3545',
              }}
            >
              {error}
            </div>
          )}

          {lineItems && lineItems.length > 0 && (
            <div
              style={{
                marginTop: 10,
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                overflow: 'hidden',
                maxHeight: 400,
                overflowY: 'auto',
              }}
            >
              {lineItems.map((li) => {
                const isCurrent =
                  String(li.cartId) === String(currentCartId) &&
                  String(loadedOrderId) === String(currentOrderId);
                // Phase 11i: fullUrl for un-watermarked thumbs.
                const thumbUrl =
                  li.photo?.fullUrl ||
                  li.photo?.largeUrl ||
                  li.photo?.thumbUrl;
                return (
                  <div
                    key={li.cartId}
                    onClick={() => !isCurrent && onSelect(li.cartId)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 16,
                      padding: '14px 16px',
                      cursor: isCurrent ? 'default' : 'pointer',
                      borderBottom: '1px solid var(--border-color)',
                      background: isCurrent
                        ? 'rgba(74,127,193,0.15)'
                        : 'transparent',
                      opacity: isCurrent ? 0.7 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!isCurrent)
                        e.currentTarget.style.background =
                          'rgba(74,127,193,0.08)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isCurrent)
                        e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt=""
                        style={{
                          width: 110,
                          height: 110,
                          objectFit: 'cover',
                          borderRadius: 4,
                          background: '#222',
                          flexShrink: 0,
                        }}
                        onError={(e) => {
                          e.target.style.display = 'none';
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 110,
                          height: 110,
                          background: '#444',
                          borderRadius: 4,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          marginBottom: 3,
                        }}
                      >
                        {li.productName || '(unnamed)'}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono, monospace)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {li.sku || '(no SKU)'} · cart {li.cartId}
                        {isCurrent ? ' · CURRENT' : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Quick-edit panel ──────────────────────────────────────
//
// Trimmed-down property editor. Just enough to nudge what's wrong.
// Position + size for everything; fontSize for text.
//
// We deliberately don't expose font family, color, weight, fit
// mode, etc. Those are layout-level decisions. If they need to
// change for an order, the operator should fix the layout itself,
// not bake the change into a per-order override.

// ─── Layers list (Phase 11b) ─────────────────────────────────
//
// The override editor needs this because static graphics are drawn
// on top and intercept canvas clicks for slots underneath. Without
// a layers list, an operator can't select the player photo if a
// graphic sits over it. (The full layout designer has a richer
// drag-reorder layers panel; this is a click-to-select sidebar
// version, no reordering — overrides don't restructure layouts.)
//
// Order: REVERSE of JSON array order. Topmost stack layer appears
// first in the list — matches what the operator sees on canvas
// (graphic at the top of the list, photo below it). Same convention
// as the designer.

function LayersList({
  slots,
  baseSlots,
  selectedIndex,
  onSelect,
  lockedSlots = {},
  onToggleLocked,
}) {
  if (!slots || slots.length === 0) {
    return (
      <div
        style={{
          padding: 10,
          fontSize: 12,
          color: 'var(--text-muted)',
          fontStyle: 'italic',
        }}
      >
        No layers in this variant.
      </div>
    );
  }
  // Map original indices, then reverse for display.
  const displayList = slots
    .map((slot, idx) => ({ slot, jsonIndex: idx }))
    .reverse();

  return (
    <div
      style={{
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        overflow: 'hidden',
        background: 'var(--bg-input)',
      }}
    >
      {displayList.map(({ slot, jsonIndex }) => {
        const isSelected = selectedIndex === jsonIndex;
        const isLocked = !!lockedSlots[jsonIndex];
        return (
          <div
            key={jsonIndex}
            onClick={() => onSelect(jsonIndex)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              cursor: 'pointer',
              background: isSelected
                ? 'rgba(74,127,193,0.15)'
                : 'transparent',
              borderLeft: isSelected
                ? '3px solid #4a7fc1'
                : '3px solid transparent',
              fontSize: 12,
              userSelect: 'none',
              // Locked rows look slightly muted so the operator can
              // see at a glance which layers are protected.
              opacity: isLocked ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isSelected)
                e.currentTarget.style.background =
                  'rgba(74,127,193,0.06)';
            }}
            onMouseLeave={(e) => {
              if (!isSelected)
                e.currentTarget.style.background = 'transparent';
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: SLOT_KIND_COLORS[slot.kind] || '#888',
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: isSelected ? 600 : 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {SLOT_KIND_LABELS[slot.kind] || slot.kind}
              </div>
              {slot.kind === 'text' && slot.text && (() => {
                // Phase 48 / 48a: a slot's "·custom" badge fires when
                // ANY override field differs from the base layout's
                // value at the same index. Phase 48 covered text
                // content (token-disconnect risk); Phase 48a adds
                // color. Future override capabilities (image upload,
                // etc.) extend the same getCustomFields helper. Badge
                // meaning is "this slot has been hand-edited" — the
                // operator scans the layers list and sees at a glance
                // which slots have been customized, without selecting
                // each one. Tooltip enumerates which fields differ
                // and what the base value was.
                const baseSlot = baseSlots ? baseSlots[jsonIndex] : null;
                const customFields = getCustomFields(slot, baseSlot);
                const isCustom = customFields.length > 0;
                const tooltip = isCustom
                  ? `Custom — base layout had: ${customFields
                      .map((f) => `${f}=${JSON.stringify(baseSlot[f] ?? '')}`)
                      .join(', ')}`
                  : slot.text;
                return (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono, monospace)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontStyle: isCustom ? 'italic' : 'normal',
                    }}
                    title={tooltip}
                  >
                    "{slot.text}"
                    {isCustom && (
                      <span style={{ color: '#d09030', marginLeft: 4 }}>
                        ·custom
                      </span>
                    )}
                  </div>
                );
              })()}
            </span>
            {/* Phase 11c: lock toggle. Locked layers can't be
                accidentally selected or dragged from the canvas;
                clicks pass through to layers underneath. Click the
                lock icon to unlock and edit. */}
            {onToggleLocked && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleLocked(jsonIndex);
                }}
                title={
                  isLocked
                    ? 'Unlock to edit this layer'
                    : 'Lock to protect from accidental edits'
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  padding: '2px 6px',
                  color: isLocked
                    ? 'var(--text-primary)'
                    : 'var(--text-muted)',
                  opacity: isLocked ? 1 : 0.5,
                  flexShrink: 0,
                }}
              >
                {isLocked ? '🔒' : '🔓'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Slot kind → color and label maps (same as the designer's, kept
// inline so the override editor doesn't depend on the designer
// file's internals).
const SLOT_KIND_COLORS = {
  playerPhoto: '#5d8fc4',
  playerBackground: '#5dc4b8',
  teamPhoto: '#c46060',
  logo: '#7cc46d',
  staticGraphic: '#b888d0',
  overlay: '#b888d0',
  text: '#888888',
};
const SLOT_KIND_LABELS = {
  playerPhoto: 'Player photo',
  playerBackground: 'Player background',
  teamPhoto: 'Team photo',
  logo: 'Logo',
  staticGraphic: 'Static graphic',
  overlay: 'Static graphic',
  text: 'Text',
};

// ─── Quick-edit panel ──────────────────────────────────────
//
// Trimmed-down property editor. Just enough to nudge what's wrong.
// Position + size for everything; fontSize for text.

function QuickEditPanel({
  slot,
  baseSlot,
  tokens,
  sheetWidth,
  sheetHeight,
  onChange,
}) {
  const isText = slot.kind === 'text';
  // Phase 48: resolved value = what the slot will render to with the
  // current text + the order's real Sytist data. If slot.text is a
  // token template ("{subject.athleteName}"), this is the substituted
  // name ("John Smith"). If slot.text is a literal, it's the literal.
  // The textarea defaults to this so the operator sees what the
  // composite will actually show, not the template syntax.
  const resolvedText = isText
    ? substituteTokens(slot.text || '', tokens || {})
    : '';
  // "Custom" = the operator has typed over the base layout's template.
  // Same detection as LayersList. When the base text contained a
  // {token}, this means the slot no longer follows Sytist data.
  const isCustomText =
    isText && baseSlot && baseSlot.kind === 'text' &&
    slot.text !== baseSlot.text;
  // Phase 48a: color override detection. Compare against base, treating
  // missing color as the renderer's default (#000000) so a slot that
  // explicitly sets the same default doesn't read as "customized."
  const isCustomColor =
    isText && baseSlot && baseSlot.kind === 'text' &&
    (slot.color || '#000000') !== (baseSlot.color || '#000000');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        Kind: {slot.kind}
      </div>

      {/* Position */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FormRow label="X (in)" hint="">
          <NumberInput
            value={slot.x}
            onChange={(v) => onChange({ ...slot, x: clamp(v, 0, sheetWidth) })}
            step={0.05}
            min={0}
            max={sheetWidth}
          />
        </FormRow>
        <FormRow label="Y (in)" hint="">
          <NumberInput
            value={slot.y}
            onChange={(v) => onChange({ ...slot, y: clamp(v, 0, sheetHeight) })}
            step={0.05}
            min={0}
            max={sheetHeight}
          />
        </FormRow>
      </div>

      {/* Size */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FormRow label="W (in)" hint="">
          <NumberInput
            value={slot.w}
            onChange={(v) =>
              onChange({ ...slot, w: clamp(v, 0.1, sheetWidth) })
            }
            step={0.05}
            min={0.1}
            max={sheetWidth}
          />
        </FormRow>
        <FormRow label="H (in)" hint="">
          <NumberInput
            value={slot.h}
            onChange={(v) =>
              onChange({ ...slot, h: clamp(v, 0.1, sheetHeight) })
            }
            step={0.05}
            min={0.1}
            max={sheetHeight}
          />
        </FormRow>
      </div>

      {/* Text-only: content editor + font size. Other text properties
          (font, color, weight, align) are layout decisions, not
          override material. Phase 48: content input added so the
          operator can correct a misspelled name or override one slot's
          text without touching the underlying layout. The textarea is
          populated with the resolved value (slot.text run through
          token substitution against the order's Sytist data), so what
          the operator types over is what the composite will render.
          If the operator leaves the value untouched, slot.text stays
          as-is (token templates keep working). If they type anything,
          slot.text becomes that literal — the badge below flags the
          disconnect. Tokens still pass through if the operator types
          one explicitly (e.g. "{subject.athleteName}") because the
          server's render-time substituteTokens runs unchanged. */}
      {isText && (
        <>
          <FormRow label="Text content" hint="">
            {/* Display rule: when slot.text contains a {token},
                show the resolved value so the operator sees what
                will render. Otherwise show slot.text directly (it's
                already literal — either from a literal layout or
                from a previous operator edit). This is independent
                of isCustomText (which requires baseSlot to detect)
                so the editor still behaves sensibly if the base
                layout is missing. */}
            <textarea
              value={
                (slot.text || '').indexOf('{') !== -1
                  ? resolvedText
                  : slot.text || ''
              }
              onChange={(e) => onChange({ ...slot, text: e.target.value })}
              rows={2}
              style={{
                width: '100%',
                padding: '6px 8px',
                fontSize: 12,
                fontFamily: 'inherit',
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                resize: 'vertical',
              }}
            />
          </FormRow>
          {isCustomText ? (
            <div
              style={{
                fontSize: 11,
                color: '#d09030',
                fontStyle: 'italic',
                marginTop: -4,
              }}
              title={`Base layout had: "${baseSlot.text}"`}
            >
              Custom text (overrides token) — won't follow Sytist data
            </div>
          ) : (
            slot.text &&
            slot.text.indexOf('{') !== -1 && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono, monospace)',
                  marginTop: -4,
                }}
                title="This slot's text follows a token template; editing it makes it literal for this order."
              >
                Pulls from: {slot.text}
              </div>
            )
          )}
          {/* Phase 48a: text color editor. Native <input type="color">
              emits 7-char hex (#rrggbb) which matches the schema in
              composite-layouts.json and what compositeService._textSvg
              expects for the `fill` attribute. No format conversion. */}
          <FormRow label="Color" hint="">
            <input
              type="color"
              value={slot.color || '#000000'}
              onChange={(e) => onChange({ ...slot, color: e.target.value })}
              style={{
                width: 48,
                height: 28,
                padding: 0,
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                background: 'var(--bg-input)',
                cursor: 'pointer',
              }}
              title={slot.color || '#000000'}
            />
          </FormRow>
          {isCustomColor && (
            <div
              style={{
                fontSize: 11,
                color: '#d09030',
                fontStyle: 'italic',
                marginTop: -4,
              }}
              title={`Base layout had: ${baseSlot.color || '#000000'}`}
            >
              Custom color (was {baseSlot.color || '#000000'})
            </div>
          )}
          <FormRow label="Font size (px)" hint="">
            <NumberInput
              value={slot.fontSize || 24}
              onChange={(v) => onChange({ ...slot, fontSize: clamp(v, 6, 200) })}
              step={1}
              min={6}
              max={200}
            />
          </FormRow>
        </>
      )}
    </div>
  );
}

function clamp(n, lo, hi) {
  if (typeof n !== 'number' || isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// Phase 48: client-side mirror of server compositeService.buildTokensFromOrder.
// Kept in sync so the editor's preview + text-content input resolve to the same
// values production will render. The shape — customer / subject / galleryName /
// order / year / date — must match the server; the subject key camelCasing must
// match too, since templates like {subject.athleteName} bind to the camelCased
// label from ms_subjects.
function buildTokensFromOrder(order, lineItem) {
  const subject = {};
  if (order && order.subject && Array.isArray(order.subject.fields)) {
    for (const f of order.subject.fields) {
      const key = camelCaseKey(f.label || '');
      if (key) subject[key] = f.value || '';
    }
  }
  return {
    customer: { ...((order && order.customer) || {}) },
    subject,
    galleryName: (order && order.galleryName) || '',
    subGalleryName:
      (order && order.subGalleryName) ||
      (lineItem && lineItem.subGalleryName) ||
      '',
    order: {
      id: (order && order.orderId) || '',
      date: ((order && order.orderDate) || '').split(' ')[0] || '',
    },
    year: new Date().getFullYear(),
    date: new Date().toISOString().split('T')[0],
  };
}

function camelCaseKey(label) {
  if (!label) return '';
  return String(label)
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .map((w, i) =>
      i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('');
}

// Phase 48a: enumerate which non-geometry override fields on a slot
// differ from the base layout's version. Geometry (x, y, w, h,
// fontSize) is intentionally NOT included — those are layout
// nudges, not content overrides, and the layers list shouldn't
// flag every position tweak as "custom." Returns an array of field
// names ([] when no overrides). Designed to grow: future override
// capabilities (e.g. slot.overrideImageUrl when image upload ships)
// add their own check here and the badge + tooltip pick them up
// without further changes. Color comparison treats missing color
// as the renderer's #000000 default so a slot that explicitly sets
// the same default doesn't read as customized.
function getCustomFields(slot, baseSlot) {
  if (!slot || !baseSlot) return [];
  const fields = [];
  if ((slot.text || '') !== (baseSlot.text || '')) fields.push('text');
  if ((slot.color || '#000000') !== (baseSlot.color || '#000000')) fields.push('color');
  return fields;
}

// ─── Button styles ─────────────────────────────────────────

function primaryBtnStyle(active) {
  return {
    padding: '10px 14px',
    background: active ? '#3a6fb1' : '#4a7fc1',
    color: 'white',
    border: 'none',
    borderRadius: 4,
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    cursor: active ? 'wait' : 'pointer',
    opacity: active ? 0.85 : 1,
  };
}

function dangerBtnStyle(active) {
  return {
    padding: '10px 14px',
    background: 'transparent',
    color: '#dc3545',
    border: '1px solid #dc3545',
    borderRadius: 4,
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    cursor: active ? 'wait' : 'pointer',
    opacity: active ? 0.6 : 1,
  };
}
