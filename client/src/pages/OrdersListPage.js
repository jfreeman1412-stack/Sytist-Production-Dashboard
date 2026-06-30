import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../services/api';

/**
 * Orders list page — Phase 3b.
 *
 * URL is the source of truth for filter state. Query params:
 *   workflow         — 'all' | 'ship_to_home' | 'ship_to_managers' | 'ship_to_league'
 *   productionStatus — '0' (Queue) | '40' | etc | 'all'
 *   galleryId        — ms_calendar.date_id
 *   subGalleryId     — ms_sub_galleries.sub_id
 *   shippingOption   — exact string match
 *   pageSize         — '50' | '100' | 'all'
 *   page             — 1-indexed page number
 *   sort             — 'date_asc' | 'date_desc'
 *
 * Defaults when no params: workflow=all, productionStatus=0, sort=date_asc.
 *
 * Phase 4 will wire up "Process this order" actions per row. For now,
 * clicking a row navigates to the detail page.
 */
export default function OrdersListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Phase 58a: gallery-logo registry for the per-row "Missing Logo"
  // badge. ONE fetch on mount; per-row checks are local against the
  // map (the existing /gallery-assets/logos endpoint returns the full
  // map — zero per-row HTTP, no API change). Soft-fail on error → no
  // badges anywhere (matches the detail-page LogoWarningBanner's
  // posture: false positives are worse than missed warnings).
  const [galleryLogos, setGalleryLogos] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/sytist/gallery-assets/logos')
      .then((r) => {
        if (!cancelled) setGalleryLogos(r?.logos || {});
      })
      .catch(() => {
        if (!cancelled) setGalleryLogos(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Read filter state from URL with defaults.
  const workflow = searchParams.get('workflow') || 'all';
  const productionStatus = searchParams.get('productionStatus') || '0';
  const galleryId = searchParams.get('galleryId') || '';
  const subGalleryId = searchParams.get('subGalleryId') || '';
  const shippingOption = searchParams.get('shippingOption') || '';
  const pageSize = searchParams.get('pageSize') || '50';
  const page = parseInt(searchParams.get('page') || '1', 10);
  const sort = searchParams.get('sort') || 'date_asc';

  // Filter dropdown data (loaded once)
  const [statuses, setStatuses] = useState([]);
  const [galleries, setGalleries] = useState([]);
  const [shippingOptionList, setShippingOptionList] = useState([]);

  // Phase 20: global order search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchError, setSearchError] = useState(null);
  // Track which result is highlighted for keyboard navigation
  const [searchHighlight, setSearchHighlight] = useState(0);
  const searchAbortRef = useRef(null);
  const searchContainerRef = useRef(null);

  // Orders data
  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [softCapHit, setSoftCapHit] = useState(false);

  // Phase 77: "⚡ Instant-Ship Only" filter toggle. Deliberately useState
  // (NOT a URL search-param) so the toggle does NOT persist across reloads —
  // the operator's intent here is a momentary "show me what's safe to instant-
  // pack right now," not a saved filter. Defaults off on page load. Composed
  // server-side as an additional AND with the other filters via the
  // `instantShipOnly` query param; pagination + total counts stay honest
  // because the SQL predicate runs before LIMIT/OFFSET. See SPEC §77 for the
  // JS↔SQL parity story.
  const [instantShipOnly, setInstantShipOnly] = useState(false);

  // Phase 4.6 — batch processing state
  // selectedOrderIds: which orders the operator has checked. Cleared
  // automatically whenever filters change (so a filter-then-process
  // workflow doesn't accidentally include orders from a prior view).
  const [selectedOrderIds, setSelectedOrderIds] = useState(() => new Set());
  // Phase 54 — anchor row index for shift+click range selection. Null
  // when there's no anchor yet or the list reloaded/filtered (a stale
  // index across a different `orders` array would select the wrong
  // range). Set to the row index on every plain (non-shift) toggle.
  const [lastSelectedIndex, setLastSelectedIndex] = useState(null);
  // Modal visibility for the batch confirm dialog
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  // "Process all filtered" mode — when true, the modal will pull every
  // matching order ID (up to a limit) instead of just the selected ones.
  const [batchAllMode, setBatchAllMode] = useState(false);
  // Active batch job (when set, a sticky banner shows progress)
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeJob, setActiveJob] = useState(null);

  // Phase 28 — bulk Mark Selected Shipped
  const [shipModalOpen, setShipModalOpen] = useState(false);
  const [shipping, setShipping] = useState(false);
  // After a successful batch-ship: { shippedCount, skippedCount,
  // results: [{orderId, ok, error?}] }. Shown as a dismissible banner.
  const [shipResult, setShipResult] = useState(null);
  // Bump this to force the orders-load useEffect to re-run (e.g.
  // after a batch-ship changes statuses and we want the list
  // refreshed without changing the filter URL params).
  const [reloadCounter, setReloadCounter] = useState(0);

  // ─── Load filter dropdown data once ────────────────────
  useEffect(() => {
    api
      .get('/api/sytist/order-statuses')
      .then((d) => setStatuses(d.statuses || []))
      .catch((err) => console.warn('Could not load statuses:', err.message));

    api
      .get('/api/sytist/galleries')
      .then((d) => setGalleries(d.galleries || []))
      .catch((err) => console.warn('Could not load galleries:', err.message));

    api
      .get('/api/sytist/shipping-options')
      .then((d) => setShippingOptionList(d.options || []))
      .catch((err) =>
        console.warn('Could not load shipping options:', err.message)
      );
  }, []);

  // ─── Load orders whenever filters change ───────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSoftCapHit(false);

    const qs = new URLSearchParams();
    if (workflow !== 'all') qs.set('workflow', workflow);
    qs.set('productionStatus', productionStatus);
    if (galleryId) qs.set('galleryId', galleryId);
    if (subGalleryId) qs.set('subGalleryId', subGalleryId);
    if (shippingOption) qs.set('shippingOption', shippingOption);
    qs.set('sort', sort);
    // Phase 77: only send the param when ON; the server treats absent as
    // default off, so the OFF case is byte-identical to pre-77 requests.
    if (instantShipOnly) qs.set('instantShipOnly', 'true');

    if (pageSize === 'all') {
      qs.set('limit', '1000');
      qs.set('offset', '0');
    } else {
      const sz = parseInt(pageSize, 10) || 50;
      qs.set('limit', String(sz));
      qs.set('offset', String((page - 1) * sz));
    }

    api
      .get(`/api/sytist/orders?${qs.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setOrders(d.orders || []);
        setTotal(d.total || 0);
        if (pageSize === 'all' && d.orders && d.orders.length === 1000) {
          setSoftCapHit(true);
        }
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [
    workflow,
    productionStatus,
    galleryId,
    subGalleryId,
    shippingOption,
    pageSize,
    page,
    sort,
    reloadCounter,
    instantShipOnly,
  ]);

  // Phase 4.6 — clear selection when filters change so the operator
  // never accidentally batch-processes orders from a prior filter view.
  // Phase 77: instantShipOnly added to the dependency set for the same
  // reason — toggling it shrinks/expands the visible set, and a stale
  // selection from the prior view would silently apply to "Process all
  // selected" after the toggle.
  useEffect(() => {
    setSelectedOrderIds(new Set());
    setLastSelectedIndex(null); // Phase 54: drop the stale range anchor
  }, [workflow, productionStatus, galleryId, subGalleryId, shippingOption, instantShipOnly]);

  // Phase 4.6 — poll the active batch job for progress every 2s.
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timer = null;

    const poll = async () => {
      try {
        const job = await api.get(`/api/sytist/process/job/${activeJobId}`);
        if (cancelled) return;
        setActiveJob(job);
        if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
          // Stop polling. After a few seconds the operator can review and
          // dismiss the banner.
        } else {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        console.warn('[batch] poll error:', err.message);
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    };
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJobId]);

  // ─── Filter manipulation helpers ───────────────────────
  function updateParam(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === '' || value === undefined) {
      next.delete(key);
    } else {
      next.set(key, String(value));
    }
    // Any filter change resets pagination to page 1.
    if (key !== 'page') next.delete('page');
    // Clearing gallery also clears sub-gallery (it's a parent-child relationship).
    if (key === 'galleryId') next.delete('subGalleryId');
    setSearchParams(next, { replace: false });
  }

  // ─── Phase 20: global order search ─────────────────────
  // Hits /api/sytist/orders/search?q=<query>. Debounced 250ms on
  // typing, AND fires immediately on Enter (which also auto-navigates
  // to the order if there's exactly one result).
  //
  // Skips current filter context — search results jump directly to
  // the order regardless of which workflow/status is selected.
  //
  // Race-condition guard: we track the "current request" by query
  // string so stale responses from rapid typing get dropped. No
  // AbortController used because api.get doesn't surface fetch options.
  function runSearch(q) {
    const query = String(q || '').trim();
    if (!query || query.length < 2) {
      setSearchResults([]);
      setSearchError(null);
      setSearchOpen(false);
      return Promise.resolve([]);
    }

    setSearchLoading(true);
    setSearchError(null);
    searchAbortRef.current = query; // remember which query is current
    return api
      .get(`/api/sytist/orders/search?q=${encodeURIComponent(query)}`)
      .then((d) => {
        // Drop stale responses if a newer query has been issued.
        if (searchAbortRef.current !== query) return [];
        const results = d.results || [];
        setSearchResults(results);
        setSearchHighlight(0);
        setSearchOpen(true);
        return results;
      })
      .catch((err) => {
        if (searchAbortRef.current !== query) return [];
        console.warn('Search failed:', err.message);
        setSearchError(err.message || 'Search failed');
        setSearchResults([]);
        return [];
      })
      .finally(() => {
        if (searchAbortRef.current === query) {
          setSearchLoading(false);
        }
      });
  }

  // Debounced search-as-you-type
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    const t = setTimeout(() => runSearch(searchQuery), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Click-outside to close the dropdown
  useEffect(() => {
    if (!searchOpen) return undefined;
    function onDocClick(e) {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(e.target)
      ) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [searchOpen]);

  function navigateToSearchResult(result) {
    if (!result || !result.orderId) return;
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    // Preserve current filter context as a return path; the order
    // detail page's Back button reads this.
    const qs = new URLSearchParams(searchParams);
    const suffix = qs.toString();
    navigate(`/orders/${result.orderId}${suffix ? `?${suffix}` : ''}`);
  }

  async function handleSearchSubmit() {
    const query = searchQuery.trim();
    if (!query) return;
    // Force an immediate search, then navigate on exact match.
    const results = await runSearch(query);
    if (!results || results.length === 0) return;
    // If query is a number AND first result is an exact order_number
    // match, navigate directly.
    if (
      /^[0-9]{3,8}$/.test(query) &&
      String(results[0].orderNumber) === query
    ) {
      navigateToSearchResult(results[0]);
      return;
    }
    // If there's exactly one result, jump to it regardless.
    if (results.length === 1) {
      navigateToSearchResult(results[0]);
      return;
    }
    // Otherwise leave the dropdown open for the user to pick.
    setSearchOpen(true);
  }

  function handleSearchKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // If the user has highlighted a result with arrow keys, pick it.
      if (
        searchOpen &&
        searchResults.length > 0 &&
        searchHighlight >= 0 &&
        searchHighlight < searchResults.length
      ) {
        navigateToSearchResult(searchResults[searchHighlight]);
        return;
      }
      handleSearchSubmit();
      return;
    }
    if (e.key === 'Escape') {
      setSearchOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!searchOpen) {
        setSearchOpen(searchResults.length > 0);
        return;
      }
      setSearchHighlight((h) =>
        Math.min(searchResults.length - 1, h + 1)
      );
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchHighlight((h) => Math.max(0, h - 1));
      return;
    }
  }

  function clearSearch() {
    setSearchQuery('');
    setSearchResults([]);
    setSearchOpen(false);
    setSearchError(null);
  }

  // ─── Phase 4.6 — selection helpers ─────────────────────
  // Phase 54: `index` is the row's position in the currently-rendered
  // `orders` array; `shiftKey` is read from the checkbox change event.
  // Plain toggle (no shift) flips one order and sets the range anchor.
  // Shift+toggle selects the inclusive range between the anchor and the
  // clicked row (file-explorer model) — it always *adds* the range
  // (doesn't deselect), which is the predictable behavior for "select
  // a block to act on". A shift+click with no prior anchor degrades to
  // a plain single toggle. Stale anchor (index out of range after a
  // reload) also degrades to single toggle.
  function toggleOrderSelected(orderId, index = null, shiftKey = false) {
    if (
      shiftKey &&
      lastSelectedIndex !== null &&
      typeof index === 'number' &&
      index >= 0 &&
      index < orders.length &&
      lastSelectedIndex < orders.length
    ) {
      const lo = Math.min(lastSelectedIndex, index);
      const hi = Math.max(lastSelectedIndex, index);
      setSelectedOrderIds((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(orders[i].orderId);
        return next;
      });
      setLastSelectedIndex(index);
      return;
    }
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
    if (typeof index === 'number') setLastSelectedIndex(index);
  }

  function selectAllOnPage() {
    setSelectedOrderIds(new Set(orders.map((o) => o.orderId)));
  }

  function clearSelection() {
    setSelectedOrderIds(new Set());
  }

  const allOnPageSelected =
    orders.length > 0 && orders.every((o) => selectedOrderIds.has(o.orderId));

  function togglePageSelection() {
    if (allOnPageSelected) {
      // Remove just this page's items from the selection
      setSelectedOrderIds((prev) => {
        const next = new Set(prev);
        for (const o of orders) next.delete(o.orderId);
        return next;
      });
    } else {
      setSelectedOrderIds((prev) => {
        const next = new Set(prev);
        for (const o of orders) next.add(o.orderId);
        return next;
      });
    }
  }

  // ─── Phase 4.6 — batch process actions ─────────────────
  function openBatchModalSelected() {
    if (selectedOrderIds.size === 0) return;
    setBatchAllMode(false);
    setBatchModalOpen(true);
  }

  function openBatchModalAll() {
    setBatchAllMode(true);
    setBatchModalOpen(true);
  }

  async function startBatch({ generateDivider, generateQrSheet }) {
    let orderIds;
    if (batchAllMode) {
      // "Process all filtered" — fetch with the current filters but no
      // pagination and grab the IDs.
      const qs = new URLSearchParams();
      if (workflow !== 'all') qs.set('workflow', workflow);
      qs.set('productionStatus', productionStatus);
      if (galleryId) qs.set('galleryId', galleryId);
      if (subGalleryId) qs.set('subGalleryId', subGalleryId);
      if (shippingOption) qs.set('shippingOption', shippingOption);
      // Phase 77: include the instant-ship filter in the "Process all filtered"
      // fetch so the batch operates on exactly the visible subset. Without
      // this the batch would pull the un-filtered set even though the UI
      // shows the eligible-only view, which is exactly the kind of silent
      // mismatch the toggle is supposed to prevent.
      if (instantShipOnly) qs.set('instantShipOnly', 'true');
      qs.set('limit', '500');
      qs.set('offset', '0');
      try {
        const data = await api.get(`/api/sytist/orders?${qs.toString()}`);
        orderIds = (data.orders || []).map((o) => o.orderId);
      } catch (err) {
        alert(`Failed to gather filtered orders: ${err.message}`);
        return;
      }
    } else {
      orderIds = Array.from(selectedOrderIds);
    }

    if (orderIds.length === 0) {
      alert('No orders to process.');
      return;
    }

    // Phase 63: team dividers are batch-level and need the team identity (a
    // team batch is single-team). Take it from the active Team filter; block
    // clearly if dividers are requested without a team selected.
    let team = null;
    if (generateDivider) {
      if (!subGalleryId) {
        alert(
          'Team dividers require a single-team batch — filter by Team first, then process.'
        );
        return;
      }
      const sg = (availableSubGalleries || []).find(
        (s) => String(s.subId) === String(subGalleryId)
      );
      team = { subGalleryId, subGalleryName: sg ? sg.subName : '' };
    }

    try {
      const response = await api.post('/api/sytist/process/batch', {
        orderIds,
        generateDivider,
        generateQrSheet,
        team,
      });
      setActiveJobId(response.jobId);
      setActiveJob({
        jobId: response.jobId,
        status: 'queued',
        total: response.total,
        completed: 0,
        results: [],
      });
      setBatchModalOpen(false);
      // Don't clear selection yet — let the operator confirm what was processed.
    } catch (err) {
      alert(`Batch failed to start: ${err.message}`);
    }
  }

  function dismissJobBanner() {
    setActiveJobId(null);
    setActiveJob(null);
    clearSelection();
  }

  // ─── Phase 28 — bulk Mark Selected Shipped ─────────────
  //
  // Mirrors the batch-process pattern: openShipModal previews the
  // count, startBatchShip calls /orders/batch-ship, then a result
  // banner shows what was shipped vs skipped. Each order is
  // independently validated server-side (only those in Printing
  // status are flipped to Shipped; the rest are reported as
  // 'not_eligible' and skipped).
  function openShipModal() {
    if (selectedOrderIds.size === 0) return;
    setShipResult(null);
    setShipModalOpen(true);
  }

  async function startBatchShip() {
    const orderIds = Array.from(selectedOrderIds);
    if (orderIds.length === 0) return;
    setShipping(true);
    try {
      const response = await api.post('/api/sytist/orders/batch-ship', {
        orderIds,
      });
      setShipResult({
        shippedCount: response.shippedCount || 0,
        skippedCount: response.skippedCount || 0,
        results: response.results || [],
      });
      setShipModalOpen(false);
      // Refresh the orders list — shipped rows have a new status
      // and may no longer match the active "Printing" filter.
      setReloadCounter((c) => c + 1);
      // Clear selection — these rows are no longer the "current set"
      clearSelection();
    } catch (err) {
      setShipResult({
        shippedCount: 0,
        skippedCount: orderIds.length,
        results: [],
        error: err.message || 'Batch ship failed',
      });
      setShipModalOpen(false);
    } finally {
      setShipping(false);
    }
  }

  function dismissShipResult() {
    setShipResult(null);
  }

  // Phase 4.7 — graceful cancel of an in-flight batch. Lets the
  // currently-processing order finish, then halts before the next one.
  async function cancelBatch() {
    if (!activeJobId) return;
    try {
      const response = await api.post(
        `/api/sytist/process/job/${activeJobId}/cancel`,
        {}
      );
      // Update local state so the UI immediately reflects "cancelling…"
      // status. The poll cycle picks up the actual server-side state
      // a few seconds later.
      if (response.job) {
        setActiveJob((prev) => ({ ...(prev || {}), ...response.job }));
      }
    } catch (err) {
      alert(`Cancel failed: ${err.message}`);
    }
  }

  // Sub-galleries available for the currently selected gallery
  const availableSubGalleries = useMemo(() => {
    if (!galleryId) return [];
    const g = galleries.find((x) => String(x.galleryId) === String(galleryId));
    return g ? g.subGalleries : [];
  }, [galleryId, galleries]);

  // Workflow tab counts (lightweight — derived from current page only;
  // Phase 12 polish could fetch separate counts per tab)
  const workflowTabs = [
    { key: 'all', label: 'All' },
    { key: 'ship_to_home', label: 'Ship to Home' },
    { key: 'ship_to_managers', label: 'Managers' },
    { key: 'ship_to_league', label: 'League' },
    // Phase 60: digital-only orders (no physical item, $0.00 shipping) that
    // previously fell into League via the cost fallback now bucket here.
    { key: 'digital', label: 'Digital' },
  ];

  return (
    <div
      style={{
        maxWidth: 1400,
        margin: '24px auto',
        padding: '0 24px',
        width: '100%',
      }}
    >
      <h1 style={{ fontSize: 22, margin: '0 0 16px' }}>Orders</h1>

      {/* ─── Phase 20: global order search ──────────────── */}
      <div
        ref={searchContainerRef}
        style={{
          position: 'relative',
          marginBottom: 12,
          maxWidth: 520,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text"
            placeholder="Search orders by # / name / email / phone — Enter to jump"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => {
              if (searchResults.length > 0) setSearchOpen(true);
            }}
            style={{
              flex: 1,
              padding: '8px 32px 8px 12px',
              background: 'var(--bg-card)',
              color: 'var(--text)',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              fontSize: 14,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          {searchQuery && (
            <button
              onClick={clearSearch}
              title="Clear search"
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                color: 'var(--text-muted)',
                border: 'none',
                cursor: 'pointer',
                fontSize: 16,
                padding: 4,
                lineHeight: 1,
                fontFamily: 'inherit',
              }}
            >
              ×
            </button>
          )}
        </div>

        {/* Results dropdown */}
        {searchOpen && (searchResults.length > 0 || searchLoading || searchError) && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
              zIndex: 50,
              maxHeight: 480,
              overflowY: 'auto',
            }}
          >
            {searchLoading && searchResults.length === 0 && (
              <div
                style={{
                  padding: '12px 14px',
                  fontSize: 13,
                  color: 'var(--text-muted)',
                }}
              >
                Searching…
              </div>
            )}
            {searchError && (
              <div
                style={{
                  padding: '12px 14px',
                  fontSize: 13,
                  color: '#ff6b6b',
                }}
              >
                Search error: {searchError}
              </div>
            )}
            {!searchLoading && !searchError && searchResults.length === 0 && (
              <div
                style={{
                  padding: '12px 14px',
                  fontSize: 13,
                  color: 'var(--text-muted)',
                }}
              >
                No matching orders
              </div>
            )}
            {searchResults.map((r, idx) => {
              const isHi = idx === searchHighlight;
              return (
                <button
                  key={r.orderId}
                  onMouseEnter={() => setSearchHighlight(idx)}
                  onClick={() => navigateToSearchResult(r)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 14px',
                    background: isHi
                      ? 'var(--accent-hover, rgba(255,255,255,0.05))'
                      : 'transparent',
                    color: 'var(--text)',
                    border: 'none',
                    borderBottom: '1px solid var(--border-color)',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontFamily: 'inherit',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      #{r.orderNumber || r.orderId}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {r.orderDate}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      gap: 12,
                      alignItems: 'baseline',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>{r.customerName || '(no name)'}</span>
                    {r.email && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {r.email}
                      </span>
                    )}
                    {r.productionStatusName && (
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--text-muted)',
                          padding: '1px 6px',
                          border: '1px solid var(--border-color)',
                          borderRadius: 4,
                          marginLeft: 'auto',
                        }}
                      >
                        {r.productionStatusName}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
            {searchResults.length === 10 && (
              <div
                style={{
                  padding: '8px 14px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  fontStyle: 'italic',
                }}
              >
                Showing first 10 — refine search for more
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Workflow tabs row ──────────────────────────── */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {workflowTabs.map((tab) => {
          const isActive = workflow === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => updateParam('workflow', tab.key === 'all' ? null : tab.key)}
              style={{
                padding: '8px 14px',
                background: isActive ? 'var(--accent)' : 'var(--bg-card)',
                color: isActive ? '#fff' : 'var(--text-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                fontFamily: 'inherit',
              }}
            >
              {tab.label}
            </button>
          );
        })}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Sort:
            <select
              value={sort}
              onChange={(e) => updateParam('sort', e.target.value)}
              style={selectStyle}
            >
              <option value="date_asc">Oldest first</option>
              <option value="date_desc">Newest first</option>
            </select>
          </label>

          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Per page:
            <select
              value={pageSize}
              onChange={(e) => updateParam('pageSize', e.target.value)}
              style={selectStyle}
            >
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="all">All</option>
            </select>
          </label>
        </div>
      </div>

      {/* ─── Filter dropdowns row ───────────────────────── */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
        }}
      >
        <FilterGroup label="Production status">
          <select
            value={productionStatus}
            onChange={(e) => updateParam('productionStatus', e.target.value)}
            style={selectStyle}
          >
            <option value="all">All statuses</option>
            <option value="0">Open</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </FilterGroup>

        <FilterGroup label="Gallery">
          <select
            value={galleryId}
            onChange={(e) => updateParam('galleryId', e.target.value || null)}
            style={{ ...selectStyle, minWidth: 240 }}
          >
            <option value="">— Any —</option>
            {galleries.map((g) => (
              <option key={g.galleryId} value={g.galleryId}>
                {g.galleryName} ({g.orderCount})
              </option>
            ))}
          </select>
        </FilterGroup>

        <FilterGroup label="Team">
          <select
            value={subGalleryId}
            onChange={(e) => updateParam('subGalleryId', e.target.value || null)}
            disabled={!galleryId}
            style={{
              ...selectStyle,
              minWidth: 200,
              opacity: galleryId ? 1 : 0.5,
            }}
          >
            <option value="">— Any —</option>
            {availableSubGalleries.map((s) => (
              <option key={s.subId} value={s.subId}>
                {s.subName} ({s.orderCount})
              </option>
            ))}
          </select>
        </FilterGroup>

        <FilterGroup label="Shipping option">
          <select
            value={shippingOption}
            onChange={(e) => updateParam('shippingOption', e.target.value || null)}
            style={{ ...selectStyle, minWidth: 240 }}
          >
            <option value="">— Any —</option>
            {shippingOptionList.map((o) => (
              <option key={o.optionName} value={o.optionName}>
                {o.optionName || '(empty)'} ({o.orderCount})
              </option>
            ))}
          </select>
        </FilterGroup>

        {/* Phase 77: Instant-Ship Only toggle. Visually distinct from the
            <select> filters (it's a yes/no, not a value picker) and uses the
            same ⚡ glyph as the per-row InstantPackBadge so the operator
            reads "this filter shows what the ⚡ badge shows" at a glance.
            Toggling resets pagination to page 1 — otherwise an operator on
            page 5 of the un-filtered view who toggles ON could land on a
            page-5 view of a much shorter filtered set (or past the end).
            Highlighted background when ON so it's obvious the list is a
            narrowed view; calm border when OFF so it blends with the row. */}
        <FilterGroup label="Instant-ship">
          <button
            onClick={() => {
              setInstantShipOnly((v) => !v);
              setSearchParams(
                (p) => {
                  const next = new URLSearchParams(p);
                  next.delete('page');
                  return next;
                },
                { replace: false }
              );
            }}
            aria-pressed={instantShipOnly}
            title={
              instantShipOnly
                ? 'Showing instant-ship-eligible orders only. Click to show all.'
                : 'Show only orders that can be instant-shipped (every physical item is on the eligible list).'
            }
            style={{
              padding: '6px 12px',
              fontSize: 13,
              background: instantShipOnly
                ? 'rgba(224,179,65,0.18)'
                : 'var(--bg-input)',
              color: instantShipOnly ? '#e0b341' : 'var(--text-primary)',
              border: `1px solid ${
                instantShipOnly ? 'rgba(224,179,65,0.55)' : 'var(--border-color)'
              }`,
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: instantShipOnly ? 600 : 400,
            }}
          >
            ⚡ Instant-Ship Only{instantShipOnly ? ' · ON' : ''}
          </button>
        </FilterGroup>

        {/* Clear all filters shortcut */}
        {(galleryId || subGalleryId || shippingOption || workflow !== 'all') && (
          <button
            onClick={() => {
              setSearchParams({ productionStatus: '0' }, { replace: false });
              // Phase 77: Clear filters also drops the instant-ship toggle —
              // matches operator expectation that "Clear filters" returns to
              // the default un-narrowed view.
              setInstantShipOnly(false);
            }}
            style={{
              padding: '6px 10px',
              fontSize: 12,
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ─── Soft cap warning ───────────────────────────── */}
      {softCapHit && (
        <div
          style={{
            padding: 10,
            marginBottom: 12,
            background: 'rgba(224,179,65,0.1)',
            border: '1px solid rgba(224,179,65,0.3)',
            borderRadius: 6,
            color: '#e0b341',
            fontSize: 12,
          }}
        >
          Showing first 1000 results. Add more filters to narrow.
        </div>
      )}

      {/* ─── Results count ──────────────────────────────────
          Phase 14a: surface the absolute total above the table so
          operators always know how many orders match their filters,
          regardless of whether pagination is active. Especially
          important for the "All" page-size mode where the
          Pagination component isn't rendered. */}
      {!loading && !error && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 8,
          }}
        >
          {total > 0 ? (
            <>
              <strong style={{ color: 'var(--text-secondary)' }}>
                {total.toLocaleString()}
              </strong>{' '}
              order{total === 1 ? '' : 's'} match
              {workflow !== 'all' ||
              productionStatus !== 'all' ||
              galleryId ||
              subGalleryId ||
              shippingOption ||
              instantShipOnly
                ? ' your filters'
                : ''}
              {/* Phase 77: explicit ⚡ chip when the instant-ship filter is on,
                  so the count is unambiguous about WHY it's narrower than the
                  default view. Sits inline so it doesn't shift layout. */}
              {instantShipOnly && (
                <span
                  style={{
                    marginLeft: 6,
                    padding: '1px 6px',
                    fontSize: 11,
                    background: 'rgba(224,179,65,0.18)',
                    color: '#e0b341',
                    border: '1px solid rgba(224,179,65,0.4)',
                    borderRadius: 3,
                  }}
                >
                  ⚡ instant-ship only
                </span>
              )}
              {pageSize !== 'all' &&
                total > orders.length &&
                ` (showing ${orders.length} on this page)`}
            </>
          ) : (
            <>No orders match</>
          )}
        </div>
      )}

      {/* ─── Results table ──────────────────────────────── */}
      {error && (
        <div
          style={{
            padding: 16,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 6,
            color: '#dc3545',
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          Error loading orders: {error}
        </div>
      )}

      {loading ? (
        <div
          style={{
            padding: 32,
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 13,
          }}
        >
          Loading orders…
        </div>
      ) : orders.length === 0 && !error ? (
        <div
          style={{
            padding: 32,
            textAlign: 'center',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            color: 'var(--text-muted)',
            fontSize: 13,
          }}
        >
          No orders match the current filters.
        </div>
      ) : (
        <>
          {/* Phase 4.6 — selection action bar (Phase 28: also handles
              bulk Mark Shipped) */}
          <SelectionActionBar
            selectedCount={selectedOrderIds.size}
            onClearSelection={clearSelection}
            onProcessSelected={openBatchModalSelected}
            onProcessAllFiltered={openBatchModalAll}
            onShipSelected={openShipModal}
            disabled={!!activeJobId && activeJob?.status !== 'complete' && activeJob?.status !== 'failed' && activeJob?.status !== 'cancelled'}
          />

          <OrdersTable
            orders={orders}
            galleryLogos={galleryLogos}
            subGalleryFilter={subGalleryId ? parseInt(subGalleryId, 10) : null}
            selectedOrderIds={selectedOrderIds}
            onToggleSelected={toggleOrderSelected}
            allOnPageSelected={allOnPageSelected}
            onTogglePageSelection={togglePageSelection}
            onRowClick={(orderId) => {
              // Phase 14b: forward the current filter context to the
              // detail page so its Prev/Next buttons navigate within
              // the same filtered set. We include ALL active filter
              // values — even defaults — so the detail page receives
              // a complete picture of "what list view is this?"
              //
              // Hotfix #2: productionStatus defaults to '0' on this
              // page but the detail page defaults to 'all'. If we
              // dropped '0' here because it equals the list's default,
              // the detail page would assume 'all' and walk every
              // status. Always send it.
              const ctx = new URLSearchParams();
              if (workflow !== 'all') ctx.set('workflow', workflow);
              // productionStatus: always send (covers both '0' default
              // and explicit selections like '40' or 'all').
              ctx.set('productionStatus', productionStatus);
              if (galleryId) ctx.set('galleryId', galleryId);
              if (subGalleryId) ctx.set('subGalleryId', subGalleryId);
              if (shippingOption) ctx.set('shippingOption', shippingOption);
              // sort: always send too, since detail-page default
              // ('date_asc') matches list-page default but explicit
              // values matter for prev/next direction.
              ctx.set('sort', sort);
              const qs = ctx.toString();
              navigate(`/orders/${orderId}${qs ? '?' + qs : ''}`);
            }}
          />

          {pageSize !== 'all' && (
            <Pagination
              page={page}
              pageSize={parseInt(pageSize, 10)}
              currentBatchSize={orders.length}
              total={total}
              onPageChange={(p) => updateParam('page', p)}
            />
          )}
        </>
      )}

      {/* Phase 4.6 — batch process modal */}
      {batchModalOpen && (
        <BatchProcessModal
          allMode={batchAllMode}
          selectedCount={selectedOrderIds.size}
          onClose={() => setBatchModalOpen(false)}
          onConfirm={startBatch}
        />
      )}

      {/* Phase 4.6 — sticky job progress banner */}
      {activeJob && (
        <JobProgressBanner
          job={activeJob}
          onDismiss={dismissJobBanner}
          onCancel={cancelBatch}
        />
      )}

      {/* Phase 28 — bulk Mark Shipped confirmation modal */}
      {shipModalOpen && (
        <BatchShipModal
          selectedCount={selectedOrderIds.size}
          onClose={() => setShipModalOpen(false)}
          onConfirm={startBatchShip}
          shipping={shipping}
        />
      )}

      {/* Phase 28 — result banner shown after a bulk ship completes */}
      {shipResult && (
        <BatchShipResultBanner
          result={shipResult}
          onDismiss={dismissShipResult}
        />
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────

function FilterGroup({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

const selectStyle = {
  marginLeft: 6,
  padding: '6px 8px',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 4,
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

function OrdersTable({
  orders,
  galleryLogos,
  subGalleryFilter,
  selectedOrderIds,
  onToggleSelected,
  allOnPageSelected,
  onTogglePageSelection,
  onRowClick,
}) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
        }}
      >
        <thead
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-muted)',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          <tr>
            <th
              style={{
                padding: '10px 12px',
                width: 36,
                textAlign: 'center',
                borderBottom: '1px solid var(--border-color)',
              }}
            >
              <input
                type="checkbox"
                checked={allOnPageSelected}
                onChange={onTogglePageSelection}
                title="Select all on this page"
                style={{ cursor: 'pointer' }}
              />
            </th>
            <Th>Order #</Th>
            <Th>Date</Th>
            <Th>Customer</Th>
            <Th>Subject</Th>
            <Th>Gallery / Team</Th>
            <Th>Workflow</Th>
            <Th>Status</Th>
            <Th align="right">Items</Th>
            <Th align="right">Total</Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, index) => (
            <OrderRow
              key={o.orderId}
              order={o}
              galleryLogos={galleryLogos}
              subGalleryFilter={subGalleryFilter}
              isSelected={selectedOrderIds?.has(o.orderId) || false}
              onToggleSelected={(shiftKey) =>
                onToggleSelected(o.orderId, index, shiftKey)
              }
              onClick={() => onRowClick(o.orderId)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return (
    <th
      style={{
        padding: '10px 12px',
        textAlign: align,
        borderBottom: '1px solid var(--border-color)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

function OrderRow({ order, galleryLogos, subGalleryFilter, isSelected, onToggleSelected, onClick }) {
  // Subject = first non-empty subject field (typically athlete name)
  const subjectName =
    (order.subject?.fields || []).find((f) => f.value)?.value || '—';

  // Sibling info — distinct sub-galleries across line items
  const subGalleryIds = new Set(
    (order.lineItems || [])
      .map((li) => li.subGalleryId)
      .filter((id) => id > 0)
  );
  const subGalleryNames = new Set(
    (order.lineItems || [])
      .map((li) => li.subGalleryName)
      .filter((n) => n)
  );
  const otherTeamCount = Math.max(0, subGalleryIds.size - 1);

  // When team-filtered, count items in this team only
  const itemsInFilteredTeam =
    subGalleryFilter !== null
      ? (order.lineItems || []).filter(
          (li) => li.subGalleryId === subGalleryFilter
        ).length
      : null;

  // Bundled-shipment indicator: ship-to-home siblings ship as one unit
  const isBundledHome =
    order.isSibling && order.shipping?.workflow === 'ship_to_home';

  return (
    <tr
      onClick={onClick}
      style={{
        cursor: 'pointer',
        borderBottom: '1px solid var(--border-color)',
        background: isSelected ? 'rgba(74,127,193,0.08)' : undefined,
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.background = 'var(--bg-secondary)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.background = '';
      }}
    >
      {/* Checkbox cell. Phase 54 fix: the input's own onChange now
          drives selection. Previously onChange was a no-op delegating
          to the td's onClick, but the input ALSO called
          stopPropagation, which severed that delegation — clicking the
          actual box did nothing; only the thin td padding around it
          toggled. The td still stops click propagation so the checkbox
          never triggers the row's open-order navigation; onChange is a
          separate synthetic event so it still fires.
          e.nativeEvent.shiftKey carries the modifier for range select. */}
      <td
        style={{ padding: '10px 12px', textAlign: 'center' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => onToggleSelected(e.nativeEvent.shiftKey)}
          style={{ cursor: 'pointer' }}
        />
      </td>
      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {order.orderId}
        {/* Phase 61: most-recent batch process outcome. Surfaced at the start
            of the row so a failed/partial order is unavoidable during batch
            review (when the operator isn't on the detail page). */}
        {order.lastProcess && <LastProcessBadge lastProcess={order.lastProcess} />}
      </td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
        {formatOrderDate(order.orderDate)}
      </td>
      <td style={{ padding: '10px 12px' }}>
        {order.customer?.firstName} {order.customer?.lastName}
      </td>
      <td style={{ padding: '10px 12px' }}>{subjectName}</td>
      <td style={{ padding: '10px 12px' }}>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <span>{order.galleryName || '—'}</span>
          {/* Phase 58a: "Missing Logo" badge — same detection as the
              order-detail LogoWarningBanner, surfaced earlier so the
              operator catches it before clicking into detail. Soft-fail:
              no badge when galleryId === 0 (no primary gallery) or the
              registry hasn't loaded / failed to load. */}
          {galleryLogos &&
            order.galleryId > 0 &&
            !galleryLogos[order.galleryId] && (
              <MissingLogoBadge galleryId={order.galleryId} />
            )}
        </div>
        <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{order.subGalleryName || '—'}</span>
          {otherTeamCount > 0 && (
            <span
              title={`Also: ${[...subGalleryNames]
                .filter((n) => n !== order.subGalleryName)
                .join(', ')}`}
              style={{
                fontSize: 10,
                padding: '2px 6px',
                background: 'rgba(156,106,222,0.15)',
                border: '1px solid rgba(156,106,222,0.4)',
                color: '#b48af0',
                borderRadius: 10,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              +{otherTeamCount} {otherTeamCount === 1 ? 'team' : 'teams'}
            </span>
          )}
        </div>
      </td>
      <td style={{ padding: '10px 12px' }}>
        <WorkflowBadge
          workflow={order.shipping?.workflow}
          uncategorized={order.shipping?.uncategorized}
        />
        {isBundledHome && (
          <div
            style={{
              marginTop: 4,
              fontSize: 10,
              color: '#4caf50',
            }}
            title="Sibling order — all items ship together to home"
          >
            📦 Bundle ships together
          </div>
        )}
        {/* Phase 78: customer notes (order-level order_notes OR per-line-item
            cart_notes). Sits BEFORE InstantPackBadge by semantic priority —
            "stop and read this" > "fast-track candidate" > "previously broke."
            The badge gets the eye-attention closest to the order number. */}
        <CustomerNotesBadge order={order} />
        {/* Phase 60a: instant-pack eligibility — every physical item in the
            order is marked Instant-Ship Eligible in Settings → Packaging.
            Display-only in 60a (bulk actions land in 60b). */}
        {order.isInstantPackEligible && <InstantPackBadge />}
      </td>
      <td style={{ padding: '10px 12px' }}>
        <StatusBadge status={order.productionStatus} />
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {(order.lineItems || []).length}
        {itemsInFilteredTeam !== null && itemsInFilteredTeam !== (order.lineItems || []).length && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            ({itemsInFilteredTeam} for this team)
          </div>
        )}
      </td>
      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}>
        ${(order.totals?.total || 0).toFixed(2)}
      </td>
    </tr>
  );
}

// Phase 58a: per-row badge that surfaces the same "no logo set for
// this gallery" condition the order-detail LogoWarningBanner shows —
// earlier in the workflow so operators catch it during batch-
// processing decisions. Clicking jumps to Settings → Gallery Assets
// with ?galleryId=<id> so LogosSection pre-selects this gallery in the
// uploader (one click to the right control instead of manual scroll).
function MissingLogoBadge({ galleryId }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the row's onClick (which navigates to order detail).
        e.stopPropagation();
        navigate(
          `/settings/gallery-assets?galleryId=${encodeURIComponent(galleryId)}`
        );
      }}
      title="No logo set for this gallery — click to upload"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        background: 'rgba(220,53,69,0.12)',
        color: '#dc3545',
        border: '1px solid rgba(220,53,69,0.4)',
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        fontFamily: 'inherit',
        lineHeight: 1.2,
      }}
    >
      <span>⚠</span>
      <span>Missing Logo</span>
    </button>
  );
}

// Phase 60a: per-row "Instant-Ship" badge. Rendered only when the order's
// canonical shape carries isInstantPackEligible (≥1 physical item, and every
// physical item's SKU is marked Instant-Ship Eligible in packaging config).
// Filled style (vs the translucent outline workflow badges) so it reads as a
// distinct class — a readiness state, not a shipping category. Display-only:
// no click action in 60a; bulk actions arrive in 60b.
function InstantPackBadge() {
  return (
    <div
      title="Instant-Ship eligible — every physical item in this order is marked eligible in Settings → Packaging"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 4,
        padding: '2px 8px',
        background: '#4263eb',
        color: '#fff',
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
    >
      <span>⚡</span>
      <span>Instant-Ship</span>
    </div>
  );
}

// Phase 78: "stop and read" badge for orders carrying customer-entered notes.
//
// Two sources, with priority encoded in the tooltip text (the load-bearing UX
// rule — see SPEC §78). The badge is rendered iff at least one source has
// substantive (non-whitespace-only) content:
//
//   (1) order.customerNotes — order-level checkout note from ms_orders.order_notes.
//   (2) order.hasLineItemNotes + lineItemNotesPreview + lineItemNotesCount —
//       per-line-item customer notes precomputed server-side from ms_cart
//       (and ms_cart_archive) cart_notes via _lineItemNotesExistsSql. The
//       SQL-side parity check uses REGEXP '[^[:space:]]' to match JS's
//       .trim() semantic exactly — see SPEC §78 / the sytistDbService
//       comment block at _lineItemNotesExistsSql for the parity rule.
//
// Tooltip priority rule (verbatim per Phase 78 spec):
//   - order_notes only      → tooltip = order_notes (up to 150 chars + ellipsis)
//   - cart_notes only       → tooltip = "Line item notes: [first cart_note, 100 chars] (+N more)" when N>1
//   - both                  → tooltip = order_notes (150) + " · Line item notes: [first cart_note, 80 chars] (+N more)" when N>1
//
// `buildCustomerNoteTooltip(order)` is exported as a named helper alongside
// the component so verify-customer-notes-badge.js drives the same string
// builder the badge renders, without rendering React. The function is the
// single source of truth for the tooltip rule; the component only handles
// the show/hide decision and the styled <div>.
const ORDER_NOTES_TRUNCATE_ALONE = 150;
const ORDER_NOTES_TRUNCATE_BOTH = 150;
const LINE_NOTES_TRUNCATE_ALONE = 100;
const LINE_NOTES_TRUNCATE_BOTH = 80;

export function buildCustomerNoteTooltip(order) {
  const cn = (order.customerNotes || '').trim();
  const hasOrder = cn.length > 0;
  const hasLine = !!order.hasLineItemNotes;
  if (!hasOrder && !hasLine) return null;

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  const linePreview = (order.lineItemNotesPreview || '').trim();
  const lineCount = Number(order.lineItemNotesCount) || 0;
  const moreSuffix = lineCount > 1 ? ` (+${lineCount - 1} more)` : '';

  if (hasOrder && hasLine) {
    return (
      truncate(cn, ORDER_NOTES_TRUNCATE_BOTH) +
      ' · Line item notes: ' +
      truncate(linePreview, LINE_NOTES_TRUNCATE_BOTH) +
      moreSuffix
    );
  }
  if (hasOrder) {
    return truncate(cn, ORDER_NOTES_TRUNCATE_ALONE);
  }
  // hasLine only
  return (
    'Line item notes: ' + truncate(linePreview, LINE_NOTES_TRUNCATE_ALONE) + moreSuffix
  );
}

function CustomerNotesBadge({ order }) {
  const tooltip = buildCustomerNoteTooltip(order);
  if (!tooltip) return null;
  return (
    <div
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 4,
        padding: '2px 8px',
        // Phase 78: amber-orange #fd7e14 — distinct from LastProcessBadge's
        // partial #e0901b and InstantPackBadge's blue #4263eb. "Needs
        // attention" tone, not "warning" red, not "fast-track" blue.
        background: '#fd7e14',
        color: '#fff',
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
    >
      <span>💬</span>
      <span>Note</span>
    </div>
  );
}

// Phase 61: orders-list badge surfacing the most-recent BATCH process outcome
// (order.lastProcess, attached by the orders route from process-history). The
// high-blindness moment is batch processing — the operator isn't on the detail
// page to see the red banner — so a held order must be visible right in the
// list. Red = the fail-closed gate held the order (nothing shipped); amber =
// partial (some teams OK, some failed). Clears when a later successful
// reprocess overrides the history entry. Hover shows the error + timestamp.
function LastProcessBadge({ lastProcess }) {
  if (!lastProcess) return null;
  const failed = lastProcess.status === 'failed';
  const c = failed
    ? { bg: '#dc3545', label: 'Last process failed' }
    : { bg: '#e0901b', label: 'Last process partial' };
  const when = lastProcess.at ? new Date(lastProcess.at).toLocaleString() : '';
  return (
    <div
      title={`${lastProcess.error || lastProcess.status}${when ? ` — ${when}` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 4,
        padding: '2px 8px',
        background: c.bg,
        color: '#fff',
        borderRadius: 10,
        fontSize: 10,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
    >
      <span>⚠</span>
      <span>{c.label}</span>
    </div>
  );
}

function WorkflowBadge({ workflow, uncategorized }) {
  const colors = {
    ship_to_home: { bg: 'rgba(76,175,80,0.15)', fg: '#4caf50', border: 'rgba(76,175,80,0.4)' },
    ship_to_managers: { bg: 'rgba(156,106,222,0.15)', fg: '#b48af0', border: 'rgba(156,106,222,0.4)' },
    ship_to_league: { bg: 'rgba(55,182,207,0.15)', fg: '#37b6cf', border: 'rgba(55,182,207,0.4)' },
    // Phase 60: digital-only (no-ship) — amber, distinct from the ship-to hues.
    digital: { bg: 'rgba(255,179,0,0.15)', fg: '#ffb300', border: 'rgba(255,179,0,0.4)' },
  };
  const labels = {
    ship_to_home: 'Home',
    ship_to_managers: 'Managers',
    ship_to_league: 'League',
    digital: 'Digital',
  };
  const c = colors[workflow] || { bg: 'var(--bg-input)', fg: 'var(--text-muted)', border: 'var(--border-color)' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
      title={uncategorized ? 'Workflow categorized via numeric fallback — add to shipping-option-mappings.json' : undefined}
    >
      {labels[workflow] || workflow || '—'}
      {uncategorized && <span style={{ fontSize: 9 }}>⚠</span>}
    </span>
  );
}

function StatusBadge({ status }) {
  if (!status) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const id = status.id;
  const map = {
    0: { fg: 'var(--accent)', bg: 'rgba(232,123,52,0.12)' },        // Queue
    40: { fg: '#5b8def', bg: 'rgba(91,141,239,0.12)' },             // Printing
    39: { fg: '#4caf50', bg: 'rgba(76,175,80,0.12)' },              // Shipped
    12: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)' },             // Office Atten
    14: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)' },             // Open Invoice
    28: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)' },             // Flagged-Customer Reply
    73: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)' },             // Atten-Specialty
    26: { fg: '#9e9e9e', bg: 'rgba(158,158,158,0.12)' },            // Digital Image
    37: { fg: '#9e9e9e', bg: 'rgba(158,158,158,0.12)' },            // 16x20 In House
  };
  const c = map[id] || { fg: 'var(--text-secondary)', bg: 'var(--bg-input)' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: c.bg,
        color: c.fg,
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {status.name}
    </span>
  );
}

function Pagination({ page, pageSize, currentBatchSize, total, onPageChange }) {
  // Phase 14a: now that the server returns an absolute total (the
  // COUNT(*) of matching rows, not just the page batch size), use it
  // for "X-Y of Z" and to gate the Next button precisely.
  //
  // When `total` is unknown (older API responses or pageSize='all'),
  // we fall back to the pre-14a heuristic: assume there's more if
  // the current page is full.
  const hasTotal = Number.isFinite(total) && total >= 0;
  const startNum = (page - 1) * pageSize + 1;
  const endNum = startNum + currentBatchSize - 1;
  const isLastPage = hasTotal
    ? endNum >= total
    : currentBatchSize < pageSize;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 0',
        fontSize: 12,
        color: 'var(--text-muted)',
      }}
    >
      <div>
        {currentBatchSize > 0 ? (
          hasTotal ? (
            <>
              Showing {startNum}–{endNum} of{' '}
              <strong style={{ color: 'var(--text-secondary)' }}>
                {total.toLocaleString()}
              </strong>
            </>
          ) : (
            <>Showing {startNum}–{endNum}</>
          )
        ) : hasTotal ? (
          <>0 of {total.toLocaleString()}</>
        ) : (
          <>—</>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          style={paginationButtonStyle(page <= 1)}
        >
          ← Previous
        </button>
        <div
          style={{
            padding: '6px 12px',
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}
        >
          {hasTotal && pageSize > 0 ? (
            <>
              Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
            </>
          ) : (
            <>Page {page}</>
          )}
        </div>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={isLastPage}
          style={paginationButtonStyle(isLastPage)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function paginationButtonStyle(disabled) {
  return {
    padding: '6px 12px',
    background: 'var(--bg-card)',
    color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 4,
    fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
  };
}

function formatOrderDate(dateStr) {
  if (!dateStr) return '—';
  // dateStr is "YYYY-MM-DD HH:MM:SS" (from Sytist + dateStrings:true)
  const [datePart, timePart] = String(dateStr).split(' ');
  if (!datePart) return dateStr;
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthName = months[m - 1] || '?';

  let time = '';
  if (timePart) {
    const [hh, mm] = timePart.split(':').map(Number);
    const hour12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
    const ampm = hh >= 12 ? 'pm' : 'am';
    time = ` ${hour12}:${String(mm || 0).padStart(2, '0')}${ampm}`;
  }

  return `${monthName} ${d}${time}`;
}

// ──────────────────────────────────────────────────────────
// Phase 4.6 — Batch processing UI
// ──────────────────────────────────────────────────────────

/**
 * Sticky action bar above the orders table. Always visible (so the
 * "Process all filtered" affordance is reachable even when no rows are
 * checked). Selected count + clear shows up only when ≥1 selected.
 */
function SelectionActionBar({
  selectedCount,
  onClearSelection,
  onProcessSelected,
  onProcessAllFiltered,
  onShipSelected,
  disabled,
}) {
  const hasSelection = selectedCount > 0;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        marginBottom: 12,
        background: hasSelection ? 'rgba(74,127,193,0.08)' : 'var(--bg-card)',
        border: `1px solid ${hasSelection ? 'rgba(74,127,193,0.4)' : 'var(--border-color)'}`,
        borderRadius: 6,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>
        {hasSelection ? (
          <>
            <strong>{selectedCount}</strong> selected
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>
            Select orders with the checkboxes — or process all filtered orders.
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {hasSelection && (
          <button
            onClick={onClearSelection}
            disabled={disabled}
            style={{
              background: 'transparent',
              border: '1px solid var(--border-color)',
              color: 'var(--text-secondary)',
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 12,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Clear selection
          </button>
        )}

        <button
          onClick={onProcessSelected}
          disabled={disabled || !hasSelection}
          style={{
            background: hasSelection ? '#4a7fc1' : 'var(--bg-input)',
            border: `1px solid ${hasSelection ? '#4a7fc1' : 'var(--border-color)'}`,
            color: hasSelection ? '#ffffff' : 'var(--text-muted)',
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: disabled || !hasSelection ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          Process selected ({selectedCount})
        </button>

        {/* Phase 28 — bulk Mark Shipped */}
        {onShipSelected && (
          <button
            onClick={onShipSelected}
            disabled={disabled || !hasSelection}
            style={{
              background: hasSelection ? '#4caf50' : 'var(--bg-input)',
              border: `1px solid ${hasSelection ? '#4caf50' : 'var(--border-color)'}`,
              color: hasSelection ? '#ffffff' : 'var(--text-muted)',
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: disabled || !hasSelection ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: disabled ? 0.6 : 1,
            }}
            title="Mark selected orders as Shipped (only orders currently in Printing will be updated)"
          >
            Mark Shipped ({selectedCount})
          </button>
        )}

        <button
          onClick={onProcessAllFiltered}
          disabled={disabled}
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-secondary)',
            padding: '6px 14px',
            borderRadius: 6,
            fontSize: 12,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: disabled ? 0.6 : 1,
          }}
          title="Process every order matching the current filters (up to 500)"
        >
          Process all filtered
        </button>
      </div>
    </div>
  );
}

/**
 * Modal that confirms a batch process and lets the operator opt into
 * team dividers and QR sheets. Closes on ESC or background click.
 */
function BatchProcessModal({ allMode, selectedCount, onClose, onConfirm }) {
  const [generateDivider, setGenerateDivider] = useState(false);
  const [generateQrSheet, setGenerateQrSheet] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm({ generateDivider, generateQrSheet });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          padding: 24,
          width: '100%',
          maxWidth: 500,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            paddingBottom: 12,
            borderBottom: '1px solid var(--border-color)',
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {allMode ? 'Process all filtered orders' : `Process ${selectedCount} order${selectedCount === 1 ? '' : 's'}`}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 22,
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          Each order will be downloaded, imposed, and have its slip + .txt
          written. Sibling orders split into per-team sub-orders automatically.
          {allMode && (
            <div
              style={{
                marginTop: 8,
                padding: 8,
                background: 'rgba(224,179,65,0.08)',
                border: '1px solid rgba(224,179,65,0.3)',
                borderRadius: 4,
                color: '#e0b341',
                fontSize: 12,
              }}
            >
              ⚠ Will fetch every matching order from the server (cap 500).
            </div>
          )}
        </div>

        <div style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 13,
              cursor: 'pointer',
              padding: 8,
              borderRadius: 4,
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
            }}
          >
            <input
              type="checkbox"
              checked={generateDivider}
              onChange={(e) => setGenerateDivider(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 500 }}>Generate team dividers</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                One 5×8 divider sheet per team for non-home orders.
              </div>
            </div>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 13,
              cursor: 'pointer',
              padding: 8,
              borderRadius: 4,
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
            }}
          >
            <input
              type="checkbox"
              checked={generateQrSheet}
              onChange={(e) => setGenerateQrSheet(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 500 }}>Generate QR sheet</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                Printable 8.5×11 sheet of QR codes (20 per page) for batch scanning.
              </div>
            </div>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              background: 'transparent',
              border: '1px solid var(--border-color)',
              color: 'var(--text-secondary)',
              padding: '8px 14px',
              borderRadius: 6,
              fontSize: 12,
              cursor: submitting ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            style={{
              background: '#4a7fc1',
              border: '1px solid #4a7fc1',
              color: '#ffffff',
              padding: '8px 18px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: submitting ? 'wait' : 'pointer',
              fontFamily: 'inherit',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Starting…' : 'Start processing'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Phase 28 — Confirmation modal for "Mark Selected Shipped".
 *
 * Doesn't pre-check eligibility — the server validates per-order
 * and reports back which were shipped vs skipped. That keeps the
 * modal fast (no extra round-trip) and the source of truth on the
 * server. The modal explains this so the operator knows what will
 * happen.
 */
function BatchShipModal({ selectedCount, onClose, onConfirm, shipping }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !shipping) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, shipping]);

  return (
    <div
      onClick={shipping ? undefined : onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          padding: 24,
          width: '100%',
          maxWidth: 480,
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>
          Mark {selectedCount} order{selectedCount === 1 ? '' : 's'} as Shipped?
        </h3>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            marginBottom: 20,
            lineHeight: 1.5,
          }}
        >
          Only orders currently in <strong>Printing</strong> status will be
          updated to <strong>Shipped</strong>. Orders in other statuses
          (Queue, Shipped, etc.) will be skipped — you'll see a summary
          after.
          <br />
          <br />
          Each transition is logged. This is reversible from the order
          detail page.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={shipping}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              fontSize: 13,
              cursor: shipping ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={shipping}
            style={{
              padding: '8px 18px',
              background: '#4caf50',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
              cursor: shipping ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {shipping ? 'Shipping…' : 'Yes, mark shipped'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Phase 28 — Result banner shown after a bulk-ship operation
 * completes. Displays the shipped/skipped counts and (on hover/click)
 * a per-order breakdown of any failures.
 */
function BatchShipResultBanner({ result, onDismiss }) {
  const [showDetails, setShowDetails] = useState(false);
  const { shippedCount = 0, skippedCount = 0, results = [], error } = result;
  const skipped = results.filter((r) => !r.ok);

  return (
    <div
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        zIndex: 999,
        background: 'var(--bg-card)',
        border: `1px solid ${error ? '#dc3545' : '#4caf50'}`,
        borderRadius: 8,
        padding: 16,
        minWidth: 340,
        maxWidth: 480,
        boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          {error ? (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#dc3545', marginBottom: 4 }}>
                Batch ship failed
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{error}</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#4caf50', marginBottom: 4 }}>
                Shipped {shippedCount} · Skipped {skippedCount}
              </div>
              {skippedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowDetails((v) => !v)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--accent, #4a7fc1)',
                    fontSize: 12,
                    padding: 0,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textDecoration: 'underline',
                  }}
                >
                  {showDetails ? 'Hide' : 'Show'} skipped details
                </button>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: 18,
            cursor: 'pointer',
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {showDetails && skipped.length > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            background: 'var(--bg-input)',
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {skipped.map((r) => (
            <div
              key={r.orderId}
              style={{
                padding: '4px 0',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                #{r.orderId}
              </span>
              <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                {r.code === 'not_eligible'
                  ? `not in Printing (status ${r.currentStatus})`
                  : r.error || r.code || 'unknown'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Bottom-of-screen progress banner for an active batch job. Updates via
 * polling in the parent component. Stays until the operator dismisses
 * it (so they can review the results).
 */
function JobProgressBanner({ job, onDismiss, onCancel }) {
  const navigate = useNavigate();
  const isComplete = job.status === 'complete';
  const isFailed = job.status === 'failed';
  const isCancelled = job.status === 'cancelled';
  const isCancelling = !!job.cancelRequested && !isComplete && !isFailed && !isCancelled;
  const isRunning = !isComplete && !isFailed && !isCancelled;

  // Phase 61: classify each per-order result the SAME way processHistoryService
  // does, so the banner, the orders-list badge, and the history page all agree.
  // A fail-closed gate failure sets subOrders[].success=false (NOT a top-level
  // r.error), so the old "errorCount = r.error" missed full gate failures and
  // the old "partialCount = !every(success)" mislabeled a fully-failed
  // single-sub-order order as "partial". Proper rule: failed = top-level error
  // OR no sub-order succeeded; partial = some-but-not-all succeeded.
  const classify = (r) => {
    if (r.error) return { status: 'failed', error: r.error };
    const subs = r.subOrders || [];
    if (subs.length > 0 && subs.every((s) => s.success)) return { status: 'success', error: null };
    const someOk = subs.some((s) => s.success);
    const firstErr = (subs.find((s) => !s.success && s.error) || {}).error || 'failed';
    return { status: someOk ? 'partial' : 'failed', error: firstErr };
  };
  const classified = (job.results || []).map((r) => ({ r, ...classify(r) }));
  const successCount = classified.filter((c) => c.status === 'success').length;
  const partialCount = classified.filter((c) => c.status === 'partial').length;
  const errorCount = classified.filter((c) => c.status === 'failed').length;
  const attentionOrders = classified.filter((c) => c.status !== 'success');

  const pct = job.total ? Math.round((job.completed / job.total) * 100) : 0;

  // Header label changes based on state. Cancel-requested gets its own
  // label so the operator knows their click registered.
  const headerLabel = isComplete
    ? '✓ Batch complete'
    : isFailed
    ? '✗ Batch failed'
    : isCancelled
    ? `⊘ Batch cancelled (${job.completed}/${job.total} done)`
    : isCancelling
    ? `Cancelling after current order… ${job.completed}/${job.total}`
    : `Processing… ${job.completed} / ${job.total}`;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: 360,
        background: 'var(--bg-card)',
        border: `1px solid ${
          isCancelled
            ? 'rgba(158,158,158,0.5)'
            : isComplete && errorCount === 0 && partialCount === 0
            ? 'rgba(76,175,80,0.5)'
            : isFailed || errorCount > 0
            ? 'rgba(220,53,69,0.5)'
            : 'rgba(74,127,193,0.5)'
        }`,
        borderRadius: 8,
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        padding: 16,
        zIndex: 999,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{headerLabel}</div>
        {!isRunning && (
          <button
            onClick={onDismiss}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 18,
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div
        style={{
          width: '100%',
          height: 6,
          background: 'var(--bg-input)',
          borderRadius: 3,
          overflow: 'hidden',
          marginBottom: 10,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: isFailed
              ? '#dc3545'
              : isCancelled
              ? '#9e9e9e'
              : isComplete
              ? '#4caf50'
              : '#4a7fc1',
            transition: 'width 0.3s ease',
          }}
        />
      </div>

      {(isComplete || isRunning || isCancelled) && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          {successCount > 0 && (
            <span style={{ color: '#4caf50' }}>✓ {successCount} ok</span>
          )}
          {partialCount > 0 && (
            <span style={{ color: '#e0b341' }}>⚠ {partialCount} partial</span>
          )}
          {errorCount > 0 && (
            <span style={{ color: '#dc3545' }}>✗ {errorCount} failed</span>
          )}
        </div>
      )}

      {/* Phase 61: ALWAYS-visible enumeration of failed/partial orders (not
          behind a "show details" expand). Batch processing is the high-
          blindness moment — a held order must be unavoidable here, since the
          operator isn't on the detail page. Each row links to the order so the
          operator can fix the source and reprocess. */}
      {(isComplete || isCancelled) && attentionOrders.length > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: 8,
            background: 'rgba(220,53,69,0.08)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 4,
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#dc3545', marginBottom: 4 }}>
            {attentionOrders.length} order{attentionOrders.length === 1 ? '' : 's'} need attention — not shipped
          </div>
          {attentionOrders.map((c, i) => (
            <div
              key={i}
              onClick={() => navigate(`/orders/${c.r.orderId}`)}
              title={c.error || c.status}
              style={{
                cursor: 'pointer',
                fontSize: 11,
                padding: '2px 0',
                color: c.status === 'failed' ? '#dc3545' : '#e0b341',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {c.status === 'failed' ? '✗' : '⚠'} #{c.r.orderNumber || c.r.orderId} — {c.error || c.status}
            </div>
          ))}
        </div>
      )}

      {/* Phase 13d: ShipStation summary for the batch. Only meaningful
          when the batch is complete; running batches haven't aggregated
          this yet (the summary is computed at end-of-batch). */}
      {isComplete && job.shipstationSummary && (
        <BatchSSSummary summary={job.shipstationSummary} />
      )}

      {/* Phase 4.7 — graceful cancel button. Visible while the batch
          is running and not already cancelling. Lets the current order
          finish, then halts. */}
      {isRunning && !isCancelling && (
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => {
              if (
                window.confirm(
                  'Stop the batch after the current order finishes?\n\n' +
                    'Already-completed orders are NOT rolled back. The Darkroom watcher ' +
                    "may have already picked them up, so you'll see partial output."
                )
              ) {
                onCancel();
              }
            }}
            style={{
              background: 'transparent',
              border: '1px solid rgba(220,53,69,0.5)',
              color: '#dc3545',
              padding: '5px 10px',
              borderRadius: 4,
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
          >
            Stop after current order
          </button>
        </div>
      )}

      {isCancelling && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: '#e0b341',
            fontStyle: 'italic',
          }}
        >
          Stop requested — finishing the current order, then halting…
        </div>
      )}

      {isFailed && job.error && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: '#dc3545',
          }}
        >
          {job.error}
        </div>
      )}

      {(job.qrSheetPaths && job.qrSheetPaths.length > 0) && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          📋 QR sheet{job.qrSheetPaths.length === 1 ? '' : 's'} written:
          {job.qrSheetPaths.map((p, i) => (
            <div
              key={i}
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 10,
                marginLeft: 8,
                wordBreak: 'break-all',
              }}
            >
              {p}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Phase 13d: ShipStation summary inside the batch banner ──
//
// Aggregated counts of SS create outcomes for the just-completed
// batch. Shows alongside the regular sub-order counts so operators
// see at a glance: "20 processed, 18 sent to SS, 2 failed."
//
// If failures exist, expose an inline retry list — each failed
// order can be retried individually without reprocessing photos/
// imposition. Server's POST /api/shipstation/orders/:id/retry-send
// uses processingService.retryShipStationForOrder.
//
// Retry success removes the entry from the displayed list so the
// operator can watch the failures drain to zero.

function BatchSSSummary({ summary }) {
  const [retryingId, setRetryingId] = React.useState(null);
  const [remaining, setRemaining] = React.useState(summary.failures || []);
  const [errors, setErrors] = React.useState({});

  async function handleRetry(orderId) {
    setRetryingId(orderId);
    setErrors((e) => ({ ...e, [orderId]: null }));
    try {
      const data = await api.post(
        `/api/shipstation/orders/${orderId}/retry-send`,
        {}
      );
      if (data.result?.ok) {
        setRemaining((rs) => rs.filter((r) => r.orderId !== orderId));
      } else {
        setErrors((e) => ({
          ...e,
          [orderId]: data.result?.error || 'Unknown error',
        }));
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [orderId]: err.message }));
    } finally {
      setRetryingId(null);
    }
  }

  const totalAttempted =
    summary.created + summary.skipped + summary.failed;
  if (totalAttempted === 0) return null;

  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 8,
        borderTop: '1px solid var(--border-color)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          marginBottom: 4,
          fontWeight: 500,
        }}
      >
        ShipStation:
      </div>
      <div
        style={{
          fontSize: 11,
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: remaining.length > 0 ? 8 : 0,
        }}
      >
        {summary.created > 0 && (
          <span style={{ color: '#4caf50' }}>
            ✓ {summary.created} sent
          </span>
        )}
        {summary.skipped > 0 && (
          <span style={{ color: 'var(--text-muted)' }}>
            ↻ {summary.skipped} skipped
          </span>
        )}
        {summary.failed > 0 && (
          <span style={{ color: '#dc3545' }}>
            ✗ {summary.failed} failed
          </span>
        )}
        {summary.driftCount > 0 && (
          <span
            style={{ color: '#e0b341' }}
            title="ShipStation reassigned the packageCode for these orders. Usually cosmetic."
          >
            ⚠ {summary.driftCount} drift
          </span>
        )}
      </div>

      {remaining.length > 0 && (
        <div
          style={{
            background: 'rgba(220,53,69,0.05)',
            border: '1px solid rgba(220,53,69,0.2)',
            borderRadius: 4,
            padding: 8,
            fontSize: 11,
          }}
        >
          <div
            style={{
              fontWeight: 500,
              color: '#dc3545',
              marginBottom: 4,
            }}
          >
            Retry failed SS sends:
          </div>
          {remaining.map((f) => (
            <div
              key={f.orderId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                borderTop: '1px solid rgba(220,53,69,0.1)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>
                  Order {f.orderNumber || f.orderId}
                </div>
                <div
                  style={{
                    color: 'var(--text-muted)',
                    fontSize: 10,
                    wordBreak: 'break-word',
                  }}
                >
                  {errors[f.orderId] || f.error}
                </div>
              </div>
              <button
                onClick={() => handleRetry(f.orderId)}
                disabled={retryingId === f.orderId}
                style={{
                  padding: '3px 8px',
                  background:
                    retryingId === f.orderId
                      ? 'transparent'
                      : 'rgba(74,127,193,0.15)',
                  border: '1px solid rgba(74,127,193,0.4)',
                  color: retryingId === f.orderId ? 'var(--text-muted)' : '#4a7fc1',
                  borderRadius: 3,
                  fontSize: 10,
                  fontWeight: 500,
                  cursor: retryingId === f.orderId ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {retryingId === f.orderId ? 'Retrying…' : 'Retry SS'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
