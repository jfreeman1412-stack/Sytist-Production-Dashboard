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
- `processingService` composite loop checks `orderOverrideService.get(orderId, cartId)` BEFORE falling through to the SKU-based composite layout lookup
- When an override exists, that layout is used instead of the mapped layout; `subResult.composites[].layoutSource` is set to `'override'` or `'mapping'` so the operator can see which path was used
- "Save (no render)" button added to `OverrideEditorPage` — stages overrides for the next Process/Reprint without immediately rendering anything
- Files: `server/services/processingService.js`, `client/src/pages/OverrideEditorPage.js`

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

- The upstream "Sportsline UI" tool that creates phantom SS orders is unidentified as of Phase 37. Pinpointing it (likely a ShipStation Selling Channel) would let us either reconfigure or remove the workaround.
- ms_notes UI doesn't currently distinguish system events from "this dashboard wrote it" vs "Sytist wrote it" — the `[Dashboard]` prefix is the only signal. Could be a colored badge in a future polish phase.
- Auto-fetch scheduler polls every 5 minutes; configurable in code only. Settings UI exposure would be useful.
- `_nextReprintNumber` scans only the regular download dir; doesn't see specialty subfolder reprints. Edge case — none observed in practice yet.
- **ShipStation auto-shipping**: orders sometimes show as `shipped` in SS within seconds of creation, without a tracking number. Cause not yet diagnosed; could be an SS account workflow rule or a phantom shipment from a prior order with the same orderNumber. Phase 44 hotfix 2's removal of auto-cleanup makes this benign (cache survives), but the underlying cause is worth investigating.
- **On-demand composite preview**: composite thumbnails only show after an order has been processed. Adding a "show me what this will look like" preview before processing would require calling the composite engine from a UI endpoint. Significant work, deferred.
- **S3 storage sweep**: with Phase 44 hotfix 2 removing auto-cleanup, S3 objects accumulate indefinitely. Cost is trivial at our scale (~$0.001/year/object) but if it ever matters, add a nightly sweep for objects > N days post-ship.
