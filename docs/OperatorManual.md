# Sytist Production Dashboard — Operator Manual

This manual covers the day-to-day workflow for processing Sytist orders: logging in, reviewing the orders list, opening individual orders, processing them through the production pipeline, marking them shipped, reprinting when needed, and dealing with common problems.

If you need to install the dashboard, add users, configure API keys, or manage packages/add-ons, see `AdminManual.md`. For a per-phase history of features, see `CHANGELOG.md`.

---

## Table of contents

1. [Logging in](#1-logging-in)
2. [The dashboard home](#2-the-dashboard-home)
3. [The orders list](#3-the-orders-list)
4. [Order detail](#4-order-detail)
5. [Processing an order](#5-processing-an-order)
6. [Navigating between orders](#6-navigating-between-orders)
7. [Workflows: ShipStation vs Managers vs One Contact](#7-workflows)
8. [Production statuses](#8-production-statuses)
9. [Marking orders shipped (and reversing)](#9-shipping-controls)
10. [Reprinting orders and items](#10-reprinting)
11. [Per-order render overrides](#11-per-order-render-overrides)
12. [Order activity log (Sytist notes)](#12-activity-log)
13. [Downloading photos from line items](#13-photo-downloads)
14. [Pushing packaging to ShipStation manually](#14-push-packaging)
15. [Common situations](#15-common-situations)
16. [Daily routine](#16-daily-routine)

---

## 1. Logging in

Open your browser to **http://localhost:3010** (or whatever URL your admin has set up).

Enter your username and password and click **Sign In**.

Your session lasts 24 hours. If you close the browser and reopen it, you should still be logged in. If you've been inactive for a long time, log in again.

The **Logout** button is in the top-right corner.

---

## 2. The dashboard home

After login, you land on the **Dashboard** — a production overview.

- **Throughput tiles** — orders processed today/week/month
- **Production status overview** — counts by status
- **Recent activity chart** — order volume
- **Gallery breakdown** — which galleries have unprocessed orders
- **Product breakdown** — what's selling
- **Quick actions** — click to jump to filtered orders lists

The Quick Actions section is your fastest path to "show me everything that needs work right now."

---

## 3. The orders list

Click **Orders** in the top navigation, or use a Quick Action tile.

### Filters

- **Workflow** — ShipStation, Managers, One Contact, or All. Default is ShipStation since that's the bulk of daily work.
- **Production status** — Queue (unprocessed), Printing/Production, Shipped, etc. Default is everything unprocessed.
- **Gallery filter** — narrow to one gallery or sub-gallery
- **Date range** — last N days or custom range
- **Search** — by order number, customer name, or email

### Table

Each row is one order with order number, date, customer, items summary, workflow badge, status, and total.

### Selecting orders

Check the box on the left to multi-select. The action toolbar above the table activates when you have a selection — including **bulk Mark Shipped** for selected orders.

---

## 4. Order detail

Click any order number in the list to open its detail page.

### Top section

- Order number, date, workflow badge, production status
- Customer block — name, email, phone, business name
- Shipping address + shipping method
- Subject info — gallery-defined extras (athlete name, jersey, coach, etc.)
- Gallery breadcrumb + sub-gallery name
- Sibling badge if items span multiple sub-galleries

### Action row (Process + Ship Status)

Two columns inside one shared card:
- **Process this order** (or **Reprint this order** if already in Printing/Shipped status — see [section 10](#10-reprinting))
- **Mark Shipped** / **Mark Back to Printing** buttons (depending on current status)

### Line items

Each line item shows:
- Product name (with any modifier suffix like " (Framed)")
- SKU, photo filename, dimensions
- Photo thumbnail (composite preview if green-screen)
- Quantity × price
- Flag chips: Green Screen, Includes Download, Framed, Canvas, Package, Gift Cert, Archived Cart

For green-screen items, the filename text and a "Background:" link are both clickable. Clicking either downloads the source image (Phase 37). Useful when you need to inspect the actual files going into production.

Package items appear with the parent on top (e.g. "Gold Package") and constituents below. Each constituent is what actually gets produced.

### Order activity log

A dedicated card shows every action taken on this order — both Sytist-native actions ("Order Has been changed to Shipped — Taylor") AND dashboard actions (`[Dashboard]` prefix). This is read from Sytist's `ms_notes` table (the same table powering Sytist's own Notes section on its order page).

You can also add your own notes here. They write back to Sytist so they're visible there too.

See [section 12](#12-activity-log) for details.

### Shipping card

Shows ShipStation link status. When linked, expands to show:
- SS order ID, tracking, carrier
- **Push packaging to ShipStation** button (opt-in escape hatch — see [section 14](#14-push-packaging))
- Delete link option (admin)

### Imposition + composite previews

Lower on the page:
- **Imposition** section — per-line-item imposed sheet previews; each card has Render Preview, Save Preview, and (when order is in reprint state) Reprint This Item buttons
- **Composite** section — per-line-item composite previews; each card has Re-render with edits button (per-order override)

---

## 5. Processing an order

Click **Process this order** on the detail page. (No confirm dialog — the button is prominent on its own; Phase 33 removed the confirm.)

What happens, in order:

1. **Image download** — each line item's photo downloaded from Sytist S3 to local disk
2. **Green-screen compose** — for line items where the customer chose a background, subject + background composited and saved as `_composed.jpg` (Phase 34)
3. **Composite render** — Memory Mate / templated outputs rendered with customer photo + team photo + overlay + logo + text
4. **Imposition** — multi-up sheets (e.g. 8 wallets on a 5×7) imposed; reads the composed file when present so backgrounds show through
5. **Packing slip** — 5×8 JPG at 300 DPI with thumbnails (also using composed files), QR code, subject info, modifier highlights
6. **Folder sort** — outputs routed via configured folder hierarchy
7. **Specialty routing** — specialty SKUs go to their own folder and get their own .txt
8. **ShipStation submission** — for ship_to_home workflow only:
   - If no SS order exists for this order_id: creates a fresh one with our packaging fields
   - If one already exists (an upstream tool created it first): adopts WITHOUT pushing packaging (Phase 33)
9. **Status writeback** — order's Sytist status flipped to "Printing and Production" (40)
10. **Activity log** — a `[Dashboard] Order processed` entry written to Sytist's notes table

When it finishes you see "Processed successfully" with paths to the created files. Errors show in red.

The page auto-refreshes the shipping card and activity log so you don't need to reload manually.

---

## 6. Navigating between orders

Once on an order detail page:
- **Prev** and **Next** buttons near the top
- Keyboard shortcuts: **left arrow** = Prev, **right arrow** = Next
- Buttons stay within your current filter context
- "Order N of M" indicator
- **Back to list** preserves all filters

---

## 7. Workflows

Sytist's shipping cost decides the workflow:

| Workflow | Shipping cost | What happens |
|---|---|---|
| **ShipStation** | > $1.01 | Full pipeline including ShipStation submission. Customer ships to home. |
| **Managers** | exactly $1.00 | Production files only, no ShipStation. Print goes to coach/manager for distribution. |
| **One Contact** | < $1.00 | Production files only, no ShipStation. Different distribution path. |

The workflow filter on the orders list defaults to ShipStation. Switch to handle Managers / One Contact orders.

---

## 8. Production statuses

The dashboard reads and writes `ms_orders.order_open_status`.

| Status ID | Name | Meaning |
|---|---|---|
| 0 | Open/Queue | Unprocessed; default for new paid orders |
| 40 | Printing and Production | Process was run; production in progress |
| 39 | Shipped | Shipment went out (set by Mark Shipped or scheduler-auto when SS marks shipped) |
| Others | Various | Sytist-specific (Needs Attention, Pending Review, etc.) |

The dashboard's auto-scheduler polls ShipStation every 5 minutes. When SS marks an order shipped, the scheduler flips Sytist `order_open_status` from 40 → 39 AND populates the shipping columns (date, tracking, carrier, cost). You typically don't have to click Mark Shipped yourself — the scheduler handles it (Phase 32).

---

## 9. Shipping controls

### Mark Shipped (manual)

On orders that are in Printing status (40), click **Mark Shipped**. The dashboard:
1. Looks up the linked ShipStation order (if any) for tracking/carrier/cost
2. Writes order_open_status=39 AND the 5 shipping columns (date, tracking, carrier, shipped_by_id=0, cost) in one UPDATE to Sytist
3. Records an audit row + activity-log note

You can also bulk Mark Shipped from the orders list by checking multiple boxes.

### Mark Back to Printing (unship)

Admin only. Reverses a Shipped status back to Printing and resets all 5 shipping columns to zero-defaults. Used when something went wrong post-ship (returned package, customer cancellation, etc.).

You can optionally type a reason — it's stored in both the SQLite audit log and the Sytist activity-log note.

### When the scheduler handles it for you

If a ShipStation user marked the order shipped in the SS UI (or via a label-printing integration), the scheduler picks that up within 5 minutes and updates Sytist automatically. You'll see an entry in the activity log:

> **[Dashboard]** Order Has been changed to Shipped (auto-detected from ShipStation) — Tracking: 9400123, Carrier: USPS, Cost: $4.50

---

## 10. Reprinting

The dashboard detects when an order has already been processed (status 39 or 40). In that state, the Process button automatically becomes a **Reprint** button (orange).

### Reprint whole order

Click **Reprint this order**. No confirm dialog (Phase 35 hotfix removed it). The dashboard:
- Computes the next `_REPRINT[_N]` number by scanning the output directory
- Re-runs the entire pipeline, but writes outputs with the `_REPRINT` suffix:
  - `110685_REPRINT.txt`, `110685_REPRINT_packing_slip.jpg`, `110685_481629_REPRINT_*.png`
  - Originals are NOT touched
- **Skips** Sytist status update (the order doesn't move to a "reprinting" state)
- **Skips** ShipStation (no new SS order, no update to existing one)
- Writes an activity-log entry: `[Dashboard] Order reprinted as REPRINT_N`

Second reprint → `_REPRINT_2`. Third → `_REPRINT_3`. Each gets its own set of files.

### Reprint single item

Each line item card gets a small orange **Reprint this item** button when the order is in reprint state. Click it to reprint just that one line:
- Produces ONE imposed sheet for that cartId
- Produces a `.txt` containing only that line item
- **No packing slip** (operator already knows what's being reprinted)
- Same `_REPRINT[_N]` suffix; filename also includes the cartId so multiple single-item reprints can coexist

The button appears in two places that show the same line item:
1. Main Items list (top of page, on each line item row)
2. Imposition section (deeper on page, next to the per-item Render Preview button)

Both go to the same endpoint; pick whichever is closer to where you're looking.

### Why reprints don't touch Sytist or ShipStation

A reprint is an extra production run, not a re-do of the whole flow. The customer's package was already shipped; we're producing a replacement print for damage/loss. Touching Sytist status would muddle the order's history. Touching ShipStation would create a duplicate shipment.

If a reprint needs its own shipment (you're sending the new print separately to the customer), handle that manually in ShipStation.

---

## 11. Per-order render overrides

If a customer's composite came out poorly placed — head cropped, position off — you can re-render with custom slot positions for that one order without affecting other orders using the same template.

1. On the order detail page, find the composite item in the Composite section
2. Click **Re-render with edits** on its preview
3. The visual editor opens with that order's actual data preloaded (photo, team photo, text, etc.)
4. Drag slot handles or edit properties to fix the placement; staticGraphic / overlay / playerBackground slots are auto-locked but you can unlock them with the 🔒/🔓 toggle in the layers panel
5. Click **Save & re-render**
6. The composite is regenerated with the override, the .txt is updated, and the new file replaces the old in the print folder

The original template stays untouched. The override only applies to this specific order.

To revert: click **Discard override** on the order detail page; the next Process / Reprint will use the original template.

---

## 12. Activity log

The **Order activity** card on the detail page shows the order's full history pulled from Sytist's `ms_notes` table. Includes:

- Sytist-native entries written by Sytist's UI ("Order created by customer — Stefanie Santillo", "Order Has been changed to Shipped — Taylor")
- Dashboard entries (prefixed `[Dashboard]`) for every action: Process, Reprint, Ship, Unship, Push Packaging
- Manual notes you type into either Sytist OR our UI

Each entry shows:
- **Note** or **Log** badge — manual operator notes vs system events
- Who (display name)
- When (date + time)
- Body text

To add a note: type into the textarea at the top, click **Add note**. It appears immediately and is also visible in Sytist's order detail page.

To delete a note you added: click the **Delete** button on the right side of a manual note (only appears on manual notes, not on system events). System log entries cannot be deleted.

The card auto-refreshes after every action (Process, Reprint, Ship, etc.) so you see entries appear without reloading.

---

## 13. Photo downloads

Each line item card shows the photo's original filename and (for green-screen items) the background photo's filename. As of Phase 37, both are clickable download links:

- Click the **photo filename** → downloads the un-watermarked full-resolution source photo
- Click the **background filename** → downloads the chosen background photo (green-screen items only)

Both links open in a new tab. Useful when:
- You want to inspect what's actually going into the printer
- You need to send the source photo to support or a coworker
- You're troubleshooting why a composite came out wrong

The links use the same `fullUrl` the dashboard uses internally for processing.

---

## 14. Push packaging

Background: occasionally a separate tool or integration creates a ShipStation order before the dashboard does (the "Sportsline UI" upstream integration is the known case). In that situation, the dashboard's Process action sees the existing SS order and **adopts** it without pushing our packaging fields, to avoid clobbering whatever the upstream tool wrote (Phase 33 behavior).

If you WANT our packaging on the SS order despite this, use the **Push packaging to ShipStation** button on the Shipping card. It:
1. Builds the same packaging payload the dashboard would have sent on Process
2. Sends it to the linked SS order via SS's update endpoint
3. Returns success with details about what was sent and what SS stored

If SS reassigned the package code (it has its own rules), you'll see a `⚠ SS reassigned package code` warning indicating drift.

An activity-log entry is written: `[Dashboard] Packaging pushed to ShipStation — 4oz, large_envelope_or_flat, stamps_com/usps_first_class`.

Use this when:
- An order shipped to SS via the upstream tool but you want our weight/package settings
- You need to update the packaging after the fact (replaced product, different shipping route)

### Retry on 404 from ShipStation

Occasionally clicking "Send to ShipStation" (or pushing packaging) will pop up a dialog like:

> ShipStation rejected this order, likely because the orderNumber (110747) was previously deleted in ShipStation and is now in a tombstoned state.
>
> Retry with modified orderNumber "110747-r1761778800"?
>
> The original Sytist order ID is preserved in our records; this only affects how ShipStation sees the order.

This means ShipStation is rejecting the order because the orderKey was previously deleted on their side. Click **OK** to retry with a slightly modified orderKey (the dashboard's internal references are unchanged — only ShipStation sees the new key).

If you click Cancel, nothing happens and the order remains unsent.

---

## 14a. Composite thumbnails in ShipStation, on packing slips, and on the order detail page (Phase 41–44)

For products that involve background composition or composite layouts (Memory Mate, Photo Button, 2 Large Magnets, etc.), the dashboard now shows the **rendered preview** — the actual composite output, the same image that gets printed — in three places:

- **ShipStation order line items** — packers see what's being shipped, not just the customer's raw photo
- **Printed packing slip thumbnails** — the slip an operator pulls off the printer shows the finished product per line
- **Dashboard order detail page** — each line item card on the order detail page shows the composite

This works automatically once an order has been processed; no operator action required.

**One thing to be aware of**: orders that were processed BEFORE this feature was deployed (Phase 42–44) won't have cached thumbnails until they're processed again. If you open an old order and the line item card shows a raw photo where you'd expect a composite, that's expected. Reprinting the order will populate the thumbnails.

---

## 15. Common situations

### "An order in the list says Needs Attention"

Open it. Look at line items for anything red or flagged. Common causes:
- **Image download failed** — try Process again
- **Missing composite template** — admin needs to fix in Settings → Composite
- **Missing imposition mapping** — admin needs to fix in Settings → Imposition

### "I processed an order but ShipStation says nothing happened"

Two possibilities:
1. **Workflow** — only ShipStation-workflow orders create SS shipments. Managers / One Contact orders generate production files only.
2. **Adopt without push** — an upstream tool created the SS order first; the dashboard adopted it. The order IS in SS, just with the upstream tool's packaging fields. Click **Push packaging to ShipStation** if you want ours instead.

### "The packing slip thumbnails look wrong for green-screen items"

Check the order's `cart_photo_bg` value in Sytist for the affected line item:
- `cart_photo_bg = 0` → customer didn't pick a background; expected to render as raw subject
- `cart_photo_bg > 0` → background should compose; if it's not appearing, check the server log for `[Processing] ... greenscreen ...` warnings

### "An add-on appears in the order but isn't being produced"

The opt_id isn't mapped, OR the mapping is incomplete (no SKU for product type, no suffix for modifier type). Tell your admin to fix in Settings → Add-ons.

### "A package processed but only the package header printed"

The package SKU isn't configured in Settings → Packages (or a constituent is misconfigured). Tell your admin.

### "I marked an order shipped, but want to unship it"

Admin only. On the order detail page, click **Mark Back to Printing** (admin role). Reason field is optional but recommended — it's stored in both the audit log and the activity-log note.

### "I want to reprint just one item out of an order"

Order needs to be in status 39 or 40 first. Then orange **Reprint this item** button appears on each line item card. See [section 10](#10-reprinting).

### "The scheduler didn't mark my SS-shipped order as shipped in Sytist"

Three possibilities:
1. Less than 5 minutes since SS marked it (scheduler runs every 5 minutes)
2. ShipStation API auth failed — check Settings → API Keys
3. The Sytist write failed — check the server log for `[Scheduler] ... failed`

You can always manually Mark Shipped on the order detail page as a fallback.

### "Reprint produces files but I don't see a Sytist activity log entry"

Check the server log for `[Processing] ms_notes insert failed for ...`. The most common cause is MySQL strict mode — the Phase 36 hotfix accounted for this, but if you see it: paste the log line to your admin.

### "Pushing packaging to SS returned 'package code drift'"

ShipStation sometimes reassigns the package code based on its own internal rules (weight thresholds, etc.). Drift is informational, not an error — the order IS in SS with whichever code SS decided. If the code SS picked is wrong for your packaging, change the order in the SS UI manually.

### "The dashboard is showing stale data"

The orders list auto-refreshes every 5 minutes. You can also click Refresh. For the order detail page, the activity log auto-refreshes after every action; the order itself reloads when you navigate prev/next.

### "I see the composite thumbnail in ShipStation but not on the dashboard order detail page"

The order was likely processed BEFORE the composite-thumbnail feature deployed (Phase 44). Reprint the order — the cache will populate during the reprint and the order detail page will show the composite on the next page load.

If a recent order is missing thumbnails on the order detail page but the printed packing slip and ShipStation both have them, check with your admin — that's an unexpected case that needs investigation.

### "ShipStation says the order is shipped but I never marked it"

Some orders show as `shipped` in ShipStation within seconds of creation, without a tracking number — cause not yet diagnosed (possibly an SS workflow rule or selling channel). This doesn't affect the dashboard or the cache anymore (Phase 44 hotfix 2), but if it's confusing operators, mention it to your admin.

---

## 16. Daily routine

A typical day:

1. **Open the dashboard**, log in
2. **Check the home dashboard** for Quick Actions
3. **Click into Orders** with workflow = ShipStation, status = Queue
4. **Process orders one by one**:
   - Open the first order
   - Verify customer info, items, and any green-screen backgrounds look right
   - Click Process this order
   - Wait for completion (10-30 seconds typically)
   - Check for errors in the result
   - Use right arrow to move to next
5. **Switch workflow to Managers**, do the same
6. **Switch workflow to One Contact**, do the same
7. **Check Needs Attention** — handle any flagged orders
8. **Check activity log** if anyone added notes about orders that need follow-up
9. **End of day** — filter to today's date + status Printing/Shipped, confirm count matches expectations

You shouldn't need to click Mark Shipped manually for ship_to_home orders — the scheduler handles it within 5 minutes of ShipStation marking the package shipped. Managers and One Contact orders may need manual Mark Shipped depending on your shop's process.

For reprints throughout the day: open the order, the Process button will already say "Reprint" if eligible. Single-item reprints take 5-10 seconds and don't disrupt anything else.

If something seems broken, screenshot the issue + the server log lines around the time it happened, and send to your admin.
