import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  Button,
  StatusBanner,
  settingsStyles,
} from '../../components/SettingsForm';

/**
 * Phase 4.7 — process history viewer.
 *
 * Lists completed batch jobs in newest-first order. Click a row to
 * expand the per-order summary. Pagination via limit/offset (50 per
 * page default).
 *
 * History is recorded automatically by processingService when a batch
 * completes (or is cancelled). Single-order processOrder() calls aren't
 * logged here — they're a one-shot UI affordance and would clutter the
 * history with verification noise.
 */
export default function ProcessHistoryPage() {
  const [data, setData] = useState({ entries: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(0);
  const [limit] = useState(50);
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [status, setStatus] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get(
        `/api/sytist/process/history?limit=${limit}&offset=${page * limit}`
      );
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  async function handleClear() {
    setConfirmingClear(false);
    try {
      await api.del('/api/sytist/process/history');
      setStatus({ kind: 'success', message: 'History cleared' });
      setPage(0);
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: `Clear failed: ${err.message}` });
    }
  }

  if (loading && data.entries.length === 0) {
    return (
      <div>
        <PageHeader title="Process History" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Process History"
        subtitle="Completed batch processing jobs, newest first. Single-order processing isn't logged here — only multi-order batches."
        actions={
          <Button variant="ghost" onClick={() => setConfirmingClear(true)}>
            Clear history
          </Button>
        }
      />

      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}
      {error && <StatusBanner kind="error" message={error} />}

      {confirmingClear && (
        <div
          style={{
            padding: 16,
            marginBottom: 16,
            background: 'rgba(220,53,69,0.08)',
            border: '1px solid rgba(220,53,69,0.4)',
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 13, color: '#dc3545', fontWeight: 600, marginBottom: 8 }}>
            Permanently clear all process history?
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            This deletes every batch job record. Cannot be undone. Files written
            to disk are NOT affected — only the audit log.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="danger" onClick={handleClear}>
              Yes, clear history
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingClear(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {data.entries.length === 0 ? (
        <Section>
          <div
            style={{
              padding: 32,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            No batch jobs yet. Start a batch from the Orders page.
          </div>
        </Section>
      ) : (
        <Section>
          <table style={settingsStyles.table}>
            <thead>
              <tr>
                <th style={settingsStyles.th}>Started</th>
                <th style={settingsStyles.th}>Mode</th>
                <th style={settingsStyles.th}>Ran by</th>
                <th style={settingsStyles.th}>Total</th>
                <th style={settingsStyles.th}>Result</th>
                <th style={settingsStyles.th}>Options</th>
                <th style={{ ...settingsStyles.th, width: 80, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => {
                const isExpanded = expandedJobId === entry.jobId;
                return (
                  <React.Fragment key={entry.jobId}>
                    <tr
                      onClick={() =>
                        setExpandedJobId(isExpanded ? null : entry.jobId)
                      }
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={settingsStyles.td}>
                        <div>{formatTimestamp(entry.startedAt)}</div>
                        {entry.completedAt && (
                          <div
                            style={{ fontSize: 10, color: 'var(--text-muted)' }}
                          >
                            took {formatDuration(entry.startedAt, entry.completedAt)}
                          </div>
                        )}
                      </td>
                      <td style={settingsStyles.td}>
                        {entry.mode ? (
                          <span
                            style={{
                              fontSize: 10,
                              padding: '2px 6px',
                              borderRadius: 3,
                              background:
                                entry.mode === 'production'
                                  ? 'rgba(220,53,69,0.15)'
                                  : 'rgba(224,179,65,0.15)',
                              color:
                                entry.mode === 'production' ? '#dc3545' : '#e0b341',
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            }}
                          >
                            {entry.mode}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={settingsStyles.td}>
                        {entry.ranBy || (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={settingsStyles.td}>{entry.total}</td>
                      <td style={settingsStyles.td}>
                        <ResultBadges
                          successCount={entry.successCount}
                          partialCount={entry.partialCount}
                          failedCount={entry.failedCount}
                          cancelled={entry.cancelled}
                        />
                      </td>
                      <td style={settingsStyles.td}>
                        <OptionsBadges options={entry.options} />
                      </td>
                      <td
                        style={{
                          ...settingsStyles.td,
                          textAlign: 'right',
                          fontSize: 11,
                          color: 'var(--text-muted)',
                        }}
                      >
                        {isExpanded ? '▲' : '▼'}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0 }}>
                          <ExpandedJobDetail entry={entry} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {data.total > limit && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 16,
                paddingTop: 16,
                borderTop: '1px solid var(--border-color)',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {page * limit + 1}–
                {Math.min((page + 1) * limit, data.total)} of {data.total}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  variant="ghost"
                  onClick={() => setPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                >
                  ← Previous
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPage(page + 1)}
                  disabled={(page + 1) * limit >= data.total}
                >
                  Next →
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function ResultBadges({ successCount, partialCount, failedCount, cancelled }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {successCount > 0 && (
        <span
          style={{
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 3,
            background: 'rgba(76,175,80,0.15)',
            color: '#4caf50',
            fontWeight: 600,
          }}
        >
          ✓ {successCount}
        </span>
      )}
      {partialCount > 0 && (
        <span
          style={{
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 3,
            background: 'rgba(224,179,65,0.15)',
            color: '#e0b341',
            fontWeight: 600,
          }}
        >
          ⚠ {partialCount}
        </span>
      )}
      {failedCount > 0 && (
        <span
          style={{
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 3,
            background: 'rgba(220,53,69,0.15)',
            color: '#dc3545',
            fontWeight: 600,
          }}
        >
          ✗ {failedCount}
        </span>
      )}
      {cancelled && (
        <span
          style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            background: 'rgba(158,158,158,0.2)',
            color: 'var(--text-muted)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          Cancelled
        </span>
      )}
    </div>
  );
}

function OptionsBadges({ options }) {
  if (!options) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const enabled = [];
  if (options.generateDivider) enabled.push('dividers');
  if (options.generateQrSheet) enabled.push('qr');
  if (enabled.length === 0)
    return (
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>basic</span>
    );
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {enabled.map((e) => (
        <span
          key={e}
          style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            background: 'rgba(120,120,200,0.15)',
            color: '#aab',
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {e}
        </span>
      ))}
    </div>
  );
}

function ExpandedJobDetail({ entry }) {
  return (
    <div
      style={{
        padding: 16,
        background: 'var(--bg-input)',
        borderTop: '1px solid var(--border-color)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: 4,
          columnGap: 12,
          fontSize: 11,
          marginBottom: 12,
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>Job ID:</span>
        <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
          {entry.jobId}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>Status:</span>
        <span>{entry.status}</span>
        {entry.error && (
          <>
            <span style={{ color: '#dc3545' }}>Error:</span>
            <span style={{ color: '#dc3545' }}>{entry.error}</span>
          </>
        )}
      </div>

      {entry.qrSheetPaths && entry.qrSheetPaths.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: 8,
            background: 'rgba(120,120,200,0.05)',
            border: '1px solid rgba(120,120,200,0.2)',
            borderRadius: 4,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              marginBottom: 4,
            }}
          >
            QR sheets:
          </div>
          {entry.qrSheetPaths.map((p, i) => (
            <div
              key={i}
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono, monospace)',
                color: 'var(--text-secondary)',
                wordBreak: 'break-all',
              }}
            >
              {p}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 8,
        }}
      >
        Per-order results ({entry.results?.length || 0})
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 6,
        }}
      >
        {(entry.results || []).map((r) => (
          <div
            key={r.orderId}
            style={{
              padding: 8,
              background: 'var(--bg-card)',
              border: `1px solid ${
                r.status === 'success'
                  ? 'rgba(76,175,80,0.3)'
                  : r.status === 'partial'
                  ? 'rgba(224,179,65,0.3)'
                  : 'rgba(220,53,69,0.3)'
              }`,
              borderRadius: 4,
              fontSize: 11,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <Link
                to={`/orders/${r.orderId}`}
                style={{
                  color: 'var(--text-primary)',
                  textDecoration: 'none',
                  fontWeight: 600,
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                #{r.orderNumber || r.orderId}
              </Link>
              <span
                style={{
                  color:
                    r.status === 'success'
                      ? '#4caf50'
                      : r.status === 'partial'
                      ? '#e0b341'
                      : '#dc3545',
                  fontWeight: 600,
                }}
              >
                {r.status === 'success' ? '✓' : r.status === 'partial' ? '⚠' : '✗'}
              </span>
            </div>
            {r.error && (
              <div style={{ color: '#dc3545', fontSize: 10 }}>{r.error}</div>
            )}
            {!r.error && (
              <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                {r.subOrderCount} sub-order{r.subOrderCount === 1 ? '' : 's'},{' '}
                {r.photoCount} photo{r.photoCount === 1 ? '' : 's'}
                {r.warningCount > 0 && (
                  <span style={{ color: '#e0b341' }}>
                    , {r.warningCount} warn
                  </span>
                )}
                {r.statusUpdated && (
                  <span style={{ color: '#4caf50' }}> · status updated</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  try {
    const ms = new Date(endIso) - new Date(startIso);
    if (ms < 1000) return '<1s';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60000)}m`;
  } catch {
    return '—';
  }
}
