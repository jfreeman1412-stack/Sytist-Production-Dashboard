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
          <OrdersTable
            orders={orders}
            subGalleryFilter={subGalleryId ? parseInt(subGalleryId, 10) : null}
            onRowClick={(orderId) => {
              // Preserve current filters in browser history so back-button
              // returns to the same view.
              navigate(`/orders/${orderId}`);
            }}
          />

          {pageSize !== 'all' && (
            <Pagination
              page={page}
              pageSize={parseInt(pageSize, 10)}
              currentBatchSize={orders.length}
              onPageChange={(p) => updateParam('page', p)}
            />
          )}
        </>
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

function OrdersTable({ orders, subGalleryFilter, onRowClick }) {
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

function OrderRow({ order, subGalleryFilter, onClick }) {
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
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-secondary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '';
      }}
    >
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

function Pagination({ page, pageSize, currentBatchSize, onPageChange }) {
  // We don't know the absolute total from the server (only the current batch
  // size), so pagination is "next disabled if batch < pageSize" style. Phase
  // 12 polish could fetch a total count separately for "Page X of Y" display.
  const isLastPage = currentBatchSize < pageSize;
  const startNum = (page - 1) * pageSize + 1;
  const endNum = startNum + currentBatchSize - 1;

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
          <>Showing {startNum}–{endNum}</>
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
          Page {page}
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
