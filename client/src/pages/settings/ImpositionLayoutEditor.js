// ImpositionLayoutEditor — WYSIWYG editor for a single imposition layout.
//
// Phase 27: ported from the PhotoDay dashboard's settings page. Replaces
// the JSON textarea modal in ImpositionSettings with a proper form +
// live SVG preview.
//
// The layout shape (same as before):
//   {
//     id, name,
//     cols, rows,
//     itemWidth, itemHeight,    -- inches
//     sheetWidth, sheetHeight,  -- inches
//     dpi,
//     colGap, rowGap,           -- inches between grid items
//     centerOnSheet,            -- bool; when true marginLeft/Top are computed
//     marginLeft, marginTop,    -- inches; manual offset
//     textOverlays: [
//       { text, x, y, width?, height?, fontSize, color,
//         rotation?, autoSize?, centerAlign? }
//     ]
//   }
//
// The live preview is a single SVG showing:
//   - Sheet (white rect)
//   - Grid cells (blue)
//   - Gap regions between cells (faint red)
//   - Empty margin regions (faint green for offsets, faint orange for
//     extra space beyond the grid)
//   - Text overlay anchor boxes (dashed in the overlay color)
//   - Rulers along the top and left edges showing inches

import React, { useState, useEffect, useMemo } from 'react';
import api from '../../services/api';
import {
  FormRow,
  TextInput,
  NumberInput,
  Button,
  StatusBanner,
} from '../../components/SettingsForm';

const emptyLayout = {
  id: '',
  name: '',
  cols: 4,
  rows: 2,
  itemWidth: 2.5,
  itemHeight: 3.5,
  sheetWidth: 10,
  sheetHeight: 8,
  dpi: 300,
  colGap: 0.01,
  rowGap: 0.01,
  centerOnSheet: false,
  marginLeft: 0,
  marginTop: 0,
  textOverlays: [],
};

const emptyOverlay = {
  text: '',
  x: 0,
  y: 0,
  fontSize: 10,
  color: '#000000',
  rotation: 0,
};

// Coerce a value to a finite number with a fallback. NumberInput emits ''
// when the user clears a field; we map those to the existing value so
// the form doesn't blow up on partial input.
function num(v, fallback = 0) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default function ImpositionLayoutEditor({
  initialLayout,    // null/undefined for new, or a layout object for edit
  onSave,           // async (layout) => void   — fires on Save button
  onCancel,         // () => void
  saving,           // boolean — show "Saving…" on the Save button
  error,            // string | null — show under the form
}) {
  const [layoutForm, setLayoutForm] = useState(() => ({
    ...emptyLayout,
    ...(initialLayout || {}),
    // Backward-compat: migrate old single-gap layouts to colGap/rowGap.
    colGap:
      initialLayout && initialLayout.colGap !== undefined
        ? initialLayout.colGap
        : initialLayout && initialLayout.gap !== undefined
          ? initialLayout.gap
          : 0.01,
    rowGap:
      initialLayout && initialLayout.rowGap !== undefined
        ? initialLayout.rowGap
        : initialLayout && initialLayout.gap !== undefined
          ? initialLayout.gap
          : 0.01,
    textOverlays:
      initialLayout && Array.isArray(initialLayout.textOverlays)
        ? initialLayout.textOverlays
        : [],
  }));
  const [textVariables, setTextVariables] = useState([]);

  // Load token catalog once.
  useEffect(() => {
    api
      .get('/api/sytist/imposition/text-variables')
      .then((d) =>
        setTextVariables(Array.isArray(d) ? d : d?.variables || [])
      )
      .catch(() => setTextVariables([]));
  }, []);

  function updateField(field, value) {
    setLayoutForm((prev) => ({ ...prev, [field]: value }));
  }

  function addTextOverlay() {
    setLayoutForm((prev) => ({
      ...prev,
      textOverlays: [
        ...prev.textOverlays,
        {
          ...emptyOverlay,
          y: num(prev.sheetHeight, 8) - 0.5,
        },
      ],
    }));
  }

  function updateTextOverlay(idx, field, value) {
    setLayoutForm((prev) => {
      const overlays = [...prev.textOverlays];
      overlays[idx] = { ...overlays[idx], [field]: value };
      return { ...prev, textOverlays: overlays };
    });
  }

  function removeTextOverlay(idx) {
    setLayoutForm((prev) => ({
      ...prev,
      textOverlays: prev.textOverlays.filter((_, i) => i !== idx),
    }));
  }

  function insertVariable(idx, token) {
    setLayoutForm((prev) => {
      const overlays = [...prev.textOverlays];
      overlays[idx] = {
        ...overlays[idx],
        text: (overlays[idx].text || '') + token,
      };
      return { ...prev, textOverlays: overlays };
    });
  }

  // Compute derived geometry on the fly. Memoized so derived values
  // don't recompute on every keystroke unless inputs changed.
  const geom = useMemo(() => {
    const sw = num(layoutForm.sheetWidth, 10);
    const sh = num(layoutForm.sheetHeight, 8);
    const iw = num(layoutForm.itemWidth, 2.5);
    const ih = num(layoutForm.itemHeight, 3.5);
    const c = Math.max(1, Math.floor(num(layoutForm.cols, 1)));
    const r = Math.max(1, Math.floor(num(layoutForm.rows, 1)));
    const cg = num(layoutForm.colGap, 0);
    const rg = num(layoutForm.rowGap, 0);
    const contentW = c * iw + (c - 1) * cg;
    const contentH = r * ih + (r - 1) * rg;
    const isCentered = !!layoutForm.centerOnSheet;
    const offsetLeft = isCentered
      ? Math.max((sw - contentW) / 2, 0)
      : num(layoutForm.marginLeft, 0);
    const offsetTop = isCentered
      ? Math.max((sh - contentH) / 2, 0)
      : num(layoutForm.marginTop, 0);
    const extraW = sw - contentW - offsetLeft;
    const extraH = sh - contentH - offsetTop;
    return {
      sw, sh, iw, ih, c, r, cg, rg,
      contentW, contentH,
      offsetLeft, offsetTop,
      extraW, extraH,
      totalItems: c * r,
    };
  }, [layoutForm]);

  // Trigger save. Coerce form values to numbers where appropriate, then
  // hand off to the parent's onSave callback.
  function handleSaveClick() {
    const payload = {
      ...layoutForm,
      cols: Math.max(1, Math.floor(num(layoutForm.cols, 1))),
      rows: Math.max(1, Math.floor(num(layoutForm.rows, 1))),
      itemWidth: num(layoutForm.itemWidth, 2.5),
      itemHeight: num(layoutForm.itemHeight, 3.5),
      sheetWidth: num(layoutForm.sheetWidth, 10),
      sheetHeight: num(layoutForm.sheetHeight, 8),
      dpi: Math.max(72, Math.floor(num(layoutForm.dpi, 300))),
      colGap: num(layoutForm.colGap, 0),
      rowGap: num(layoutForm.rowGap, 0),
      marginLeft: num(layoutForm.marginLeft, 0),
      marginTop: num(layoutForm.marginTop, 0),
      textOverlays: (layoutForm.textOverlays || []).map((o) => ({
        ...o,
        x: num(o.x, 0),
        y: num(o.y, 0),
        width: o.width === '' || o.width == null ? undefined : num(o.width, 0),
        height: o.height === '' || o.height == null ? undefined : num(o.height, 0),
        fontSize: Math.max(4, Math.floor(num(o.fontSize, 10))),
        rotation: Math.floor(num(o.rotation, 0)),
      })),
    };
    onSave(payload);
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        {/* LEFT: Form fields */}
        <div style={{ flex: '1 1 420px', minWidth: 320 }}>
          <FormRow label="Layout Name" hint="Friendly name shown in the table.">
            <TextInput
              value={layoutForm.name}
              onChange={(v) => updateField('name', v)}
              placeholder="e.g. 8 Wallets on 8x10"
            />
          </FormRow>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
            <FormRow label="Columns">
              <NumberInput
                value={layoutForm.cols}
                onChange={(v) => updateField('cols', v)}
                step="1"
                min="1"
              />
            </FormRow>
            <FormRow label="Rows">
              <NumberInput
                value={layoutForm.rows}
                onChange={(v) => updateField('rows', v)}
                step="1"
                min="1"
              />
            </FormRow>
            <FormRow label="Item W (in)">
              <NumberInput
                value={layoutForm.itemWidth}
                onChange={(v) => updateField('itemWidth', v)}
                step="0.1"
              />
            </FormRow>
            <FormRow label="Item H (in)">
              <NumberInput
                value={layoutForm.itemHeight}
                onChange={(v) => updateField('itemHeight', v)}
                step="0.1"
              />
            </FormRow>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 8 }}>
            <FormRow label="Sheet W (in)">
              <NumberInput
                value={layoutForm.sheetWidth}
                onChange={(v) => updateField('sheetWidth', v)}
                step="0.1"
              />
            </FormRow>
            <FormRow label="Sheet H (in)">
              <NumberInput
                value={layoutForm.sheetHeight}
                onChange={(v) => updateField('sheetHeight', v)}
                step="0.1"
              />
            </FormRow>
            <FormRow label="DPI">
              <NumberInput
                value={layoutForm.dpi}
                onChange={(v) => updateField('dpi', v)}
                step="1"
              />
            </FormRow>
            <FormRow label="Col Gap (in)">
              <NumberInput
                value={layoutForm.colGap}
                onChange={(v) => updateField('colGap', v)}
                step="0.01"
                min="0"
              />
            </FormRow>
            <FormRow label="Row Gap (in)">
              <NumberInput
                value={layoutForm.rowGap}
                onChange={(v) => updateField('rowGap', v)}
                step="0.01"
                min="0"
              />
            </FormRow>
          </div>

          {/* Position on sheet */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr 1fr',
              gap: 12,
              alignItems: 'flex-end',
              marginBottom: 12,
            }}
          >
            <label
              style={{
                fontSize: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                paddingBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={!!layoutForm.centerOnSheet}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setLayoutForm((prev) => ({
                    ...prev,
                    centerOnSheet: checked,
                    ...(checked
                      ? {
                          marginLeft: parseFloat(geom.offsetLeft.toFixed(2)),
                          marginTop: parseFloat(geom.offsetTop.toFixed(2)),
                        }
                      : {}),
                  }));
                }}
              />
              Center on sheet
            </label>
            <FormRow label="Left Margin (in)">
              <NumberInput
                value={
                  layoutForm.centerOnSheet
                    ? parseFloat(geom.offsetLeft.toFixed(2))
                    : layoutForm.marginLeft
                }
                onChange={(v) => updateField('marginLeft', v)}
                step="0.1"
                min="0"
                disabled={!!layoutForm.centerOnSheet}
              />
            </FormRow>
            <FormRow label="Top Margin (in)">
              <NumberInput
                value={
                  layoutForm.centerOnSheet
                    ? parseFloat(geom.offsetTop.toFixed(2))
                    : layoutForm.marginTop
                }
                onChange={(v) => updateField('marginTop', v)}
                step="0.1"
                min="0"
                disabled={!!layoutForm.centerOnSheet}
              />
            </FormRow>
          </div>

          {/* Info line */}
          <div
            style={{
              padding: '8px 12px',
              background: 'var(--bg-input)',
              borderRadius: 4,
              fontSize: 13,
              color: 'var(--text-secondary)',
              marginBottom: 16,
            }}
          >
            {geom.totalItems} items ({geom.c}×{geom.r}), each {geom.iw}"×
            {geom.ih}" → content area {geom.contentW.toFixed(2)}"×
            {geom.contentH.toFixed(2)}" on {geom.sw}"×{geom.sh}" sheet
            {(geom.extraW > 0.01 || geom.extraH > 0.01) && (
              <span style={{ color: '#e0b341', marginLeft: 8 }}>
                Extra: {geom.extraW > 0.01 ? `${geom.extraW.toFixed(1)}" right` : ''}
                {geom.extraW > 0.01 && geom.extraH > 0.01 ? ', ' : ''}
                {geom.extraH > 0.01 ? `${geom.extraH.toFixed(1)}" bottom` : ''}
              </span>
            )}
          </div>

          {/* Text Overlays */}
          <TextOverlaysEditor
            overlays={layoutForm.textOverlays}
            textVariables={textVariables}
            onAdd={addTextOverlay}
            onUpdate={updateTextOverlay}
            onRemove={removeTextOverlay}
            onInsertVar={insertVariable}
          />
        </div>

        {/* RIGHT: Live Preview */}
        <div style={{ flex: '0 0 380px', minWidth: 320 }}>
          <label
            style={{
              display: 'block',
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: 8,
            }}
          >
            Live Preview
          </label>
          <div
            style={{
              background: '#2a2a3a',
              borderRadius: 6,
              padding: 16,
            }}
          >
            <LayoutPreviewSvg layout={layoutForm} geom={geom} />
          </div>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <StatusBanner kind="error" message={error} />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          marginTop: 16,
        }}
      >
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSaveClick}
          disabled={saving || !layoutForm.name}
        >
          {saving ? 'Saving…' : initialLayout ? 'Update Layout' : 'Create Layout'}
        </Button>
      </div>
    </div>
  );
}

// ─── Text overlays sub-editor ──────────────────────────────

function TextOverlaysEditor({
  overlays,
  textVariables,
  onAdd,
  onUpdate,
  onRemove,
  onInsertVar,
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600 }}>Text Overlays</span>
        <Button onClick={onAdd}>+ Add Text</Button>
      </div>

      {overlays.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>
          No text overlays. Add text to empty areas of the sheet.
        </div>
      )}

      {overlays.map((overlay, i) => (
        <div
          key={i}
          style={{
            padding: 10,
            background: 'var(--bg-input)',
            borderRadius: 4,
            marginBottom: 8,
            border: '1px solid var(--border-color)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>Text #{i + 1}</span>
            <Button variant="danger" onClick={() => onRemove(i)}>
              Remove
            </Button>
          </div>

          <FormRow label="Text" hint="Use \\n for line breaks. Click a token below to insert.">
            <textarea
              value={overlay.text || ''}
              onChange={(e) => onUpdate(i, 'text', e.target.value)}
              placeholder="e.g. Order: {order_id}\nGallery: {gallery}"
              style={{
                width: '100%',
                minHeight: 50,
                padding: '8px 10px',
                fontSize: 14,
                fontFamily: 'inherit',
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
          </FormRow>

          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
            {textVariables.map((v) => (
              <button
                key={v.token}
                type="button"
                onClick={() => onInsertVar(i, v.token)}
                title={v.description || v.token}
                style={{
                  padding: '3px 8px',
                  fontSize: 12,
                  background: 'rgba(120,120,200,0.18)',
                  color: '#aab',
                  fontFamily: 'var(--font-mono, monospace)',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                {v.token}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onInsertVar(i, '\\n')}
              title="Insert line break"
              style={{
                padding: '3px 8px',
                fontSize: 12,
                background: 'rgba(120,120,200,0.18)',
                color: '#aab',
                fontFamily: 'var(--font-mono, monospace)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              ↵ newline
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr 60px', gap: 6 }}>
            <FormRow label="X (in)">
              <NumberInput
                value={overlay.x}
                onChange={(v) => onUpdate(i, 'x', v)}
                step="0.1"
              />
            </FormRow>
            <FormRow label="Y (in)">
              <NumberInput
                value={overlay.y}
                onChange={(v) => onUpdate(i, 'y', v)}
                step="0.1"
              />
            </FormRow>
            <FormRow label="W (in)">
              <NumberInput
                value={overlay.width ?? ''}
                onChange={(v) => onUpdate(i, 'width', v)}
                step="0.1"
                placeholder="auto"
              />
            </FormRow>
            <FormRow label="H (in)">
              <NumberInput
                value={overlay.height ?? ''}
                onChange={(v) => onUpdate(i, 'height', v)}
                step="0.1"
                placeholder="auto"
              />
            </FormRow>
            <FormRow label="Size (pt)">
              <NumberInput
                value={overlay.fontSize ?? 10}
                onChange={(v) => onUpdate(i, 'fontSize', v)}
                step="1"
                min="4"
                max="200"
                disabled={!!overlay.autoSize}
              />
            </FormRow>
            <FormRow label="Rotate (°)">
              <NumberInput
                value={overlay.rotation ?? 0}
                onChange={(v) => onUpdate(i, 'rotation', v)}
                step="1"
              />
            </FormRow>
            <FormRow label="Color">
              <input
                type="color"
                value={overlay.color || '#000000'}
                onChange={(e) => onUpdate(i, 'color', e.target.value)}
                style={{
                  width: '100%',
                  height: 30,
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  padding: 0,
                  background: 'transparent',
                }}
              />
            </FormRow>
          </div>

          <div style={{ display: 'flex', gap: 16, marginTop: 6, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!overlay.autoSize}
                onChange={(e) => onUpdate(i, 'autoSize', e.target.checked)}
              />
              Auto-size to fit
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!overlay.centerAlign}
                onChange={(e) => onUpdate(i, 'centerAlign', e.target.checked)}
              />
              Center align
            </label>
            {overlay.autoSize && !overlay.width && (
              <span style={{ fontSize: 11, color: '#e0b341' }}>
                Set W and H for auto-size to work
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Live SVG preview ───────────────────────────────────────

function LayoutPreviewSvg({ layout, geom }) {
  const { sw, sh, iw, ih, c, r, cg, rg, contentW, contentH, offsetLeft, offsetTop, extraW, extraH } = geom;

  // Scale: everything is in inches, convert to preview pixels.
  const maxW = 340;
  const maxH = 460;
  const scaleX = maxW / sw;
  const scaleY = maxH / sh;
  const scale = Math.min(scaleX, scaleY);

  const pvW = Math.round(sw * scale);
  const pvH = Math.round(sh * scale);
  const uiMargin = 24;
  const svgW = pvW + uiMargin * 2;
  const svgH = pvH + uiMargin * 2 + 20;

  // Grid cells
  const cells = [];
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const xIn = offsetLeft + col * (iw + cg);
      const yIn = offsetTop + row * (ih + rg);
      const x = uiMargin + xIn * scale;
      const y = uiMargin + yIn * scale;
      const w = iw * scale;
      const h = ih * scale;
      cells.push(
        <rect
          key={`c${row}-${col}`}
          x={x}
          y={y}
          width={w}
          height={h}
          fill="#4a90d9"
          fillOpacity="0.25"
          stroke="#4a90d9"
          strokeWidth="1.5"
          rx="2"
        />
      );
      cells.push(
        <text
          key={`t${row}-${col}`}
          x={x + w / 2}
          y={y + h / 2 + 4}
          textAnchor="middle"
          fontSize="11"
          fill="#4a90d9"
          fontWeight="600"
        >
          {`${iw}"×${ih}"`}
        </text>
      );
    }
  }

  // Gap indicators
  const gapLines = [];
  if (cg > 0) {
    for (let col = 1; col < c; col++) {
      const gapStartIn = offsetLeft + col * iw + (col - 1) * cg;
      const gapX = uiMargin + gapStartIn * scale;
      const gapW = cg * scale;
      gapLines.push(
        <g key={`cg${col}`}>
          <rect
            x={gapX}
            y={uiMargin + offsetTop * scale}
            width={Math.max(gapW, 1)}
            height={contentH * scale}
            fill="#ff6b6b"
            fillOpacity="0.15"
          />
          {gapW > 8 && (
            <text
              x={gapX + gapW / 2}
              y={uiMargin + (offsetTop + contentH) * scale + 12}
              textAnchor="middle"
              fontSize="8"
              fill="#ff6b6b"
            >
              {cg}"
            </text>
          )}
        </g>
      );
    }
  }
  if (rg > 0) {
    for (let row = 1; row < r; row++) {
      const gapStartIn = offsetTop + row * ih + (row - 1) * rg;
      const gapY = uiMargin + gapStartIn * scale;
      const gapH = rg * scale;
      gapLines.push(
        <g key={`rg${row}`}>
          <rect
            x={uiMargin + offsetLeft * scale}
            y={gapY}
            width={contentW * scale}
            height={Math.max(gapH, 1)}
            fill="#ff6b6b"
            fillOpacity="0.15"
          />
        </g>
      );
    }
  }

  // Margin + extra-space shading
  const extraSpace = [];
  if (extraW > 0.01) {
    const exX = uiMargin + (offsetLeft + contentW) * scale;
    extraSpace.push(
      <g key="exW">
        <rect
          x={exX}
          y={uiMargin}
          width={extraW * scale}
          height={pvH}
          fill="#ffaa00"
          fillOpacity="0.08"
          stroke="#ffaa00"
          strokeWidth="0.5"
          strokeDasharray="4,3"
        />
        <text
          x={exX + (extraW * scale) / 2}
          y={uiMargin + pvH / 2}
          textAnchor="middle"
          fontSize="9"
          fill="#ffaa00"
          fontWeight="600"
        >
          {extraW.toFixed(1)}"
        </text>
      </g>
    );
  }
  if (offsetLeft > 0.01) {
    extraSpace.push(
      <g key="mL">
        <rect
          x={uiMargin}
          y={uiMargin}
          width={offsetLeft * scale}
          height={pvH}
          fill="#66bb6a"
          fillOpacity="0.08"
          stroke="#66bb6a"
          strokeWidth="0.5"
          strokeDasharray="4,3"
        />
        <text
          x={uiMargin + (offsetLeft * scale) / 2}
          y={uiMargin + pvH / 2}
          textAnchor="middle"
          fontSize="9"
          fill="#66bb6a"
          fontWeight="600"
        >
          {offsetLeft.toFixed(1)}"
        </text>
      </g>
    );
  }
  if (extraH > 0.01) {
    const exY = uiMargin + (offsetTop + contentH) * scale;
    extraSpace.push(
      <g key="exH">
        <rect
          x={uiMargin}
          y={exY}
          width={pvW}
          height={extraH * scale}
          fill="#ffaa00"
          fillOpacity="0.08"
          stroke="#ffaa00"
          strokeWidth="0.5"
          strokeDasharray="4,3"
        />
        <text
          x={uiMargin + pvW / 2}
          y={exY + (extraH * scale) / 2 + 3}
          textAnchor="middle"
          fontSize="9"
          fill="#ffaa00"
          fontWeight="600"
        >
          {extraH.toFixed(1)}"
        </text>
      </g>
    );
  }
  if (offsetTop > 0.01) {
    extraSpace.push(
      <g key="mT">
        <rect
          x={uiMargin}
          y={uiMargin}
          width={pvW}
          height={offsetTop * scale}
          fill="#66bb6a"
          fillOpacity="0.08"
          stroke="#66bb6a"
          strokeWidth="0.5"
          strokeDasharray="4,3"
        />
        <text
          x={uiMargin + pvW / 2}
          y={uiMargin + (offsetTop * scale) / 2 + 3}
          textAnchor="middle"
          fontSize="9"
          fill="#66bb6a"
          fontWeight="600"
        >
          {offsetTop.toFixed(1)}"
        </text>
      </g>
    );
  }

  // Text overlays
  const textIndicators = (layout.textOverlays || []).map((ov, idx) => {
    const tx = uiMargin + num(ov.x, 0) * scale;
    const ty = uiMargin + num(ov.y, 0) * scale;
    const rot = num(ov.rotation, 0);
    const lines = String(ov.text || 'Text').split('\\n');
    const displayText = lines[0].substring(0, 25);
    const textColor = ov.color || '#000';
    const fSize = Math.max(Math.round((num(ov.fontSize, 10)) * scale / 30), 7);
    const labelW = Math.min(displayText.length * fSize * 0.6 + 8, pvW);
    const labelH = fSize + 6;
    return (
      <g key={`ov${idx}`} transform={`rotate(${rot} ${tx} ${ty})`}>
        <rect
          x={tx}
          y={ty - 2}
          width={labelW}
          height={labelH * lines.length}
          fill={textColor}
          fillOpacity="0.12"
          rx="2"
          stroke={textColor}
          strokeWidth="1"
          strokeDasharray="2,2"
        />
        <text
          x={tx + 3}
          y={ty + fSize - 1}
          fontSize={fSize}
          fill={textColor}
          fontFamily="Arial"
          fontWeight="600"
        >
          {displayText}
          {lines.length > 1 ? '...' : ''}
        </text>
        <text x={tx} y={ty - 5} fontSize="7" fill="#aaa">
          ({num(ov.x, 0)}", {num(ov.y, 0)}")
        </text>
      </g>
    );
  });

  // Ruler ticks
  const rulerTicks = [];
  for (let i = 0; i <= sw; i++) {
    const x = uiMargin + i * scale;
    rulerTicks.push(
      <line key={`rtx${i}`} x1={x} y1={uiMargin - 8} x2={x} y2={uiMargin} stroke="#888" strokeWidth="0.8" />
    );
    if (i > 0 && i < sw) {
      rulerTicks.push(
        <text key={`rtxl${i}`} x={x} y={uiMargin - 10} textAnchor="middle" fontSize="7" fill="#888">
          {i}"
        </text>
      );
    }
  }
  for (let i = 0; i <= sh; i++) {
    const y = uiMargin + i * scale;
    rulerTicks.push(
      <line key={`rty${i}`} x1={uiMargin - 8} y1={y} x2={uiMargin} y2={y} stroke="#888" strokeWidth="0.8" />
    );
    if (i > 0 && i < sh) {
      rulerTicks.push(
        <text key={`rtyl${i}`} x={uiMargin - 12} y={y + 3} textAnchor="end" fontSize="7" fill="#888">
          {i}"
        </text>
      );
    }
  }

  return (
    <svg width={svgW} height={svgH} style={{ display: 'block' }}>
      <rect width={svgW} height={svgH} fill="#2a2a3a" />
      {rulerTicks}
      <rect
        x={uiMargin}
        y={uiMargin}
        width={pvW}
        height={pvH}
        fill="white"
        stroke="#666"
        strokeWidth="2"
      />
      {extraSpace}
      {gapLines}
      {cells}
      {textIndicators}
      <text
        x={uiMargin + pvW / 2}
        y={uiMargin + pvH + 16}
        textAnchor="middle"
        fontSize="10"
        fill="#aaa"
        fontWeight="600"
      >
        {sw}" × {sh}" sheet
      </text>
    </svg>
  );
}
