# Sytist Production Dashboard — Spec

**Status:** Draft, planning session 2026-05-08
**Author:** Joey Freeman + Claude

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

**Phase 0 — Bootstrap (½ day)**
Project folder, package.json (server + client), `.gitignore`, `.env.example`, README. Empty Express server runs; empty React app loads at /. Init git, push to private GitHub repo.

**Phase 1 — Auth (½ day)**
Copy `authService.js`, `middleware/auth.js`, login route + page from photo day. Confirm login works against a local SQLite users table.

**Phase 2 — Data layer (1–2 days)**
`sytistDbService.js` with the public surface in §9. Connection via `.env`, configurable in Settings later. Test queries against the live droplet DB; verify canonical shape with real data. A `/api/orders/test` endpoint that returns 5 recent orders as JSON for visual inspection.

**Phase 3 — Read-only UI (1 day)**
Orders list page populated by `sytistDbService`. Filters: workflow, production status, date range, gallery. Detail view (no actions yet, just display).

**Phase 4 — Pipeline port (2–3 days)**
Copy darkroom, packing slip, packaging, folder sort, specialty, **imposition**, qrcode services. Extend packing slip per §6 (barcode, subject info, breadcrumb, branded graphic). Add a "Process this order" button on order detail that runs the full pipeline locally (no ShipStation yet). Verify Darkroom txt + packing slip JPG + multi-up imposition (8 wallets, 2 magnets, etc.) produced correctly for a real Sytist order. **Composition products fail gracefully with a clear "needs composition (Phase 8)" message until Phase 8 ships.**

**Phase 5 — ShipStation (1 day)**
Copy `shipstationService.js`, wire to "Process" action for `shipstation` workflow only. Verify with a single order end-to-end.

**Phase 6 — Schedulers (1–2 days)**
Auto-fetch poll every 5 min. Scheduled batch with HH:MM definitions. UI for schedule management.

**Phase 7 — Status writeback (½ day)**
"Mark as Printing" / "Mark as Shipped" buttons → write to `ms_orders.order_open_status`. Confirm Sytist's automation picks it up correctly.

**━━━ Composition system (Phases 8–11) ━━━**

**Phase 8 — Composition engine (3–4 days)**
`compositionService.js` with JSON-driven templates per §6.5. Slot types, variant selection from photo orientation, variable substitution, auto-fit text, team photo resolution per §6.5.1. Templates authored as hand-edited JSON files for now (no UI). Hook into pipeline so SKUs mapped to composition templates render via this engine instead of producing the "needs composition" failure from Phase 4.

**Phase 9 — Asset upload + logo assignment (2 days)**
Upload UI per §6.7 (overlays, logos, fonts). Per-gallery logo assignment UI per §6.5.2. `$JOB_LOGO` resolution wired into composition engine.

**Phase 10 — Visual template editor (5–7 days)**
Canvas-based editor per §6.6. Drag handles, properties panel, variant switcher, asset picker, sample-order preview render. Users can author and edit composition templates without hand-editing JSON.

**Phase 11 — Per-order re-render (Flow B1) (1–2 days)**
Per §6.8. Re-render with overrides for a single order using the visual editor pre-populated with that order's data.

**━━━ Polish ━━━**

**Phase 12 — Polish (open-ended)**
Bulk operations, print sheets page, stats and quick actions, multi-user concurrency, Flow A re-render (edit template + re-render affected orders), whatever else surfaces during real use.

**Total estimate to Phase 11:** roughly 3–5 weeks of dedicated focus. Phases 0–7 alone (working basic dashboard): ~1.5–2 weeks.

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
