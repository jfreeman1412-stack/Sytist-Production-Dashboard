// server/services/schedulerService.js
//
// Phase 13e: background polling for ShipStation shipped status.
//
// Periodically queries ShipStation for orders we have local links
// for, looking for ones that have moved to 'shipped' status. When
// it finds one, updates the local shipstation_links row with
// tracking number, carrier, and shipped_at timestamp.
//
// Design choices:
//
//   - Singleton lifecycle. Start once on server boot; stop on
//     SIGINT/SIGTERM via graceful shutdown. No per-request state.
//
//   - Poll interval defaults to 5 minutes. Configurable via env
//     SHIPSTATION_POLL_MS (in ms) so dev can poll faster. Setting
//     to 0 disables polling entirely.
//
//   - Re-entrant guard. If a poll is still running when the next
//     interval fires (e.g. SS is slow), the next tick skips rather
//     than queuing — keeps things from piling up.
//
//   - 7-day window. We only ask SS for orders shipped in the last
//     7 days. Two reasons: (1) keeps the response size bounded;
//     (2) anything older we'd already have caught on a previous
//     poll. Operators who need to backfill historical shipped
//     status can call _pollOnce() manually via the API.
//
//   - Failure-tolerant. Any error during a poll is logged but
//     doesn't crash the timer. The next tick tries again. SS
//     auth issues will show up as repeated logs that the operator
//     can notice and fix without restarting the server.
//
//   - Sytist has no external "customer notification" callback yet
//     (PhotoDay had photodayService.markAsShipped). We just update
//     the local link row. When customer notifications come online,
//     this is where we'd hook into them.

const DEFAULT_POLL_MS = 5 * 60 * 1000; // 5 minutes
const SHIPPED_WINDOW_DAYS = 7;
const SHIPPED_PAGE_SIZE = 100;

class SchedulerService {
  constructor() {
    this._timer = null;
    this._isPolling = false;
    this._lastPollAt = null;
    this._lastPollResult = null;
    this._pollCount = 0;
    // Phase 49 v2: track when the photo-cache TTL sweep last ran.
    // Each SS poll tick checks this; if >24h elapsed, sweep alongside
    // the poll. Lazily piggybacking on the existing scheduler avoids
    // spinning up a second timer.
    this._lastPhotoCacheSweepAt = 0;
  }

  /**
   * Start the background poller. Idempotent — calling twice has the
   * same effect as calling once (no double-timers).
   *
   * Reads SHIPSTATION_POLL_MS from env. Setting it to 0 disables
   * polling (useful in dev if you don't want noise). Setting it
   * below 60_000 is allowed but logs a warning since SS rate limits
   * to 40 req/min on the V1 API.
   */
  start() {
    if (this._timer) {
      console.log('[Scheduler] Already running');
      return;
    }
    const raw = process.env.SHIPSTATION_POLL_MS;
    const interval =
      raw === undefined || raw === '' ? DEFAULT_POLL_MS : Number(raw);
    if (interval === 0) {
      console.log(
        '[Scheduler] ShipStation polling disabled (SHIPSTATION_POLL_MS=0)'
      );
      return;
    }
    if (!Number.isFinite(interval) || interval < 0) {
      console.warn(
        `[Scheduler] Invalid SHIPSTATION_POLL_MS=${raw}, falling back to ${DEFAULT_POLL_MS}ms`
      );
    }
    const ms = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_MS;
    if (ms < 60_000) {
      console.warn(
        `[Scheduler] Poll interval ${ms}ms is below 60s — SS V1 rate limits at 40 req/min`
      );
    }
    this._timer = setInterval(() => this._pollOnce(), ms);
    console.log(`[Scheduler] ShipStation polling started (every ${ms}ms)`);

    // Also run once immediately on start so a fresh server restart
    // catches up rather than waiting a full interval. Fire-and-
    // forget; errors are logged inside _pollOnce.
    this._pollOnce().catch((err) => {
      console.warn(`[Scheduler] Initial poll error: ${err.message}`);
    });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      console.log('[Scheduler] ShipStation polling stopped');
    }
  }

  /**
   * Expose poller status for the UI / health endpoint.
   */
  getStatus() {
    return {
      running: !!this._timer,
      isPolling: this._isPolling,
      lastPollAt: this._lastPollAt,
      lastPollResult: this._lastPollResult,
      pollCount: this._pollCount,
    };
  }

  /**
   * Run one poll cycle. Public so the API can trigger an on-demand
   * refresh (e.g. operator clicks "Check ShipStation now").
   *
   * Returns the summary object that also gets stored on the service
   * instance for getStatus().
   */
  async _pollOnce() {
    if (this._isPolling) {
      // Don't queue; skip this tick. The next interval will try again.
      console.log('[Scheduler] Previous poll still running, skipping');
      return { skipped: true };
    }
    this._isPolling = true;
    this._pollCount += 1;
    const startedAt = new Date().toISOString();
    const summary = {
      startedAt,
      finishedAt: null,
      ok: false,
      matched: 0,           // number of local links that got updated
      ssOrdersChecked: 0,   // number of shipped orders SS returned
      pendingLinks: 0,      // number of local links awaiting shipment
      // Phase 32: track Sytist sync. Every local "marked shipped" also
      // pushes to ms_orders via orderStatusService.shipOrder so the
      // ms_orders.order_open_status flips to 39 + the shipping
      // columns get written. Rollback on failure.
      sytistSynced: 0,
      sytistFailed: 0,
      error: null,
    };

    try {
      const shipstationLinkService = require('./shipstationLinkService');
      const shipstationService = require('./shipstationService');
      // Phase 32: route auto-detected shipments through orderStatusService
      // so they hit the same code path as a manual Mark Shipped — which
      // means ms_orders.order_open_status flips to the configured
      // shippedStatusId AND all 5 shipping columns get written. Lazy
      // require to mirror the existing pattern + tolerate the module
      // not being present in older installs (just skips the Sytist
      // sync if so).
      let orderStatusService = null;
      try {
        orderStatusService = require('./orderStatusService');
      } catch (e) {
        // Service unavailable; we'll fall back to link-only updates.
        // Operator should see this warning in the log on first poll
        // after a partial deploy.
        console.warn(
          `[Scheduler] orderStatusService not available — Sytist auto-sync disabled: ${e.message}`
        );
      }

      // Find local links that aren't shipped yet. We poll until they
      // either go shipped or get deleted by the operator.
      const allLinks = shipstationLinkService.listAll();
      const pending = allLinks.filter(
        (l) => l.ss_order_status !== 'shipped' && l.ss_order_status !== 'cancelled'
      );
      summary.pendingLinks = pending.length;

      if (pending.length === 0) {
        // Nothing to check; record a quick OK summary and bail.
        summary.ok = true;
        summary.finishedAt = new Date().toISOString();
        this._lastPollAt = summary.finishedAt;
        this._lastPollResult = summary;
        return summary;
      }

      // Ask SS for shipped orders in the rolling window. We don't
      // filter by orderNumber because SS's V1 API doesn't accept
      // arrays — and one wide query is cheaper than N targeted ones.
      const start = new Date();
      start.setDate(start.getDate() - SHIPPED_WINDOW_DAYS);
      const modifyDateStart = start.toISOString().split('T')[0];

      let ssResult;
      try {
        ssResult = await shipstationService.listOrders({
          orderStatus: 'shipped',
          pageSize: SHIPPED_PAGE_SIZE,
          sortBy: 'ModifyDate',
          sortDir: 'DESC',
          modifyDateStart,
        });
      } catch (err) {
        summary.error = `listOrders failed: ${err.message}`;
        console.error(`[Scheduler] ${summary.error}`);
        return summary;
      }

      const ssOrders = ssResult?.orders || [];
      summary.ssOrdersChecked = ssOrders.length;
      if (ssOrders.length === 0) {
        summary.ok = true;
        return summary;
      }

      // Build a lookup by orderNumber. ShipStation guarantees
      // orderNumber is unique per account so collisions aren't a
      // concern for us.
      const ssByOrderNumber = new Map();
      for (const o of ssOrders) {
        if (o.orderNumber) ssByOrderNumber.set(String(o.orderNumber), o);
      }

      // Walk pending local links and match by orderNumber.
      // We also accept matching by ss_order_id when the orderNumber
      // is missing (defensive against historic data).
      let matched = 0;
      for (const link of pending) {
        let ssOrder = null;
        if (link.ss_order_number) {
          ssOrder = ssByOrderNumber.get(String(link.ss_order_number));
        }
        if (!ssOrder && link.ss_order_id) {
          ssOrder = ssOrders.find((o) => o.orderId === link.ss_order_id);
        }
        if (!ssOrder) continue;

        // Found a shipped match. Extract tracking from the last
        // shipment record if available, falling back to top-level
        // fields. ShipStation isn't always consistent here.
        const shipments = ssOrder.shipments || [];
        const latest = shipments[shipments.length - 1];
        const trackingNumber =
          latest?.trackingNumber || ssOrder.trackingNumber || null;
        const carrierCode =
          latest?.carrierCode || ssOrder.carrierCode || link.carrier_code || null;
        const shippedAt =
          latest?.shipDate || latest?.createDate || new Date().toISOString();

        try {
          // Snapshot of the link's previous state so we can roll
          // back if the Sytist sync fails. The local-link update
          // happens FIRST (we want orderStatusService.shipOrder's
          // buildShippingFieldsForShip helper to read the fresh
          // tracking + carrier from the link row when it constructs
          // the ms_orders write).
          const previousState = {
            ssOrderStatus: link.ss_order_status,
            trackingNumber: link.tracking_number,
            carrierCode: link.carrier_code,
            shippedAt: link.shipped_at,
          };

          shipstationLinkService.update(link.order_id, {
            ssOrderStatus: 'shipped',
            trackingNumber,
            carrierCode,
            shippedAt,
          });
          matched += 1;
          console.log(
            `[Scheduler] Order ${link.order_id} marked shipped: ` +
              `${carrierCode || 'unknown carrier'} ${trackingNumber || '(no tracking)'}`
          );

          // Phase 32: also push to Sytist. orderStatusService.shipOrder
          // writes ms_orders.order_open_status → shippedStatusId (39)
          // plus the 5 shipping columns (date, tracking, carrier,
          // shipped_by_id, cost). force=true bypasses the eligibility
          // check — if SS says shipped, Sytist's status is the lagging
          // indicator that needs to catch up regardless of where it
          // currently sits.
          //
          // Phase 36 hotfix 3: try to find the operator who originally
          // processed this order (via ms_notes lookup) and use their
          // display name as note_who on the auto-ship note. Falls
          // back to 'sytist-dashboard' if no prior dashboard activity
          // exists for the order.
          if (orderStatusService) {
            try {
              let originalOperator = null;
              try {
                const sytistDb = require('./sytistDbService');
                originalOperator = await sytistDb.findOriginalOperator(link.order_id);
              } catch (lookupErr) {
                console.warn(
                  `[Scheduler] findOriginalOperator(${link.order_id}) failed (using fallback): ${lookupErr.message}`
                );
              }

              const result = await orderStatusService.shipOrder({
                orderId: link.order_id,
                force: true,
                source: 'shipstation_auto',
                userId: null,
                userDisplayName: originalOperator || 'sytist-dashboard',
                userIp: '',
              });
              if (!result.ok) {
                // Roll back local link so the next poll retries.
                throw new Error(
                  result.error || `code=${result.code}`
                );
              }
              summary.sytistSynced += 1;
              console.log(
                `[Scheduler] Order ${link.order_id} synced to Sytist: ` +
                  `status ${result.fromStatus} → ${result.toStatus}` +
                  (result.shippingFields
                    ? ` (tracking=${result.shippingFields.trackingNumber || ''}, ` +
                      `carrier=${result.shippingFields.carrier || ''}, ` +
                      `cost=${result.shippingFields.shipCost})`
                    : '')
              );

              // Phase 44 hotfix 2: composed-thumbnail cleanup
              // (both S3 objects and SQLite cache rows) used to
              // happen here, gated on a successful Sytist sync.
              // Removed entirely. Reasoning:
              //
              //   - Cache rows have no meaningful storage cost; the
              //     row is a small (orderId, cartId, url) tuple.
              //   - S3 objects cost ~$0.001/year per ~50KB thumbnail
              //     — trivial at our volume.
              //   - Auto-cleanup was racing the operator: orders
              //     occasionally got marked shipped within the same
              //     poll cycle they were processed in (sometimes
              //     orders pre-exist in SS as 'shipped' for reasons
              //     we haven't fully diagnosed yet), wiping the
              //     cache before the operator could view the order
              //     detail or slip preview.
              //   - Manual cleanup is still possible via a SQLite
              //     DELETE if rows ever become stale (extremely
              //     unlikely; URLs remain valid for the S3 object's
              //     lifetime).
              //
              // If S3 cost ever becomes meaningful at scale, we can
              // add a separate sweep job (e.g. "delete S3 objects >
              // 30 days after ship") rather than coupling it to the
              // poll cycle.
            } catch (sytistErr) {
              // Sytist write failed. Roll back the local link so we
              // retry on the next poll cycle. Without rollback, the
              // link would show as shipped forever and we'd never
              // re-attempt the Sytist sync.
              summary.sytistFailed += 1;
              console.error(
                `[Scheduler] Order ${link.order_id} Sytist sync failed, ` +
                  `rolling back local link: ${sytistErr.message}`
              );
              try {
                shipstationLinkService.update(link.order_id, {
                  ssOrderStatus: previousState.ssOrderStatus,
                  trackingNumber: previousState.trackingNumber,
                  carrierCode: previousState.carrierCode,
                  shippedAt: previousState.shippedAt,
                });
              } catch (rollbackErr) {
                console.error(
                  `[Scheduler] Rollback failed for ${link.order_id}: ${rollbackErr.message}`
                );
              }
              // Don't count this as "matched" since we rolled back.
              matched -= 1;
            }
          }
        } catch (updateErr) {
          console.warn(
            `[Scheduler] Update failed for ${link.order_id}: ${updateErr.message}`
          );
        }
      }

      summary.matched = matched;
      summary.ok = true;
      if (matched > 0 || summary.sytistFailed > 0) {
        console.log(
          `[Scheduler] Poll complete: ${matched} order(s) marked shipped` +
            (summary.sytistSynced > 0
              ? `, ${summary.sytistSynced} synced to Sytist`
              : '') +
            (summary.sytistFailed > 0
              ? `, ${summary.sytistFailed} Sytist sync failed (will retry next poll)`
              : '')
        );
      }
    } catch (err) {
      // Catch-all for unexpected errors. Don't kill the timer.
      summary.error = err.message;
      console.error(`[Scheduler] Poll error: ${err.message}`);
    } finally {
      summary.finishedAt = new Date().toISOString();
      this._lastPollAt = summary.finishedAt;
      this._lastPollResult = summary;
      this._isPolling = false;
    }

    // Phase 49 v2: opportunistic photo-cache TTL sweep. At most
    // once per 24h, piggybacking on whichever SS poll tick is first
    // past the threshold. Errors swallowed — sweep failures must
    // not poison the SS sync summary or future ticks.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - this._lastPhotoCacheSweepAt > ONE_DAY_MS) {
      this._lastPhotoCacheSweepAt = Date.now();
      try {
        const photoThumbService = require('./photoThumbService');
        await photoThumbService.sweep();
      } catch (e) {
        console.warn(`[Scheduler] PhotoCache sweep failed (non-fatal): ${e.message}`);
      }
    }

    return summary;
  }
}

module.exports = new SchedulerService();
