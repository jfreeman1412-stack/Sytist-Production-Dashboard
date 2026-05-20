# Sytist Production Dashboard — CLAUDE.md

This file is the project context for Claude Code. Read it before doing any work. The architecture details are in `docs/` (CHANGELOG, README, SPEC, OperatorManual, AdminManual); this file is the working conventions and landmines.

## What this project is

A production dashboard for Sportsline Photography. Local Node.js/Express server (`server/`) and React client (`client/`) that:

- Pulls orders from a remote Sytist MySQL database (read-only except for an explicit allow-list)
- Manages local dashboard state in SQLite at `server/config/sytist-dashboard.db`
- Generates print-ready files (composite renders, imposition sheets, packing slips, Darkroom `.txt`)
- Syncs orders to ShipStation and back
- Publishes composite/composed thumbnails to S3 so they're visible in ShipStation and the dashboard UI

The project lives at `C:\Users\Sportsline\Downloads\sytist-dashboard\sytist-dashboard\` on Joey's Windows machine. Production output files land in `Z:\Photo Day\__Open Orders\Sytist_Orders\` (a network drive).

Phase numbering reaches 44 as of writing. See `docs/CHANGELOG.md` for the full phase log.

## Critical constraints — read these every time

### Sytist write allow-list

The remote Sytist MySQL database is **read-only except** for these explicit writes. Never extend without explicit operator approval:

| Table | Allowed operation | Columns |
|---|---|---|
| `ms_orders` | UPDATE | `order_open_status`, `order_shipped_date`, `order_shipped_track`, `order_shipped_by`, `order_shipped_by_id`, `order_ship_cost` |
| `ms_notes` | INSERT, soft-DELETE | All columns per `sytistDbService.insertNote` and `softDeleteNote` |

**Never** touch schemas, indexes, or other `ms_*` tables. Never add new write paths without flagging it explicitly. Phase 30 set this scope; it has held since.

### Sytist data quirks

- **`ms_cart.cart_package` is unreliable**. Package parents routinely store with `cart_package=0`. The dashboard uses `Settings → Packages` config as authoritative; expansion happens in `sytistDbService.getOrderById`. Don't add logic that depends on the Sytist flag (Phase 39).
- **DATETIME from `mysql2` comes back as `"YYYY-MM-DD HH:MM:SS"` (space, not T)**. ShipStation V1 sometimes rejects this; always convert to ISO 8601 with `new Date(value).toISOString()` before sending (Phase 43).
- **`order_id` is an integer**. Don't quote it as a string in SQL.
- **Status IDs** in `ms_orders.order_open_status`: 0 = Open / queue, 40 = Printing/Production, 39 = Shipped.

### Composite/composed thumbnails

The pipeline has a single source of truth: the `composed_thumbnails` SQLite table, keyed by `(order_id, cart_id)`. Three destinations read from it: ShipStation payload, packing slip, dashboard order detail page.

- Cache rows and S3 objects **persist indefinitely** (Phase 44 hotfix 2). Do NOT add auto-cleanup to the scheduler — it races operator visibility. A separate sweep job is fine if storage ever matters.
- Backend is pluggable: `composedThumbnailService.publish(orderId, cartId, buffer)` returns a public URL or null. Default backend `skip` is a no-op. Production backend `s3-sytist` uploads to AWS S3.
- Both green-screen compose AND composite-engine render publish to this same backend.

### ShipStation oddities

- A `404` with empty body from `POST /orders/createorder` typically means the orderKey is tombstoned (previously deleted). Retry with a modified orderKey suffix like `-r{timestamp}`. Phase 43 has this logic; don't recreate it inline (use the helper).
- Some orders show as `shipped` in SS within seconds of creation, with no tracking number. Cause not yet diagnosed. Don't auto-clean the cache on shipped detection (see above).
- ShipStation may reassign `packageCode` based on its own rules. The dashboard surfaces this as a "drift" warning, not an error.
- **Package weights are FLOORED to whole oz (min 1) before SS gets them** (Phase 58, universal across packages and carriers). USPS gives a 1oz grace per package, so 8.7oz labelled 8oz is safe and saves a rate tier. The floor lives in `packagingService._buildResult` (both normal + fallback paths) and is idempotently re-applied in `shipstationService` at the order-level weight resolution (so operator overrides + the no-engine `defaultWeightOz` fallback are also floored). The packaging engine's "roll remainder onto first non-digital line item" mechanism (so `Σ items = order weight`, what SS bills) handles BOTH signs — under floor the remainder is negative — and clamps the absorbing item ≥1oz. Log line is `Floor rounding: -X.X oz` (sign-carrying via the `roundingDeltaOz` field); the old `Ceiling rounding: +X oz` / `preCeilingOz` / `ceilingRemainderOz` labels were renamed for honesty. **Phase 58 hotfix 2 (important):** the SS payload now sends `units: 'ounces'` integer for BOTH order-level AND per-item (via `distributeIntegerOzAcrossLines` which splits the whole-oz floor across physical lines as integers summing to it exactly). The previous `OZ_TO_G = 28.3495` grams conversion + the `units: 'grams'` payload is GONE — the oz↔g round-trip was lossy for every 1–16 whole-oz value (no integer gram reverses to exactly N.00 oz under any rounding mode), causing whole-oz floors to land in the wrong rate tier. **Don't reintroduce grams here.** Per-item distribution: digital / zero-weight lines stay at 0 and are never the absorber; first physical line is the absorber. `qty > 1` lines are the only imperfect case (per-unit ceils when `lineIntegerOz / qty` isn't integer, bounded overshoot ≤ qty−1 oz; `console.warn` fires so production frequency can be quantified). See SPEC §58 hotfix 2 for the full diagnosis.

### SS eligibility filter — three layered skip reasons

The line-item filter in `shipstationService.buildOrderFromSytist` skips an item if any of these match. Same three checks are mirrored in `previewPackagingForOrder` and `routes/shipstation.js _computeEligibility`. **Keep all three in sync** when adding new skip reasons:

1. **`SKIP_FLAGS` on the line item's `flags`**: `['download', 'giftCert', 'creditProduct', 'booking', 'preSell']`. Driven by Sytist `ms_cart` columns (`cart_download`, `cart_gift_certificate`, etc.) populated in `sytistDbService.getOrderById`.
2. **`specialtyService.isDropShipped(li.sku)`**: per-SKU lookup against `specialty-products.json` `dropShipped: true` entries. There is no `flags.dropShip` — drop-ship is a config-driven SKU check, not a line-item flag.
3. **`packagingService.isDigital(li.sku)`** (Phase 45): per-SKU lookup against `packaging-config.json` `productWeights[sku].category === 'digital'`. Case-tolerant (uppercase first, raw fallback). Added because Sytist sets `cart_download = 0` on digital-package SKUs like 3D / 5D / 20D, so `flags.download` misses them. Affected ~256 historical orders. Real bug case: order 111042.

If you ever see a "digital" or "non-shippable" SKU bypass the filter, the fix is usually a missing `packaging-config.json` entry rather than a code change. Add the SKU with `category: 'digital'` (uppercased key) and the next process call picks it up — `packagingService.getConfig` reads from disk each call, no restart needed.

### Output path configuration

There are **two independent operator-configurable output roots**, sourced from different config files and resolved by different services. They do **not** cascade — changing one does not move the other.

| Output | Operator control | Config file / key | Resolved by |
|---|---|---|---|
| Regular pipeline (download, darkroom `.txt`, packing slip, imposition) | Settings → Paths → *mode* templates | `path-overrides.json` → `downloadBase` (per active `mode`) | `pathsService.resolveFullPath` / `resolveBase` at runtime |
| Specialty products (per-SKU routing) | Settings → Specialty → Base path | `specialty-products.json` → `basePath` | `specialtyService.getBasePath()`; blank → fallback `downloadBase\Specialty` |

Do **not** describe a specific drive (`Z:\Photo Day\…`, `Z:\Sytist\…`) as a code fact — those are current operator settings, not invariants. The invariant is the *mechanism*: two knobs, two files, no linkage. The production setup at time of writing deliberately points them at different drive roots (specialty on its own root for lab-bin / drop-ship separation). The blank-`basePath` fallback (`downloadBase\Specialty`) is the *designed default*; an explicit `basePath` is a deliberate operator override, not an accident — do not "fix" the divergence by deriving one from the other without operator sign-off.

Soft-failure note: if the specialty root is unreachable at process time, the raw specialty download fails into `subResult.photosFailed` and processing continues (`processingService.js` ~L1143-1158). As of Phase 55 this is **no longer silent** — a failed specialty (or regular) download now emits a `console.warn` (`[Processing] … photo download FAILED`, flagged `(SPECIALTY)`), and a failed `mkdir` warns too instead of being swallowed by an empty catch. Still also recorded in `subResult.photosFailed` for the result UI. A "missing specialty file" is most likely a stale `specialty-products.json` `basePath`, an unmounted share, or — before Phase 55 — an illegal Windows path char in the `subfolder` (e.g. SKU 29 `12" Wall Cling`; Phase 55's `specialtyService.sanitizePathSegment` strips the reserved set `<>:"/\|?*` at the path-construction use-point, so the *stored* config can still contain them while the *directory* is safe). Check the configured `basePath` and the server log before assuming data loss (order 111297 was a false alarm — files were at the deliberately-separate specialty root; order 110924 was this illegal-char bug — no file was ever written).

### The Darkroom .txt is the authoritative print manifest (Phase 57)

The Darkroom `.txt` is the **authoritative list of what gets printed** for the regular pipeline. After processing, an order's **regular** output folder contains exactly: the `.txt` file(s), the packing slip(s), the team divider(s), and the files referenced by the `.txt`'s `Filepath=` lines — **nothing else for that order**. Any intermediate or staging artifact not referenced by a `.txt` (raw green-screen subject left after `_composed`, the raw subject left after a non-chain `_composite_<layout>.jpg`, the chain-SKU `_composite_<layout>.jpg` intermediate, crashed-write `*.tmp`) is pollution and is removed by `processingService._cleanupOrphanOutputs`, the **final step of `processOrder`** (runs once per order, only when every sub-order succeeded — a failed sub-order's files are left for inspection/retry).

Invariants the cleanup must keep (don't weaken any of these):

- **Specialty is a separate pipeline/folder and is never touched.** Specialty items route to `specialtyService` `basePath`\subfolder with their own `…_specialty.txt`; the cleanup reads **only** the regular `downloadDir` (non-recursive, files only), bails if that dir resolves under `specialtyBase`, and carves out `*_specialty.txt` / recorded specialty paths. A mixed order (regular + specialty) is fine — the two never co-mingle.
- **Order-scoped.** A file is in scope iff its basename is `<orderNumber>.txt` or starts with `<orderNumber>_` (trailing `_`/`.` boundary stops order 110 matching `1100_…`). Folder-sort can co-mingle multiple orders in one dir; other orders are never touched.
- **Referenced set = UNION of `Filepath=` basenames across EVERY `<orderNumber>*.txt` in the dir** — original + reprints + per-team ship_to_league chunks — never just the latest. This is what stops a reprint or a multi-team batch from deleting another batch's outputs (and respects the "never delete reprint files between reprints" landmine).
- **Case-insensitive, basename-only comparison.** Only lowercased basenames are ever compared, never raw/absolute paths — separator/case differences between a `Filepath=` value and the on-disk name must not cause a false "unreferenced".
- **Explicit carve-outs even when also referenced** (belt-and-braces): the `.txt` manifests, packing slips (`_packing_slip`), team dividers (`_DIVIDER_` — these are *not* in any `.txt` and are not order-number-prefixed, so they are doubly safe).
- **Non-fatal.** Printing already succeeded before cleanup runs; any failure (unreadable dir, unlink error) → `console.warn` and continue. An unreadable manifest → skip cleanup entirely (never delete against an incomplete referenced set). Cleanup logs `removed N orphan file(s): [list]` or `no orphan files` per order for operator visibility.

## Repo layout

```
sytist-dashboard/
├── server/
│   ├── index.js                          # Express entry
│   ├── routes/
│   │   ├── sytist.js                     # The big one — order ops, packing slips, processing, push-packaging
│   │   ├── shipstation.js                # SS-specific routes (create, status, refresh)
│   │   └── ...                           # auth, settings, gallery-assets, etc.
│   ├── services/
│   │   ├── processingService.js          # Process/Reprint orchestration (the heaviest file)
│   │   ├── sytistDbService.js            # MySQL reads + the narrow write allow-list
│   │   ├── shipstationService.js         # SS V1 API client + payload builder
│   │   ├── packingSlipService.js         # Slip JPG generator (5x8 @ 300 DPI)
│   │   ├── impositionService.js          # Print sheet layouts
│   │   ├── compositeService.js           # Memory Mate / Photo Button / etc renderer
│   │   ├── greenscreenService.js         # Subject + background compositor
│   │   ├── composedThumbnailService.js   # Pluggable backend entrypoint (Phase 42)
│   │   ├── composedThumbnailCacheService.js  # SQLite cache (Phase 43)
│   │   ├── thumbnailBackends/
│   │   │   ├── skip.js                   # No-op (default)
│   │   │   └── s3Sytist.js               # AWS S3 publisher
│   │   ├── schedulerService.js           # 5-min polling: SS shipped → Sytist sync
│   │   ├── orderStatusService.js         # Manual ship/unship + audit
│   │   ├── orderOverrideService.js       # Per-(orderId, cartId) composite layout overrides
│   │   └── ...
│   └── config/
│       ├── sytist-dashboard.db           # SQLite — auth, sessions, links, audit, overrides, thumbnails cache
│       ├── packaging-config.json
│       ├── composite-mappings.json
│       ├── imposition-layouts.json
│       ├── app-settings.json             # Includes aws_s3 section
│       └── ...
├── client/
│   └── src/
│       ├── pages/
│       │   ├── OrderDetailPage.js        # Biggest file by far (~5500 lines)
│       │   ├── OrdersListPage.js
│       │   ├── OverrideEditorPage.js
│       │   └── settings/                 # Per-section settings pages
│       └── services/
│           └── api.js                    # Fetch wrapper; attaches err.data on failures
└── docs/                                 # Read these for architecture context
    ├── README.md
    ├── CHANGELOG.md
    ├── SPEC.md
    ├── OperatorManual.md
    └── AdminManual.md
```

## Working conventions

### Code style

- Mostly vanilla JavaScript (Node + React). No TypeScript. No build step on the server side beyond what `npm install` produces. Client uses Create React App.
- Functions are written long-form, not concise. Comments explain *why*, not *what*.
- Prefer early returns + flat conditionals over nested if/else.
- Two-space indentation throughout.
- Single quotes for strings except in JSON and SQL.
- Backticks for template literals and multi-line.
- No semicolons missing — they're always there.

### Service boundaries

- **Routes are thin**: parse input, call a service, return JSON. No business logic in route handlers.
- **Services own state**: cache reads/writes, database calls, external API calls all live in services.
- **Failure modes for audit-style writes are non-blocking**: `ms_notes`, `order_status_audit`, thumbnail cache upserts. The action succeeds even if the audit write fails. The operator just doesn't see the side-effect entry.
- **Override-feature verification must test BOTH the editor's Apply paths AND normal Process picking up Save-(no-render) overrides.** The two render paths are independent and one can silently regress — Phase 40 shipped the override UI without the pipeline wiring and Process ignored every saved override for months, unnoticed. Phase 52 unified layout/variant + image-override resolution behind `overrideRenderService`; Phase 56b unified output dir/filename/reprint-N + impose-in-place behind `printOutputService`. **Keep Apply and Process on these shared helpers — never reintroduce inline produce-output logic in `renderOverrideForOrder`.** Every divergence found this way (Process ignored overrides; Apply never imposed; Apply reprint-N collided; Apply wrote order-root not the folder-sort subdir) was an Apply-vs-Process drift.
- **Verification plans must include at least one folder-sorted order AND at least one package order.** These exercise code paths that plain-integer single-photo orders don't, and have historically hidden bugs in cartId handling, output paths, and reprint numbering (Phase 56's four bugs all hid behind that gap). A green run on a simple order is not evidence the change is safe.
- **Worked examples in numerical-fix specs and offline harnesses must exercise the bug class, not coincidentally-safe values.** Phase 58 originally documented `8 oz → 227 g` as its worked example; 8 oz happens to be one of the values where `Math.round` and `Math.ceil` agree on `oz × 28.3495`. The hotfix-1 harness inherited that example and missed the actual failure mode (4 / 7 / 10 / 13 / 15 oz, where `Math.round` undershoots). When fixing a float / unit-conversion / rounding bug, the worked example AND harness cases must include values where the wrong behaviour would *measurably* produce a different output — pick a value at the edge of the bug class, not a value that's coincidentally safe under both old and new behaviour. (Phase 58 hotfix 2 added cross-checks against 4 oz and 8 oz explicitly to assert the previously-safe values still pass.)
- **`cartId` is an opaque string end-to-end — never `parseInt`/`Number` it.** Package constituents and addons have synthetic IDs (`483036-pkg-27`, `483036-addon-69516`); numeric coercion truncates them to the parent int and collapses/ misroutes everything keyed by cart. `orderId` is always a real integer (coerce that). `order_overrides.cart_id` is declared INTEGER but **bound as String** — SQLite affinity normalizes numeric strings to int (old plain-int rows still resolve) and stores synthetic IDs as TEXT; do not "fix" the column type or re-add coercion. `orderAssetOverrideService` gates cartId with `isSafeCartId` (`[A-Za-z0-9_-]`), not an integer check. (Phase 56a; pre-56 package/addon override rows are unmigratable orphans.)
- **Line items carry two product-name fields — `productName` is the IDENTIFIER, `productNameDisplay` is for RENDERING.** Sytist gives us a `>`-delimited hierarchy (`"Print Packages > Silver Package > 8x10"`); `sytistDbService` sets both fields at line-item construction time (`productNameDisplay = deriveDisplayName(productName)` → leaf-only, e.g. `"8x10"`, with empty-leaf fallback to the original string). **Match/lookup/path-construction reads `productName`** (darkroom template mapping, specialty subfolder construction, operator-edited `template-mappings.json` + `specialty-products.json`) — these must stay full-path because the stored config is full-path. **Every operator-visible render reads `productNameDisplay`** (dashboard UI, slip JPG, SS payload, ms_notes audit, imposition `{item_description}` token, packaging trace log). The field-name at the callsite tells you which it is — never call the utility manually in a new display site, just read the right field. (Phase 58c.)
- **If a SKU's composite mapping has `chainToImposition`, the printed file is the imposed sheet — Apply must impose, not stop at the composite.** `printOutputService.produceFinalOutput` handles this for Apply; Process's Step 1.5/2 still does its own. A `chainToImposition` SKU with no imposition rule yields the bare composite at the photo-derived path (parity with Process) **plus** an `imposition_rule_missing` warning (returned and `console.warn`'d) — deliberate parity-plus-warning, not a hard-fail.
- **Composite layout-level props (`sheetWidth`/`sheetHeight`/`dpi`/`backgroundColor`) resolve variant-first, root-fallback** in `compositeService.buildSheetBuffer`: `variantDef.X` if the variant owns it, else the **deprecated** `layout.X` root, else the original hardcoded default (Phase 57A — vertical/horizontal are independent designs now; the fallback makes pre-migration data and un-diverged variants byte-identical to pre-57). Root copies exist *only* as that fallback — don't read them directly for render, don't re-share them. **`graphics` is also variant-first as of Phase 57B**, but resolved at the use-sites (not in `compositeService`): the 3 render reads (`processingService.js:1562`, `routes/sytist.js:3232` preview, `routes/sytist.js:3837` Apply override) read `variantDef.graphics[key] ?? layout.graphics[key]`; the variant-agnostic preview/info stream routes use the helper `resolveGraphicMeta` (same precedence, scans all variants then root). Per-variant graphics keys are **namespaced `${variant}__<name>`** so vertical and horizontal can't collide in the shared `composite-graphics/<layoutId>/` on-disk bucket; the POST/DELETE routes require an explicit `variant` in the body and validate the prefix. **Root `graphics` is read-only fallback now — the routes never write it.** Legacy un-namespaced root entries keep rendering via fallback (don't migrate them — the per-key UI hides legacy entries from a variant's library only when the variant uploads its own same-base-name replacement).

### Cross-platform notes

The dashboard runs on Joey's Windows machine today and writes to a Windows `Z:` network drive for operator output. It will eventually move to a Linux server — keep the code portable enough that the move is a config edit, not a rewrite.

**For server-internal paths** (SQLite DB, config files, cache dirs, anything inside `server/`): use `path.join(__dirname, ...)` with `path.join` from `require('path')` — not `path.win32` or `path.posix`. Node picks the platform's native separator automatically. Never hardcode drive letters (`C:`, `Z:`) or absolute paths in code; derive from `__dirname` or read from configurable JSON.

**For operator-output paths** (where files land for the lab — `Z:\Photo Day\...` today): the path values themselves live in `server/config/path-overrides.json` and are operator-edited. The code joining base + segments should use `path.join` (uses platform-native separator) so the result is correct on whatever OS the dashboard runs on. **There is currently a portability bug here**: many call sites use `path.win32.join`, which always emits backslashes — works on Windows-to-Windows today, breaks on Linux-to-Linux. Search for `path.win32` before touching output-path logic; flag in any new code so we don't add more sites.

**Shell-outs and platform-specific binaries**: zero today. No `child_process.exec`, no `cmd.exe`/`powershell` invocations, no `.bat` scripts. Keep it that way — anything platform-specific should be a configurable command in `app-settings.json`, not a hardcoded path.

**OS detection**: not used anywhere today. If you ever need platform-specific behavior, prefer `process.platform === 'win32'` over `os.platform()` (they're equivalent but `process.platform` is more idiomatic in Node) and put the check at the lowest reasonable level.

**Photo proxy** (`/api/sytist/photo-thumb`, Phase 49 v2) is intentionally **unauthenticated** and relies on SSRF validation only (HTTPS + exact-host allowlist via `PHOTO_PROXY_ALLOWED_HOSTS` env + `redirect:'error'` + no query string/fragment/credentials + safe extension). Safe because the dashboard server is localhost-only. **If this ever moves to a public-facing deployment, replace with signed URLs (HMAC over src/width/expiry) before deploy** — see the inline comment on the route in `routes/sytist.js` and SPEC §49 for context. The `<img>`-via-session-cookie approach was tried in v1 and consistently 401'd; don't reintroduce it without solving the cookie/CORS path.

**The `Z:` references in CLAUDE.md and SPEC.md** are environment facts (what the current production setup looks like), not code facts. They stay even after a Linux migration as historical context.

### Client routing

Settings pages live under `/settings/<page>` — when navigating to the override editor, gallery assets, or any other settings page from non-settings code, include the `/settings` prefix in the URL. Unknown paths fall through to a wildcard `<Route path="*" element={<Navigate to="/" replace />} />` in `AppLayout.js`, so a missing prefix silently redirects to the dashboard home instead of erroring. Cross-check against an existing working call (e.g. `OrderOverridesPage.openEditor`) when in doubt.

### Logging conventions

The dashboard logs aggressively. Match the existing style when adding new logs:

```
[Processing] Order N cart C sku=X: ...
[SS] N: payload built — weight=Ngrams, ...
[Scheduler] Order N marked shipped: ...
[s3Sytist] Published composed thumbnail for order N cart C → https://...
[Packaging Trace] Order N
[SytistDB] cart N sku=X (name): ...
[PackingSlip] Wrote {path}
[Darkroom] Wrote {path}
[Imposition] {layoutName} → {path} ({W}x{H}px)
```

Tag with the service/area in brackets, then the order/cart context. This makes grep-ing logs feasible at scale.

### Running the dev server

From the repo root:

```cmd
npm run dev
```

Starts both server (port 3011) and client (port 3010) via `concurrently`. nodemon watches the server side. After installing new npm packages, a **full restart** (Ctrl+C, then `npm run dev`) is required — nodemon doesn't reliably reload newly-installed modules.

The browser reloads on client changes; for full state reset use **Ctrl+Shift+R** (hard refresh).

**For sessions involving real-order testing**, start the dev server with output teed to a log file so the agent can tail it. The plain `npm run dev` terminal has no log file — server stdout goes only to that interactive console, so the agent cannot follow it and is limited to log excerpts the operator pastes by hand. Instead run it so stdout+stderr land in `server.live.log` (e.g. `npm run dev *> server.live.log` in PowerShell, or pipe through `tee`), and add `server.live.log` to `.gitignore`. Set this up at the start of any session where the operator will process real orders for the agent to watch.

### Git on Windows

- The shell is CMD/PowerShell. **Single-line commit messages only** — multi-line messages don't survive the CMD quoting.
- Commit messages are descriptive: phase number, what shipped, files affected if many.
- Commits are reasonably frequent — we commit after each phase or hotfix lands and tests clean.

Example commit pattern that works:

```cmd
git add -A && git commit -m "Phase 44 hotfix 2: remove scheduler auto-cleanup; cache rows + S3 objects persist indefinitely"
```

## Common landmines (where I've stepped before)

### Stale uploads regress earlier phases

If you ever take a snapshot of a service file and use it as a base for an edit, **verify it has the most recent changes** before bundling. The Phase 43 hotfix 2 base file was missing Phase 41/42/43 changes and the resulting tarball overwrote the deployed file, regressing `imageUrl`, `composedImageUrl`, and orderDate ISO conversion. Hotfix 3 had to restore them.

Mitigation in Claude Code: this entire failure mode is gone because there's no upload/download — you edit the current file in place.

### nodemon doesn't reload after `npm install`

Always Ctrl+C and restart manually after installing packages. Otherwise the new module silently fails to load and you waste an hour debugging.

### `composed_thumbnails` cache empty after process

If processing an order doesn't populate the cache, check in order:

1. Is `composedThumbnailBackend` set to `s3-sytist` (not `skip`) in `app-settings.json`?
2. Did `@aws-sdk/client-s3` install? Run `node -e "console.log(require('@aws-sdk/client-s3').S3Client.name)"` from `server/`.
3. Did the server fully restart after install?
4. Watch the log for `[s3Sytist] Published composed thumbnail` lines. If absent, the publish never ran.
5. If publish ran but cache is empty, check for `cache upsert failed (non-fatal)` warnings.

Verify with:

```cmd
cd server
node -e "const db = require('better-sqlite3')('./config/sytist-dashboard.db'); console.log(db.prepare('SELECT order_id, cart_id, backend, datetime(created_at) AS created FROM composed_thumbnails ORDER BY created_at DESC LIMIT 10').all());"
```

### Package constituent download flags

Constituent `flags.download` is determined by the constituent's own SKU, NOT the parent's. Silver Packages previously showed "Includes Download" on every constituent because of inherited flags — Phase 43 hotfix 1 fixed this. Don't add inheritance back.

### Reprint output filenames

Reprints append `_REPRINT`, `_REPRINT_2`, `_REPRINT_3` suffixes via `_nextReprintNumber()` which scans the output directory. **Never delete reprint files between reprints** — the function relies on existing files to compute the next suffix. If files are cleaned up manually, the counter restarts and collisions become possible.

Reprints:
- Skip Sytist status updates
- Skip ShipStation auto-create
- Skip packing slip generation for single-item reprints
- Insert `order_status_audit` row with `source='reprint'`

### `Cache-Control: immutable` on mutable URLs

`Cache-Control: immutable` is wrong for any URL whose bytes can change across deploys — composite/composed thumbnails, proxied photos, anything served from a stable key. `immutable` tells the browser never to revalidate, so a hotfix that changes the underlying image leaves operators staring at the stale one with no in-app way to bust it. Use `max-age` with revalidation instead (`public, max-age=3600, stale-while-revalidate=86400`). `immutable` is only safe when the URL itself changes whenever the content does (content-hashed or signed URLs). Phase 49 lost an afternoon to this.

### Smoke-test artifacts leak into output

When running tests that touch `composite-layouts.json` or `composite-mappings.json`, they sometimes get rewritten with test data. Before bundling or committing, verify these JSON files haven't been overwritten with smoke-test fixtures.

## Architecture pointers

For deeper detail, see:

- **`docs/README.md`** — project overview, architecture highlights, roadmap
- **`docs/SPEC.md`** — per-phase design notes (sections 21–44 cover Phase 17 onward; sections 1–19 cover the bootstrap)
- **`docs/CHANGELOG.md`** — chronological summary of every phase and hotfix
- **`docs/AdminManual.md`** — Settings UI walkthrough, AWS S3 setup, troubleshooting (sections 38–44 are the most recent)
- **`docs/OperatorManual.md`** — what end users see and do

## Open follow-ups (as of Phase 52)

These aren't urgent but are worth knowing about:

- **Kirsten coexistence** — most production traffic flows through an upstream tool used by operator Kirsten, not our dashboard. As of Phase 47 hotfix 2 diagnosis (2026-05-14): **546 of 555** composite-mapped orders in the last 14 days were processed by Kirsten's tool. ms_notes signed `"Kirsten"` with body `"Order Has been changed to Printing and Production"` (vs our `"Sytist Dashboard: Order processed..."`). Our dashboard's value-adds (S3 composite cache, audit notes, ShipStation packaging logic) are only applied to the ~2% that flow through us. Phase 33's "adopt without push" already handles the SS-side coexistence; the **open question is the workflow side** — bring upstream-processed orders into our composite/audit/packaging pipeline, OR accept that we add value only for orders that come through us. Worth a real conversation with Kirsten before more code investment. Planning item, not code work. (Also resolves the long-standing "SS orders auto-shipping without tracking" mystery — it was Kirsten's tool creating SS orders that auto-fulfill via an SS workflow rule. Cosmetic noise from that flow, not a bug in ours.)
- **Photo proxy public-deployment readiness** — Phase 49 v2 is intentionally unauthenticated (relies on SSRF validation + localhost-only deployment). v2.3 also dropped `Cache-Control: immutable` because it poisoned browser caches across hotfix deploys; current header is `public, max-age=3600, stale-while-revalidate=86400`. **If this ever moves to a public-facing deployment**, swap to signed URLs (HMAC over src/width/expiry) AND reconsider cache headers (signed URLs can safely be `immutable` since the URL itself changes when the underlying source changes). See `routes/sytist.js` proxy route comment and SPEC §49 for context.
- **Scheduler poll interval** is hardcoded at 300000ms; would be nice in Settings UI
- **`_nextReprintNumber`** doesn't scan specialty subfolders — edge case, none observed
- **S3 storage sweep** for old shipped orders, decoupled from the poll cycle — not needed at current scale but worth a phase eventually
- **On-demand composite preview** before processing — currently you have to Process to populate the thumbnail cache. A preview endpoint that calls composite engine without writing files would let operators see "what will this look like" before committing
- **Audit downstream effects of `flags.digital` propagation in canonical order shape** (rejected Phase 45 alternative). The narrower Phase 45 fix only teaches the SS filter about packaging-config category=digital. A broader fix would set `flags.download = true` at `sytistDbService.getOrderById` time for any digital-by-config SKU so every downstream consumer (slip, Darkroom .txt, composite engine, imposition) gets the same behavior automatically. Rejected for Phase 45 because of regression risk on slip display, the Darkroom .txt's skip-if-download logic, and Phase 43 hotfix 1's careful work to keep `flags.download` from propagating incorrectly to package constituents. Worth revisiting once we want symmetric "digital is digital everywhere" handling.
- **Linux portability — `path.win32` usage in operator-output code paths** (deferred from Phase 49 cross-platform notes revival). Many output-path call sites use `path.win32.join`, which emits backslashes unconditionally — fine Windows-to-Windows today, breaks on Linux. Grep for `path.win32` before adding more sites; address holistically before any Linux migration.
- **Phase 53 (planned, decided this session): "Save & next item" + in-editor line-item prev/next.** Phase 52 made Save (no render) → Process actually honor staged overrides, so the batch loop (stage fixes across an order's items, Process once) is functionally real but ergonomically hidden — the editor has no prev/next; advancing means the order-page round-trip or the switcher panel, and Save (no render) gives no confirmation until Process. Phase 53 adds in-editor line-item prev/next + a combined "Save & next item" (persist override, no render, advance). Apply (Overwrite) keeps its render-now-with-thumbnail role for the single-fix case. Depends on Phase 52. See `docs/SPEC.md` Open follow-ups for the full rationale.

## How to ask me for things

Joey works best with:

- **Concrete decisions before code**. When there are multiple ways to solve something, ask which approach to take before building.
- **Diagnostics over guessing**. If something's broken, propose a quick diagnostic (Select-String, SQLite query, log search) before changing code. The investigation often reveals the actual problem.
- **Small, testable changes**. Prefer iterative phases with single-purpose changes over big refactors. Phases 38–44 each shipped one focused thing.
- **Explicit verification steps**. After making a change, propose exactly what command to run + what success looks like.
- **Honest tradeoffs**. When recommending an option, explain why and what's being given up. Don't pick the easy answer when it has hidden costs.
- **Speak up about risks**. If a request would create a regression, security issue, or maintenance burden, say so before implementing.

Less helpful:

- Over-narration ("Let me think about this...", "Great question!", "Now I'll do X")
- Speculative code without diagnostics first
- Tarballs (now that we're in Claude Code, this is moot — edit in place)
- Confident wrong answers — say "I don't know, let me check" instead

## Last updated

After Phase 49 v2.3 (cache-control fix). If you're picking this up after subsequent work, check `docs/CHANGELOG.md` for what's shipped since.
