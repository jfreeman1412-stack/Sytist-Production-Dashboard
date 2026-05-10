// LayoutCanvas.js — Phase 9b: interactive SVG layout editor.
//
// Renders a composite layout as an SVG canvas where slots can be:
//   - Selected by clicking
//   - Dragged to reposition
//   - Resized by 8 handles (corners + edges)
//
// Coordinates: SVG viewBox is the layout's INCH dimensions. So a 5×7
// sheet has viewBox="0 0 5 7" and slot positions/sizes are in inches
// throughout. SVG handles aspect-ratio scaling — the canvas always
// fills its container while preserving proportion.
//
// Mouse events: we capture mousemove/mouseup on the WINDOW during a
// drag/resize, not on the slot itself. This is essential — if the
// operator drags fast, the cursor can leave the slot's bounds, and a
// per-slot mousemove handler would lose tracking. Window-level events
// give us complete coverage.
//
// The component supports two modes:
//   - Read-only (no onSlotChange callback) — Phase 9a behavior
//   - Interactive (onSlotChange supplied) — Phase 9b behavior
//
// Sticking to one component for both keeps things consistent. The mode
// is determined by the presence of onSlotChange.

import React, { useEffect, useRef, useState } from 'react';

const SLOT_STYLES = {
  playerPhoto: { fill: '#5d8fc4', stroke: '#3c6a9a', label: 'Player photo' },
  teamPhoto:   { fill: '#c46060', stroke: '#9a3c3c', label: 'Team photo' },
  logo:        { fill: '#7cc46d', stroke: '#4a9a3c', label: 'Logo' },
  overlay:     { fill: '#aaaaaa', stroke: '#777777', label: 'Overlay' },
  text:        { fill: 'transparent', stroke: '#888888', label: 'Text' },
};
const FALLBACK_STYLE = { fill: '#888888', stroke: '#555555', label: '?' };

// Default snap step in inches. UI exposes a toggle to disable.
export const DEFAULT_SNAP_STEP = 0.05;

export default function LayoutCanvas({
  layout,
  variant = 'vertical',
  selectedIndex = null,
  onSlotSelect,
  onSlotChange, // (index, newSlot) — when supplied, enables interactive editing
  width = 360,
  height = 504,
  sampleTokens = {},
  snapEnabled = true,
  snapStep = DEFAULT_SNAP_STEP,
  // Optional preview backdrop — base64 JPG, rendered behind slot boxes
  // so the operator can position slots over actual photos.
  backgroundImageDataUrl = null,
}) {
  const svgRef = useRef(null);

  // Drag/resize transient state. Lives in the canvas itself because the
  // parent doesn't need it during the drag — only the final value, on
  // mouseup. This avoids a re-render cascade for every mousemove tick.
  const [dragState, setDragState] = useState(null);
  // dragState shape:
  //   {
  //     mode: 'drag' | 'resize',
  //     slotIndex,
  //     handle: null | 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w',
  //     startX, startY,                    // mouse position at start (px)
  //     originalSlot: {x, y, w, h, ...},   // slot at drag start
  //   }

  const interactive = typeof onSlotChange === 'function';

  // Compute the on-screen → inches conversion factor. Re-derived on
  // every mousemove because the SVG might be in a flexbox that changes
  // size. Use getBoundingClientRect for accurate live values.
  function getInchesPerPixel() {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: layout.sheetWidth / rect.width,
      y: layout.sheetHeight / rect.height,
      rect,
    };
  }

  // Snap a value to the configured grid step. No-op when snap is off.
  function maybeSnap(value) {
    if (!snapEnabled) return value;
    return Math.round(value / snapStep) * snapStep;
  }

  // Constrain a slot's position to fit within the sheet. Only applied
  // for drag (resize already handles its own clamping based on the
  // handle direction).
  function constrainPosition(slot) {
    return {
      ...slot,
      x: clamp(slot.x, 0, layout.sheetWidth - slot.w),
      y: clamp(slot.y, 0, layout.sheetHeight - slot.h),
    };
  }

  // Constrain after a resize. Width/height must be positive; resulting
  // box must stay inside the sheet.
  function constrainSize(slot) {
    const minDim = 0.1; // 0.1 inch minimum so slots can't disappear
    let { x, y, w, h } = slot;

    // Clamp position into sheet
    x = clamp(x, 0, layout.sheetWidth);
    y = clamp(y, 0, layout.sheetHeight);

    // Clamp size to a positive minimum
    if (w < minDim) w = minDim;
    if (h < minDim) h = minDim;

    // If x + w exceeds the sheet, pull w back (not x — the operator's
    // intent during a resize is anchored to whichever edge they're not
    // dragging)
    if (x + w > layout.sheetWidth) w = layout.sheetWidth - x;
    if (y + h > layout.sheetHeight) h = layout.sheetHeight - y;

    return { ...slot, x, y, w, h };
  }

  // Compute new slot dimensions after a resize. Each handle moves a
  // specific subset of edges:
  //
  //   nw — top-left corner: moves x, y; w & h grow as x, y decrease
  //   n  — top edge: moves y; h grows as y decreases
  //   ne — top-right: moves y; w & h adjust
  //   e  — right edge: w only
  //   se — bottom-right: w & h
  //   s  — bottom edge: h only
  //   sw — bottom-left: x, w, h
  //   w  — left edge: x, w
  function applyResize(originalSlot, handle, dxInch, dyInch) {
    let { x, y, w, h } = originalSlot;
    if (handle.includes('w')) {
      x = originalSlot.x + dxInch;
      w = originalSlot.w - dxInch;
    }
    if (handle.includes('e')) {
      w = originalSlot.w + dxInch;
    }
    if (handle.includes('n')) {
      y = originalSlot.y + dyInch;
      h = originalSlot.h - dyInch;
    }
    if (handle.includes('s')) {
      h = originalSlot.h + dyInch;
    }
    return { ...originalSlot, x, y, w, h };
  }

  // ─── Mouse handlers (window-level during a drag/resize) ──

  useEffect(() => {
    if (!dragState) return;

    function onMove(e) {
      const conv = getInchesPerPixel();
      if (!conv.rect) return;
      const dxPx = e.clientX - dragState.startX;
      const dyPx = e.clientY - dragState.startY;
      const dxInch = dxPx * conv.x;
      const dyInch = dyPx * conv.y;

      let nextSlot;
      if (dragState.mode === 'drag') {
        nextSlot = {
          ...dragState.originalSlot,
          x: maybeSnap(dragState.originalSlot.x + dxInch),
          y: maybeSnap(dragState.originalSlot.y + dyInch),
        };
        nextSlot = constrainPosition(nextSlot);
      } else {
        const resized = applyResize(
          dragState.originalSlot,
          dragState.handle,
          maybeSnap(dxInch),
          maybeSnap(dyInch)
        );
        nextSlot = constrainSize(resized);
      }

      // Live update — fire onSlotChange so the parent re-renders the
      // canvas with the new slot in real time. This is the price of
      // putting the source-of-truth in the parent: every mousemove is
      // a parent re-render. In practice React + SVG handles this fine
      // for the slot counts we'll have.
      onSlotChange(dragState.slotIndex, nextSlot);
    }

    function onUp() {
      // Drag ended; clear the local transient state. The parent already
      // has the final slot from the last onMove → onSlotChange.
      setDragState(null);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState]);

  // ─── Mousedown handlers on slot body / handle ─────────────

  function startDrag(e, slotIndex, originalSlot) {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    onSlotSelect && onSlotSelect(slotIndex);
    setDragState({
      mode: 'drag',
      slotIndex,
      handle: null,
      startX: e.clientX,
      startY: e.clientY,
      originalSlot: { ...originalSlot },
    });
  }

  function startResize(e, slotIndex, originalSlot, handle) {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    setDragState({
      mode: 'resize',
      slotIndex,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      originalSlot: { ...originalSlot },
    });
  }

  // ─── Render ──────────────────────────────────────────────

  if (!layout) {
    return (
      <div
        style={{
          width, height,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)', fontSize: 12,
        }}
      >
        (no layout)
      </div>
    );
  }

  const variantDef = layout.variants?.[variant];
  const sheetW = layout.sheetWidth;
  const sheetH = layout.sheetHeight;
  const slots = variantDef?.slots || [];

  function handleBackgroundClick(e) {
    if (e.target === e.currentTarget) {
      onSlotSelect && onSlotSelect(null);
    }
  }

  return (
    <div
      style={{
        width, height,
        position: 'relative',
        background: '#2a2a2a',
        borderRadius: 6,
        padding: 12,
        boxSizing: 'border-box',
        userSelect: dragState ? 'none' : 'auto',
        cursor: dragState
          ? dragState.mode === 'drag' ? 'grabbing'
            : RESIZE_CURSORS[dragState.handle]
          : 'default',
      }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${sheetW} ${sheetH}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={(e) => {
          // Background click → deselect (only if no drag is in progress)
          if (!dragState && e.target === e.currentTarget) {
            onSlotSelect && onSlotSelect(null);
          }
        }}
        onClick={handleBackgroundClick}
        style={{ display: 'block' }}
      >
        {/* Sheet background */}
        <rect
          x="0" y="0" width={sheetW} height={sheetH}
          fill={layout.backgroundColor || '#ffffff'}
          stroke="#666"
          strokeWidth={Math.min(sheetW, sheetH) * 0.005}
        />

        {/* Optional preview backdrop image (for live preview mode) */}
        {backgroundImageDataUrl && (
          <image
            href={backgroundImageDataUrl}
            x="0" y="0" width={sheetW} height={sheetH}
            preserveAspectRatio="none"
            opacity="0.85"
            pointerEvents="none"
          />
        )}

        {!variantDef && (
          <g pointerEvents="none">
            <line
              x1="0" y1="0" x2={sheetW} y2={sheetH}
              stroke="#dc3545" strokeWidth="0.05" strokeDasharray="0.1 0.1"
            />
            <line
              x1={sheetW} y1="0" x2="0" y2={sheetH}
              stroke="#dc3545" strokeWidth="0.05" strokeDasharray="0.1 0.1"
            />
            <text
              x={sheetW / 2} y={sheetH / 2}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={Math.min(sheetW, sheetH) * 0.06}
              fill="#dc3545" fontFamily="Arial, sans-serif" fontWeight="600"
            >
              {variant} variant not defined
            </text>
          </g>
        )}

        {/* Slots */}
        {slots.map((slot, idx) => (
          <SlotShape
            key={idx}
            slot={slot}
            sampleTokens={sampleTokens}
            isSelected={selectedIndex === idx}
            interactive={interactive}
            hasBackdrop={!!backgroundImageDataUrl}
            onMouseDown={(e) => startDrag(e, idx, slot)}
            onSelect={() => onSlotSelect && onSlotSelect(idx)}
          />
        ))}

        {/* Resize handles for the selected slot — drawn after slots so
            they overlay on top */}
        {interactive && selectedIndex !== null && slots[selectedIndex] && (
          <ResizeHandles
            slot={slots[selectedIndex]}
            sheetW={sheetW}
            sheetH={sheetH}
            onHandleDown={(e, handle) =>
              startResize(e, selectedIndex, slots[selectedIndex], handle)
            }
          />
        )}
      </svg>

      <div
        style={{
          position: 'absolute',
          bottom: 4, right: 8,
          fontSize: 10,
          color: 'rgba(255,255,255,0.4)',
          fontFamily: 'var(--font-mono, monospace)',
          pointerEvents: 'none',
        }}
      >
        {sheetW}″ × {sheetH}″ @ {layout.dpi || 300}dpi
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────

function SlotShape({ slot, sampleTokens, isSelected, interactive, hasBackdrop, onMouseDown, onSelect }) {
  const style = SLOT_STYLES[slot.kind] || FALLBACK_STYLE;
  const x = slot.x || 0;
  const y = slot.y || 0;
  const w = slot.w || 0;
  const h = slot.h || 0;

  if (w <= 0 || h <= 0) return null;

  // When a backdrop image exists, slot boxes become semi-transparent
  // outlines so the operator can see the photos behind them. Otherwise
  // (placeholder mode) slots are filled solid as visual placeholders.
  const fillOpacity = hasBackdrop ? 0.15 : 0.85;
  const strokeWidth = isSelected ? 0.04 : 0.015;
  const strokeColor = isSelected ? '#4a7fc1' : style.stroke;

  const cursor = interactive ? 'move' : 'pointer';

  if (slot.kind === 'text') {
    return (
      <g
        style={{ cursor }}
        onMouseDown={onMouseDown}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
      >
        <rect
          x={x} y={y} width={w} height={h}
          fill={isSelected ? 'rgba(74,127,193,0.15)' : 'transparent'}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray="0.06 0.04"
        />
        <SlotText slot={slot} sampleTokens={sampleTokens} x={x} y={y} w={w} h={h} />
      </g>
    );
  }

  const labelFontSize = Math.min(w, h) * 0.08;

  return (
    <g
      style={{ cursor }}
      onMouseDown={onMouseDown}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <rect
        x={x} y={y} width={w} height={h}
        fill={style.fill}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        opacity={fillOpacity}
      />
      {!hasBackdrop && (
        <text
          x={x + w / 2} y={y + h / 2}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={labelFontSize}
          fill="white" fontFamily="Arial, sans-serif" fontWeight="500"
          pointerEvents="none"
        >
          {style.label}
        </text>
      )}
    </g>
  );
}

function SlotText({ slot, sampleTokens, x, y, w, h }) {
  const resolvedText = substituteTokens(slot.text || '', sampleTokens);
  const dpi = sampleTokens.__dpi || 300;
  const inchFontSize = (slot.fontSize || 24) / dpi;
  const align = slot.align || 'center';
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const textX = align === 'left' ? x : align === 'right' ? x + w : x + w / 2;

  return (
    <text
      x={textX} y={y + h / 2}
      textAnchor={anchor} dominantBaseline="middle"
      fontSize={inchFontSize}
      fontFamily={slot.fontFamily || 'Arial, sans-serif'}
      fontWeight={slot.weight || 'normal'}
      fill={slot.color || '#000000'}
      pointerEvents="none"
    >
      {resolvedText || '(empty text)'}
    </text>
  );
}

function ResizeHandles({ slot, sheetW, sheetH, onHandleDown }) {
  const x = slot.x;
  const y = slot.y;
  const w = slot.w;
  const h = slot.h;

  // Handle size in inches — 0.12" diameter circles look balanced
  // across all reasonable sheet sizes
  const handleSize = Math.min(sheetW, sheetH) * 0.018;

  const handles = [
    { id: 'nw', cx: x,         cy: y },
    { id: 'n',  cx: x + w / 2, cy: y },
    { id: 'ne', cx: x + w,     cy: y },
    { id: 'e',  cx: x + w,     cy: y + h / 2 },
    { id: 'se', cx: x + w,     cy: y + h },
    { id: 's',  cx: x + w / 2, cy: y + h },
    { id: 'sw', cx: x,         cy: y + h },
    { id: 'w',  cx: x,         cy: y + h / 2 },
  ];

  return (
    <g>
      {handles.map((h) => (
        <circle
          key={h.id}
          cx={h.cx} cy={h.cy}
          r={handleSize}
          fill="#ffffff"
          stroke="#4a7fc1"
          strokeWidth={handleSize * 0.3}
          style={{ cursor: RESIZE_CURSORS[h.id] }}
          onMouseDown={(e) => onHandleDown(e, h.id)}
        />
      ))}
    </g>
  );
}

const RESIZE_CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n:  'ns-resize',   s:  'ns-resize',
  e:  'ew-resize',   w:  'ew-resize',
};

// ─── Helpers ────────────────────────────────────────────────

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

function substituteTokens(template, ctx) {
  if (!template) return '';
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const parts = key.split('.');
    let v = ctx;
    for (const p of parts) {
      if (v == null) return '';
      v = v[p];
    }
    return v == null ? '' : String(v);
  });
}

export const PLACEHOLDER_TOKENS = {
  customer: { firstName: 'Sample', lastName: 'Player', email: 's@p.com' },
  subject: {
    athleteName: 'Sample Player',
    coachName: 'Coach Smith',
    teamAndLevel: 'Varsity',
    jerseyNumber: '12',
  },
  galleryName: 'Sample Gallery',
  subGalleryName: 'Sample Team',
  order: { id: '99999', date: '2025-10-15' },
  year: new Date().getFullYear(),
  date: new Date().toISOString().split('T')[0],
  __dpi: 300,
};
