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
