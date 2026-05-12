# Sytist Production Dashboard — Operator Manual

This manual covers the day-to-day workflow for processing Sytist orders: logging in, reviewing the orders list, opening individual orders, processing them through the production pipeline, and dealing with common problems.

If you need to install the dashboard, add users, configure API keys, or manage packages/add-ons, see `AdminManual.md`.

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
9. [Reprocessing an order](#9-reprocessing-an-order)
10. [Per-order render overrides](#10-per-order-render-overrides)
11. [Common situations](#11-common-situations)
12. [Daily routine](#12-daily-routine)

---

## 1. Logging in

Open your browser to **http://localhost:3010** (or whatever URL your admin has set up).

![Screenshot: login page](screenshots/01-login.png)

Enter your username and password and click **Sign In**.

Your session lasts 24 hours. If you close the browser and reopen it, you should still be logged in. If you've been inactive for a long time, log in again.

The **Logout** button is in the top-right corner once you're in.

---

## 2. The dashboard home

After login, you land on the **Dashboard** — a production overview page.

![Screenshot: dashboard home with production analytics](screenshots/02-dashboard-home.png)

What you'll see:

- **Throughput tiles** — orders processed today, week, month
- **Production status overview** — counts by status (Queue, In Progress, Shipped, etc.)
- **Recent activity chart** — order volume over the last few days
- **Gallery breakdown** — which galleries have unprocessed orders
- **Product breakdown** — what's selling
- **Quick actions** — click to jump to filtered orders lists

The Quick Actions section is your fastest path to "show me everything that needs work right now."

---

## 3. The orders list

Click **Orders** in the top navigation, or use a Quick Action tile.

![Screenshot: orders list page with filters and table](screenshots/03-orders-list.png)

### Filters

At the top of the list:

- **Workflow** — ShipStation, Managers, One Contact, or All. Default is ShipStation since that's the bulk of daily work. (See [section 7](#7-workflows) for what each one means.)
- **Production status** — Queue (unprocessed), In Progress, Needs Attention, Shipped, etc. Default is everything unprocessed.
- **Gallery filter** — narrow to one gallery or sub-gallery
- **Date range** — last N days, custom range, etc.
- **Search** — by order number, customer name, or email

### The table

Each row is one order. Columns:

- **Order #** — clickable; opens the order detail page
- **Date** — when the order was placed
- **Customer** — name + email
- **Items** — short summary of what's in the order
- **Workflow** — color-coded badge
- **Status** — current production status
- **Total**

### The count

Above the table, you'll see something like "**24 orders match. Page 2 of 5.**" The count reflects the filters you have applied — not just the visible page.

### Selecting orders

You can check the box on the left of each row to multi-select. The action toolbar above the table activates when you have a selection (bulk process, mark status, etc.).

---

## 4. Order detail

Click any order number in the list to open its detail page.

![Screenshot: order detail page top section with customer and shipping info](screenshots/04-order-detail-top.png)

### Top section

- **Order number** and date
- **Workflow badge** + Production status
- **Customer block** — name, email, phone, business name (if set)
- **Shipping address**
- **Shipping method** — option name + cost
- **Subject info** — gallery-defined extra fields (athlete name, jersey number, coach, etc.). Empty fields still show with the label.
- **Gallery breadcrumb** — League > School > Gallery
- **Sub-gallery** — team name (e.g. "U12 Black")

### Sibling indicator

If this order has line items from multiple sub-galleries (one parent ordering for multiple kids on different teams), there's a **Sibling** badge near the order header. This affects folder routing during processing.

### Line items

Below the customer info, every cart line is listed.

![Screenshot: order detail line items showing parent package with exploded constituents](screenshots/05-order-detail-items.png)

Each line shows:

- Product name (with any modifier suffix like " (Framed)")
- SKU + qty
- Photo thumbnail
- Price
- Sub-gallery if different from the order's primary

**Package items** appear with their parent on top (e.g. "Gold Package") and the individual constituents below (a 5×7, an 8×10, magnets, etc.). Each constituent is what actually gets produced.

**Add-on items** that are mapped as products (like "2 Magnets") appear as their own line. Add-ons mapped as modifiers (like "Frame") show up as part of the parent's product name with the suffix appended.

### Action panel

On the right side or below the items:

- **Process this order** — the big button. Runs the full pipeline.
- **Mark as Printing** / **Mark as Shipped** — status writeback buttons
- **Open in Sytist** — links to the order in the Sytist admin
- **Download composite** / **Re-render** — for orders with composite items

---

## 5. Processing an order

Click **Process this order** on the detail page.

![Screenshot: processing in progress with status updates](screenshots/06-processing-progress.png)

What happens, in order:

1. **Image download** — each cart line's photo is downloaded from S3 to local disk
2. **Composite render** — for items that need composite layouts (Memory Mate, etc.), the dashboard renders the composite using the configured template, with the customer photo + team photo + overlay + logo + text
3. **Imposition** — items that get printed multi-up on a sheet (e.g. 8 wallets on a 5×7) are imposed
4. **Darkroom .txt** — a text file is written telling the Darkroom software which CRD template to use, what files to print, and order metadata
5. **Packing slip** — a 5×8 JPG is generated with all line items, thumbnails, QR/barcode, subject info, and modifier highlights
6. **Folder sort** — output files are routed into the configured folder hierarchy (Gallery / Order ID / Shipping Type / etc.)
7. **Specialty product routing** — any specialty SKUs are sent to their own folder and excluded from the .txt
8. **ShipStation submission** — only for the **ShipStation workflow**; creates a shipment with the calculated weight and customer address
9. **Status writeback** — the order's status in Sytist gets updated to "Printing and Production"

When it finishes you'll see "**Processed successfully**" with a list of what was created. If anything failed (image download error, missing composite template, etc.) the page shows the error in red.

---

## 6. Navigating between orders

Once you're on an order detail page, you don't have to go back to the list to see the next one.

![Screenshot: order detail with Prev/Next buttons](screenshots/07-prev-next-nav.png)

- **Prev** and **Next** buttons appear near the top of the page
- Keyboard shortcuts: **left arrow** = Prev, **right arrow** = Next
- The buttons stay within your current filter context — if you opened the order from a list filtered to ShipStation/Queue, Prev/Next walks through that filtered set only
- The page shows "**Order N of M**" so you know how far you've gone
- **Back to list** returns you to the orders list with all filters preserved

If you change filters in the URL or click directly to an order, Prev/Next adapts.

---

## 7. Workflows

Sytist's shipping cost decides the workflow. The dashboard handles all three differently.

| Workflow | Shipping cost | What happens |
|----------|---------------|--------------|
| **ShipStation** | > $1.01 | Full pipeline including ShipStation submission. Customer pays for and receives the package. |
| **Managers** | exactly $1.00 | Production files generated, but **no ShipStation order**. The print goes to the manager/coach for distribution. |
| **One Contact** | < $1.00 | Production files generated, but **no ShipStation order**. Different distribution path. |

The dashboard's workflow filter (top of orders list) defaults to **ShipStation** because that's the bulk of daily volume. Switch to Managers or One Contact to process those.

You can process orders in any workflow from the detail page — the workflow filter just helps you find them.

---

## 8. Production statuses

The Sytist `ms_order_status_logs` writes the canonical status; the dashboard reads it from `ms_orders.order_open_status` and writes back to that same column when you click Mark as Printing or Mark as Shipped.

Statuses you'll see:

| Status | Meaning |
|--------|---------|
| **Queue** | Unprocessed. Default for new paid orders. |
| **Printing and Production** | You've processed it; production work is in progress. |
| **Shipped** | The shipment has gone out (set automatically when ShipStation marks it shipped). |
| **Needs Attention** | Sytist or the dashboard flagged a problem. |
| Various Sytist-specific | Other statuses from the Sytist status table. |

The dashboard's production-status filter lets you scope the list to one or more.

---

## 9. Reprocessing an order

If an order processed but the output is wrong (bad imposition, wrong filename, etc.), you can reprocess it.

1. Open the order detail page
2. Click **Process this order** again

The dashboard re-downloads images (it overwrites local files), re-renders composites, regenerates the .txt and slip, and (for ShipStation orders) attempts to update the existing shipment rather than create a duplicate.

If you need to wipe the entire output for an order and start clean, an admin can manually delete the order's folder from disk and then reprocess.

---

## 10. Per-order render overrides

If a customer's composite came out poorly placed — head cropped, position off — you can re-render with custom slot positions for that one order without affecting other orders using the same template.

![Screenshot: composite thumbnail with Re-render with edits button](screenshots/08-rerender-button.png)

1. On the order detail page, find the composite item that's wrong
2. Click **Re-render with edits** on its thumbnail
3. The visual editor opens with that order's actual data preloaded (the photo, the team photo, the text, etc.)
4. Drag slot handles or edit properties to fix the placement
5. Click **Save & re-render**
6. The composite is regenerated with the override, the .txt is updated, and the new file replaces the old in the print folder

The original template stays untouched. The override only applies to this specific order.

If you change your mind, click **Discard override** on the order detail page — it'll re-render with the original template next time you process.

---

## 11. Common situations

### "An order in the list says 'Needs Attention'"

Open it. Look at the line items for anything red or flagged. Common causes:

- **Image download failed** — the photo couldn't be fetched from S3. Try Process again; if it keeps failing, check the photo's URL in Sytist.
- **Missing composite template** — a SKU mapped to a composite layout, but the template file is missing. Admin needs to fix in Settings → Composite.
- **Missing imposition mapping** — a SKU should be imposed but no layout is set. Admin needs to fix in Settings → Imposition.

### "I processed an order but ShipStation says nothing happened"

Check the workflow. **Only ShipStation-workflow orders create ShipStation shipments.** Managers and One Contact orders generate production files only.

### "The packing slip is missing modifiers"

Modifier add-ons (like Frame, Gloss) only show on the slip if they've been **mapped as modifier type** in Settings → Add-ons. An unmapped option might still appear as plain text in the parent's options list but won't have the yellow highlight.

### "An add-on appears in the order but isn't being produced"

The opt_id isn't mapped, OR the mapping is incomplete (no SKU for product type, no suffix for modifier type). Tell your admin so they can fix it in Settings → Add-ons.

### "A package processed but only the package header printed"

The package SKU isn't configured in Settings → Packages (or one of its constituent items is misconfigured). Tell your admin.

### "I want to undo a status change"

The status field is just a value in `ms_orders.order_open_status`. The admin can change it back via the Sytist admin interface, or via the dashboard if there's a button for it.

### "The dashboard is showing stale data"

The orders list auto-refreshes every 5 minutes (the auto-fetch poll). You can also click **Refresh** at the top of the list. If you opened an order detail page and an action happened in the background, click the order in the list again or use Prev/Next to reload.

### "An order from this morning isn't in my list"

Three possibilities:

1. Workflow filter is excluding it (try All)
2. Production-status filter is excluding it (try All / Queue)
3. It's outside the date range filter
4. The auto-fetch hasn't picked it up yet — click Refresh

If none of those reveal it, the order may not be paid yet (the dashboard only shows `order_payment_status = 'Completed'` and `order_erased = 0`).

---

## 12. Daily routine

A typical day:

1. **Open the dashboard**, log in
2. **Check the home dashboard** — see Quick Actions for "unprocessed orders" and similar
3. **Click into the Orders list** with workflow = ShipStation, status = Queue
4. **Process orders one by one**:
   - Open the first order
   - Verify customer info and items look right
   - Click Process this order
   - Wait for completion, check for errors
   - Use **right arrow** to move to next, repeat
5. **Switch workflow to Managers**, do the same for those
6. **Switch workflow to One Contact**, do the same
7. **Check Needs Attention** — handle any flagged orders
8. **End of day** — confirm all expected orders are processed (filter to today's date, status = Printing/Shipped, eyeball the count)

If anything is unclear, the admin manual covers configuration. If something seems broken, send a screenshot of the issue to your admin.
