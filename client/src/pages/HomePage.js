import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

/**
 * Home / welcome screen. Default landing after login.
 *
 * Top: stat cards (production statuses + workflows). Click → filtered orders.
 * Bottom: system status (server + Sytist DB health).
 *
 * Phase 3a: stat counts come from a new /api/sytist/order-counts endpoint.
 * Phase 3b/3c: clicking a card navigates to OrdersListPage with appropriate filter.
 */
export default function HomePage() {
  const navigate = useNavigate();

  const [counts, setCounts] = useState(null);
  const [countsError, setCountsError] = useState(null);
  const [countsLoading, setCountsLoading] = useState(true);

  const [serverHealth, setServerHealth] = useState(null);
  const [sytistHealth, setSytistHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [sytistError, setSytistError] = useState(null);

  // Stat counts
  useEffect(() => {
    let cancelled = false;
    setCountsLoading(true);
    api
      .get('/api/sytist/order-counts')
      .then((d) => !cancelled && setCounts(d))
      .catch((err) => !cancelled && setCountsError(err.message))
      .finally(() => !cancelled && setCountsLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Server + Sytist health (small footer instead of full cards)
  useEffect(() => {
    let cancelled = false;

    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => !cancelled && setServerHealth(d))
      .catch((err) => !cancelled && setHealthError(err.message));

    api
      .get('/api/sytist/health')
      .then((d) => !cancelled && setSytistHealth(d))
      .catch((err) => !cancelled && setSytistError(err.message));

    return () => {
      cancelled = true;
    };
  }, []);

  // Stat card click → orders list with filter applied via query string.
  function goToFiltered(filterKey, filterValue) {
    const qs = new URLSearchParams();
    qs.set(filterKey, filterValue);
    navigate(`/orders?${qs.toString()}`);
  }

  return (
    <div
      style={{
        maxWidth: 1080,
        margin: '32px auto',
        padding: '0 24px',
        width: '100%',
      }}
    >
      {/* ─── Production status cards ───────────────────────── */}
      <h2
        style={{
          fontSize: 13,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          margin: '0 0 12px',
        }}
      >
        Production status
      </h2>

      <div style={statCardGridStyle}>
        <StatCard
          label="Open"
          count={counts?.byStatus?.['0'] ?? null}
          loading={countsLoading}
          accent="var(--accent)"
          onClick={() => goToFiltered('productionStatus', '0')}
        />
        <StatCard
          label="Printing & Production"
          count={counts?.byStatus?.['40'] ?? null}
          loading={countsLoading}
          accent="#5b8def"
          onClick={() => goToFiltered('productionStatus', '40')}
        />
        <StatCard
          label="Office Attention"
          count={counts?.byStatus?.['12'] ?? null}
          loading={countsLoading}
          accent="#e0b341"
          onClick={() => goToFiltered('productionStatus', '12')}
        />
      </div>

      {/* ─── Workflow cards ────────────────────────────────── */}
      <h2
        style={{
          fontSize: 13,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          margin: '32px 0 12px',
        }}
      >
        By workflow (open orders only)
      </h2>

      <div style={statCardGridStyle}>
        <StatCard
          label="Ship to Home"
          count={counts?.byWorkflow?.ship_to_home ?? null}
          loading={countsLoading}
          accent="#4caf50"
          onClick={() => goToFiltered('workflow', 'ship_to_home')}
        />
        <StatCard
          label="Ship to Managers"
          count={counts?.byWorkflow?.ship_to_managers ?? null}
          loading={countsLoading}
          accent="#9c6ade"
          onClick={() => goToFiltered('workflow', 'ship_to_managers')}
        />
        <StatCard
          label="Ship to League"
          count={counts?.byWorkflow?.ship_to_league ?? null}
          loading={countsLoading}
          accent="#37b6cf"
          onClick={() => goToFiltered('workflow', 'ship_to_league')}
        />
        {/* Phase 60: digital-only orders (no physical item, $0.00 shipping) */}
        <StatCard
          label="Digital"
          count={counts?.byWorkflow?.digital ?? null}
          loading={countsLoading}
          accent="#ffb300"
          onClick={() => goToFiltered('workflow', 'digital')}
        />
      </div>

      {countsError && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 8,
            color: 'var(--error, #dc3545)',
            fontSize: 13,
          }}
        >
          Could not load order counts: {countsError}
        </div>
      )}

      {/* ─── System status footer ──────────────────────────── */}
      <div
        style={{
          marginTop: 48,
          padding: 16,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          display: 'flex',
          gap: 24,
          fontSize: 12,
          color: 'var(--text-muted)',
        }}
      >
        <SystemStatusItem
          label="Dashboard server"
          ok={!!serverHealth && !healthError}
          error={healthError}
        />
        <SystemStatusItem
          label="Sytist database"
          ok={!!sytistHealth && !sytistError}
          error={sytistError}
          extra={sytistHealth ? `${sytistHealth.elapsedMs}ms` : null}
        />
      </div>
    </div>
  );
}

const statCardGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

function StatCard({ label, count, loading, accent, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: 20,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 8,
        cursor: 'pointer',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-secondary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--bg-card)';
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        {loading ? '…' : count !== null ? count.toLocaleString() : '—'}
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginTop: 8,
        }}
      >
        View →
      </div>
    </button>
  );
}

function SystemStatusItem({ label, ok, error, extra }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: ok ? 'var(--success, #4caf50)' : 'var(--error, #dc3545)' }}>
        {ok ? '✓' : '✗'}
      </span>
      <span>{label}</span>
      {extra && <span style={{ opacity: 0.6 }}>({extra})</span>}
      {error && <span style={{ color: 'var(--error, #dc3545)' }}>— {error}</span>}
    </div>
  );
}
