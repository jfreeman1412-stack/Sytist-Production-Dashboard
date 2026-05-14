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

### SS eligibility filter — three layered skip reasons

The line-item filter in `shipstationService.buildOrderFromSytist` skips an item if any of these match. Same three checks are mirrored in `previewPackagingForOrder` and `routes/shipstation.js _computeEligibility`. **Keep all three in sync** when adding new skip reasons:

1. **`SKIP_FLAGS` on the line item's `flags`**: `['download', 'giftCert', 'creditProduct', 'booking', 'preSell']`. Driven by Sytist `ms_cart` columns (`cart_download`, `cart_gift_certificate`, etc.) populated in `sytistDbService.getOrderById`.
2. **`specialtyService.isDropShipped(li.sku)`**: per-SKU lookup against `specialty-products.json` `dropShipped: true` entries. There is no `flags.dropShip` — drop-ship is a config-driven SKU check, not a line-item flag.
3. **`packagingService.isDigital(li.sku)`** (Phase 45): per-SKU lookup against `packaging-config.json` `productWeights[sku].category === 'digital'`. Case-tolerant (uppercase first, raw fallback). Added because Sytist sets `cart_download = 0` on digital-package SKUs like 3D / 5D / 20D, so `flags.download` misses them. Affected ~256 historical orders. Real bug case: order 111042.

If you ever see a "digital" or "non-shippable" SKU bypass the filter, the fix is usually a missing `packaging-config.json` entry rather than a code change. Add the SKU with `category: 'digital'` (uppercased key) and the next process call picks it up — `packagingService.getConfig` reads from disk each call, no restart needed.

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

### Smoke-test artifacts leak into output

When running tests that touch `composite-layouts.json` or `composite-mappings.json`, they sometimes get rewritten with test data. Before bundling or committing, verify these JSON files haven't been overwritten with smoke-test fixtures.

## Architecture pointers

For deeper detail, see:

- **`docs/README.md`** — project overview, architecture highlights, roadmap
- **`docs/SPEC.md`** — per-phase design notes (sections 21–44 cover Phase 17 onward; sections 1–19 cover the bootstrap)
- **`docs/CHANGELOG.md`** — chronological summary of every phase and hotfix
- **`docs/AdminManual.md`** — Settings UI walkthrough, AWS S3 setup, troubleshooting (sections 38–44 are the most recent)
- **`docs/OperatorManual.md`** — what end users see and do

## Open follow-ups (as of Phase 46)

These aren't urgent but are worth knowing about:

- **Why are SS orders auto-shipping** without a tracking number, seconds after creation? Cache survives now (Phase 44 hotfix 2), but the root cause is unknown. Could be an SS account workflow rule.
- **Scheduler poll interval** is hardcoded at 300000ms; would be nice in Settings UI
- **`_nextReprintNumber`** doesn't scan specialty subfolders — edge case, none observed
- **S3 storage sweep** for old shipped orders, decoupled from the poll cycle — not needed at current scale but worth a phase eventually
- **On-demand composite preview** before processing — currently you have to Process to populate the thumbnail cache. A preview endpoint that calls composite engine without writing files would let operators see "what will this look like" before committing
- **Audit downstream effects of `flags.digital` propagation in canonical order shape** (rejected Phase 45 alternative). The narrower Phase 45 fix only teaches the SS filter about packaging-config category=digital. A broader fix would set `flags.download = true` at `sytistDbService.getOrderById` time for any digital-by-config SKU so every downstream consumer (slip, Darkroom .txt, composite engine, imposition) gets the same behavior automatically. Rejected for Phase 45 because of regression risk on slip display, the Darkroom .txt's skip-if-download logic, and Phase 43 hotfix 1's careful work to keep `flags.download` from propagating incorrectly to package constituents. Worth revisiting once we want symmetric "digital is digital everywhere" handling.

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

After Phase 44 hotfix 2 deploy + full docs refresh. If you're picking this up after subsequent work, check `docs/CHANGELOG.md` for what's shipped since.
