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
- **Workflow buckets** (`shipping.workflow`): `ship_to_home`, `ship_to_managers`, `ship_to_league`, and **`digital`** (Phase 60). Derived, not stored in Sytist — by `sytistDbService.categorizeShipping` (option-name match wins, else numeric cost fallback). `digital` = a digital-only order (no physical line item) that would otherwise hit the `$0.00 → league` fallback; it gets its own orders-list tab + Home stat card. Anything that enumerates "the three ship_to_* workflows" must now consider the 4th.

### Workflow classification has two implementations that MUST agree (Phase 14a + 60)

Workflow is decided in **two** places and they must classify the same order identically: the JS `categorizeShipping(optionName, cost, isDigitalOnly)` (per-order display badge) and the SQL `_buildWorkflowSqlPredicate(workflow, digitalSkuList)` (the list filter, next/prev navigation, AND the count-badge query). If you change the bucketing rule in one, change the other in the same commit — a drift makes the tab counts disagree with the filtered list, or the badge disagree with which tab an order appears in.

Phase 60 specifics worth not breaking:
- **Option-name match always wins** over cost and over digital status. The `digital` bucket only catches orders whose option name is *unmapped* and that hit the numeric fallback — a digital order with an explicit `USPS-Ship to Home` option stays home.
- **"Digital-only" = `NOT EXISTS` a physical cart row**, where physical = `cart_download = 0 AND UPPER(cart_sku) NOT IN (<digital-by-config SKUs>)`. The SKU exclusion is **required** by the Phase 45 landmine — digital *packages* (5D etc.) carry `cart_download = 0`, so `cart_download` alone misses them. The SKU list comes from `packaging-config.json` `category:'digital'`, is **inlined** into SQL (validated `[A-Z0-9 _-]`, trusted local config — not a bound param, to avoid ordering bugs across the predicate + the computed `isDigitalOnly` SELECT columns), and checks **both** `ms_cart` and `ms_cart_archive`. The single `_physicalItemExistsSql` helper feeds the predicate, the list query's `isDigitalOnly` column, `getOrderById`, and `getOrderCounts` — keep them on that one helper so they can't diverge.
- `digital` orders carry `uncategorized: false` (deterministic classification — no shipping option to add to the mapping, so no misleading "add to config" ⚠ badge), unlike the home/managers/league numeric-fallback buckets which stay `uncategorized: true`.

### Instant-pack eligibility — JS-only today, but 60b's tab/count MUST add SQL parity (Phase 60a)

`order.isInstantPackEligible` (the orders-list ⚡ Instant-Ship badge + the order-detail shape) is computed **purely in JS** by `sytistDbService._computeInstantPackEligibility(lineItems, predicates)`, called in **both** `getOrdersByWorkflow` and `getOrderById` over the already-expanded canonical line items. There is **deliberately no SQL predicate** — 60a's badge is display-only (no filter tab, no count badge), so unlike Phase 60's `isDigitalOnly` it doesn't gate LIMIT/OFFSET. **The moment Phase 60b adds an Instant-Pack filter tab or count badge, it MUST gain a `_buildWorkflowSqlPredicate`-style SQL counterpart** (replicating package + add-on expansion + eligible-list membership across the MySQL ⨝ local-config boundary) — otherwise the tab's count silently disagrees with the badge. This is the same two-implementations-must-agree trap as workflow classification; 60a only has one implementation because it can afford to.

Rule (default-deny): eligible iff **≥1 physical item** AND **every** physical item's SKU is `instantPackEligible:true` in `packaging-config.json` `productWeights[sku]`. *Physical* = NOT `isPackageHeader` AND none of `INSTANT_PACK_SKIP_FLAGS` (`download/giftCert/creditProduct/booking/preSell`) AND NOT `isDigital(sku)`. Two things not to "fix":
- **Specialty / drop-ship are physical and disqualify via default-deny** — they are NOT skip-flagged, so they pass the physical predicate and (being unmarked) block the order. The eligibility function has **zero** specialty/drop-ship awareness; correctness is emergent from default-deny. **Do NOT reuse the Phase 59 packing-slip `shipsWithLabOrder`** here — that *excludes* specialty/drop-ship (it answers "what's in this lab box"), so the two predicates disagree on specialty/drop-ship **by design**.
- **`isInstantPackEligible(sku)` and `_makePackagingPredicates`'s `isEligibleSku` must stay case-tolerant in lockstep** (uppercase-first, raw fallback — same as `isDigital`). The async service method powers nothing yet but exists for symmetry; the sync predicate powers the badge. Change one lookup rule, change both. `setProductWeight` **preserves** `instantPackEligible` when a caller omits it — don't make it default-to-false on partial updates.

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

### Packaging: category is the source of truth for "force Package service" (Phase 66)

A physical SKU ships as ShipStation `packageCode = 'package'` (not `large_envelope_or_flat`) iff its `packaging-config.json` `productWeights[sku].category` is **`rigid`, `bulky`, or `pano`**. This lives in `packagingService.determinePackaging`'s force-package loop (`PACKAGE_CATEGORIES` set). `flat` → flat mailer (default); `digital` is filtered out upstream.

- **`forcePackageSKUs` is RETIRED** — there used to be a parallel hand-maintained "ship as package" SKU list, and it drifted from the category dropdown (SKU 18 Bagtag was `category:'rigid'` but missing from the list, so it shipped flat). The category dropdown is now the *only* knob. The old key is gone from `DEFAULT_CONFIG`, the migrate seeding, the live config, the PUT-config allowlist (`routes/shipstation.js`), and the Settings → Packaging UI. **Do not reintroduce a parallel force-package list** — change the SKU's category instead. (A stray `forcePackageSKUs` key left in some old config file is inert; nothing reads it.)
- **This is ONLY about `packageCode`, not box sizing.** `boxRouteSKUs` (+ legacy plaques 21/22) still independently decide Medium vs Large *box* and run *before* the category check (returning early), so a boxed SKU is already `package`. The magnet count rule (`magnetThreshold`, SKUs 15/17 at qty ≥ 3) and `packageBundles[].forcePackage` are also untouched. A rigid/bulky/pano item that isn't box-routed gets the existing "9x11 flat-as-package" treatment (packageType `flat_9x11`, `packageCode 'package'`) — physically a flat, but classified as a package, which is the intent.
- Worked/verified by `server/scripts/verify-package-routing.js` (10/10) plus a read-only live-config sweep: all SKUs formerly in `forcePackageSKUs` still package; 18/34/37 flipped flat→package; flats stay flat.
- **Known live data note:** `packageBundles` Gold `forcePackage` is `false` in the live config (the bundle override mechanism is intact, but Gold is not currently forcing package). Separately, SKU 45 (a flat) is still in `boxRouteSKUs` so it boxes — pending a deliberate one-line config removal.

### Output path configuration

There are **two independent operator-configurable output roots**, sourced from different config files and resolved by different services. They do **not** cascade — changing one does not move the other.

| Output | Operator control | Config file / key | Resolved by |
|---|---|---|---|
| Regular pipeline (download, darkroom `.txt`, packing slip, imposition) | Settings → Paths → *mode* templates | `path-overrides.json` → `downloadBase` (per active `mode`) | `pathsService.resolveFullPath` / `resolveBase` at runtime |
| Specialty products (per-SKU routing) | Settings → Specialty → Base path | `specialty-products.json` → `basePath` | `specialtyService.getBasePath()`; blank → fallback `downloadBase\Specialty` |

Do **not** describe a specific drive (`Z:\Photo Day\…`, `Z:\Sytist\…`) as a code fact — those are current operator settings, not invariants. The invariant is the *mechanism*: two knobs, two files, no linkage. The production setup at time of writing deliberately points them at different drive roots (specialty on its own root for lab-bin / drop-ship separation). The blank-`basePath` fallback (`downloadBase\Specialty`) is the *designed default*; an explicit `basePath` is a deliberate operator override, not an accident — do not "fix" the divergence by deriving one from the other without operator sign-off.

Soft-failure note (**superseded by Phase 61 — see the fail-closed section below**): if the specialty root is unreachable at process time, the raw specialty download fails into `subResult.photosFailed`. As of Phase 55 this stopped being silent — a failed specialty (or regular) download emits a `console.warn` (`[Processing] … photo download FAILED`, flagged `(SPECIALTY)`), and a failed `mkdir` warns too instead of being swallowed by an empty catch. **As of Phase 61 it no longer "continues" — any `photosFailed` entry (regular OR specialty) now HARD-FAILS the whole order** (fail-closed; the Fork-2 reversal of Phase 55's continue-anyway behavior). Still also recorded in `subResult.photosFailed` for the result UI. A "missing specialty file" is most likely a stale `specialty-products.json` `basePath`, an unmounted share, or — before Phase 55 — an illegal Windows path char in the `subfolder` (e.g. SKU 29 `12" Wall Cling`; Phase 55's `specialtyService.sanitizePathSegment` strips the reserved set `<>:"/\|?*` at the path-construction use-point, so the *stored* config can still contain them while the *directory* is safe). Check the configured `basePath` and the server log before assuming data loss (order 111297 was a false alarm — files were at the deliberately-separate specialty root; order 110924 was this illegal-char bug — no file was ever written).

### The Darkroom .txt is the authoritative print manifest (Phase 57)

The Darkroom `.txt` is the **authoritative list of what gets printed** for the regular pipeline. After processing, an order's **regular** output folder contains exactly: the `.txt` file(s), the packing slip(s), the team divider(s), and the files referenced by the `.txt`'s `Filepath=` lines — **nothing else for that order**. Any intermediate or staging artifact not referenced by a `.txt` (raw green-screen subject left after `_composed`, the raw subject left after a non-chain `_composite_<layout>.jpg`, the chain-SKU `_composite_<layout>.jpg` intermediate, crashed-write `*.tmp`) is pollution and is removed by `processingService._cleanupOrphanOutputs`, the **final step of `processOrder`** (runs once per order, only when every sub-order succeeded — a failed sub-order's files are left for inspection/retry).

Invariants the cleanup must keep (don't weaken any of these):

- **Specialty is a separate pipeline/folder and is never touched.** Specialty items route to `specialtyService` `basePath`\subfolder with their own `…_specialty.txt`; the cleanup reads **only** the regular `downloadDir` (non-recursive, files only), bails if that dir resolves under `specialtyBase`, and carves out `*_specialty.txt` / recorded specialty paths. A mixed order (regular + specialty) is fine — the two never co-mingle.
- **Order-scoped.** A file is in scope iff its basename is `<orderNumber>.txt` or starts with `<orderNumber>_` (trailing `_`/`.` boundary stops order 110 matching `1100_…`). Folder-sort can co-mingle multiple orders in one dir; other orders are never touched.
- **Referenced set = UNION of `Filepath=` basenames across EVERY `<orderNumber>*.txt` in the dir** — original + reprints + per-team ship_to_league chunks — never just the latest. This is what stops a reprint or a multi-team batch from deleting another batch's outputs (and respects the "never delete reprint files between reprints" landmine).
- **Case-insensitive, basename-only comparison.** Only lowercased basenames are ever compared, never raw/absolute paths — separator/case differences between a `Filepath=` value and the on-disk name must not cause a false "unreferenced".
- **Explicit carve-outs even when also referenced** (belt-and-braces): the `.txt` manifests, packing slips (`_packing_slip`), team dividers (`_DIVIDER_` — these are *not* in any `.txt` and are not order-number-prefixed, so they are doubly safe).
- **Non-fatal.** Printing already succeeded before cleanup runs; any failure (unreadable dir, unlink error) → `console.warn` and continue. An unreadable manifest → skip cleanup entirely (never delete against an incomplete referenced set). Cleanup logs `removed N orphan file(s): [list]` or `no orphan files` per order for operator visibility.

### Processing is FAIL-CLOSED — partial/wrong output blocks the whole order (Phase 61)

The invariant: **"every artifact this order needs got produced, or nothing proceeds."** A sub-order is marked `success:false` (early-return in `_processSubOrder`) if any per-item step fails, and `allOk = subOrders.every(s => s.success)` then short-circuits **all** completion side-effects — orphan cleanup, ShipStation auto-create, the Sytist status → 40 flip, and the ms_notes write. The order stays **Open** with a clear error; the OK files sit on disk as inert debris (no `.txt` references them, so the lab prints nothing); a reprocess re-downloads everything and writes a complete manifest. This replaced the silent-partial bug on order 112054 (one photo failed to download → the `.txt` was built from only the *other* item → a partial box shipped with status flipped to Printing).

**Two failure classes are fatal, both via the same set-`error`/`success=false`/early-`return` mechanism:**
- **Missing item** — a photo that won't download. The gate sits right after the download loop (before any output is produced); it fires on **any** `subResult.photosFailed` entry. **Regular AND specialty/drop-ship both block** (Phase 61 reversed Phase 55's specialty soft-fail — Fork-2 decision: a flaky/unmounted specialty drive now blocks the regular box too, the accepted trade for zero silent-failure surface).
- **Wrong product** — a downstream step that *throws*: green-screen compose (would ship the raw subject instead of photo-on-background), composite render (would ship the bare photo instead of the Memory Mate/etc.), imposition (would ship 1 un-imposed photo instead of the sheet of 8 wallets / 4 magnets). Each step's outer `catch` sets `subResult.error` + returns. Slip and `.txt` generation were already fatal.

**Do NOT weaken any of these back to warning+continue** — that's exactly the silent-partial/wrong-product bug. And **do NOT promote the deliberately-deferred non-fatal cases without a decision**: placeholder logo, missing team photo, background-fetch failure, and missing static graphic each render a *degraded-but-recognizable* result and `continue` (they don't throw); promoting them is a deliberate **Phase 62** policy pass, not a casual change. The rule that drew the line: *fatal if the customer would say "this isn't what I ordered" (wrong product); non-fatal if "this looks slightly off" (degraded but recognizable).*

**Known gap (multi-team):** for `ship_to_managers`/`ship_to_league`, sub-orders are processed independently, so a per-team failure writes no `.txt` for that team and (via `allOk=false`) blocks the order-level status/SS, but **successful sibling teams' `.txt` files are still written to disk** and the lab could print them. The reported case was `ship_to_home` (single sub-order, unaffected). Strict "no team prints unless every team succeeds" is a two-pass restructure deferred until it matters — don't assume it's already enforced.

**Downloads:** `_downloadFile` is single-attempt with an `AbortController` timeout and throws an error carrying `.status` (HTTP) / `.cause` (network). `_downloadWithRetry` wraps it: terminal (HTTP 4xx except 408/429 → source genuinely missing) fails immediately; everything else (network errors, `AbortError` timeout, 5xx, 408, 429) retries with backoff `[1s,3s,9s]`. **Always log `err.cause`** — bare `"fetch failed"` alone is undiagnosable (that's what made 112054 opaque). The retry classification + the gate are exercised offline by `verify-download-retry.js` and `verify-failclose-gate.js`.

**Phase 61a — digital-by-config must be excluded from `printableItems` BEFORE the gate.** `_splitIntoSubOrders` (now `async`) excludes `packagingService.isDigital(li.sku)` items in addition to `SKIP_FLAGS`. Without this, a **standalone digital package** (e.g. `5D`, `category:'digital'`) carries `cart_download=0` (Phase 45 landmine), so `SKIP_FLAGS`' `download` misses it; it has no photo, so it hits the missing-item gate as a "printable item with no photo" and **false-blocks the whole order** (the live 5D bug — order 112094 cart 478746). The exclusion keys on **"this SKU is a configured digital product" (`isDigital(sku)===true`), NOT on "missing photo"** — so a *real* print whose photo genuinely failed stays printable and still trips the gate (the `verify-failclose-gate.js` "real print, no photo → still gate-fails" guard is the proof). Do not "fix" a digital false-block by relaxing the gate. Edge not handled (by decision): a digital item with a truly **empty** `cart_sku` — `isDigital('')` is false, so it wouldn't be excluded; that's a Sytist data gap (assign the SKU / packaging-config entry), **not** a reason to add fragile productName-substring matching (which would wrongly exclude a real print named "…Digital…"). The config read is hoisted (one `getProductWeights()`, not per-item). The slip is unaffected — it renders from the full `order`, not `printableItems`.

### The packing slip's "Items to Ship" count is intentionally NOT what the slip displays (Phase 59)

`packingSlipService._composeSlip` renders specialty rows on every slip (orange tint + SPECIALTY badge — operator awareness) but the "Items to Ship: K" header total in the ITEMS band **excludes them**, along with drop-ship and digital-by-config (Phase 45 `packagingService.isDigital(sku)`) rows. The count answers *"what's in THIS lab box?"* — specialty ships separately on its own pipeline per Phase 55, drop-ship leaves the studio outside the lab flow, digital is a download. Rendering them but counting them would be wrong: a packer scanning "ITEMS TO SHIP: 9" should be able to count nine things into the box. Rendering them but **not** rendering them at all would also be wrong: the operator preparing the order needs to know the specialty piece exists (it's their separate-pipeline reminder).

Do not "fix" the divergence by filtering specialty rows out of `printedItems`, nor by including them in the count. Either change breaks one of the two operator workflows the divergence exists to serve. The eligibility resolution sits in `eligibilityByCartId` (one pre-pass over `printedItems` resolving `isSpecialty` / `isDropShipped` / `isDigitalByConfig` plus a derived `shipsWithLabOrder` boolean); reads happen at the count and at the row-tint independently. Don't introduce a fourth read site that conflates the two — the "lab box vs visible row" distinction is the whole point of the structure.

Same goes for the two-column threshold at N≥7. Single-column for N≤6 keeps today's visual identity for the common case (5–6 items at 120-px thumbs). Two-column is an overflow mitigation, not the new default — don't unify the path "for consistency." The single-page constraint (one JPG, one `Filepath=` in the Darkroom .txt) is also load-bearing: it's why Phase 59 didn't have to touch `darkroomService` / `processingService` / orphan cleanup. Pagination (multi-JPG) was considered and rejected because the propagation through those services creates ongoing coupling not worth the marginal ceiling extension past N=20.

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
- **Completeness audit greps must not be truncated with `head -N`.** When the audit is "enumerate every setter / every call site / every render / every X" and the plan depends on touching all of them, `head -N` silently gives a smaller answer and the audit is non-exhaustive by construction. Phase 58c shipped with one of five `productName:` setters in `sytistDbService` missed because the original audit grep was `grep ... | head -25` and the fifth setter sat past line 25 of the results — the order DETAIL page rendered `"(no name)"` for every item until the hotfix added it. Either no limit on completeness greps, or grep multiple times with `offset` / different patterns and union, or accept that any `head`-limited audit is incomplete and call that out explicitly. Different lesson from "worked examples exercise the bug class" — that one is about test inputs; this one is about audit coverage. (Phase 58c hotfix.)
- **`cartId` is an opaque string end-to-end — never `parseInt`/`Number` it.** Package constituents and addons have synthetic IDs (`483036-pkg-27`, `483036-addon-69516`); numeric coercion truncates them to the parent int and collapses/ misroutes everything keyed by cart. `orderId` is always a real integer (coerce that). `order_overrides.cart_id` is declared INTEGER but **bound as String** — SQLite affinity normalizes numeric strings to int (old plain-int rows still resolve) and stores synthetic IDs as TEXT; do not "fix" the column type or re-add coercion. `orderAssetOverrideService` gates cartId with `isSafeCartId` (`[A-Za-z0-9_-]`), not an integer check. (Phase 56a; pre-56 package/addon override rows are unmigratable orphans.)
- **Line items carry two product-name fields — `productName` is the IDENTIFIER, `productNameDisplay` is for RENDERING.** Sytist gives us a `>`-delimited hierarchy (`"Print Packages > Silver Package > 8x10"`); `sytistDbService` sets both fields at line-item construction time (`productNameDisplay = deriveDisplayName(productName)` → leaf-only, e.g. `"8x10"`, with empty-leaf fallback to the original string). **Match/lookup/path-construction reads `productName`** (darkroom template mapping, specialty subfolder construction, operator-edited `template-mappings.json` + `specialty-products.json`) — these must stay full-path because the stored config is full-path. **Every operator-visible render reads `productNameDisplay`** (dashboard UI, slip JPG, SS payload, ms_notes audit, imposition `{item_description}` token, packaging trace log). The field-name at the callsite tells you which it is — never call the utility manually in a new display site, just read the right field. (Phase 58c.)
- **If a SKU's composite mapping has `chainToImposition`, the printed file is the imposed sheet — Apply must impose, not stop at the composite.** `printOutputService.produceFinalOutput` handles this for Apply; Process's Step 1.5/2 still does its own. A `chainToImposition` SKU with no imposition rule yields the bare composite at the photo-derived path (parity with Process) **plus** an `imposition_rule_missing` warning (returned and `console.warn`'d) — deliberate parity-plus-warning, not a hard-fail.
- **Composite layout-level props (`sheetWidth`/`sheetHeight`/`dpi`/`backgroundColor`) resolve variant-first, root-fallback** in `compositeService.buildSheetBuffer`: `variantDef.X` if the variant owns it, else the **deprecated** `layout.X` root, else the original hardcoded default (Phase 57A — vertical/horizontal are independent designs now; the fallback makes pre-migration data and un-diverged variants byte-identical to pre-57). Root copies exist *only* as that fallback — don't read them directly for render, don't re-share them. **Phase 70 found three client surfaces that had drifted by reading root only** (the composites list "Size" column at `CompositesSettings.js:445`, and the override editor's canvas aspect ratio + `QuickEditPanel` props at `OverrideEditorPage.js:928, 1034-1035`) — visible bug was a layout's edited dimensions appearing in the editor but not the list. Fix introduced **`client/src/utils/resolveSheetMeta.js`** — the canonical client-side resolver mirroring the server pattern (variant-first, root-fallback, hardcoded defaults `dpi=300` / `bg='#ffffff'`). **Any new client surface that displays composite-layout dimensions for a specific variant must use this helper** — don't re-inline the precedence (that's how the Phase 70 sites drifted in the first place). `LayoutCanvas` + `LayoutDesignerPage` have their own correct inlined resolvers and were deliberately left alone in Phase 70's scope; they're safe to migrate to the helper later if convenient. **`graphics` is also variant-first as of Phase 57B**, but resolved at the use-sites (not in `compositeService`): the 3 render reads (`processingService.js:1562`, `routes/sytist.js:3232` preview, `routes/sytist.js:3837` Apply override) read `variantDef.graphics[key] ?? layout.graphics[key]`; the variant-agnostic preview/info stream routes use the helper `resolveGraphicMeta` (same precedence, scans all variants then root). Per-variant graphics keys are **namespaced `${variant}__<name>`** so vertical and horizontal can't collide in the shared `composite-graphics/<layoutId>/` on-disk bucket; the POST/DELETE routes require an explicit `variant` in the body and validate the prefix. **Root `graphics` is read-only fallback now — the routes never write it.** Legacy un-namespaced root entries keep rendering via fallback (don't migrate them — the per-key UI hides legacy entries from a variant's library only when the variant uploads its own same-base-name replacement).

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

### An order "didn't complete" / stayed Open with no .txt — that's the Phase 61 gate, not a bug

If Process leaves an order Open with no `.txt`, no ShipStation order, and a red "ORDER NOT COMPLETED" banner, the **fail-closed gate** fired: a photo wouldn't download, or a composite/imposition/green-screen step threw. This is intentional (prevents partial/wrong shipments). Fix the underlying source and reprocess — do **not** "fix" it by reverting the gate to warning+continue. See the "Processing is FAIL-CLOSED" section above. Check the server log for `FAIL-CLOSED` + the `download attempt N/M … cause=…` lines for the real reason.

### Non-product line items false-block the fail-closed gate (Phase 64 — recurring pattern, now confirmed by Phase 69)

**Non-product line item types — `booking`, `preSell`, `preRegister`, `coupon`, and any future variant — can carry no SKU and no photo, and will reach the printable set / fail-closed gate as a "printable item with no photo" and hard-fail the whole order unless they are explicitly skip-flagged.** Three instances so far in close succession: digital-by-config (5D, Phase 61a), pre-registration (order 112376, Phase 64), and coupon lines (orders 112885/112886, Phase 69). The order's *real* prints get held hostage by one non-product line. **The landmine note from Phase 64 — "audit `cart_*` columns for siblings" — is what caught the coupon case on first report; the rule earns its keep.** Audit `cart_*` columns for siblings remains the standing rule whenever a "won't process" / `no_photo_url` symptom appears on an order whose products look fine.

**The fix pattern (always the same):**
1. **Identify the type via a dedicated Sytist column**, never by name or by "missing photo": `booking → ms_cart.cart_booking`, `preSell → cart_pre_sell`, `preRegister → cart_pre_register_id`, `coupon → cart_coupon`. Before assuming a type is already covered, **audit the `cart_*` column set in `ms_cart` for sibling flags** — that's how you find the next one.
2. **Add a `flags.<type>` in `sytistDbService`** at *both* line-item construction sites (the `getOrderById` query and the `getOrdersByWorkflow` list query), reading the dedicated column. Add the column to the SELECTs.
3. **Wire the flag into every skip set that lists the existing siblings** — keep them in lockstep: `processingService` `SKIP_FLAGS` (the gate), `darkroomService`, `packingSlipService`, `shipstationService`, `INSTANT_PACK_SKIP_FLAGS` in `sytistDbService`, and the inline eligibility check in `routes/shipstation.js`.

**Invariant — key on item identity, NEVER on "missing photo".** Excluding on "no photo" would re-open the Phase 61 gate's guard: a *real* print whose photo genuinely failed to download must still hard-fail. The dedicated-column check preserves that (a real print never has `cart_pre_register_id > 0` / `cart_coupon > 0` etc.). The empty-`cart_sku` edge is a Sytist data gap — assign the SKU, don't add productName-substring matching.

### Body-parser limits: global `express.json` runs first, per-route limits don't override it (Phase 71)

`app.use(express.json({ limit: ... }))` in `server/index.js` is **global middleware** — it runs on every request *before* any route-specific `express.json(...)` parser. So a per-route `express.json({ limit: '15mb' })` doesn't "scope a higher limit to one endpoint" — the global parser sees the body first, returns 413 if oversized, and the route-specific parser never runs. **Phase 9e-hotfix and Phase 50 both made this mistake** (at the composite/graphics route and the order-asset upload route); both added 15mb per-route parsers that were dead code from the moment they were committed. Phase 71 removed both and bumped the global to 25mb. **The global is the only knob that matters for `express.json` size limits**; raise/lower it there or not at all.

If a future upload route needs a *different* size cap from the global, you can't do it with per-route `express.json(...)` — you'd need to (a) use multipart/form-data + multer (whose `fileSize` limit is independent of `express.json`), or (b) skip the global parser on that route via conditional middleware. Neither has been needed yet.

**Base64-in-JSON inflation factor: 4/3.** The override editor's image upload (`OverrideEditorPage.uploadSlotAsset`) reads the file with `FileReader.readAsDataURL` and POSTs `{ dataBase64, filename, slotKind }` JSON. A raw N MB image becomes ~1.33×N MB on the wire, plus a small JSON-wrapper overhead. So **the client's raw-MB cap must lead the server's JSON-MB cap by that factor** or 413 will fall through to a generic error: today, **server 25mb JSON ⇒ client `MAX_UPLOAD_RAW_BYTES = 18 * 1024 * 1024`** (~18.7mb wire-equivalent, rounded down to 18 for wrapper margin), enforced by a pre-flight `file.size` check + a popup, with a 413 catch as defense in depth. If you move one, move both.

### Photo URLs are encoded ONCE at construction in `buildPhotoUrls` (Phase 72)

`sytistDbService.buildPhotoUrls` builds the S3 photo URLs as `${baseUrl}/${encodeURIComponent(photoRow.pic_full)}` (and same for `pic_large` / `pic_th`). **`encodeURIComponent` runs once, at construction.** Every dashboard consumer — `processingService._downloadFile`, the `/api/sytist/photo-thumb` proxy, `greenscreenService`, `impositionService`, `packingSlipService`, and every `fetch(lineItem.photo.fullUrl)` in `routes/sytist.js` — reads the already-encoded `fullUrl`/`largeUrl`/`thumbUrl` from this object. **No consumer should re-encode** (would double-encode, breaking working URLs like `%2B` → `%252B` = wrong path), and **no consumer should construct photo URLs from raw `pic_full` directly** (would re-introduce the bug class).

**The bug this fixed (Phase 72).** Sytist's upload sanitizer strips spaces, `&`, `#`, `?`, apostrophes — they never appear in `pic_full` — but lets `+` through (1,114 of 2.86M lifetime rows). S3 signature validation interprets a bare `+` in the path as a space (`application/x-www-form-urlencoded` convention), returns 403. Order 114148 Team 2 ("6th+ Co Ed Ireland") was the first live trigger; the photo-thumb proxy failed for the same reason transitively. Single-spot fix at the canonical builder propagates to every consumer.

If Sytist eventually adds a new path-component field (per-event subfolders, year buckets, etc.) and we wire it into the URL builder, that new segment also needs `encodeURIComponent` at construction — same reasoning applies. `pic_full` is always a flat filename today (zero of 2.86M rows have an internal `/`); if that ever changes, the fix shape changes too (you'd need to encode segment-by-segment via `.split('/').map(encodeURIComponent).join('/')` so internal `/` is preserved).

### Auth invariants — last-admin guard + soft-delete + session-on-password-change (Phase 73)

Three rules to keep in mind around the auth stack (`server/services/authService.js`, `server/middleware/auth.js`, `server/routes/auth.js`, and the Phase 73 `client/src/pages/settings/UsersSettings.js` + `client/src/pages/ProfilePage.js`):

1. **At least one active admin must always exist.** Server-side check lives in `authService.updateUser` and fires when an update would convert the user from an active admin to either `active=0` OR a non-admin role: if `COUNT(*) FROM users WHERE role='admin' AND active=1 AND id != userId` is zero, it throws `"Cannot deactivate or demote the last active admin"` (route returns 400). `deactivateUser` calls `updateUser({active:false})` so the guard runs there too. The `UsersSettings` UI mirrors this client-side — the "Deactivate" button and the role `<select>` are disabled with a tooltip when `activeAdminCount === 1` and the target is that admin — but the server is authoritative; UI is purely a friendly nudge. **Don't loosen the server guard** without thinking through the brick scenario (recovery from a fully-locked-out dashboard requires shell access to run `scripts/add-user.js`).

2. **"Delete user" is soft-delete by design.** The DELETE route at `/api/auth/users/:id` calls `authService.deactivateUser` → sets `active=0`. It does NOT hard-delete the row. Reasons: (a) audit rows in `order_status_audit.user_id` reference users — orphaning them would break forensic queries; (b) `users.username` has a `UNIQUE` constraint that applies to deactivated rows too, so the right "I want this user back" workflow is **Reactivate**, not "create a new user with the same name." UI labels the action "Deactivate" not "Delete" to avoid lying to operators. Deactivated users show in the list with reduced opacity + a red "Deactivated" badge so they're visible (not hidden — needed for the reactivate workflow). If a real hard-delete is ever needed (GDPR purge etc.), it's a separate phase with its own audit-cascade decisions.

3. **Changing your own password does NOT invalidate your current session.** Sessions are UUIDs stored in SQLite. `validateSession` joins `sessions` ↔ `users` and checks `expires_at` + `users.active = 1`, but does NOT check the password hash. `updateUser({password})` issues `UPDATE users SET password_hash = ?` and never touches the `sessions` table. So an admin (or anyone) who changes their password via `/profile` stays signed in on the same session; the new password is only required on the **next** sign-in. `ProfilePage`'s success message says exactly this so operators don't worry. If you ever want password-change-to-invalidate-other-sessions as a security feature (defense against stolen session cookies), it's a deliberate behavior change — currently we don't.

`SESSION_SECRET` in `.env` was dead config (no source reference) and was deleted in Phase 73. The actual session machinery uses `uuid` (npm package) for opaque session IDs and `bcrypt` for password hashes — neither needs a shared secret. Don't reintroduce `SESSION_SECRET` thinking it's load-bearing.

### Photo rotation clips, text rotation extends — same `slot.rotation` field, two render paths (Phase 22 + 74)

The composite layout's `slot.rotation` (degrees, clockwise per SVG convention) is shared by every slot kind, but the **render semantic differs by design** and the two paths must not be unified:

- **Text slots (Phase 22) — rotation EXTENDS the bounding box.** `compositeService._textSvg` enlarges the SVG to the slot's diagonal (`Math.ceil(sqrt(w² + h²))`) and rotates the `<text>` around the slot center. The extended SVG is then `_clipToCanvas`'d at the sheet edge but NOT at the slot edge — the rotated text can spill past the original w × h box (intended: a 90°-rotated label should fit its full string).
- **Photo / graphic slots (Phase 74) — rotation keeps the box FIXED and CLIPS corners.** `compositeService._applyRotationToBox(buffer, w, h, angleDeg)` rotates the fitted buffer (sharp returns a larger bounding box), then `extract`s the central w × h region — content that pokes outside the original slot box is dropped at the slot edges. The 5 kinds it covers: `playerPhoto`, `playerBackground`, `teamPhoto`, `logo`, `staticGraphic`/overlay. The fast path `if (!angleDeg) return buffer;` is critical for byte-identical output on existing layouts (no `rotation` field or explicit `0`).

Why different: a rotated text label spilling outside the slot is normal layout behavior (and harmless — the slot rect was always notional for text); a rotated photo spilling outside the slot would overlap neighboring slots and break print alignment. The designer canvas matches each path: text-slot SVGs use `transform` on the rotated `<text>` directly (no clip), while `LayoutCanvas.js`' `<image>` elements get both `transform="rotate(angle pivotX pivotY)"` and `clipPath="url(#slot-clip-N)"` (per-slot `clipPathUnits="userSpaceOnUse"` rect at the slot's box). The Rotation FormRow in `LayoutDesignerPage.js`'s `QuickEditPanel` is hoisted out of `{isText && ...}` so it shows for every kind.

**Two landmines on the photo path specifically:**

1. **`sharp.composite` REFUSES inputs larger than the destination canvas** (`"Image to composite must have same dimensions or smaller"`). The Phase 74 harness's first cut tried compositing the rotated (larger) buffer onto a fresh w × h canvas with negative top/left — every rotated render returned an entirely transparent slot (the throw was being swallowed upstream and `_clipToCanvas` was never reached, so the canvas background painted through). The fix that landed uses `sharp(rotated).extract({ left, top, width, height })` to crop centrally — that's the correct primitive for "stable bounding box, corners clip." Don't reintroduce the negative-composite path.
2. **The fast path is byte-identical, not approximately.** Existing layouts have no `rotation` field; `Number(undefined) || 0 === 0` → helper short-circuits → buffer flows to `_clipToCanvas` exactly as it did pre-Phase-74. Don't add any normalization or re-encode in the helper that would touch the no-rotation buffer.

### Terminal-status guard — `!shippingFields` is the discriminator, do not change it (Phase 75)

`sytistDbService.updateOrderStatus(orderId, statusId, shippingFields = null)` refuses to flip an order **out of** a terminal status (`TERMINAL_STATUSES = {39 Shipped}`) to a non-terminal one when `shippingFields` is falsy. This blocks the order-114242 incident class: processed once, SS+scheduler advanced status 0→40→39, then reprocessed by mistake — the second process silently flipped 39→40, corrupting Sytist's state to "in Printing" for an order that was already delivered.

**Why `!shippingFields` is the right discriminator.** The argument distinguishes two intent-classes by call-site convention, NOT by content:
- **Carries `shippingFields` (truthy)** — `orderStatusService.shipOrder` (operator-initiated or scheduler-driven ship), `orderStatusService.unshipOrder` (operator un-ship). These are *explicit shipping-state actions*; the caller has already decided the state-machine transition is correct and is also passing the 5 shipping columns to write. **Allow any transition.**
- **Passes `null` / omits the arg (falsy)** — `processingService` (post-process "flip to Printing"), `routes/sytist.js` PUT `/orders/:id/status` (manual operator status change from the dashboard UI). These are *non-shipping* callers that don't know or care about the order's shipping state. **Gate against reverting out of terminal.**

This mirrors the existing `if (shippingFields)` predicate at line ~2080 that already decides between the 6-column write path and the legacy 1-column write path — same predicate, same callers gated, intentional symmetry. **Do not "improve"** the guard by replacing `!shippingFields` with `caller === 'processing'` flags, role checks, or any other in-band signal. Adding new flags would split the discriminator from the write-path predicate, and the next caller that gets the new flag wrong silently re-opens the 114242 bug class.

**Where the guard is bypassed legitimately.** The shipping-fields path (the only way to bypass) is reachable from: (a) the dashboard's manual ship/unship modals, (b) the scheduler's auto-detected-shipped path (`schedulerService` → `orderStatusService.shipOrder({force:true})`), (c) the explicit unship-then-reprocess operator sequence (the operator un-ships in the UI first; that writes through with `shippingFields`, sets status back to non-terminal, *then* a subsequent reprocess can set 40 since current is no longer 39). There's no "force" flag at the `updateOrderStatus` layer — you bypass by routing through `orderStatusService` instead. That's deliberate: the bypass paths are the ones that need to write the shipping columns anyway.

**Terminal set is exactly `{39}` today** — do NOT broaden it to include the "attention needed" statuses (12 Office Attention Needed / 28 Flagged-For Customer Reply / 73 Atten Needed-Specialty Item). Those are *requests for operator action*, and a reprocess fulfilling them is correct behavior — gating them would re-create the bug from the other direction. Cancelled is handled via `order_erased=1`, not a status (the function already throws on `order_erased=1` separately).

**The error class:** `err.code = 'TERMINAL_STATUS_LOCKED'`. `routes/sytist.js` maps that to **HTTP 409 Conflict** (state-machine guard violation, not a malformed request). `processingService`'s existing `try/catch` around `updateOrderStatus` (lines ~383-403) catches it as `result.statusUpdateError = err.message` and leaves `result.statusUpdated = false` while every print artifact populated *before* the status-update step (sub-orders, txtPath, slipPath, SS adopt result) remains intact — Phase 75 explicitly did NOT touch `processingService.js`, and `verify-status-guard.js` case (B) locks that contract in so a future refactor of that try/catch can't silently break "guard fires + rest succeeds."

### Composite text token vocabulary lives in THREE places (Phase 67 — `{customer.phoneFormatted}`)

The token vocabulary used in composite text slots (`{customer.firstName}`, `{year}`, `{customer.phoneFormatted}`, etc.) is **duplicated across three files that must stay in sync** — add a new token in all three or the editor's preview will silently disagree with what production renders:

1. **Server resolution:** `compositeService.buildTokensFromOrder(order, lineItem)` — the context the regex `_substituteTokens` resolves against, plus any helper functions like `formatPhone`.
2. **Client mirror:** `client/src/pages/settings/OverrideEditorPage.js` — has its own `buildTokensFromOrder` + `camelCaseKey` + (Phase 67) `formatPhone`, per the Phase 48 contract. Powers the override editor's preview + the Text content textarea's resolved-value display.
3. **Variable-picker UI:** `client/src/pages/settings/LayoutDesignerPage.js` — the `VARIABLES` array of `{ token, label }` rows that becomes the button strip in the text-content editor (e.g. `{ token: '{customer.phoneFormatted}', label: 'Phone' }`).

Phase 67 added `{customer.phoneFormatted}` — strips non-digits, then renders 10-digit numbers as `xxx-xxx-xxxx`, strips a leading `1` on 11-digit numbers, and returns the raw input untouched for anything else (empty/whitespace-only → blank). The raw `customer.phone` is **deliberately left unchanged** — `shipstationService.js:513,530` reads it for billTo/shipTo phone fallback and formatting it there would silently leak hyphens into ShipStation. So `{customer.phone}` (raw) and `{customer.phoneFormatted}` coexist.

**Source choice — `order_phone`, not a `ms_people` join, by the data.** `phoneFormatted` reads from `customer.phone` (= `ms_orders.order_phone`). A 90-day live profile justified skipping the obvious `ms_orders.order_email = ms_people.p_email` join: `order_phone` and `p_phone` agree 100% of the time when both are populated, the join would gain only ~10 phones across 4,521 orders (~0.2%), and the email join is fragile (32 emails have >1 `ms_people` row → ambiguous which to pick; 10 orders have no `ms_people` row at all). **When a future token genuinely needs a field only `ms_people` carries, add the join at `sytistDbService.getOrderById`'s query — don't sneak it into `buildTokensFromOrder`.**

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
