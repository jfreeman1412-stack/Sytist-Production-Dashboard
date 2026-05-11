import React, { useEffect, useMemo, useState } from 'react';
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

  // Orders data
  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [softCapHit, setSoftCapHit] = useState(false);

  // Phase 4.6 — batch processing state
  // selectedOrderIds: which orders the operator has checked. Cleared
  // automatically whenever filters change (so a filter-then-process
  // workflow doesn't accidentally include orders from a prior view).
  const [selectedOrderIds, setSelectedOrderIds] = useState(() => new Set());
  // Modal visibility for the batch confirm dialog
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  // "Process all filtered" mode — when true, the modal will pull every
  // matching order ID (up to a limit) instead of just the selected ones.
  const [batchAllMode, setBatchAllMode] = useState(false);
  // Active batch job (when set, a sticky banner shows progress)
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeJob, setActiveJob] = useState(null);

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
  ]);

  // Phase 4.6 — clear selection when filters change so the operator
  // never accidentally batch-processes orders from a prior filter view.
  useEffect(() => {
    setSelectedOrderIds(new Set());
  }, [workflow, productionStatus, galleryId, subGalleryId, shippingOption]);

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

  // ─── Phase 4.6 — selection helpers ─────────────────────
  function toggleOrderSelected(orderId) {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
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

    try {
      const response = await api.post('/api/sytist/process/batch', {
        orderIds,
        generateDivider,
        generateQrSheet,
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

        {/* Clear all filters shortcut */}
        {(galleryId || subGalleryId || shippingOption || workflow !== 'all') && (
          <button
            onClick={() => {
              setSearchParams({ productionStatus: '0' }, { replace: false });
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
              shippingOption
                ? ' your filters'
                : ''}
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
          {/* Phase 4.6 — selection action bar */}
          <SelectionActionBar
            selectedCount={selectedOrderIds.size}
            onClearSelection={clearSelection}
            onProcessSelected={openBatchModalSelected}
            onProcessAllFiltered={openBatchModalAll}
            disabled={!!activeJobId && activeJob?.status !== 'complete' && activeJob?.status !== 'failed' && activeJob?.status !== 'cancelled'}
          />

          <OrdersTable
            orders={orders}
            subGalleryFilter={subGalleryId ? parseInt(subGalleryId, 10) : null}
            selectedOrderIds={selectedOrderIds}
            onToggleSelected={toggleOrderSelected}
            allOnPageSelected={allOnPageSelected}
            onTogglePageSelection={togglePageSelection}
            onRowClick={(orderId) => {
              navigate(`/orders/${orderId}`);
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
          {orders.map((o) => (
            <OrderRow
              key={o.orderId}
              order={o}
              subGalleryFilter={subGalleryFilter}
              isSelected={selectedOrderIds?.has(o.orderId) || false}
              onToggleSelected={() => onToggleSelected(o.orderId)}
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

function OrderRow({ order, subGalleryFilter, isSelected, onToggleSelected, onClick }) {
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
      {/* Checkbox cell — clicks don't propagate to the row */}
      <td
        style={{ padding: '10px 12px', textAlign: 'center' }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelected();
        }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => {
            /* handled via td click */
          }}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'pointer' }}
        />
      </td>
      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
        {order.orderId}
      </td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
        {formatOrderDate(order.orderDate)}
      </td>
      <td style={{ padding: '10px 12px' }}>
        {order.customer?.firstName} {order.customer?.lastName}
      </td>
      <td style={{ padding: '10px 12px' }}>{subjectName}</td>
      <td style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {order.galleryName || '—'}
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

function WorkflowBadge({ workflow, uncategorized }) {
  const colors = {
    ship_to_home: { bg: 'rgba(76,175,80,0.15)', fg: '#4caf50', border: 'rgba(76,175,80,0.4)' },
    ship_to_managers: { bg: 'rgba(156,106,222,0.15)', fg: '#b48af0', border: 'rgba(156,106,222,0.4)' },
    ship_to_league: { bg: 'rgba(55,182,207,0.15)', fg: '#37b6cf', border: 'rgba(55,182,207,0.4)' },
  };
  const labels = {
    ship_to_home: 'Home',
    ship_to_managers: 'Managers',
    ship_to_league: 'League',
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
 * Bottom-of-screen progress banner for an active batch job. Updates via
 * polling in the parent component. Stays until the operator dismisses
 * it (so they can review the results).
 */
function JobProgressBanner({ job, onDismiss, onCancel }) {
  const isComplete = job.status === 'complete';
  const isFailed = job.status === 'failed';
  const isCancelled = job.status === 'cancelled';
  const isCancelling = !!job.cancelRequested && !isComplete && !isFailed && !isCancelled;
  const isRunning = !isComplete && !isFailed && !isCancelled;

  const successCount = (job.results || []).filter(
    (r) => !r.error && r.subOrders && r.subOrders.every((s) => s.success)
  ).length;
  const errorCount = (job.results || []).filter((r) => !!r.error).length;
  const partialCount = (job.results || []).filter(
    (r) => !r.error && r.subOrders && !r.subOrders.every((s) => s.success)
  ).length;

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
