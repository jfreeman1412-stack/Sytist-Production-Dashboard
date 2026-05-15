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

Phase 11 introduced per-order composite layout overrides — operators can save a layout customization for a specific (orderId, cartId) so the composite engine uses the custom layout instead of the SKU's default mapping.

Phase 40 wires that into the actual Process/Reprint flow:
- `processingService` composite loop calls `orderOverrideService.get(orderId, cartId)` BEFORE falling through to `compositeService.findMapping(sku)`
- If an override is found, that layout is used; `subResult.composites[].layoutSource = 'override'`
- Otherwise the SKU mapping runs as before; `subResult.composites[].layoutSource = 'mapping'`

New UI: `OverrideEditorPage` now has a "Save (no render)" button alongside the existing "Save and render" — useful when an operator wants to stage an override for the next Process/Reprint without immediately producing files.

Files: `server/services/processingService.js`, `client/src/pages/OverrideEditorPage.js`

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

## 50+. Open follow-ups

- ~~Identify the upstream "Sportsline UI" integration creating phantom SS orders.~~ **Identified during Phase 47 hotfix 2 diagnosis (2026-05-14)**: a separate processing tool used by operator Kirsten. Writes to Sytist directly (`note_who: "Kirsten"` with "Order Has been changed to Printing and Production" — distinct from our `"Sytist Dashboard: Order processed..."` prefix) and creates SS orders outside our pipeline. The ms_notes comparison showed our dashboard processed ~9 of 555 composite-mapped orders in the last 14 days; the other 546 went through Kirsten's tool. Phase 33's "adopt without push" already handles the coexistence pattern — no code change required. The remaining question is operational, not technical: should the dashboard become the primary tool, or stay a special-case path? Worth a conversation with Kirsten, not more code.
- Distinguish dashboard-written vs Sytist-written log entries in our `OrderActivityCard` (currently only the `[Dashboard]` body prefix marks ours)
- Migrate remaining JSON configs to SQLite where it makes sense (low priority)
- Configurable scheduler poll interval via Settings UI (currently hardcoded to 300000ms)
- **Kirsten coexistence** — bring upstream-processed orders into the dashboard's composite/audit/packaging pipeline, OR accept that the dashboard only adds value for the orders that come through it. Identified during Phase 47 hotfix 2 (2026-05-14): 546 of 555 composite-mapped orders in the last 14 days are processed by Kirsten's tool, not our dashboard. Phase 33's "adopt without push" already handles the SS-side coexistence; the open question is whether to integrate Kirsten's workflow into ours (so all orders get our composite cache + S3 thumbnails + audit notes), or accept that our dashboard is a special-case path for orders Joey personally handles. Worth a real conversation with Kirsten before more code investment. This is a planning item, not code work.
- **Phase 49 v2 → public-facing deployment**: if this dashboard ever moves off localhost, the `/photo-thumb` proxy must switch from "no auth, SSRF-only" to signed URLs (HMAC over `src + width + expiry`) before deploy. See SPEC §49 for the rationale and the inline comment in `routes/sytist.js`.
- **Auto-ship investigation**: orders sometimes show as `shipped` in SS within seconds of creation, with no tracking number. Cause unknown; not blocking after Phase 44 hotfix 2 (cache survives) but worth understanding.
- **On-demand composite preview** before processing — currently the dashboard order detail page only shows composite thumbnails for orders that have already been processed. Adding a "preview what this will look like" requires calling the composite engine from a UI endpoint.
- **S3 storage sweep** for orders shipped > N days. Decoupled from the poll cycle so the visibility race doesn't recur.
