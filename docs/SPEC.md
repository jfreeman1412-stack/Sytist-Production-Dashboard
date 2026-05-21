# Sytist Production Dashboard — Spec

**Status:** Phase 16 shipped — production-capable. Original spec drafted 2026-05-08; this revision 2026-05-12.
**Author:** Joey Freeman + Claude

This spec documents both the original plan and the additions made through Phase 16. Phase headings in §13 are marked with their current status. New sections (§16–§20) cover work that happened after the original spec was drafted.

---

## 1. Purpose

Build a web-based production dashboard for processing **Sytist** orders into Darkroom-ready txt files, packing slips, and ShipStation shipments. Mirrors the architecture and visual design of the existing **Photo Day Dashboard**, but pulls order data from the Sytist MySQL database instead of the PhotoDay API.

Replaces the existing Python/Tkinter app over time. Python app keeps running until the new dashboard is fully proven.

## 2. Goals & Non-goals

**Goals**
- Process Sytist orders into Darkroom txt files, 5×8 packing slip JPGs, and ShipStation shipments.
- Provide a live production view: Queue / In Progress / Needs Attention / Shipped, with filters and bulk operations.
- Reuse battle-tested logic from the Photo Day Dashboard (packaging, ShipStation, imposition, folder sort, etc.).

**Non-goals**
- Modifying the existing Photo Day Dashboard. Code is *copied*, not shared.
- Modifying the existing Python app — it stays running in parallel.
- Writing to `ms_order_status_logs` (owned by an existing Sytist DB automation).
- Building any reporting/analytics features beyond what the Photo Day Dashboard already has.
- Multi-tenancy — Sportsline-specific.

## 3. Architecture

| Layer | Choice |
|---|---|
| Server | Node.js + Express |
| Client | React (Create React App, mirroring photo day project) |
| Sytist DB (read/write) | MySQL on droplet, via public 3306 in dev |
| Own DB (tracking, audit, schedules) | SQLite, local file in `server/config/` |
| Config | JSON files in `server/config/` |
| Auth | Same pattern as photo day dashboard — username/password, session-based |

**Project location:** `C:\Users\Sportsline\Downloads\sytist-dashboard\sytist-dashboard\`

**Git:** New private GitHub repo, same account as photo day dashboard. Suggested name: `sportsline-sytist-dashboard`.

**Hosting:**
- Dev: Joey's Windows machine, connects to droplet MySQL over public 3306.
- Production (later): Docker container on the Sytist droplet, MySQL via internal Docker network. Public 3306 closes at that point.

## 4. Code reuse — Option A: copy & adapt

These services are **copied** from `sportsline-dashboard/server/services/` into the new project and consume the canonical order shape (§5) via an adapter:

```
darkroomService.js          ← unchanged
packingSlipService.js       ← extended (see §6)
shipstationService.js       ← unchanged
packagingService.js         ← unchanged
impositionService.js        ← unchanged
folderSortService.js        ← unchanged
specialtyService.js         ← unchanged
qrcodeService.js            ← unchanged
printSheetService.js        ← unchanged
schedulerService.js         ← polls Sytist DB instead of PhotoDay API
authService.js              ← unchanged
middleware/auth.js          ← unchanged
database.js (SQLite setup)  ← pattern only, fresh schema
orderDatabase.js            ← adapted to canonical shape
```

**Two copies, drift accepted.** When ShipStation/packaging logic is improved in the photo day dashboard, manually backport to sytist dashboard. Don't symlink, don't share at the filesystem level.

## 5. Canonical order shape

Both Sytist and (eventually) PhotoDay produce this shape via per-source adapters. The Sytist data layer queries MySQL, builds objects in this shape, hands them to downstream services. Downstream services consume only this shape.

```js
{
  source: "sytist",                           // or "photoday"
  orderId: "110760",
  orderNumber: "110760",
  orderDate: "2026-05-08T11:40:00Z",
  paymentStatus: "Completed",

  // Sytist's order_open_status mapped via ms_order_status table
  productionStatus: { id: 0, name: "" },      // 0/empty = Queue
                                              // 40 = "Printing and Production"
                                              // 39 = "Shipped" — etc.
  orderStatus: 0,                             // Sytist: 0 Open / 1 Archived / 2 Trashed

  customer: {
    firstName, lastName, email, phone,
    businessName                              // optional
  },

  shipTo: {
    firstName, lastName,
    address1, address2,
    city, state, zip, country,
    phone, businessName                       // optional
  },

  shipping: {
    optionName: "USPS-Ship to Home",
    cost: 12.50,
    workflow: "shipstation" | "managers" | "one_contact"
                                              // sytist-derived from cost:
                                              //   > 1.01  → shipstation
                                              //   = 1.00  → managers
                                              //   < 1.01  → one_contact
                                              // photoday: always "shipstation"
  },

  // Sytist-specific subject info, populated from order_extra_field_*/order_extra_val_*
  // Fields are dynamic; only populated when the gallery defines them
  subject: {
    fields: [                                 // ordered list of {label, value}
      { label: "Athlete's Name",    value: "Lincoln Zubert" },
      { label: "Sport",             value: "Trap" },
      { label: "Coach",             value: "Edgington" },
      { label: "Team and Level",    value: "Pact Varsity" },
      { label: "Jersey Number",     value: "" }
    ]
  },

  // Gallery breadcrumb — leagues > schools > galleries > sub-galleries
  // Built from ms_blog_categories cat_under_ids walk + ms_calendar.date_title
  galleryPath: [
    "Photo Day Galleries",                    // top-level section
    "PACT Charter School",                    // ms_blog_categories
    "Trap",                                   // ms_blog_categories sub
    "2026 PACT Trap Photo Day"                // ms_calendar.date_title
  ],

  // Optional sub-gallery (team/event within the gallery)
  subGalleryName: "Pact Trap",                // ms_sub_galleries.sub_name

  // Each row is one cart line (ms_cart row), with photo + product
  lineItems: [
    {
      cartId: 482134,
      productName: "5x7 Individual Photo",
      sku: "10",                              // cart_sku (string)
      qty: 1,
      size: "5x7",                            // resolved via size-mappings.json
      productType: "photo_print",             // or "package", "download", "specialty", etc.

      // Photo info — populated when cart_pic_id > 0
      photo: {
        picId: 4523123,
        originalFilename: "Pact_Trap-0067.jpg",
        s3Url: "https://endpoint/bucket/folder/full.jpg",
        // local path filled in after download
        localPath: null
      },

      // Cart options (image options selected during checkout)
      options: [
        { name: "Add on High Resolution Download", price: 0 }
      ],

      // Pre-selling flags (carried for inspection; workflow TBD)
      preSell: false,
      preSold: false,

      // Sub-gallery context — denormalized so each line knows its team
      subGalleryName: "Pact Trap"
    }
  ],

  // Sibling order detection — true when one orderId has cart lines from multiple
  // distinct sub-galleries (a parent ordering for multiple kids on different teams)
  isSibling: false,

  customerNotes: "",
  adminNotes: ""
}
```

**Notes:**

- `subject.fields` is an array, not a fixed object. Galleries set 0–5 extra fields with arbitrary labels; we display whatever's there. Empty values still render their label (matches Sytist behavior).
- `galleryPath` is a hierarchical breadcrumb. For Sytist, computed from `ms_blog_categories.cat_under_ids`. For PhotoDay, flat.
- `productionStatus.id` writes back to `ms_orders.order_open_status`. The dashboard never writes to `ms_order_status_logs`.

## 6. Packing slip — extended

Start from photo day's `packingSlipService.js` (5×8 @ 300 DPI, dynamic thumb sizing). Extend:

- **Code 128 barcode** in header right, encoding `orderNumber`. Use `bwip-js` (Node lib for barcode generation) — replaces or supplements the existing QR code.
- **Branded "Order More" graphic** — configurable PNG referenced in `server/config/`.
- **Subject info block** — renders `subject.fields[]` between addresses and items. Label/value pairs, one row per field. Empty values show label only.
- **Gallery breadcrumb** — small text under each line item, joined with ` > `, prefixed with `In `. Renders only when `galleryPath` is non-empty.
- **Letterhead** — Sportsline studio info at top-left. Populate from a config file rather than from a PhotoDay studio object.

## 6.5 Composition system (Phase 8+)

A second image-rendering engine, separate from `impositionService.js`. Where imposition handles "N copies of one image on a sheet" (8 wallets, 2 magnets), composition handles **multi-image layered composites** for products the customer cannot design themselves in the Sytist cart.

**The two engines coexist.** A SKU maps to one or the other (or neither). `template-mappings.json` is extended to point at composition templates as well as imposition templates. Phase 4 ships imposition (copied from photo day). Phase 8+ ships composition.

**Examples requiring composition:** Memory Mate (individual photo + team photo + overlay graphic + logo on 8x10). Roughly 20 SKUs out of ~40-50 in the catalog.

**Output:** single-page sheet only. No multi-page composites in v1.

### Slot types

```
individual_photo   ← the photo on this cart line
team_photo         ← resolved per-order (see §6.5.1)
overlay_image      ← static PNG, asset uploaded to dashboard
logo               ← per-gallery PNG/JPG (see §6.5.2)
text               ← static text or variable substitution
```

### Template JSON shape

```js
{
  templateId: "memory_mate_v1",
  name: "Memory Mate",
  appliesToSKUs: ["6"],                     // mapped via template-mappings.json
  outputSize: { width: 8, height: 10, dpi: 300 },

  variants: {
    vertical: {                             // chosen when individual photo is portrait
      slots: [
        { type: "individual_photo", x: 0.5, y: 0.5, w: 4, h: 5, rotation: 0 },
        { type: "team_photo",       x: 0.5, y: 6,   w: 7, h: 3.5 },
        { type: "overlay_image",    x: 0,   y: 0,   w: 8, h: 10,
          asset: "overlays/memory_mate_v1.png" },
        { type: "logo",             x: 6.5, y: 0.5, w: 1, h: 1,
          asset: "$JOB_LOGO" },             // resolves to gallery's assigned logo
        { type: "text",             x: 1,   y: 9,   w: 6, h: 0.4,
          text: "{customer.firstName} {customer.lastName}",
          font: "Arial", size: 24, color: "#000000",
          align: "center", verticalAlign: "middle",
          bold: false, italic: false,
          autoFit: { enabled: true, minSize: 10, maxSize: 32 } }
      ]
    },
    horizontal: { slots: [ /* ... */ ] }    // chosen when individual photo is landscape
  }
}
```

Coordinates in inches. Multiplied by DPI internally (matches photo day imposition convention).

### Variant selection

Read individual photo orientation from `ms_photos.pic_width` and `pic_height`:
- `pic_width >= pic_height` → use `horizontal` variant
- `pic_width < pic_height` → use `vertical` variant

### Variable substitution in text slots

Simple flat substitution from a documented variable list. No conditional logic in v1. Variables resolved against the canonical order shape (§5):

```
{customer.firstName}      {customer.lastName}
{customer.email}          {customer.phone}
{subject.athleteName}     {subject.coach}        ← from subject.fields[]
{subject.team}            {subject.sport}        ← keys derived from labels
{galleryName}             {subGalleryName}
{order.id}                {order.date}
{year}                    {date}
```

Field labels in `subject.fields[]` get normalized to camelCase keys for substitution (e.g. "Athlete's Name" → `athleteName`, "Team and Level" → `teamAndLevel`).

### Auto-fit text

When `autoFit.enabled = true`, text shrinks to fit within the slot width × height, between `minSize` and `maxSize`. Implementation: measure-then-render loop using Sharp's text rendering. Falls back to truncation at `minSize` if text still doesn't fit.

### 6.5.1 Team photo resolution

Per cart line, find the team photo:

1. **Filter to this gallery first** — `ms_blog_photos.bp_blog = cart.cart_pic_date_id`. **This is critical** — multiple leagues have teams named "11U" / "12U" etc. Scoping to the gallery prevents collisions.
2. **Within that gallery, find photo whose `pic_org` matches `{sub_gallery_name}.jpg`** (case-insensitive) where sub_gallery_name comes from `ms_sub_galleries.sub_name` for the cart's `cart_sub_gal_id`.
3. **Optional backstop:** filter by team-photo price list. Configurable in Settings (`teamPhotoPriceListId`). Default off; enable if filename-only matching ever produces wrong results in production.

If no match found, the composition fails for that line item with a clear error. Operator sees it in the failed orders log and can manually intervene.

### 6.5.2 Per-gallery logo assignment

Logos are assigned per `ms_calendar.date_id` (the specific photo day event, e.g., "2026 PACT Trap Photo Day"). Different events under the same league/category can have different logos.

Storage: dashboard's local SQLite, table `gallery_logo_assignments`:
```
date_id        INT     -- ms_calendar.date_id
logo_file      TEXT    -- relative path under server/assets/logos/
assigned_at    DATETIME
assigned_by    TEXT    -- username
```

Composition resolves `$JOB_LOGO` per cart line: look up gallery via `cart_pic_date_id` → look up assignment → use that logo file.

If no logo assigned, the slot renders empty (transparent). No error.

## 6.6 Visual template editor (Phase 10)

Browser-based canvas editor for creating and editing composition templates.

**Capabilities:**
- HTML5 canvas with drag handles per slot
- Slot list panel: add/delete/reorder slots, click to select
- Properties panel: position, size, rotation, slot-type-specific fields
- Variant switcher: edit vertical and horizontal layouts side-by-side or independently
- Asset picker: choose from uploaded overlays, logos, fonts
- Preview render: pick a sample order, render the template against its data, see actual output before saving
- Save/duplicate/delete templates

**Out of scope for v1:**
- Multi-page templates
- Conditional slot visibility (e.g. "show this slot only if subject.jerseyNumber is set")
- Animation, gradients, complex effects beyond the basic text formatting

**Implementation note:** the canvas is a planning surface — coordinates and properties get saved as JSON. The actual rendering (for both preview and production output) goes through Sharp on the server using the same JSON-driven path. The canvas never produces the final image; it's purely for authoring.

## 6.7 Asset management (Phase 9)

Upload UI in Settings → Assets, three sections (overlays, logos, fonts). Each section:

- File picker → upload to `server/assets/{type}/`
- List of currently uploaded files with thumbnail (for images) or name preview (for fonts)
- Delete with confirmation
- Storage paths visible for debugging

**Validation:**
- Overlays: PNG only, transparency expected
- Logos: PNG or JPG
- Fonts: TTF or OTF

**Logo assignment** lives on a separate page (Galleries → Logo Assignments) where operator picks a gallery and assigns one logo. Bulk assign by category (e.g. "assign Anoka logo to all 2026 Anoka galleries") is a Phase 12 polish item.

## 6.8 Re-render workflow — Flow B1 (Phase 11)

When a composed render is wrong, the operator can re-render with overrides for that single order, without affecting other orders using the same template.

**UX flow:**
1. Operator opens an order in Order Detail
2. Sees a thumbnail of the rendered composite for each composition line item
3. Clicks "Re-render with edits" on a thumbnail
4. Visual template editor opens, **pre-populated with this order's data** (the actual individual photo, team photo, logo, substituted text)
5. Operator tweaks slot positions/sizes/content as needed
6. Clicks "Save & re-render" — the override is stored on the order, the composite re-renders, and the new file replaces the old in the print folder
7. The Darkroom txt is regenerated to point at the new file

**Storage:** override JSON stored on the order in dashboard's SQLite (`order_render_overrides` table), keyed by `(orderId, cartLineId)`. The override is a full template JSON with this order's specific slot values baked in — not a diff. Simpler to reason about, slightly larger storage footprint, fine.

**The original template is never modified by per-order edits.** Only the override on this specific order changes.

## 7. Schedulers — both

**Auto-fetch (continuous):** every N minutes (default 5), poll Sytist DB for newly-completed orders matching the active workflow filter. Insert/upsert into the dashboard's own SQLite for tracking. Update counts in UI.

**Scheduled batch (specific times):** at HH:MM daily/weekday, run the full pipeline (download images → write CSVs/txt → generate packing slips → optionally create ShipStation orders) for orders matching the schedule's filter. Schedule defs live in dashboard's SQLite (mirrors Python `ScheduledRun`).

## 8. Three shipping workflows

Sytist's `order_shipping` cost determines the workflow:

| Condition | Workflow | Behavior |
|---|---|---|
| `> 1.01` | `shipstation` | Full pipeline → ShipStation order + shipment + batch |
| `= 1.00` | `managers` | Build files for Darkroom, **skip** ShipStation |
| `< 1.01` | `one_contact` | Build files for Darkroom, **skip** ShipStation |

The dashboard exposes a workflow filter (default: `shipstation`). Manual single-order send works across all workflows; the ShipStation step is conditional on workflow.

## 9. Data layer — sytistDbService.js

Single Node module, uses `mysql2/promise`. Public surface (initial):

```js
getOrdersByWorkflow(workflow, opts)       // canonical[]; pagination, status filter
getOrderById(orderId)                     // canonical | null
updateOrderStatus(orderId, statusId)      // writes ms_orders.order_open_status
getOrderStatusList()                      // ms_order_status rows
getGalleryHierarchy()                     // for filter dropdowns
healthCheck()                             // connection test
```

**Internal queries replace the Python's flat SQL.** Build proper nested JS objects instead of pandas-shaped row-per-line-item DataFrames. Joins involve `ms_orders + ms_cart + ms_cart_options + ms_photos + ms_sub_galleries + ms_calendar + ms_blog_categories`.

The Python query in `database.py` is a useful reference for which columns matter; the new JS queries are a rewrite, not a port.

## 10. Local SQLite — what we store

Mirrors photo day patterns. Tables (initial — extend as needed):

- `users` — auth (mirror photo day)
- `orders_tracked` — local cache of orders we've seen, with processing state, file paths, ShipStation IDs, last-fetched timestamp
- `order_actions` — audit log of every dashboard-driven action
- `schedules` — scheduled batch run definitions
- `schedule_runs` — history of scheduled runs (start/end, counts, errors)

We do **not** duplicate Sytist data into SQLite. We cache enough to render the UI quickly and track local-only state.

## 11. JSON config files

Mirroring photo day project layout in `server/config/`:

```
app-settings.json          ← UI/runtime preferences
filename-config.json       ← txt file naming rules
folder-sort.json           ← folder hierarchy config
imposition-layouts.json    ← imposition presets
packaging-config.json      ← magnet thresholds, package SKU lists
path-overrides.json        ← per-gallery path tweaks
size-mappings.json         ← SKU → print size LUT
specialty-products.json    ← specialty SKU list + highlight colors
template-mappings.json     ← product → .crd template path

# Sytist-specific additions:
sytist-status-map.json     ← ms_order_status.status_id → dashboard category
                              (e.g. 0 → "queue", 40 → "in_progress", 39 → "shipped",
                              12,28,73 → "needs_attention")
```

DB connection lives in `.env` (server-side only), with a Settings UI tab to edit at runtime.

## 12. UI — pages

Mirroring photo day:
- `LoginPage` — same pattern
- `Dashboard` — counts, charts, quick actions, with workflow filter
- `OrdersPage` — list view: filterable, bulk-selectable, action toolbar; clicks open detail
- `SettingsPage` — tabs for Setup (creds, DB connection), Paths, Folder Sort, Packaging, Specialty, Size Mappings, Template Mappings, Schedules
- `ShipStationPage` — same pattern (purge awaiting, etc.)
- `PrintSheetsPage` — same pattern

Sytist-specific additions:
- Workflow tabs/filter (ship-to-home / managers / one-contact)
- Order detail view with subject info, gallery breadcrumb, sibling indicator, photo thumbnails per line item
- Status update controls writing back to `ms_orders.order_open_status`

## 13. Build phases

Each phase ends in something runnable and verifiable. **Phases 0-7 ship a working dashboard for orders that don't need composition** (the majority of daily volume). Phases 8-11 add composition incrementally on top.

**Phase 0 — Bootstrap (½ day) — ✅ shipped**
Project folder, package.json (server + client), `.gitignore`, `.env.example`, README. Empty Express server runs; empty React app loads at /. Init git, push to private GitHub repo.

**Phase 1 — Auth (½ day) — ✅ shipped**
Copy `authService.js`, `middleware/auth.js`, login route + page from photo day. Confirm login works against a local SQLite users table.

**Phase 2 — Data layer (1–2 days) — ✅ shipped**
`sytistDbService.js` with the public surface in §9. Connection via `.env`, configurable in Settings later. Test queries against the live droplet DB; verify canonical shape with real data. A `/api/orders/test` endpoint that returns 5 recent orders as JSON for visual inspection.

**Phase 3 — Read-only UI (1 day) — ✅ shipped**
Orders list page populated by `sytistDbService`. Filters: workflow, production status, date range, gallery. Detail view (no actions yet, just display).

**Phase 4 — Pipeline port (2–3 days) — ✅ shipped**
Copy darkroom, packing slip, packaging, folder sort, specialty, **imposition**, qrcode services. Extend packing slip per §6 (barcode, subject info, breadcrumb, branded graphic). Add a "Process this order" button on order detail that runs the full pipeline locally (no ShipStation yet). Verify Darkroom txt + packing slip JPG + multi-up imposition (8 wallets, 2 magnets, etc.) produced correctly for a real Sytist order. **Composition products fail gracefully with a clear "needs composition (Phase 8)" message until Phase 8 ships.**

**Phase 5 — ShipStation (1 day) — ✅ shipped**
Copy `shipstationService.js`, wire to "Process" action for `shipstation` workflow only. Verify with a single order end-to-end.

**Phase 6 — Schedulers (1–2 days) — ✅ shipped**
Auto-fetch poll every 5 min. Scheduled batch with HH:MM definitions. UI for schedule management.

**Phase 7 — Status writeback (½ day) — ✅ shipped**
"Mark as Printing" / "Mark as Shipped" buttons → write to `ms_orders.order_open_status`. Confirm Sytist's automation picks it up correctly.

**━━━ Composition system (Phases 8–11) ━━━**

**Phase 8 — Composition engine (3–4 days) — ✅ shipped**
`compositionService.js` with JSON-driven templates per §6.5. Slot types, variant selection from photo orientation, variable substitution, auto-fit text, team photo resolution per §6.5.1. Templates authored as hand-edited JSON files for now (no UI). Hook into pipeline so SKUs mapped to composition templates render via this engine instead of producing the "needs composition" failure from Phase 4.

**Phase 9 — Asset upload + logo assignment (2 days) — ✅ shipped**
Upload UI per §6.7 (overlays, logos, fonts). Per-gallery logo assignment UI per §6.5.2. `$JOB_LOGO` resolution wired into composition engine.

**Phase 10 — Visual template editor (5–7 days) — ✅ shipped**
Canvas-based editor per §6.6. Drag handles, properties panel, variant switcher, asset picker, sample-order preview render. Users can author and edit composition templates without hand-editing JSON.

**Phase 11 — Per-order re-render (Flow B1) (1–2 days) — ✅ shipped**
Per §6.8. Re-render with overrides for a single order using the visual editor pre-populated with that order's data.

**━━━ Polish ━━━**

**Phase 12 — Polish — ✅ shipped**
Dashboard analytics, production overview charts, gallery breakdown, quick actions, folder sort UI, specialty highlight colors, paths config with dynamic variable substitution.

**━━━ Post-spec phases ━━━**

Phases 13 through 16 happened after the original spec was drafted. See §16–§20 below for details. Quick summary:

**Phase 13 — Packaging engine — ✅ shipped**
ProductWeights + packageBundles config (Settings → Packaging). Drives shipping weight calculation per order.

**Phase 14a — Orders list count fix — ✅ shipped**
Workflow filter applied in SQL rather than JS post-LIMIT.

**Phase 14b — Prev/Next navigation — ✅ shipped**
Order detail page has Prev/Next buttons + arrow-key shortcuts. Filter context preserved across navigation.

**Phase 15a — Package explosion — ✅ shipped**
Configurable map from package SKU → constituent items. Pipeline emits synthetic line items for each constituent so composite/imposition/slip see them.

**Phase 15b — Add-on explosion — ✅ shipped**
Configurable map from `ms_cart_options.co_opt_id` → SKU. Pipeline emits synthetic line items for mapped options.

**Phase 15c — Add-on qty + modifier suffixes — ✅ shipped**
Add-ons can have a qty > 1 (e.g. "Add 2 5×7s" → qty 2). New modifier type appends a suffix to the parent's product name instead of synthesizing a new line.

**Phase 16 — SQLite migration + audit history — ✅ shipped**
addon-mappings.json and package-contents.json moved to SQLite tables. Unified config_history table records every settings change. Export/import endpoints. HistoryModal UI per row.

Total estimate to Phase 11 from the original draft: roughly 3–5 weeks. Actual: similar range, with phases 12–16 layered on top over the following weeks.

## 14. Open questions / deferred decisions

These don't block starting; we resolve as we hit them.

1. **`sytist-status-map.json` initial content.** Statuses 12, 28, 73 all = "needs attention" but with different meanings. Single bucket, or three sub-buckets in the UI?
2. **Packing slip override for managers/one-contact workflows.** Same slip layout, or simplified for non-ShipStation flows?
3. **Image download — S3 direct vs through Sytist.** Sytist photos are on S3 with public URLs in our queries. Use directly (faster) or proxy through Sytist (auth-ready)?
4. **Pre-sell / pre-sold workflow.** Cart flags exist; behavior TBD. Probably ignore in v1.
5. **Sibling orders folder structure.** Python uses `Sibling-{order_id}` under the gallery. Keep or revise.
6. **Multi-user concurrency.** Probably needed eventually. Defer until phase 12.
7. **HTTPS in production.** Caddy reverse proxy already on droplet — extend its config when deploying.
8. **Team photo lookup — price list backstop.** Phase 8 ships with gallery-scoped filename matching only. If filename collisions ever produce wrong team photos in production, enable optional `teamPhotoPriceListId` filter from Settings.
9. **Flow A re-render** (edit template, re-render all affected orders). Listed as Phase 12 polish. Decision: ship Phase 11 (per-order overrides) first, evaluate need for Flow A based on operational experience.
10. **Template versioning.** When a template is edited via the visual editor, do we keep the old version for orders previously rendered with it, or allow re-rendering against the new version? Phase 10 question.

## 15. Out of scope (today)

Discussed and deferred:
- Migrating other-droplet integrations to containers (separate project)
- Locking down 3306 (after dashboard moves to droplet)
- Rotating MySQL passwords (security followup)
- Configuring PHP error log outside webroot (security followup)
- Removing `smsapp/backup.php` from webroot (security followup)
- Rotating Twilio/Plivo credentials (security followup)
- Reviewing `dbscreenpop/.htaccess` (security followup)
- Full charset migration to utf8mb4 (latent risk)

---

## 16. Packaging engine (Phase 13)

Drives shipping weight calculation per order, used by both the slip and the ShipStation submission.

**Config:** `server/config/packaging-config.json`

```js
{
  productWeights: {
    "<sku>": {
      name: "...",
      weight: 1.7,           // ounces, per individual item
      category: "flat" | "bulky" | "digital",
      externalId: "..."      // links to composite/imposition mappings
    }
  },
  packageBundles: {
    "<package_sku>": {
      name: "Gold Package",
      weight: 0              // bundle base weight; constituents now carry weight (Phase 15a)
    }
  }
}
```

**Categories:**
- `flat` — counted in standard envelope weight calculation
- `bulky` — triggers larger packaging
- `digital` — excluded from production AND shipping calculations

**Slip + ShipStation behavior:**
- Slip totals up `Σ qty × weight` across all materialized line items
- ShipStation `weight.value` set to the same total
- Bundle weight is 0 because Phase 15a's package explosion now emits constituent items, each carrying their own weight from `productWeights`

UI: Settings → Packaging. Per-SKU editor with name + weight + category + externalId. Searchable. Add/delete rows.

## 17. Order navigation (Phase 14)

### 17a. Workflow count fix

The original orders-list endpoint applied workflow filtering in JS *after* a SQL `LIMIT 50`, which meant the "N orders match" count was wrong whenever a page included rows that didn't pass the workflow filter.

Fixed by translating the workflow filter into a SQL predicate using `SHIPPING_OPTION_MAP` (configured in Settings → Shipping) plus a numeric `order_shipping` fallback for the three workflow buckets defined in §8.

### 17b. Prev/Next navigation

Order detail page got Prev/Next buttons + arrow-key shortcuts (left/right). The filter context (workflow, productionStatus, sort) is preserved across navigation via:

- A `getOrderNeighbors(orderId, opts)` method in `sytistDbService` that runs 6 small SQL queries against the filtered set: anchor lookup, total count, in-set check, before-count, next, prev. Stable order_id ASC tiebreaker so consecutive Prev/Next stays in sync with the list page.
- A `GET /api/sytist/orders/:orderId/neighbors` endpoint
- An `OrdersListPage` that forwards filter context (workflow, productionStatus, sort) to the detail page
- A `BackLink` component on the detail page that routes back to `/orders?<filters>` rather than `navigate(-1)`

This was where we hit MySQL on the droplet rejecting `before` as a column alias (it's a reserved word in this MySQL version) — fixed by renaming to `before_count`.

## 18. Package and add-on explosion (Phase 15)

The Sytist data model represents packages and add-ons as **single ms_cart rows** — the customer buys a "Gold Package" or a "Memory Mate + Frame", and that's one cart line. But the production pipeline needs to see each constituent item separately to composite, impose, print, and slip. Phase 15 introduces the **explosion** layer that bridges this gap.

### 18a. Package explosion

**Config:** moved to SQLite in Phase 16. Storage: `packages` + `package_items` tables.

Shape:
```
packages         (package_sku PK, name, ...)
package_items    (id, package_sku FK, item_sku, qty, sort_order)
```

Settings UI: Settings → Packages. Per-package card with:
- Editable name
- Items list (SKU + qty per row, picked from productWeights)
- Add-item dropdown
- Per-item warnings (missing composite/imposition mappings)
- Per-card Save + Delete buttons
- Lint panel showing config-wide warnings

**Pipeline integration:**
- `sytistDbService._loadPackageMap()` loads the config once per query
- `_expandPackageLineItems(lineItems, packageMap)` walks line items, for each row with `flags.package === true` it:
  1. Emits the parent line item unchanged (with `flags.isPackageHeader = true`) so the slip and detail page still show "1× Gold Package"
  2. Emits one synthetic line item per constituent
- Synthetic items have:
  - `cartId = "<parent>-pkg-<sku>"` (string, unique within the order)
  - `sku` from the mapping
  - `qty = constituent.qty × parent.qty`
  - `price = 0` (parent carries the bundled price)
  - `photo` / `gallery` / `subGallery` inherited from parent
  - `flags.isPackageItem = true`, `flags.packageParentCartId`, `flags.packageParentSku`
  - `flags.download = true` if mapped SKU has `category = "digital"`

SKIP_FLAGS were extended to include `isPackageHeader` so the parent doesn't trigger production work (just slip display) and the constituents do all the production.

### 18b. Add-on explosion

Sytist add-ons live in **ms_cart_options**, not ms_cart. Each has `co_opt_id` (option type), `co_opt_name` (display), `co_price` (customer paid).

**Config:** in SQLite as of Phase 16. Storage: `addon_mappings` table.

```
addon_mappings   (opt_id PK, type, name, sku, qty, suffix, ...)
```

Two mapping types (Phase 15c):

**Product type** — synthesizes a production line item.
```json
{ "type": "product", "name": "2 Magnets", "sku": "15", "qty": 1 }
```

**Modifier type** — appends a suffix to the parent line's product name.
```json
{ "type": "modifier", "name": "Frame", "suffix": " (Framed)" }
```

The suffix flows naturally to:
- Darkroom .txt's item description (whatever's in `productName`)
- Packing slip's product name area, with a yellow `+ Frame` highlight rendered below

Settings UI: Settings → Add-ons. Three sections:
1. **Discovery panel** — co_opt_id values seen in recent orders that aren't mapped yet, sorted by occurrence. "Scan more orders" button ladders 500 → 1000 → 2000 → 5000.
2. **Configured mappings** — table with type dropdown, name, dynamic fields (SKU+qty for product, suffix for modifier), save/delete per row.
3. **Manual add** — type chip selector, fields per type, add button.

**Pipeline integration:** runs AFTER package explosion. Walks each line item, for each option:
- **No mapping** → option stays as a `text` entry on `lineItem.options[]` (visible on slip + detail page, not materialized)
- **Mapping = product** → emit synthetic line item:
  - `cartId = "<parent>-addon-<coId>"`
  - `sku`, `qty` from mapping
  - `price = co_price` (the actual add-on price)
  - inherited photo / gallery / subGallery
  - `flags.isAddonItem = true`, `flags.addonParentCartId`, `flags.addonOptId`
  - `flags.download = true` if mapped SKU is digital
- **Mapping = modifier** → don't emit a new line; instead, on the parent line:
  - Append `mapping.suffix` to `productName`
  - Push `{name, suffix, price}` into a new `modifiers[]` array (used by the slip for the yellow highlight)

**Discovery query** scans recent paid+non-erased orders for `co_opt_id` values not in the addon_mappings table. Default scan: 500 orders. Cap: 5000.

**MySQL version quirk:** the discovery query originally used `LIMIT` inside an `IN (subquery)`, which the droplet's MySQL rejects (error 1235 `ER_NOT_SUPPORTED_YET`). Split into two queries (fetch recent order IDs first, then options joined to that ID list).

## 19. SQLite migration + audit history (Phase 16)

Three configs moved from JSON files to SQLite:

1. **addon-mappings.json** → `addon_mappings` table
2. **package-contents.json** → `packages` + `package_items` tables
3. **order_overrides** (already in SQLite since Phase 11) — audit history hooks added

Plus shared infrastructure:
- `config_history` table — polymorphic on `config_type` ('addon_mapping' | 'package' | 'order_override') and `entity_id`. Records prev_value + new_value JSON snapshots per action.
- `configHistoryService.js` — `record({...})`, `list({...})`, `recent({...})` helpers
- `HistoryModal.js` (client) — reusable timeline viewer with side-by-side prev/new diff
- Export/import endpoints per config: `/api/sytist/<config>/export` (GET download), `/api/sytist/<config>/import` (PUT replace)

### Why move these specifically

Three classes of problems:

1. **Nodemon restart loop.** Writing to a `.json` file in `server/config/` was triggering nodemon to restart the dev server mid-request, killing in-flight queries with proxy ECONNRESET. SQLite writes don't have this problem. (Belt-and-suspenders: `server/nodemon.json` also explicitly ignores `config/` and all `.json` files.)

2. **Race conditions on concurrent edits.** "Read whole JSON, mutate in memory, write whole JSON" is a classic lost-update pattern. SQLite handles concurrent writes via locking.

3. **No audit history.** Operators want to know who changed what.

### Migration mechanics

On every server boot, `databaseService.init()` calls `_createSchema()` then `_migrateJsonConfigs()`:

1. For each migrated config, check if its SQLite table is empty
2. If yes AND the JSON file exists, read it, INSERT each row in a transaction
3. Rename the JSON file to `<name>.json.migrated` so it won't get re-imported
4. Log the migration

Idempotent. Safe to boot repeatedly. The `.migrated` files are kept as rollback artifacts.

### Audit history shape

Every write to one of the three migrated configs records a row:
```
history_id   PK auto
config_type  'addon_mapping' | 'package' | 'order_override'
entity_id    opt_id, package_sku, or "<orderId>:<cartId>"
action       'insert' | 'update' | 'delete'
prev_value   JSON snapshot before (null for insert)
new_value    JSON snapshot after (null for delete)
changed_at   ISO timestamp
changed_by   username from req.user (null if no auth context)
```

Diffs are computed in the service layer — only entities whose shape actually changed get history rows. Bulk save of an unchanged config doesn't generate noise.

UI: a 📜 button per row (Add-ons) or per package card (Packages) opens HistoryModal, which calls `GET /api/sytist/config-history?type=...&id=...` and renders the timeline.

### Export/import

Per-config endpoints:
- `GET /api/sytist/addon-mappings/export` — returns the current config as a JSON download
- `PUT /api/sytist/addon-mappings/import` — accepts a JSON body, replaces the config wholesale (recorded in audit history)
- `GET /api/sytist/package-contents/export` / `PUT .../import` — same pattern

UI: ↓ Export and ↑ Import buttons in the page header. Import shows a confirmation prompt with the entity count.

**Known issue:** the export button uses `<a>.click()` for the download, which doesn't carry the session header. The endpoint then 401s and redirects, which the browser interprets as "go to homepage." Workaround: fix later by fetching the JSON via the authenticated `api.get()` and constructing a blob URL.

## 20. Open items / next phases

Pulled from the working notes:

- **Real production end-to-end test** of all the explosion changes for a Gold Package order. Verify composite, imposition, slip, and Darkroom .txt all produce correct output with synthetic line items mixed with regular ones.
- **Visual grouping on order detail + slip** — indent constituent items under their parent so the structure is obvious at a glance. Currently they're a flat list with the same gallery/sub-gallery as the parent.
- **Export endpoint auth fix** — see §19 known issue.
- **Migration of remaining JSON configs to SQLite** — following the same pattern as Phase 16. Candidates: `packaging-config.json`, `size-mappings.json`, `composite-mappings.json`, `imposition-config.json`, `shipping-option-mappings.json`, `path-overrides.json`, `processing-settings.json`, `darkroom-settings.json`. Not urgent — these are written rarely, so the original motivations (nodemon, concurrency, audit) don't bite as hard. But the pattern is established.
- **Discovery panel cleanup** — the diagnostic `[discovery] start / querying / got / done` logs from Phase 15b hotfix-3 are still in. Remove once the feature feels solid.
- **Trading Cards SKU mapping (35)** — needs an imposition mapping; lint warned about this. Resolution pending operator config.

---

## 21. Green-screen compose at the composite layer (Phase 17)

Sytist's green-screen products store the customer's photo as a transparent PNG (subject already keyed out) and a chosen background photo ID in `ms_cart.cart_photo_bg`. The dashboard's canonical line item shape surfaces these as:

- `lineItem.flags.greenScreen` (boolean)
- `lineItem.backgroundPhoto.fullUrl` (string)

`greenscreenService.composeWithBackground(subjectBuffer, backgroundUrl, options)`:
- Fetches the background URL
- Resizes it with `sharp` `fit: 'cover'` to match the subject's dimensions
- Composites the subject on top at (0,0) — the subject's alpha channel reveals the background
- Returns a buffer + warnings array

Failure modes:
- No `backgroundUrl` → returns subject-only with a `background_url_missing` warning
- Background fetch fails → returns subject-only with a `background_fetch_failed` warning
- Resize fails → returns subject-only with a `background_resize_failed` warning
- Subject metadata read fails → throws

`greenscreenService.shouldComposite(lineItem)` returns true when both `flags.greenScreen` AND `backgroundPhoto.fullUrl` are present.

Originally (Phase 17) only wired into the manual single-item Imposition Preview + Save endpoints. Phase 34 extended this to the full Process flow.

---

## 22-27. Imposition WYSIWYG editor + visual polish

Settings → Imposition got a visual drag/resize/snap editor matching the composite editor's UX. Key milestones:
- 21: bleed canvas overlay
- 22: mouse-wheel resize at 5% per notch + text rotation
- 23: bleed default tweaks + Enter-to-load
- 24: canvas 950 default, 3fr/1fr grid layout
- 25: `clipToCanvas` enforced at render time
- 26: ResizeObserver reflow
- 27: full WYSIWYG with grid + bleed overlay + properties panel

Files: `client/src/components/LayoutCanvas.js`, `client/src/pages/settings/ImpositionLayoutEditor.js`

---

## 28. Manual ship/unship endpoints + bulk shipping

New `orderStatusService` module (server/services/orderStatusService.js):

### shipOrder({ orderId, force, source, userId })

1. Loads current order status via `getCurrentStatus`
2. Validates against `settings.shipEligibleFromStatusIds` (default `[40]`) unless `force: true`
3. Refuses on missing order, erased order, ineligible status, or already-shipped (noop case)
4. Calls `sytistDb.updateOrderStatus(orderId, shippedStatusId, shippingFields)` — Phase 30 added the shipping fields write
5. Inserts an `order_status_audit` row
6. Returns `{ ok, fromStatus, toStatus, shippingFields }`

### unshipOrder({ orderId, targetStatusId, source, userId, notes })

Inverse: flips back to Printing (default 40) with shipping fields reset to zero-defaults. No eligibility check (operator override).

### batchShipOrders({ orderIds, force, source, userId })

Iterates `shipOrder` for each ID, returns aggregate `{ results, shippedCount, skippedCount }`.

### order_status_audit table (SQLite)

```sql
CREATE TABLE order_status_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  order_id INTEGER NOT NULL,
  from_status INTEGER,
  to_status INTEGER,
  source TEXT,             -- 'manual', 'bulk', 'manual_override', 'shipstation_auto', 'reprint'
  user_id INTEGER,
  notes TEXT,
  shipping_fields_json TEXT  -- Phase 30: full payload snapshot
);
```

### Endpoints

- `POST /api/sytist/orders/:orderId/ship` (admin, operator)
- `POST /api/sytist/orders/:orderId/unship` (admin only)
- `POST /api/sytist/orders/batch-ship` (admin, operator) — body `{ orderIds: [], force?: bool }`

### UI

- `ShipStatusBlock` on order detail page (Phase 28); Phase 29 merged it with `ProcessOrderBlock` into a shared two-column card
- Multi-select checkboxes on orders list with bulk Mark Shipped button

---

## 29. Order detail card consolidation

Replaced two stacked full-width cards (Process + Ship Status) with `ProcessAndShipStatusRow` — a two-column inside a shared border. Saves vertical space and groups related actions visually. Each child uses `bare` mode to suppress its own card wrapper.

Other tweaks: dropped "(id 0)" decoration from shipping fields, made Shipping card collapsible to compact the page footer.

---

## 30. Full shipping field writeback to Sytist

Extended the Sytist write allow-list. Before: only `order_open_status`. After:

| Column | Type | Source |
|---|---|---|
| `order_open_status` | int | targetStatus from shipOrder |
| `order_shipped_date` | DATE | `shippedAt` from SS link or "today" |
| `order_shipped_track` | varchar(255) | tracking from SS link |
| `order_shipped_by` | varchar(50) | mapped via `CARRIER_CODE_MAP` (e.g. stamps_com → USPS) |
| `order_shipped_by_id` | int | always 0 |
| `order_ship_cost` | decimal(10,2) | parsed from SS link payload |

All NOT NULL with zero-defaults in Sytist's schema. `buildShippingFieldsForShip(orderId)` derives values from the SS link row; `buildShippingFieldsForUnship()` returns zero-defaults to reset.

`sytistDbService.updateOrderStatus(orderId, statusId, shippingFields=null)`:
- When `shippingFields` is null → single-column UPDATE (legacy callers)
- When provided → multi-column UPDATE in one statement

`order_status_audit.shipping_fields_json` captures the full snapshot for forensics.

### CARRIER_CODE_MAP

```js
const CARRIER_CODE_MAP = {
  stamps_com: 'USPS',
  usps: 'USPS',
  fedex: 'FEDEX',
  ups: 'UPS',
  endicia: 'USPS',
  // ... etc
};
```

Unknown carriers fall through to the raw lowercase string. Sytist's `order_shipped_by` is varchar(50) — long carrier codes just truncate.

---

## 31. Phase 31 — Push packaging during adopt (REVERSED)

Briefly tried: when adopting an externally-created SS order (one that already exists for our `order_id` before Process runs), automatically push the dashboard's recommended packaging fields (weight, dims, package code, carrier/service) via SS's update endpoint.

Result: the upstream tool's payload kept overwriting ours within seconds, leading to flapping. Reversed in Phase 33.

---

## 32. Scheduler auto-syncs SS → Sytist

`schedulerService` polls ShipStation every 5 minutes via the `listOrders` endpoint scoped to recent updates.

For each link in `shipstation_links` that's not yet `shipped`:
1. Query SS for the order's current status
2. If `awaiting_shipment` → no change
3. If `shipped` → call `orderStatusService.shipOrder({ orderId, force: true, source: 'shipstation_auto' })`
4. If `cancelled` or error → log + skip

Failure handling: if Sytist write fails after the local link transition, roll back the link's `ss_order_status` so the next poll retries.

Counters in poll result: `markedShipped` (local link transitions), `sytistSynced` (successful Sytist writes), `sytistFailed`.

Log lines:
```
[Scheduler] ShipStation polling started (every 300000ms)
[Scheduler] Order 110685 marked shipped: stamps_com (no tracking)
[SytistDB] updateOrderStatus (with shipping): order 110685: 40 → 39, tracking=, carrier=USPS, cost=0
[Scheduler] Order 110685 synced to Sytist: status 40 → 39
[Scheduler] Poll complete: 1 order(s) marked shipped, 1 synced to Sytist
```

---

## 33. Three items in one bundle

Three changes shipped together since they all touched the Process / ShipStation flow:

### 33.1 Removed Process popup confirm

Phase 28's "Process this order?" confirm dialog was friction every time. Operators process dozens of orders a day. Removed entirely. Reprint (Phase 35) kept its confirm originally then also dropped it in the Phase 35 hotfix.

### 33.2 Reversed Phase 31's auto-push during adopt

When `_tryCreateShipStation` finds a phantom SS order for the same `orderId` via `listOrders`, it now:
- `PATH=adopt_existing — SS#X already has this orderNumber, adopting WITHOUT pushing packaging (Phase 33 default)`
- Creates the local link row pointing at the phantom
- Returns success

The upstream tool keeps owning the packaging fields. We coexist.

### 33.3 Manual "Push packaging to ShipStation" button

Escape hatch for operators when they want our packaging on the SS order despite the upstream tool. Lives on the Shipping card.

Endpoint: `POST /api/sytist/orders/:orderId/push-packaging`. Builds the same payload `_tryCreateShipStation` would, then calls SS's update path on the linked SS order ID. Returns `{ ok, orderId, orderNumber, orderStatus, packageCodeSent, packageCodeStored, packageCodeDrift, ... }`.

`packageCodeDrift` is true when SS stored a different package code than we sent (SS sometimes reassigns based on its own rules). UI shows a ⚠ indicator.

Extensive `[SS]`-tagged logging through this whole flow for diagnostics.

---

## 34. Green-screen for imposition + packing slip

Background bug: Phase 17's compose only ran in the manual imposition preview + composite engine. The full `processOrder` flow used `impositionService.composeSheetInPlace(downloaded.path, ...)` directly on the raw transparent PNG, so plain prints showed up as keyed-out subject on white. Packing slip thumbnails had the same issue (`thumbUrl` fetch only, no compose step).

### Fix

New Step 1.4 in `processingService.processOrder` runs after the photo download loop and before the composite engine:

```js
const composedByCartId = {};
for (const li of sub.lineItems) {
  const downloaded = photosByCartId[li.cartId];
  if (!downloaded) continue;
  if (!greenscreenService.shouldComposite(li)) continue;
  if (await compositeService.findMapping(li.sku)) continue;  // composite handles its own

  const subjectBuffer = await fsp.readFile(downloaded.path);
  const { buffer: composedBuffer } = await greenscreenService.composeWithBackground(
    subjectBuffer, li.backgroundPhoto.fullUrl, { outputFormat: 'jpeg', jpegQuality: 92 }
  );
  const composedPath = downloaded.path.replace(/\.[^.]+$/, '') + '_composed.jpg';
  await fsp.writeFile(composedPath + '.tmp', composedBuffer);
  await fsp.rename(composedPath + '.tmp', composedPath);
  downloaded.path = composedPath;
  downloaded.composedPath = composedPath;
  composedByCartId[li.cartId] = composedPath;
}
```

Imposition (Step 2) then sees the composed file. Packing slip (Step 3) receives `composedByCartId` and uses a three-tier strategy on thumbnails:

1. **Pre-composed disk file** (cheapest) — when `composedByCartId[cartId]` exists, read from disk
2. **On-demand compose** — for preview path (no Process run yet), fetch subject `fullUrl` + composite in-memory
3. **Plain thumbUrl** — for non-green-screen line items

Composite-mapped SKUs (Memory Mate etc.) are explicitly skipped in Step 1.4 because the composite engine has its own `playerBackground` slot that handles backgrounds during the composite render.

---

## 35. Reprint workflow

### Detection

Reprint mode triggers when `order.productionStatus.id === 39` (Shipped) OR `=== 40` (Printing). Client-side: `ProcessOrderBlock` reads this from the order object; button label flips to "Reprint this order" (orange `#d97706`) and POSTs `{ reprint: true }`.

### File naming

`_nextReprintNumber(order)` scans the output dir for files starting with `${orderNum}_REPRINT` and parses the numeric suffix to find the next available N. Returns 1 if no prior reprints, 2 if `_REPRINT` exists, 3 if `_REPRINT_2` exists, etc.

Numbered suffix `_REPRINT`, `_REPRINT_2`, `_REPRINT_3` appended to:
- Photo filenames (between cartId and original name): `110685_481629_REPRINT_2_JV_Baseball-0016.png`
- Composite filenames (before `.jpg`): `110685_481629_composite_memory-mate_REPRINT.jpg`
- Packing slip filename (via existing `filenameSuffix` option): `110685_packing_slip_REPRINT.jpg`
- `.txt` filename (combined with teamSuffix): `110685_TeamName_REPRINT.txt`
- Specialty `.txt`: `110685_TeamName_REPRINT_specialty.txt`

### Behavior

- Sytist status: UNTOUCHED. Reprint never changes `order_open_status`.
- ShipStation: SKIPPED. Reprint never calls `_tryCreateShipStation` or any SS update.
- Audit: writes `order_status_audit` row with `source='reprint'`, `from_status=null`, `to_status=0`, notes describing the reprint number + items/full + reason.

### Per-item reprint

`POST /api/sytist/process/order/:orderId/reprint-item/:cartId` calls `processOrder({ reprint: true, lineItemFilter: [cartId] })`.

Single-item reprints SKIP the packing slip (operator already knows what they're reprinting; no slip clutter).

UI: orange "Reprint this item" button on each line item card; visible only when order is in reprint state. Button appears on both `LineItemRow` (main items list) and `ImpositionItemRow` (imposition section).

### Hotfix in same phase

The original Phase 35 had two issues caught in testing:
1. All reprint actions had confirm dialogs — operators wanted them gone (matches Phase 33's removal of the Process confirm)
2. `lineItemFilter` was declared in `processOrder` but NOT forwarded to `_processSubOrder` — so the slip-skip check in `_processSubOrder` always saw `undefined` and produced the slip anyway

Both fixed.

---

## 36. Sytist ms_notes integration

### What ms_notes is

A polymorphic note/log table in the Sytist database. Every Sytist-native action (status changes, emails, invoices, customer order creation) appends a row. Schema:

```
note_id          int PK auto_increment
note_date        datetime
note_table       varchar(100)       ('ms_orders' for orders)
note_table_id    int                (order_id)
note_note        text               (body)
note_delete      int                (0 = active, 1 = soft-deleted)
note_who         varchar(100)
note_edited      datetime
note_edited_who  varchar(100)
note_ip          varchar(200)
note_admin       int                (1 = staff, 0 = customer)
note_is_note     int                (1 = manual note, 0 = system log)
note_log         int                (1 = system log, 0 = manual note)
note_data        text               (HTTP form data for Sytist's own actions; we leave empty)
```

### Flag conventions (discovered from sampled rows)

| Event class | note_admin | note_is_note | note_log |
|---|---|---|---|
| System log event (e.g. Sytist "Taylor changed to Shipped") | 1 | 0 | 1 |
| Manual operator note | 1 | 1 | 0 |
| Customer-triggered event (Sytist only) | 0 | 0 | 1 |

The dashboard emits the first two; never the third.

### What we write — and when

All bodies prefixed `[Dashboard]`. `note_who` is the logged-in user's `display_name` (matches Sytist convention like "Taylor"). Falls back to `'sytist-dashboard'` for the scheduler (no user attached).

| Trigger | Body |
|---|---|
| Process (fresh) | `[Dashboard] Order processed (N items) — status → 40` |
| Reprint (full) | `[Dashboard] Order reprinted as REPRINT_N` (+ optional `— Reason: ...`) |
| Reprint (item) | `[Dashboard] Item "Product Name" reprinted as REPRINT_N` |
| Mark Shipped (manual) | `[Dashboard] Order Has been changed to Shipped — Tracking: ..., Carrier: ..., Cost: $...` |
| Mark Shipped (scheduler-auto) | Same as above with `(auto-detected from ShipStation)` suffix |
| Mark Back to Printing | `[Dashboard] Order Has been changed to Printing` (+ optional `— Reason: ...`) |
| Push Packaging | `[Dashboard] Packaging pushed to ShipStation — 4oz, large_envelope_or_flat, stamps_com/usps_first_class` (+ `⚠ SS reassigned package code` on drift) |
| Manual operator note | (whatever the operator typed, trimmed) |

### Endpoints

- `GET /api/sytist/orders/:orderId/notes` — returns UI-shaped rows newest first, soft-deleted excluded by default
- `POST /api/sytist/orders/:orderId/notes` — body `{ noteText }`, writes manual note
- `DELETE /api/sytist/orders/:orderId/notes/:noteId` — soft-delete (auth: admin OR author matched on display_name; log entries cannot be deleted)

### sytistDbService methods

```js
insertNote({ orderId, noteText, who, ip = '', isManual = false, table = 'ms_orders' }) → { noteId }
listNotes(orderId, { includeDeleted = false, limit = 200 }) → array of {id, date, body, who, ip, type, admin, deleted}
softDeleteNote(noteId, { editedWho = '' }) → { affectedRows }
```

### INSERT statement

```sql
INSERT INTO ms_notes
  (note_date, note_table, note_table_id, note_note,
   note_who, note_ip, note_admin, note_is_note, note_log)
VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
```

Note: `note_edited`, `note_edited_who`, `note_delete`, and `note_data` are deliberately NOT in the column list. MySQL strict mode (`NO_ZERO_DATE`) rejects the literal `'0000-00-00 00:00:00'` even though that's the column default. Letting MySQL apply schema defaults sidesteps the check.

### Failure handling

All `insertNote` calls in upstream code (orderStatusService, processingService, push-packaging endpoint) are wrapped in try/catch. A notes failure logs a warning but never undoes the calling action. The SQLite `order_status_audit` table is the authoritative audit trail; ms_notes is the operator-friendly mirror.

### Client UI

New `OrderActivityCard` between customer/admin notes and output paths. Fetches `GET /notes` on mount + on `refreshKey` change. Listens for a `sytist:activity-changed` window event so deeply-nested action buttons (per-item reprint, push packaging) can trigger refresh without prop drilling.

Renders newest first with `Note` (manual) vs `Log` (system) badges. Manual notes get a delete button; server enforces who can actually delete.

---

## 37. Photo + background download links on line item card

Small UX improvement. The line item card already displays `lineItem.photo.originalFilename` as plain text. Phase 37 makes it a download link:

```jsx
<a
  href={photo.fullUrl}
  download={photo.originalFilename}
  target="_blank"
  rel="noopener noreferrer"
>
  {photo.originalFilename}
</a>
```

For green-screen items (`backgroundPhoto.fullUrl` present), a labeled background link is also added: `Background: filename.jpg`.

Both open in a new tab so the operator doesn't lose their place. The `download` attribute hints the browser to save rather than navigate, though some browsers/CORS configurations may still navigate inline.

Also in Phase 37: full rewrite of README.md, SPEC.md (this file), OperatorManual.md, and AdminManual.md to bring all four docs current from their Phase 16 baseline. New CHANGELOG.md gives a phase-by-phase summary.

---

## 38. Packaging filter for unknown SKUs

The ShipStation payload builder previously emitted every line item regardless of whether the dashboard's packaging config knew about it. Items without a configured weight defaulted to 0 oz, and unrecognized add-ons appeared in SS as shippable items without contributing to total weight.

Phase 38 filters those out:
- Before building the SS payload's `items` array, each line item's SKU is checked against the dashboard's `productWeights` map (Settings → Packaging)
- Items without a configured weight are silently omitted from the payload
- The `[Packaging Trace]` log shows which items were filtered

Side effects:
- Cleaner SS UI (no zero-weight phantom items)
- Total weight is now accurate without operator intervention for unconfigured SKUs
- An unconfigured SKU that's actually shippable becomes invisible to the packer — flip side: operators must keep `productWeights` current

File: `server/services/shipstationService.js`

## 39. Dashboard-driven package expansion

Sytist's `ms_cart.cart_package` field is supposed to flag package parents (so the system knows to explode them into constituents for printing). In practice it's unreliable — packages routinely show `cart_package=0` regardless of whether they should expand.

Phase 39 stops trusting `cart_package` and uses the dashboard's own Settings → Packages config as the authoritative source. Flow:

1. `sytistDbService.getOrderById` loads raw cart rows from MySQL as before
2. For each cart row whose SKU appears in `packageContentsMap`, the dashboard generates the configured constituents inline
3. Each constituent gets a synthetic `cart_id` of the form `{parentCartId}-pkg-{constituentSku}`
4. `cart_photo_bg` and `flags.greenScreen` from the parent propagate to each constituent (so a Bronze Package with a chosen background composites each of its 4×3.5x5s + 8 wallets against that background)

Logs emitted during expansion (per-cart):
```
[SytistDB] cart {N} sku={X} ({name}): Sytist's cart_package=0 but SKU is configured as a package in dashboard settings. Expanding using dashboard config ({M} constituents).
[SytistDB] Package cart {N} sku={X} expansion: parent greenScreen={bool} parent backgroundPhoto={present|absent} parent bgFullUrl={set|unset} (propagating to {M} constituents)
```

**Phase 39 hotfix 1:** removed the "package detected by config" UI banner that originally appeared on the order detail page. The banner was meant to be transient ("the dashboard noticed Sytist's flag was wrong"), but since `cart_package=0` is now universal for our orders, the banner became permanent visual noise.

**Phase 43 hotfix 1** (related): the constituent's `flags.download` is determined by the constituent's own SKU lookup, NOT by the parent's flag. Earlier code was inheriting `download` from the parent, which caused Silver Package orders to incorrectly show "Includes Download" badges on every constituent line item.

Files: `server/services/sytistDbService.js`, `client/src/pages/OrderDetailPage.js`

## 40. Process/Reprint respect saved per-order overrides

> **⚠ Correction (Phase 52):** The pipeline wiring described below was **specified but never delivered** in Phase 40. Only the UI half shipped (the "Save (no render)" button). `processingService` never called `orderOverrideService` — normal **Process silently ignored every saved override** (text, color, position, image) for months; overrides only took effect via the editor's *Apply (Overwrite/Reprint)*. **Phase 52 actually delivers what this section describes** (see §52). The design text below is retained because it is the correct design — Phase 52 implements it.

Phase 11 introduced per-order composite layout overrides — operators can save a layout customization for a specific (orderId, cartId) so the composite engine uses the custom layout instead of the SKU's default mapping.

Phase 40 wires that into the actual Process/Reprint flow:
- `processingService` composite loop calls `orderOverrideService.get(orderId, cartId)` BEFORE falling through to `compositeService.findMapping(sku)`
- If an override is found, that layout is used; `subResult.composites[].layoutSource = 'override'`
- Otherwise the SKU mapping runs as before; `subResult.composites[].layoutSource = 'mapping'`

New UI: `OverrideEditorPage` now has a "Save (no render)" button alongside the existing "Save and render" — useful when an operator wants to stage an override for the next Process/Reprint without immediately producing files.

Files: `server/services/processingService.js`, `client/src/pages/OverrideEditorPage.js`
Files (Phase 52, actual delivery): `server/services/overrideRenderService.js` (new), `server/services/processingService.js`, `server/services/orderOverrideService.js`, `server/routes/sytist.js`

## 41. Per-item thumbnails in ShipStation

ShipStation V1 API supports an `imageUrl` field on each line item — a public URL string. ShipStation fetches it server-side and displays the image as a thumbnail in the order detail UI.

Phase 41 wires this in:
- `shipstationService.buildOrderFromSytist` adds `imageUrl` to each item in the payload's `items` array
- Source preference chain: `li.composedImageUrl` → `li.photo.thumbUrl` → `li.photo.largeUrl` → `li.photo.fullUrl` → omit field
- `composedImageUrl` is empty as of Phase 41 (no publish flow yet); Phase 42 fills it. Phase 41 establishes the field plumbing so Phase 42 can drop in the URL transparently.

File: `server/services/shipstationService.js`

## 42. Pluggable composed-thumbnail backend (S3 publish)

To fill the `composedImageUrl` field with the actual composed image (subject + chosen background), the dashboard needs to host the composed JPEGs at a public URL. ShipStation can fetch the URL from anywhere as long as it's reachable.

Architecture:
- `composedThumbnailService` is the entry point. Initialization reads `Settings → API Keys → AWS S3` and selects a backend:
  - `skip` — default; `publish()` returns null, `cleanup()` is a no-op (originally; removed in Phase 44 hotfix 2)
  - `s3-sytist` — uploads to AWS S3 using the configured region, bucket, key prefix, and credentials. Returns the public URL
- New `aws_s3` section in `appSettings.js` and `ApiKeysPage.js`:
  - `region` (default us-east-1)
  - `bucket`
  - `publicUrlBase` (e.g. `https://{bucket}.s3.{region}.amazonaws.com`)
  - `keyPrefix` (e.g. `sytist-dashboard-composed/`)
  - `accessKeyId`
  - `secretAccessKey`
  - `aclEnabled` (boolean; affects whether the upload sets `ACL: public-read`)
- Files published with key `{prefix}{orderId}/{cartId}.jpg`
- `@aws-sdk/client-s3` added to `server/package.json`

Publish flow (during Step 1.4 in processOrder, the green-screen compose step):
1. After the composed JPEG buffer is built and written to disk for printing
2. A separate 500px max-edge JPEG (quality 80) is created via `sharp` for the thumbnail
3. `composedThumbnailService.publish(orderId, cartId, thumbBuffer)` returns the URL (or null if backend is `skip` or upload failed)
4. The returned URL is written to `li.composedImageUrl` so the shipstation payload builder picks it up

S3 setup walkthrough lived in `GUIDE-AWS-S3-SETUP.txt` (Phase 42 tarball). Joey's bucket: `sportsline-sytist-thumbnails` in `us-east-1`, with ACLs enabled, Block Public Access off, and a bucket policy granting `s3:GetObject` for `Principal: *` on the `sytist-dashboard-composed/*` prefix. IAM user `sytist-dashboard` has `s3:PutObject`, `s3:PutObjectAcl`, `s3:DeleteObject`, and `s3:ListBucket` scoped to the prefix.

**Phase 42 hotfix 1:** added diagnostic logging per cart_id at Step 1.4 entry (`greenScreen=`, `backgroundPhoto=`, `bgFullUrl=`, `shouldComposite=`) so it's clear in the log why the publish ran or didn't. Avoids guessing why a thumbnail didn't appear for a particular item.

Files: `server/services/composedThumbnailService.js` (new), `server/services/thumbnailBackends/skip.js` (new), `server/services/thumbnailBackends/s3Sytist.js` (new), `server/services/processingService.js`, `server/services/shipstationService.js`, `server/services/schedulerService.js`, `server/config/appSettings.js`, `client/src/pages/settings/ApiKeysPage.js`, `server/package.json`

## 43. SQLite cache for composed URLs + Push Packaging resilience

Phase 42 published thumbnails during Process, but the URL only lived on the in-memory `li.composedImageUrl` for the duration of that Process call. Push Packaging (the "Push to ShipStation" button) re-reads the order from scratch later; it had no way to recover the published URL without re-running Step 1.4 (which is expensive — fetches subject, fetches background, composites, uploads).

Phase 43 adds a persistent cache:
- New `composed_thumbnails` SQLite table: `(order_id, cart_id, public_url, backend, created_at, updated_at)`, primary key `(order_id, cart_id)`
- New service `composedThumbnailCacheService` with `upsert`, `get`, `listByOrder`, `deleteByOrder`
- Step 1.4 in processOrder writes to the cache alongside the `li.composedImageUrl` mutation
- Push Packaging route reads the cache and hydrates `composedImageUrl` onto each line item before building the SS payload

ShipStation-side resilience also added in Phase 43:
- `orderDate` field converted to ISO 8601 in `buildOrderFromSytist`. mysql2 returns DATETIME as `"YYYY-MM-DD HH:MM:SS"` (space, not T); SS V1 sometimes accepted it, sometimes returned errors. ISO is unambiguous.
- Push Packaging route does a `listOrders` pre-check by orderNumber. If SS still has the order, the local link is adopted/updated rather than re-created.
- On `404` with empty body from `createOrder`, the route returns a structured `409` with `code: 'orderkey_tombstone_suspected'` and a `suggestedSuffix` for the client to use on retry. SS appears to maintain a tombstone for recently-deleted orderKeys; recreating with a modified key (`{orderNumber}-r{timestamp}`) sidesteps the conflict.

**Phase 43 hotfix 1:** package constituent `download` flag is determined by the constituent's own SKU, not the parent's. See Phase 39 section.

**Phase 43 hotfix 2:** the same 404-retry logic added to `POST /api/shipstation/orders/:orderId/create` (the "Send to ShipStation" button on the order detail page — a separate route from Push Packaging). UI confirmation popup: "ShipStation rejected this order, likely because orderNumber X was previously deleted in ShipStation. Retry with modified orderNumber X-r{timestamp}?" Also enhanced server-side diagnostic logging: response headers, byte length, payload sample (truncated at 3000 chars). `api.js` was extended to attach the full response data as `err.data` on thrown errors so the client can read structured fields like `suggestedSuffix`.

**Phase 43 hotfix 3:** rebuilt `shipstationService.js`. Hotfix 2 had been built off a stale uploaded `shipstationService.js` that pre-dated Phase 41/42/43 changes — extracting hotfix 2 overwrote the deployed file with a version missing imageUrl, composedImageUrl preference, and orderDate ISO conversion. Hotfix 3 layers the Phase 41/42/43 changes back on top of hotfix 2's enhanced logging in a single file.

Files: `server/services/composedThumbnailCacheService.js` (new), `server/services/processingService.js`, `server/services/shipstationService.js`, `server/services/schedulerService.js`, `server/routes/sytist.js`, `client/src/services/api.js`, `client/src/pages/OrderDetailPage.js`

## 44. Composite thumbnails on packing slip, ShipStation, and dashboard UI

Phase 42 + 43 made green-screen composed thumbnails (subject + background) reach ShipStation. But composite-layout products — Memory Mate, Photo Button, 2 Large Magnets, etc. — go through the composite engine, which produces a fully-rendered output (subject + background + team photo + logo + text overlays + graphics). That composite output is what actually prints. Before Phase 44, it was invisible to operators looking at the order in ShipStation or the dashboard.

Phase 44 surfaces the composite engine output in three places:

- **Packing slip**: 4-tier thumbnail resolver in `packingSlipService._composeSlip`:
  - Tier 0: composite engine output. Falls into 0a (local file path, fastest, used during processOrder) and 0b (public URL fetched via HTTP, used during slip preview route handlers — see hotfix 1 below)
  - Tier 1: pre-composed green-screen file (Phase 34's behavior)
  - Tier 2: on-demand compose (Phase 34)
  - Tier 3: plain `thumbUrl` (pre-Phase-34 behavior)
- **ShipStation**: composite engine output also publishes to S3 + cache. The shipstation payload's `imageUrl` field picks up the URL via the existing chain (Phase 41 + 42 + 43)
- **Dashboard order detail page**: `LineItemsBlock` fetches per-cart URLs via the new endpoint, threads them down to each `LineItemRow`. When a URL exists, the card shows that single image; otherwise it falls back to the existing bg+player stacking (Phase 12b/c)

New endpoint: `GET /api/sytist/orders/:orderId/composed-thumbnails`. Returns `{ ok: true, thumbnails: { [cart_id]: public_url, ... } }`. Reads from `composedThumbnailCacheService.listByOrder`. Non-fatal — returns empty thumbnails map on cache read errors so the UI falls back gracefully.

Implementation in processOrder: after the composite engine writes its output file (existing behavior), Phase 44 also resizes the buffer to 500px, calls `composedThumbnailService.publish`, mutates `li.composedImageUrl`, and upserts the cache row — parallel to the green-screen publish flow.

**Phase 44 hotfix 1:** slip preview routes (`GET /slip/preview/:id`, `POST /slip/preview/:id/save`, `GET /slip/preview/:id/info`) don't have access to local composite paths because they run on-demand without processOrder. New helper `_loadCompositeUrlsForOrder(orderId)` reads the SQLite cache and passes the URL map via a new `compositeUrlsByCartId` option. Slip's Tier 0 split into 0a (path, used by processOrder) and 0b (URL fetch via `sharp` + `fetch`, used by route handlers).

**Phase 44 hotfix 2:** removed both `composedThumbnailService.cleanup(orderId)` and `composedThumbnailCacheService.deleteByOrder(orderId)` calls from `schedulerService`. The cleanup was racing operator visibility — orders that auto-shipped in ShipStation within the same poll cycle as creation (cause not yet diagnosed; could be an SS workflow rule or phantom shipments from prior deleted orders with the same orderNumber) were getting their S3 objects + cache rows wiped within minutes. By the time an operator viewed the order detail or slip preview, the cache was empty and the dashboard fell back to raw photos.

Storage growth is bounded but slow: ~50KB per thumbnail × hundreds of orders/month × multiple constituents = a few hundred MB/year in S3. At ~$0.023/GB/month, that's $0.001/year/object — trivial. If it ever matters at scale, add a separate sweep job that deletes objects > N days post-ship; that can be decoupled from the poll cycle.

Files: `server/services/processingService.js`, `server/services/packingSlipService.js`, `server/services/schedulerService.js`, `server/routes/sytist.js`, `client/src/pages/OrderDetailPage.js`

---

## 45. ShipStation eligibility honors packaging-config category=digital

A real order (111042) was sent to ShipStation despite containing only a drop-shipped specialty (SKU 14) and a digital-package SKU (5D). The SS eligibility filter previously skipped a line item only if `flags.download === true` (driven by Sytist's `cart_download` column) or if `specialtyService.isDropShipped(sku)` returned true. Sytist sets `cart_download = 0` for digital-package SKUs (3D, 5D, 20D, and a few long-string variants), so the existing filter missed them and they ended up in the `shippable` array — keeping the order eligible for an SS create call.

This is a class of bug, not a one-off: 6 distinct SKUs across ~256 orders in our data window had `cart_download = 0` despite being digital products. (Other digital SKUs, like 25, already have `cart_download = 1` set by Sytist and were filtered correctly.)

**Part A — config**: add the 6 missing SKUs to `packaging-config.json` with `category: 'digital'`. Keys are stored uppercased to match the lookup convention; lookups normalize the incoming `li.sku` to uppercase before reading from `productWeights`. Entries:

| SKU | Category | Volume |
|---|---|---|
| `3D` | digital | 162 orders |
| `5D` | digital | 79 orders |
| `20D` | digital | 1 order |
| `5 DIGITALS - CHEER` | digital | 8 orders |
| `5 DIGITALS` | digital | 2 orders |
| `10 HIGH RESOLUTION DIGITAL IMAGES CHEER` | digital | 4 orders |

Side decision: `packaging-config.json` was previously gitignored as "local operator-edited config." Phase 45 removes it from gitignore so the canonical digital classification travels with the code. Other listed configs (app-settings.json with AWS keys, specialty-products.json, etc.) stay gitignored.

**Part B — code**: new `packagingService.isDigital(sku)` method mirroring `specialtyService.isDropShipped(sku)` in shape and call convention. Wired into all three filter sites:

- `shipstationService.buildOrderFromSytist` — the real create path
- `shipstationService.previewPackagingForOrder` — the packaging engine's preview, used by Settings → Packaging test calculator and the order detail page's Ship card pre-fill
- `routes/shipstation.js _computeEligibility` — the eligibility-summary endpoint that drives the order detail page's "X shippable, Y skipped" badge

The check sits after the SKIP_FLAGS check and after the drop-ship check, before the line is added to `shippable`. Same defensive try/catch fallback pattern as the drop-ship check — if the lookup throws, the item is treated as shippable (easier to refund a label than to fail to ship).

Case-tolerance: `isDigital` tries the uppercased SKU first, falls back to the raw key. So `5D`, `5d`, `5D`, all match the stored `5D` entry. Numeric SKUs like `25` work unchanged since `'25'.toUpperCase() === '25'`.

**Orphan scope**: of the 29 orders currently in `shipstation_links`, exactly 1 (order 111042) would have been skipped under the new filter but wasn't under the old. The orphaned SS row stays — we don't auto-clean per Phase 44 hotfix 2's principle, and one row isn't worth a manual sweep. The bug-case universe is much larger (~256 orders) but most predate the dashboard or hit Sytist's status pipeline through other paths and never appeared in `shipstation_links`.

**Verification**:
- Regression check (real order 111260, ship_to_home, mixed `[3D, 25, 25, 25, 9]`): payload built and sent to SS contained exactly one item — SKU 9 (8x10 Team Photo). The 3D was caught by the new rule; the three 25s by the existing `flags.download` filter.
- Bug case (synthetic `[14, 5D]`): `buildOrderFromSytist` returned `{ __skipShipStation: true, reason: 'no_shippable_items', message: '... 1 dropShipped, 1 digital' }`. `previewPackagingForOrder` returned `ok: false, shippableCount: 0`.

Files: `.gitignore`, `server/config/packaging-config.json`, `server/services/packagingService.js`, `server/services/shipstationService.js`, `server/routes/shipstation.js`

---

## 46. Order-detail composite affordances on each line item

Composite-layout products (Memory Mate, Photo Button, etc.) sometimes render wrong during Process — team photo didn't auto-pull, text in a slot is incorrect, wrong image in an image slot. Before Phase 46 the operator workflow was: Process → look at the printed composite → reprint with overrides. That wastes a print run. The corrective tool — the per-(orderId, cartId) override editor from Phases 10-11f — was already capable enough to fix all three cases (geometry adjustments via canvas drag/resize, drift detection, three apply modes), but operators had to navigate Settings → Order Overrides → type the order ID → Load → click a line item thumbnail to reach it. Four-plus clicks, no in-the-moment use.

Phase 46 closes the discovery gap. The override editor itself is unchanged. What changed is the order detail page: every line item whose SKU has a composite mapping now shows three affordances inline.

### Affordances on `LineItemRow` when `compositeMapping !== null`

- **"✏ Composite" chip** in the existing flag-chip strip. Visually distinct from the solid flagChips: transparent background, full-opacity `#b888d0` border, pencil prefix. The outline-vs-fill is the "this is an action target, not a status" signal. Color matches the override editor's `SLOT_KIND_COLORS.text` / `.staticGraphic` value for visual continuity between the chip and the editor it links to.
- **"✏ Edit layout" button**: navigates to `/overrides/${orderId}/${cartId}` via the existing `useNavigate` import. One click.
- **"Preview" button**: lazily POSTs to `/api/sytist/composite/preview` (existing endpoint, no server change) and expands an inline block showing the rendered JPEG plus diagnostics (variant, output dimensions, team photo found/missing with reason, logo found/missing, render bytes). The "team photo ⚠ Missing" line is the most operationally useful piece — operators spot the case where the auto-lookup failed without printing first.

### Loading state

Composite renders are bandwidth-heavy (downloads player + team photo + logo, runs sharp compositing). The Preview button:
- Disables on click
- Flips label to `⟳ Rendering…`
- Switches cursor to `wait` and reduces opacity to 0.6

Per-row preview state is local to that row, so multiple previews on the same order can be open at once.

### Narrow-viewport layout

The inline preview uses `window.matchMedia('(max-width: 767px)')` (with addEventListener / removeListener fallback for older Safari). At ≥768px the JPEG and diagnostics sit side-by-side via flex-row; below 768px they stack column-wise and the JPEG goes full-width so it doesn't overflow the line item card.

### Mappings fetch hoisting

`LineItemsBlock` fetches `/api/sytist/composite/mappings` once on mount and builds a `Map<String(SKU), mapping>` that's threaded down through `LineItemList` to each `LineItemRow`. Previously the (deprecated) `CompositeBlock` re-fetched on every expand. One round-trip per order page now, regardless of how many composite-mapped items appear.

Empty or failed fetch leaves an empty Map — no chips, no buttons, page still renders. Same defensive-degradation pattern as the composed-thumbnails fetch.

### CompositeBlock deprecation

The bottom-of-page `CompositeBlock` + `CompositeItemRow` (~290 lines, Phase 8b) are removed entirely. Two paths to the same thing was UI debt; the per-line-item affordances strictly dominate. `DetailLine` survives — the new inline preview reuses it.

Files: `client/src/pages/OrderDetailPage.js`

---

## 47. Override editor wired into the operator-fix loop

Phase 46 made the override editor reachable from each line item card. Phase 47 closes the workflow: when an operator finishes editing, they return to the order detail page with the thumbnail updated; when they Save (no render) for batch staging, the order detail card visibly indicates the layout is edited but the thumbnail hasn't been rendered yet; and when a line item is composite-mapped but never processed, the card shows that the operator is looking at the raw player photo, not the final product.

The override editor's renderer, the cache pipeline from Phase 42/44, and the order detail's thumbnail display already existed — Phase 47 is mostly wiring those together with two new UI indicators.

### 47a. Auto-return on Apply Overwrite / Apply Reprint

Both apply paths in `OverrideEditorPage.applyOverride` now `navigate('/orders/<orderId>')` immediately on success. No setTimeout. The success-message banner is left in `actionResult` state but is effectively unobserved — the order detail page IS the confirmation. Save (no render) intentionally does NOT navigate, since that button is for batch-staging multiple cart fixes in one order, and pulling the operator away after each Save would force three round-trips for three items.

### 47b. Cache publish in `renderOverrideForOrder`

`routes/sytist.js renderOverrideForOrder` previously wrote the composite file to disk (and the `_REPRINT` .txt for reprint mode) but did not refresh the `composed_thumbnails` cache. So an operator clicking Apply Overwrite saw their fix on disk but not on the order detail thumbnail. Phase 47b adds the same publish step `processingService.js` uses in the composite engine loop — sharp resize to 500px max, `composedThumbnailService.publish` to the configured backend (S3 in production), `composedThumbnailCacheService.upsert` for the SQLite row. Non-fatal: failures surface as a warning rather than rolling back the render.

The cache row is keyed by `(orderId, cartId)`. Apply Overwrite and Apply Reprint both upsert the same row — most-recent action wins. For an Overwrite-then-Reprint sequence, the cache ends up pointing at the _REPRINT render, which matches operator intent (the most recent action is what they want to see).

### 47c. Stale-render indicator on order-detail tiles

When an operator clicks Save (no render), the override snapshot's `updated_at` advances but no render fires — the cache row stays at its previous timestamp. Phase 47c surfaces this asymmetry. The `/composed-thumbnails` endpoint now returns a `stale: [cart_id, ...]` array alongside the thumbnails map. Cart ids appear in `stale` when `order_overrides.updated_at > composed_thumbnails.updated_at` for that pair.

`LineItemsBlock` reads the new field into a `staleCartIds` Set, threads it down to each `LineItemRow` as `thumbnailStale`. When true and a thumbnail exists, the tile gets an amber **⚠ Layout edited** overlay in the top-right corner. The overlay clears on the next Apply (47b refreshes the cache) or Process (`processingService.js`'s composite publish step does the same upsert).

Implementation note: `composedThumbnailCacheService.listByOrder` was extended to include `created_at` and `updated_at` in the SELECT. Purely additive — existing consumers (the SS push-packaging hydration path and shipstation routes) ignore the new columns.

### 47d. "Process to generate" badge for un-rendered composite-mapped items

When a composite-mapped SKU (SKUs 6, 12, 15, 16, 27 — Memory Mate, wallet, Magnets, Photo Button, 4-3.5x5 Prints) has no cache row, the tile falls back to the raw player photo. Operators who hadn't internalized the "composite is generated by Process, not pre-baked" rule were surprised to see the raw photo and assumed the composite render was broken. Phase 47d adds a dark **🔄 Process to generate** badge in the bottom-right of the tile when:

- `compositeMapping !== null` for this SKU (composite-mapped), AND
- `composedThumbnailUrl` is null (no cache row), AND
- `lineItem.flags.isPackageHeader !== true` (package headers never get their own render — the composite engine fires per-constituent, so a header tile's missing thumbnail is correct, not a sign that Process needs to run).

The badge appears alongside the player photo fallback. Clicking through to the line item still works (the linked anchor is the player photo, not the badge — `pointerEvents: 'none'` on the badge).

### 47e. Save (no render) success banner clarifies the thumbnail consequence

The post-save banner in `OverrideEditorPage` previously said "Override saved. Composite will be re-rendered with these changes the next time you Process or Reprint this order." Phase 47e rephrases it to explicitly mention the **⚠ Layout edited** indicator the operator will see on the order detail page, and the three ways to clear it: Apply (Overwrite), Apply (Reprint), or Process the order.

### Visual overlay placement

Two distinct overlays on the tile, each in its own corner so they never conflict:

| Indicator | When | Position | Color |
|---|---|---|---|
| **🔄 Process to generate** | composite-mapped + no cache row + not a package header | bottom-right | dark (`rgba(0,0,0,0.6)`) on white text |
| **⚠ Layout edited** | cache row exists + override updated later than cache | top-right | amber (`#e0b341`) on black text |

The two are mutually exclusive: "Process to generate" only fires when there's no cache row; "Layout edited" only fires when there is one. They never appear on the same tile simultaneously.

### Edge cases handled

- **Package headers**: `flags.isPackageHeader === true` suppresses the "Process to generate" badge. Composite engine never produces a render for headers; constituents have their own (synthetic) cart_ids and their own cache rows.
- **Addon synthetic items**: their `cart_id` is `<parent>-addon-<optId>`. If the resolved (post-addon-explosion) SKU is composite-mapped, the badge logic applies as for any other composite-mapped item. The cache row, if it exists, is keyed by the synthetic cart_id and is found correctly.
- **Mappings fetch failure**: empty Map → `hasComposite` is always false → no badges, no buttons, page renders normally. Matches the Phase 46 defensive degradation pattern.
- **`/composed-thumbnails` endpoint failure**: catch returns `{ ok: true, thumbnails: {}, stale: [] }` to preserve the response shape so the client's destructuring doesn't error.

Files: `client/src/pages/OrderDetailPage.js`, `client/src/pages/settings/OverrideEditorPage.js`, `server/routes/sytist.js`, `server/services/composedThumbnailCacheService.js`

---

## 48. Text content editing in the override editor

Phase 47 wired the override editor into the operator-fix loop for position/size adjustments. Text *content* — the actual string a text slot renders — remained un-editable: operators could move the player-name slot, resize it, change its font size, but if a player's name was misspelled in Sytist or needed a per-order override ("John Smith" → "Jonathan Smith"), they had to fix it in Sytist or edit the underlying layout. Both were heavy interventions for what was usually a one-character typo.

Phase 48 adds a Text content textarea to the QuickEditPanel for `text` slots. The save path uses the existing `POST /api/sytist/overrides/:orderId/:cartId` endpoint with no server change — slot text templates are already part of the snapshot blob, so editing `slot.text` in place and POSTing the whole snapshot is the entire mechanism.

### Why no server change was needed

The override snapshot mechanism (Phase 11, stored at `order_overrides.layout_snapshot`) is a full layout JSON, not a delta. Slot text templates like `"{subject.athleteName}"` are part of that JSON. At render time, `compositeService.buildSheetBuffer` runs `_substituteTokens(slot.text, tokens)` on whatever string is in `slot.text`, no preferential treatment for tokens vs literals. So if the operator types "Jonathan Smith" over the template, `slot.text` becomes the literal "Jonathan Smith", token substitution sees no tokens to substitute, and the render is correct. The pipeline is content-agnostic by construction.

### The textarea display rule

The input shows the **resolved value** by default, not the template. If `slot.text` is `"{subject.athleteName}"`, the textarea reads "John Smith" — what the composite will actually render. The operator edits over the resolved value, and what they type becomes `slot.text` literally.

Display logic (one-liner): when `slot.text` contains a `{` anywhere, show `substituteTokens(slot.text, tokens)`; otherwise show `slot.text` directly. This handles three cases correctly without needing the base layout for reference:

| `slot.text` | Display | Notes |
|---|---|---|
| `"{subject.athleteName}"` | `"John Smith"` | Resolved against real Sytist data |
| `"Photo Day {year}"` | `"Photo Day 2026"` | Partial tokens substituted |
| `"Jonathan Smith"` | `"Jonathan Smith"` | Pure literal, identity |
| `""` | `""` | Empty stays empty |

The `{`-detection heuristic is independent of `isCustomText` (which compares against the base layout) so the textarea still behaves sensibly when `baseLayout` is null — e.g. when an override's underlying base layout was deleted.

### Token pass-through preserved

The earlier design discussion considered "literal-only" UI vs. "pass-through tokens" UI. The conclusion: pass-through is free because the substitution pipeline already handles whatever `slot.text` contains. If an operator types `"{customer.firstName}"` explicitly into the textarea, it gets stored as that string, and at render time `_substituteTokens` substitutes the customer's first name. The UI doesn't advertise tokens to non-technical operators, but doesn't block power users from using them.

### Custom-text indicator (two surfaces)

A slot is "custom" when its `slot.text` differs from `baseLayout.variants[variant].slots[index].text`. Two visible indicators:

- **QuickEditPanel**: an amber italic line below the textarea reading "Custom text (overrides token) — won't follow Sytist data". Hover tooltip surfaces the original base text so the operator can see what they overrode without leaving the editor.
- **LayersList**: italic styling on the text snippet + a small amber `·custom` suffix next to the slot's text preview. Operator scanning the layers can see at a glance which slots have manual text without selecting them.

When the base text contained a `{token}`, the indicator means "this slot no longer follows Sytist subject/customer data for this order" — the precise concern that motivated making the indicator visible enough to notice without clicking. When the base text was already a literal (e.g. layout has fixed copy "2026 Photo Day"), the indicator simply means "this differs from the base," which is the same thing semantically.

When the slot's text is unchanged from base but contains a token, an alternative info-only hint is shown instead: "Pulls from: `{subject.athleteName}`" in muted monospace. This surfaces the template so the operator knows what to expect if they edit (the resolved value will become literal).

### Side-effect: canvas-preview bug fix

The `sampleTokens` map at `OverrideEditorPage.js` L595 (pre-Phase 48) tried to override `PLACEHOLDER_TOKENS` with real order data but did so with flat dotted keys:

```js
const sampleTokens = {
  ...PLACEHOLDER_TOKENS,
  'subject.athleteName': lineItem.productName || 'Customer Name',
  'order.number': String(order.orderNumber || order.orderId || ''),
};
```

`substituteTokens` walks nested objects (`ctx.subject.athleteName`), never reads the flat keys. The override was dead code. Worse, `lineItem.productName` is the *product* name ("8x10 Memory Mate"), not the player name — even if the flat-key approach had worked, it would have substituted the wrong field.

Phase 48 replaces the flat-key override with `buildTokensFromOrder(order, lineItem)`, a client-side mirror of the server's `compositeService.buildTokensFromOrder`. Same shape (`{ customer, subject, galleryName, subGalleryName, order, year, date }`), same `camelCaseKey` for subject-field labels, same field provenance (`order.subject.fields[]` from `ms_subjects`). The canvas preview now shows real player names instead of "Sample Player", and the textarea's resolved-value default uses the same tokens — so what the canvas shows and what the textarea shows are the same string, and both match what production will render.

### Server-side mirror risk

`buildTokensFromOrder` exists in both `server/services/compositeService.js` and `client/src/pages/settings/OverrideEditorPage.js`. If the server's version evolves (new fields, different camelCase rules), the client diverges silently — the canvas preview and textarea would resolve differently from the actual render. Tolerable today because the function is small and stable. Both sites carry header comments cross-referencing the other so future-you sees the dependency; if the function ever changes meaningfully, the right move is probably a single `tokensForOrder` server endpoint the client calls, eliminating the duplication.

### Files

`client/src/pages/settings/OverrideEditorPage.js`, `client/src/components/LayoutCanvas.js` (export `substituteTokens`).

---

## 48a. Text color editing + conditional Save auto-return

Two enhancements bundled after Phase 48 verification surfaced operator workflow gaps. Both are confined to the override editor + one entry-point line on the order detail page; no server change.

### Text color editor

Operators can now change a text slot's color from the QuickEditPanel via a native `<input type="color">`. The picker's value is bound to `slot.color`, the existing property the layout JSON has carried since Phase 9b and that `compositeService._textSvg` already reads as `fill="${slot.color || '#000000'}"`. The 7-char hex format (`#rrggbb`) that the native picker emits is byte-identical to what's already in the layout JSON — no conversion, no schema change.

Other text styling (font family, weight, alignment) stays locked at the layout level, same rationale as Phase 47's original QuickEditPanel scoping: those are layout decisions and shouldn't be tweaked per-order. Color is the exception because operators occasionally need to recolor a name to be readable against a particular player photo's background — a per-order concern.

### Generalized "·custom" badge

Phase 48's `·custom` badge in the LayersList was text-only — it fired when `slot.text !== baseSlot.text`. Phase 48a generalizes the detection via a new `getCustomFields(slot, baseSlot)` helper that enumerates which non-geometry override fields differ from the base:

```js
function getCustomFields(slot, baseSlot) {
  if (!slot || !baseSlot) return [];
  const fields = [];
  if ((slot.text || '') !== (baseSlot.text || '')) fields.push('text');
  if ((slot.color || '#000000') !== (baseSlot.color || '#000000')) fields.push('color');
  return fields;
}
```

Geometry (x, y, w, h, fontSize) is intentionally excluded — those are layout nudges, not content overrides, and the badge would otherwise fire on every position tweak and lose its signal value.

The badge's semantic meaning shifts with this change: from "this slot has token-disconnect risk" to "this slot has been hand-edited." Broader but more useful — operators can scan the layers list and spot customized slots at a glance regardless of which field differs. The tooltip enumerates specifics: `Custom — base layout had: text="John Smith", color="#000000"`.

Future override capabilities extend the same helper. When image upload ships (a "Replace photo" affordance on player-photo slots), `slot.overrideImageUrl` joins the field check and the badge picks it up without further changes.

### Conditional Save (no render) auto-return

Phase 47a made Apply (Overwrite) and Apply (Reprint) auto-navigate to `/orders/<orderId>` on success, with the rationale that the rendered composite on the order detail page is itself the confirmation. Save (no render) intentionally stayed on the editor — the operator who's batch-staging multiple cart fixes in one order doesn't want a round-trip after every Save.

Phase 48a adds a conditional: **stay-on-editor remains the default, but the single-item fix flow auto-returns**. Distinguished by query param `?from=order`:

| Entry point | Query param | Save (no render) behavior |
|---|---|---|
| OrderDetailPage "Edit layout" button (Phase 46) | `?from=order` appended | Auto-returns to order page on success |
| Settings → Order Overrides search (OrderOverridesPage) | none | Stays on editor (existing behavior) |
| OrderSwitcher inside the editor (Phase 11a) | none | Stays on editor |

Apply (Overwrite/Reprint) ignore the param — they always navigate to the order page on success, same as Phase 47a.

### Why query param over `location.state`

React Router's `location.state` is more idiomatic for "where did you come from" semantics but **doesn't survive a hard refresh** — operator who Ctrl+Shift+R's mid-edit silently loses the auto-return context and the post-save behavior reverts to staying on the editor. Query param persists in the URL and survives refresh, copy-paste, and bookmarks. The UI-hint nature (no permission decision rides on it) means manual manipulation has no security cost — worst case the operator strips `?from=order` and Save stays on the editor instead of returning, a benign degradation.

### Edge cases

- **Manual URL strip of `?from=order`**: Save stays on editor. Operator navigates back manually. No data loss.
- **Hard refresh mid-edit**: URL param persists → behavior preserved.
- **OrderSwitcher mid-edit**: `switchTo()` calls `navigate()` with a new path and no propagated query — naturally drops `from`. Saving the new cart line stays on editor. Probably correct: once the operator switches cart lines they're effectively in multi-item mode.
- **Middle-click "Edit layout" → new tab**: param is in the URL → new tab's Save returns its own tab to the order page. Original tab unaffected.

### Files

`client/src/pages/OrderDetailPage.js` (append `?from=order` to the navigate URL — one site, the Phase 46 "Edit layout" button); `client/src/pages/settings/OverrideEditorPage.js` (read `from=order` via `useSearchParams`, navigate on Save success when set, color picker in QuickEditPanel, generalized `getCustomFields` badge detection).

---

## 49. Photo thumbnail proxy with disk cache

The dashboard's line item card tiles rendered `lineItem.photo.fullUrl` as the `<img src>`. Phase 12a's reasoning — "prefer un-watermarked original over watermarked thumbnail" — held but the cost wasn't measured at the time: Sytist's S3 buckets serve originals at full resolution, 6–10 MB per photo. A 30-item order downloaded 200–300 MB to render 30 tiny tiles. Production page load reached "up to a minute" per Joey's report (DevTools-confirmed 2026-05-14).

Phase 49 v2 adds a server-side resize proxy. The line item card's `<img src>` now points at `/api/sytist/photo-thumb?src=<encoded>&w=400`. The route fetches the source from S3, resizes to 400-px max edge with `sharp` (~30–60 KB), caches the result to local disk, and serves it. `<a href>` click-through still uses `fullUrl` so operators who actually want to inspect the photo at full size get the un-watermarked original.

### Why "v2" and what changed from v1

Phase 49 v1 (reverted at `9db1e15`) shipped with `requireAuth` on the proxy route on the assumption that same-origin `<img>` requests would carry session cookies. They didn't — CRA dev-proxy + SameSite cookie semantics broke the flow, and every `<img>` got 401. v2 drops auth entirely and hardens the SSRF validation as the only line of defense.

| v1 | v2 |
|---|---|
| `requireAuth` applied (caused 401s on every image) | No auth; SSRF validation only |
| Hostname check via `endsWith('.amazonaws.com')` | Hostname check via exact-match allowlist (env-configurable) |
| Query string and fragment ignored | Query string and fragment rejected |
| `fetch(src)` followed redirects by default | `fetch(src, { redirect: 'error' })` |
| Also swapped OverrideEditor switcher | Switcher stays on `fullUrl` (out of scope) |
| 60-second fetch timeout | 20-second fetch timeout |
| Defensive comment about auth being belt-and-suspenders | Explicit comment + CLAUDE.md note documenting the no-auth-because-localhost assumption |

### Source URL validation (SSRF)

`photoThumbService._isValidSource` accepts only URLs that:
- Use the `https:` protocol
- Have a hostname exactly in `ALLOWED_HOSTS` (env-configurable via `PHOTO_PROXY_ALLOWED_HOSTS`, default `s3.dualstack.us-east-1.amazonaws.com`)
- Have no embedded credentials (`user:pass@host`)
- Have no query string
- Have no fragment
- End in `.jpg`/`.jpeg`/`.png`/`.webp` (case-insensitive)
- Have no `..` or `//` in the pathname

The fetch additionally uses `redirect: 'error'` so a 3xx response from S3 to a host outside the allowlist throws rather than silently following.

### No-auth rationale

The dashboard runs on Joey's local Windows machine, not exposed to the public internet. The proxy can only fetch from `*.amazonaws.com` hosts in the allowlist — anyone reachable to the server can pull resized Sytist photos, but they could also hit Sytist S3 directly, so the proxy doesn't add capability they don't already have. Auth on this specific route would protect nothing meaningful while consistently breaking `<img>`-based consumption (v1 demonstrated this).

**If the dashboard ever moves to a public-facing deployment**, the right move is signed URLs (HMAC over `src + width + expiry`), not patching cookies. Captured in both the route's inline comment and CLAUDE.md → Cross-platform notes.

### Disk cache

`server/config/photo-cache/` relative to the service via `path.join(__dirname, '..', 'config', 'photo-cache')`. Portable. Filename is `sha1(srcUrl + '|' + width).hex + '.jpg'`. Flat directory, no subdirs. `mtime` is touched on every cache hit so popular photos stay alive while orphans age out. Gitignored.

The placeholder lives at `_placeholder.jpg` in the same directory. Generated once at service init via `sharp` over an SVG label ("Photo unavailable" on a dark background). Re-used on every source-fetch failure or validation rejection.

### Sweep

TTL-based, 60 days by default. Runs once per ~24h piggybacked on `schedulerService._pollOnce` — the SS sync poll already runs every 5 minutes, so a `_lastPhotoCacheSweepAt` check is essentially free. Sweep enumerates the cache directory, deletes files with `mtime < cutoff`, skips the placeholder, and has a 30-second hard time cap. No size cap in v1.

### Cache headers

- Success: `Cache-Control: public, max-age=86400, immutable` — content is keyed by `sha1(src + width)`, effectively immutable for the lifetime of the source.
- Placeholder: `Cache-Control: public, max-age=60` — short cache so transient Sytist outages clear quickly when the source recovers.
- `X-Photo-Thumb-Status` header is `cache-hit`, `fresh`, or `placeholder` for forensic logging.

### Fetch timeout: 20 seconds

The diagnostic that motivated Phase 49 v1 observed one pathological case of 230 s to download a 7.5 MB photo. v1 set timeout to 60 s to "accommodate the bad case." v2 cuts to 20 s based on operational reasoning: if a fetch takes >20 s the operator has already given up scrolling that order anyway, and a 60-s wait holds an Express worker uselessly. 20 s captures realistic slow paths (5–15 s S3 spikes) without the worst-case hold.

If the 230 s scenario recurs, the operator sees the placeholder, the placeholder's 60 s `max-age` expires within a minute, refresh retries, and the cache typically populates on the second attempt.

### Node fetch quirk worked around

v1 initial implementation used `AbortController` with `signal: controller.signal` passed to `fetch`. On Node 22.13.1, this causes `resp.arrayBuffer()` to hang indefinitely after headers arrive — verified empirically. v2 (and the final v1 before revert) uses `Promise.race` with a separate timeout promise instead. The orphaned fetch on timeout gets GC'd; acceptable for a 20 s ceiling.

### Scope of client edits

**One `<img src>` site changed** — `LineItemRow` tile in `OrderDetailPage.js`. The `OverrideEditor` switcher (v1 also swapped) is intentionally **out of scope** in v2: operators visit it rarely, slow load is acceptable there, and a swap would have to thread the composed-thumbnails cache map down into the switcher to be safe — more code surface for a rarely-hit path.

`LayoutCanvas` main editor view, `<a href>` click-throughs, and Phase 37 download links keep `fullUrl` for the same reasons as v1: editor needs hi-res for WYSIWYG, operator-initiated full-quality views, operator-expected slow.

### Why this matters more than initially framed

The Phase 47 hotfix 2 diagnosis surfaced that 546 of 555 recently-processed composite-mapped orders went through Kirsten's upstream tool, not our dashboard. Those orders have no S3 composite cache entry, so their LineItemRow tiles fall through to the player photo fallback — exactly the path Phase 49 v2 speeds up. The fallback was framed in v1 as "rare edge case"; v2 ships knowing it's the common path.

### Verification

1. Open an order with mostly non-composite items (or one Kirsten processed). Confirm tile thumbnails load in <500 ms warm, within ~15 s cold.
2. Network tab: tile `<img>` requests hit `/api/sytist/photo-thumb` returning 200 with `X-Photo-Thumb-Status` header.
3. `dir server\config\photo-cache\` shows growing `<sha1>.jpg` files (30-60 KB each) as orders are viewed.
4. **Verify `.gitignore` works**: after the cache populates with a few files, run `git status` — `server/config/photo-cache/` should NOT appear as untracked or modified.
5. Click a tile → opens un-watermarked original at full size in new tab.
6. Force a bad URL (DevTools tamper to a non-allowlist host) → placeholder appears, layout stable, `X-Photo-Thumb-Status: placeholder`.
7. After 24h+ uptime: `[PhotoCache] swept N files, freed M MB` line in scheduler log.

Files: `.gitignore`, `server/services/photoThumbService.js` (new), `server/routes/sytist.js`, `server/services/schedulerService.js`, `client/src/pages/OrderDetailPage.js`

### Phase 49 v2.1 — alpha preservation hotfix

**Bug**: Phase 49 v2 shipped with `.jpeg({ quality: 80 })` as the only output format. JPEG has no alpha channel. When the proxy received a transparent PNG (Sytist's green-screen keyed-out subject photos), sharp flattened the transparent areas against its default black background. The resulting JPEG was rendered on top of the chosen background photo in `LineItemRow`'s fallback stack, producing **black where the customer's background should have shown through**. Reported by Joey 2026-05-14 shortly after deploy.

Composite-cached items were unaffected (they take the IF branch with `composedThumbnailUrl` and skip the proxy entirely). Plain-photo items were unaffected (opaque source, JPEG output fine). Only green-screen items with no cache row were broken — which, after the Kirsten finding (Phase 47 hotfix 2), is most green-screen items in production.

**Fix**: format-aware output in `photoThumbService`. The output format is inferred from the source URL's extension:

- `.png` source → WebP output (preserves alpha)
- `.jpg` / `.jpeg` / `.webp` source → JPEG output (smaller for opaque)

The inference is URL-based, not content-based — probing alpha via `sharp.metadata()` would require fetching the source first, which defeats the cache. The cache filename uses the inferred format's extension (`<sha1>.webp` or `<sha1>.jpg`) so the cache lookup remains a single deterministic `readFile`. Same URL always produces the same cache filename; old `.jpg` entries for PNG sources orphan automatically when the new code computes `.webp` for the same URL.

`getOrCreate` now returns `{ buffer, format, fromCache, isPlaceholder }`. The route at `/photo-thumb` sets `Content-Type: image/webp` or `image/jpeg` based on `format`. Placeholder remains JPEG (opaque dark rectangle, no alpha needed).

Sweep was updated to delete both `.jpg` and `.webp` files (matched on extension, with the placeholder explicitly skipped by exact name).

**Known assumption**: the URL-extension inference assumes `.webp` sources are opaque. Sytist doesn't serve WebP sources today (only PNG for green-screen subjects, JPEG for everything else). If that changes AND the WebP sources carry alpha, `_inferOutputFormat` needs to widen to `ext === '.png' || ext === '.webp'`.

**Verified** before commit: synthetic transparent PNG (red circle on alpha=0) run through the new pipeline — output WebP retains `hasAlpha: true, channels: 4`. Opaque JPEG control case produces `hasAlpha: false` output.

**Deploy step required**: existing `.jpg` cache entries for PNG sources are still on disk and won't be reused (the new code looks for `.webp` at a different filename), but they take disk space until the 60-day TTL expires. To free that space immediately, run after deploy:

```cmd
del /Q server\config\photo-cache\*.jpg
```

The `_placeholder.jpg` regenerates automatically on next service init.

Files: `server/services/photoThumbService.js`, `server/routes/sytist.js`

### Phase 49 v2.2 — metadata-based format detection (v2.1 was still wrong)

**Bug**: v2.1's URL-extension inference (`.png` → WebP, else JPEG) turned out to be unreliable for Sytist's actual photo URLs. Operators reported black-background regression still occurring for transparent green-screen subject photos — the source URLs don't consistently end in `.png`, so the inference defaulted to JPEG and the alpha got flattened again. v2.1 fixed only the subset of cases where Sytist happened to use `.png` extension.

**Fix**: switch to ground-truth detection. After fetching the source buffer, probe alpha via `sharp.metadata().hasAlpha` and choose output format from that. URL extension is no longer consulted — it's a guess; alpha-channel detection is the actual signal.

**Cache key design**: format is now determined AFTER fetch, not before. This means cache lookup can't predict which extension to read. Solution: store the hash key without an extension and try **both** `<key>.webp` and `<key>.jpg` on lookup. Same URL always produces the same hash → at most one of the two files exists in steady state. The lookup cost is two failed `readFile`s on miss (both ENOENT, fast) vs one on hit. Negligible.

```js
const key = sha1(src + '|' + width).hex;
const webpPath = ${key}.webp;
const jpegPath = ${key}.jpg;
// try webp → try jpeg → miss → fetch + metadata + write
```

**On cache miss**:

1. Fetch source.
2. `sharp(buffer).metadata()` — reads header bytes only, cheap.
3. `format = meta.hasAlpha ? 'webp' : 'jpeg'`.
4. Resize + encode in chosen format.
5. Write to `${key}.${format === 'webp' ? 'webp' : 'jpg'}`.

**X-Photo-Thumb-Status header** now includes the format suffix for diagnostic clarity. Values: `placeholder:jpeg`, `cache-hit:webp`, `cache-hit:jpeg`, `fresh:webp`, `fresh:jpeg`. When this regresses for a third time (it won't, but if it does), the format part of the header tells future-you instantly what the proxy decided.

**Code cleanup**: `_inferOutputFormat` removed (dead code). `_cachePath` renamed to `_cacheKey` — returns just the hash string, not a `{path, format}` object. The route's `Content-Type` still follows the service-returned `format` field.

**Sweep**: unchanged — already handles both extensions and the TTL check is format-agnostic.

**Verified**: opaque JPEG and transparent PNG roundtripping was verified against synthetic inputs in v2.1's pre-commit checks. v2.2 changes the detection mechanism, not the encoding pipeline, so the alpha-preservation guarantee carries forward.

**Deploy step required**: clear both `.jpg` and `.webp` cache entries. Existing files include the broken black-background `.jpg` files that v2.1 wrote for transparent sources at unrecognized URL extensions. Letting everything regenerate cleanly:

```cmd
del /Q server\config\photo-cache\*.jpg server\config\photo-cache\*.webp
```

Placeholder regenerates on next service init.

Files: `server/services/photoThumbService.js`, `server/routes/sytist.js`

### Phase 49 v2.3 — cache header fix + request-entry log

**Bug**: v2.2 set `Cache-Control: public, max-age=86400, immutable` on success responses on the (wrong) assumption that the URL → bytes mapping never changes. Across v2 → v2.1 → v2.2 the URL stayed the same but the bytes changed (broken JPEG → broken JPEG → correct WebP). Browsers that had cached the v2-era output refused to even ASK the server for the URL again — `immutable` tells the browser not to revalidate, ever, within the max-age window. Including on hard refresh, for `<img>` subresources, on Chrome at least. Affected operators saw stale black-background JPEGs from their browser cache while incognito windows (no shared cache) showed the correct WebP. Diagnosed by Joey 2026-05-14: incognito showed correct render; main browser showed stale.

**Fix part 1: drop `immutable`, switch to `stale-while-revalidate`.**

```js
// Was:
res.set('Cache-Control', 'public, max-age=86400, immutable');
// Now:
res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
```

- 0–3600 s: browser serves cached bytes directly. Identical UX to before.
- 3600–86400 s: browser serves cached bytes **immediately** AND fires an asynchronous background revalidation. If the server returns different content, the cache updates for the next page load. Operators never wait on cache expiry.
- 86400 s+: browser must fully refetch.

This sidesteps the cache-expiry wait that plain `max-age=3600` would impose, while allowing the cache to actually catch up with server-side fixes. When we ship a proxy bug fix, operators see the new bytes silently within one cache cycle — no `Ctrl+Shift+Delete` ritual.

Placeholder responses stay at `Cache-Control: public, max-age=60` (unchanged — failures should clear quickly).

**Fix part 2: request-entry log.**

v2 / v2.1 / v2.2 only logged on errors. A successful proxy hit was completely silent. That meant "is the proxy being called?" was inferred from the absence of error logs, which is not the same thing. Diagnostic for this exact bug got stuck because the user couldn't tell from logs whether the v2.2 server code was running.

Added a per-request log line in `routes/sytist.js`'s `/photo-thumb` handler:

```
[PhotoThumb] GET <full src URL> → <statusBase>:<format> (<bytes>)
```

Example outputs:
- `[PhotoThumb] GET https://s3.dualstack...png → cache-hit:webp (15584 bytes)` — fast path, expected for green-screen items
- `[PhotoThumb] GET https://s3.dualstack...jpg → fresh:jpeg (45123 bytes)` — first view of an opaque source
- `[PhotoThumb] GET https://evil.example.com/x.png → placeholder:jpeg (2446 bytes)` — SSRF rejection

Cost: ~200 bytes of log per proxy request. At ~30 line items per order page and a few orders viewed per day, that's a few hundred KB/day. Trivial.

**Verification path post-deploy:**
1. Server restart picks up the change.
2. Affected operators clear their browser cache one time (Ctrl+Shift+Delete → cached images and files → all time) — this is necessary because v2.2-era cached `immutable` entries override the new directive until they expire. Or use a different browser profile for ~24h until the old cache TTL passes.
3. Future proxy hits write a log line — easy to grep for `[PhotoThumb]` to confirm requests are landing on v2.3 code.

Files: `server/routes/sytist.js`

---

## 50. Operator-uploaded image override

Operators occasionally need to replace the photo a composite slot renders — wrong subject tagged, customer requested a different pose. Before Phase 50 the only fixes were indirect (rename in Sytist, edit the base layout). Phase 50 adds a direct per-(orderId, cartId, slotIndex) image upload in the override editor.

**Scope (read this):** the uploaded image takes effect via the override editor's **Apply (Overwrite) / Apply (Reprint)** path only. Normal **Process does NOT yet honor it** — that's a pre-existing gap affecting *all* override types (text/color/position/image), not Phase 50-specific, and it contradicts the Phase 40 docs which describe Process honoring overrides. Phase 52 delivers that uniformly. Until Phase 52, an operator who uploads an image then clicks Process (rather than Apply) gets the default photo.

### Storage

`server/config/order-asset-overrides/<orderId>/<cartId>/<slotIndex>.<ext>`, gitignored runtime data. `orderAssetOverrideService` owns all disk I/O: magic-byte sniff (PNG/JPEG/WebP only — SVG and everything else rejected regardless of filename), 10 MB cap, `.tmp`+rename atomic write, prior-extension orphan cleanup on re-upload. Path safety is internal: integer-only orderId/cartId/slotIndex plus `path.resolve` + `startsWith(base + sep)` on every read/write/unlink — nothing can escape the asset root. `deleteCartAssets` wipes the per-cart tree when the override row is DELETEd.

Eligible slot kinds: `playerPhoto`, `teamPhoto`, `logo`, `playerBackground`. `staticGraphic`/`overlay` deferred (layout-fixed graphics, rarely per-order).

### Endpoints + the auth split (Defect A)

`POST` (upload) and `DELETE` (remove) are auth-gated (`requireRole('admin','operator')`) — they go through `api.*` (fetch with credentials). `GET` (image fetch) is consumed by `<img src>`, which **cannot carry the session cookie across the CRA dev-proxy + SameSite** — the exact Phase 49 v1 failure. Phase 50's first cut registered GET after `router.use(requireAuth)` and 401'd every preview (Defect A). Fix: the GET is registered *before* `router.use(requireAuth)` and is auth-free, mirroring the photo-thumb placement. Threat model differs from photo-thumb — no SSRF surface (local files only, no remote fetch) — so the residual no-auth risk is just ID-enumeration of override images on a localhost-only server, consistent with the existing posture. Same signed-URL caveat as photo-thumb if this ever goes public.

POST scoped to a 15 MB `express.json` parser (10 MB binary → ~13.4 MB base64 > the global 10 MB limit), mirroring `graphicUploadJsonParser`.

### Snapshot integration + render fallback

Upload writes the file, returns `overrideImage` metadata; the client mutates `slot.overrideImage` in the in-memory snapshot and re-saves it via the existing override POST (URL carries `?v=<uploadedAt-ms>` so a re-upload busts the browser cache). `renderOverrideForOrder` resolves each image-kind slot's buffer from disk via `orderAssetOverrideService.readAssetBuffer`; **missing-on-disk falls back to the default image resolution for that slot** (protects against backup/restore mismatch and manual deletion — never fails the render).

Client: `QuickEditPanel` drag-drop zone + file input + "Custom image" indicator + Remove control; `LayersList` `·custom` badge generalized via `getCustomFields` gaining `'image'`; `LayoutCanvas` previews `slot.overrideImage.url` over the default.

### Files

`server/services/orderAssetOverrideService.js` (new), `server/routes/sytist.js`, `client/src/pages/settings/OverrideEditorPage.js`, `client/src/components/LayoutCanvas.js`, `.gitignore`.

### Hotfix: stale order-detail thumbnail after Apply Overwrite

Browser verification surfaced a layer-5 bug independent of Phase 50's pipeline: after Apply Overwrite the order-detail line item thumbnail kept showing the pre-override composite. Diagnosis walked all five layers — `renderOverrideForOrder` ran, wrote the composite (override image confirmed present in the file), and Phase 47b published to S3 with `composed_thumbnails.updated_at` advancing. The composite in S3 was correct (incognito proved it). The failure was the **Phase 49 v2.3 cache lesson recurring in a different code path**: the composed-thumbnail S3 object lives at a *stable key* (`sytist-dashboard-composed/<orderId>/<cartId>.jpg`); Apply Overwrite replaces its bytes at the unchanged URL; the order-detail `<img src>` had no cache-buster, so the browser served the stale cached composite. Phase 47c's "⚠ Layout edited" staleness badge *cleared* correctly (cache newer than override), which masked the bug — the system believed it was fresh while the browser displayed stale bytes (exactly the v2.3 trap: server correct, browser cached).

Fix is endpoint-level: `/orders/:orderId/composed-thumbnails` appends `?v=<updated_at-epoch>` to each thumbnail URL (the endpoint already had `updated_at` per row for the Phase 47c stale calc). One source of truth → every browser consumer (`<img src>` and the click-through `<a href>`) gets the cache-busted URL with zero OrderDetailPage changes; the `?v=` advances exactly when the composite is re-rendered. Deliberately **not** applied in the DB/service layer so server-side consumers (ShipStation payload, packing slip) keep the bare URL — they fetch server-side with no browser cache, and a query string can trip ShipStation's image-URL handling. The override editor switcher was checked and is not affected: it renders raw Sytist photo URLs (`li.photo.fullUrl`), not the stable composed S3 key.

Files: `server/routes/sytist.js`.

---

## 52. Process honors saved overrides (delivers Phase 40)

Phase 40 (§40) specified that normal Process/Reprint would consult `orderOverrideService` and render the operator's saved override instead of the SKU-mapped layout. Only the UI shipped; the pipeline wiring never did. For months, **every saved override — text (§48), color (§48a), position, image (§50) — was silently ignored by Process**. Overrides only took effect via the editor's *Apply (Overwrite/Reprint)* (`renderOverrideForOrder`). The gap was invisible because the two paths looked equivalent and nothing tested Process-with-override. Surfaced during Phase 50 image-override browser verification.

Phase 52 delivers the real wiring, factored so the two render paths **cannot drift again**.

### Shared module: `overrideRenderService`

Both `processingService` (Process) and `renderOverrideForOrder` (Apply) now call one policy layer:

- **`resolveLayoutAndVariant({ lineItem, override?, explicitLayout?, mapping? })`** → `{ layout, variant, layoutSource, mapping, warnings }`. Precedence: `explicitLayout` (override-DELETE restore) > usable `override.layoutSnapshot` (wholesale) > SKU mapping. Returns `layout:null` when nothing resolves — the caller decides fatality (`renderOverrideForOrder` throws; `processingService` warns + skips the item). Never throws itself. No DB access — the caller passes the loaded `override` in, so the module stays decoupled from `orderOverrideService`.
- **`applyImageOverrides({ orderId, cartId, layout, variant, buffers })`** → `{ buffers, warnings }`. The verbatim lift of the Phase 50 inline image-override loop. Missing-on-disk → keeps the default buffer + a warning; never fails the render.

### The variant bug, fixed as part of this (deliberate, documented)

`renderOverrideForOrder` previously resolved the layout from the override snapshot but then **recomputed the variant via `pickVariant(playerPhoto w/h)`, ignoring `override.variant`**. The editor only populates the variant the operator edited; the other variant in the snapshot is empty. So an override saved against `vertical` rendered against an empty `horizontal` whenever the player photo was landscape — silently dropping *all* the operator's edits (and, post-Phase-50, the image override too). It didn't bite the Phase 50 test order only because that player photo was portrait, so `pickVariant` coincidentally returned the edited `vertical`. `resolveLayoutAndVariant` now uses `override.variant` (falling back to `pickVariant` only when that variant is absent/empty in the snapshot, with a warning). This **changes a previously-shipped path's behavior** (`renderOverrideForOrder` variant source), which is why the Apply (Overwrite/Reprint) paths were re-verified alongside Process, not assumed safe.

### processingService wiring

- One batched read per order before the composite loop: `orderOverrideService.listByOrderWithSnapshots(orderId)` → `Map<String(cartId), override>` (new method — `listByOrder` is deliberately light and omits `layout_snapshot`). One indexed query, not an N-line-item `.get()` fan-out; a read failure is non-fatal (falls back to SKU-mapped, i.e. pre-Phase-52 behavior).
- Inside the loop, after the existing `findMapping` (which still gates the loop and still drives `chainToImposition`/specialty/green-screen unchanged), `resolveLayoutAndVariant` chooses layout+variant; `applyImageOverrides` runs just before `buildSheetBuffer`. `layoutSource` is logged when an override is used.

### Degradation

`isUsableSnapshot` gates the wholesale swap (object with a non-empty `variants` map). Unusable snapshot → fall through to SKU-mapped + a warning. `override.variant` missing/empty-in-snapshot → `pickVariant` fallback + a warning. Override image file missing on disk → that slot keeps its default buffer + a warning. An override can degrade an item to default output; it can never abort the order or throw out of the loop.

### Files

`server/services/overrideRenderService.js` (new), `server/services/processingService.js`, `server/services/orderOverrideService.js` (`listByOrderWithSnapshots`), `server/routes/sytist.js` (`renderOverrideForOrder` refactor — variant-bug fix lands here).

### Post-ship fix + verification

First Process verification of an *image* override failed (#3) while text/color/position passed — the diagnostic key: those live in the snapshot (returned wholesale by `resolveLayoutAndVariant`) and never touch the integer-gated `orderAssetOverrideService`, but the image path does, and the canonical order shape supplies `orderId` as a String (`sytistDbService: String(o.order_id)`). `Number.isInteger()` is false for strings → `readAssetBuffer` silently returned null → Process kept the default photo. `renderOverrideForOrder` had passed `parseInt`'d numbers, which is why Apply worked and Process didn't. Fixed by coercing `Number(orderId)`/`Number(cartId)` at the `applyImageOverrides` shared boundary (not by loosening the path-escape guard, which is a security control). Synthetic addon/pkg cartIds → NaN → null → default fallback, which is correct: `saveAsset` gates identically so such carts can never have a stored asset.

Verified by a real Process/Reprint run (order 111118 cart 483792): `[Processing] … using SAVED OVERRIDE layout (variant=vertical)` then `[OrderAsset] applied override order=111118 cart=483792 slot=2 kind=teamPhoto bytes=5132331` (numeric id), S3 thumbnail re-published. Matrix #1–#6 + #3 + #8 browser-confirmed; #7 (deleted-asset graceful fallback) covered by the 24/24 offline smoke suite only.

---

## 54. Orders-list selection fix + shift-range + order-detail quick lookup

Three small operator-UX items, no server changes. (§53 is intentionally absent here — Phase 53 is logged as a planned follow-up, not yet built; section numbers track shipped phases.)

**1a — row checkbox was dead on direct click.** `OrderRow`'s checkbox had a no-op `onChange` that delegated selection to the wrapping `<td onClick>`, but the input *also* called `e.stopPropagation()` — which severed that delegation for the most common interaction (clicking the box itself). Net: only the thin `<td>` padding *around* the box toggled; clicking the checkbox did nothing. The header "select all" worked because it's a normal controlled checkbox (`onChange={onTogglePageSelection}`), which is why the operator could check the top one but no individual rows. Fix: make the row input a proper controlled checkbox — `onChange` drives selection directly; the `<td>` keeps `stopPropagation` so the checkbox still never triggers the row's open-order navigation (the click and change synthetic events are independent, so stopping the click bubble doesn't suppress the change).

**1b — shift+click range select (new).** Was never implemented (`shiftKey` appeared nowhere). `toggleOrderSelected` now takes `(orderId, index, shiftKey)`; the input reads `e.nativeEvent.shiftKey`. A plain toggle flips one order and sets a row anchor (`lastSelectedIndex`); a shift+toggle selects the inclusive range between the anchor and the clicked row (file-explorer model — always *adds* the block, never deselects). The anchor is dropped on filter change and guarded against a stale/out-of-range index (degrades to a single toggle), so a range can never be computed across a different `orders` array.

**2 — "Go to order #" on every order-detail page.** The order-lookup mechanism already existed but only on the not-found view. `NavStrip` now carries a small lookup form (same `navigate('/orders/<id>')` one-liner) so operators can jump to any order from any order-detail page without returning to the list. Deliberately a *fresh* lookup — no `filterParamsKey` appended — because typing an explicit order number is a context switch, not movement within the current filtered set (the prev/next pager already covers in-set movement).

Files: `client/src/pages/OrdersListPage.js`, `client/src/pages/OrderDetailPage.js`.

---

## 55. Specialty subfolder filesystem-safety + visible download failures

Diagnosing a "missing Wall Cling" report on order 110924 (a 3-item order; the 2 composite Magnets reprinted fine, the specialty item produced nothing — no file, no log line). Root cause: SKU 29's specialty `subfolder` in `specialty-products.json` is `12" Wall Cling`. The `"` is a Windows-reserved path character (`< > : " / \ | ? *`); `path.win32.join(specialtyBase, '12" Wall Cling')` builds the string fine, but `fs.mkdir`/write throws `EINVAL`. The mkdir error was swallowed by an empty `catch {}`; the download error went into `subResult.photosFailed` — which only surfaces in the result UI, **not the server log** — so the whole specialty item vanished silently. This is exactly the CLAUDE.md "specialty soft-failure is easy to miss" landmine, and **not a reprint bug** — the shared Step 1 download loop would fail identically on a first Process; reprint was a red herring.

**Fix — three parts, no behavior change for healthy configs:**

1. **Sanitize the subfolder at its single use-point.** New `sanitizePathSegment()` in `specialtyService`: reserved chars + control chars → space, collapse whitespace, trim, strip leading/trailing dots+spaces (Windows also rejects a trailing dot/space on a directory). Applied in `getSpecialtySubfolder` (its only caller is the path construction in `processingService`); falls back to the SKU if sanitizing leaves nothing. The **stored config stays raw** — `productName`/display are untouched; only the value that becomes a real directory is made safe. Clean existing subfolders (Acrylic Ornament 3.5x5, Key Chain, …) are a no-op; SKU 29 now routes to `…\Specialty\12 Wall Cling`. Deliberate non-goal (flagged in code): reserved DOS device names (CON/PRN/NUL) — rare for photo-product subfolders.
2. **mkdir failure no longer swallowed** — the empty `catch {}` becomes a `console.warn` with the bad targetDir (earliest, clearest signal).
3. **Download failures are logged** — the `photosFailed` catch now also `console.warn`s, flagging `(SPECIALTY)`. A photo that won't download is a product that won't print; it gets a server-log line regardless of regular-vs-specialty, instead of being visible only in the result UI.

`sanitizePathSegment` is exported; 11/11 offline unit cases pass (inch-quote, slash/backslash, all-reserved→empty→SKU fallback, trailing dot, null/number coercion).

Files: `server/services/specialtyService.js`, `server/services/processingService.js`.

---

## 56. Synthetic-cart-ID override keying + Apply→imposition parity

Investigating order 110969 (ship_to_league, siblings, **Bronze Package** → constituents `483036-pkg-27` / `-pkg-12`): operator edits to package-constituent layouts weren't applying, with a confusing split — "Save (no render)→Process imposed but didn't apply the edit; Apply Overwrite applied but didn't impose." Root-caused to a *class* of latent bugs. The sibling/ship_to_league per-team split was confirmed **by design** (each team gets its own slip/divider/.txt), not a bug.

This phase fixes **four** pre-existing bugs (only the first two are the "headline"; #3/#4 are real correctness fixes future-you should be able to find):

**Bug 1 — `parseInt(cartId)` truncation (56a + addendum).** Every override route, every asset route, and the 3 imposition-preview routes did `parseInt(req.params.cartId,10)`. Package constituents/addons have synthetic IDs (`483036-pkg-27`, `483036-addon-69516`); `parseInt` truncated to the parent int (`483036`), collapsing both constituents onto one key and creating a save-vs-lookup mismatch (the editor/Apply keyed the parent int; Phase 52's Process keyed the full string). **cartId is now an opaque string end-to-end:** routes use `String(req.params.cartId)`; `orderOverrideService` binds `cart_id` as String (SQLite INTEGER-affinity: numeric strings normalize to int so pre-56 plain-int rows still resolve, non-numeric synthetic IDs store as TEXT — no table rebuild; pre-56 *collided* package/addon rows are unmigratable orphans, see below); `orderAssetOverrideService` gained `isSafeCartId` (`[A-Za-z0-9_-]`, bounded) replacing the `isPositiveInt(cartId)` gate; `overrideRenderService.applyImageOverrides` dropped its Phase-52 `Number(cartId)` (which 56a's gate change had turned into a *re-truncation*). Exhaustive sweep: zero `parseInt`/`Number` coercion of cartId anywhere in `server/`. `orderId` stays integer everywhere (always numeric).

**Bug 2 — Apply never imposed `chainToImposition` SKUs (56b core).** `renderOverrideForOrder` wrote only the composite and never ran imposition, so for chainToImposition SKUs (e.g. 110969's pkg-27/12) Apply produced the bare composite, never the imposed sheet the lab prints. Process was correct (Step 1.5 feeds the composite into Step 2 `composeSheetInPlace`).

**Bug 3 — Apply Reprint numbering collided.** Apply hardcoded `_REPRINT` (`baseFilename.replace(/\.jpg$/i,'_REPRINT.jpg')`); a 2nd Apply Reprint silently overwrote the 1st. Process used `_nextReprintNumber` (`_REPRINT[_N]`).

**Bug 4 — Apply wrote to the order ROOT, not the folder-sort subdir.** `renderOverrideForOrder` resolved `resolveFullPath('downloadBase', order, [])` (empty segments). Process always used `folderSortService` sort-segments. For folder-sorted orders, Apply Overwrite/Reprint (and the override-DELETE restore via `forcedOutputFilename`) never overwrote the file the `.txt`/lab actually print — even for non-imposed items. (Order 110969 only *looked* fine because its sort-segments were empty.)

**The fix — `printOutputService` (new shared module).** Single source of truth for the produce-output concern, used by both `renderOverrideForOrder` (Apply) and `processingService` (Process) so they can't drift again (same principle as Phase 52's `overrideRenderService`). Five functions: `resolveOutputDir` (folder-sort dir — verbatim extraction of Process's resolution), `nextReprintNumber(order, dir)` (caller-resolves-dir-once so Apply scans the same dir Process writes), `reprintSuffix`, `buildOutputFilename` (photo-derived for chainToImposition / composite-final otherwise — verbatim merge of Process's two name builders), `produceFinalOutput` (atomic `.tmp`+rename write, then in-place `composeSheetInPlace` for chainToImposition). Decision B (narrow extraction): `processingService`'s loop and its own Step 2 `composeSheetInPlace` are untouched; only `_nextReprintNumber`/`_buildPhotoFilename`/`_buildCompositeFilename`/Step-1 dir delegate to the shared module (byte-identical, single-sourced). `renderOverrideForOrder` is rewired onto `produceFinalOutput`; `forcedOutputFilename` removed (it re-injected the pre-56 root name — restore now reverts the correct canonical sort-subdir file). **Parity-plus-warning** (deliberate, not hard-fail — out of scope for a parity phase): a `chainToImposition` SKU with no imposition rule yields the bare composite at the photo-derived path *exactly as Process does today*, plus an `imposition_rule_missing` warning (returned **and** `console.warn`'d) so the misconfig is visible, not silent.

**Orphaned pre-56 overrides.** Any package or addon override created before Phase 56 was keyed under the truncated parent int; that collision already lost which-constituent information, so **no migration can recover it. Those rows are now inert orphans with no effect — re-create the affected overrides in the editor.** Plain-integer-cart overrides are unaffected (key identically before/after via SQLite affinity).

Files: `server/services/printOutputService.js` (new), `server/services/orderOverrideService.js`, `server/services/orderAssetOverrideService.js`, `server/services/overrideRenderService.js`, `server/services/processingService.js`, `server/routes/sytist.js`.

---

## 57. Composite-layout variant split — foundation (Phase 57A)

Operator goal: vertical and horizontal are **not** minor tweaks of one layout — they are parallel independent designs that happen to share a SKU (own canvas, dpi, background, graphics, slots). Before Phase 57 the layout-level props (`sheetWidth`/`sheetHeight`/`dpi`/`backgroundColor`/`graphics`) lived only at the layout root and were shared by both variants; only `slots` was per-variant. Editing canvas/background in the designer changed both variants — the faithful behavior of a shared-root model, not a UI bug.

**Option Y (chosen) over Option X.** Y = keep one layout object / one `id`, copy all layout-level props down into each variant, root retained as a **deprecated fallback**. X = variants become first-class layouts (SKU→two layoutIds, `pickVariant`→`pickLayout`). X was rejected: it rewrites the override-snapshot contract (`order_overrides` row, `overrideRenderService.resolveLayoutAndVariant`, `isUsableSnapshot`'s "non-empty variants map") — exactly the Phase 52/56 surface — and has no graceful back-compat. Y leaves that contract untouched, keeps the 10 existing layouts and all saved overrides rendering identically until intentionally diverged, and is a small blast radius. "variant" stays in the data model; a rename is a deferred cosmetic pass.

**Phase 57A — invisible foundation.** Three artifacts:

- **`compositeService` variant-first/root-fallback** at the 4 scalar reads (`dpi`, `sheetWidth`, `sheetHeight`, `backgroundColor`): `variantDef.X` → `layout.X` → original default, fallback operators preserved so an un-diverged variant is **byte-identical to pre-57**. The graphics-map render read is **not** in compositeService (it's `processingService.js:1552` + `routes/sytist.js:83/3220/3821`); switching it would thread the Phase-56 render path, so it is **deferred to 57B** — alongside the editor that first lets operators set a divergent per-variant graphics map. Until 57B, graphics resolves from root (byte-identical by construction).
- **Copy-down migration** (`server/scripts/migrate-layout-variant-copydown.js`): pure transform + CLI (`--dry-run`/`--check`). Copies each of the 5 root keys into every variant with **≥1 slot**, only if the variant doesn't already own that key. Non-destructive (root never deleted), idempotent (already-owned keys untouched; re-run = verified no-op), atomic (tmp+rename), never fabricates/populates an empty or absent variant (preserves `pickVariant`'s vertical-only fallback — 7 of 10 layouts are vertical-only). A lossless copy-down, not a lossy collapse.
- **Verification harness** (`server/scripts/verify-layout-variant-copydown.js`) — the ship gate. For every populated `(layout, variant)` it renders the canonical pre-migration shape and the migrated shape with identical synthetic inputs and asserts byte-identical buffers + equal dimensions; plus structural asserts (root copy-keys unmutated; each populated variant gained each root-present key deep-equal to root; variant-name set unchanged — no fabricated variant; empty/0-slot variants untouched) and idempotency (per-layout double-run copies 0 / deep-equal, plus a document-level double-run no-op). **13/13 populated render cases green** — 10 vertical-only layouts + 3 both-variant layouts × 2 = 13. The only non-rendered variants are empty/absent ones (not renderable by design, `pickVariant` never selects them) and they are still structurally asserted untouched — there is **no scope reduction**; an earlier "16 cases" figure was an arithmetic error in scoping prose, never a dropped scope.

Phase 57A changes nothing visible to operators. After it ships and is pushed, the live migration is run as a deliberate, **separate operator step** so the real-order soak exercises the actually-migrated path, not just the byte-identical fallback. **Phase 57B (planned):** `LayoutDesignerPage` meta-editor write-target flip → `variants[activeVariant]`; copy-on-write UX (inheriting field editable showing the muted shared value; first edit promotes to "● Own value" with a "Use shared default" revert link — chosen over an explicit "Make independent" button); at-a-glance own/inherit badges; panel banner showing **both** inherit and independent counts; the graphics-read variant-first switch; operator docs.

Files (57A): `server/services/compositeService.js`, `server/scripts/migrate-layout-variant-copydown.js` (new), `server/scripts/verify-layout-variant-copydown.js` (new).

---

## 57B. Composite-layout variant split — designer + per-variant graphics

57A made vertical/horizontal *capable* of being independent (data model + render fallback + lossless migration). 57B delivers the **operator-facing surface** for that independence in the designer and extends per-variant ownership to the layout's `graphics` map — closing every gap the 57A "graphics-read deferred" note flagged.

**Shipping the designer (steps 1+2 + canvas-reflection completion).** `LayoutMetaEditor` writes canvas/dpi/background to the **active variant** via two new parent handlers: `handleVariantMetaChange` (copy-on-write — writes `variants[activeVariant].X`, creating the variant if absent with the same immutable pattern as `updateVariantSlots`) and `handleVariantMetaReset` ("Use shared default" — deletes the variant's own key to revert to inheriting the deprecated root). `name` stays root (one layout identity across orientations). Each scalar field shows the **effective** value (`variantDef.X ?? layout.X ?? default`, mirroring 57A's render resolution), an unambiguous **● Own** pill vs muted italic *Inherited (shared default)* badge, and a "Use shared default" link only when owned; a panel banner above the fields shows both counts ("N independent · M inheriting shared default") so divergence is as visible as inheritance. Editing an inheriting field promotes it to own with no extra click (copy-on-write was operator-chosen over an explicit "Make independent" button — fewer clicks, banner mitigates silent-divergence risk).

The first try shipped only the write-target flip and the operator surfaced that **the editing canvas didn't re-orient** — a real bug, not a UX nit. The fix was an unsplit part of the same change: `LayoutCanvas` + `LayoutDesignerPage` now resolve canvas/dpi/bg variant-first/root-fallback at **every** editing-surface site — canvas aspect (the cause of "stays vertical"), drag-clamp/zoom-fit bounds, bg fill, the `W″ × H″ @ dpi` label, new-slot placement, and `LayersPanel` slot-bound hints. The designer surface now matches what will print for the active variant (e.g. Magnet Horizontal 5×3.5 vs Vertical 3.5×5 — operator-verified live).

**Per-variant graphics (step 3, server + client, decisions a–d).** The 57A "graphics-read deferred" note is closed. Decisions, all operator-approved this session:

- **(a) Variant-namespaced keys.** Keys are namespaced `${variant}__<name>` end-to-end (storage key = on-disk filename = slot `graphicKey`). The shared per-layout on-disk bucket `composite-graphics/<layoutId>/` is unchanged; namespacing prevents vertical/horizontal collision without splitting the bucket physically. `compositeGraphicsService` needs **zero** changes.
- **(b) Explicit `variant` in mutation bodies.** POST upload and DELETE require `variant` in the JSON body and validate `key.startsWith(variant + '__')` — a graphic can never be written to the wrong variant's map (or the deprecated root, which the routes never write). `api.del` gained an optional JSON body (backward-compatible) for the DELETE.
- **(c) Legacy "Shared (legacy)" group, per-key divergence.** Root `graphics` is the **deprecated read-only fallback** — never written by the routes again. The GET list takes `?variant=` and returns the variant's own graphics + a separate `legacyShared` group; the client renders that as a read-only "Shared (legacy)" group below the variant grid, with each entry hidden **individually** only when the variant uploads its own same-base-name replacement (per-key divergence beats all-or-nothing — operator pushed back on the original "hide once any variant graphic exists" rule because real workflow is gradual replacement).
- **(d) No per-slot graphics revert.** Graphics divergence is managed at the library level, not the slot. Slots keep their `graphicKey`; render resolves variant-first → root-fallback. A slot picker shows the variant's own first, a labelled `──── shared (legacy) ────` separator, then `(legacy) <key>` entries — all selectable — so existing slots can still point at legacy assets during gradual replacement.

**Render-read surface (deferred from 57A, completed here).** All three render reads inline the same variant-first/root-fallback pattern: `processingService.js:1562` (Process Step 1.5), `routes/sytist.js:3232` (`/composite/preview`), `routes/sytist.js:3837` (`renderOverrideForOrder` — the Apply override path, kept in lock-step with Process per the anti-drift constraint). The two variant-agnostic stream routes (preview at `:79`, info at `:4302`) use a new module-local helper `resolveGraphicMeta(layout, key)` that scans all variants then root — same precedence, key-driven (works for both namespaced and legacy bare keys).

**In-memory adopt (the riskiest piece).** Upload and delete were the only writes that touched the in-memory layout's graphics map. The existing "uploads aren't unsaved-changes, slot edits are" contract had to be **scoped to the variant** without clobbering unsaved slot edits or other variants. Per Decision A the post-mutation merge now adopts only `fresh.variants[activeVariant].graphics` into `prev.variants[activeVariant].graphics` (and the same narrow update on `originalJson` so an upload doesn't flip `isDirty`). Slots, every other variant, and root are untouched.

**Rollout (server-first, then client).** Server shipped first, client second — between commits, the not-yet-updated designer's GET list still worked (no-variant path preserved its pre-57B behaviour) but upload/delete returned **`400 variant is required`** because the server immediately enforced the new contract. The operator paused upload/delete during the brief window. Closed when the client commit landed.

**Verification (step 4 harness, `server/scripts/verify-layout-variant-graphics.js`).** 26/26 offline cases pass: (A) namespacing/contract — bare/mismatched/empty-variant rejected; (B) `resolveGraphicMeta` variant-first/root-fallback across populated/empty/null layouts; (C) the 3 render reads — variant own beats root, root fallback, **variant isolation in both directions** (vertical entry never resolves on horizontal and vice-versa), legacy bare-key slot refs keep rendering via root; (D) namespaced keys are distinct ⇒ no on-disk collision; (E) Decision B per-key legacy hiding (matches the client's `visibleLegacyGraphics`); (F) real `composite-layouts.json` sanity — 6 cases proving un-diverged production data (MM-General's root graphics post-57A migration, plus the operator's hand-uploaded `Horizontal-Calm-Gray-Memory-Mate` legacy PNG) renders identical filenames on both variants via fallback.

**Existing graphics were never touched, renamed, or moved by 57B.** Every change is either a read-path resolution (read variant-first, fall back to root for legacy/un-namespaced keys) or a *stricter* mutation route that only runs on explicit operator action. The 57A migration's copy-down already placed root graphics into populated variants for back-compat; legacy operator-uploaded root entries (e.g. `Horizontal-Calm-Gray-Memory-Mate`) keep rendering via root fallback indefinitely. No migration of existing graphics keys (operator-driven gradual replacement is the spec).

Files (57B): `client/src/pages/settings/LayoutDesignerPage.js`, `client/src/components/LayoutCanvas.js`, `client/src/services/api.js`, `server/routes/sytist.js`, `server/services/processingService.js`, `server/scripts/verify-layout-variant-graphics.js` (new).

---

## 58. ShipStation package weights: floor to whole oz (USPS 1oz grace)

Operational rate-savings change. Package weights are now **floored** to whole ounces (min 1) before they reach the ShipStation payload, universally across all packages and all carriers. USPS gives a 1oz grace per package — an 8.7oz package labelled 8oz is safe and sheds a rate-tier bump; `15.9 oz` labels as `15 oz`, not `16 oz` or `1 lb`. The rule was previously a **ceiling** (which paid the next tier for any sub-ounce overage).

**Where the floor lives.** Inside `packagingService._buildResult` at both rounding sites — the normal path (`totalWeight = Math.max(1, Math.floor(itemWeight + baseWeight))`) and the unknown-packaging-type fallback (`Math.max(1, Math.floor(itemWeight + 2))`). The `Math.max(1, …)` enforces the 1oz minimum at the ounce step (the existing 1-gram clamp on the post-conversion grams was inadequate — 0.5oz would have rounded to 14g and printed as 0oz on the label). The same floor is **idempotently re-applied** at `shipstationService`'s order-level weight resolution so the rule is universal at the SS payload boundary — catching the operator-override and no-engine `defaultWeightOz` fallback that bypass the packaging engine.

**Per-item rollup, both signs.** The engine emits per-line `itemWeights` (in oz) that sum to the order total — required because SS sums line-item weights and replaces the order weight with that sum when any SKU has SS Product Defaults. The "absorb the rounding remainder onto the first non-digital line item" helper (`_buildItemWeights`) previously assumed remainder > 0 (ceiling adds; absorber gets `+baseWeight + |fraction|`). Under floor the remainder is **negative** (we shed the fraction; absorber gets `+baseWeight − |fraction|`). The helper now handles both signs and clamps the absorbing item to ≥1oz so a degenerate `baseWeight = 0` config can't drive it negative. **Without this branch the floor would be silently undone by SS re-summing fractional per-item weights** — the engine's whole-oz total wouldn't survive the SS sum step.

**Conversion order.** Floor at the ounce step happens **before** the `OZ_TO_G = 28.3495` grams conversion in `shipstationService` (per-item L583, order-level L650). The conversion stays as-is (`Math.max(1, Math.round(weightOz * OZ_TO_G))`); since input is now a whole-oz integer, the gram value is deterministic (e.g. 8 oz → 227 g).

**Field/log rename for honesty.** The old `preCeilingOz` / `ceilingRemainderOz` names and `Pre-ceiling total` / `Ceiling rounding: +X oz` log copy would have been objectively wrong post-change. Renamed to `preRoundingOz` / `roundingDeltaOz` (sign-carrying — negative under floor) and `Pre-rounding total` / `Floor rounding: -X oz` (the leading `-` comes from the numeric formatter naturally). The log guard flipped to `Math.abs(roundingDeltaOz) > 0.001` so the "no rounding to mention" suppression still works.

**No tests/fixtures asserted the old behavior**, so nothing to update. Verification path is the `[Packaging Trace]` server log — process any order with fractional weight; the trace now shows `Pre-rounding total: 3.7 oz` / `Floor rounding: -0.7 oz` / `FINAL: 3 oz` instead of the old ceiling output. Files: `server/services/packagingService.js`, `server/services/shipstationService.js`.

### Hotfix: round-trip ounces ↔ grams must reverse-display ≥ the floor

Caught in real-order verification (order 111920, processed against Phase 58 as originally shipped): the packaging trace correctly produced `FINAL: 4 oz`, but the ShipStation payload sent **113 g** and SS reverse-displayed it as **3.99 oz** and billed at the **3 oz tier**. That is the *exact failure mode* Phase 58's floor was meant to prevent — a real 4.6 oz package labelled 3.99 oz exceeds USPS's 1 oz grace at the 3 oz tier, surcharging the very order the floor was supposed to keep tier-safe. Phase 58 was undermining its own goal at the wire.

**Root cause: the oz → g conversion used `Math.round`.** `4 × 28.3495 = 113.398` → `Math.round` = **113** g. Reversing for display: `113 / 28.3495 = 3.9859` → "3.99 oz". `Math.round` drops ~0.5 g at the whole-oz values where `oz × 28.3495` lands just over a half-gram boundary going up. Those values: **1, 4, 7, 10, 13, 15** oz — each reverse-displays as `.99` oz. The other whole-oz values (2, 3, 5, 6, 8, 9, 11, 12, 14 oz) happen to round identically under `Math.round` and `Math.ceil`, which is **why the offline verification harness missed it**: the SPEC §58 worked-example used `8 oz → 227 g`, which is one of the values where round and ceil agree. Real-order verification with a 4 oz order was what surfaced it.

**Contract that must hold (now documented explicitly).** Phase 58's promise is "floor to whole ounces, bill at that tier." For that to survive the SS payload boundary the conversion direction must be: `oz → g` such that `g / OZ_TO_G >= oz_floor`. That is exactly `Math.ceil(oz × OZ_TO_G)`. `Math.round` violates the contract; `Math.floor` would as well; only `Math.ceil` guarantees the round-trip never undershoots.

**Fix.** `Math.round` → `Math.ceil` at **both** `shipstationService` grams sites: per-item L585 (per-unit weight in grams) and order-level L660 (final order weight). Both sites also gained inline comments documenting the round-trip contract so future-me reading either call sees the rationale without digging here. The packaging-engine path is untouched — Phase 58's whole-oz floor in `packagingService._buildResult` already worked correctly; only the cross-unit boundary was wrong.

**Tradeoff (bounded, conservative).** `Math.ceil` over-states each gram conversion by at most ~1 g. The per-item sum can exceed the order-level grams ceil by up to (N−1) g (~0.04 oz per item) for an N-item order; SS uses the per-item sum (it replaces the order weight with the line-item sum when any SKU has Product Defaults). For realistic orders this stays well within a whole-oz rate tier (a 6-item order would over-state by ~0.18 oz; the tier boundaries are whole oz). And the direction is the *correct* conservative side — SS sees slightly more than intended, never less. The alternative (proportional distribution so item sum equals order ceil exactly) is more code for sub-gram precision and isn't worth it.

**Verification path.** Process any order whose floored total is one of `{1, 4, 7, 10, 13, 15}` oz and confirm ShipStation displays ≥ that value (e.g. 4.02 oz for a 4 oz floor, 15.03 oz for 15). Process an 8 oz order to confirm no regression at the round/ceil-agree values (grams stays 227, oz display stays 8). Files: `server/services/shipstationService.js`.

### Hotfix 2: integer ounces throughout the SS payload (oz↔g round-trip eliminated)

Hotfix 1 wasn't enough. Caught processing order 111921 (5 oz floor): packaging trace correctly produced `FINAL: 5 oz`, the order-level grams sent was `142 g`, but SS displayed **5.04 oz** — the per-item ceil sum (94 + 49 = 143 g) reversing through `g / 28.3495`. USPS treats any weight `> N.00 oz` as the `N+1` oz tier (the tier covers up to and including N oz), so 5.04 oz bills at the **6 oz tier** — Phase 58's exact failure mode again, just via the per-item overshoot direction instead of the order-level undershoot direction. **Hotfix 1's "bounded overshoot never crosses a whole-oz rate tier in practice" claim was wrong.** It crosses every time the floor lands on a whole oz boundary — which is by definition every time. Owning that diagnostic mistake explicitly here; the verification harness was also incomplete (offline cases inherited the SPEC's `8 oz → 227 g` worked-example which happens to round/ceil-agree).

**Root cause is the oz↔g unit boundary itself, not the conversion direction.** `oz × 28.3495` is not an integer for any 1–16 whole-oz value, so no integer gram value reverses through `g / 28.3495` to exactly `N.00 oz`. `Math.round`, `Math.ceil`, `Math.floor` — every direction lands in a non-intended tier for some subset of whole-oz values. The only way to preserve the whole-oz floor through the SS payload is **don't go through grams at all**.

**Architectural fix.** ShipStation accepts `units: 'ounces'` with integer values. Send the order-level weight as `{value: floorOz, units: 'ounces'}` — SS sees exactly N oz, bills N oz tier. For per-item (where the engine's rollup produces fractional oz like 3.3 / 1.7), a new helper **`distributeIntegerOzAcrossLines(itemWeights, orderFloorOz)`** splits the whole-oz floor across physical lines as integers summing exactly to the floor, using the same "first physical line absorbs the rounding remainder" pattern the engine uses internally (just expressed at integer-oz granularity at the SS payload boundary). For 5 oz / 1.7 + 1.7: sends `[3 oz, 2 oz]` — SS sum exactly 5 oz, bills 5 oz tier.

**Decision A (the in-memory pass shape).** Order-level weight resolution was hoisted **above** the line-item loop so `weightOz` is known before per-item distribution. The grams conversion sites (`OZ_TO_G = 28.3495` constant + the per-item and order-level `Math.ceil(oz * OZ_TO_G)` lines from hotfix 1) are gone — unused. Phase 13b's original reason for switching to grams (SS truncates fractional oz per line when summing) **does not apply to integer oz** — there's no fraction to truncate.

**`qty > 1` lines (only imperfect case).** SS computes line total as `quantity × per-unit weight`. The integer-oz distribution gives a per-LINE total, but SS wants per-UNIT. For `qty = 1` (the dominant case in observed orders): per-unit = line, exact integer oz, lossless. For `qty > 1` where `lineIntegerOz / qty` isn't integer: per-unit ceils, accepting a bounded `≤ (qty − 1) oz` over-shoot per such line. A `console.warn` fires when this happens so the production frequency can be quantified; revisit if it shows up often. If `qty > 1` turns out to be common, a follow-up could split affected lines into multiple `qty = 1` payload entries summing exactly to the line target — invasive payload-structure change, not worth it preemptively.

**Helper details (`shipstationService` module-level, exported).** Iterates `itemWeights`; for each line: digital / zero-weight stays at 0 and is never the absorber; first physical line is the absorber (placeholder, set after the loop); non-absorber physical lines round-to-integer. Absorber gets `Math.max(0, orderFloorOz − Σ non-absorber rounded)`; clamp to ≥0 covers the rare pathological combo (5+ items each ~0.6 oz with effectively zero `baseWeight`) where the non-absorber sum exceeds the floor — line sum over-shoots the floor by a few oz, bounded. Exported as `module.exports.distributeIntegerOzAcrossLines` for the offline harness (same named-attach pattern as `compositeService.LAYOUTS_PATH`).

**Verification harness (`server/scripts/verify-weight-distribution.js`).** 12/12 cases pass. Operator-specified matrix: (1) the real-order 5 oz / 1.7 + 1.7 reproducer → `[3, 2]` sum 5; (2) single-physical floor 4 → absorber takes full 4; (3) floor 1 oz / 3 tiny items → `[1, 0, 0]`; (4) floor 7 oz / 4 × 0.5 → `[4, 1, 1, 1]`; (5) digital + physical mix → digitals 0, physical absorbs all; (6) pathological 5 × 0.6 oz floor 3 → absorber clamps to 0, sum over by 1 (asserts the documented clamp). Plus null-safety + cross-checks against the 4 oz and 8 oz prior-bug values to assert no regression at "previously-safe" inputs (the lesson from hotfix 1's harness gap).

**Hotfix 1 stays in history as a transitional patch.** It did fix the 4 oz / 3.99 oz display case — that wasn't an empty change — but it didn't fix tier billing as I'd claimed, and the diagnostic overconfidence ("bounded overshoot never crosses a tier") is part of the record future-me needs to see. The honest commit log preserves that.

Files: `server/services/shipstationService.js`, `server/scripts/verify-weight-distribution.js` (new).

---

## 58a. Orders-list "Missing Logo" badge + Settings preselect

Small operator-facing surface change: the same "no logo set for this gallery" warning that fires on the order-detail page (Phase 12 `LogoWarningBanner`) now also appears as a per-row badge on the main orders list, so operators see it during batch-processing decisions instead of having to click into each order to discover it.

**Detection is identical to the detail page** — same per-gallery rule (`galleryLogos[order.galleryId]` truthiness check), same conservative posture (the detail banner deliberately does not check whether any line item's layout actually uses a logo slot; "false positives are cheap; false negatives would mean the wasted render the user wanted to avoid"). The badge inherits that posture so operators never see one without the other. Phase 57B's per-variant composite-layout graphics is a separate asset system (`compositeGraphicsService`, keyed by `layoutId` + namespaced key) and does not interact — gallery logos are per-gallery via `galleryAssetsService`.

**Implementation, zero new endpoint, zero per-row HTTP.** `OrdersListPage` fetches the existing `GET /api/sytist/gallery-assets/logos` (the same registry endpoint `GalleryAssetsSettings` already uses) ONCE on mount and stores the `{ [galleryId]: { logoFilename, ... } }` map; each row checks locally against the map. The orders-list API already exposes `order.galleryId` per row (`sytistDbService` sets it from the `primaryGallery` rollup at L1162/L1659 — no schema change). Soft-fail rule: no badges when `galleryId === 0` (no primary gallery), the registry hasn't loaded yet, or the registry fetch failed — same false-positive-aversion posture as the detail-page banner.

**UX (operator-specified).** Red `⚠ Missing Logo` pill in the row's gallery cell, styled to match the existing `WorkflowBadge` / `StatusBadge` pill vocabulary and the list's warning-color family (`rgba(220,53,69,0.x)`); text is the primary signal so a scanning operator reads "Missing Logo" without interpreting a glyph. `title` attribute provides the hover tooltip `"No logo set for this gallery — click to upload"`. Click stops row-event propagation (so the row's order-detail navigate doesn't fire) and routes to `/settings/gallery-assets?galleryId=<encoded id>`.

**Settings-page preselect.** `GalleryAssetsSettings`'s `LogosSection` now reads `useSearchParams`; on initial load (gated on the dropdown still being at its empty default — manual operator selection is never overridden) it locates the requested gallery in the already-loaded list and pre-selects it. The badge click lands the operator at the upload control for that specific gallery instead of the empty default state.

Files: `client/src/pages/OrdersListPage.js`, `client/src/pages/settings/GalleryAssetsSettings.js`.

---

## 58c. Product names display as leaf-only (everywhere)

Operator-facing readability change: Sytist hands the dashboard a `>`-delimited product hierarchy (e.g. `"Print Packages > Silver Package > 8x10"`) — useful for matching/identifying, terrible for scanning a list of items. Phase 58c renders just the **leaf** (`"8x10"`) at every operator-visible surface — dashboard UI, packing slip JPG, ShipStation payload, `ms_notes` reprint audit (operator sees it in Sytist's own UI too), imposition `{item_description}` template token (renders on the imposed sheet if a layout uses it), packaging weight-trace log, server debug logs.

**Architecture — Option Y (single source on the data shape).** `sytistDbService` is the only source of `productName` for line items, set at four construction sites: main cart line items (`L1052`), package constituents (`L311`), addons (`L451`), and the sibling parent-suffix variant (`L487`, which re-derives display from the suffixed string so the team suffix appears in the leaf). At each site the line item now carries **both** fields:

- `productName` — full `>`-delimited string, **identifier**. Untouched downstream. Consumers that key off it (`darkroomService` template lookup at `L163/173/277/301/314/316`, `specialtyService` path construction at `L194/196/266/268`, operator-edited `template-mappings.json` and `specialty-products.json` records) keep reading this field — they're naturally protected because they read `productName`, not `productNameDisplay`.
- `productNameDisplay` — leaf-only string, **display**. Every render site reads this. The field name itself signals the intent at every callsite, eliminating the per-display-site choice of "which utility do I call?" — a new display site added in 6 months just reads `productNameDisplay` and gets the right behaviour automatically.

**Helper (one place).** `deriveDisplayName(productName)` at `sytistDbService` module level: `String(name).split('>').pop().trim()` with an empty-leaf guard — if the trim yields `''` (e.g. `"Print Packages > "` with a trailing `>`), fall back to the original string so the field is never empty. Display sites still guard with `|| '(no name)'` etc., but the helper itself never emits `''`.

**Display sites updated.** Server: `shipstationService` payload line-item `name`, `packingSlipService` SVG render, `processingService` `ms_notes` reprint audit (`L456`), `processingService` `photosFailed` warning message (push field also renamed `productName` → `productNameDisplay` at `L1108/L1149`; reader at `L1907`), `impositionService` `{item_description}` template token (`L359`), `packagingService` weight-trace at `L511/L654`, `sytistDbService` debug log (`L258`). Client: `OrderDetailPage` line-item rows + process-result summaries + photo-failed callout + imposed-sheet alt text, `LayoutDesignerPage` preview-order picker, `OrderOverridesPage` cart row, `OverrideEditorPage` subtitle + cart switcher.

**`photosFailed` field rename.** The internal `subResult.photosFailed[]` shape's `productName` field was renamed to `productNameDisplay` — safe because the client only reads `photosFailed.length`, not individual entries (verified by grep). Match the canonical line-item shape.

**Identifier-vs-display separation, made explicit.** The rule from the audit (don't touch identifier sites) is now structurally enforced: if a consumer reads `productName`, it's doing an identifier operation (matching, path construction, lookup); if it reads `productNameDisplay`, it's rendering. The field-name choice at the callsite tells you which it is. No utility-call discipline needed.

Verification: existing `verify-weight-distribution.js` still 12/12 pass (the SS helper export is unchanged); `node --check` clean on every server file; ESLint clean on every client file (only the pre-existing `ssSkipped` unused-var warning remains). Operational verification: process any order — leaf-only names should appear in the dashboard order detail, the slip JPG, the SS line-item display, and any `ms_notes` reprint audit text.

Files: `server/services/sytistDbService.js`, `server/services/shipstationService.js`, `server/services/packingSlipService.js`, `server/services/processingService.js`, `server/services/impositionService.js`, `server/services/packagingService.js`, `client/src/pages/OrderDetailPage.js`, `client/src/pages/settings/LayoutDesignerPage.js`, `client/src/pages/settings/OrderOverridesPage.js`, `client/src/pages/settings/OverrideEditorPage.js`.

### Hotfix: missed second cart-row mapper in `getOrderById`

Real-order regression caught immediately — the order DETAIL page rendered every line item as the fallback `"(no name)"`. The original Phase 58c audit identified four `productName:` setter sites in `sytistDbService` (package constituents, addons, sibling parent-suffix, and `getOrdersByWorkflow` main cart at `L1054`) and set `productNameDisplay` at each. There is a **fifth** setter — `getOrderById`'s main cart-row mapper at `L1578` — and it was missed because the audit grep was truncated with `head -25`, which cut off before reaching the late occurrence. The list page (`getOrdersByWorkflow` path) rendered correctly; the detail page (`getOrderById` path) returned line items with `productNameDisplay` undefined, so every name hit the `|| '(no name)'` fallback at `OrderDetailPage.js:1265`.

**Fix.** Add `productNameDisplay: deriveDisplayName(c.cart_product_name || '')` at `L1578` adjacent to its `productName`. Verified with an exhaustive `productName:` grep (no `head` limit) that no other setter remains missed.

**Audit-discipline lesson recorded as a separate CLAUDE.md bullet (not the existing "worked examples" one — different lesson).** This is about completeness greps, specifically: when grepping to enumerate "every setter / every call site / every render," **don't truncate the output with `head -N`** — late occurrences hide past the limit, and the audit produces an incomplete plan. Either no limit, or grep multiple times and union, or accept that any audit using `head` is *non-exhaustive by construction*. The Phase 58c miss made a structural change to "Option Y: set the new field at every line-item construction site" — which depends on enumerating EVERY site exactly — and the truncated grep silently gave a smaller answer.

## 59. Packing slip two-column layout + Items-to-Ship total

Operator-visible bug: packing slips for orders with many items overlapped the footer or cut off the bottom rows on screen and in print. Surface symptom was "the slip is wrong"; the failure was geometric — `packingSlipService._composeSlip` has a fixed ~820-px vertical budget for the items zone, the thumb-size scaling floors at 60 px so rows can shrink no further than ~80-px tall, and the per-row loop iterated all items with **no overflow check**. Around N=12 the last rows started colliding with the footer divider / QR area; past N=15 sharp silently clipped composites that ran past the canvas bottom — operator just saw missing items.

**Design — single-page two-column, NOT multi-page.** Multi-page pagination (one JPG per page, all referenced in the Darkroom .txt) was considered and rejected by the operator. The user's lab pipeline already prints exactly one packing slip per order/per-team; a single JPG keeps the Darkroom .txt scalar (`packingSlipPath`), keeps `subResult.slipPath` scalar, and avoids any change in `processingService` or orphan cleanup. Two-column delivers ~2× density on the same physical 5×8 sheet.

**Layout rules.** Single-column path (N ≤ 6) is preserved verbatim — visual output for the common case is byte-comparable to pre-Phase-59 aside from the new "Items to Ship" label replacing the old "ITEMS (N)" header text. At N ≥ 7 the items zone splits into two 680-px columns with a 20-px gutter. Items 1..⌈N/2⌉ fill column 1 top-to-bottom, items ⌈N/2⌉+1..N fill column 2 — canonical print order preserved (matches what the Darkroom .txt prints). Thumb size in 2-col mode is adaptive: `clamp(60, 100, ⌊820 / ⌈N/2⌉⌋ - 20)` — starts at 100 px and shrinks toward a 60-px floor as items per column rise. A faint `#eeeeee` vertical divider runs between the columns from `itemsStartY` down to `footerY - 10`, framing the items zone even when column 2 is partially empty so operators register the column structure at a glance.

**Hard ceiling: ~20 items** at the 60-px thumb floor. Beyond N=20 the same overflow returns and operator gets a `console.warn` (`[Packing Slip] warning: order N has K items, may overflow 2-column layout (ceiling ~20). Verify slip output.`). N>20 is empirically <1% of orders; accepted as a manual-handling edge case rather than building a 3-column fallback (would crowd readability for the realistic distribution to cover the rare extreme).

**"Items to Ship: K" total — always shown, qty-summed, lab-shippable only.** Appears on every slip (1-col and 2-col), in the ITEMS header band. Operationally answers "did the packer get every item into the box?" The number is `Σ qty` across `printedItems` **excluding** specialty (`specialtyService.isSpecialty(sku)`), drop-ship (`specialtyService.isDropShipped(sku)`), and digital-by-config (`packagingService.isDigital(sku)` — Phase 45). Those classes ship separately — specialty on its own pipeline per Phase 55, drop-ship outside the lab, digital as downloads — and so don't count toward the lab box that this slip rides on top of. **Crucial subtlety:** specialty rows still *render* on the slip (orange tint + SPECIALTY badge — operator awareness unchanged); only the *count* excludes them. This is a deliberate divergence from "count = rows × qty" — the count answers "what's in THIS box," not "what rows exist." The right-edge `QTY` label drops in 2-col mode (each column carries its own per-row qty badges, a single-edge label would be misleading); the vertical column divider communicates the 2-col structure visually (a textual `— 2 COLUMNS` suffix on the header was tried in initial Phase 59 and removed after live-UI review as redundant with the divider).

**Pre-resolution unified.** The per-row loop's existing `isSpecialty` lookup loop was hoisted above the SVG build and extended to also resolve `isDropShipped` + `isDigital`, storing all three plus a derived `shipsWithLabOrder: !(any of the three)` per cartId in `eligibilityByCartId`. Single pre-pass instead of three; downstream sites read once. The hoist is required because the "Items to Ship" total appears in the **header band** (rendered before the items loop), so eligibility has to be known before the SVG build starts.

**Per-team scoping.** ship_to_league per-team slips paginate independently — each team's slip decides 1-col vs 2-col based on that team's own item count. Some teams in a league might be 2-col while others stay 1-col. Filename pattern unchanged: `{order}_packing_slip{teamSuffix}{filenameSuffix}.jpg`.

**Zero touch outside `packingSlipService._composeSlip`.** Slip still produces one JPG; `subResult.slipPath` stays a scalar string; `darkroomService.buildOrderTxt({ packingSlipPath })` API unchanged; `processingService` slip path handling unchanged; `_cleanupOrphanOutputs` substring carve-out (`n.includes('_packing_slip')`) unchanged. Single-file scope was an explicit audit goal.

**Verification.** 11/11 offline harness cases pass (`server/scripts/verify-slip-pagination.js`): N = 1, 3, 6, 7, 8, 12, 16, 20, 22, plus a qty-aware case (5 rows, qty 1+1+1+3+3 → "Items to Ship: 9") and a skip-flags case (download + giftCert filtered before the count). Cases deliberately exercise the bug class per the CLAUDE.md "worked examples" discipline: N=7 (onset of 2-col), N=12 (overlap zone in old behavior), N=20 (ceiling), N=22 (overflow warn fires). N=6 visually identical to pre-Phase-59 aside from the new "Items to Ship: K" header text. N=7 produces "ITEMS TO SHIP: 7" with 4 items in column 1, 3 in column 2, and the vertical divider between them visible. N=20 fits cleanly at the 60-px floor without overflowing into the footer zone.

Files: `server/services/packingSlipService.js`, `server/scripts/verify-slip-pagination.js`, `.gitignore` (adds `server/scripts/_*-scratch/`).

## 60. Digital-only orders get their own workflow bucket

Operator-visible bug: galleries that are Ship-to-Home or Ship-to-Managers had orders showing up under the **League** tab when the customer ordered only digital downloads. Root cause in `sytistDbService.categorizeShipping`: workflow is decided by shipping option-name first (name-match wins), then a numeric cost fallback (`>1.01 → home`, `=1.00 → managers`, `else → ship_to_league`). A digital-only order pays **no shipping** — `order_shipping = 0.00` with an **empty** `order_shipping_option` — so it matched no option name and fell through the `else` into league.

Diagnostic (read-only, 90-day window): of the orders with empty option + `$0.00`, ~99 (live cart) were digital-only and ~76 had physical items; the digital-only ones overwhelmingly belonged to galleries whose dominant *paid* option was `USPS-Ship to Home`. So they were home/manager-gallery digital orders dumped into league.

**Fix — a 4th workflow value `'digital'`.** A digital-only order has nothing physical to ship, so it must not be force-bucketed into league by the cost rule. `categorizeShipping` gains an `isDigitalOnly` argument; in the fallback, a digital-only order at the league cost band returns `{ workflow: 'digital', uncategorized: false }`. Two deliberate properties:

- **Option-name match still ALWAYS wins.** A digital-only order that carries an explicit `USPS-Ship to Home` option stays home — the customer/gallery tagged it, and that tag is more authoritative than the cost heuristic. The digital bucket only catches orders that hit the *unmapped* numeric fallback.
- **Not flagged `uncategorized`.** Unlike the other fallback buckets (which mean "operator should add this option to the mapping"), a digital order is *deterministically* classified — there's no shipping option to map — so it carries `uncategorized: false` and shows no misleading "add to config" ⚠ on the badge.

**JS ↔ SQL parity (the load-bearing part).** Workflow classification lives in two places that must agree: the JS `categorizeShipping` (per-order display) and `_buildWorkflowSqlPredicate` (the SQL behind the list filter, the next/prev navigation, and the count badges). Phase 60 keeps them in lockstep:

- `_buildWorkflowSqlPredicate` gains a `'digital'` bucket (`option unmapped AND (cost<1.00 OR NULL) AND NOT EXISTS physical-item`) and **excludes digital-only orders from the `ship_to_league` FALLBACK branch only** — the name-matched league branch is untouched, so a digital order with an explicit league option still classifies league, exactly as the JS does.
- "Digital-only" = `NOT EXISTS` a **physical** cart row, where physical = `cart_download = 0 AND UPPER(cart_sku) NOT IN (<digital-by-config SKUs>)`. The SKU exclusion is required by the **Phase 45 landmine**: digital *packages* like 5D carry `cart_download = 0`, so `cart_download` alone misses them. The list comes from `packaging-config.json` `category:'digital'`. Checks **both** `ms_cart` and `ms_cart_archive` (an order's rows live in one or the other).
- The digital-SKU list is **inlined** into SQL (not a bound param): each SKU is validated against `[A-Z0-9 _-]` (trusted local config, no injection surface), and inlining avoids fragile param-array ordering across the predicate *and* the computed `isDigitalOnly` SELECT columns. The **same** `_physicalItemExistsSql` fragment computes an `isDigitalOnly` column in the list query, `getOrderById`, and `getOrderCounts`, so the row badge, the detail-page badge, the filter, and the tab counts can never disagree.

**Downstream audit (reclassifying league→digital is safe).** `processingService._splitIntoSubOrders` sends `'digital'` orders down the default single-bundle path instead of per-team (harmless — digital-only orders have no physical output; all download items are skipped by the pipeline). SS auto-create still correctly does not fire (it's gated on `ship_to_home`, and digital is non-home, same as league was). The `{workflow}` path token just becomes `digital` (cosmetic/more accurate). No `switch` errors on the new value.

**Client.** New amber **Digital** tab in the orders list (`OrdersListPage` `workflowTabs` + `WorkflowBadge`), the same label/color on the order-detail `WorkflowBadge`, and a **Digital** stat card on the Home dashboard (`byWorkflow.digital`).

**Verification.** Offline harness `server/scripts/verify-shipping-classify.js` exercises the real `categorizeShipping` (exposed as `_categorizeShipping`) — 11/11, covering the bug case, its physical twin, name-match-wins for all three buckets, the cost branches, and null cost. Live DB: 4 known orders (112049 / 112042 / 111906 / 111882) now classify `digital`; the digital filter returns 173 across all statuses; `ship_to_league` still returns 1,724 with **zero** digital leaks; home unaffected (23,913). SQL parity is the live-only part — the harness covers the JS, the live run covers the predicate.

Files: `server/services/sytistDbService.js`, `server/scripts/verify-shipping-classify.js`, `client/src/pages/OrdersListPage.js`, `client/src/pages/HomePage.js`, `client/src/pages/OrderDetailPage.js`.

- ~~Identify the upstream "Sportsline UI" integration creating phantom SS orders.~~ **Identified during Phase 47 hotfix 2 diagnosis (2026-05-14)**: a separate processing tool used by operator Kirsten. Writes to Sytist directly (`note_who: "Kirsten"` with "Order Has been changed to Printing and Production" — distinct from our `"Sytist Dashboard: Order processed..."` prefix) and creates SS orders outside our pipeline. The ms_notes comparison showed our dashboard processed ~9 of 555 composite-mapped orders in the last 14 days; the other 546 went through Kirsten's tool. Phase 33's "adopt without push" already handles the coexistence pattern — no code change required. The remaining question is operational, not technical: should the dashboard become the primary tool, or stay a special-case path? Worth a conversation with Kirsten, not more code.
- Distinguish dashboard-written vs Sytist-written log entries in our `OrderActivityCard` (currently only the `[Dashboard]` body prefix marks ours)
- Migrate remaining JSON configs to SQLite where it makes sense (low priority)
- Configurable scheduler poll interval via Settings UI (currently hardcoded to 300000ms)
- **Kirsten coexistence** — bring upstream-processed orders into the dashboard's composite/audit/packaging pipeline, OR accept that the dashboard only adds value for the orders that come through it. Identified during Phase 47 hotfix 2 (2026-05-14): 546 of 555 composite-mapped orders in the last 14 days are processed by Kirsten's tool, not our dashboard. Phase 33's "adopt without push" already handles the SS-side coexistence; the open question is whether to integrate Kirsten's workflow into ours (so all orders get our composite cache + S3 thumbnails + audit notes), or accept that our dashboard is a special-case path for orders Joey personally handles. Worth a real conversation with Kirsten before more code investment. This is a planning item, not code work.
- **Phase 49 v2 → public-facing deployment**: if this dashboard ever moves off localhost, the `/photo-thumb` proxy must switch from "no auth, SSRF-only" to signed URLs (HMAC over `src + width + expiry`) before deploy. See SPEC §49 for the rationale and the inline comment in `routes/sytist.js`.
- **On-demand composite preview** before processing — currently the dashboard order detail page only shows composite thumbnails for orders that have already been processed. Adding a "preview what this will look like" requires calling the composite engine from a UI endpoint.
- **S3 storage sweep** for orders shipped > N days. Decoupled from the poll cycle so the visibility race doesn't recur.
- **Phase 50 follow-up: storage sweep for `server/config/order-asset-overrides/`** — delete subtrees for orders shipped > N days old. Uploaded override images accumulate indefinitely (and orphan if an operator uploads then closes the editor without Save). Manual cleanup script acceptable until then; the override-DELETE path already wipes per-cart assets so this only matters for never-deleted overrides on shipped orders.
- **Phase 53 (planned): "Save & next item" + in-editor line-item prev/next.** Phase 52 made Save (no render) → Process actually honor staged overrides, so the multi-item batch loop (fix item A → stage → fix item B → stage → Process once) is now *functionally* real but *ergonomically* hidden: the editor has no prev/next; advancing requires the order-page round-trip (Phase 48a auto-return) or the "Switch to a different order / cart line" panel. Operator can't tell Save (no render) "worked" until Process. Phase 53 adds (a) in-editor prev/next across the order's line items and (b) a combined **Save & next item** action (persist override, no render, advance to the next line item) so the batch primitive Phase 52 unlocked has the ergonomic wrapper it's missing. Decision (Joey, this session): build as its own phase; Apply (Overwrite) keeps its render-now-with-thumbnail-confirmation role for the single-fix case. Depends on Phase 52 (no point before Process honored staged overrides).
