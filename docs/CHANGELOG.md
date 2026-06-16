# Changelog

Concise per-phase summary of changes from Phase 17 onward. For phases 0–16, see the original `SPEC.md` sections 13 and 16–19. For deeper rationale on any individual phase, see the `Phase NN — ...` sections in `SPEC.md`.

Format: phase number → short title → what shipped → key files touched.

---

## Phase 17 — Green-screen compose at the composite layer
- New `greenscreenService.composeWithBackground(subjectBuffer, backgroundUrl)` using `sharp`
- Subject is a transparent PNG; background is fetched and resized with `fit:'cover'` to match subject dimensions
- Falls back to subject-only on background-fetch failure with a warning surfaced to the operator
- Wired into `routes/sytist.js` imposition preview + save endpoints
- Files: `server/services/greenscreenService.js` (new), `server/routes/sytist.js`

## Phase 18 — Paths + specialty routing refinements
- Specialty SKUs route to a separate base folder + per-SKU subfolder
- Specialty `.txt` is written to that folder and excluded from the regular `.txt`
- Files: `server/services/specialtyService.js`, `server/services/processingService.js`

## Phase 19 — Packaging header fix
- Package parent rows (`cart_package > 0`) now correctly flagged via `flags.package`
- Constituent items inherit package context for slip display
- Files: `server/services/sytistDbService.js`, `server/services/packingSlipService.js`

## Phase 20 — Order search
- Search box on orders list scopes by order number, customer name, or email
- Files: `client/src/pages/OrdersListPage.js`, `server/routes/sytist.js`

## Phase 21–22 — Visual editor: bleed canvas + wheel resize
- Imposition layout editor gets a bleed visualization
- Mouse-wheel scaling on slots at 5% per notch
- Files: `client/src/pages/settings/ImpositionLayoutEditor.js`, `client/src/components/LayoutCanvas.js`

## Phase 23–24 — Editor refinements
- Bleed default 30% then 0.6; canvas reflow at 950×—; Enter to load
- 3fr / 1fr grid for editor + properties panel
- Files: client/src/pages/settings/* editor components

## Phase 25 — Clip-to-canvas
- Imposition rendering clips strictly to the configured canvas bounds (no overflow into bleed)
- Files: `server/services/impositionService.js`

## Phase 26 — Designer reflow ResizeObserver
- Editor canvas dimensions track container resize via ResizeObserver
- Avoids layout drift when the browser window changes size mid-edit
- Files: `client/src/components/LayoutCanvas.js`

## Phase 27 — Imposition WYSIWYG editor
- Settings → Imposition gets the same visual editor used for composites
- Per-layout drag/resize/snap with grid + bleed overlay
- Files: `client/src/pages/settings/ImpositionLayoutEditor.js`

## Phase 28 — Manual ship/unship + bulk Mark Shipped
- New `orderStatusService.shipOrder` / `unshipOrder` with eligibility check (configurable `shipEligibleFromStatusIds`)
- `order_status_audit` SQLite table records every ship/unship event (`source`, `user_id`, `from_status`, `to_status`)
- `POST /api/sytist/orders/:orderId/ship`, `POST /unship`, `POST /batch-ship`
- New `ShipStatusBlock` UI on order detail; bulk Mark Shipped from orders list selection
- Files: `server/services/orderStatusService.js` (new), `server/services/database.js`, `server/routes/sytist.js`, `client/src/pages/OrderDetailPage.js`, `client/src/pages/OrdersListPage.js`

## Phase 29 — Order detail card consolidation
- Process panel + Ship Status panel merged into a single `ProcessAndShipStatusRow` (two-column inside a shared card)
- Dropped redundant "(id 0)" decoration
- Shipping card became collapsible
- Files: `client/src/pages/OrderDetailPage.js`

## Phase 30 — Full shipping field writeback to Sytist
- Extended Sytist write allow-list from just `order_open_status` to also: `order_shipped_date` (DATE), `order_shipped_track` (varchar), `order_shipped_by` (carrier USPS/UPS/FEDEX via `CARRIER_CODE_MAP`), `order_shipped_by_id` (always 0), `order_ship_cost` (decimal)
- All NOT NULL with zero-defaults
- `buildShippingFieldsForShip(orderId)` derives the values from the existing SS link row
- `buildShippingFieldsForUnship()` returns zero-defaults
- `sytistDbService.updateOrderStatus(orderId, statusId, shippingFields=null)` — third arg opt-in so non-shipping callers don't accidentally clobber shipping state
- `order_status_audit.shipping_fields_json` column records the full snapshot for forensics
- Files: `server/services/orderStatusService.js`, `server/services/sytistDbService.js`, `server/services/database.js`

## Phase 31 — Push packaging during adopt (REVERSED in Phase 33)
- Briefly tried auto-pushing packaging fields when adopting an externally-created SS order
- Reversed in Phase 33 after it conflicted with the upstream tool's payload
- Result: Phase 31 code REMOVED from main; commit retained in history for reference

## Phase 32 — Scheduler auto-syncs SS → Sytist
- `schedulerService` polls ShipStation every 5 minutes
- When an SS order transitions to shipped, the scheduler calls `orderStatusService.shipOrder({ ..., force: true, source: 'shipstation_auto' })`
- Failure to write Sytist rolls back the local link's `ss_order_status` so the next poll retries
- Counters: `sytistSynced`, `sytistFailed`
- Files: `server/services/schedulerService.js`

## Phase 33 — Removed auto-push during adopt; added manual Push Packaging button
- Three changes in one bundle:
  1. Removed the Process popup confirm (per operator request — friction every time)
  2. Reversed Phase 31's auto-push during adopt (let the upstream tool's payload stand)
  3. New manual "Push packaging to ShipStation" button on the Shipping card with extensive `[SS]`-tagged logging
- Endpoint: `POST /api/sytist/orders/:orderId/push-packaging`
- Files: `server/routes/sytist.js`, `client/src/pages/OrderDetailPage.js`, `server/services/shipstationService.js`

## Phase 34 — Green-screen for imposition + packing slip
- Fixed bug: green-screen compositing only worked on the Composite layer; Imposition and Packing Slip got raw transparent subjects (= white on print)
- New Step 1.4 in `processingService.processOrder` runs BEFORE composite + imposition:
  - For each green-screen line item (`flags.greenScreen && backgroundPhoto.fullUrl`)
  - Reads downloaded subject buffer → composites with background → writes `<original>_composed.jpg` to disk → updates `photosByCartId[cartId].path` to point at the composed file
  - Skips items that are already composite-mapped (those handle backgrounds via the composite engine's `playerBackground` slot)
- `packingSlipService.buildSlipBuffer` accepts `composedByCartId` option; uses three-tier strategy on thumbnails:
  1. Pre-composed disk file from Step 1.4 (cheap read)
  2. On-demand compose for preview path (no Step 1.4 has run yet)
  3. Plain `thumbUrl` fetch for non-green-screen items
- Files: `server/services/processingService.js`, `server/services/packingSlipService.js`

## Phase 35 — Reprint workflow
- `processOrder({ reprint: true, lineItemFilter?: [cartId], reason?: string, ... })`:
  - `_nextReprintNumber(order)` scans output dir for existing `_REPRINT*` files and returns next N
  - Suffix `_REPRINT` / `_REPRINT_2` / `_REPRINT_3` appended to all output filenames (photos, composites, slip, .txt, specialty .txt)
  - Skips Sytist `order_open_status` update
  - Skips ShipStation auto-create
  - Skips packing slip generation for single-item reprints
  - Inserts `order_status_audit` row with `source='reprint'`
- New endpoint `POST /api/sytist/process/order/:orderId/reprint-item/:cartId`
- Client UI: Process button auto-detects reprint state (`status === 39 || 40`), changes to orange "Reprint this order" with confirm dialog
- "Reprint this item" button appears on LineItemRow AND ImpositionItemRow when in reprint state
- Files: `server/services/processingService.js`, `server/routes/sytist.js`, `client/src/pages/OrderDetailPage.js`
- Phase 35 hotfix: removed all reprint confirm dialogs; fixed lineItemFilter not being passed through to `_processSubOrder` (was causing slips to generate on single-item reprints)

## Phase 36 — Sytist ms_notes integration
- New methods on `sytistDbService`:
  - `insertNote({ orderId, noteText, who, ip, isManual })` — appends to `ms_notes`
  - `listNotes(orderId, { includeDeleted, limit })` — returns UI-shaped rows
  - `softDeleteNote(noteId, { editedWho })` — sets `note_delete=1` + `note_edited` fields
- Flag conventions discovered from sampled Sytist rows:
  - System events: `note_admin=1, note_is_note=0, note_log=1, note_data=''`
  - Manual operator notes: `note_admin=1, note_is_note=1, note_log=0, note_data=''`
- `note_who` = logged-in user's `display_name` (matches Sytist convention of "Taylor", "Sportsline Office", etc.); falls back to "sytist-dashboard" for scheduler events
- Note bodies prefixed with `[Dashboard]` to distinguish from Sytist-native entries
- 8 wiring points: Process (fresh), Reprint (full), Reprint (item), Mark Shipped (manual), Mark Shipped (scheduler-auto), Mark Back to Printing, Push Packaging, Manual Operator Note
- All writes are non-fatal: a notes failure logs a warning but doesn't undo the underlying action
- 3 new endpoints: `GET /orders/:orderId/notes`, `POST /orders/:orderId/notes`, `DELETE /orders/:orderId/notes/:noteId`
- Auth on DELETE: only the author (matched on display_name) or an admin can delete; system log entries cannot be deleted
- New `OrderActivityCard` on order detail page between customer notes and output paths; auto-refreshes via `sytist:activity-changed` CustomEvent dispatched by action handlers
- Files: `server/services/sytistDbService.js`, `server/services/orderStatusService.js`, `server/services/processingService.js`, `server/routes/sytist.js`, `client/src/pages/OrderDetailPage.js`
- Phase 36 hotfix: removed explicit `'0000-00-00 00:00:00'` literal for `note_edited` from INSERT column list; let MySQL apply schema defaults instead (strict mode was rejecting the literal even though it matches the column default)

## Phase 37 — Photo + background download links on line item card
- Line item card's filename text becomes a download link (uses `<a download>` attribute)
- For green-screen items, the background photo also gets a labeled download link
- Both links open in a new tab with `target="_blank"` so they don't disrupt the operator's place
- Files: `client/src/pages/OrderDetailPage.js`
- Also in Phase 37: full documentation refresh (README, SPEC, OperatorManual, AdminManual) to bring all four files up to current state from their Phase 16 baseline

## Phase 38 — Packaging filter for unknown SKUs
- ShipStation payload builder filters out line items whose SKU isn't in the dashboard's packaging config
- Prevents unrecognized add-ons from contributing weight or appearing as shippable items in SS
- Files: `server/services/shipstationService.js`

## Phase 39 — Dashboard-driven package expansion
- Sytist's `ms_cart.cart_package` flag is unreliable (often 0 even on package parents). The dashboard now ignores that field and uses its own Settings → Packages config as the authoritative source for what's a package
- `sytistDbService.getOrderById` looks up the parent's SKU in `packageContentsMap`; if a config row exists, expands the parent into its configured constituent line items at fetch time
- `cart_photo_bg` and the green-screen flag propagate from parent to each constituent (so a constituent inherits the parent's chosen background)
- Files: `server/services/sytistDbService.js`
- Phase 39 hotfix 1: removed the "package detected by config (cart_package=0)" UI banner since `cart_package=0` is the universal case now

## Phase 40 — Process/Reprint respect saved per-order layout overrides
- **⚠ Correction (Phase 52): the pipeline half of Phase 40 was specified but never delivered.** Only the "Save (no render)" UI shipped. `processingService` never actually called `orderOverrideService` — normal Process silently ignored every saved override (text/color/position/image) for months; overrides only took effect via the editor's Apply paths. **Phase 52 delivers the real wiring** (see Phase 52 entry). Bullets below describe the intended (now Phase-52-delivered) design.
- `processingService` composite loop checks `orderOverrideService.get(orderId, cartId)` BEFORE falling through to the SKU-based composite layout lookup
- When an override exists, that layout is used instead of the mapped layout; `subResult.composites[].layoutSource` is set to `'override'` or `'mapping'` so the operator can see which path was used
- "Save (no render)" button added to `OverrideEditorPage` — stages overrides for the next Process/Reprint without immediately rendering anything
- Files: `server/services/processingService.js`, `client/src/pages/OverrideEditorPage.js` (Phase 40 as-shipped: only the second file's button). Phase 52 adds the real pipeline files.

## Phase 41 — Per-item thumbnails in ShipStation
- ShipStation payload builder adds `imageUrl` field to each line item — V1 API accepts a public URL and shows the image as a thumbnail in the SS order detail UI
- Preference chain: `li.composedImageUrl` → `li.photo.thumbUrl` → `li.photo.largeUrl` → `li.photo.fullUrl` → omit
- `composedImageUrl` is empty at Phase 41 (filled in by Phase 42); Phase 41 establishes the field plumbing
- Files: `server/services/shipstationService.js`

## Phase 42 — Pluggable composed-thumbnail backend (S3 publish)
- New `server/services/composedThumbnailService.js` — pluggable abstraction over backends
- New `server/services/thumbnailBackends/skip.js` (default no-op) and `s3Sytist.js` (AWS S3 publisher)
- `processOrder` Step 1.4 (green-screen compose) resizes the composed buffer to 500px max with `sharp`, calls `composedThumbnailService.publish(orderId, cartId, buffer)`, mutates `li.composedImageUrl` with the returned public URL
- Shipstation builder prefers `li.composedImageUrl` over `thumbUrl` (so SS shows the composed image with background, not the keyed-out subject)
- `schedulerService` originally called cleanup() after a successful Sytist sync (later removed in Phase 44 hotfix 2)
- New `aws_s3` section in `appSettings.js`: 7 fields covering region, bucket, public URL base, prefix, access key, secret key, ACL enabled
- `ApiKeysPage` adds `aws_s3` to its `sectionOrder` and `sectionTitles`
- `@aws-sdk/client-s3` added to `server/package.json`
- Files: `server/services/composedThumbnailService.js` (new), `server/services/thumbnailBackends/skip.js` (new), `server/services/thumbnailBackends/s3Sytist.js` (new), `server/services/processingService.js`, `server/services/shipstationService.js`, `server/services/schedulerService.js`, `server/config/appSettings.js`, `client/src/pages/settings/ApiKeysPage.js`, `server/package.json`
- Phase 42 hotfix 1: extra diagnostic logging in processingService and sytistDbService — per-cart green-screen state (`greenScreen=`, `backgroundPhoto=`, `bgFullUrl=`, `shouldComposite=`) so it's clear in the log why publish ran or didn't

## Phase 43 — SQLite cache for composed URLs + Push Packaging resilience
- New `server/services/composedThumbnailCacheService.js` — SQLite-backed `composed_thumbnails` table keyed by `(order_id, cart_id)`, stores published URL + backend name + timestamps
- `processOrder` Step 1.4 also caches the published URL alongside the `li.composedImageUrl` mutation, so downstream code can hydrate later without re-running compose
- Push Packaging route (`POST /api/sytist/orders/:orderId/push-packaging`):
  - Reads cache and hydrates `li.composedImageUrl` onto each line item before building the SS payload
  - Pre-check via `listOrders` (by orderNumber) to detect if SS still has the order
  - On `404` with empty body from createOrder, returns a structured `409 orderkey_tombstone_suspected` error code with a `suggestedSuffix` so the UI can prompt
- `orderDate` field in SS payload converted to ISO 8601 (was sometimes failing with raw MySQL `"YYYY-MM-DD HH:MM:SS"` format)
- `schedulerService` initially also called `composedThumbnailCacheService.deleteByOrder(orderId)` after sync to shipped (later removed in Phase 44 hotfix 2)
- Files: `server/services/composedThumbnailCacheService.js` (new), `server/services/processingService.js`, `server/services/shipstationService.js`, `server/services/schedulerService.js`, `server/routes/sytist.js`
- Phase 43 hotfix 1: package constituents should NOT inherit `download` flag from parent. The expansion code was setting each constituent's `flags.download` based on the parent's flag; now it's determined solely by the constituent's own SKU (file: `server/services/sytistDbService.js`)
- Phase 43 hotfix 2: same retry-on-404 logic added to the `POST /api/shipstation/orders/:orderId/create` route (the "Send to ShipStation" button on the order detail page). Enhanced `shipstationService.createOrder` logging: response headers, byte length, payload sample. `api.js` attaches full response data as `err.data` on thrown errors. UI shows confirmation popup before retry: "ShipStation rejected this order, likely because orderNumber X was previously deleted in ShipStation. Retry with modified orderNumber X-r{timestamp}?"
- Phase 43 hotfix 3: hotfix 2's `shipstationService.js` was built off a stale uploaded version that pre-dated Phase 41/42/43 changes; restoring imageUrl + composedImageUrl preference + orderDate ISO conversion alongside the new 404 logging (file: `server/services/shipstationService.js`)

## Phase 44 — Composite thumbnails on packing slip, ShipStation, and dashboard UI
- Composite engine output (Memory Mate, Photo Button, etc. — products with a composite mapping) is now also published to the configured thumbnail backend
- `processOrder` builds `compositePathsByCartId` from `subResult.composites` and passes to `packingSlipService.buildSlipBuffer`. New Tier 0 in the slip's thumbnail resolver: composite engine output > pre-composed green-screen file > on-demand compose > plain thumbUrl
- `OrderDetailPage`'s `LineItemsBlock` fetches the per-cart URL map from a new endpoint and threads it down to each `LineItemRow`. When a composite URL exists for a line item, the card shows that single image (replaces the previous bg + transparent player stack)
- New endpoint `GET /api/sytist/orders/:orderId/composed-thumbnails` — returns `{ ok: true, thumbnails: { [cart_id]: public_url } }` from the cache. Non-fatal — returns empty map on cache read failures
- Files: `server/services/processingService.js`, `server/services/packingSlipService.js`, `server/routes/sytist.js`, `client/src/pages/OrderDetailPage.js`
- Phase 44 hotfix 1: the three slip preview routes (`GET /slip/preview/:id`, `POST /slip/preview/:id/save`, `GET /slip/preview/:id/info`) don't have access to local composite paths. New helper `_loadCompositeUrlsForOrder(orderId)` reads the SQLite cache and passes URLs via a new `compositeUrlsByCartId` option. Slip's Tier 0 split into 0a (path, fastest) and 0b (URL fetch, for route handlers)
- Phase 44 hotfix 2: removed both `composedThumbnailService.cleanup` and `composedThumbnailCacheService.deleteByOrder` calls from `schedulerService`. Auto-cleanup was racing against operator visibility — orders detected as shipped within the same poll cycle as creation were getting their cache rows wiped before the operator could view the order detail or slip preview. Cache rows + S3 objects now persist indefinitely; trivial storage cost (file: `server/services/schedulerService.js`)

## Phase 45 — ShipStation eligibility honors packaging-config category=digital
- Real order 111042 was sent to SS with only a drop-shipped specialty (SKU 14) and a digital-package SKU (5D). Sytist sets `cart_download = 0` on digital-package SKUs (3D, 5D, 20D, plus three long-string CHEER/digital variants), so the existing `flags.download` filter missed them — they fell through into `shippable` and SS create proceeded. Class of bug, ~256 orders in the data window had this shape; 1 currently has a leftover `shipstation_links` row (left as-is, mirrors Phase 44 hotfix 2's no-auto-clean principle)
- Part A — config: added 6 digital SKU entries to `packaging-config.json` (`3D`, `5D`, `20D`, `5 DIGITALS - CHEER`, `5 DIGITALS`, `10 HIGH RESOLUTION DIGITAL IMAGES CHEER`), all `category: 'digital'`. Removed `packaging-config.json` from `.gitignore` so the canonical digital classification travels with the code
- Part B — code: new `packagingService.isDigital(sku)` mirrors `specialtyService.isDropShipped(sku)`, case-tolerant lookup (tries uppercased then raw). Wired into all three filter sites: `shipstationService.buildOrderFromSytist`, `shipstationService.previewPackagingForOrder`, `routes/shipstation.js _computeEligibility`. New check sits between SKIP_FLAGS and the shippable push, after the drop-ship check
- Verification: real order 111260 (mixed `[3D, 25, 25, 25, 9]`, ship_to_home) processed cleanly — payload contained only SKU 9; synthetic `[14, 5D]` returned `__skipShipStation: true, message: "... 1 dropShipped, 1 digital"`
- Files: `.gitignore`, `server/config/packaging-config.json`, `server/services/packagingService.js`, `server/services/shipstationService.js`, `server/routes/shipstation.js`

## Phase 46 — Order-detail composite affordances on each line item
- Composite-layout fixes (team photo missing, wrong text, wrong image in a slot) previously required Settings → Order Overrides → 4+ click navigation. The override editor was capable enough; it just wasn't reachable in-the-moment. Phase 46 surfaces it on each line item card so operators spot and fix issues BEFORE printing instead of reprinting after
- `LineItemRow` gets three new affordances when the SKU has a composite mapping: outlined "✏ Composite" chip in the flag-chip strip (distinct from solid flag chips so it reads as an action target, not a status), "✏ Edit layout" button → `navigate('/overrides/:orderId/:cartId')`, and "Preview" button that lazy-fires `POST /api/sytist/composite/preview` (existing endpoint, no server change) and expands an inline JPEG + diagnostics (variant, output dims, team photo found/missing with reason, logo found/missing, render bytes)
- Preview button has a proper loading state (`⟳ Rendering…`, disabled, wait cursor) since composite renders take a few seconds. Inline preview layout is side-by-side at ≥768px, stacks vertically below that via `window.matchMedia`
- `LineItemsBlock` hoists the `/composite/mappings` fetch once per order page into a `Map<String(SKU), mapping>` threaded down to each row — one round-trip regardless of how many composite-mapped items appear. Empty/failed fetch leaves no chips/buttons; page still renders
- Bottom-of-page `CompositeBlock` + `CompositeItemRow` removed wholesale (~290 lines). Two paths to the same thing was UI debt; per-line-item affordances strictly dominate. `DetailLine` helper preserved — new inline preview reuses it
- Net diff: +269 / −292 in one file (`client/src/pages/OrderDetailPage.js`). No server change
- Files: `client/src/pages/OrderDetailPage.js`

## Phase 47 — Override editor wired into the operator-fix loop
- Phase 46 made the override editor reachable from each line item. Phase 47 closes the workflow: edit → return to order page → updated thumbnail visible (Apply paths) OR clear staleness indicator visible (Save no-render path). Plus a "Process to generate" badge for composite-mapped items that haven't been processed yet, addressing the operator confusion that triggered Phase 47 to begin with
- 47a: Apply Overwrite + Apply Reprint navigate to `/orders/<orderId>` immediately on success. No setTimeout. Save (no render) intentionally stays on the editor so batch-staging across multiple cart fixes doesn't force round-trips
- 47b: `routes/sytist.js renderOverrideForOrder` now publishes the rendered composite to the configured thumbnail backend + upserts `composed_thumbnails`. Mirrors `processingService.js`'s composite engine publish shape. Non-fatal failures surface as render warnings. Closes the gap where Apply Overwrite wrote the file to disk but the order detail thumbnail stayed at the last Process-time state
- 47c: `/composed-thumbnails` endpoint returns a `stale: [cart_id, ...]` array. Cart ids are stale when `order_overrides.updated_at > composed_thumbnails.updated_at`. Order detail's `LineItemRow` renders a top-right amber ⚠ Layout edited overlay when stale. `composedThumbnailCacheService.listByOrder` extended to include `created_at`/`updated_at` (additive, doesn't break existing consumers)
- 47d: bottom-right dark "🔄 Process to generate" badge on tiles where `hasComposite && !flags.isPackageHeader && !composedThumbnailUrl`. The two overlays are mutually exclusive — "Process to generate" only when no cache row; "Layout edited" only when a stale one exists
- 47e: Save (no render) success banner rephrased to explicitly mention the ⚠ Layout edited indicator on the order detail page and the three ways to clear it (Apply Overwrite, Apply Reprint, or Process)
- Files: `client/src/pages/OrderDetailPage.js`, `client/src/pages/settings/OverrideEditorPage.js`, `server/routes/sytist.js`, `server/services/composedThumbnailCacheService.js`
- Phase 47 hotfix 2: tightened the 47d badge condition to also suppress when the order is already in Printing (40) or Shipped (39). The original `hasComposite && !flags.isPackageHeader && !composedThumbnailUrl` test misfired on orders processed outside our dashboard — those have status=40 but no cache row, so the badge would imply "not processed yet" when Sytist already showed otherwise. Reuses the existing `isReprintMode` variable (already computed for the per-item Reprint button in Phase 35) since the semantics match. One-line condition change. **Companion diagnostic finding**: while investigating a 100% cache-miss rate that looked like a Phase 47 publish regression, ms_notes comparison revealed the cache misses are correct — 546 of 555 recently-processed composite-mapped orders went through an upstream tool (`note_who: "Kirsten"`) rather than our dashboard's processOrder. This identifies the long-standing "Sportsline UI" follow-up (formerly unknown root cause). Phase 33's "adopt without push" already handles the coexistence; no code work needed beyond the badge tightening. Files: `client/src/pages/OrderDetailPage.js`, `CLAUDE.md`, `docs/SPEC.md`

## Phase 48 — Text content editing in the override editor
- Phase 47 wired position/size override edits into the operator-fix loop; text content stayed un-editable (operators had to fix typos in Sytist or rewrite the underlying layout). Phase 48 closes that gap with a Text content textarea in QuickEditPanel, leveraging the existing override snapshot mechanism — slot text templates are already part of the snapshot blob, so editing `slot.text` in place and POSTing the whole snapshot to the existing override endpoint is the entire mechanism. Zero server changes
- Textarea displays the **resolved value** by default (slot.text run through real-data tokens from `order.subject.fields`, `order.customer`, gallery). What the operator sees is what the composite will render. Edits become literal `slot.text` on save. If the operator types a `{token}` explicitly, the server's render-time `_substituteTokens` still substitutes it — token pass-through is free because the render path is content-agnostic
- Display rule uses a `{`-presence heuristic, not the baseLayout comparison: when `slot.text` contains a token marker, show resolved; otherwise show literal. Independent of `baseLayout` so the textarea behaves sensibly when the base layout is missing
- Two custom-text indicators so the override-vs-token state is visible without selecting each slot: (a) QuickEditPanel shows an amber italic "Custom text (overrides token) — won't follow Sytist data" line below the textarea, with the original base text in the tooltip; (b) LayersList shows italic styling on the text snippet + a small amber `·custom` suffix. "Custom" = `slot.text !== baseSlot.text`. When unchanged-but-tokenized, a muted "Pulls from: `{token}`" info hint shows instead
- Side-effect bug fix: pre-Phase 48 `sampleTokens` construction at `OverrideEditorPage.js` L595 used flat dotted keys (`'subject.athleteName': lineItem.productName`) that `substituteTokens` never reads (it walks `ctx.subject.athleteName` against nested objects). Worse, `lineItem.productName` is the product name, not the player name. The flat-key override was dead code AND wrong-field. Phase 48 replaces it with `buildTokensFromOrder(order, lineItem)`, a client-side mirror of the server's `compositeService.buildTokensFromOrder` — same nested shape, same `camelCaseKey` logic, same `order.subject.fields[]` provenance. Canvas preview now shows real player names; textarea's default resolves to the same value
- Server-side `compositeService.buildTokensFromOrder` is now mirrored on the client; if either evolves the other diverges silently. Mitigation: header comment in the client helper noting the dependency. Worth tightening if the function changes meaningfully
- Files: `client/src/pages/settings/OverrideEditorPage.js`, `client/src/components/LayoutCanvas.js` (export `substituteTokens`)

## Phase 48a — Text color editing + conditional Save auto-return
- Two enhancements bundled after Phase 48 verification surfaced operator workflow gaps. Both confined to the override editor + one entry-point line on the order detail page; no server change
- **Text color editor**: native `<input type="color">` in QuickEditPanel for text slots, value bound to `slot.color` (existing property since Phase 9b, already read by `compositeService._textSvg` as the SVG `fill` attribute). 7-char hex format matches both the layout JSON and what the native picker emits — no conversion. Other text style properties (font family, weight, alignment) stay locked at layout level per Phase 47 scoping; color is the exception because per-order recoloring for readability against specific player photos is a real workflow
- **Custom color indicator**: amber italic "Custom color (was #xxxxxx)" line under the picker when `slot.color !== baseSlot.color`. Comparison treats missing color as renderer's `#000000` default so a slot explicitly setting that default doesn't false-fire
- **Generalized `·custom` badge**: Phase 48's text-only LayersList badge is now any-override via new `getCustomFields(slot, baseSlot)` helper. Geometry (x/y/w/h/fontSize) intentionally excluded — those are layout nudges, not content overrides. Badge meaning shifts from "token-disconnect risk" to "this slot has been hand-edited"; broader but more useful for layer-list scanning. Tooltip enumerates which fields differ. Future override capabilities (image upload, etc.) extend the same helper without further code changes
- **Conditional Save (no render) auto-return**: Phase 47a made Apply paths auto-navigate to `/orders/<orderId>` on success; Save (no render) intentionally stayed on editor for multi-item batch staging. Phase 48a adds conditional: when operator arrives via `?from=order` (set by OrderDetailPage's "Edit layout" button only), Save auto-returns to the order page. Other entry points (Settings → Order Overrides search, internal OrderSwitcher) omit the param and keep stay-on-editor behavior
- Query param over `location.state` so the signal survives hard refresh — operator who Ctrl+Shift+R's mid-edit doesn't silently lose the auto-return context. Manual URL strip degrades to "stays on editor," which is benign
- Files: `client/src/pages/OrderDetailPage.js` (one-line append `?from=order`), `client/src/pages/settings/OverrideEditorPage.js`

## Phase 49 v2 — Photo thumbnail proxy with disk cache (no auth, hardened SSRF)
- Line item card tiles were downloading 6–10 MB original photos to render 150-px thumbnails (Phase 12a's "prefer un-watermarked fullUrl" decision, unmeasured bandwidth cost at the time). 30-item orders took "up to a minute" to load all tiles. Phase 49 v2 adds a server-side resize proxy that fetches the source, resizes via sharp to 400-px max edge, caches to disk, and serves ~50 KB JPEGs
- **No auth on the proxy route.** Phase 49 v1 (reverted at `9db1e15`) shipped with `requireAuth` and got 401s on every `<img src>` — CRA dev-proxy + SameSite cookie semantics broke same-origin subresource auth. v2 drops auth, relies on hardened SSRF validation as the only line of defense. Acceptable because the server is localhost-only today; documented in both the inline route comment and CLAUDE.md → Cross-platform notes that if the dashboard ever goes public-facing, signed URLs must replace the no-auth pattern before deploy
- **Hardened SSRF validation** in `photoThumbService._isValidSource`: URL parsing (not regex), exact-host allowlist (env-configurable via `PHOTO_PROXY_ALLOWED_HOSTS`, default `s3.dualstack.us-east-1.amazonaws.com`), HTTPS only, no embedded credentials, no query string, no fragment, safe extension only, no path traversal. Plus `redirect: 'error'` on the fetch itself so S3 can't redirect us to a host outside the allowlist
- **Fetch timeout: 20 seconds** (v1 was 60 s). One pathological 230 s case observed during diagnosis was an outlier; 20 s captures realistic slow paths (5–15 s S3 spikes) without holding Express workers indefinitely. Placeholder `Cache-Control: max-age=60` so a refresh ~1 min after a timeout typically populates the cache
- **Scope: single client tile swap** in `LineItemRow` fallback path. `<a href>` click-through keeps `fullUrl` for full-quality opens. OverrideEditor switcher stays unchanged (out of scope; rarely visited). `LayoutCanvas` keeps `fullUrl` (editor needs hi-res). Phase 37 download links keep `fullUrl`
- **Cache**: disk-backed at `server/config/photo-cache/`, sha1 filenames, mtime touched on hit, placeholder pre-generated at init. Daily TTL sweep (60-day default, 30 s hard time cap) piggybacked on the existing SS-poll scheduler tick — no second timer needed
- **Headers**: `Cache-Control: public, max-age=86400, immutable` on success (content keyed by sha1 of src+width is effectively immutable), `max-age=60` on placeholder. `X-Photo-Thumb-Status: cache-hit|fresh|placeholder` for forensics
- Node 22 fetch quirk worked around: `AbortSignal` passed to fetch causes `arrayBuffer()` to hang after headers arrive (verified empirically). Service uses `Promise.race` with a separate timeout promise instead
- Files: `.gitignore`, `server/services/photoThumbService.js` (new), `server/routes/sytist.js`, `server/services/schedulerService.js`, `client/src/pages/OrderDetailPage.js`
- Phase 49 v2.1 (alpha preservation hotfix): Phase 49 v2 used `sharp().jpeg()` unconditionally. JPEG has no alpha channel, so green-screen items' transparent player PNGs were flattened against black on output — the resulting opaque JPEG covered the background photo `<img>` underneath, displaying as a black rectangle. Reported within hours of v2 deploy. Fix: output format inferred from source URL extension — `.png` → WebP (preserves alpha), everything else → JPEG (smaller for opaque). Cache filename uses inferred extension (`<sha1>.webp` or `<sha1>.jpg`) so cache lookup stays a single deterministic readFile; old `.jpg` entries for PNG sources orphan automatically. Sweep updated to handle both extensions. Route's `Content-Type` follows the format the service chose. Placeholder remains JPEG. Verified pre-commit: synthetic transparent PNG roundtrips through the pipeline with `hasAlpha: true` preserved. **Deploy step**: run `del /Q server\config\photo-cache\*.jpg` to clear stale `.jpg` cache entries that were holding black-background output (placeholder regenerates automatically). Files: `server/services/photoThumbService.js`, `server/routes/sytist.js`
- Phase 49 v2.2 (metadata-based format detection): v2.1's URL-extension inference was unreliable — Sytist serves transparent green-screen subject photos at URLs that don't consistently end in `.png`, so v2.1's check fell through to JPEG and the alpha was killed again. v2.2 switches to ground-truth detection: after fetching the source, probe `sharp(buf).metadata().hasAlpha` and choose output format from that. `_inferOutputFormat` removed (dead code). Cache lookup can no longer predict the extension, so it tries both `<key>.webp` and `<key>.jpg`; same URL always produces same hash so at most one exists in steady state. Two ENOENT readFiles on miss is fine. `_cachePath` renamed to `_cacheKey` and now returns just the hash string. `X-Photo-Thumb-Status` extended to include the format as suffix (`fresh:webp`, `cache-hit:jpeg`, `placeholder:jpeg`, etc.) so future regressions are diagnosable from response headers alone. Sweep already handled both extensions — no change. **Deploy step**: `del /Q server\config\photo-cache\*.jpg server\config\photo-cache\*.webp` to clear both formats and let everything regenerate from the metadata-based path. Files: `server/services/photoThumbService.js`, `server/routes/sytist.js`
- Phase 49 v2.3 (cache header fix + request-entry log): v2.2 server-side correctness verified by direct probe (cache-hit:webp + hasAlpha:true) but operators still saw black backgrounds in their main browser while incognito worked. Root cause: v2/v2.1/v2.2 sent `Cache-Control: public, max-age=86400, immutable`. `immutable` tells browsers "never revalidate" — once a browser cached the v2-era broken JPEG, it refused to ask the server again for up to 24h, including on hard refresh. Incognito worked because no shared cache. Fix: drop `immutable`, switch to `public, max-age=3600, stale-while-revalidate=86400` — browser still serves cached bytes instantly for the full 24h, but fires an invisible background revalidate after the 1h fresh window, so server-side fixes propagate silently to operators without cache-clearing rituals. Also added per-request log `[PhotoThumb] GET <src> → <status>:<format> (<bytes>)` because v2 / v2.1 / v2.2 only logged on errors and "is the proxy being called?" was undecidable from logs alone (it's what trapped this exact bug for hours). One-time operator action: clear browser cache (Ctrl+Shift+Delete → cached images and files) to evict the stale `immutable` entries; new responses use the new directive. Files: `server/routes/sytist.js`

## Phase 51 — Settings cross-reference notes for the two output-path configs
- Italic cross-reference note added to Settings → Paths ("specialty output configured separately, see Settings → Specialty → Base path") and the reverse on Settings → Specialty. The two output roots (`path-overrides.json` `downloadBase` vs `specialty-products.json` `basePath`) are independent operator knobs in separate Settings pages with no cascade; an operator changing one doesn't realize the other exists. Discoverability fix for the order 111297 data-loss false alarm (files were at the deliberately-separate specialty root, not lost). CLAUDE.md "Output path configuration" section added describing the mechanism (not specific drive values)
- Files: `client/src/pages/settings/PathsSettings.js`, `client/src/pages/settings/SpecialtySettings.js`, `CLAUDE.md`

## Phase 50 — Operator-uploaded image override (Apply-path; Process in Phase 52)
- Per-(orderId, cartId, slotIndex) image upload in the override editor, so operators can replace a slot's photo directly instead of renaming in Sytist or editing the base layout. New `orderAssetOverrideService`: disk store at `server/config/order-asset-overrides/` (gitignored), magic-byte sniff (PNG/JPEG/WebP; SVG + everything else rejected), 10 MB cap, atomic `.tmp`+rename, integer-only IDs + `path.resolve`/`startsWith` path safety, `deleteCartAssets` wired into override DELETE
- **Defect A (caught in browser verification, fixed before commit)**: first cut registered the GET image route after `router.use(requireAuth)` → every `<img src>` preview 401'd (CRA dev-proxy can't carry the session cookie — same failure class as Phase 49 v1). Fix: GET registered *before* the global auth middleware and auth-free, mirroring the photo-thumb placement; threat model differs (local files, no SSRF surface) so the no-auth posture is consistent and documented inline. POST/DELETE stay auth-gated (go through `api.*` with credentials)
- **Scope**: applies via the editor's Apply (Overwrite/Reprint) path only. Normal Process does NOT honor it — pre-existing gap affecting all override types (text/color/position/image), contradicts the Phase 40 docs. Phase 52 delivers Process-honors-overrides uniformly. Documented honestly in SPEC §50
- Client: `QuickEditPanel` drag-drop + file input + "Custom image" indicator + Remove; `getCustomFields` gains `'image'` so the `·custom` badge covers it; `LayoutCanvas` previews `slot.overrideImage.url`
- Follow-up logged: storage sweep for `order-asset-overrides/` on shipped orders (manual cleanup acceptable until then)
- Files: `server/services/orderAssetOverrideService.js` (new), `server/routes/sytist.js`, `client/src/pages/settings/OverrideEditorPage.js`, `client/src/components/LayoutCanvas.js`, `.gitignore`
- Phase 50 hotfix (stale thumbnail after Apply Overwrite): browser-verification found the order-detail line item thumbnail kept showing the pre-override composite after Apply Overwrite, even though the server re-rendered correctly and S3 had the override-correct image (confirmed: incognito showed it right). Root cause was the **Phase 49 v2.3 cache lesson recurring**: the composed-thumbnail S3 object is a stable key (`sytist-dashboard-composed/<orderId>/<cartId>.jpg`) whose bytes are replaced on every re-render, but the order-detail `<img src>` had no version query, so the browser served the cached old composite for the unchanged URL. Phase 47c's "Layout edited" staleness badge *cleared* correctly (cache newer than override), masking it — system believed fresh while browser showed stale. Fix: `/orders/:orderId/composed-thumbnails` appends `?v=<updated_at-epoch>` to each URL — endpoint-only so all browser consumers get it from one source of truth (no OrderDetailPage change) while server-side consumers (ShipStation payload, packing slip) keep the bare URL. Override editor switcher checked, not affected (it uses raw Sytist photo URLs, not the stable composed S3 key). Files: `server/routes/sytist.js`

## Phase 52 — Process honors saved overrides (delivers what Phase 40 promised)
- Phase 40 specified that normal Process/Reprint would render saved per-order overrides; only the "Save (no render)" UI shipped — `processingService` never called `orderOverrideService`, so **Process silently ignored every override (text/color/position/image) for months**. Overrides only worked via the editor's Apply (Overwrite/Reprint). Surfaced during Phase 50 image-override verification. Phase 52 wires it for real
- New `overrideRenderService` — the shared policy layer both Process and Apply call so they can't drift again: `resolveLayoutAndVariant()` (explicit > usable override snapshot wholesale > SKU mapping; returns layout:null for caller to decide fatality; no DB access — caller passes the override in) and `applyImageOverrides()` (verbatim lift of the Phase 50 inline image loop; missing-on-disk → default + warning, never fails)
- `processingService`: one batched `orderOverrideService.listByOrderWithSnapshots(orderId)` per order → `Map<cartId, override>` (new method; `listByOrder` is deliberately light, no snapshot). Composite loop uses the helper for layout+variant and applies image overrides before `buildSheetBuffer`. `findMapping` still gates the loop and still drives chainToImposition/specialty/green-screen unchanged. Batch-read failure is non-fatal (SKU-mapped fallback = pre-Phase-52 behavior)
- **Variant-bug fix bundled (deliberate, see SPEC §52):** `renderOverrideForOrder` previously recomputed the variant via `pickVariant` and ignored `override.variant` — an override saved against `vertical` rendered against the empty `horizontal` when the player photo was landscape, silently dropping all edits incl. the Phase 50 image override. The shared `resolveLayoutAndVariant` now honors `override.variant` (fallback + warning if absent/empty). This changes a previously-shipped path's behavior, so Apply (Overwrite/Reprint) was re-verified alongside Process
- Degradation: unusable snapshot → SKU-mapped + warning; missing/empty override.variant → pickVariant + warning; missing override image file → default buffer for that slot + warning. An override can degrade an item to default output, never abort the order
- Phase 40 SPEC/CHANGELOG/AdminManual entries corrected (reconciled, not erased — the design text was right, only undelivered); CLAUDE.md gains a verification-lesson line
- Files: `server/services/overrideRenderService.js` (new), `server/services/processingService.js`, `server/services/orderOverrideService.js`, `server/routes/sytist.js`
- Phase 52 fix (orderId/cartId coercion): canonical order shape hands out `orderId` as a String (`sytistDbService: String(o.order_id)`); `orderAssetOverrideService` gates every read on `Number.isInteger()` as a path-escape guard and silently returns null for non-integers, so Process skipped every *image* override (text/color/position live in the snapshot and never hit that gate, so they worked — which is why verification #3 alone failed). Coerced `Number(orderId)`/`Number(cartId)` at the `applyImageOverrides` shared boundary rather than loosening the security gate; synthetic addon/pkg cartIds → NaN → null → default fallback (correct — `saveAsset` gates identically so they could never have a stored asset). File: `server/services/overrideRenderService.js`
- **Verification (browser, real Process/Reprint run, order 111118 cart 483792):** logs show `[Processing] … using SAVED OVERRIDE layout (variant=vertical)` then `[OrderAsset] applied override order=111118 cart=483792 slot=2 kind=teamPhoto bytes=5132331` with a numeric order id, S3 thumbnail re-published. #1 text / #2 color / #4 position / #5 no-override regression / #6 mixed order confirmed via Process earlier; #3 image-via-Process confirmed by this run; #8 Apply (Overwrite/Reprint) confirmed not regressed by the refactor (editor Apply re-verified). #7 (deleted override-image file → graceful default fallback) covered by the offline smoke suite (24/24) only, not a browser run — low-risk defensive path

## Phase 54 — Orders-list selection fix + shift-range + order-detail quick lookup
- **1a (bug):** orders-list row checkbox did nothing on direct click — `onChange` was a no-op delegating to the `<td onClick>`, but the input also `stopPropagation`'d, severing the delegation; only the thin td padding toggled (header "select all" worked because it's a normal controlled checkbox — hence "can check the top one, not individual rows"). Fixed: row input is now a proper controlled checkbox; td still stops click propagation so it never triggers row open-order nav
- **1b (new):** shift+click range select (was unimplemented). `toggleOrderSelected(orderId, index, shiftKey)`; plain toggle sets a row anchor, shift+toggle adds the inclusive anchor..clicked range (file-explorer model). Anchor cleared on filter change + guarded against stale/out-of-range index
- **2 (enhancement):** "Go to order #" form added to `NavStrip` so operators can jump to any order from any order-detail page without returning to the list. Reuses the not-found view's `navigate('/orders/<id>')`; deliberately a fresh lookup (no inherited filter params — explicit order # is a context switch, not in-set movement)
- No server changes. Files: `client/src/pages/OrdersListPage.js`, `client/src/pages/OrderDetailPage.js`

## Phase 55 — Specialty subfolder filesystem-safety + visible download failures
- Root cause of order 110924's "missing Wall Cling": SKU 29's specialty `subfolder` is `12" Wall Cling`; `"` is illegal in Windows paths → mkdir/download threw `EINVAL`, the item soft-failed into `photosFailed` with **no server log line** (CLAUDE.md "easy to miss" specialty landmine). Not a reprint bug — would fail identically on first Process
- New `specialtyService.sanitizePathSegment()` (reserved `<>:"/\|?*` + control chars → space, collapse, trim, strip leading/trailing dots+spaces; empty → caller falls back to SKU), applied in `getSpecialtySubfolder` (single use-point). Stored config stays raw — only the directory segment is sanitized. Clean subfolders unchanged; SKU 29 → `…\Specialty\12 Wall Cling`
- Empty mkdir `catch {}` → `console.warn`; `photosFailed` download failures now `console.warn` flagging `(SPECIALTY)` — this whole class is no longer invisible in logs
- 11/11 offline unit cases pass. Files: `server/services/specialtyService.js`, `server/services/processingService.js`

## Phase 56 — Synthetic-cart-ID override keying + Apply→imposition parity
- Root-caused from order 110969 (ship_to_league, siblings, Bronze Package constituents): package/addon overrides not applying; the sibling/league per-team split was confirmed by-design, not a bug. Four pre-existing bugs fixed:
- **Bug 1 (56a + addendum):** every override/asset/imposition-preview route `parseInt(req.params.cartId)` — synthetic IDs (`483036-pkg-27`, `…-addon-…`) truncated to the parent int, collapsing constituents onto one key. cartId is now an opaque string end-to-end: routes `String(req.params.cartId)`; `orderOverrideService` binds `cart_id` String (SQLite affinity — no migration; pre-56 collided rows are unmigratable orphans); `orderAssetOverrideService` `isSafeCartId` replaces the integer gate; `overrideRenderService` dropped its now-re-truncating `Number(cartId)`. Zero cartId numeric-coercion left in `server/`. orderId stays integer
- **Bug 2 (56b core):** `renderOverrideForOrder` never imposed — Apply produced the bare composite for chainToImposition SKUs instead of the imposed sheet the lab prints
- **Bug 3:** Apply Reprint hardcoded `_REPRINT` → 2nd Apply Reprint silently overwrote the 1st (Process used `_nextReprintNumber`)
- **Bug 4:** Apply wrote the order ROOT, not the folder-sort subdir → for folder-sorted orders Apply Overwrite/Reprint + DELETE-restore never overwrote the file the .txt/lab print (even non-imposed items)
- Fix: new shared `printOutputService` (resolveOutputDir / nextReprintNumber / reprintSuffix / buildOutputFilename / produceFinalOutput) used by both Apply and Process so they can't drift (Phase 52 `overrideRenderService` precedent). Narrow extraction (decision B): Process loop + its own Step 2 imposition untouched, only naming/dir/N delegate; `renderOverrideForOrder` rewired onto `produceFinalOutput`; `forcedOutputFilename` removed; orphaned `folderSortService` require dropped
- Parity-plus-warning: chainToImposition with no rule → bare composite (Process behavior unchanged) + `imposition_rule_missing` warning, returned AND `console.warn`'d
- **Operator action:** package/addon overrides created before Phase 56 are inert orphans (unmigratable) — re-create them in the editor. Apply output now lands in the folder-sort subdir (was order root for folder-sorted orders)
- 19/19 + regression offline assertions (incl. the reprint-collision case). Files: `server/services/printOutputService.js` (new), `orderOverrideService.js`, `orderAssetOverrideService.js`, `overrideRenderService.js`, `processingService.js`, `server/routes/sytist.js`

## Phase 57A — Composite-layout variant split: foundation (schema migration + render fallback + verification)
- Goal: vertical/horizontal become fully independent designs (own canvas/dpi/background/graphics/slots), not shared-root variants. Option Y (copy props into variants; root retained as deprecated fallback) chosen over Option X (first-class split layouts) — Y leaves the Phase 52/56 override-snapshot contract untouched and keeps existing layouts/overrides byte-identical until intentionally diverged
- `compositeService.buildSheetBuffer`: `dpi`/`sheetWidth`/`sheetHeight`/`backgroundColor` resolve `variantDef.X` → deprecated `layout.X` root → original default; fallback operators preserved so un-diverged variants render byte-identical to pre-57. Graphics-map read deferred to 57B (it lives outside compositeService on the Phase-56 render path)
- New `scripts/migrate-layout-variant-copydown.js`: pure transform + CLI (`--dry-run`/`--check`); copies the 5 root keys into each ≥1-slot variant only if not already owned; non-destructive, idempotent, atomic (tmp+rename), never fabricates an empty/absent variant (preserves pickVariant vertical-only fallback)
- New `scripts/verify-layout-variant-copydown.js` (ship gate): 13/13 populated (layout,variant) render cases byte-identical pre vs post + structural invariants + per-layout & doc-level double-run idempotency; exit-coded. 13 = 10 vertical-only + 3 both-variant×2; empty/absent variants aren't renderable by design and are structurally asserted untouched — no scope reduction (an earlier "16" was an arithmetic slip in scoping prose)
- Invisible to operators. Live migration is a separate operator step run right after push so the soak exercises the migrated path. Phase 57B (planned): designer write-target flip + copy-on-write UX + own/inherit badges + banner with both counts + graphics-read switch + operator docs
- Files: `server/services/compositeService.js`, `server/scripts/migrate-layout-variant-copydown.js` (new), `server/scripts/verify-layout-variant-copydown.js` (new)

## Phase 57B — Composite-layout variant split: designer + per-variant graphics
- **Steps 1+2 (designer meta-editor + canvas, commit `6bddf62`):** `LayoutMetaEditor` writes canvas/dpi/background to the ACTIVE variant (copy-on-write — editing an inheriting field promotes it to own; "Use shared default" reverts), ● Own / Inherited badges, banner with both inherit + own counts; `name` stays root. `LayoutCanvas` + `LayoutDesignerPage` resolve canvas/dpi/bg variant-first/root-fallback at every editing-surface site (aspect, drag-clamp, zoom-fit, bg fill, dim label, new-slot placement, LayersPanel slot-bound hints) — the editor re-orients to the active variant (e.g. Magnet Horizontal 5×3.5 vs Vertical 3.5×5)
- **Step 3 server (commit `c3690c7`):** graphics are per-variant. POST/DELETE `/composite/layouts/:id/graphics/:key` require explicit `variant` in the body and a key namespaced `${variant}__<name>` (validated); write `variants[variant].graphics` (copy-on-write — create variant if absent, preserve slots + other variants), NEVER write the deprecated root map. GET list takes `?variant=` (variant-scoped + `legacyShared` root group; no-variant keeps pre-57B behaviour for client rollout). All 3 render reads (`processingService:1562`, `sytist:3232` preview, `sytist:3837` Apply override) + the 2 stream routes (preview/info via new `resolveGraphicMeta` helper) resolve variant-first → deprecated-root fallback. Namespaced key = on-disk filename so vertical/horizontal can't collide in the shared `composite-graphics/<layoutId>/` bucket — **no `compositeGraphicsService` change, no migration, no rename**
- **Step 3 client (commit `5a75652`):** `api.del` gains optional body (per-variant DELETE sends `{variant}`); `LayoutDesignerPage` reloads the library on variant-tab change, namespaces upload keys, per Decision A adopts ONLY `variants[activeVariant].graphics` into the in-memory layout + originalJson (uploads-aren't-unsaved-changes contract scoped to variant). `visibleLegacyGraphics` applies Decision B per-key divergence (a legacy key hides from a variant's library only when that variant has its own same-base-name entry — strip `${variant}__` to compare — so replacing one asset never hides the others). `GraphicsLibrarySection` shows variant title, primary variant grid, read-only "Shared (legacy)" group below; `StaticGraphicSlotEditor` picker shows variant's own first + labelled `──── shared (legacy) ────` separator + `(legacy) <key>` entries, all selectable (Decision C). Decision D: no per-slot graphics revert. Closes the brief server-first rollout window
- **Step 4 harness (commit `4edbc82`):** `scripts/verify-layout-variant-graphics.js` — 26/26 offline cases pass (incl. 6 real-data cases against `composite-layouts.json`): namespacing + API contract validation (bare/mismatched/empty rejected); `resolveGraphicMeta` variant-first/root-fallback; the 3 render-read sites — variant own beats root, root fallback, **variant isolation in both directions** (vertical entry never resolves on horizontal and vice versa), legacy bare-key slot refs keep rendering; namespaced keys are distinct ⇒ no on-disk collision; Decision B per-key legacy hiding; real layout sanity (un-diverged production data renders identical filenames)
- **Operator UX shipped:** Memory Mate Horizontal now usable independently — set 5×3.5 canvas, upload a horizontal-specific background graphic, build out horizontal slots; legacy MM graphics remain available read-only and disappear from a variant's library only as they are individually replaced
- Files: `client/src/pages/settings/LayoutDesignerPage.js`, `client/src/components/LayoutCanvas.js`, `client/src/services/api.js`, `server/routes/sytist.js`, `server/services/processingService.js`, `server/scripts/verify-layout-variant-graphics.js` (new)

## Phase 58 — ShipStation package weights: floor to whole oz (USPS 1oz grace)
- Operational rate-savings change. Weights are now **floored** to whole ounces (min 1) before SS — universal across all packages and all carriers. USPS gives a 1oz grace per package (`8.7oz → 8oz`, `15.9oz → 15oz`, never `16oz`/`1lb`). Previously **ceiled**, which paid the next tier for any sub-ounce overage
- `packagingService._buildResult` — `Math.ceil(…)` → `Math.max(1, Math.floor(…))` at both rounding sites (normal `itemWeight + baseWeight`; fallback `itemWeight + 2`). The 1oz min enforced at the ounce step (the existing 1g clamp post-conversion was inadequate — 0.5oz would label as 0oz)
- `shipstationService` — same floor idempotently re-applied at the order-level weight-resolution fallback so operator-override + no-engine `defaultWeightOz` paths are floored too, not just the packaging-engine output. Universal at the payload boundary
- `_buildItemWeights` — remainder rollup now handles BOTH signs (was `> 0` only; under floor the remainder is negative — the absorber gets `+baseWeight − |fraction|`). Without this the floor would be silently undone by SS re-summing fractional per-item weights. Defensive ≥1oz clamp on the absorbing item so a degenerate `baseWeight=0` config can't drive it negative
- Field/log rename for honesty (the old names would be wrong post-change): `preCeilingOz`→`preRoundingOz`, `ceilingRemainderOz`→`roundingDeltaOz` (sign-carrying); `Pre-ceiling total`→`Pre-rounding total`; `Ceiling rounding: +X oz`→`Floor rounding: -X oz`. Log guard flipped to `Math.abs(…) > 0.001` so no-op rounding is still suppressed
- node --check clean both files. No tests/fixtures asserted ceiling behavior so none to update. Verification is the `[Packaging Trace]` server log — fractional-weight orders now print `Pre-rounding total: 3.7 oz / Floor rounding: -0.7 oz / FINAL: 3 oz`
- Files: `server/services/packagingService.js`, `server/services/shipstationService.js`

## Phase 58a — Orders-list "Missing Logo" badge + Settings preselect
- Surfaces the same per-gallery "no logo set" condition as the order-detail `LogoWarningBanner` (Phase 12), earlier in the workflow — operators catch it during batch-processing decisions without clicking into detail. Identical detection rule, identical conservative posture (the detail banner intentionally doesn't check whether any line item's layout uses a logo slot; the badge inherits that)
- Zero new endpoint, zero per-row HTTP, zero API/schema change: `OrdersListPage` fetches the existing `GET /api/sytist/gallery-assets/logos` ONCE on mount, stores the `{[galleryId]: {…}}` registry, checks each row locally. `order.galleryId` is already exposed per row by `sytistDbService`'s `primaryGallery` rollup
- Soft-fail (matches detail banner's "false positives worse than misses"): no badge when `galleryId === 0`, registry hasn't loaded, or fetch failed
- UX (operator-specified): red `⚠ Missing Logo` pill matching `WorkflowBadge`/`StatusBadge` styling + the list's warning-color family; text-primary so it reads at a glance. Hover tooltip `"No logo set for this gallery — click to upload"`. Click stops row propagation, routes to `/settings/gallery-assets?galleryId=<encoded>`
- `GalleryAssetsSettings.LogosSection` reads `useSearchParams` and pre-selects the requested gallery in the uploader dropdown on initial load (gated on dropdown still empty — manual selection never overridden). Operator lands at the upload control for that gallery, not the empty default
- Phase 57B per-variant composite-layout graphics doesn't interact — gallery logos are a separate per-gallery asset (`galleryAssetsService`). ESLint clean (3 pre-existing warnings unchanged)
- Files: `client/src/pages/OrdersListPage.js`, `client/src/pages/settings/GalleryAssetsSettings.js`

## Phase 58 hotfix — oz→g conversion must be `Math.ceil`, not `Math.round`
- **Real-order regression caught processing order 111920.** Packaging trace correctly produced `FINAL: 4 oz`, but ShipStation sent `113 g` (= `Math.round(4 × 28.3495) = round(113.398)`) and SS reverse-displayed `113 / 28.3495 = 3.99 oz`, billing at the **3 oz tier** — the exact failure Phase 58's floor was meant to prevent (a real 4.6 oz package labelled 3.99 oz exceeds USPS's 1 oz grace at 3 oz tier)
- **Whole-oz values affected:** 1, 4, 7, 10, 13, 15 oz (`Math.round` drops ~0.5 g, reverses to `.99`). 2/3/5/6/8/9/11/12/14 oz round identically under round and ceil — which is why the SPEC §58 worked-example (`8 oz → 227 g`) coincidentally passed and the offline harness missed this. Real-order verification surfaced it
- **Contract now documented explicitly:** the `oz → g → oz` round-trip must reverse to **≥** the original whole-oz floor. Only `Math.ceil(oz × OZ_TO_G)` satisfies that; round/floor both violate it
- **Fix:** `Math.round` → `Math.ceil` at both `shipstationService` grams sites (per-item L585 + order-level L660), with inline comments at each site documenting the round-trip contract so the rationale is visible at the call site
- **Bounded overshoot tradeoff (acceptable):** per-item sum can exceed the order-level grams ceil by up to (N−1) g ≈ 0.04 oz/item; never crosses a whole-oz rate tier in practice; direction is conservative (SS sees slightly more than intended, never less). Proportional distribution would be more code for sub-gram precision — not worth it
- **Verification:** process an order whose floored total is one of `{1, 4, 7, 10, 13, 15}` oz; SS should display ≥ that value (e.g. 4.02 oz / 15.03 oz). Process an 8 oz order to confirm no regression at the round/ceil-agree values (227 g, 8 oz display)
- Files: `server/services/shipstationService.js`

## Phase 58 hotfix 2 — integer ounces throughout the SS payload (eliminates the oz↔g round-trip)
- **Real-order regression caught processing order 111921.** Packaging trace correctly produced `FINAL: 5 oz`; ShipStation displayed **5.04 oz** (per-item ceil sum 143 g reversed to 5.0442 oz), billing at the **6 oz tier** — Phase 58's failure mode again, via overshoot this time. **Hotfix 1's "bounded overshoot never crosses a whole-oz rate tier in practice" claim was wrong**: it crosses every time the floor lands on a whole-oz boundary (i.e., every time). Owning that diagnostic mistake — preserved in the commit log
- **Root cause is the unit boundary, not the rounding direction.** `oz × 28.3495` is not an integer for any 1–16 whole-oz value → no integer gram value reverses to exactly N.00 oz under any rounding mode. The only fix is to not round-trip through grams at all
- **Architectural fix.** Send `units: 'ounces'` with integer values for BOTH order-level AND per-item. New `distributeIntegerOzAcrossLines(itemWeights, orderFloorOz)` helper splits the whole-oz floor across physical lines as integers summing exactly to it (same first-physical-absorber pattern the packaging engine uses for its fractional rollup, expressed at integer-oz granularity). Order-level weight resolution hoisted above the line-item loop so the floor is known before distribution. `OZ_TO_G` constant + all grams conversions removed
- **qty > 1 nuance (only imperfect case).** SS computes line total as `qty × per-unit`. For `qty=1` (dominant in observed orders): per-unit = lineIntegerOz exact. For `qty>1` where `lineIntegerOz/qty` isn't integer: per-unit ceils, bounded `≤ (qty-1) oz` over-shoot per such line, with `console.warn` so production frequency can be quantified. Phase 13b's original "SS truncates fractional oz per line" reason for grams doesn't apply to integer oz — no fraction to truncate
- **Verification harness (`server/scripts/verify-weight-distribution.js`, new): 12/12 pass.** Operator-specified matrix incl. the real-order 5 oz reproducer (`[3, 2]` summing 5), 1 oz floor, single-physical, multi-item (`[4, 1, 1, 1]`), digital mix (digitals stay 0, physical absorbs all), pathological 5×0.6 oz clamp; plus null-safety + cross-checks against the 4 oz (hotfix-1 case, now `[3, 1]` exact) and 8 oz (round/ceil-agree, no regression) values. Lesson encoded: worked examples must exercise the bug class, not coincidentally-safe values
- **Hotfix 1 stays in history** as a transitional patch — it did fix the 4 oz display, just not tier billing as claimed. Honest record over rewrite
- Files: `server/services/shipstationService.js`, `server/scripts/verify-weight-distribution.js` (new)

## Phase 58c — Product names display as leaf-only (everywhere)
- Sytist hands us `>`-delimited hierarchies (`"Print Packages > Silver Package > 8x10"`); we now render just the leaf (`"8x10"`) at every operator-visible surface — dashboard UI, slip JPG, SS payload, `ms_notes` reprint audit, imposition `{item_description}` token, packaging trace + debug logs
- **Architecture — Option Y (single source on the data shape).** Every line item carries both `productName` (full string, **identifier**, read by darkroom template lookup + specialty path construction + operator-edited config) and `productNameDisplay` (leaf, **display**, read by every render site). The field-name choice at the callsite signals intent — identifier-vs-display is structurally enforced, not utility-call discipline
- `deriveDisplayName` helper at `sytistDbService` module level: `.split('>').pop().trim()` with empty-leaf fallback to the original string (so `"Print Packages > "` with trailing `>` never renders empty)
- Set at all 4 `sytistDbService` construction sites: main cart line items, package constituents, addons, sibling parent-suffix variant (re-derives from suffixed string so team suffix appears in the leaf)
- 8 server display sites + 8 client display sites updated to read `productNameDisplay`. `photosFailed[]` staging field renamed `productName` → `productNameDisplay` (client only reads `.length`, safe)
- Identifier sites untouched: darkroom `template-mappings.json` matching, specialty `specialty-products.json` path construction, operator-edited settings pages. They keep reading `productName` (full path) — naturally protected by field-name choice
- Existing weight-distribution harness still 12/12 pass; node --check clean all server; ESLint clean all client (1 pre-existing unrelated warning)
- Files: `server/services/sytistDbService.js`, `shipstationService.js`, `packingSlipService.js`, `processingService.js`, `impositionService.js`, `packagingService.js`, `client/src/pages/OrderDetailPage.js`, `client/src/pages/settings/{LayoutDesignerPage,OrderOverridesPage,OverrideEditorPage}.js`

## Phase 58c hotfix — missed second cart-row mapper in `getOrderById` (order detail rendered "(no name)" for every item)
- **Real-order regression on the detail page.** Original Phase 58c set `productNameDisplay` at 4 line-item construction sites; the audit grep's `head -25` cut off before the FIFTH setter at `sytistDbService:1578` (the `getOrderById` main cart-row mapper — the order DETAIL data path, distinct from the list-page path at L1054). Detail page received line items with `productNameDisplay` undefined → `OrderDetailPage.js:1265` fallback `|| '(no name)'` fired on every row
- **Fix:** add `productNameDisplay: deriveDisplayName(c.cart_product_name || '')` at L1578. Exhaustive `productName:` grep (no head limit) now shows zero other missed setters
- **Lesson recorded as a separate CLAUDE.md bullet** (sibling to the "worked examples" one — different lesson): completeness audit greps must not be truncated with `head -N`. The original Phase 58c miss was a direct consequence of the truncated grep silently giving a smaller answer than reality
- Files: `server/services/sytistDbService.js`

---

## Phase 59 — Packing slip two-column layout + Items-to-Ship total

- **Bug:** Packing slips for orders with many items overlapped the footer or cut off the bottom rows. Root cause in `packingSlipService._composeSlip`: the items zone has a fixed ~820-px vertical budget, the thumb-size scaling floors at 60 px (kicks in at N≥7), and the per-row loop iterated all items with no overflow check. Around N=12 the last rows started colliding with the footer divider/QR; past N=15 sharp silently clipped composites that ran past the canvas bottom. No error logged either way — silent regression.
- **Fix:** at N≥7, split the items zone into two 680-px columns with a 20-px gutter. Items 1..ceil(N/2) fill column 1 top-to-bottom, items ceil(N/2)+1..N fill column 2 — canonical print order preserved (matches Darkroom .txt). Thumb size adaptive within 2-col mode: `clamp(60, 100, floor(820 / ceil(N/2)) - 20)`. Faint `#eeeeee` vertical divider between columns from itemsStartY to footerY-10. New ceiling: ~20 items at the 60-px floor; beyond that the same failure mode returns and operator gets a `console.warn` (`[Packing Slip] warning: order N has K items, may overflow 2-column layout (ceiling ~20)`).
- **"Items to Ship: K" total** is added to the ITEMS header band on **every** slip (single-col AND two-col). The number is the qty-summed total of rows that actually ship in the lab box — `printedItems` minus specialty / drop-ship / digital-by-config (Phase 45 `packagingService.isDigital(sku)`). Specialty rows still **render** on the slip (orange tint + SPECIALTY badge — operator awareness unchanged) but ship separately on their own pipeline per Phase 55 and so don't count toward the lab-box total. The right-edge `QTY` label drops in 2-col mode (each column carries its own per-row qty badges); the vertical column divider communicates the 2-col structure on its own (an initial `— 2 COLUMNS` textual suffix on the header was removed after live-UI review as redundant).
- **Single-column path preserved verbatim for N ≤ 6** — visual output for the common case is byte-comparable to pre-Phase-59 aside from the new `ITEMS TO SHIP: K` text (replaces the old `ITEMS (K)` label).
- **Zero touch outside `packingSlipService._composeSlip`.** Slip still produces one JPG with one `Filepath=` entry in the Darkroom .txt; `subResult.slipPath` stays a scalar string; `_cleanupOrphanOutputs` substring carve-out (`n.includes('_packing_slip')`) unchanged. Per-team ship_to_league slips paginate independently — each team's slip decides 1-col vs 2-col based on that team's own item count.
- **Pre-resolution unified.** The per-row loop's existing `isSpecialty` lookup loop was hoisted above the SVG build and extended to also resolve `isDropShipped` + `isDigital`, storing all three plus a derived `shipsWithLabOrder: !(any of the three)` per cartId in `eligibilityByCartId`. Single pre-pass instead of three; downstream sites read once.
- 11/11 offline harness cases pass (`server/scripts/verify-slip-pagination.js`): N = 1, 3, 6, 7, 8, 12, 16, 20, 22, plus a qty-aware case (5 rows, qty 1+1+1+3+3 → "Items to Ship: 9") and a skip-flags case (download + giftCert filtered before the count). Cases deliberately cover the bug class (N=7 onset, N=12 overlap zone, N=20 ceiling, N=22 overflow-warn-fires) per the worked-examples discipline.
- Files: `server/services/packingSlipService.js`, `server/scripts/verify-slip-pagination.js`, `.gitignore` (adds `server/scripts/_*-scratch/`)

---

## Phase 60 — Digital-only orders get their own workflow bucket

- **Bug:** Home/Manager galleries' orders showed under the **League** tab when the customer ordered only digital downloads. `categorizeShipping`'s numeric fallback bucketed `$0.00` shipping + empty option into `ship_to_league` (`else → league`). Diagnostic (90d): ~99 of the empty-option `$0.00` orders were digital-only and mostly belonged to home/manager galleries.
- **Fix:** new `'digital'` workflow value. `categorizeShipping(optionName, cost, isDigitalOnly)` — a digital-only order (no physical item) in the league cost band now returns `workflow:'digital', uncategorized:false`. Option-name match still always wins (a digital order with an explicit `USPS-Ship to Home` option stays home). Digital orders aren't flagged uncategorized (deterministic, no "add to mapping" ⚠).
- **JS ↔ SQL parity:** `_buildWorkflowSqlPredicate` gains a `'digital'` bucket and excludes digital-only from the `ship_to_league` **fallback** branch (name-matched league untouched). Digital-only = `NOT EXISTS` a physical cart row (`cart_download=0 AND sku NOT IN <packaging-config category=digital SKUs>` — Phase 45 landmine: 5D-type digital packages carry `cart_download=0`); checks `ms_cart` + `ms_cart_archive`. The digital-SKU list is **inlined** (validated `[A-Z0-9 _-]`, trusted local config) to avoid param juggling across the predicate + computed SELECT columns. The same `_physicalItemExistsSql` computes an `isDigitalOnly` column in the list query, `getOrderById`, and `getOrderCounts`, so badge / detail / filter / counts never disagree.
- **Downstream (safe):** `'digital'` orders take the single-bundle process path (vs per-team) and skip SS auto-create (non-home) — harmless, digital-only orders have no physical output.
- **Client:** amber **Digital** tab + `WorkflowBadge` (OrdersListPage), detail-page `WorkflowBadge` label/color (OrderDetailPage), Home dashboard stat card (HomePage).
- **Verification:** `server/scripts/verify-shipping-classify.js` 11/11 (real `categorizeShipping`); live DB — 4 known orders reclassify `digital`, digital filter = 173 (all statuses), league still 1,724 with 0 leaks, home unaffected (23,913).
- Files: `server/services/sytistDbService.js`, `server/scripts/verify-shipping-classify.js`, `client/src/pages/OrdersListPage.js`, `client/src/pages/HomePage.js`, `client/src/pages/OrderDetailPage.js`

---

## Phase 60a — Instant-pack eligibility classification (badge only)

- **Goal:** surface which orders are safe to auto-pack/ship without operator review, as a per-order badge. No bulk actions, no print triggering, no label changes — those land in **60b**.
- **Eligibility rule:** an order is instant-pack eligible IFF it has **≥1 physical item** AND **every physical item's SKU is marked eligible** (default-deny). A line item is *physical* iff: not a package header, none of `INSTANT_PACK_SKIP_FLAGS` (`download/giftCert/creditProduct/booking/preSell`), and not a digital-by-config SKU (`packaging-config category:'digital'`). Modifier-type add-ons never become line items, so they're ignored for free; package constituents and product-type add-ons are evaluated by their **own** SKU.
- **Specialty / drop-ship (decision):** these are **NOT** skip-flagged — they physically ship, so they pass the physical predicate and must themselves be on the eligible list. Default-deny means they aren't (a drop-ship SKU shouldn't be markable), which **correctly disqualifies** any order containing one. The eligibility function has **no** specialty/drop-ship awareness — correctness comes entirely from default-deny + a physical SKU not being on the list. (Contrast: the Phase 59 packing-slip `shipsWithLabOrder` *excludes* specialty/drop-ship — that answers "what's in this lab box," a different question.)
- **Storage:** a new `instantPackEligible: true` boolean on each `packaging-config.json` `productWeights[sku]` entry (default-deny via missing flag). `packagingService.isInstantPackEligible(sku)` mirrors `isDigital`'s case-tolerant lookup. `setProductWeight` persists it and **preserves** it when a caller omits the field.
- **No SQL parity (deliberate):** unlike Phase 60's `isDigitalOnly` (which gated the LIMIT/OFFSET filter + count badge and so needed a SQL predicate), 60a's badge is **display-only** — no filter tab, no count. So `isInstantPackEligible` is computed **purely in JS** over the already-expanded canonical line items in **both** `getOrdersByWorkflow` (list) and `getOrderById` (detail), via the shared pure helper `_computeInstantPackEligibility(lineItems, predicates)`. **When 60b adds a tab/count, a `_buildWorkflowSqlPredicate`-style SQL parity becomes mandatory** — flagged in code + SPEC so a future tab's count can't silently disagree with the badge.
- **Client:** filled blue **⚡ Instant-Ship** badge in the orders table (OrdersListPage), rendered only when `order.isInstantPackEligible`. New **⚡ Instant-Ship Eligible** checkbox column in Settings → Packaging → Product weights (operator-clear header, not the internal field name); edits reflect with no restart (`getConfig` reads disk each call).
- **Verification:** `server/scripts/verify-instant-pack-eligible.js` 11/11 (real `_computeInstantPackEligibility` + `_makePackagingPredicates`) — digital-only ✗, prints-only ✓, prints+ineligible-physical ✗, prints+modifier-addon ✓, prints+eligible-product-addon ✓, prints+ineligible-product-addon ✗, empty ✗, package-header-ignored ✓, specialty-item ✗ (SKU in `blockingSkus`), drop-ship-item ✗ (SKU in `blockingSkus`), eligible-print+digital ✓. Real-order check deferred until the operator marks SKUs eligible on the new column.
- Files: `server/services/packagingService.js`, `server/services/sytistDbService.js`, `server/scripts/verify-instant-pack-eligible.js`, `client/src/pages/settings/PackagingPage.js`, `client/src/pages/OrdersListPage.js`

---

## Phase 61 — Fail-closed processing (stop partial/wrong-product shipments)

- **Bug:** order 112054 shipped with 1 of 2 items. A photo failed to download (`fetch failed`); the `.txt` was built from only the items that DID download, `subResult.success` was set `true` regardless, the order flipped to Printing, and ShipStation was created. A customer would receive a partial order with no alert — only a buried `console.warn`.
- **Root cause:** the regular pipeline was **fail-open**. `_processSubOrder` recorded photo-download failures as warnings and set `success = true` unconditionally; the `.txt` step deliberately *excluded* failed items. Audit also found green-screen / composite / imposition failures were non-fatal warnings producing **wrong product** (raw subject instead of on-background; bare photo instead of Memory Mate; 1 photo instead of a sheet of 8 wallets).
- **Fix — fail-closed gate.** Invariant: *everything is in the `.txt`, or the order doesn't complete.* `_processSubOrder` now sets `success:false` + early-returns on any failure, so `allOk` short-circuits cleanup / ShipStation / status-flip / ms_notes; the order stays **Open**, nothing prints, OK files are inert debris, a reprocess re-downloads everything.
  - **Missing-item gate:** fires after the download loop on any `photosFailed` entry. **Regular AND specialty/drop-ship block** (reverses Phase 55's specialty soft-fail — a flaky specialty drive now blocks the regular box too; the accepted Fork-2 trade for zero silent-failure surface).
  - **Wrong-product gates:** green-screen compose, composite render, and imposition throws are now FATAL (each catch sets `error` + returns). Rule: *fatal if the customer would say "this isn't what I ordered"; non-fatal if "this looks slightly off."* Deferred to **Phase 62** (deliberate policy pass): placeholder logo, missing team photo, background-fetch failure, missing static graphic — degraded-but-recognizable, they `continue`.
- **Download resilience:** `_downloadFile` gains an `AbortController` timeout + throws `.status`/`.cause`. New `_downloadWithRetry` retries transient failures (network / `AbortError` / 5xx / 408 / 429) with backoff `[1s,3s,9s]`; terminal 4xx (≠408/429) fails immediately. **`err.cause` is logged everywhere** — bare `"fetch failed"` was undiagnosable.
- **Visibility (the blind-spot fix):** the operator batch-processes 10–50 orders and rarely opens detail, so a held order must surface in the batch flow. (1) OrderDetailPage shows a blocking **red** "ORDER NOT COMPLETED" banner with per-sub-order reasons (was a buried amber "completed with errors"). (2) The `JobProgressBanner` now classifies results correctly (a fully-failed single-sub-order was mislabeled "partial") and **always-visibly enumerates** failed/partial orders with order # + reason + click-through. (3) Orders-list rows get a red **⚠ Last process failed** / amber **Partial** badge from `process-history.json` (batch-only; single-order failures are covered by the detail banner since the operator is on that page). New `processHistoryService.getLatestStatusByOrderId`.
- **Known gap (multi-team):** a per-team failure blocks the order-level status/SS, but successful sibling teams' `.txt` files are still written to disk. Reported case was `ship_to_home` (single sub-order, unaffected). Strict per-team all-or-nothing is a deferred two-pass restructure.
- **Verification:** `verify-download-retry.js` 6/6 (retry/terminal/transient classification), `verify-failclose-gate.js` 6/6 (photo-download fail, specialty fail, composite/imposition/green-screen throws → `success:false` + no `.txt` + no SS create/status). Real-order verification pending operator processing.
- Files: `server/services/processingService.js`, `server/services/processHistoryService.js`, `server/routes/sytist.js`, `server/scripts/verify-download-retry.js`, `server/scripts/verify-failclose-gate.js`, `client/src/pages/OrderDetailPage.js`, `client/src/pages/OrdersListPage.js`

---

## Phase 61a — Digital-by-config false-block fix

- **Bug:** a standalone digital package ("Digital Package - 5 High Resolution Digital Images", `cart_sku="5D"`, order 112094) false-blocked its whole order at the Phase 61 missing-item gate (`no_photo_url`) — the "digital-by-config reaches `printableItems`" case flagged as theoretical in Phase 61, now live.
- **Root cause:** `_splitIntoSubOrders` filtered `printableItems` on `SKIP_FLAGS` only. `5D` is `category:'digital'` but carries `cart_download=0` (Phase 45 landmine), so the `download` skip-flag missed it; it reached the download loop with no photo → tripped the gate. (The `sku=?` in the log was a separate red herring — the SKU resolved fine; the `no_photo_url` push just omitted the `sku` field.)
- **Fix:** `_splitIntoSubOrders` is now `async` and also excludes `packagingService.isDigital(li.sku)` items (one hoisted `getProductWeights()` read, not per-item; awaited at the single `processOrder` call site). Logging gap fixed — `no_photo_url` now records `sku: li.sku`. **The gate is unchanged** — we fixed what counts as printable, not what the gate does.
- **The distinction:** exclusion keys on `isDigital(sku)===true` ("configured digital product"), NOT on "missing photo" — so a real print whose photo genuinely fails stays printable and still hard-fails. No productName-substring fallback (fragile). Edge not handled: a digital item with truly-empty `cart_sku` (a Sytist data gap), by decision.
- **Safety:** slip unaffected (renders from full `order`, not `printableItems`); `.txt` unchanged (digital had no photo → never in the manifest); digital package *constituents* were already excluded via `flags.download`.
- **Verification:** `verify-failclose-gate.js` → 8/8, adding "digital 5D excluded → order completes" and the guard "real print, no photo URL → STILL gate-fails (error carries `sku=8`)". Live two-sided check required before commit (harness missed 5D originally): digital ignored on a real order + real-print photo-fail still blocked.
- Files: `server/services/processingService.js`, `server/scripts/verify-failclose-gate.js`

---

## Phase 64 — Pre-registration line items skip-flagged (fail-closed false-block fix)

- **Bug:** order 112376 (3 real prints + 1 "Pre-registration for Kristin Nelson") false-blocked by the Phase 61 fail-closed gate. The pre-reg cart row carries no SKU, no photo, and none of the existing skip-flags (`booking`/`preSell`/`creditProduct`/`download`), so it survived into `printableItems`, hit the download loop, returned `no_photo_url`, and hard-failed the whole order — 3 real prints held hostage by one non-product line. Same class of bug as the 5D digital false-block (Phase 61a), different item type.
- **Discriminator:** Sytist has a dedicated `ms_cart.cart_pre_register_id` column (positive integer ⇒ pre-registration line). Live DB profile (`ms_cart` + `ms_cart_archive`): **641 pre-reg rows, 0 with a photo, 0 with a SKU, 0 with `cart_download=1`, 0 counterexamples** — a clean type signal that can never drop a real print.
- **Fix:** new `flags.preRegister` (from `cart_pre_register_id > 0`) at both line-item construction sites in `sytistDbService` (with the column added to both SELECTs). Wired into every skip set that lists `booking`/`preSell`: `processingService` `SKIP_FLAGS` (the gate), `darkroomService`, `packingSlipService`, `shipstationService`, `INSTANT_PACK_SKIP_FLAGS` in `sytistDbService`, and the inline eligibility check in `routes/shipstation.js`. The full retirement was deliberate — `processingService`-only would unblock the gate but leave a phantom $0 pre-reg line on the slip and as a ShipStation line item.
- **Identity-not-photo invariant:** keys on the dedicated flag (`flags.preRegister`), NEVER on "missing photo." A real print whose photo genuinely fails still hard-fails — a real print can't have `cart_pre_register_id > 0`. The empty-`cart_sku` edge is a Sytist data gap (assign the SKU); no productName-substring matching.
- **Gate log fix:** `cart N sku=? (item): error` previously rendered `sku=?` for empty-string SKUs (pre-reg signature), reading like "unlogged" when actually no SKU on the row. Now `sku=(empty)` (truly empty) vs `sku=?` (genuinely null/undefined).
- **Recurring-pattern landmine added to `CLAUDE.md`:** non-product line item types (`booking`, `preSell`, `preRegister`, future variants) — always identify via dedicated `cart_*` column, add `flags.<type>`, wire into every skip set in lockstep, key on item identity. **Audit the `cart_*` column set in `ms_cart` for sibling flags before assuming a new type is already covered.**
- **Verification:** `verify-failclose-gate.js` 10/10 (added cases 8/9 — pre-reg + real prints completes; sibling real-print-no-photo still hard-fails alongside excluded pre-reg). Live read-only on 112376: pre-reg cart 488923 now `flags.preRegister=true`; `_splitIntoSubOrders` excludes it; gate sees only the 3 real prints (all with photos) → would NOT fire.
- Files: `server/services/sytistDbService.js`, `server/services/processingService.js`, `server/services/darkroomService.js`, `server/services/packingSlipService.js`, `server/services/shipstationService.js`, `server/routes/shipstation.js`, `server/scripts/verify-failclose-gate.js`, `CLAUDE.md`

---

## Phase 65 — Order-number prefix on Darkroom `.txt` last name (lab sort)

- **Goal:** the Darkroom `.txt` `OrderLastName=` header now reads `<orderNumber>-<lastname>` (e.g. `112376-Nelson`) so lab print jobs sort numerically by order number on Darkroom import. Operator-requested for stack management at the print bench.
- **Darkroom-`.txt`-ONLY.** Built as a local string at the `_renderContent` call site in `buildOrderTxt`; `order.customer` is **never mutated**. The packing slip (reads `order.shipTo`) and ShipStation (billTo reads `order.customer`, shipTo reads `order.shipTo`) keep the clean last name with no number. `ExtOrderNum` still carries the bare order number on its own header line. Verified live on order 112376: `order.customer.lastName` / `order.shipTo.lastName` both unchanged before vs after `buildOrderTxt` — leak-safe end-to-end.
- **Divider carve-out.** `_renderContent` is shared between `buildOrderTxt` and `buildDividerTxt` (the Phase 63 batch divider). Editing only the `buildOrderTxt` call site leaves the divider untouched by construction — `buildDividerTxt` calls `_renderContent` with its own synthetic `lastName=''` and `orderNum='DIVIDER <teamName>'`. A divider isn't an order; correct.
- **Edge:** order with empty `customer.lastName` renders `OrderLastName=<orderNumber>-` (trailing dash). Documented; matches the "always include order number" intent.
- Files: `server/services/darkroomService.js`

---

## Phase 66 — Product category drives `packageCode=package` (`forcePackageSKUs` retired)

- **Architecture change:** the per-SKU `productWeights[sku].category` field (rigid / bulky / pano / flat / digital) is now the **single source of truth** for "force Package service." `determinePackaging`'s force-package loop checks `category ∈ {rigid, bulky, pano}` for each physical SKU; matches set `forcePackage = true` and the existing flat-as-package path (`packageCode='package'`, `flat_9x11` dims) takes over. The parallel hand-maintained `forcePackageSKUs` SKU list is **retired entirely** — engine, `DEFAULT_CONFIG`, migrate-seeding, live `packaging-config.json`, the PUT-config allowlist in `routes/shipstation.js`, and the Settings → Packaging UI input (replaced with a static "Driven by per-SKU category" pointer).
- **Why retire:** the parallel list drifted. SKU 18 Bagtag was `category:'rigid'` but absent from `forcePackageSKUs`, so it shipped as a flat. Live audit confirmed retirement is safe — all 10 SKUs in the live `forcePackageSKUs` are category rigid/bulky/pano, so category subsumes them.
- **Behavior change — exactly 3 SKUs flip:** 18 (Bagtag, rigid), 37 (Team Coffee mug, bulky), 34 (12x36 Pano, pano) — previously `large_envelope_or_flat` — now `packageCode='package'`. Every other SKU unchanged.
- **Intentionally untouched:** `boxRouteSKUs` (Medium-vs-Large box sizing, runs BEFORE the force-package check and returns early — boxed SKUs were already `service:'package'`), the magnet count rule (`magnetThreshold` SKUs 15/17 at qty ≥ 3 → package), and `packageBundles[].forcePackage` (bundle override). The narrow scope keeps Phase 66 as "category replaces the parallel list," not "rewrite box routing."
- **CLAUDE.md landmine added:** do not reintroduce a parallel force-package list; change the SKU's category instead.
- **Verification:** `server/scripts/verify-package-routing.js` 10/10 (rigid/bulky/pano → package, flat → flat, magnet count rule unchanged, Gold bundle override unchanged, boxRoute sizing unchanged, SKU 45 without boxRoute → flat) + read-only live sweep (every SKU formerly in `forcePackageSKUs` still ships package; 18/34/37 flip flat→package).
- Files: `server/services/packagingService.js`, `server/config/packaging-config.json`, `server/routes/shipstation.js`, `client/src/pages/settings/PackagingPage.js`, `server/scripts/verify-package-routing.js`, `CLAUDE.md`

---

## Phase 67 — `{customer.phoneFormatted}` composite text token (dash-formatted from `order_phone`)

- **Goal:** new composite-builder variable for printing the customer's phone in dash-formatted form (e.g. `555-123-4567`). Operator inserts via a "Phone" button in the variable picker.
- **Source — `order_phone`, not an `ms_people.p_phone` join, by the data.** 90-day live profile (4,521 orders): `order_phone` empty in 224; `ms_people.p_phone` populated (post-join) in 4,278; but **only 10 orders where `p_phone` would gain over `order_phone`**, and **zero disagreements** where both were present. Email join (`ms_orders.order_email = ms_people.p_email`) is fragile — 32 emails with >1 `ms_people` row (ambiguous which to pick), 10 with no `ms_people` row at all. Data settled it: use the field already on the order row, no SQL change.
- **Naming — `{customer.phoneFormatted}`, not bare `{phone}`.** Groups under `customer`. The raw `{customer.phone}` is **deliberately left unchanged** — `shipstationService.js:513,530` reads it for the ShipStation billTo/shipTo phone fallback, and formatting it there would silently leak hyphens into SS. Raw and formatted coexist.
- **`formatPhone` formatter:** strip non-digits; 10 digits → `xxx-xxx-xxxx`; 11 digits starting with `1` → strip the leading `1`, format as above; anything else (including empty / null / undefined / whitespace-only → blank) → return raw input untouched. Mirrored byte-identically in the server and the client `OverrideEditorPage` per the Phase 48 contract.
- **Three places the token vocabulary lives** (sync-warning landmine added to `CLAUDE.md`): `compositeService.buildTokensFromOrder` (server) + `OverrideEditorPage.buildTokensFromOrder` (client mirror) + `LayoutDesignerPage.VARIABLES` (the picker UI's `{ token, label }` array, where `{ token: '{customer.phoneFormatted}', label: 'Phone' }` was added). Future tokens must touch all three or the editor's preview silently disagrees with production.
- **Verification:** `server/scripts/verify-phone-token.js` — 13/13 offline (5 operator-listed formatter + 4 defensive null/undefined/whitespace/`+1` notation + 4 `buildTokensFromOrder` plumbing) + 2/2 live on order 112801 (raw `"7633501875"` → `tokens.customer.phoneFormatted = "763-350-1875"`, raw preserved unchanged). The originally-listed "email-mismatch case → blank not error" is moot — no email join under the chosen design. Live UI checks ride next natural phone-bearing composite (operator confirms picker "Phone" inserts the token; rendered composite shows dashed output).
- Files: `server/services/compositeService.js`, `client/src/pages/settings/OverrideEditorPage.js`, `client/src/pages/settings/LayoutDesignerPage.js`, `server/scripts/verify-phone-token.js`, `CLAUDE.md`

---

## Phase 69 — Coupon line skip-flag (fail-closed false-block fix, third instance of the non-product-line pattern)

- **Bug:** orders 112885 and 112886 false-blocked by the Phase 61 fail-closed gate. Both contained a Sytist coupon line in `ms_cart` (cart 492158 "Harberts10", cart 492160 "Melanie95") with no SKU, no product name, no photo, and **none** of the existing skip-flags. The coupon line survived `printableItems`, hit the download loop, returned `no_photo_url`, and hard-failed the whole order — real prints held hostage. Third instance of the same recurring pattern: digital-by-config 5D (Phase 61a) → pre-registration (Phase 64) → coupon (Phase 69). **The Phase 64 landmine — "audit `cart_*` columns for siblings" — caught this on first report; the rule earns its keep.**
- **Discriminator:** `ms_cart.cart_coupon > 0`. Live DB profile across both `ms_cart` + `ms_cart_archive`: **2,635 coupon rows, 0 with photo, 0 with SKU, 0 with `cart_download=1`, 0 with product name, 0 counterexamples** — clean type signal that can never drop a real print.
- **Fix:** new `flags.coupon` (from `cart_coupon > 0`) at both line-item construction sites in `sytistDbService` (with `cart_coupon` added to all 3 SELECTs). Wired into every skip set in lockstep with `preRegister`: `processingService` `SKIP_FLAGS` (fixes the gate), `darkroomService`, `packingSlipService`, `shipstationService`, `INSTANT_PACK_SKIP_FLAGS`, and the inline eligibility check in `routes/shipstation.js`. Identity-not-photo invariant preserved (a real print never has `cart_coupon > 0`; missing-photo on a real print still hard-fails). Full wiring was deliberate — `processingService`-only would have left the coupon as a phantom $0 line on the packing slip and a phantom ShipStation line item.
- **CLAUDE.md landmine updated** to include `coupon` in the recurring-pattern type list and explicitly note that the "audit `cart_*` siblings" rule successfully predicted/caught this third instance.
- **Verification:** `verify-failclose-gate.js` 12/12 (added cases 10/11 mirroring Phase 64's 8/9 — coupon + real prints completes; real-print-no-photo still hard-fails alongside excluded coupon). Adjacent harnesses unchanged: instant-pack 11/11, slip pagination 11/11, package-routing 10/10. Live read-only on both reported orders: `flags.coupon=true` on the coupon line; `_splitIntoSubOrders` excludes it; gate would NOT fire. **Live two-sided field check on 112885/112886 (operator-confirmed):** both processed cleanly, no phantom $0 coupon line on the packing slip, ShipStation order weight reflects only real items.
- Files: `server/services/sytistDbService.js`, `server/services/processingService.js`, `server/services/darkroomService.js`, `server/services/packingSlipService.js`, `server/services/shipstationService.js`, `server/routes/shipstation.js`, `server/scripts/verify-failclose-gate.js`, `CLAUDE.md`

---

## Phase 70 — `resolveSheetMeta` helper + three client sites swapped (Phase 57A drift fix; SKU 22 list-vs-editor)

- **Bug:** the operator edited SKU 22's composite from 8×10.25 to 8×10.5 in the layout designer. Editor preview showed 8×10.5 (correct — designer resolves variant-first); the composites list "Size" column still showed 8×10.25. The JSON file on disk has both: variant value `10.5` and deprecated root value `10.25`. The list read root only — exactly the failure mode the Phase 57A landmine warned against (*"don't read root directly for render"*).
- **Three drift sites confirmed.** Initial audit grep flagged four; one (`OrderDetailPage.js:3282`) turned out to be a false positive — it displays **imposition** info (`{info.layout.cols}×{info.layout.rows} on {info.layout.sheetWidth}×{info.layout.sheetHeight}″`), and imposition is single-variant by design (root is authoritative there). The three actual composite-layout drift sites:
  - `client/src/pages/settings/CompositesSettings.js:445` — list "Size" column (the reported case).
  - `client/src/pages/settings/OverrideEditorPage.js:928` — override-editor canvas aspect ratio (silent: would render the canvas at wrong proportions for any layout with diverged variants).
  - `client/src/pages/settings/OverrideEditorPage.js:1034-1035` — `sheetWidth`/`sheetHeight` props to `QuickEditPanel`.
- **Fix — shared helper `client/src/utils/resolveSheetMeta.js`.** Variant-first / root-fallback / hardcoded-default for all four Phase 57A-named fields (`sheetWidth`, `sheetHeight`, `dpi`, `backgroundColor`). Pattern mirrors `LayoutCanvas.js:120-133`'s existing-correct inline exactly: `!= null` checks for numeric fields, `||`-chain for backgroundColor, defaults `dpi=300` / `backgroundColor='#ffffff'`. **`backgroundColor` included even though no current drift site reads it** — Phase 57A names all four fields as variant-first; excluding it would invite the next reader to re-inline the precedence and recreate the bug class for that field. The helper is the canonical "resolve sheet meta for variant X" function on the client.
- **List column: vertical-primary + `(V/H differ)` marker.** Resolves from the `vertical` variant (the historical default; ~95% of composites don't diverge V vs H in practice). When vertical-resolved dims don't agree with horizontal-resolved dims, a small italic `(V/H differ)` marker appears inline and the cell's `title` carries both variants' resolved dims as a tooltip. Decision over a per-variant column: marker handles divergence without bloating the column for the common case.
- **Scope discipline — `LayoutCanvas` + `LayoutDesignerPage` left alone.** Their existing inlined resolvers are correct; helper is available for them later if a future refactor consolidates.
- **CLAUDE.md Phase 57A landmine updated** to point at `resolveSheetMeta` as the canonical client-side resolver, document the three drifted sites Phase 70 fixed, and tell the next reader: any new client surface that displays composite-layout dimensions for a specific variant must use this helper — don't re-inline the precedence.
- **Verification:** offline drive of the helper against the live SKU 22 layout — root `8 × 10.25`, vertical resolved `8 × 10.5`, horizontal resolved `8 × 10.25` (variant fallback to root, since horizontal has no override). `differs=true`. List cell would render `8″ × 10.5″ @ 300dpi (V/H differ)`. Live two-sided field check post-commit: refresh the composites page, confirm SKU 22 row shows the corrected size with the marker, hover-tooltip shows both variants.
- Files: `client/src/utils/resolveSheetMeta.js` (new), `client/src/pages/settings/CompositesSettings.js`, `client/src/pages/settings/OverrideEditorPage.js`, `CLAUDE.md`

---

## Phase 71 — Override editor image upload: 25 MB JSON cap + 18 MB client pre-flight popup (and removed two dead per-route parsers)

- **Bug:** override editor image replacement returned `413 Payload Too Large` on a 9 MB raw JPEG. Base64-in-JSON inflates binary by ~4/3, so 9 MB raw becomes ~12 MB JSON body — exceeded the global `express.json({ limit: '10mb' })` at `server/index.js:78`.
- **Latent footgun discovered during audit.** `routes/sytist.js:3571` had a per-route `orderAssetUploadJsonParser = express.json({ limit: '15mb' })` and `:4178` had a sibling `graphicUploadJsonParser` at the composite/graphics route — **both were dead code** from the moment they were committed (Phase 50 and Phase 9e-hotfix respectively). Both authors believed a per-route parser would "scope" a higher limit to one endpoint; in fact `app.use(express.json(...))` is global middleware that runs *before* any per-route parser sees the body. The next person who tried to "fix" the 413 by raising either per-route limit would have wasted hours.
- **Fix:**
  - **Server:** `express.json` + `express.urlencoded` in `server/index.js` raised from `'10mb'` to `'25mb'`. With base64 inflation that's a ~18.7 MB raw image ceiling — comfortable headroom for camera JPEGs.
  - **Cleanup:** removed `orderAssetUploadJsonParser` (`:3571`) and `graphicUploadJsonParser` (`:4178`) plus their misleading rationale comments. Global is now the only `express.json` cap in the codebase.
  - **Client pre-flight popup:** `uploadSlotAsset` in `OverrideEditorPage.js` checks `file.size` *before* the FileReader read. If > **18 MB** (operator-facing cap; rounded down from 18.7 with margin for the JSON wrapper), shows a native `window.alert`: *"Image too large — max 18 MB. This file is X.X MB. Please resize and try again."* No upload attempt — instant feedback.
  - **Defense in depth:** the existing `try/catch` also detects `err.status === 413` (the `api.js` wrapper attaches `.status` to thrown errors) and shows the same popup. If the client raw cap and server JSON cap ever drift, the operator still gets the actionable message rather than a generic "Request failed (413)" banner.
- **CLAUDE.md landmine added** documenting the three interconnected gotchas: (a) global `express.json` runs first / per-route limits don't override it; (b) base64 inflation factor 4/3; (c) client raw-MB cap must lead the server JSON-MB cap by that factor or 413 falls through to a generic error.
- **Verification:** the 9 MB file that triggered the report would now succeed (12 MB JSON < 25 MB cap; 9 MB raw < 18 MB cap). Live two-sided field check post-commit: (a) upload a < 18 MB image, succeeds without 413; (b) try a > 18 MB image, see the popup with the actual size and the cap, no upload attempted.
- Files: `server/index.js`, `server/routes/sytist.js`, `client/src/pages/settings/OverrideEditorPage.js`, `CLAUDE.md`

---

## Phase 72 — Photo URLs encoded at construction (S3 `+` in filename → 403 fix)

- **Bug:** order 114148 Team 2 failed processing with `403 Forbidden` on its two Ireland photos. The Sytist team name "6th+ Co Ed Ireland" went into the photo filenames as `original_..._6th+_Co_Ed_Ireland.jpg`. `sytistDbService.buildPhotoUrls` built the S3 URL by raw string concat — the bare `+` in the path was interpreted by S3's signature validation as a space, returning 403. The `[PhotoThumb] Source fetch failed` error in the log was the same root cause hitting the photo-thumb proxy transitively.
- **Scope of the bug class:** 1,114 of 2.86M lifetime `ms_photos` rows have `+` in `pic_full`. Sytist's upload sanitizer already strips spaces, `&`, `#`, `?`, apostrophes (0 rows for each), but `+` slips through. Latent for years — only triggered when a team name or customer name with `+` hits processing.
- **Fix:** `encodeURIComponent` on the filename segment in `buildPhotoUrls` for all three URL fields (`fullUrl`, `largeUrl`, `thumbUrl`). Single-spot change at the canonical URL construction point. Every consumer (`processingService._downloadFile`, photo-thumb proxy, green-screen, imposition, slip, every route-handler `fetch(...fullUrl)`) reads URLs from this output and is fixed transitively — **no consumer touches needed.**
- **Why `encodeURIComponent` over alternatives:** `encodeURI` would NOT fix the bug (`+` is RFC 3986 sub-delim, allowed unescaped in path segments, encodeURI leaves it). `replace(/\+/g, '%2B')` is too narrow — covers `+` but not future Sytist sanitizer changes. `encodeURIComponent` is safe because (1) `pic_full` is always a flat filename — zero rows have internal `/` to preserve, (2) zero rows are pre-encoded — no double-encoding risk, (3) it covers any future URL-special char too.
- **CLAUDE.md landmine added:** photo URLs are encoded ONCE at construction; no consumer should re-encode or build photo URLs from raw `pic_full` directly.
- **Verification:** offline math — Ireland photos correctly contain `%2B`, Germany/United_States files unchanged. Live read-only HEAD fetches on all four order 114148 cart photos (including both Ireland files) + package constituents + known-good non-`+` controls: **200 on all**. The two Ireland files that 403'd pre-fix now return 200.
- **Multi-team gap (Phase 61 "Known gap") confirmed live, not theoretical:** order 114148 Team 1 (3rd Girls United States) succeeded BEFORE Team 2 (6th+ Co Ed Ireland) failed, leaving Team 1's `.txt` + slip + imposed prints on disk while the order as a whole was incomplete. Operator deleted them manually. The strict "no team prints unless every team succeeds" two-pass restructure remains deferred but is now field-confirmed.
- Files: `server/services/sytistDbService.js`, `CLAUDE.md`

---

## Phase 73 — User management UI + Profile page + last-admin invariant + `SESSION_SECRET` cleanup

- **Built on top of existing auth.** The dashboard already had a full auth stack (`authService`, `requireAuth`/`requireRole`, `/api/auth/*` routes, SQLite `users` + `sessions` tables, `App.js` LoginPage gate). Phase 73 added the missing UI surfaces so admins don't have to use `scripts/add-user.js` for user management and so non-admin operators (none today, but the role is wired) can change their own password without admin access.
- **`UsersSettings.js` (new)** — admin-only settings page (gated by `SettingsLayout`'s top-level `role === 'admin'` check). Lists all users with: username, display name, role badge (admin/operator/viewer color-coded), active/deactivated badge, created date, last-login relative time (`3h ago` / `Never`, with ISO tooltip). Add-user form with UI-side hygiene rules: `[A-Za-z0-9_.-]+` for usernames, min 8 chars for passwords (server stays permissive). Edit row for display name + role + optional password change (blank = keep current). Per-row "Deactivate" (soft-delete) and "Reactivate" actions with `window.confirm` prompts. Default role on Add is **admin** matching `scripts/add-user.js` convention.
- **`ProfilePage.js` (new)** — top-level route at `/profile`, accessible to any authenticated user (NOT under `/settings/*` because that subtree is admin-only). Reached via the now-clickable username in `AppLayout`'s header. Change display name + password (with confirmation). On password change, the success banner explicitly states *"Your current session remains active — the new password is required at the next sign-in"* so operators don't worry about being kicked.
- **Last-admin invariant** added to `authService.updateUser`. Throws `"Cannot deactivate or demote the last active admin"` (route returns 400) when an update would convert this user from active+admin to either `active=0` OR a non-admin role AND `COUNT(*)` of other active admins is zero. `deactivateUser` calls `updateUser({active:false})` so the guard runs naturally. UsersSettings mirrors the check client-side (disabled button + tooltip) to avoid the round-trip, but the server is authoritative. **Closes the brick scenario** that existed pre-Phase-73: previously, accidentally deactivating yourself or demoting your role to viewer would leave no admin and require shell access to `scripts/add-user.js` for recovery.
- **Soft-delete semantics confirmed.** The existing DELETE route was already soft-delete (sets `active=0`); Phase 73 kept that and labels the UI action "Deactivate" not "Delete". Reasons: audit-row preservation (`order_status_audit.user_id` references), `users.username` UNIQUE applies to deactivated rows (reactivate workflow > recreate-with-same-name), sessions auto-clean via TTL + `users.active=1` join in `validateSession`. CLAUDE.md landmine documents the rationale.
- **Password-change-keeps-session behavior verified and documented.** Sessions are UUID-keyed in SQLite, no tie to `password_hash`. `validateSession` checks `users.active=1` but not the password hash. `updateUser({password})` updates `users` only, never `sessions`. So self password change keeps the session active; next sign-in needs the new password. CLAUDE.md landmine documents this so a future reader doesn't assume a security-driven session-invalidate-on-password-change behavior that doesn't exist.
- **`SESSION_SECRET` cleanup.** Deleted from `server/.env` (file is gitignored — local cleanup only). Confirmed zero source references — the actual session machinery uses `uuid` (npm) for opaque session IDs + `bcrypt` for password hashes. The `.env` line was leftover from an earlier copy-paste shape.
- **Routing changes:** `/profile` registered above the `/settings/*` block in `AppLayout.js` (top-level, no role gate beyond auth). `/settings/users` added inside `/settings/*` (inherits admin gate from `SettingsLayout`). Header username block converted from a `<div>` to a `<NavLink to="/profile">` with the same visual treatment.
- **Verification:** live read-only sanity ran the API surface end-to-end against `sytist-dashboard.db` — create test_user, edit display name + role, deactivate, reactivate, delete (soft), confirm last-admin guard fires when attempted against the lone joey admin. **Browser-side UI walkthrough is the operator's to perform** (the client builds + runs in their browser; this audit can't drive the React app live).
- **Scope explicitly out:** role-based permission differentiation (everyone is admin in practice today), password reset flow / forgot password (admin re-sets via UsersSettings), audit-by-user analytics, any change to the photo-thumb proxy's unauthenticated carve-out.
- Files: `server/services/authService.js`, `server/.env`, `client/src/App.js`, `client/src/components/AppLayout.js`, `client/src/pages/settings/SettingsLayout.js`, `client/src/pages/settings/UsersSettings.js` (new), `client/src/pages/ProfilePage.js` (new), `CLAUDE.md`

---

## Reversed / removed

- **Phase 31**: auto-push packaging during adopt — reversed in Phase 33 after it conflicted with the upstream "Sportsline UI" tool's payload

## Major architecture decisions captured

- Sytist write allow-list is **deliberately minimal**: status + 5 shipping columns on `ms_orders`, plus INSERT/soft-delete on `ms_notes`. Never touches schemas, indexes, or other ms_* tables.
- The dashboard **coexists** with upstream tools that push SS orders. Phase 33's "adopt without push" + manual "Push Packaging" button is the coexistence pattern.
- **Failure modes are non-blocking** for audit-style writes (ms_notes, order_status_audit). The action succeeds even if the log write fails; the operator just doesn't see the side effect entry.
- **Reprints are first-class** but use a different filename convention so original outputs are never overwritten. Numbered suffix (`_REPRINT_2`) protects against double-clicks producing collisions.
- **Green-screen compositing** runs in three places (composite engine, imposition, slip thumbs) so output is consistent regardless of how the line item routes.
- **Sytist's `cart_package` is unreliable**: as of Phase 39, package expansion happens via the dashboard's Settings → Packages config, not Sytist's flag.
- **Composed/composite thumbnails** have a single source of truth: the `composed_thumbnails` SQLite table holds the published URL per `(order_id, cart_id)`. Three destinations read from it: packing slip (local file preferred, URL fetched as fallback), ShipStation (URL goes into the SS payload's `imageUrl` field), and the dashboard's order detail page (URL becomes the line item card thumbnail).
- **Thumbnail backend is pluggable**: `composedThumbnailService` defaults to `skip` (no-op), can be switched to `s3-sytist` (or future backends) via Settings → API Keys → AWS S3. The publish call returns a URL (or null), which becomes the single source of truth for all downstream consumers.
- **Thumbnail cleanup is intentionally deferred**: storage cost is trivial and auto-cleanup races against operator visibility (Phase 44 hotfix 2). Cache rows and S3 objects persist indefinitely. A separate sweep job can be added later if needed.

## Known follow-ups (not yet phased)

- **Kirsten coexistence** (formerly listed as "Sportsline UI unidentified"): identified Phase 47 hotfix 2 as an upstream tool run by operator Kirsten that processes most production traffic outside our dashboard — 546 of 555 recently-processed composite-mapped orders flowed through it (ms_notes signed `"Kirsten"`). Phase 33's "adopt without push" already handles the SS-side coexistence. The open question is the workflow side: bring upstream-processed orders into our composite/audit/packaging pipeline, OR accept that we add value only for orders that come through us. Planning conversation, not code work.
- ms_notes UI doesn't currently distinguish system events from "this dashboard wrote it" vs "Sytist wrote it" — the `[Dashboard]` prefix is the only signal. Could be a colored badge in a future polish phase.
- Auto-fetch scheduler polls every 5 minutes; configurable in code only. Settings UI exposure would be useful.
- `_nextReprintNumber` scans only the regular download dir; doesn't see specialty subfolder reprints. Edge case — none observed in practice yet.
- **SS auto-shipping** (resolved Phase 47 hotfix 2 diagnosis): orders showed as `shipped` in SS within seconds of creation without a tracking number. Root cause was Kirsten's upstream tool creating SS orders that auto-fulfill via an SS workflow rule, not a bug in ours. Phase 33's "adopt without push" + Phase 44 hotfix 2's cache survival make the behavior benign cosmetic noise.
- **On-demand composite preview**: composite thumbnails only show after an order has been processed. Adding a "show me what this will look like" preview before processing would require calling the composite engine from a UI endpoint. Significant work, deferred.
- **S3 storage sweep**: with Phase 44 hotfix 2 removing auto-cleanup, S3 objects accumulate indefinitely. Cost is trivial at our scale (~$0.001/year/object) but if it ever matters, add a nightly sweep for objects > N days post-ship.
