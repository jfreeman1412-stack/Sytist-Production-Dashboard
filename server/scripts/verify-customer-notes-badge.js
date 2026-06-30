// Phase 78 verification harness — customer-notes badge tooltip rule.
//
// The badge is rendered iff at least one source has substantive content
// (order_notes OR per-line cart_notes — both customer-entered). The tooltip
// composition is the load-bearing UX rule (see SPEC §78). This harness
// drives the canonical tooltip builder from the client (re-implemented here
// against the same input shape) and asserts the 8 fixture cases Joey
// specified, plus a couple of guard cases against silent drift.
//
// Why we re-implement the tooltip builder here rather than importing it
// from client/src/pages/OrdersListPage.js: the client file is a React
// module with JSX + CSS-in-JS imports that won't load in plain Node.js
// without a bundler. The harness keeps the rule's two encodings (the JS
// builder in OrdersListPage.js and this one) commented as parallel — the
// only fixture-driven cases that would catch a drift are the truncate
// thresholds (150 / 100 / 80 chars) and the priority order. Both are
// asserted explicitly here.
//
// Whitespace-trim parity check: a separate fixture case asserts that
// `(order.customerNotes || '').trim()` empty-out behaves the same as
// what the SQL-side _lineItemNotesExistsSql guarantees (REGEXP not TRIM).
// The harness covers the JS half; the SQL half was verified live during
// the audit (see SPEC §78 "REGEXP-not-TRIM" subsection).

const ORDER_NOTES_TRUNCATE_ALONE = 150;
const ORDER_NOTES_TRUNCATE_BOTH = 150;
const LINE_NOTES_TRUNCATE_ALONE = 100;
const LINE_NOTES_TRUNCATE_BOTH = 80;

// Mirror of buildCustomerNoteTooltip(order) from
// client/src/pages/OrdersListPage.js. If you change one, change both —
// the harness verifies the rule, not the import.
function buildCustomerNoteTooltip(order) {
  const cn = (order.customerNotes || '').trim();
  const hasOrder = cn.length > 0;
  const hasLine = !!order.hasLineItemNotes;
  if (!hasOrder && !hasLine) return null;

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  const linePreview = (order.lineItemNotesPreview || '').trim();
  const lineCount = Number(order.lineItemNotesCount) || 0;
  const moreSuffix = lineCount > 1 ? ` (+${lineCount - 1} more)` : '';

  if (hasOrder && hasLine) {
    return (
      truncate(cn, ORDER_NOTES_TRUNCATE_BOTH) +
      ' · Line item notes: ' +
      truncate(linePreview, LINE_NOTES_TRUNCATE_BOTH) +
      moreSuffix
    );
  }
  if (hasOrder) {
    return truncate(cn, ORDER_NOTES_TRUNCATE_ALONE);
  }
  return (
    'Line item notes: ' + truncate(linePreview, LINE_NOTES_TRUNCATE_ALONE) + moreSuffix
  );
}

let pass = 0;
const fails = [];
function expect(name, actual, expected) {
  // Object equality via JSON since values are scalars / strings / null.
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fails.push(name);
    console.log('  FAIL  ' + name);
    console.log('         got:      ' + JSON.stringify(actual));
    console.log('         expected: ' + JSON.stringify(expected));
  }
}

console.log('=== Phase 78: customer-notes badge tooltip rule ===\n');

// (1) order_notes only → badge shows, tooltip = order_notes text
expect(
  '1. order_notes only → tooltip = order_notes text',
  buildCustomerNoteTooltip({
    customerNotes: 'Please mail the pictures to the billing address.',
    hasLineItemNotes: false,
    lineItemNotesPreview: '',
    lineItemNotesCount: 0,
  }),
  'Please mail the pictures to the billing address.'
);

// (2) cart_notes on one line item only → tooltip = "Line item notes: [text]"
expect(
  '2. cart_notes on one line item only → tooltip = "Line item notes: [text]"',
  buildCustomerNoteTooltip({
    customerNotes: '',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'Please fix flyaway hair on left side',
    lineItemNotesCount: 1,
  }),
  'Line item notes: Please fix flyaway hair on left side'
);

// (3) cart_notes on multiple line items → "+N more"
expect(
  '3. cart_notes on multiple line items → tooltip appends "(+N more)"',
  buildCustomerNoteTooltip({
    customerNotes: '',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'Coach: Mike Beaudoin',
    lineItemNotesCount: 4,
  }),
  'Line item notes: Coach: Mike Beaudoin (+3 more)'
);

// (4) both order_notes AND cart_notes → composed tooltip with separator
expect(
  '4. both → tooltip = order_notes + " · Line item notes: [first cart_note]"',
  buildCustomerNoteTooltip({
    customerNotes: 'Ship before March 15 please.',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'Spell name with two Ns',
    lineItemNotesCount: 1,
  }),
  'Ship before March 15 please. · Line item notes: Spell name with two Ns'
);

// (4b) both with multiple cart_notes → "+N more" appended to the line-notes segment
expect(
  '4b. both with multi-line-notes → tooltip composes order_notes + line preview + "(+N more)"',
  buildCustomerNoteTooltip({
    customerNotes: 'Ship before March 15 please.',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'Spell name with two Ns',
    lineItemNotesCount: 3,
  }),
  'Ship before March 15 please. · Line item notes: Spell name with two Ns (+2 more)'
);

// (5) whitespace-only in both fields → no badge (tooltip null)
expect(
  '5. whitespace-only in both fields → no badge (tooltip null)',
  buildCustomerNoteTooltip({
    customerNotes: '   \t\n  ',
    hasLineItemNotes: false,
    lineItemNotesPreview: '',
    lineItemNotesCount: 0,
  }),
  null
);

// (6) empty/null in both → no badge
expect(
  '6. empty/null in both → no badge (tooltip null)',
  buildCustomerNoteTooltip({
    customerNotes: '',
    hasLineItemNotes: false,
    lineItemNotesPreview: null,
    lineItemNotesCount: 0,
  }),
  null
);

// (7) Long order_notes (>150 chars) → tooltip truncates with ellipsis
expect(
  '7. long order_notes (>150 chars) → truncates at 149 + ellipsis',
  buildCustomerNoteTooltip({
    // 200-char note
    customerNotes: 'A'.repeat(200),
    hasLineItemNotes: false,
    lineItemNotesPreview: '',
    lineItemNotesCount: 0,
  }),
  'A'.repeat(149) + '…'
);

// (8) Long cart_notes → truncate per the rule (100 chars alone, 80 with order_notes)
expect(
  '8a. long cart_notes ALONE → truncates at 99 + ellipsis (100 cap)',
  buildCustomerNoteTooltip({
    customerNotes: '',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'B'.repeat(200),
    lineItemNotesCount: 1,
  }),
  'Line item notes: ' + 'B'.repeat(99) + '…'
);

expect(
  '8b. long cart_notes ALONGSIDE order_notes → truncates at 79 + ellipsis (80 cap)',
  buildCustomerNoteTooltip({
    customerNotes: 'Short order note.',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'B'.repeat(200),
    lineItemNotesCount: 1,
  }),
  'Short order note. · Line item notes: ' + 'B'.repeat(79) + '…'
);

// Guard cases against silent drift on edge conditions
// G1: hasLineItemNotes true but preview is whitespace-only → treat as no preview
//     (the badge still shows because the server's hasLineItemNotes is the
//     authority; the preview content fallback is empty-after-trim). The
//     tooltip composes "Line item notes:  " — an oddity, but not breaking;
//     in practice the server's REGEXP gate prevents whitespace-only previews
//     from reaching the client. This guard pins the rule.
expect(
  'G1: hasLineItemNotes=true with whitespace-only preview → tooltip still composes (server gate prevents this case in practice)',
  buildCustomerNoteTooltip({
    customerNotes: '',
    hasLineItemNotes: true,
    lineItemNotesPreview: '   \t  ',
    lineItemNotesCount: 1,
  }),
  'Line item notes: '
);

// G2: lineItemNotesCount = 1 → NO "(+N more)" suffix; the rule says count>1
expect(
  'G2: lineItemNotesCount=1 → no "(+N more)" suffix',
  buildCustomerNoteTooltip({
    customerNotes: '',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'just one note',
    lineItemNotesCount: 1,
  }),
  'Line item notes: just one note'
);

// G3: lineItemNotesCount = 0 but hasLineItemNotes = true (data oddity) →
//     "(+N more)" should NOT appear (Math.max guard not needed because
//     the conditional is `lineCount > 1`)
expect(
  'G3: count=0, hasLineItemNotes=true (defensive) → no "+N more"',
  buildCustomerNoteTooltip({
    customerNotes: '',
    hasLineItemNotes: true,
    lineItemNotesPreview: 'note text',
    lineItemNotesCount: 0,
  }),
  'Line item notes: note text'
);

console.log('\n' + pass + '/' + (pass + fails.length) + ' Phase 78 customer-notes tooltip cases pass');
if (fails.length) {
  console.error('FAILURES:\n  ' + fails.join('\n  '));
  process.exit(1);
}
process.exit(0);
