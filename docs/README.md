# Sytist Production Dashboard

Web-based production dashboard for processing Sytist orders into Darkroom-ready txt files, packing slips, ShipStation shipments, and back into Sytist as status updates + activity-log entries. Pulls order data directly from the Sytist MySQL database.

**Status:** Phase 47 — production. See `SPEC.md` for the full phase history and `CHANGELOG.md` for a chronological summary.

---

## What it does

- Pulls order data from the Sytist MySQL database (mostly read-only — writes confined to `ms_orders` status/shipping columns and `ms_notes` activity log)
- Builds **Darkroom .txt files** so prints flow through the lab's existing CRD-template printing
- Generates **5×8 packing slips** at 300 DPI with thumbnails, QR codes, subject info, and modifier highlights
- **Imposes** multiple prints onto sheets (8 wallets to a 5×7, 2 magnets, etc.) with per-product layouts
- **Composites** green-screen photos (transparent PNG subject + chosen background) for every output type — composite-layout items AND plain prints AND packing-slip thumbnails (Phase 34)
- **Routes** specialty products to separate folders and excludes them from the .txt
- **Expands** package SKUs into their constituent items (Gold Package → 9 distinct production items)
- **Expands** add-on options into either synthetic line items or modifier suffixes
- Sends shipments to **ShipStation** via the v1 API; supports manual "Push packaging" override when an upstream tool created the SS order first (Phase 33)
- **Schedules** automated ShipStation polling that flips Sytist `order_open_status` to Shipped when SS marks an order shipped (Phase 32)
- **Writes back to Sytist** the full shipping field set: `order_open_status`, `order_shipped_date`, `order_shipped_track`, `order_shipped_by`, `order_shipped_by_id`, `order_ship_cost` (Phase 30)
- **Reprint workflow** with per-order and per-item buttons; numbered `_REPRINT[_N]` outputs, no Sytist status change, no ShipStation involvement (Phase 35)
- **Sytist ms_notes integration** writes every dashboard action (process, reprint, ship, unship, push-packaging) to Sytist's order activity log; operators can read AND add notes from our UI (Phase 36)
- **Audit history** in local SQLite tracks every settings change, ship/unship event, and reprint event with prev/new diffs and user attribution
- **Export/import** lets you back up or share configs as JSON files

---

## Setup

### Prerequisites

- Node.js 22+ (developed on 22.13.1)
- Network access to the Sytist droplet (MySQL on 3306)
- A `.env` file in `server/` with required variables (see `.env.example`)
- **Windows build tools** for `better-sqlite3` and `bcrypt` native modules — usually fine on a stock Node 22 install

### First-time install

From the project root:

```powershell
npm run install-all
```

### Configure environment

```powershell
copy .env.example server\.env
```

At minimum set:
- `SESSION_SECRET` (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` for the Sytist DB
- `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`, `INITIAL_ADMIN_DISPLAY_NAME` — bootstrap admin user (used only on first start if no users exist)
- `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` (or set later in Settings → API Keys)

### Run (development)

```powershell
npm run dev
```

Starts both processes concurrently:
- Server on http://localhost:3011
- Client on http://localhost:3010

### Adding more users

```powershell
npm run add-user --prefix server -- newusername password123
```

Or use the Users management UI inside the dashboard (Settings → Users).

---

## Important Sytist write allow-list

The dashboard treats the Sytist MySQL database as **mostly read-only**. The only permitted writes are:

| Table | Columns | When |
|---|---|---|
| `ms_orders` | `order_open_status` | Auto-update after successful Process (target 40 by default); manual Mark Shipped (39) / Mark Back to Printing |
| `ms_orders` | `order_shipped_date`, `order_shipped_track`, `order_shipped_by`, `order_shipped_by_id`, `order_ship_cost` | Manual Mark Shipped + scheduler-driven auto-ship (Phase 30) |
| `ms_notes` | INSERT only (full row) | Every dashboard action: process/reprint/ship/unship/push-packaging/manual operator notes (Phase 36) |
| `ms_notes` | `note_delete`, `note_edited`, `note_edited_who` | Soft-delete of operator-added manual notes only (Phase 36) |

**Never writes** to `ms_order_status_logs` (that table is owned by an existing Sytist automation). **Never writes** to schemas, indexes, or any other ms_* table.

---

## Project structure

```
sytist-dashboard/
├── server/                          Express API server (port 3011)
│   ├── index.js                     App entry — boots services, mounts routes
│   ├── routes/                      HTTP routes (thin — delegate to services)
│   │   ├── auth.js                  Login, logout, sessions, users
│   │   ├── sytist.js                Orders, packages, addons, configs, history, notes
│   │   ├── shipstation.js           Packaging config, shipping links
│   │   ├── photoday.js              PhotoDay API integration (legacy)
│   │   └── darkroom.js              Darkroom settings
│   ├── services/                    Business logic
│   │   ├── database.js              SQLite init + schema + migrations
│   │   ├── authService.js
│   │   ├── sytistDbService.js       MySQL pool + canonical order shape + ms_notes I/O
│   │   ├── processingService.js     Full pipeline including reprint orchestration
│   │   ├── greenscreenService.js    Phase 17 — transparent subject + background compose
│   │   ├── packagingService.js      productWeights + bundles
│   │   ├── packingSlipService.js    5×8 slip; uses green-screen tier strategy (Phase 34)
│   │   ├── packageContentsService.js
│   │   ├── addonMappingsService.js
│   │   ├── orderOverrideService.js  Per-order layout overrides (Phase 11)
│   │   ├── configHistoryService.js  Unified audit log
│   │   ├── compositeService.js      Composite layouts with playerBackground slot
│   │   ├── impositionService.js
│   │   ├── folderSortService.js
│   │   ├── specialtyService.js
│   │   ├── darkroomService.js
│   │   ├── shipstationService.js
│   │   ├── shipstationLinkService.js   Local link table — order_id ↔ ss_order_id
│   │   ├── orderStatusService.js    Phase 28–30 — ship/unship + audit + ms_notes
│   │   ├── schedulerService.js      Phase 32 — polls SS, auto-flips Sytist status
│   │   ├── pathsService.js
│   │   └── ...
│   ├── middleware/
│   │   └── auth.js                  requireAuth, requireRole, optionalAuth
│   ├── config/                      JSON configs + SQLite DB (gitignored)
│   │   └── sytist-dashboard.db      auth, sessions, addons, packages, overrides, history, audit, links
│   ├── scripts/
│   │   └── add-user.js
│   └── assets/                      Uploaded overlays/logos/fonts (gitignored)
│
├── client/                          React app (port 3010 in dev)
│   └── src/
│       ├── components/
│       │   ├── AppLayout.js
│       │   ├── HistoryModal.js
│       │   └── ...
│       ├── pages/
│       │   ├── LoginPage.js
│       │   ├── Dashboard.js
│       │   ├── OrdersListPage.js
│       │   ├── OrderDetailPage.js   Process, Reprint, Ship, Push Packaging, Activity card
│       │   └── settings/
│       │       ├── ApiKeysPage.js
│       │       ├── PackagingPage.js
│       │       ├── PackagesPage.js
│       │       ├── AddonsPage.js
│       │       ├── PathsPage.js
│       │       ├── FolderSortPage.js
│       │       ├── SpecialtyPage.js
│       │       ├── ImpositionPage.js   With WYSIWYG layout designer (Phase 27)
│       │       ├── CompositePage.js    With visual template editor (Phase 10)
│       │       ├── OverrideEditorPage.js   Per-order WYSIWYG override editor (Phase 11f)
│       │       ├── ShippingPage.js
│       │       └── DarkroomPage.js
│       └── services/
│           └── api.js
│
├── SPEC.md                          Full project specification
├── README.md                        This file
├── CHANGELOG.md                     Chronological summary of all phases
├── OperatorManual.md                Day-to-day operator guide
├── AdminManual.md                   Setup, config, troubleshooting
├── package.json
└── .env.example
```

---

## Architecture highlights

### Green-screen pipeline (Phase 17 + 34)

Sytist's green-screen products work like this:
- Customer's photo is uploaded as a transparent PNG (subject already keyed out)
- Customer selects a background from a Sytist-managed background pool
- `ms_cart.cart_photo_bg` stores the chosen background photo ID

The dashboard composites them at three points in the pipeline:
1. **Composite engine** uses `playerBackground` slot to embed the chosen background into Memory Mate / templated outputs
2. **Imposition path** (plain prints like wallets, magnets) composites BEFORE imposing, so the printed sheet shows the player on the background instead of transparent-on-white
3. **Packing slip thumbnails** use a three-tier strategy: pre-composed disk file → on-demand compose → plain thumbUrl fallback, so the slip preview matches what actually prints

### ShipStation integration (Phase 13 + 28–35, hardened in 38–43)

- Auto-creation on Process (when no upstream tool already pushed)
- "Adopt without push" when a phantom SS order already exists for the same Sytist order_id (Phase 33)
- Manual "Push packaging to ShipStation" button as an escape hatch (Phase 33), with composedImageUrl cache hydration (Phase 43)
- Scheduler polls every 5 minutes; on detecting an SS shipment, flips Sytist `order_open_status` to 39 with full shipping columns populated (Phase 32 + 30)
- Per-item thumbnails in the SS UI: Phase 41 adds the `imageUrl` field to each line item, Phase 42 fills it with publicly-hosted composed images (S3), Phase 44 expands to composite-layout products (Memory Mate, etc.)
- 404-empty-body retry: SS sometimes rejects creates with no body when an orderKey was previously deleted (tombstoned). Phase 43 detects this and offers the operator a one-click retry with a modified orderKey (Phase 43 hotfix 2 added it to the Send to ShipStation button on the order detail page; Phase 43 hotfix 3 restored Phase 41/42/43 changes that an earlier upload had regressed)

### Composed thumbnail pipeline (Phase 42 + 44)

A pluggable backend publishes composed/composite product previews to a public URL so they're consumable everywhere a thumbnail is shown.

- `composedThumbnailService` is the entry point. Default backend `skip` is no-op; `s3-sytist` uploads to AWS S3 (configured in Settings → API Keys → AWS S3)
- During Process: each green-screen line item AND each composite-layout line item (Memory Mate, Photo Button, etc.) gets a 500px max thumbnail published. The returned public URL goes onto `li.composedImageUrl` AND into the `composed_thumbnails` SQLite cache (keyed by `order_id, cart_id`)
- Three destinations read from this single source:
  - **ShipStation payload**: `composedImageUrl` becomes the line item's `imageUrl` field, so the SS UI shows what's actually being shipped
  - **Packing slip**: 4-tier thumbnail resolver, Tier 0 = composite engine local file (during Process) OR cached URL (during slip preview routes); falls through to green-screen composed file (Tier 1), on-demand compose (Tier 2), or raw thumbUrl (Tier 3) if Tier 0 doesn't apply
  - **Dashboard order detail page**: `LineItemsBlock` fetches the per-cart URL map from `GET /api/sytist/orders/:id/composed-thumbnails`; line item card thumbnail uses that URL when present, falls back to the existing bg+player stack
- Cache rows and S3 objects persist indefinitely. Auto-cleanup was removed in Phase 44 hotfix 2 because it raced against operator visibility (orders that auto-shipped within minutes had their cache wiped before the operator could view them)

### Dashboard-driven package expansion (Phase 39)

Sytist's `ms_cart.cart_package` field has been unreliable — packages are often stored with `cart_package=0` even when they are package parents. The dashboard now ignores that flag entirely and uses its own Settings → Packages config as the authoritative source:

- During order fetch, each line item's SKU is looked up in `packageContentsMap`
- If the SKU is a configured package, the parent is expanded into its constituent items
- `cart_photo_bg` and the green-screen flag propagate from parent to constituents (so a Bronze Package's prints all get the parent's chosen background)
- Phase 43 hotfix 1: constituent `download` flag is determined by the constituent's own SKU, NOT inherited from the parent (Silver Packages were showing all items as "Includes Download" badge incorrectly)

### Reprint workflow (Phase 35)

- Auto-detects reprint state from `order.productionStatus.id === 39 || 40`
- Button label switches to "Reprint this order" (orange)
- Per-item "Reprint this item" button on each line item card
- Output filenames numbered: `_REPRINT`, `_REPRINT_2`, `_REPRINT_3`
- Reprint never touches Sytist status, never touches ShipStation
- Single-item reprints skip the packing slip

### Sytist activity log (Phase 36)

The dashboard reads from and writes to Sytist's existing `ms_notes` table. Every dashboard action appends a `[Dashboard]`-prefixed row that shows up in Sytist's native order detail page alongside Sytist's own log entries. Operators can also add manual notes from the dashboard UI; those also appear in Sytist.

---

## Roadmap snapshot

| Phase | Description | Status |
|-------|-------------|--------|
| 0–16  | Bootstrap → core pipeline → SQLite migration + audit | ✅ |
| 17    | Green-screen compose at composite layer | ✅ |
| 18    | Specialty routing + paths refinements | ✅ |
| 19    | Packaging package-header fix | ✅ |
| 20    | Order search | ✅ |
| 21–27 | Visual editor polish (bleed, wheel resize, WYSIWYG imposition) | ✅ |
| 28    | Manual ship/unship endpoints + bulk Mark Shipped | ✅ |
| 29    | Order detail card consolidation | ✅ |
| 30    | Full shipping field writeback to Sytist | ✅ |
| 31    | Phase 31 — push packaging during adopt (REVERSED in 33) | ↩️ |
| 32    | Scheduler auto-syncs SS→Sytist | ✅ |
| 33    | Removed auto-push during adopt; added manual Push Packaging button | ✅ |
| 34    | Green-screen for imposition + packing slip | ✅ |
| 35    | Reprint workflow (full + per-item) | ✅ |
| 36    | ms_notes integration (read + write + UI card) | ✅ |
| 37    | Photo + background download links on line item card | ✅ |
| 38    | Packaging filter for unknown SKUs | ✅ |
| 39    | Dashboard-driven package expansion | ✅ |
| 40    | Process/Reprint respect saved per-order overrides | ✅ |
| 41    | Per-item thumbnails in ShipStation (imageUrl field) | ✅ |
| 42    | Pluggable composed-thumbnail backend (S3) | ✅ |
| 43    | SQLite cache for composed URLs + Push Packaging resilience | ✅ |
| 44    | Composite thumbnails on packing slip, ShipStation, dashboard | ✅ |
| 45    | SS eligibility honors packaging-config category=digital | ✅ |
| 46    | Order-detail composite affordances on each line item | ✅ |
| 47    | Override editor wired into the operator-fix loop | ✅ |

See `CHANGELOG.md` for what each phase delivered and `SPEC.md` for the full design notes.

---

## Conventions

- **Ports:** server 3011, client 3010
- **No business logic in routes.** Routes are thin: parse input, call a service, return JSON.
- **SQLite at `server/config/sytist-dashboard.db`** for: auth, sessions, addon mappings, packages, order overrides, unified config history, ShipStation links, order status audit. Single file, easy to back up.
- **JSON config files** in `server/config/` for the rest (packaging-config, size-mappings, composite-mappings, imposition-layouts, etc.).
- **Nodemon ignores `*.json` and `config/`** to prevent restarts on config writes.
- **Never write to `ms_order_status_logs`** in Sytist. See the allow-list above.
- **Username for audit history** comes from `req.user?.username`. The new ms_notes path uses `req.user?.display_name` (matches Sytist's convention).

---

## Troubleshooting

**Client says "Server not reachable"** — make sure the server started on 3011. Check terminal for errors.

**`npm run dev` only starts one process** — ensure you ran `npm run install-all` (installs `concurrently` at root).

**Saving a setting causes the page to break** — nodemon may be restarting on a JSON write. Check `server/nodemon.json` ignores `config/`.

**MySQL connection errors** — verify `server/.env` credentials. The droplet's MySQL is older and rejects `LIMIT` inside `IN (subquery)`. Test queries against the actual droplet.

**Reprint isn't producing files** — verify the order is in status 39 (Shipped) or 40 (Printing). Reprint mode only fires for those statuses.

**ms_notes rows aren't appearing in Sytist** — check the server log for `[Processing] ms_notes insert failed for ...`. The most common cause is MySQL strict mode rejecting a literal zero-date; the Phase 36 hotfix lets MySQL apply schema defaults instead of writing the literal.

**Photos won't download from the line item links** — the Sytist URL needs to be reachable from your browser. The download link uses the same `fullUrl` the dashboard uses for processing; if it works in Process, it works here.

**Phantom SS orders appearing without dashboard involvement** — an external integration (a coworker's tool, a connected ShipStation store, a script) is creating SS orders. The dashboard's Phase 33 "adopt without push" behavior handles this gracefully, but to fix the root cause, identify the integration in ShipStation Settings → Selling Channels.

---

## Backups

Two things worth backing up:

1. **`server/config/sytist-dashboard.db`** — auth, sessions, configs, audit history, ShipStation links. Most valuable file.
2. **`server/config/*.json`** — every other config. Operator-edited and harder to reconstruct than from a backup.

Snapshot `server/config/` periodically.
