# Sytist Production Dashboard

Web-based production dashboard for processing Sytist orders into Darkroom-ready txt files, packing slips, and ShipStation shipments. Pulls order data directly from the Sytist MySQL database.

Mirrors the architecture of the Photo Day Dashboard but is a separate, standalone project.

**Status:** Phase 16 — production-capable. See `SPEC.md` for the full phase history.

---

## What it does

- Pulls order data from the Sytist MySQL database (read-mostly — only writes `ms_orders.order_open_status`)
- Builds **Darkroom .txt files** so prints flow through the lab's existing CRD-template printing
- Generates **5×8 packing slips** at 300 DPI with thumbnails, QR codes, subject info, and modifier highlights
- **Imposes** multiple prints onto sheets (8 wallets to a 5×7, 2 magnets, etc.) with per-product layouts
- **Routes** specialty products to separate folders and excludes them from the .txt
- **Expands** package SKUs into their constituent items (Gold Package → 9 distinct production items)
- **Expands** add-on options into either synthetic line items (e.g. "2 magnets" → SKU 15, qty 2) or modifier suffixes on the parent (e.g. "Frame" → "8x10 (Framed)")
- Sends shipments to **ShipStation** via the v1 API (workflow-gated)
- Provides a **Settings UI** for everything: API keys, paths, packaging weights, packages, addons, specialty SKUs, imposition layouts, composite layouts, folder sort, shipping mappings
- **Audit history** tracks every settings change with prev/new diffs and `by <username>` attribution
- **Export/import** lets you back up or share configs as JSON files

---

## Setup

### Prerequisites

- Node.js 22+ (developed on 22.13.1)
- Network access to the Sytist droplet (MySQL on 3306)
- A `.env` file in `server/` with required variables (see `.env.example`)
- **Windows build tools** for `better-sqlite3` and `bcrypt` native modules — usually fine on a stock Node 22 install. If you hit compile errors during `npm install`, paste them and we'll work through it.

### First-time install

From the project root:

```powershell
npm run install-all
```

This installs deps for the root, server, and client in one go.

### Configure environment

Copy the env template and fill in values:

```powershell
copy .env.example server\.env
```

At minimum set:
- `SESSION_SECRET` (generate with the command below)
- `MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` for the Sytist DB
- `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`, `INITIAL_ADMIN_DISPLAY_NAME` — bootstrap admin user, only used on first server start if no users exist
- `PHOTODAY_API_KEY` / `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` (set later via Settings → API Keys, but environment vars also work)

Generate a session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Run (development)

```powershell
npm run dev
```

Starts both processes concurrently:

- Server on http://localhost:3011
- Client on http://localhost:3010

Open http://localhost:3010, log in with your `INITIAL_ADMIN_*` credentials, and you're in.

### Run individually

If you want one without the other:

```powershell
npm run server   # only the Express API
npm run client   # only the React dev server
```

### Adding more users

```powershell
npm run add-user --prefix server -- newusername password123
```

Or use the Users management UI inside the dashboard.

---

## Project structure

```
sytist-dashboard/
├── server/                          Express API server (port 3011)
│   ├── index.js                     App entry — boots services, mounts routes
│   ├── nodemon.json                 Phase 16: ignores config/ + *.json
│   ├── routes/                      HTTP routes (thin — delegate to services)
│   │   ├── auth.js                  Login, logout, sessions, users
│   │   ├── sytist.js                Orders, packages, addons, configs, history
│   │   ├── shipstation.js           Packaging config, shipping
│   │   ├── photoday.js              PhotoDay API integration
│   │   ├── darkroom.js              Darkroom settings
│   │   └── ...
│   ├── services/                    Business logic — testable units
│   │   ├── database.js              SQLite init + schema + migrations
│   │   ├── authService.js
│   │   ├── sytistDbService.js       MySQL pool + canonical order shape
│   │   ├── processingService.js     Full pipeline: download → produce
│   │   ├── packagingService.js      productWeights + bundles
│   │   ├── packingSlipService.js    5×8 slip with modifiers + barcode
│   │   ├── packageContentsService.js   Phase 15a — package SKU → items
│   │   ├── addonMappingsService.js     Phase 15b/c — opt_id → SKU/suffix
│   │   ├── orderOverrideService.js     Phase 11 — per-order layout overrides
│   │   ├── configHistoryService.js     Phase 16 — unified audit log
│   │   ├── compositeService.js
│   │   ├── impositionService.js
│   │   ├── folderSortService.js
│   │   ├── specialtyService.js
│   │   ├── darkroomService.js
│   │   ├── shipstationService.js
│   │   ├── schedulerService.js
│   │   ├── pathsService.js
│   │   └── ...
│   ├── middleware/
│   │   └── auth.js                  requireAuth, requireRole, optionalAuth
│   ├── config/                      JSON configs + SQLite DB (gitignored)
│   │   ├── sytist-dashboard.db      auth, sessions, addons, packages, overrides, history
│   │   ├── packaging-config.json
│   │   ├── size-mappings.json
│   │   ├── path-overrides.json
│   │   ├── shipping-option-mappings.json
│   │   ├── *.json.migrated          Phase 16 archive — kept as rollback backup
│   │   └── ...
│   ├── scripts/
│   │   └── add-user.js              CLI for adding users
│   └── assets/                      Uploaded overlays/logos/fonts (Phase 9, gitignored)
│
├── client/                          React app (port 3010 in dev)
│   ├── public/
│   └── src/
│       ├── App.js
│       ├── index.js
│       ├── components/
│       │   ├── AppLayout.js         Route registration + nav
│       │   ├── HistoryModal.js      Phase 16 audit log viewer
│       │   └── ...
│       ├── pages/
│       │   ├── LoginPage.js
│       │   ├── Dashboard.js
│       │   ├── OrdersListPage.js
│       │   ├── OrderDetailPage.js
│       │   └── settings/
│       │       ├── SettingsLayout.js
│       │       ├── ApiKeysPage.js
│       │       ├── PackagingPage.js
│       │       ├── PackagesPage.js          Phase 15a
│       │       ├── AddonsPage.js            Phase 15b/c
│       │       ├── PathsPage.js
│       │       ├── FolderSortPage.js
│       │       ├── SpecialtyPage.js
│       │       ├── ImpositionPage.js
│       │       ├── CompositePage.js
│       │       ├── ShippingPage.js
│       │       └── DarkroomPage.js
│       ├── services/
│       │   └── api.js               Fetch wrapper with session header
│       └── styles/
│
├── nodemon.json                     Backup nodemon config at root
├── SPEC.md                          Full project specification
├── README.md                        This file
├── OperatorManual.md                Day-to-day operator guide
├── AdminManual.md                   Setup, config, and troubleshooting
├── package.json                     Root scripts (run both, install-all)
├── .gitignore
└── .env.example
```

### Why separate `server/` and `client/`?

Same pattern as the Photo Day Dashboard. The server is a long-running Node process; the client is a static bundle in production. Keeping them in separate trees keeps deps clean and lets each be deployed independently when we move to the droplet container.

---

## Roadmap

| Phase | Description | Status |
|-------|-------------|--------|
| 0  | Bootstrap — skeleton, dev server runs | ✅ |
| 1  | Auth — login page, session middleware, user CRUD | ✅ |
| 2  | Sytist MySQL data layer | ✅ |
| 3  | Read-only orders UI | ✅ |
| 4  | Pipeline port (Darkroom txt, packing slip, imposition, packaging) | ✅ |
| 5  | ShipStation integration | ✅ |
| 6  | Schedulers (auto-fetch + scheduled batch) | ✅ |
| 7  | Status writeback to Sytist | ✅ |
| 8  | Composition engine (composite layouts, JSON-driven) | ✅ |
| 9  | Asset upload + per-gallery logo assignment | ✅ |
| 10 | Visual template / composite editor | ✅ |
| 11 | Per-order re-render with overrides | ✅ |
| 12 | Polish — production analytics, dashboard, folder sort, specialty | ✅ |
| 13 | Packaging engine — productWeights + bundles | ✅ |
| 14a | Orders list workflow count fix | ✅ |
| 14b | Prev/Next order navigation | ✅ |
| 15a | Package explosion (Gold/Silver/Bronze → constituent items) | ✅ |
| 15b | Add-on explosion (ms_cart_options → synthetic line items) | ✅ |
| 15c | Add-on qty + modifier-suffix add-ons | ✅ |
| 16 | SQLite migration for addon/package configs + audit history + export/import | ✅ |

Open / planned items (no formal phase yet):
- Real production end-to-end test of all the explosion changes
- Visual grouping on order detail + slip (indent constituents under parent)
- Migration of remaining JSON configs to SQLite (packaging-config, size-mappings, composite-mappings, etc.) following the same pattern as Phase 16
- Export endpoint auth fix (currently triggers a redirect because `<a>.click()` doesn't send the session header)

See `SPEC.md` for what each phase delivers and the rationale behind the ordering. See `OperatorManual.md` for day-to-day workflow. See `AdminManual.md` for setup, configuration, and troubleshooting.

---

## Conventions

- **Ports:** server 3011, client 3010 (chosen to coexist with the Photo Day Dashboard on 3000/3001).
- **No business logic in routes.** Routes are thin: parse input, call a service, return JSON. Services are testable units.
- **SQLite at `server/config/sytist-dashboard.db`** for: auth, sessions, addon mappings (Phase 16), packages (Phase 16), order overrides (Phase 11), unified config history (Phase 16). Single file, easy to back up.
- **JSON config files** in `server/config/` for everything else (packaging-config, size-mappings, composite-mappings, imposition-layouts, etc.). These will migrate to SQLite incrementally as the need arises.
- **`*.json.migrated` files** are renamed-after-migration originals from Phase 16. Kept as rollback artifacts. Safe to delete once SQLite is proven.
- **Nodemon ignores `*.json` and `config/`** — both `server/nodemon.json` and the root `nodemon.json`. This prevents the dev server from restarting mid-request when configs get written.
- **Never write to `ms_order_status_logs`** in the Sytist database. That table is owned by an existing automation. We write to `ms_orders.order_open_status` instead.
- **Username for audit history** comes from `req.user?.username` (set by `requireAuth` middleware). Routes pass it through to service writes. Edits without an auth session record `changed_by: null`, which is acceptable.

---

## Troubleshooting

**Client says "Server not reachable"** — make sure the server actually started on 3011. Check the terminal where `npm run dev` is running for errors. Common cause: port 3011 already in use.

**`npm run dev` only starts one process** — `concurrently` should run both. If only one runs, check that you ran `npm run install-all` (which installs `concurrently` at the root).

**Saving a setting causes the page to break or shows a proxy ECONNRESET** — nodemon is restarting on the config file write. Phase 16 mostly eliminates this by moving config writes to SQLite, but if it happens for a config still on JSON, check that `server/nodemon.json` exists and contains `"ignore": ["config/", ...]`. Restart `npm run dev` after fixing.

**MySQL connection errors** — verify the credentials in `server/.env`. The MySQL on the Sytist droplet is older and has some quirks (rejects `LIMIT` inside `IN (subquery)`, doesn't like `before` as a column alias). If you write new queries, test against the actual droplet, not a local MySQL.

**Migration didn't run on first boot** — check the server console for `[Database] Migrated N addon mappings from JSON` lines. If you don't see them, either the JSON files were already migrated (look for `*.json.migrated` in `server/config/`) or the SQLite tables already had data. Both are normal.

**Rollback Phase 16 migration** — stop the dev server. Restore your `sytist-dashboard.db` backup. Rename `addon-mappings.json.migrated` → `addon-mappings.json` (same for package-contents). Revert `server/services/database.js`, `addonMappingsService.js`, and `packageContentsService.js` to their pre-Phase-16 versions via git. Restart.

**Port 3010 already in use** — the photo day dashboard might be running on 3000, but if something else is on 3010 you'll need to either stop it or change the port in `client/package.json` and the CORS origin in `server/index.js`.

---

## Backups

Two things worth backing up:

1. **`server/config/sytist-dashboard.db`** — auth + sessions + Phase 16 configs + audit history. Most valuable file.
2. **`server/config/*.json`** — every other config file. These are operator-edited and harder to reconstruct from scratch than from a backup.

Easy approach: snapshot `server/config/` as a whole, periodically. Tar it, drop on the F: drive (or whatever you use for backups).
