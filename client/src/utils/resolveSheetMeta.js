// Phase 70: canonical resolver for composite-layout sheet metadata
// (sheetWidth, sheetHeight, dpi, backgroundColor). Phase 57A made these
// per-variant: each variant may override the layout's root value; root
// remains only as a DEPRECATED fallback for un-diverged variants and pre-
// migration data. The server's compositeService.buildSheetBuffer resolves
// the same way.
//
// Use this helper from ANY client surface that displays composite-layout
// dimensions for a specific variant. Reading layout.sheetWidth (or .dpi /
// .backgroundColor) directly — without the variant fallback — is the bug
// class Phase 70 fixed. The composite list table (CompositesSettings) and
// the override editor (OverrideEditorPage) both drifted from the engine +
// the layout designer by reading root only, displaying stale dimensions
// for any layout whose variants had diverged from the root snapshot.
//
// LayoutCanvas + LayoutDesignerPage have their own inlined resolvers that
// already work correctly; Phase 70 deliberately left them alone (per scope
// — "don't expand to existing-correct inlines"), but the helper is
// available for them to use later if a future refactor consolidates them.
//
// Hardcoded defaults match LayoutCanvas's existing inline pattern
// (dpi → 300, backgroundColor → '#ffffff'). Numeric fields (sheetWidth,
// sheetHeight, dpi) use `!= null` to preserve 0/falsy variant values;
// backgroundColor uses an `||` chain so empty-string variant falls through
// to root (matching LayoutCanvas:130–133).
export function resolveSheetMeta(layout, variant) {
  if (!layout) {
    return {
      sheetWidth: undefined,
      sheetHeight: undefined,
      dpi: 300,
      backgroundColor: '#ffffff',
    };
  }
  const v = (layout.variants && layout.variants[variant]) || null;
  const sheetWidth =
    v && v.sheetWidth != null ? v.sheetWidth : layout.sheetWidth;
  const sheetHeight =
    v && v.sheetHeight != null ? v.sheetHeight : layout.sheetHeight;
  const dpi = (v && v.dpi != null ? v.dpi : layout.dpi) || 300;
  const backgroundColor =
    (v && v.backgroundColor) || layout.backgroundColor || '#ffffff';
  return { sheetWidth, sheetHeight, dpi, backgroundColor };
}
