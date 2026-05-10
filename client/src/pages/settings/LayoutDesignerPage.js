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

  // Preview state
  const [previewMode, setPreviewMode] = useState('placeholder'); // 'placeholder' | 'order'
  const [previewOrderId, setPreviewOrderId] = useState('');
  const [previewCartId, setPreviewCartId] = useState('');
  const [previewImageDataUrl, setPreviewImageDataUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

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
  }, [layoutId]);

  // Reset selection when variant changes (slot indices are per-variant)
  useEffect(() => {
    setSelectedIndex(null);
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
  }

  function handleAddSlot(kind) {
    if (!layout) return;
    const w = layout.sheetWidth;
    const h = layout.sheetHeight;
    // Default size: 30% of sheet. Centered. Big enough to click but
    // not so big it occludes everything.
    const defaultW = w * 0.3;
    const defaultH = h * 0.3;
    const newSlot = makeDefaultSlot(kind, w / 2 - defaultW / 2, h / 2 - defaultH / 2, defaultW, defaultH);

    updateVariantSlots((slots) => {
      const nextSlots = [...slots, newSlot];
      // Select the newly added slot so the property panel shows it
      // immediately
      setTimeout(() => setSelectedIndex(nextSlots.length - 1), 0);
      return nextSlots;
    });
  }

  function handleLayoutMetaChange(updates) {
    setLayout((prev) => (prev ? { ...prev, ...updates } : prev));
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
        const r = await api.post('/api/sytist/composite/preview', {
          orderId: previewOrderId,
          cartId: parseInt(previewCartId, 10),
          layout, // inline — server uses this instead of saved version
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
  }, [layout, previewMode, previewOrderId, previewCartId]);

  // ─── Render ──────────────────────────────────────────────

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
  const selectedSlot = selectedIndex !== null ? slots[selectedIndex] : null;

  // Canvas dimensions: keep the longer side at 504
  const TARGET_LONG_SIDE = 504;
  const aspect = layout.sheetWidth / layout.sheetHeight;
  const canvasWidth =
    aspect >= 1 ? TARGET_LONG_SIDE : TARGET_LONG_SIDE * aspect;
  const canvasHeight =
    aspect >= 1 ? TARGET_LONG_SIDE / aspect : TARGET_LONG_SIDE;

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
          gridTemplateColumns: `${canvasWidth + 80}px 1fr`,
          gap: 16,
        }}
      >
        {/* LEFT: variant tabs + canvas + toolbar */}
        <div>
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
              __dpi: layout.dpi || 300,
            }}
            snapEnabled={snapEnabled}
            backgroundImageDataUrl={
              previewMode === 'order' ? previewImageDataUrl : null
            }
          />
          <CanvasFooterToolbar
            snapEnabled={snapEnabled}
            onSnapToggle={() => setSnapEnabled((v) => !v)}
            previewMode={previewMode}
            onPreviewModeChange={setPreviewMode}
            previewOrderId={previewOrderId}
            previewCartId={previewCartId}
            onPreviewOrderIdChange={setPreviewOrderId}
            onPreviewCartIdChange={setPreviewCartId}
            previewLoading={previewLoading}
            previewError={previewError}
          />
        </div>

        {/* RIGHT: property panel */}
        <div>
          {selectedSlot ? (
            <SlotEditor
              slot={selectedSlot}
              slotIndex={selectedIndex}
              variantName={variant}
              totalSlots={slots.length}
              sheetWidth={layout.sheetWidth}
              sheetHeight={layout.sheetHeight}
              onChange={(newSlot) =>
                handleSlotChange(selectedIndex, newSlot)
              }
              onDelete={() => handleSlotDelete(selectedIndex)}
            />
          ) : (
            <LayoutMetaEditor
              layout={layout}
              onChange={handleLayoutMetaChange}
            />
          )}
          <AddSlotToolbar onAdd={handleAddSlot} disabled={!variantDef} />
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
        <div
          style={{
            marginTop: 8,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
          }}
        >
          <FormRow label="Order ID" hint="A real order with a player photo">
            <TextInput
              value={previewOrderId}
              onChange={onPreviewOrderIdChange}
              placeholder="e.g. 110855"
              monospace
            />
          </FormRow>
          <FormRow label="Cart ID" hint="Line item within the order">
            <TextInput
              value={previewCartId}
              onChange={onPreviewCartIdChange}
              placeholder="e.g. 12345"
              monospace
            />
          </FormRow>
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

// ─── Slot editor (right panel when slot selected) ──────────

function SlotEditor({
  slot,
  slotIndex,
  variantName,
  totalSlots,
  sheetWidth,
  sheetHeight,
  onChange,
  onDelete,
}) {
  function update(field, value) {
    onChange({ ...slot, [field]: value });
  }

  const isText = slot.kind === 'text';
  const isImage = ['playerPhoto', 'teamPhoto', 'logo', 'overlay'].includes(slot.kind);

  return (
    <Section
      title={`Slot ${slotIndex + 1} of ${totalSlots} (${variantName})`}
      description="Edit selected slot. Changes preview immediately on the canvas; click Save to persist."
      actions={
        <Button variant="danger" onClick={onDelete}>
          Delete slot
        </Button>
      }
    >
      <FormRow label="Kind">
        <Select
          value={slot.kind}
          onChange={(v) => update('kind', v)}
          options={[
            { value: 'playerPhoto', label: 'Player photo' },
            { value: 'teamPhoto', label: 'Team photo' },
            { value: 'logo', label: 'Logo' },
            { value: 'overlay', label: 'Overlay' },
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
        <FormRow label="X (in)" hint={`0 to ${(sheetWidth - (slot.w || 0)).toFixed(2)}`}>
          <NumberInput
            value={slot.x ?? 0}
            onChange={(v) => update('x', v)}
            step="0.05"
          />
        </FormRow>
        <FormRow label="Y (in)" hint={`0 to ${(sheetHeight - (slot.h || 0)).toFixed(2)}`}>
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
          hint="cover = fills slot, may crop. contain = entire image visible, may letterbox."
        >
          <Select
            value={slot.fit || 'cover'}
            onChange={(v) => update('fit', v)}
            options={[
              { value: 'cover', label: 'cover' },
              { value: 'contain', label: 'contain' },
              { value: 'fill', label: 'fill' },
              { value: 'inside', label: 'inside' },
              { value: 'outside', label: 'outside' },
            ]}
          />
        </FormRow>
      )}

      {slot.kind === 'overlay' && (
        <FormRow label="Overlay ID" hint="ID from gallery-assets">
          <TextInput
            value={slot.overlayId || ''}
            onChange={(v) => update('overlayId', v)}
            monospace
            placeholder="ov-..."
          />
        </FormRow>
      )}

      {isText && (
        <>
          <FormRow
            label="Text content"
            hint="Use {tokens} like {subject.athleteName} or {customer.firstName}"
          >
            <TextInput
              value={slot.text || ''}
              onChange={(v) => update('text', v)}
            />
          </FormRow>
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
    </Section>
  );
}

// ─── Layout meta editor (right panel when nothing selected) ──

function LayoutMetaEditor({ layout, onChange }) {
  return (
    <Section
      title="Layout properties"
      description="Click a slot to edit it, or edit layout-wide settings here."
    >
      <FormRow label="Name">
        <TextInput
          value={layout.name || ''}
          onChange={(v) => onChange({ name: v })}
        />
      </FormRow>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        <FormRow label="Sheet width (in)">
          <NumberInput
            value={layout.sheetWidth || 0}
            onChange={(v) => onChange({ sheetWidth: v })}
            step="0.25"
          />
        </FormRow>
        <FormRow label="Sheet height (in)">
          <NumberInput
            value={layout.sheetHeight || 0}
            onChange={(v) => onChange({ sheetHeight: v })}
            step="0.25"
          />
        </FormRow>
        <FormRow label="DPI" hint="300 is typical for print">
          <NumberInput
            value={layout.dpi || 300}
            onChange={(v) => onChange({ dpi: v })}
            step="50"
          />
        </FormRow>
        <FormRow label="Background">
          <TextInput
            value={layout.backgroundColor || '#ffffff'}
            onChange={(v) => onChange({ backgroundColor: v })}
            monospace
          />
        </FormRow>
      </div>
    </Section>
  );
}

// ─── Add slot toolbar ──────────────────────────────────────

function AddSlotToolbar({ onAdd, disabled }) {
  const slotTypes = [
    { kind: 'playerPhoto', label: 'Player photo' },
    { kind: 'teamPhoto', label: 'Team photo' },
    { kind: 'logo', label: 'Logo' },
    { kind: 'overlay', label: 'Overlay' },
    { kind: 'text', label: 'Text' },
  ];

  return (
    <Section title="Add slot" description="New slot lands centered on the sheet at 30% size — drag to position.">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
    </Section>
  );
}

// ─── Slot factories ────────────────────────────────────────

function makeDefaultSlot(kind, x, y, w, h) {
  const base = { kind, x, y, w, h };
  switch (kind) {
    case 'playerPhoto':
    case 'teamPhoto':
      return { ...base, fit: 'cover' };
    case 'logo':
      return { ...base, fit: 'contain' };
    case 'overlay':
      return { ...base, overlayId: '' };
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
