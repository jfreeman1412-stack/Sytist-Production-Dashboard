import React, { useEffect, useState, useCallback } from 'react';
import api from '../services/api';

/**
 * Phase 16: audit-history viewer modal.
 *
 * Used by Settings → Add-ons (per row) and Settings → Packages (per
 * card) via a small "View changes" link. Calls the
 * /api/sytist/config-history endpoint with the config type + entity
 * id and renders the result as a timeline of insert / update /
 * delete events.
 *
 * Diffs are shown inline as side-by-side prev/new JSON snapshots —
 * not a pretty character-level diff, just the raw before/after.
 * That's enough to answer "what changed" in 99% of cases.
 *
 * Props:
 *   configType — 'addon_mapping' | 'package' | 'order_override'
 *   entityId   — opt_id, package_sku, or "<orderId>:<cartId>"
 *   title      — modal title (e.g. "History for Photo Frame (458)")
 *   onClose    — close handler
 */
export default function HistoryModal({
  configType,
  entityId,
  title,
  onClose,
}) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get(
        `/api/sytist/config-history?type=${encodeURIComponent(
          configType
        )}&id=${encodeURIComponent(entityId)}`
      );
      setHistory(resp.history || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [configType, entityId]);

  useEffect(() => {
    load();
  }, [load]);

  // ESC closes
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '60px 20px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 720,
          background: 'var(--bg-card, #1c1c1c)',
          color: 'var(--text-primary, #fff)',
          border: '1px solid var(--border-color, #333)',
          borderRadius: 8,
          padding: 20,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
            paddingBottom: 10,
            borderBottom: '1px solid var(--border-color)',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {title || 'Edit history'}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              color: 'var(--text-secondary)',
              border: 'none',
              fontSize: 16,
              cursor: 'pointer',
              padding: '0 8px',
            }}
          >
            ×
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              Loading…
            </div>
          ) : error ? (
            <div style={{ color: '#dc3545', fontSize: 12 }}>{error}</div>
          ) : history.length === 0 ? (
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: 13,
                fontStyle: 'italic',
                padding: '20px 0',
                textAlign: 'center',
              }}
            >
              No history recorded yet for this item.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {history.map((entry) => (
                <HistoryEntry key={entry.historyId} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryEntry({ entry }) {
  const actionColor = {
    insert: '#3b9c5f',
    update: '#4a7fc1',
    delete: '#dc3545',
  }[entry.action] || 'var(--text-secondary)';

  return (
    <div
      style={{
        padding: 10,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'baseline',
          marginBottom: 6,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: actionColor,
          }}
        >
          {entry.action}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {formatTimestamp(entry.changedAt)}
        </span>
        {entry.changedBy && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            by <code>{entry.changedBy}</code>
          </span>
        )}
      </div>
      <DiffView prev={entry.prevValue} next={entry.newValue} />
    </div>
  );
}

function DiffView({ prev, next }) {
  if (prev == null && next == null) return null;

  // Single-side render for inserts and deletes
  if (prev == null) {
    return (
      <JsonBlock label="After" value={next} color="#3b9c5f" />
    );
  }
  if (next == null) {
    return (
      <JsonBlock label="Before (deleted)" value={prev} color="#dc3545" />
    );
  }

  // Both sides — side-by-side
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
      }}
    >
      <JsonBlock label="Before" value={prev} color="var(--text-muted)" />
      <JsonBlock label="After" value={next} color="#4a7fc1" />
    </div>
  );
}

function JsonBlock({ label, value, color }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <pre
        style={{
          fontSize: 11,
          fontFamily:
            'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace',
          color: 'var(--text-secondary)',
          background: 'rgba(0,0,0,0.2)',
          padding: '6px 8px',
          borderRadius: 4,
          margin: 0,
          maxHeight: 200,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
