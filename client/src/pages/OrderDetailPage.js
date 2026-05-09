import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../services/api';

/**
 * Order detail page — Phase 3c.
 *
 * Read-only canonical-shape rendering. Action buttons (status updates,
 * processing, photo downloads) come in later phases.
 *
 * Layout:
 *   - Header strip: back link, order #, badges (status, workflow, sibling)
 *   - Customer + Ship To blocks (two columns on wide screens)
 *   - Subject fields block (the dynamic athlete/team info)
 *   - Sibling banner (if 3+ teams)
 *   - Bundle banner (if ship-to-home sibling)
 *   - Line items block (grouped by team if non-home sibling, flat otherwise)
 *   - Totals block
 *   - Notes blocks (only if present)
 */
export default function OrderDetailPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setOrder(null);

    api
      .get(`/api/sytist/orders/${orderId}`)
      .then((d) => {
        if (cancelled) return;
        setOrder(d.order);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) {
          setNotFound(true);
        } else {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  // ─── Loading ──────────────────────────────────────────
  if (loading) {
    return (
      <div style={pageStyle}>
        <BackLink />
        <div style={{ marginTop: 32, color: 'var(--text-muted)', fontSize: 13 }}>
          Loading order {orderId}…
        </div>
      </div>
    );
  }

  // ─── Not found ────────────────────────────────────────
  if (notFound) {
    return <NotFoundView orderId={orderId} navigate={navigate} />;
  }

  // ─── Error ────────────────────────────────────────────
  if (error) {
    return (
      <div style={pageStyle}>
        <BackLink />
        <div style={errorBoxStyle}>
          <strong>Could not load order {orderId}</strong>
          <div style={{ marginTop: 6, fontSize: 12 }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!order) return null;

  // ─── Render ───────────────────────────────────────────
  const distinctTeams = new Set(
    (order.lineItems || []).map((li) => li.subGalleryId).filter((id) => id > 0)
  );
  const teamCount = distinctTeams.size;
  const isBundledHome =
    order.isSibling && order.shipping?.workflow === 'ship_to_home';

  return (
    <div style={pageStyle}>
      <BackLink />

      <HeaderStrip order={order} teamCount={teamCount} />

      <div style={twoColumnStyle}>
        <CustomerBlock customer={order.customer} />
        <ShipToBlock shipTo={order.shipTo} />
      </div>

      {(order.subject?.fields || []).length > 0 && (
        <SubjectBlock fields={order.subject.fields} />
      )}

      {/* Sibling notice — only when 3+ teams since 2-team is communicated by badges */}
      {order.isSibling && teamCount >= 3 && (
        <Banner color="purple" icon="🔀">
          <strong>Sibling order — {teamCount} teams.</strong> Items will process
          per-team unless this is a ship-to-home order.
        </Banner>
      )}

      {/* Bundled-home banner */}
      {isBundledHome && (
        <Banner color="green" icon="📦">
          <strong>Bundle ships together.</strong> All items in this order ship
          to one address regardless of team.
        </Banner>
      )}

      <LineItemsBlock
        order={order}
        groupByTeam={order.isSibling && !isBundledHome}
      />

      <TotalsBlock order={order} />

      <NotesBlocks order={order} />

      <OutputPathsBlock orderId={order.orderId} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Page-level pieces
// ──────────────────────────────────────────────────────────

function BackLink() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(-1)}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        fontSize: 13,
        color: 'var(--accent)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      ← Back to Orders
    </button>
  );
}

function HeaderStrip({ order, teamCount }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginTop: 12,
        marginBottom: 24,
      }}
    >
      <div>
        <h1 style={{ fontSize: 24, margin: '0 0 4px', fontFamily: 'var(--font-mono, monospace)' }}>
          Order {order.orderId}
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Placed {formatFullDate(order.orderDate)}
          {order.dueDate && (
            <>
              {' · '}Due {formatFullDate(order.dueDate)}
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StatusBadge status={order.productionStatus} />
        <WorkflowBadge
          workflow={order.shipping?.workflow}
          uncategorized={order.shipping?.uncategorized}
          shippingOption={order.shipping?.optionName}
        />
        {order.isSibling && (
          <Badge color="#b48af0" bg="rgba(156,106,222,0.15)" border="rgba(156,106,222,0.4)">
            Sibling · {teamCount} teams
          </Badge>
        )}
      </div>
    </div>
  );
}

function CustomerBlock({ customer }) {
  if (!customer) return null;
  return (
    <Card title="Customer">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {customer.firstName} {customer.lastName}
      </div>
      {customer.businessName && (
        <div style={textRowStyle}>{customer.businessName}</div>
      )}
      {customer.email && (
        <div style={textRowStyle}>
          <a
            href={`mailto:${customer.email}`}
            style={{ color: 'var(--accent)', textDecoration: 'none' }}
          >
            {customer.email}
          </a>
        </div>
      )}
      {customer.phone && <div style={textRowStyle}>{customer.phone}</div>}
    </Card>
  );
}

function ShipToBlock({ shipTo }) {
  if (!shipTo) return null;
  const hasAddress = shipTo.address1 || shipTo.city;
  if (!hasAddress) return null;

  return (
    <Card title="Ship To">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {shipTo.firstName} {shipTo.lastName}
      </div>
      {shipTo.businessName && (
        <div style={textRowStyle}>{shipTo.businessName}</div>
      )}
      {shipTo.address1 && <div style={textRowStyle}>{shipTo.address1}</div>}
      {shipTo.address2 && <div style={textRowStyle}>{shipTo.address2}</div>}
      <div style={textRowStyle}>
        {[shipTo.city, shipTo.state, shipTo.zip].filter(Boolean).join(', ')}
      </div>
      {shipTo.country && shipTo.country !== 'United States' && (
        <div style={textRowStyle}>{shipTo.country}</div>
      )}
    </Card>
  );
}

function SubjectBlock({ fields }) {
  return (
    <Card title="Subject">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i}>
              <td
                style={{
                  padding: '4px 12px 4px 0',
                  color: 'var(--text-muted)',
                  fontSize: 12,
                  width: 180,
                  verticalAlign: 'top',
                }}
              >
                {f.label}
              </td>
              <td style={{ padding: '4px 0', fontSize: 13 }}>{f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function LineItemsBlock({ order, groupByTeam }) {
  const lineItems = order.lineItems || [];
  if (lineItems.length === 0) {
    return (
      <Card title="Line items">
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No line items.
        </div>
      </Card>
    );
  }

  if (!groupByTeam) {
    // Flat: gallery shown in card title, then list
    return (
      <Card
        title={
          <>
            Line items
            <span
              style={{
                fontSize: 12,
                fontWeight: 400,
                color: 'var(--text-muted)',
                marginLeft: 8,
              }}
            >
              {order.galleryName} · {order.subGalleryName}
            </span>
          </>
        }
      >
        <LineItemList lineItems={lineItems} />
      </Card>
    );
  }

  // Grouped by sub-gallery
  const groups = new Map();
  for (const li of lineItems) {
    const key = li.subGalleryId || 0;
    if (!groups.has(key)) {
      groups.set(key, {
        subGalleryId: key,
        subGalleryName: li.subGalleryName || '(no team)',
        galleryName: li.galleryName,
        items: [],
      });
    }
    groups.get(key).items.push(li);
  }

  return (
    <Card title="Line items by team">
      {[...groups.values()].map((g, idx) => (
        <div
          key={g.subGalleryId}
          style={{
            marginTop: idx === 0 ? 0 : 24,
            paddingTop: idx === 0 ? 0 : 16,
            borderTop: idx === 0 ? 'none' : '1px solid var(--border-color)',
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: 12,
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {g.galleryName} ›
            </span>
            <span>{g.subGalleryName}</span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
              ({g.items.length} {g.items.length === 1 ? 'item' : 'items'})
            </span>
          </div>
          <LineItemList lineItems={g.items} />
        </div>
      ))}
    </Card>
  );
}

function LineItemList({ lineItems }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {lineItems.map((li, idx) => (
        <LineItemRow key={li.cartId || idx} lineItem={li} />
      ))}
    </div>
  );
}

function LineItemRow({ lineItem }) {
  const photo = lineItem.photo;
  const flags = lineItem.flags || {};
  const flagChips = [];
  if (flags.greenScreen) flagChips.push({ label: 'Green Screen', color: '#37b6cf' });
  if (flags.download) flagChips.push({ label: 'Includes Download', color: '#9c6ade' });
  if (flags.framed) flagChips.push({ label: 'Framed', color: '#e0b341' });
  if (flags.canvas) flagChips.push({ label: 'Canvas', color: '#e0b341' });
  if (flags.package) flagChips.push({ label: 'Package', color: '#5b8def' });
  if (flags.giftCert) flagChips.push({ label: 'Gift Certificate', color: '#9c6ade' });
  if (flags.fromArchive) flagChips.push({ label: 'Archived Cart', color: '#9e9e9e' });

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
      }}
    >
      {/* Photo thumbnail (left) */}
      <div
        style={{
          flexShrink: 0,
          width: 80,
          height: 80,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {photo && photo.thumbUrl ? (
          <a
            href={photo.fullUrl || photo.largeUrl || photo.thumbUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open full-size in new tab"
            style={{ display: 'block', width: '100%', height: '100%' }}
          >
            <img
              src={photo.thumbUrl}
              alt={photo.originalFilename || ''}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          </a>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>no photo</span>
        )}
      </div>

      {/* Right: product info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            alignItems: 'baseline',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>
            {lineItem.productName || '(no name)'}
          </div>
          <div
            style={{
              fontSize: 13,
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            {lineItem.qty} × ${lineItem.price.toFixed(2)}
          </div>
        </div>

        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginTop: 4,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          {lineItem.sku && <span>SKU {lineItem.sku}</span>}
          {photo?.originalFilename && (
            <>
              <span>·</span>
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {photo.originalFilename}
              </span>
            </>
          )}
          {photo?.width > 0 && photo?.height > 0 && (
            <>
              <span>·</span>
              <span>
                {photo.width}×{photo.height}
                {photo.width >= photo.height ? ' (H)' : ' (V)'}
              </span>
            </>
          )}
        </div>

        {flagChips.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {flagChips.map((c) => (
              <span
                key={c.label}
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  background: `${c.color}22`,
                  color: c.color,
                  border: `1px solid ${c.color}55`,
                  borderRadius: 10,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {c.label}
              </span>
            ))}
          </div>
        )}

        {(lineItem.options || []).length > 0 && (
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}
          >
            {lineItem.options.map((o, i) => (
              <div key={i}>
                <span style={{ color: 'var(--text-muted)' }}>{o.name}:</span>{' '}
                {o.selectedValue}
                {o.price > 0 && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}
                    (+${o.price.toFixed(2)})
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {lineItem.notes && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              background: 'var(--bg-input)',
              borderLeft: '2px solid var(--accent)',
              fontSize: 12,
              color: 'var(--text-secondary)',
              borderRadius: 4,
            }}
          >
            {lineItem.notes}
          </div>
        )}
      </div>
    </div>
  );
}

function TotalsBlock({ order }) {
  const t = order.totals || {};
  const shipping = order.shipping?.cost || 0;

  return (
    <Card title="Totals">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          <TotalRow label="Subtotal" amount={t.subtotal || 0} />
          <TotalRow
            label={
              <>
                Shipping
                {order.shipping?.optionName && (
                  <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>
                    ({order.shipping.optionName})
                  </span>
                )}
              </>
            }
            amount={shipping}
          />
          <TotalRow label="Tax" amount={t.tax || 0} />
          {t.paymentFee > 0 && <TotalRow label="Payment Fee" amount={t.paymentFee} />}
          <TotalRow label="Total" amount={t.total || 0} bold />
        </tbody>
      </table>

      {(order.payType || order.cardLastFour) && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid var(--border-color)',
            fontSize: 12,
            color: 'var(--text-muted)',
          }}
        >
          Payment:{' '}
          {order.payType && <span>{order.payType}</span>}
          {order.cardLastFour && (
            <span>
              {' '}
              ····{order.cardLastFour}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function TotalRow({ label, amount, bold }) {
  return (
    <tr>
      <td
        style={{
          padding: '4px 0',
          color: bold ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: bold ? 700 : 400,
        }}
      >
        {label}
      </td>
      <td
        style={{
          padding: '4px 0',
          textAlign: 'right',
          fontFamily: 'var(--font-mono, monospace)',
          color: bold ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: bold ? 700 : 400,
        }}
      >
        ${Number(amount).toFixed(2)}
      </td>
    </tr>
  );
}

function NotesBlocks({ order }) {
  const cn = (order.customerNotes || '').trim();
  const an = (order.adminNotes || '').trim();
  if (!cn && !an) return null;

  return (
    <>
      {cn && (
        <Card title="Customer notes">
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{cn}</div>
        </Card>
      )}
      {an && (
        <Card title="Admin notes">
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{an}</div>
        </Card>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────
// Output paths preview (Phase 4.1)
// ──────────────────────────────────────────────────────────
//
// Diagnostic block that asks the server "where would production files for
// this order land?" without writing anything. Collapsed by default — it's
// meant for verifying configuration during the Phase 4 rollout, not for
// daily operator use.

function OutputPathsBlock({ orderId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Guard ref so React 18 StrictMode's double-invoke of effects doesn't fire
  // two parallel fetches (whose cleanup-cancel flags race and leave the UI
  // stuck on "Resolving paths…"). Tracks whether a fetch is in-flight or
  // already completed for the current orderId.
  const fetchedRef = useRef({ orderId: null, status: 'idle' });

  // Reset when the order changes — a different order needs a new fetch.
  useEffect(() => {
    fetchedRef.current = { orderId, status: 'idle' };
    setData(null);
    setError(null);
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    if (!open) return;

    const ref = fetchedRef.current;
    // Skip if we've already fetched (or are mid-flight) for this orderId.
    if (ref.orderId === orderId && ref.status !== 'idle') return;

    fetchedRef.current = { orderId, status: 'loading' };
    setLoading(true);
    setError(null);

    api
      .get(`/api/sytist/paths/preview/${orderId}`)
      .then((d) => {
        // Drop the response if the user navigated to a different order
        // mid-flight; the orderId-effect above will have reset things.
        if (fetchedRef.current.orderId !== orderId) return;
        fetchedRef.current = { orderId, status: 'done' };
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        if (fetchedRef.current.orderId !== orderId) return;
        fetchedRef.current = { orderId, status: 'error' };
        setError(err.message);
        setLoading(false);
      });
  }, [open, orderId]);

  return (
    <Card
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>Output paths</span>
          {data?.mode && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 10,
                background:
                  data.mode === 'production'
                    ? 'rgba(76,175,80,0.15)'
                    : 'rgba(224,179,65,0.15)',
                color: data.mode === 'production' ? '#4caf50' : '#e0b341',
                border: `1px solid ${
                  data.mode === 'production'
                    ? 'rgba(76,175,80,0.4)'
                    : 'rgba(224,179,65,0.4)'
                }`,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              {data.mode}
            </span>
          )}
        </div>
      }
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'transparent',
          border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)',
          padding: '6px 12px',
          borderRadius: 6,
          fontSize: 12,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {open ? 'Hide' : 'Show'} resolved paths
      </button>
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        Preview only — no files are written.
      </div>

      {open && loading && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Resolving paths…
        </div>
      )}

      {open && error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 6,
            color: '#dc3545',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {open && data && !loading && !error && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginBottom: 12,
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <span>
              <strong>Workflow:</strong>{' '}
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {data.workflow || '—'}
              </span>
            </span>
            <span>
              <strong>Sort levels:</strong>{' '}
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {(data.sortLevels || []).join(' › ') || 'none'}
              </span>
            </span>
            {data.sortSegments && data.sortSegments.length > 0 && (
              <span>
                <strong>Resolved segments:</strong>{' '}
                <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                  {data.sortSegments.join(' \\ ')}
                </span>
              </span>
            )}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {Object.entries(data.paths || {}).map(([key, info]) => (
                <tr
                  key={key}
                  style={{ borderBottom: '1px solid var(--border-color)' }}
                >
                  <td
                    style={{
                      padding: '8px 12px 8px 0',
                      width: 180,
                      verticalAlign: 'top',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      fontWeight: 600,
                    }}
                  >
                    {key}
                  </td>
                  <td
                    style={{
                      padding: '8px 0',
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 11,
                      color: 'var(--text-primary)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {info.full || (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                    {info.template && info.template !== info.full && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 10,
                          color: 'var(--text-muted)',
                        }}
                      >
                        template: {info.template}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ──────────────────────────────────────────────────────────
// Building blocks
// ──────────────────────────────────────────────────────────

function Card({ title, children }) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        padding: 20,
        marginBottom: 16,
      }}
    >
      <h2
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          margin: '0 0 12px',
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function Banner({ icon, color = 'purple', children }) {
  const colors = {
    purple: { bg: 'rgba(156,106,222,0.1)', border: 'rgba(156,106,222,0.4)', fg: '#b48af0' },
    green: { bg: 'rgba(76,175,80,0.1)', border: 'rgba(76,175,80,0.4)', fg: '#4caf50' },
    yellow: { bg: 'rgba(224,179,65,0.1)', border: 'rgba(224,179,65,0.4)', fg: '#e0b341' },
  };
  const c = colors[color] || colors.purple;
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: 12,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        marginBottom: 16,
        fontSize: 13,
        color: c.fg,
      }}
    >
      <span style={{ fontSize: 18 }}>{icon}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function Badge({ children, color, bg, border }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 10px',
        background: bg,
        color,
        border: `1px solid ${border}`,
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function StatusBadge({ status }) {
  if (!status) return null;
  const id = status.id;
  const map = {
    0: { fg: 'var(--accent)', bg: 'rgba(232,123,52,0.12)', border: 'rgba(232,123,52,0.4)' },
    40: { fg: '#5b8def', bg: 'rgba(91,141,239,0.12)', border: 'rgba(91,141,239,0.4)' },
    39: { fg: '#4caf50', bg: 'rgba(76,175,80,0.12)', border: 'rgba(76,175,80,0.4)' },
    12: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)', border: 'rgba(224,179,65,0.4)' },
    14: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)', border: 'rgba(224,179,65,0.4)' },
    28: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)', border: 'rgba(224,179,65,0.4)' },
    73: { fg: '#e0b341', bg: 'rgba(224,179,65,0.12)', border: 'rgba(224,179,65,0.4)' },
    26: { fg: '#9e9e9e', bg: 'rgba(158,158,158,0.12)', border: 'rgba(158,158,158,0.4)' },
    37: { fg: '#9e9e9e', bg: 'rgba(158,158,158,0.12)', border: 'rgba(158,158,158,0.4)' },
  };
  const c = map[id] || {
    fg: 'var(--text-secondary)',
    bg: 'var(--bg-input)',
    border: 'var(--border-color)',
  };
  return (
    <Badge color={c.fg} bg={c.bg} border={c.border}>
      {status.name}
    </Badge>
  );
}

function WorkflowBadge({ workflow, uncategorized, shippingOption }) {
  const labels = {
    ship_to_home: 'Ship to Home',
    ship_to_managers: 'Ship to Managers',
    ship_to_league: 'Ship to League',
  };
  const colors = {
    ship_to_home: { fg: '#4caf50', bg: 'rgba(76,175,80,0.12)', border: 'rgba(76,175,80,0.4)' },
    ship_to_managers: { fg: '#b48af0', bg: 'rgba(156,106,222,0.12)', border: 'rgba(156,106,222,0.4)' },
    ship_to_league: { fg: '#37b6cf', bg: 'rgba(55,182,207,0.12)', border: 'rgba(55,182,207,0.4)' },
  };
  const c = colors[workflow] || {
    fg: 'var(--text-secondary)',
    bg: 'var(--bg-input)',
    border: 'var(--border-color)',
  };
  const tooltip = uncategorized
    ? `Workflow categorized via numeric fallback. Add "${shippingOption}" to shipping-option-mappings.json.`
    : shippingOption || undefined;
  return (
    <span title={tooltip}>
      <Badge color={c.fg} bg={c.bg} border={c.border}>
        {labels[workflow] || workflow || '—'}
        {uncategorized && <span style={{ marginLeft: 4, fontSize: 10 }}>⚠</span>}
      </Badge>
    </span>
  );
}

// ──────────────────────────────────────────────────────────
// Not-found view (option B: with order lookup search)
// ──────────────────────────────────────────────────────────

function NotFoundView({ orderId, navigate }) {
  const [lookup, setLookup] = useState('');

  function handleLookup(e) {
    e.preventDefault();
    const trimmed = lookup.trim();
    if (!trimmed) return;
    navigate(`/orders/${trimmed}`);
  }

  return (
    <div style={pageStyle}>
      <BackLink />
      <div
        style={{
          marginTop: 32,
          padding: 32,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Order {orderId} not found</h2>
        <p style={{ margin: '0 0 24px', color: 'var(--text-muted)', fontSize: 13 }}>
          The order ID doesn't exist or has been erased.
        </p>

        <form
          onSubmit={handleLookup}
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            maxWidth: 320,
            margin: '0 auto',
          }}
        >
          <input
            type="text"
            inputMode="numeric"
            placeholder="Look up another order #"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            className="form-input"
            style={{ flex: 1, fontSize: 13 }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!lookup.trim()}
            style={{ padding: '8px 16px', fontSize: 13 }}
          >
            Open
          </button>
        </form>

        <div style={{ marginTop: 24 }}>
          <Link to="/orders" style={{ color: 'var(--accent)', fontSize: 13, textDecoration: 'none' }}>
            Back to orders list →
          </Link>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function formatFullDate(dateStr) {
  if (!dateStr) return '—';
  const [datePart, timePart] = String(dateStr).split(' ');
  if (!datePart) return dateStr;
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthName = months[m - 1] || '?';
  let time = '';
  if (timePart && timePart !== '00:00:00') {
    const [hh, mm] = timePart.split(':').map(Number);
    const hour12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
    const ampm = hh >= 12 ? 'pm' : 'am';
    time = ` at ${hour12}:${String(mm || 0).padStart(2, '0')}${ampm}`;
  }
  return `${monthName} ${d}, ${y}${time}`;
}

// ──────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────

const pageStyle = {
  maxWidth: 1100,
  margin: '24px auto',
  padding: '0 24px',
  width: '100%',
};

const twoColumnStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 16,
  marginBottom: 16,
};

const textRowStyle = {
  fontSize: 13,
  color: 'var(--text-secondary)',
  marginBottom: 4,
};

const errorBoxStyle = {
  marginTop: 32,
  padding: 16,
  background: 'rgba(220,53,69,0.1)',
  border: '1px solid rgba(220,53,69,0.3)',
  borderRadius: 8,
  color: '#dc3545',
  fontSize: 13,
};
