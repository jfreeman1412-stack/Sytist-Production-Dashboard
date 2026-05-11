import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../services/api';

// ─── ShipStationPage (Phase 13f) ──────────────────────────────
//
// Dedicated page for managing the ShipStation integration in bulk.
// Three tabs:
//
//   Pending  — orders sent to ShipStation that haven't shipped yet.
//              Operator can see what's awaiting fulfillment and
//              refresh status for individual rows.
//
//   Shipped  — recently-shipped orders with their tracking numbers.
//              Sorted by ship date descending.
//
//   Poller   — status of the background polling service from 13e
//              (last run time, last result, manual trigger button).
//              Less of a tab and more of a control panel; included
//              here so operators can sanity-check the poller without
//              needing server-log access.
//
// All data comes from the new GET /api/shipstation/links endpoint
// plus the scheduler status endpoint. Refresh happens on tab switch
// + manual refresh button.
//
// Auto-refresh: pending tab auto-refreshes every 60s while open
// (cheap query, useful for operators leaving the page open during
// fulfillment). Shipped tab does NOT auto-refresh — it's a list
// review surface and re-pulling adds nothing.

const TABS = [
  { id: 'pending',  label: 'Pending',  hint: 'Sent to ShipStation, awaiting shipment' },
  { id: 'shipped',  label: 'Shipped',  hint: 'Recently shipped with tracking numbers' },
  { id: 'poller',   label: 'Poller',   hint: 'Background polling status + manual trigger' },
];

export default function ShipStationPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const currentTab = TABS.find((t) => t.id === tab) ? tab : 'pending';

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1400,
        margin: '0 auto',
        width: '100%',
        flex: 1,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            marginTop: 0,
            marginBottom: 4,
          }}
        >
          ShipStation
        </h1>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-muted)',
            lineHeight: 1.5,
          }}
        >
          Manage orders that have been sent to ShipStation, monitor
          shipped status, and check the background poller.
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--border-color)',
          marginBottom: 20,
        }}
      >
        {TABS.map((t) => {
          const active = t.id === currentTab;
          return (
            <button
              key={t.id}
              onClick={() => navigate(`/shipstation/${t.id}`)}
              style={{
                padding: '10px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: active
                  ? '2px solid #4a7fc1'
                  : '2px solid transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: active ? 600 : 500,
                fontSize: 14,
                cursor: 'pointer',
                fontFamily: 'inherit',
                marginBottom: -1, // overlap the border-bottom of parent
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {currentTab === 'pending' && <PendingTab />}
      {currentTab === 'shipped' && <ShippedTab />}
      {currentTab === 'poller' && <PollerTab />}
    </div>
  );
}

// ─── Tab 1: Pending ────────────────────────────────────────

function PendingTab() {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshingOrderId, setRefreshingOrderId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get('/api/shipstation/links?status=pending&limit=500');
      setLinks(data.links || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Auto-refresh every 60s. Operators leaving this open during
    // fulfillment get fresh data without doing anything.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function handleRefreshOne(orderId) {
    setRefreshingOrderId(orderId);
    try {
      await api.post(`/api/shipstation/orders/${orderId}/refresh`);
      await load();
    } catch (err) {
      // Show as a banner so the row state is still usable
      setError(`Refresh ${orderId}: ${err.message}`);
    } finally {
      setRefreshingOrderId(null);
    }
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {links.length} pending order{links.length === 1 ? '' : 's'}
        </div>
        <button
          onClick={load}
          style={smallButton('#4a7fc1')}
          title="Refresh the list (auto-refreshes every 60s)"
        >
          Refresh
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {links.length === 0 ? (
        <EmptyState
          title="No pending orders"
          subtitle="Orders sent to ShipStation will appear here until they're marked shipped."
        />
      ) : (
        <LinksTable
          rows={links}
          mode="pending"
          refreshingOrderId={refreshingOrderId}
          onRefreshOne={handleRefreshOne}
        />
      )}
    </div>
  );
}

// ─── Tab 2: Shipped ────────────────────────────────────────

function ShippedTab() {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.get('/api/shipstation/links?status=shipped&limit=500');
      setLinks(data.links || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {links.length} shipped order{links.length === 1 ? '' : 's'}
        </div>
        <button onClick={load} style={smallButton('#4a7fc1')}>
          Refresh
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {links.length === 0 ? (
        <EmptyState
          title="No shipped orders yet"
          subtitle="Orders the poller detects as shipped will appear here with tracking."
        />
      ) : (
        <LinksTable rows={links} mode="shipped" />
      )}
    </div>
  );
}

// ─── Tab 3: Poller ─────────────────────────────────────────

function PollerTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get('/api/shipstation/scheduler/status');
      setStatus(data.status || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Auto-refresh every 10s while on this tab so the operator sees
    // poll-in-flight state without manual refresh.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function handleManualPoll() {
    if (
      !window.confirm(
        'Run a poll right now? This asks ShipStation for any orders shipped in the last 7 days and updates local tracking info.'
      )
    ) {
      return;
    }
    setPolling(true);
    setPollResult(null);
    setError(null);
    try {
      const data = await api.post('/api/shipstation/scheduler/poll', {});
      setPollResult(data.summary);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setPolling(false);
    }
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  }

  return (
    <div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div
        style={{
          padding: 20,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: '0 0 12px 0', fontSize: 15 }}>Background poller</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, fontSize: 13 }}>
          <div style={{ color: 'var(--text-muted)' }}>Status:</div>
          <div>
            {status?.running ? (
              <span style={{ color: '#4caf50' }}>● Running</span>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>○ Stopped</span>
            )}
            {status?.isPolling && (
              <span style={{ marginLeft: 8, color: '#4a7fc1', fontSize: 12 }}>
                (polling now…)
              </span>
            )}
          </div>

          <div style={{ color: 'var(--text-muted)' }}>Last poll:</div>
          <div>
            {status?.lastPollAt ? (
              <>
                {new Date(status.lastPollAt).toLocaleString()}{' '}
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  ({timeAgo(status.lastPollAt)})
                </span>
              </>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>Never</span>
            )}
          </div>

          <div style={{ color: 'var(--text-muted)' }}>Total polls run:</div>
          <div>{status?.pollCount ?? 0}</div>

          {status?.lastPollResult && (
            <>
              <div style={{ color: 'var(--text-muted)' }}>Last result:</div>
              <div>
                <PollResultLine result={status.lastPollResult} />
              </div>
            </>
          )}
        </div>

        <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={handleManualPoll}
            disabled={polling || status?.isPolling}
            style={smallButton(polling || status?.isPolling ? 'transparent' : '#4a7fc1', polling || status?.isPolling)}
          >
            {polling ? 'Polling…' : 'Run poll now'}
          </button>
          <button onClick={load} style={smallButton('transparent')}>
            Refresh status
          </button>
        </div>

        {pollResult && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              background: 'rgba(74,127,193,0.08)',
              border: '1px solid rgba(74,127,193,0.25)',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <strong style={{ color: 'var(--text-primary)' }}>Manual poll result:</strong>{' '}
            <PollResultLine result={pollResult} />
          </div>
        )}
      </div>

      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}
      >
        The poller checks ShipStation every 5 minutes (configurable via
        the <code>SHIPSTATION_POLL_MS</code> env var) for orders that
        have moved to shipped status. When it finds one, it updates the
        local tracking number and carrier so the Shipped tab and order
        detail pages reflect the latest state.
      </div>
    </div>
  );
}

function PollResultLine({ result }) {
  if (!result) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  if (result.skipped) {
    return <span style={{ color: 'var(--text-muted)' }}>Skipped (already running)</span>;
  }
  if (result.error) {
    return <span style={{ color: '#dc3545' }}>Error: {result.error}</span>;
  }
  return (
    <span>
      {result.matched > 0 ? (
        <span style={{ color: '#4caf50' }}>
          ✓ {result.matched} order{result.matched === 1 ? '' : 's'} marked shipped
        </span>
      ) : (
        <span style={{ color: 'var(--text-muted)' }}>
          No new shipments — {result.pendingLinks} pending locally, {result.ssOrdersChecked} checked at SS
        </span>
      )}
    </span>
  );
}

// ─── Shared table component for both pending + shipped ────

function LinksTable({ rows, mode, refreshingOrderId, onRefreshOne }) {
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
        <thead>
          <tr>
            <th style={thStyle}>Order</th>
            <th style={thStyle}>SS#</th>
            <th style={thStyle}>Carrier</th>
            <th style={thStyle}>Service</th>
            {mode === 'shipped' && <th style={thStyle}>Tracking</th>}
            {mode === 'shipped' && <th style={thStyle}>Shipped</th>}
            {mode === 'pending' && <th style={thStyle}>Status</th>}
            {mode === 'pending' && <th style={thStyle}>Sent</th>}
            <th style={thStyleRight}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.order_id}>
              <td style={tdStyle}>
                <Link
                  to={`/orders/${r.order_id}`}
                  style={{
                    color: '#4a7fc1',
                    textDecoration: 'none',
                    fontWeight: 500,
                  }}
                >
                  {r.order_id}
                </Link>
              </td>
              <td style={tdStyle}>
                <code style={{ fontSize: 12 }}>{r.ss_order_id}</code>
              </td>
              <td style={tdStyle}>
                <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {r.carrier_code || '—'}
                </code>
              </td>
              <td style={tdStyle}>
                <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {r.service_code || '—'}
                </code>
              </td>
              {mode === 'shipped' && (
                <td style={tdStyle}>
                  {r.tracking_number ? (
                    <code style={{ fontSize: 12 }}>{r.tracking_number}</code>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                  )}
                </td>
              )}
              {mode === 'shipped' && (
                <td style={tdStyle}>
                  {r.shipped_at ? (
                    <>
                      {new Date(r.shipped_at).toLocaleDateString()}{' '}
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        ({timeAgo(r.shipped_at)})
                      </span>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                  )}
                </td>
              )}
              {mode === 'pending' && (
                <td style={tdStyle}>
                  <StatusBadge status={r.ss_order_status} />
                </td>
              )}
              {mode === 'pending' && (
                <td style={tdStyle}>
                  {r.created_at && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {timeAgo(r.created_at)}
                    </span>
                  )}
                </td>
              )}
              <td style={tdStyleRight}>
                {mode === 'pending' && onRefreshOne && (
                  <button
                    onClick={() => onRefreshOne(r.order_id)}
                    disabled={refreshingOrderId === r.order_id}
                    style={smallButton(
                      refreshingOrderId === r.order_id ? 'transparent' : 'transparent',
                      refreshingOrderId === r.order_id
                    )}
                    title="Re-fetch this order's status from ShipStation"
                  >
                    {refreshingOrderId === r.order_id ? 'Refreshing…' : 'Refresh'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = {
    awaiting_payment:    { bg: 'rgba(224,179,65,0.15)', fg: '#e0b341' },
    awaiting_shipment:   { bg: 'rgba(74,127,193,0.15)', fg: '#4a7fc1' },
    shipped:             { bg: 'rgba(76,175,80,0.15)',  fg: '#4caf50' },
    on_hold:             { bg: 'rgba(224,179,65,0.15)', fg: '#e0b341' },
    cancelled:           { bg: 'rgba(220,53,69,0.15)',  fg: '#dc3545' },
  };
  const c = colors[status] || { bg: 'rgba(255,255,255,0.05)', fg: 'var(--text-muted)' };
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 3,
        background: c.bg,
        color: c.fg,
        fontWeight: 500,
      }}
    >
      {status || 'unknown'}
    </span>
  );
}

// ─── Shared helpers ────────────────────────────────────────

function EmptyState({ title, subtitle }) {
  return (
    <div
      style={{
        padding: 40,
        textAlign: 'center',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--text-secondary)',
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{subtitle}</div>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }) {
  return (
    <div
      style={{
        padding: 10,
        background: 'rgba(220,53,69,0.1)',
        border: '1px solid rgba(220,53,69,0.3)',
        borderRadius: 6,
        marginBottom: 12,
        fontSize: 12,
        color: '#dc3545',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
      }}
    >
      <div>{message}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
            marginLeft: 8,
            fontSize: 14,
          }}
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function smallButton(bg, disabled) {
  return {
    padding: '5px 12px',
    background: disabled ? 'transparent' : bg,
    border: '1px solid ' + (bg === 'transparent' ? 'var(--border-color)' : bg),
    color: disabled
      ? 'var(--text-muted)'
      : bg === 'transparent'
      ? 'var(--text-secondary)'
      : '#fff',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
  };
}

const thStyle = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--bg-secondary)',
};
const thStyleRight = { ...thStyle, textAlign: 'right' };
const tdStyle = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-color)',
};
const tdStyleRight = { ...tdStyle, textAlign: 'right' };
