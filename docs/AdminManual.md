# Sytist Production Dashboard — Admin Manual

This manual covers setup, configuration, and troubleshooting for admins. For day-to-day order processing, see `OperatorManual.md`.

---

## Table of contents

1. [Initial install](#1-initial-install)
2. [Environment configuration](#2-environment-configuration)
3. [First-time bootstrap](#3-first-time-bootstrap)
4. [Managing users](#4-managing-users)
5. [Settings overview](#5-settings-overview)
6. [Settings → API Keys](#6-settings--api-keys)
7. [Settings → Paths](#7-settings--paths)
8. [Settings → Packaging](#8-settings--packaging)
9. [Settings → Packages](#9-settings--packages)
10. [Settings → Add-ons](#10-settings--add-ons)
11. [Settings → Imposition](#11-settings--imposition)
12. [Settings → Composite](#12-settings--composite)
13. [Settings → Folder Sort](#13-settings--folder-sort)
14. [Settings → Specialty Products](#14-settings--specialty-products)
15. [Settings → Shipping Mappings](#15-settings--shipping-mappings)
16. [Settings → Darkroom](#16-settings--darkroom)
17. [Audit history](#17-audit-history)
18. [Export / Import configs](#18-export--import-configs)
19. [Backups](#19-backups)
20. [Troubleshooting](#20-troubleshooting)
21. [Updating the dashboard](#21-updating-the-dashboard)
22. [The data model](#22-the-data-model)

---

## 1. Initial install

### Prerequisites

- **Windows 10/11**, the production machine
- **Node.js 22+** — install from https://nodejs.org if not already present
- **Git** — install from https://git-scm.com
- **Network access** to the Sytist droplet's MySQL (typically port 3306)

### Clone

```powershell
cd C:\Users\Sportsline\Downloads
git clone https://github.com/jfreeman1412-stack/Sytist-Production-Dashboard.git sytist-dashboard
cd sytist-dashboard
```

(Or wherever you want it. The convention is `C:\Users\Sportsline\Downloads\sytist-dashboard\sytist-dashboard\`.)

### Install dependencies

```powershell
npm run install-all
```

This installs the root, server, and client dependency trees in one command. Expect a few minutes.

If `better-sqlite3` or `bcrypt` fail to compile, you may need Microsoft Build Tools:

```powershell
npm install --global windows-build-tools
```

(Run as administrator.) Or install Visual Studio Build Tools manually from Microsoft's site.

---

## 2. Environment configuration

Copy the example file:

```powershell
copy .env.example server\.env
```

Open `server\.env` in a text editor.

### Required variables

```env
# Session security — REQUIRED
SESSION_SECRET=<generate one — see below>

# Sytist database — REQUIRED
MYSQL_HOST=24.199.107.201
MYSQL_PORT=3306
MYSQL_USER=script_user
MYSQL_PASSWORD=<from your Sytist droplet credentials>
MYSQL_DATABASE=sportsline

# First-run admin bootstrap — only used if no users exist yet
INITIAL_ADMIN_USERNAME=joey
INITIAL_ADMIN_PASSWORD=<pick a secure password>
INITIAL_ADMIN_DISPLAY_NAME=Joey Freeman
```

Generate `SESSION_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy that 64-character hex string into the env file.

### Optional but recommended

```env
# PhotoDay API (if integrating)
PHOTODAY_API_KEY=...

# ShipStation API (if integrating)
SHIPSTATION_API_KEY=...
SHIPSTATION_API_SECRET=...
```

You can also leave these blank and configure them in the dashboard's Settings → API Keys after the first login.

---

## 3. First-time bootstrap

The first time you run the server, it does several things automatically:

1. Creates `server/config/sytist-dashboard.db` (the SQLite database)
2. Runs schema migrations (creates all tables)
3. Looks for `INITIAL_ADMIN_*` env vars. If set AND no users exist yet, it creates that user as an admin.
4. Looks for any existing JSON configs in `server/config/` and migrates them to SQLite tables (Phase 16 migration: addon-mappings, package-contents)

Start the dev server:

```powershell
npm run dev
```

Wait for:

```
[Database] Initialized at C:\...\server\config\sytist-dashboard.db
[sytist-dashboard] server listening on http://localhost:3011
webpack compiled successfully
```

![Screenshot: terminal showing successful first boot](screenshots/admin-01-first-boot.png)

If you see migration log lines like:

```
[Database] Migrated 14 addon mappings from JSON
[Database] Archived addon-mappings.json to addon-mappings.json.migrated
```

… that's normal — Phase 16's migration ran. The `.migrated` files in `server/config/` are kept as rollback artifacts.

Open http://localhost:3010 in your browser. You should see the login page.

Log in with `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`.

![Screenshot: login page with credentials filled in](screenshots/admin-02-login.png)

---

## 4. Managing users

### Add a user from the UI

Settings → Users (if available) → **+ Add User**.

![Screenshot: Settings Users page with add form](screenshots/admin-03-users-list.png)

Fields:
- Username
- Display name
- Password
- Role: `admin` or `operator`
- Active (toggle)

### Add a user from the command line

```powershell
npm run add-user --prefix server -- newusername password123
```

The script prompts for additional fields if needed.

### Remove or disable a user

In the UI, click **Edit** on the user row and uncheck **Active**. The user account remains in the database (so their audit-log entries still make sense) but they can't log in.

### Change a user's password

Same place: Edit → set a new password → Save.

---

## 5. Settings overview

Click **Settings** in the top navigation. The settings layout has a sidebar with all sub-pages.

![Screenshot: settings sidebar showing all sections](screenshots/admin-04-settings-sidebar.png)

The sections, in roughly the order you'd configure them on a fresh install:

| Section | What it controls |
|---------|------------------|
| **API Keys** | PhotoDay, ShipStation, other external API credentials |
| **Paths** | Where output files write (test vs production paths) |
| **Packaging** | Product weights + bundle weights for shipping calculation |
| **Packages** | Package SKU → constituent items (Phase 15a) |
| **Add-ons** | co_opt_id → SKU / suffix mappings (Phase 15b/c) |
| **Imposition** | Multi-up layouts per SKU |
| **Composite** | Composite layouts per SKU (Memory Mate, etc.) |
| **Folder Sort** | How output folders are organized |
| **Specialty** | SKUs that get separate folder routing |
| **Shipping** | Sytist shipping option name → workflow mapping |
| **Darkroom** | .txt format settings |
| **Users** | User management (if you have it) |

---

## 6. Settings → API Keys

![Screenshot: API Keys settings page](screenshots/admin-05-api-keys.png)

Fields you'll want to set:

- **PhotoDay API Key** — for PhotoDay-related integration (if applicable)
- **ShipStation API Key** + **ShipStation API Secret** — for shipment submission
- **Darkroom path / credentials** — depends on your Darkroom setup

Each field has a show/hide toggle so the secret is masked by default.

Save changes per section. The change is recorded in the audit log.

---

## 7. Settings → Paths

![Screenshot: Paths settings page with dynamic variable preview](screenshots/admin-06-paths.png)

Controls where output files write.

Two modes:

- **Test** — writes to `C:\Users\Sportsline\Downloads\sytist-dashboard-test-output\{date}\` so your test runs don't pollute production
- **Production** — writes to the lab's real production location

The path template supports dynamic variables:

- `{date}` — today's date, format `YYYY-MM-DD`
- `{year}`, `{month}`, `{day}` — components
- `{order_id}` — the Sytist order ID (rare; usually folder sort handles this)

Below the template field is a **live resolved preview** showing what the path looks like right now.

Switch modes via the dropdown at the top. Mode is preserved across server restarts.

---

## 8. Settings → Packaging

![Screenshot: Packaging settings page with productWeights table](screenshots/admin-07-packaging.png)

The single most important config for the lab. Every SKU you can ship needs an entry here.

### Product Weights table

Per SKU, you set:

- **SKU** — the dashboard SKU (e.g. `8` for 8×10 Individual)
- **Name** — display name
- **Weight (oz)** — physical weight, in ounces. Used for ShipStation shipment weight and for slip totals.
- **Category** — `flat`, `bulky`, or `digital`
  - `flat` — counted in standard envelope weight
  - `bulky` — needs larger packaging
  - `digital` — excluded from both production and shipping math
- **External ID** — the identifier used by composite and imposition mappings (often a unique product code from Sytist or your catalog)

### Package Bundles table

Bundle weights are set to 0 since the package-explosion (Phase 15a) emits constituent items, and each constituent carries its own weight via the productWeights entry. The package row itself is just a header for display.

### Adding a SKU

Click **+ Add Product**. Fill in the fields. Save.

### Editing

Click the SKU row, edit the fields inline, click **Save**.

### Deleting

Click **Delete** on the row. You'll be asked to confirm.

---

## 9. Settings → Packages

This is where you define **what's inside a package SKU** so the pipeline can explode it into constituent items at processing time.

![Screenshot: Packages settings page with cards for Gold/Silver/Bronze](screenshots/admin-08-packages.png)

### Per-package card

Each card has:

- **Package name** — editable
- **Package SKU** — the parent SKU as it appears in Sytist
- **Items list** — one row per constituent, with item SKU + qty
- **Add item dropdown** — picks from your productWeights catalog
- **Lint warnings** — flags constituent SKUs that are missing composite or imposition mappings (since those items would print at full size on the wrong sheet)
- **Per-card Save** + **Delete** + **📜 History** buttons

### Sample setup

Gold Package (SKU 1):
- SKU 6 (Memory Mate), qty 1
- SKU 8 (8×10 Individual), qty 1
- SKU 10 (5×7 Individual), qty 1
- SKU 11 (3.5×5 Magnet), qty 2
- SKU 12 (Wallet sheet), qty 1
- SKU 35 (Trading Cards), qty 1
- SKU 15 (2 Magnets), qty 1
- SKU 16 (Photo Button), qty 1
- SKU 25 (Digital Download), qty 1

Silver Package (SKU 2): subset of Gold's items
Bronze Package (SKU 3): smaller subset

### Adding a new package

Click **+ Add Package** at the top. Pick the package SKU from your productWeights, give it a name, save. Then add items.

### Lint warnings

If you add an item SKU that doesn't have a composite or imposition mapping configured, you'll see a yellow warning. The package will still process, but that item will print at full size instead of being multi-up imposed. Usually a mistake — go to Settings → Imposition or Composite and add a mapping.

### View changes history

Click **📜 History** on a package card to see every edit ever made: who changed it, when, and a side-by-side diff of before/after.

![Screenshot: history modal showing diff of package edit](screenshots/admin-09-history-modal.png)

---

## 10. Settings → Add-ons

Maps Sytist `ms_cart_options.co_opt_id` values to dashboard SKUs (product type) or to suffix modifiers (modifier type).

![Screenshot: Add-ons settings page with discovery panel and configured table](screenshots/admin-10-addons.png)

### Two mapping types

**Product type** — synthesizes a new production line item.

Example: customer adds "2 5×7s" to a Memory Mate. That option maps to:
```
Type: product
Name: 2 5×7s
SKU: 10
Qty: 2
```

When the order processes, the pipeline emits a synthetic line item with SKU 10, qty 2.

**Modifier type** — appends a suffix to the parent line's product name.

Example: customer adds "Frame" to an 8×10. That option maps to:
```
Type: modifier
Name: Frame
Suffix:  (Framed)
```

When the order processes:
- The parent line becomes "8x10 Individual (Framed)" on the slip and in the Darkroom .txt
- The slip also shows a yellow `+ Frame` highlight below the product name

### Discovery panel

The top of the page shows **Unmapped add-ons in recent orders** — every co_opt_id that's been ordered recently but isn't yet mapped, sorted by occurrence count.

![Screenshot: discovery panel with unmapped options listed](screenshots/admin-11-addons-discovery.png)

Click **Map** on any row → it pre-fills the manual-add form below with the option's ID and Sytist name. Pick the type (Product or Modifier), set the SKU or suffix, click **Add**.

**Scan more orders** — by default the scan looks at the 500 most recent paid orders. Click to ladder: 500 → 1000 → 2000 → 5000.

### Configured mappings table

Once a mapping is configured, it appears in the **Configured mappings** table below.

Each row has:
- Opt ID
- Type dropdown (Product / Modifier)
- Name
- Dynamic fields: SKU + qty for Product, Suffix input for Modifier
- 📜 History button
- Save / Delete buttons

You can change a mapping's type later — switching from Product to Modifier clears the SKU/qty fields and shows the Suffix field, and vice versa.

### Manual add

If you know an opt_id before any order has used it, click **+ Add a mapping manually**. Pick type, fill in fields, add.

### Half-configured entries

A Product mapping with no SKU set, or a Modifier with no suffix, is considered **incomplete** — it shows in the table with a ⚠️ warning but doesn't drive any pipeline behavior. Operator can come back and finish it later.

---

## 11. Settings → Imposition

Configures multi-up print layouts per SKU. E.g. 8 wallets fit on one 5×7 sheet at specific positions and rotations.

The page has a layout list. Each layout has:
- Layout ID + name
- Applies to SKU(s)
- Sheet size + DPI
- Slot positions (in inches), rotations
- Gap measurements (column / row, in inches)
- Center-on-sheet toggle
- Manual margin offsets

Test layouts using the **Preview** button — renders a sample composite with placeholder image.

Settings here drive what the pipeline's imposition step does. Wrong layout = wrong print.

---

## 12. Settings → Composite

Configures composite layouts (Memory Mate-style multi-photo prints) per SKU.

The page lists composite layouts. Each has:
- Template ID, name
- Applies to SKUs
- Output size (in inches) + DPI
- Vertical and horizontal variants (selected based on customer photo orientation)
- Slots per variant:
  - Individual photo
  - Team photo
  - Overlay PNG
  - Logo (per-gallery)
  - Text (with variable substitution)

The **visual editor** (Phase 10) lets you drag handles to position slots. Save → preview render against a sample order.

See `SPEC.md` §6.5 for the full composition system reference.

---

## 13. Settings → Folder Sort

Controls how output files are organized in the print folder hierarchy.

You build a sort by selecting levels in order:

1. Gallery
2. Order ID
3. Shipping Type
4. Shipping Name
5. No Sort

Each level is a folder layer. Example: Gallery → Order ID produces `<gallery>/<order_id>/<files>`.

**No Sort** is exclusive — if selected, it's the only level and outputs go flat.

---

## 14. Settings → Specialty Products

SKUs that get routed to a separate folder and excluded from the standard Darkroom .txt (because they're produced through a different process — e.g. embossed prints, custom framing).

Per SKU:
- SKU + name
- Highlight color (used on the slip — picks the row out visually)
- Output folder name

---

## 15. Settings → Shipping Mappings

Maps Sytist shipping option names → workflow buckets.

Example:
- "USPS-Ship to Home" → workflow: `shipstation`
- "Pick up at school" → workflow: `managers`
- "Coach distribution" → workflow: `one_contact`

Plus a numeric fallback based on `order_shipping` cost (see Operator Manual §7).

---

## 16. Settings → Darkroom

Settings for the Darkroom .txt output:
- Output folder
- Filename template (with dynamic variables)
- Field formatting (which Sytist fields go into which Darkroom .txt columns)
- Header/footer text (if any)

---

## 17. Audit history

Every edit to addon mappings, packages, and order overrides is recorded in the `config_history` table with:

- What changed (the entity ID)
- Action (insert / update / delete)
- Before and after JSON snapshots
- Timestamp
- Username (or "migration" for the initial Phase 16 import)

To view history for an item:

1. Open Settings → Add-ons or Settings → Packages
2. Find the row/card
3. Click **📜 History**

![Screenshot: history modal showing timeline of edits](screenshots/admin-09-history-modal.png)

The modal shows the timeline newest-first with side-by-side diffs.

To query history programmatically:

```
GET /api/sytist/config-history?type=addon_mapping&id=2007
GET /api/sytist/config-history?type=package&id=1
GET /api/sytist/config-history/recent?type=package&limit=20
```

---

## 18. Export / Import configs

The ↓ Export and ↑ Import buttons in the headers of Settings → Add-ons and Settings → Packages let you:

- **Export** — download the current config as a JSON file with today's date in the filename
- **Import** — upload a JSON file (same shape as export) to replace the current config wholesale

Use cases:
- Backup before a big edit
- Move configs between dev and production environments
- Bulk edit in a text editor
- Share configs between operators

Import shows a confirmation prompt with the entity count. After import, the entire config is recorded as a series of update entries in audit history.

**Known issue:** the Export button currently has a bug where it redirects to the homepage instead of downloading on some setups (because the download mechanism doesn't carry the auth session header). Fix coming. Workaround for now: hit `GET /api/sytist/addon-mappings/export` directly with credentials, or use the audit log if you need a snapshot.

---

## 19. Backups

The dashboard's state lives in three places:

| Location | What's there | Backup frequency |
|----------|-------------|-----------------|
| `server/config/sytist-dashboard.db` | Auth, sessions, addons, packages, overrides, audit history | Daily |
| `server/config/*.json` | All other configs (packaging, imposition, composite, paths, etc.) | After every significant edit |
| `server/assets/` | Uploaded overlays/logos/fonts | After uploading new assets |

### Easy backup approach

Take a tar of `server/config/` and `server/assets/` periodically:

```powershell
$date = Get-Date -Format "yyyy-MM-dd"
mkdir F:\sytist-backups -Force
tar -czf F:\sytist-backups\config-$date.tar.gz -C C:\Users\Sportsline\Downloads\sytist-dashboard\sytist-dashboard\server config assets
```

Run that nightly via Task Scheduler. Keep a week of backups.

### Restoring from backup

1. Stop the dev server (Ctrl+C in the terminal)
2. Replace the corrupt `server/config/` (or `server/assets/`) with the backup
3. Restart `npm run dev`

---

## 20. Troubleshooting

### "Server won't start — port 3011 already in use"

Something else is listening on 3011. Find and kill it:

```powershell
netstat -ano | findstr :3011
taskkill /F /PID <the PID from above>
```

Restart `npm run dev`.

### "MySQL connection refused"

Check the credentials in `server/.env`. Try connecting to the Sytist MySQL from a separate tool (HeidiSQL, mysql CLI) with the same credentials. Common causes:
- IP blocklist on the droplet
- VPN required
- Password changed
- MySQL is down

### "Saving a setting causes a proxy ECONNRESET"

Nodemon is restarting on the file write. Check that `server/nodemon.json` exists and contains `"ignore"` patterns for `config/` and `**/*.json`. **Fully restart** the dev server (Ctrl+C + `npm run dev` — auto-restart doesn't pick up nodemon config changes).

### "Migration didn't run on first boot"

That's normal if:
- The `.json` files were already migrated (look for `*.json.migrated` in `server/config/`)
- The SQLite tables already had data

If you specifically need to re-run the migration (e.g. after restoring from a backup), drop the relevant tables and rename the `.migrated` files back to `.json`:

```powershell
# WARNING: this destroys current data — only do this if you have a backup
sqlite3 server/config/sytist-dashboard.db "DELETE FROM addon_mappings;"
ren server\config\addon-mappings.json.migrated addon-mappings.json
# restart server — migration re-runs
```

### "Add-on saved but still shows in unmapped"

The mapping is incomplete — either the product SKU is missing, or the modifier suffix is empty. Discovery treats it as unmapped until it's complete.

### "Package processed but pipeline only created the header"

The package SKU has no constituent items configured in Settings → Packages. Or all the constituent items have `category = "digital"` in productWeights, which skips them.

### "Order shows wrong production status"

The dashboard reads `ms_orders.order_open_status` from Sytist. If Sytist's automation hasn't run yet, you might see stale data. The dashboard's auto-fetch poll (every 5 min) re-reads from MySQL.

### "Composite is rendering with the wrong photo"

Look at the photo and team photo selectors in Settings → Composite for that SKU. Common issue: team photo matching is case-sensitive on the filename. Sub-gallery names with special characters can break matching — try the **teamPhotoPriceListId** backstop in Settings if available.

### "Discovery panel takes 10+ seconds to load"

Scan limit might be set higher than needed. Default is 500 orders. If you bumped it to 5000 and the MySQL connection is slow, that's the cause. Set back to 500.

### "I want to wipe everything and start over"

```powershell
# Stop the server first
del server\config\sytist-dashboard.db
del server\config\*.json.migrated
# Restart server — fresh schema, no users, will create INITIAL_ADMIN_*
```

**This destroys all audit history.** Make a backup first.

### "Where are server logs?"

Currently in the terminal where `npm run dev` is running. There's no log file by default. For production, you might want to redirect stdout to a file.

---

## 21. Updating the dashboard

If we ship a new phase (or hotfix), the deploy pattern is:

```powershell
cd C:\Users\Sportsline\Downloads\sytist-dashboard\sytist-dashboard
tar -xzf F:\Downloads\sytist-dashboard-phase-XX.tar.gz --strip-components=1
```

That overwrites the changed files in place. The `--strip-components=1` flag removes the leading `sytist-dashboard-phase-XX/` from the archive paths.

After extraction:

- **Backend changes** — nodemon auto-restarts the server (unless it's a `package.json` change, in which case run `npm install --prefix server`)
- **Frontend changes** — webpack auto-recompiles, hard-refresh the browser (Ctrl+Shift+R)

For phases that include database schema changes (like Phase 16), back up `sytist-dashboard.db` first.

---

## 22. The data model

### SQLite — `server/config/sytist-dashboard.db`

| Table | Purpose |
|-------|---------|
| `users` | Auth (username, password_hash, role, active) |
| `sessions` | Active session tokens |
| `addon_mappings` | co_opt_id → SKU / suffix (Phase 16) |
| `packages` | Package SKUs (Phase 16) |
| `package_items` | Items per package (Phase 16) |
| `order_overrides` | Per-order composite layout overrides (Phase 11) |
| `config_history` | Unified audit log (Phase 16) |
| (other tables) | Various — see `database.js` for the schema |

### JSON configs — `server/config/*.json`

| File | Purpose |
|------|---------|
| `packaging-config.json` | productWeights + packageBundles |
| `size-mappings.json` | SKU → physical size |
| `composite-mappings.json` | Composite layout assignments |
| `imposition-config.json` | Imposition layout config |
| `shipping-option-mappings.json` | Shipping option name → workflow |
| `path-overrides.json` | Test vs production output paths |
| `processing-settings.json` | Pipeline preferences |
| `darkroom-settings.json` | Darkroom .txt format settings |

These are still on JSON because their write frequency is low (operator changes once or twice, never again). The Phase 16 SQLite migration pattern can be applied to any of them if it becomes useful.

### Sytist MySQL — read-mostly

The dashboard reads heavily from Sytist's MySQL but only ever writes to **one column**: `ms_orders.order_open_status`. Everything else is read-only.

Key tables we query:
- `ms_orders` — order header
- `ms_cart` + `ms_cart_archive` — line items
- `ms_cart_options` — add-ons
- `ms_photos` — image metadata
- `ms_sub_galleries` — team/event sub-gallery info
- `ms_calendar` — gallery dates and IDs
- `ms_blog_categories` — gallery hierarchy
- `ms_order_status` — production status names
- (others — see `sytistDbService.js` for the full query surface)

---

## When to call for help

For anything that:
- Affects orders being processed right now (production-blocking)
- Involves the Sytist MySQL going down or returning unexpected data
- Involves money — payment statuses, shipping costs, customer info
- Requires a code change (not just a settings tweak)

If it can wait, write it up with screenshots and a description of what you tried. Otherwise, escalate immediately.

---

# Phase 17–37 — Features added after the original manual

Everything above this line is from the Phase 16 baseline and remains accurate for setup, users, and core settings. The sections below cover features added in phases 17–37. When they conflict with anything above, **this section is authoritative**.

---

## 30. Green-screen pipeline (Phase 17 + 34)

Sytist's green-screen products work like this:
- Customer's photo is uploaded as a transparent PNG (subject keyed out by Sytist's tooling)
- Customer chooses a background from a Sytist-managed pool
- `ms_cart.cart_photo_bg` stores the chosen background photo ID

The dashboard's canonical line item surfaces this as:
- `lineItem.flags.greenScreen` (boolean)
- `lineItem.backgroundPhoto.fullUrl` (URL of the background image)

### Where compositing happens

| Pipeline stage | Used by | Background applied via |
|---|---|---|
| **Composite engine** | Composite-mapped SKUs (Memory Mate, etc.) | `playerBackground` slot in the layout |
| **Imposition path** | Plain prints (Mini Magnets, wallets, etc.) | `processingService` Step 1.4 composes `<photo>_composed.jpg` before imposition reads the photo |
| **Packing slip thumbnails** | All slip rows | Three-tier strategy: composed disk file → on-demand compose → plain thumbUrl |

### Step 1.4 mechanics

Runs after the download loop and before the composite engine in `processOrder`:

```js
for each lineItem where shouldComposite(li) AND no composite mapping:
  read downloaded subject buffer
  call greenscreenService.composeWithBackground(subject, backgroundUrl)
  write to <orig>_composed.jpg
  update photosByCartId[cartId].path to point at composed file
  add cartId → composedPath to composedByCartId map
pass composedByCartId to packingSlipService.buildSlipBuffer()
```

Composite-mapped SKUs are deliberately skipped because the composite engine handles backgrounds via the `playerBackground` slot during composite render — double-compositing would be wrong.

### Failure handling

Compose failure is non-fatal: subject-only is used and a warning is surfaced (`type: 'greenscreen_*'`). Operator sees the warning in the result UI but the line still processes.

### Operator UX

- Line item card shows the **Green Screen** flag chip
- Photo filename AND background filename are both download links (Phase 37)
- Composite preview thumbnail shows the actual composed image
- Packing slip preview thumbnails also show composites

---

## 31. Manual ship/unship endpoints (Phase 28)

New `orderStatusService` module owns the ship/unship logic. See `SPEC.md` section 28 for full mechanics.

### Settings to configure

```json
// processing-settings.json
{
  "autoStatusUpdate": true,
  "targetStatusId": 40,         // status after successful Process
  "shippedStatusId": 39,        // status used by Mark Shipped
  "shipEligibleFromStatusIds": [40]   // statuses that can transition to Shipped
}
```

`force: true` in the ship endpoint bypasses the eligibility check (use sparingly — admin operations only).

### Endpoints summary

| Endpoint | Role | Purpose |
|---|---|---|
| `POST /api/sytist/orders/:orderId/ship` | admin, operator | Single order Mark Shipped |
| `POST /api/sytist/orders/:orderId/unship` | admin | Reverse to Printing |
| `POST /api/sytist/orders/batch-ship` | admin, operator | Bulk Mark Shipped |

### Audit table

```sql
CREATE TABLE IF NOT EXISTS order_status_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  order_id INTEGER NOT NULL,
  from_status INTEGER,
  to_status INTEGER,
  source TEXT,           -- 'manual', 'bulk', 'manual_override', 'shipstation_auto', 'reprint'
  user_id INTEGER,
  notes TEXT,
  shipping_fields_json TEXT  -- Phase 30 snapshot
);
```

Created automatically by `orderStatusService.ensureAuditTable()` on first use. To inspect:

```bash
cd server
node -e "const db = require('better-sqlite3')('config/sytist-dashboard.db'); console.log(JSON.stringify(db.prepare('SELECT * FROM order_status_audit ORDER BY ts DESC LIMIT 20').all(), null, 2));"
```

---

## 32. Shipping field writeback (Phase 30)

**Expansion of the Sytist write allow-list.** Before Phase 30 the dashboard only wrote `ms_orders.order_open_status`. Now it also writes 5 shipping columns:

| Column | Type | Source |
|---|---|---|
| `order_shipped_date` | DATE | SS link's `shipped_at` or today |
| `order_shipped_track` | varchar(255) | tracking from SS link |
| `order_shipped_by` | varchar(50) | `CARRIER_CODE_MAP[carrierCode]` (stamps_com→USPS, fedex→FEDEX, ups→UPS) |
| `order_shipped_by_id` | int | always 0 |
| `order_ship_cost` | decimal(10,2) | parsed from SS link payload |

All NOT NULL with zero-defaults in Sytist.

### When the writeback happens

- Manual Mark Shipped on a single order
- Bulk Mark Shipped from the orders list selection
- Scheduler-detected SS shipment (`source: 'shipstation_auto'`)

### Reset to zero on unship

`buildShippingFieldsForUnship()` returns zero-defaults:
- `order_shipped_date: '0000-00-00'`
- `order_shipped_track: ''`
- `order_shipped_by: ''`
- `order_shipped_by_id: 0`
- `order_ship_cost: 0`

So a re-shipped order doesn't retain stale tracking from the previous ship.

### Forensics

`order_status_audit.shipping_fields_json` captures the full payload that was written. Useful when diagnosing "why does this Sytist row have these specific values?"

---

## 33. Scheduler auto-syncs SS → Sytist (Phase 32)

`schedulerService` runs `pollShipStation()` every 5 minutes. For each link in `shipstation_links` that's not yet `shipped`:
1. Query SS for current status
2. On `shipped`: call `orderStatusService.shipOrder({ force: true, source: 'shipstation_auto' })`
3. Local link's `ss_order_status` rolled back if Sytist write fails (so next poll retries)

### Configuration

Currently hardcoded to 300000ms (5 min). To change: edit `POLL_INTERVAL_MS` in `server/services/schedulerService.js`. A Settings UI for this is a planned follow-up.

### Disabling

Set `autoShipStation: false` in `processing-settings.json` to disable auto-create. The poller still runs and still auto-syncs already-linked orders.

To fully disable the scheduler, comment out the `schedulerService.start()` call in `server/index.js` and restart.

### Logs to watch

```
[Scheduler] ShipStation polling started (every 300000ms)
[Scheduler] Order 110685 marked shipped: stamps_com (no tracking)
[SytistDB] updateOrderStatus (with shipping): order 110685: 40 → 39, ...
[Scheduler] Order 110685 synced to Sytist: status 40 → 39
[Scheduler] Poll complete: 1 order(s) marked shipped, 1 synced to Sytist
```

If you see `[Scheduler] sytistFailed=N` repeatedly, the Sytist DB connection is broken or strict mode is rejecting writes — check `[SytistDB]` log lines for the actual error.

---

## 34. ShipStation coexistence with upstream tools (Phase 33)

### The phantom-order problem

If something OTHER than the dashboard creates a ShipStation order with the same `orderNumber`, the dashboard's `_tryCreateShipStation` step finds it via `listOrders` and would normally overwrite our packaging fields. Phase 33 changes the behavior:

- **PATH=adopt_existing**: SS order found → create local link, DON'T push packaging
- **PATH=fresh_create**: no SS order → create fresh with our packaging

This lets the dashboard coexist with the upstream tool, identified during Phase 47 hotfix 2 diagnosis (2026-05-14) as Kirsten's processing tool. It writes to Sytist directly (ms_notes signed `"Kirsten"` with body `"Order Has been changed to Printing and Production"`, distinct from our `"Sytist Dashboard: Order processed..."`) and creates SS orders outside our pipeline — ~546 of 555 recent composite-mapped orders flowed through it, not us.

### Identifying which tool processed an order

The ms_notes signature is authoritative. Query Sytist directly to see which path an order took:

```sql
SELECT note_who, note_body, note_date
FROM ms_notes
WHERE order_id = <id>
  AND note_body LIKE '%Printing and Production%'
ORDER BY note_date DESC;
```

- `note_who = "Kirsten"` with `note_body = "Order Has been changed to Printing and Production"` → processed by Kirsten's tool
- `note_body LIKE 'Sytist Dashboard: Order processed%'` → processed by our dashboard

The SS Selling Channels view (`Settings → Selling Channels`) is **not** the right place to look — Kirsten's tool isn't a connected SS store; it creates orders via a separate path that doesn't show up under Selling Channels. Earlier versions of this doc suggested checking there; that was a dead lead.

### What to do about the dual-path situation

There's nothing operational to fix — Phase 33's "adopt without push" already handles the SS-side coexistence safely. The open question is workflow-side: should we fold Kirsten's orders into our composite/audit/packaging pipeline (so all production traffic benefits from S3 thumbnails, audit notes, packaging logic), or accept that our dashboard adds value only for the ~2% that flow through us? Planning conversation, not code change.

### Manual override: "Push packaging to ShipStation"

Operators can opt to push our packaging onto an already-adopted SS order:
- Button on the Shipping card → `POST /api/sytist/orders/:orderId/push-packaging`
- Returns `packageCodeDrift: true` if SS reassigned the code (informational)
- Writes an activity-log entry

Extensive `[SS]`-tagged logging through this flow:
```
[SS] 110685: _tryCreateShipStation entered
[SS] 110685: payload built — weight=Ng, dims=NxNxN, carrier=X/Y, package=Z
[SS] 110685: calling listOrders to check for phantom
[SS] 110685: listOrders returned 1 match(es)
[SS] 110685: PATH=adopt_existing — SS#X already has this orderNumber, adopting WITHOUT pushing packaging (Phase 33 default)
[SS] 110685: link row created for adopted SS#X
```

---

## 35. Reprint workflow (Phase 35)

### When the Process button becomes Reprint

`order.productionStatus.id === 39` OR `=== 40` → button label = "Reprint this order" (orange).

### What reprint does (and doesn't)

| Action | Reprint behavior |
|---|---|
| Output files | Filenames suffixed `_REPRINT[_N]` |
| Sytist status | UNTOUCHED |
| ShipStation | SKIPPED entirely |
| Packing slip (full reprint) | Generated with `_REPRINT` suffix |
| Packing slip (per-item) | NOT generated |
| Audit | `order_status_audit` row with `source='reprint'` |
| Activity log | `[Dashboard] Order reprinted as REPRINT_N` |

### Numbering

`_nextReprintNumber(order)` scans the output dir for files matching `${orderNum}_REPRINT*` and parses the numeric suffix. Returns next available N.

- 1st reprint: `_REPRINT` (no number)
- 2nd: `_REPRINT_2`
- 3rd: `_REPRINT_3`

### Per-item reprint endpoint

`POST /api/sytist/process/order/:orderId/reprint-item/:cartId`
Body: `{ reason?: string }`

Validates cartId exists, then calls `processOrder({ reprint: true, lineItemFilter: [cartId] })`. Returns full result with paths to new files.

### Edge cases

- If `_nextReprintNumber` can't read the output dir (doesn't exist yet, permission issue), defaults to 1
- Specialty reprints land in the specialty subfolder with the same `_REPRINT` suffix; numbering is per-folder, not global
- Per-team reprints (ship_to_managers / ship_to_league orders) get `_TeamName_REPRINT[_N]` suffix
- Double-click protection: `_nextReprintNumber` always finds the highest existing N + 1, so back-to-back clicks produce numbered files rather than overwrites

---

## 36. ms_notes integration (Phase 36)

### Sytist write allow-list extended

In addition to status + 5 shipping columns on `ms_orders`, the dashboard now also writes:
- **INSERT** into `ms_notes` (append new rows; never UPDATE existing)
- **UPDATE** on `ms_notes` for soft-delete only (`note_delete=1`, `note_edited`, `note_edited_who`)

### When the dashboard writes a row

| Trigger | note_who | note_admin | note_is_note | note_log | Body |
|---|---|---|---|---|---|
| Process (fresh) | logged-in user's display_name | 1 | 0 | 1 | `[Dashboard] Order processed (N items) — status → 40` |
| Reprint (full) | display_name | 1 | 0 | 1 | `[Dashboard] Order reprinted as REPRINT_N` |
| Reprint (item) | display_name | 1 | 0 | 1 | `[Dashboard] Item "Product Name" reprinted as REPRINT_N` |
| Mark Shipped (manual) | display_name | 1 | 0 | 1 | `[Dashboard] Order Has been changed to Shipped — Tracking: ..., Carrier: ..., Cost: $...` |
| Mark Shipped (scheduler) | `sytist-dashboard` | 1 | 0 | 1 | Same + `(auto-detected from ShipStation)` |
| Mark Back to Printing | display_name | 1 | 0 | 1 | `[Dashboard] Order Has been changed to Printing` |
| Push Packaging | display_name | 1 | 0 | 1 | `[Dashboard] Packaging pushed to ShipStation — ...` |
| Manual operator note | display_name | 1 | **1** | **0** | (whatever operator typed) |

### Endpoints

- `GET /api/sytist/orders/:orderId/notes` — list non-deleted rows
- `POST /api/sytist/orders/:orderId/notes` — add manual note
- `DELETE /api/sytist/orders/:orderId/notes/:noteId` — soft delete

### Authorization for delete

- Admins: any manual note
- Non-admins: only their own manual notes (matched on display_name)
- Nobody: system log entries (`type='log'`)

### Failure mode

ALL `insertNote` calls in upstream code are wrapped in try/catch:

```js
try {
  await sytistDb.insertNote({ ... });
} catch (noteErr) {
  console.warn(`[orderStatusService] ms_notes insert failed for ship of ${orderId}: ${noteErr.message}`);
}
```

A notes failure never undoes the action. The SQLite `order_status_audit` table remains the authoritative audit trail.

### MySQL strict mode gotcha

The schema's column default for `note_edited` is `'0000-00-00 00:00:00'`. MySQL strict mode (`NO_ZERO_DATE` or `NO_ZERO_IN_DATE` in sql_mode) rejects this literal on INSERT — even though it matches the column default — when you explicitly list the column in the INSERT list.

The Phase 36 hotfix solution: **don't list those columns in the INSERT statement.** Let MySQL apply the schema defaults:

```sql
INSERT INTO ms_notes
  (note_date, note_table, note_table_id, note_note,
   note_who, note_ip, note_admin, note_is_note, note_log)
VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
```

`note_edited`, `note_edited_who`, `note_delete`, `note_data` all fall back to defaults.

### Order Activity card

Renders between Customer/Admin Notes and Output Paths on the order detail page. Reads via the GET endpoint, lists notes newest-first with Note/Log badges. Auto-refreshes via window event `sytist:activity-changed` dispatched by every action handler.

Operator-facing text input at the top for adding manual notes. Delete button on each manual note (server enforces authorization).

---

## 37. Photo + background download links (Phase 37)

Small UX addition: the line item card's photo filename text is now a download link (`<a download href={photo.fullUrl}>`). For green-screen items, the background photo filename also appears as a download link with the prefix "Background:".

Both open in a new tab. Useful for inspecting source files, sending to support, or troubleshooting composite issues.

No server-side changes — just leveraging the URLs the data layer already exposed.

---

## 38. Packaging filter (Phase 38)

The ShipStation payload builder now silently filters out any line item whose SKU isn't in the dashboard's `productWeights` map (Settings → Packaging). This prevents:
- Items defaulting to 0 oz in the SS weight calculation
- Unrecognized SKUs cluttering the SS UI as shippable

**Operational implication**: keep `productWeights` current. If a SKU is shippable but missing from the table, ShipStation won't see it at all. The dashboard's `[Packaging Trace]` log line shows which items were filtered.

## 39. Dashboard-driven package expansion (Phase 39)

Sytist's `ms_cart.cart_package` flag is unreliable for our use case — package parents are stored with `cart_package=0` more often than not. The dashboard stopped trusting that field and now expands packages purely based on the Settings → Packages config.

What changed admin-wise:
- The previously-shown "package detected via dashboard config" banner on the order detail page was removed (Phase 39 hotfix 1) because the condition is now universal
- A constituent's `flags.download` is now determined by the constituent's own SKU, NOT the parent's (Phase 43 hotfix 1). Silver Packages previously showed "Includes Download" on every constituent — that's fixed
- The order activity log will show per-cart expansion lines like `[SytistDB] cart {N} sku={X}: Sytist's cart_package=0 but SKU is configured as a package in dashboard settings`

**No admin action required.** This works automatically as long as the Settings → Packages config is current.

## 40. Per-order overrides during Process/Reprint (Phase 40, delivered in Phase 52)

Phase 11 added the override editor (Settings-style page per (orderId, cartId)). Phase 40 was *supposed* to make those overrides take effect during normal Process/Reprint — but **only the UI shipped in Phase 40; the pipeline wiring was not delivered until Phase 52.** Between Phase 40 and Phase 52, a saved override only took effect if the operator used the editor's **Apply (Overwrite/Reprint)** button; clicking the order's normal **Process** silently rendered the SKU-mapped layout and ignored the override. As of **Phase 52** the behavior below is real:
- Process and Reprint check the saved override (batch-loaded per order) before falling through to the SKU mapping; the override's snapshot is used wholesale, including the variant the operator edited
- Override editor page has a "Save (no render)" button alongside "Save and render" — stages the override; **now** the next normal Process picks it up (pre-Phase-52 it did not)
- The `subResult.composites[].layoutSource` field shows `'override'` or `'mapping'` so operators (and logs) can see which path was taken

## 41–44. Composed/composite thumbnail pipeline

This is a major addition that spans four phases. The motivation: ShipStation and the packing slip historically showed the customer's raw subject photo (often a keyed-out PNG for green-screen items, or a plain product photo for composite-layout items). Operators packing orders wanted to see what would actually print.

### Phase 41 — imageUrl field in ShipStation

`shipstationService.buildOrderFromSytist` now adds an `imageUrl` to each item in the SS payload. ShipStation V1 accepts a public URL and shows the image as a thumbnail in its UI. Phase 41 establishes the plumbing; the URL is empty until Phase 42 fills it.

### Phase 42 — AWS S3 backend setup

To populate `imageUrl`, the dashboard needs to publish composed images to a public URL. Phase 42 adds a pluggable backend system.

**Configuration (Settings → API Keys → AWS S3)**:

| Field | Notes |
|---|---|
| Region | `us-east-1` (or wherever the bucket lives) |
| Bucket | e.g. `sportsline-sytist-thumbnails` |
| Public URL base | e.g. `https://{bucket}.s3.{region}.amazonaws.com` |
| Key prefix | `sytist-dashboard-composed/` (don't omit the trailing slash) |
| Access Key ID | IAM user with `s3:PutObject` + `s3:PutObjectAcl` on the prefix |
| Secret Access Key | (paired with above) |
| ACL Enabled | True if the bucket has ACLs enabled; uploads will be `public-read` |

**AWS setup walkthrough** (one-time, ~10 minutes):

1. Create the bucket in S3 console (e.g. `sportsline-sytist-thumbnails`, region `us-east-1`)
2. Enable ACLs: Object Ownership → "Object writer" or "Bucket owner preferred"
3. Block Public Access settings: turn OFF all four blocks and acknowledge the warning
4. Add a bucket policy granting `s3:GetObject` to `Principal: *` on the prefix:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::sportsline-sytist-thumbnails/sytist-dashboard-composed/*"
       }
     ]
   }
   ```
5. Create an IAM user (e.g. `sytist-dashboard`) with an inline policy granting `s3:PutObject`, `s3:PutObjectAcl`, `s3:DeleteObject` on the prefix and `s3:ListBucket` on the bucket
6. Generate access keys for the IAM user, paste into dashboard Settings → API Keys → AWS S3
7. Set the backend in `appSettings.composedThumbnailBackend` to `s3-sytist` (Settings UI may also expose this)
8. Run `npm install` in `server/` to ensure `@aws-sdk/client-s3` is present
9. Restart the server (Ctrl+C and `npm run dev`)

**Verifying it works**: process a green-screen order and watch the server log for `[s3Sytist] Published composed thumbnail for order N cart C → https://...`. The URL should open in a browser and show the composed image.

### Phase 43 — Persistent cache + ShipStation resilience

A new SQLite table `composed_thumbnails` (in `server/config/sytist-dashboard.db`) keeps a per-`(order_id, cart_id)` map of published URLs. This makes the URL available to downstream code paths (Push Packaging, slip preview, the new UI fetch) without re-running Step 1.4 on each request.

ShipStation interactions also got more resilient:
- `orderDate` field in the SS payload converted to ISO 8601 (was sometimes failing on mysql2's `"YYYY-MM-DD HH:MM:SS"` format)
- The "Send to ShipStation" button (route: `POST /api/shipstation/orders/:id/create`) now detects when SS rejects with a 404+empty-body response and offers a one-click retry with a modified orderKey suffix. SS appears to maintain an internal tombstone for recently-deleted orderKeys; the suffix sidesteps the conflict. The retry preserves the original Sytist order_id in our records — only ShipStation sees the modified key.
- Similar logic in Push Packaging
- Enhanced server-side logging on SS 404s: response headers, byte length, payload sample. Useful for diagnosing ShipStation behavior changes.

### Phase 44 — Composite engine output everywhere

Composite-layout products (Memory Mate, Photo Button, 2 Large Magnets, etc.) now ALSO publish their composite-engine output to the thumbnail backend. The same SQLite cache stores the URL, and three destinations consume it:

- **ShipStation** (via the existing imageUrl chain)
- **Packing slip** (via a 4-tier thumbnail resolver — local file preferred during processOrder, URL fetched as fallback for slip preview routes)
- **Dashboard order detail page** (via the new `GET /api/sytist/orders/:id/composed-thumbnails` endpoint)

**Storage lifecycle (Phase 44 hotfix 2)**: cache rows and S3 objects persist indefinitely. Auto-cleanup was originally tied to the scheduler's "order shipped" detection but was removed because some orders auto-ship in SS within the same poll cycle as creation, wiping the cache before operators could view it. At our scale storage cost is trivial (~$0.001/year/object); add a separate sweep job later if it ever matters.

**Verification queries** (PowerShell, from `server/` directory):

```powershell
# How many rows are in the cache?
node -e "const db = require('better-sqlite3')('./config/sytist-dashboard.db'); console.log(db.prepare('SELECT COUNT(*) AS n FROM composed_thumbnails').get());"

# Most recent 10 rows
node -e "const db = require('better-sqlite3')('./config/sytist-dashboard.db'); console.log(db.prepare('SELECT order_id, cart_id, backend, datetime(created_at) AS created FROM composed_thumbnails ORDER BY created_at DESC LIMIT 10').all());"

# Rows for a specific order
node -e "const orderId = process.argv[1]; const db = require('better-sqlite3')('./config/sytist-dashboard.db'); console.log(db.prepare('SELECT cart_id, backend, public_url FROM composed_thumbnails WHERE order_id = ?').all(orderId));" 110823

# Manually clear cache rows for an order (if URLs go stale)
node -e "const orderId = process.argv[1]; const db = require('better-sqlite3')('./config/sytist-dashboard.db'); const r = db.prepare('DELETE FROM composed_thumbnails WHERE order_id = ?').run(orderId); console.log('deleted:', r.changes);" 110823
```

### Backward compatibility

Orders processed before Phase 42 deployed have no cache entries. The dashboard order detail page and slip preview will fall back to the pre-Phase-44 rendering (bg+player stack for green-screen, raw photo for others). Re-processing or reprinting any such order will populate the cache and the composite thumbnails will appear from then on.

---

## Troubleshooting (Phase 17–37 additions)

### "Reprint is producing slip when it shouldn't (single-item reprint)"

Phase 35 hotfix issue. Verify your processingService.js has the fix: `_processSubOrder` should receive `lineItemFilter` via its options. Grep:
```
grep -n "lineItemFilter" server/services/processingService.js
```
Should appear in both the function signature and the `skipSlip` check (around line 1530).

### "ms_notes insert failed: Incorrect datetime value"

MySQL strict mode + zero-date literal. Phase 36 hotfix removes the offending column from the INSERT list. Verify:
```
grep "note_edited" server/services/sytistDbService.js
```
Should appear only in the schema comments, NOT in the INSERT statement's column list.

### "Reprint produces _REPRINT but operator wanted REPRINT_2"

`_nextReprintNumber` scans the output dir for existing files. If you cleaned up `_REPRINT` files manually before the next reprint, the function legitimately returns 1 again. Either leave old reprint files in place, or rename them to keep the sequence.

### "Scheduler isn't auto-flipping Sytist status"

Sequence of things to check:
1. Server log: are `[Scheduler]` lines appearing every 5 minutes?
2. Is there a SS link for the order in `shipstation_links`?
3. Does SS show the order as `shipped`?
4. Is `autoShipStation` enabled in settings?
5. Check `order_status_audit` for entries with `source='shipstation_auto'` — none means the scheduler never even tried

### "Push Packaging button returns packageCodeDrift"

ShipStation reassigned the package code based on its own rules (often weight thresholds). The order IS in SS with the code SS chose. If that code is wrong, edit the SS order directly in the SS UI.

### "Order Activity card is empty"

Hit the endpoint directly to see if it's a UI problem or data problem:
```
curl -b <session-cookie> http://localhost:3011/api/sytist/orders/110685/notes
```
- Returns empty `notes: []` → no notes exist for that order yet; trigger an action to write one
- Returns 500 with error → MySQL connection or schema issue
- Returns 401 → session expired, log in again

### "Activity card doesn't refresh after actions"

Check the browser console for the CustomEvent:
```js
window.addEventListener('sytist:activity-changed', e => console.log('event:', e.detail));
```
Then click Process. If the event doesn't fire, the action handler isn't dispatching. If it fires but the card doesn't refresh, the listener wiring is broken — check OrderDetailPage.js for the eventRefreshKey state.

### "[s3Sytist] @aws-sdk/client-s3 not available: Cannot find module"

The AWS SDK isn't installed. Run:
```
cd C:\Users\Sportsline\Downloads\sytist-dashboard\sytist-dashboard\server
npm install
```
Then restart the server (Ctrl+C, `npm run dev`). nodemon doesn't reliably pick up newly-installed modules — a full restart is required.

To verify the SDK loads:
```
node -e "console.log(require('@aws-sdk/client-s3').S3Client.name)"
```
Should print `S3Client`.

### "Composite thumbnails not showing in the dashboard order detail page"

The line item card pulls URLs from the composed_thumbnails cache. If the cache is empty for the order, the card falls back to its previous render (bg+player stack for green-screen, raw photo otherwise).

Diagnose:
1. Open browser DevTools → Network tab → filter "composed-thumbnails"
2. Refresh the page; you should see a request to `/api/sytist/orders/{id}/composed-thumbnails`
3. Check the Response tab — if `thumbnails: {}`, the cache has no rows for this order
4. Reprint the order; the cache populates during processOrder and the page reload should show composites

If the response has thumbnails but the UI still doesn't show them, the Phase 44 client code may not be deployed:
```
Select-String -Path "client\src\pages\OrderDetailPage.js" -Pattern "composed-thumbnails" -SimpleMatch
```
Should return 1 match.

### "Slip preview shows raw photos instead of composite thumbnails"

The slip preview route reads the composed_thumbnails cache (Phase 44 hotfix 1). Check that the route updates are deployed:
```
Select-String -Path "server\routes\sytist.js" -Pattern "_loadCompositeUrlsForOrder" -SimpleMatch
```
Should return 4 matches (one definition + three call sites).

If 0 matches, hotfix 1 wasn't extracted. Re-extract:
```
tar -xzvf F:\Downloads\sytist-dashboard-phase-44-hotfix1.tar.gz --strip-components=1
```

### "ShipStation rejected with 404 for an order I never sent before"

ShipStation's V1 API maintains a tombstone on recently-deleted orderKeys. If you (or any other tool) previously created and deleted an SS order with a given orderNumber, recreating it can fail with 404 and empty body.

The "Send to ShipStation" button (and Push Packaging) detect this and offer a one-click retry with a modified orderKey suffix. If you see the popup `"ShipStation rejected this order, likely because orderNumber X was previously deleted in ShipStation. Retry with modified orderNumber X-r{timestamp}?"`, click OK. The dashboard's link will record the modified key but our internal references continue to use the original Sytist order_id.

### "ShipStation order is shipped but I never marked it"

Unresolved issue. Some orders are showing as `shipped` in SS within seconds of creation, without a tracking number. Likely cause: an SS account workflow rule or selling channel that auto-completes orders matching certain criteria.

Not blocking after Phase 44 hotfix 2 — the composed thumbnail cache survives regardless. But worth investigating in the SS account settings if you want to understand it.

To inspect a specific order's state in SS via API:
```powershell
$key = "<your_ss_api_key>"
$secret = "<your_ss_api_secret>"
$auth = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${key}:${secret}"))
$r = Invoke-RestMethod -Uri "https://ssapi.shipstation.com/orders?orderNumber=110823&pageSize=50" -Headers @{Authorization="Basic $auth"}
foreach ($o in $r.orders) {
  Write-Host "orderId=$($o.orderId) status=$($o.orderStatus) modifyDate=$($o.modifyDate) shipDate=$($o.shipDate) tracking=$($o.trackingNumber)"
}
```

---

## Phase-numbered reference

For a phase-by-phase summary of what shipped when, see `CHANGELOG.md`.

For deeper architecture notes, see `SPEC.md` (sections 21–44 cover Phase 17 onward).
