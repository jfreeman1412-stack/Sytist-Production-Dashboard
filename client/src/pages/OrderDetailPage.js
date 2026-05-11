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

  // Phase 13c: bump this counter to trigger ShippingBlock to refetch
  // its status. Wired into ProcessOrderBlock so a successful Process
  // (which now also creates a SS order) immediately reflects the new
  // linked state on the Shipping card without needing a page reload.
  const [shippingRefreshTrigger, setShippingRefreshTrigger] = useState(0);
  const refreshShipping = React.useCallback(() => {
    setShippingRefreshTrigger((n) => n + 1);
  }, []);

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

      <ProcessOrderBlock
        order={order}
        teamCount={teamCount}
        isBundledHome={isBundledHome}
        onProcessComplete={refreshShipping}
      />

      {/* Phase 12: warn if the gallery has no logo set. Composites that
          include a logo slot will render with a placeholder if no logo
          is uploaded — usually not what the operator wants. */}
      <LogoWarningBanner
        galleryId={order.galleryId}
      />

      {/* Phase 13a: ShipStation integration. Renders status of the
          order's relationship to ShipStation — eligible / not yet
          sent / sent / shipped — and provides controls to send and
          mark-as-shipped manually. Phase 13c: refreshTrigger lets
          parent force a refetch after Process auto-creates a SS order. */}
      <ShippingBlock order={order} refreshTrigger={shippingRefreshTrigger} />

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

      <DarkroomTxtBlock orderId={order.orderId} />

      <PackingSlipBlock orderId={order.orderId} />

      <ImpositionBlock order={order} />

      <CompositeBlock order={order} />
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
  const backgroundPhoto = lineItem.backgroundPhoto;
  const flags = lineItem.flags || {};
  const flagChips = [];
  if (flags.greenScreen) flagChips.push({ label: 'Green Screen', color: '#37b6cf' });
  if (flags.download) flagChips.push({ label: 'Includes Download', color: '#9c6ade' });
  if (flags.framed) flagChips.push({ label: 'Framed', color: '#e0b341' });
  if (flags.canvas) flagChips.push({ label: 'Canvas', color: '#e0b341' });
  if (flags.package) flagChips.push({ label: 'Package', color: '#5b8def' });
  if (flags.giftCert) flagChips.push({ label: 'Gift Certificate', color: '#9c6ade' });
  if (flags.fromArchive) flagChips.push({ label: 'Archived Cart', color: '#9e9e9e' });

  // Phase 12a: pick un-watermarked thumbnail URLs for both the
  // player photo and (if green-screen) the chosen background.
  const playerUrl = photo
    ? photo.fullUrl || photo.largeUrl || photo.thumbUrl
    : null;
  const bgUrl = backgroundPhoto
    ? backgroundPhoto.fullUrl ||
      backgroundPhoto.largeUrl ||
      backgroundPhoto.thumbUrl
    : null;

  // Phase 12c: aspect-correct thumbnail dimensions. 150px on the
  // long edge, the short edge scales to match the photo's native
  // aspect ratio. Falls back to 150×150 if width/height aren't
  // known. Computed BEFORE the image loads (we have the dimensions
  // from the API response), so the page layout doesn't shift when
  // the image arrives.
  const LONG_EDGE = 150;
  let tileWidth = LONG_EDGE;
  let tileHeight = LONG_EDGE;
  if (photo && photo.width > 0 && photo.height > 0) {
    if (photo.width >= photo.height) {
      // Horizontal or square — width is the long edge.
      tileWidth = LONG_EDGE;
      tileHeight = Math.round((LONG_EDGE * photo.height) / photo.width);
    } else {
      // Vertical — height is the long edge.
      tileHeight = LONG_EDGE;
      tileWidth = Math.round((LONG_EDGE * photo.width) / photo.height);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
      }}
    >
      {/* Photo thumbnail (left)

          Phase 12b: when this is a green-screen item, the player photo
          is already a PNG with the green keyed out (transparent
          background). So we can render a REAL composite preview by
          stacking the chosen background photo underneath the player
          PNG — the browser handles the alpha natively. No chroma-key
          needed; the keying's already done.

          Layer order in DOM (and z-index by paint order):
            1. Background photo  — fills the tile, bottom of stack
            2. Player PNG        — on top, transparency shows through

          For non-green-screen items, only the player photo renders
          (same behavior as before). */}
      <div
        style={{
          position: 'relative',
          flexShrink: 0,
          width: tileWidth,
          height: tileHeight,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        {/* Background photo — only rendered for green-screen items.
            Sits underneath the player PNG so its transparent areas
            reveal it. */}
        {bgUrl && (
          <img
            src={bgUrl}
            alt=""
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        )}

        {playerUrl ? (
          <a
            href={playerUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={
              bgUrl
                ? `Composite preview · Background: ${
                    backgroundPhoto.originalFilename || ''
                  } · click to open player photo`
                : 'Open full-size in new tab'
            }
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              position: 'relative',
            }}
          >
            <img
              // Phase 12: prefer fullUrl (un-watermarked original)
              // over thumbUrl/largeUrl (both watermarked).
              src={playerUrl}
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
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>no photo</span>
          </div>
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
// Darkroom .txt preview (Phase 4.2)
// ──────────────────────────────────────────────────────────
//
// Diagnostic block showing the .txt body that WOULD be written for this
// order, plus warnings, skipped line items, and the resolved target
// path. Collapsed by default. No file is written from here — preview
// only. Uses the same StrictMode-safe ref-guarded fetch pattern as
// OutputPathsBlock above.

function DarkroomTxtBlock({ orderId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchedRef = useRef({ orderId: null, status: 'idle' });

  useEffect(() => {
    fetchedRef.current = { orderId, status: 'idle' };
    setData(null);
    setError(null);
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    if (!open) return;
    const ref = fetchedRef.current;
    if (ref.orderId === orderId && ref.status !== 'idle') return;

    fetchedRef.current = { orderId, status: 'loading' };
    setLoading(true);
    setError(null);

    api
      .get(`/api/sytist/darkroom/preview/${orderId}`)
      .then((d) => {
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
    <Card title="Darkroom .txt preview">
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
        {open ? 'Hide' : 'Show'} .txt preview
      </button>
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        Preview only — no file is written.
      </div>

      {open && loading && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Building preview…
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
        <DarkroomPreviewContent data={data} />
      )}
    </Card>
  );
}

function DarkroomPreviewContent({ data }) {
  const printItems = data.printItems || [];
  const skipped = data.skippedItems || [];
  const warnings = data.warnings || [];

  return (
    <div style={{ marginTop: 16 }}>
      {/* Top metadata strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: 6,
          columnGap: 12,
          fontSize: 12,
          marginBottom: 16,
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>Filename:</span>
        <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
          {data.filename}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>Target path:</span>
        <span
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
            wordBreak: 'break-all',
          }}
        >
          {data.filePath}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>Line items:</span>
        <span>
          {data.meta?.printedLineItems ?? printItems.length} printed
          {data.meta?.skippedLineItems > 0 &&
            `, ${data.meta.skippedLineItems} skipped`}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>Packing slip:</span>
        <span>
          {data.packingSlip?.included
            ? `included (${data.packingSlip.position})`
            : 'generated at processing time (not shown in this preview)'}
        </span>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: 10,
            background: 'rgba(224,179,65,0.1)',
            border: '1px solid rgba(224,179,65,0.4)',
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: '#e0b341',
              marginBottom: 6,
            }}
          >
            Warnings ({warnings.length})
          </div>
          {warnings.map((w, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                marginTop: i === 0 ? 0 : 4,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'rgba(224,179,65,0.18)',
                  color: '#e0b341',
                  marginRight: 6,
                }}
              >
                {w.type}
              </span>
              {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Skipped items */}
      {skipped.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: 10,
            background: 'rgba(158,158,158,0.08)',
            border: '1px solid rgba(158,158,158,0.3)',
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--text-muted)',
              marginBottom: 6,
            }}
          >
            Skipped ({skipped.length})
          </div>
          {skipped.map((s, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                marginTop: i === 0 ? 0 : 4,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'rgba(158,158,158,0.2)',
                  color: 'var(--text-muted)',
                  marginRight: 6,
                }}
              >
                {s.reason}
              </span>
              {s.productName}
              {s.sku && (
                <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                  (SKU {s.sku})
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Print items in txt order */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        Print order ({printItems.length} items)
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
            <th style={txtTh}>#</th>
            <th style={txtTh}>Size</th>
            <th style={txtTh}>Qty</th>
            <th style={txtTh}>Product</th>
            <th style={txtTh}>Source</th>
          </tr>
        </thead>
        <tbody>
          {printItems.map((p, i) => (
            <tr
              key={i}
              style={{ borderBottom: '1px solid var(--border-color)' }}
            >
              <td style={{ ...txtTd, width: 30, color: 'var(--text-muted)' }}>
                {i + 1}
              </td>
              <td
                style={{
                  ...txtTd,
                  width: 60,
                  fontFamily: 'var(--font-mono, monospace)',
                  fontWeight: 600,
                }}
              >
                {p.size}
              </td>
              <td style={{ ...txtTd, width: 40 }}>{p.qty}</td>
              <td style={txtTd}>
                {p.isSlip ? (
                  <em style={{ color: 'var(--accent)' }}>{p.productName}</em>
                ) : (
                  p.productName
                )}
                {p.templatePath && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      marginTop: 2,
                      fontFamily: 'var(--font-mono, monospace)',
                    }}
                  >
                    template: {p.templatePath}
                  </div>
                )}
              </td>
              <td style={{ ...txtTd, width: 80, color: 'var(--text-muted)', fontSize: 11 }}>
                {p.sizeSource}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Raw txt body */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        Raw .txt content
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 6,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11,
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {data.content}
      </pre>
    </div>
  );
}

const txtTh = {
  textAlign: 'left',
  padding: '6px 8px',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};
const txtTd = {
  padding: '8px',
  fontSize: 12,
  color: 'var(--text-secondary)',
  verticalAlign: 'top',
};

// ──────────────────────────────────────────────────────────
// Packing slip preview (Phase 4.3)
// ──────────────────────────────────────────────────────────
//
// Card with: collapsed by default; on expand, fetches /info for metadata
// (filename, target path, warnings, skipped) AND fetches the slip JPG as
// an authenticated blob (the /preview endpoint requires X-Session-Id; a
// plain <img src=...> tag can't pass that header, so the browser would
// hit the auth wall and get redirected to login). The blob is rendered
// via URL.createObjectURL so the <img> shows the slip without a second
// network round-trip.
//
// StrictMode-safe ref-guarded fetch pattern — same as DarkroomTxtBlock
// and OutputPathsBlock.

function PackingSlipBlock({ orderId }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  const [imgUrl, setImgUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState(null);

  const fetchedRef = useRef({ orderId: null, status: 'idle' });
  // Track the most recent object URL so we can revoke the previous one
  // before swapping in a new one (avoids leaking blobs in the browser).
  const objectUrlRef = useRef(null);

  // Reset on order change
  useEffect(() => {
    fetchedRef.current = { orderId, status: 'idle' };
    setInfo(null);
    setError(null);
    setLoading(false);
    setSaving(false);
    setSavedPath(null);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setImgUrl(null);
  }, [orderId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const ref = fetchedRef.current;
    if (ref.orderId === orderId && ref.status !== 'idle') return;

    fetchedRef.current = { orderId, status: 'loading' };
    setLoading(true);
    setError(null);

    // Fetch metadata + image blob in parallel — both need auth headers,
    // so both go through api (not raw <img src>).
    Promise.all([
      api.get(`/api/sytist/slip/preview/${orderId}/info`),
      api.getBlob(`/api/sytist/slip/preview/${orderId}`),
    ])
      .then(([infoData, blob]) => {
        if (fetchedRef.current.orderId !== orderId) return;
        const url = URL.createObjectURL(blob);
        // Revoke previous URL if any (e.g. after a re-fetch)
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = url;
        fetchedRef.current = { orderId, status: 'done' };
        setInfo(infoData);
        setImgUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (fetchedRef.current.orderId !== orderId) return;
        fetchedRef.current = { orderId, status: 'error' };
        setError(err.message);
        setLoading(false);
      });
  }, [open, orderId]);

  async function handleSave() {
    setSaving(true);
    setSavedPath(null);
    try {
      const result = await api.post(`/api/sytist/slip/preview/${orderId}/save`, {});
      setSavedPath(result.filePath);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Packing slip preview">
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
        {open ? 'Hide' : 'Show'} slip preview
      </button>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        Streamed from server — image is rendered fresh each time, not saved to disk.
      </div>

      {open && loading && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Building slip preview…
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

      {open && info && imgUrl && !loading && (
        <SlipPreviewContent
          info={info}
          imgUrl={imgUrl}
          orderId={orderId}
          onSave={handleSave}
          saving={saving}
          savedPath={savedPath}
        />
      )}
    </Card>
  );
}

function SlipPreviewContent({ info, imgUrl, orderId, onSave, saving, savedPath }) {
  const warnings = info.warnings || [];
  const skipped = info.skippedItems || [];

  return (
    <div style={{ marginTop: 16 }}>
      {/* Metadata strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: 6,
          columnGap: 12,
          fontSize: 12,
          marginBottom: 16,
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>Filename:</span>
        <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{info.filename}</span>
        <span style={{ color: 'var(--text-muted)' }}>Target path:</span>
        <span
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
            wordBreak: 'break-all',
          }}
        >
          {info.filePath}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>Items on slip:</span>
        <span>
          {info.meta?.printedCount ?? 0} printed
          {info.meta?.skippedCount > 0 && `, ${info.meta.skippedCount} skipped`}
        </span>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: 10,
            background: 'rgba(224,179,65,0.1)',
            border: '1px solid rgba(224,179,65,0.4)',
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: '#e0b341',
              marginBottom: 6,
            }}
          >
            Warnings ({warnings.length})
          </div>
          {warnings.map((w, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                marginTop: i === 0 ? 0 : 4,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'rgba(224,179,65,0.18)',
                  color: '#e0b341',
                  marginRight: 6,
                }}
              >
                {w.type}
              </span>
              {w.message ||
                (w.cartId
                  ? `cartId ${w.cartId}${w.url ? ' — ' + w.url : ''}`
                  : '')}
            </div>
          ))}
        </div>
      )}

      {/* Skipped items */}
      {skipped.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: 10,
            background: 'rgba(158,158,158,0.08)',
            border: '1px solid rgba(158,158,158,0.3)',
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--text-muted)',
              marginBottom: 6,
            }}
          >
            Skipped ({skipped.length})
          </div>
          {skipped.map((s, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                marginTop: i === 0 ? 0 : 4,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'rgba(158,158,158,0.2)',
                  color: 'var(--text-muted)',
                  marginRight: 6,
                }}
              >
                {s.reason}
              </span>
              {s.productName}
              {s.sku && (
                <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                  (SKU {s.sku})
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Inline rendered slip image — blob URL so auth header was sent */}
      <div
        style={{
          marginTop: 12,
          padding: 16,
          background: '#2a2a2a',
          border: '1px solid var(--border-color)',
          borderRadius: 6,
          textAlign: 'center',
        }}
      >
        <img
          src={imgUrl}
          alt={`Packing slip for order ${orderId}`}
          style={{
            maxWidth: '100%',
            maxHeight: 1200,
            border: '1px solid #444',
            boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
          }}
        />
      </div>

      {/* Save button + status */}
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            padding: '8px 14px',
            borderRadius: 6,
            fontSize: 12,
            cursor: saving ? 'wait' : 'pointer',
            fontFamily: 'inherit',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save preview to test sandbox'}
        </button>
        {savedPath && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono, monospace)',
              wordBreak: 'break-all',
            }}
          >
            Saved → {savedPath}
          </span>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Imposition preview (Phase 4.4)
// ──────────────────────────────────────────────────────────
//
// Imposition is per-line-item (not per-order), so this card lists the
// order's print-eligible line items and lets the operator preview the
// imposed sheet for each one. Each row shows: product name, SKU, layout
// it would use, and an inline expand to render the actual imposed
// sheet via authed blob fetch.
//
// Same StrictMode-safe ref-guarded pattern as the other preview blocks.

function ImpositionBlock({ order }) {
  const [open, setOpen] = useState(false);

  // Filter to the line items that could possibly be imposed:
  // - have a photo with a fullUrl (no point imposing without a source)
  // - aren't flagged as download / booking / etc.
  const candidateLineItems = (order.lineItems || []).filter((li) => {
    if (!li.photo || !li.photo.fullUrl) return false;
    const skipFlags = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell'];
    return !skipFlags.some((f) => li.flags?.[f]);
  });

  return (
    <Card title="Imposition preview">
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
        {open ? 'Hide' : 'Show'} imposition
      </button>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        Per-line-item preview. Layouts are looked up by SKU + auto-detected orientation.
      </div>

      {open && candidateLineItems.length === 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          No line items with photos eligible for imposition.
        </div>
      )}

      {open &&
        candidateLineItems.map((li) => (
          <ImpositionItemRow
            key={li.cartId}
            order={order}
            lineItem={li}
          />
        ))}
    </Card>
  );
}

function ImpositionItemRow({ order, lineItem }) {
  const [info, setInfo] = useState(null);
  const [imgUrl, setImgUrl] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [loadingImg, setLoadingImg] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState(null);

  const objectUrlRef = useRef(null);
  const infoFetchedRef = useRef(false);
  const imgFetchedRef = useRef(false);

  // Fetch metadata once when the row mounts so the layout name and
  // hasRule status are visible without expanding.
  useEffect(() => {
    if (infoFetchedRef.current) return;
    infoFetchedRef.current = true;
    setLoadingInfo(true);
    api
      .get(
        `/api/sytist/imposition/preview/${order.orderId}/${lineItem.cartId}/info`
      )
      .then((d) => {
        setInfo(d);
        setLoadingInfo(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoadingInfo(false);
      });
  }, [order.orderId, lineItem.cartId]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!expanded || !info?.hasRule || imgFetchedRef.current) return;
    imgFetchedRef.current = true;
    setLoadingImg(true);

    api
      .getBlob(
        `/api/sytist/imposition/preview/${order.orderId}/${lineItem.cartId}`
      )
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setImgUrl(url);
        setLoadingImg(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoadingImg(false);
      });
  }, [expanded, info, order.orderId, lineItem.cartId]);

  async function handleSave() {
    setSaving(true);
    setSavedPath(null);
    try {
      const result = await api.post(
        `/api/sytist/imposition/preview/${order.orderId}/${lineItem.cartId}/save`,
        {}
      );
      setSavedPath(result.filePath);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const noRule = info && !info.hasRule;
  const hasRule = info && info.hasRule;

  return (
    <div
      style={{
        marginTop: 16,
        padding: 12,
        border: '1px solid var(--border-color)',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {lineItem.productName}
            {lineItem.qty > 1 && (
              <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                × {lineItem.qty}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            SKU{' '}
            <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
              {lineItem.sku || '(none)'}
            </span>
            {lineItem.subGalleryName && (
              <span style={{ marginLeft: 12 }}>Team: {lineItem.subGalleryName}</span>
            )}
          </div>
          {loadingInfo && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Resolving layout…
            </div>
          )}
          {hasRule && (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              Layout:{' '}
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                {info.layout.name}
              </span>{' '}
              <span style={{ color: 'var(--text-muted)' }}>
                ({info.layout.cols}×{info.layout.rows} on{' '}
                {info.layout.sheetWidth}×{info.layout.sheetHeight}″)
              </span>
              {info.mapping?.orientation && (
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono, monospace)',
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(120,120,200,0.18)',
                    color: '#aab',
                    marginLeft: 8,
                  }}
                >
                  {info.mapping.orientation}
                </span>
              )}
              {info.mappingFellBack && (
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono, monospace)',
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(224,179,65,0.18)',
                    color: '#e0b341',
                    marginLeft: 8,
                  }}
                >
                  fallback
                </span>
              )}
            </div>
          )}
          {noRule && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                marginTop: 6,
                fontStyle: 'italic',
              }}
            >
              No imposition rule for this SKU. Item will print as-is.
            </div>
          )}
        </div>

        {hasRule && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border-color)',
              color: 'var(--text-secondary)',
              padding: '4px 10px',
              borderRadius: 6,
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            {expanded ? 'Collapse' : 'Render preview'}
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 4,
            color: '#dc3545',
            fontSize: 11,
          }}
        >
          {error}
        </div>
      )}

      {expanded && hasRule && (
        <>
          {loadingImg && (
            <div
              style={{
                marginTop: 12,
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              Rendering imposed sheet…
            </div>
          )}
          {imgUrl && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                background: '#2a2a2a',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                textAlign: 'center',
              }}
            >
              <img
                src={imgUrl}
                alt={`Imposed sheet for ${lineItem.productName}`}
                style={{
                  maxWidth: '100%',
                  maxHeight: 800,
                  border: '1px solid #444',
                  boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
                }}
              />
            </div>
          )}
          {imgUrl && (
            <div
              style={{
                marginTop: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: saving ? 'wait' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save preview to test sandbox'}
              </button>
              {savedPath && (
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono, monospace)',
                    wordBreak: 'break-all',
                  }}
                >
                  Saved → {savedPath}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Process order (Phase 4.6)
// ──────────────────────────────────────────────────────────
//
// Prominent top-of-page action: "Process this order". Triggers
// processingService.processOrder via the API.
//
// Phase 12: removed the "Generate team dividers" checkbox from
// the single-order view. Dividers are a batch-printing concept —
// they separate teams when multiple orders are printed together,
// which never happens at the single-order level. The dividers
// feature is preserved server-side for the future multi-order
// flow; this just keeps the UI honest about when it applies.

function ProcessOrderBlock({ order, teamCount, isBundledHome, onProcessComplete }) {
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const isPerTeam =
    !isBundledHome &&
    (order.shipping?.workflow === 'ship_to_managers' ||
      order.shipping?.workflow === 'ship_to_league');

  async function handleProcess() {
    if (
      !window.confirm(
        `Process order ${order.orderNumber || order.orderId}?\n\n` +
          `This will download photos, run imposition, and write the .txt file ` +
          `that triggers Darkroom. Make sure you're in TEST mode if this is a dry run.`
      )
    ) {
      return;
    }

    setProcessing(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.post(
        `/api/sytist/process/order/${order.orderId}`,
        // Phase 12: no generateDivider flag — single-order processing
        // never produces dividers. Server defaults to false when absent.
        {}
      );
      setResult(response.result);
      // Phase 13c: tell parent to refresh the Shipping card since
      // Process now also auto-creates a ShipStation order. The card's
      // linked-state UI replaces its "click Send" form on success.
      if (onProcessComplete) onProcessComplete();
    } catch (err) {
      setError(err.message);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div
      style={{
        marginBottom: 20,
        padding: 16,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Process this order</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Downloads photos, runs imposition, writes slip + .txt to the configured
            output path.{' '}
            {isPerTeam && teamCount > 1 && (
              <strong>{teamCount} sub-orders will be created (one per team).</strong>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            onClick={handleProcess}
            disabled={processing}
            style={{
              background: '#4a7fc1',
              border: '1px solid #4a7fc1',
              color: '#ffffff',
              padding: '8px 18px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: processing ? 'wait' : 'pointer',
              fontFamily: 'inherit',
              opacity: processing ? 0.6 : 1,
            }}
          >
            {processing ? 'Processing…' : 'Process this order'}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
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

      {result && <ProcessResultDisplay result={result} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// LogoWarningBanner (Phase 12)
// ──────────────────────────────────────────────────────────
//
// Calls /api/sytist/gallery-assets/logos/:galleryId/exists when
// mounted. If the gallery has no logo set, surfaces a warning
// banner above the rest of the page so the operator catches it
// BEFORE clicking Process. Wasted-render prevention.
//
// We don't bother checking whether any line item's layout has a
// logo slot — that'd require fetching layouts and is more code
// for the rare case where a gallery legitimately has no logo and
// no layout uses one. The banner just says "this gallery has no
// logo" and trusts the operator to know whether that's a problem
// for these layouts. False positives are cheap (just a heads-up
// they can ignore); false negatives would mean the wasted render
// the user wanted to avoid.

function LogoWarningBanner({ galleryId }) {
  const [status, setStatus] = useState({ loading: true, exists: null });

  useEffect(() => {
    if (!galleryId) {
      setStatus({ loading: false, exists: null });
      return;
    }
    let cancelled = false;
    api
      .get(
        `/api/sytist/gallery-assets/logos/${galleryId}/exists`
      )
      .then((r) => {
        if (cancelled) return;
        setStatus({ loading: false, exists: !!r?.exists });
      })
      .catch(() => {
        // Soft-fail: if the check itself errors, don't display a
        // false alarm. Worse case the operator processes without
        // the warning, which is the existing behavior anyway.
        if (!cancelled) setStatus({ loading: false, exists: null });
      });
    return () => {
      cancelled = true;
    };
  }, [galleryId]);

  // Render nothing while loading, on error, or when the logo
  // exists. Only display when we've definitively determined the
  // logo is missing.
  if (status.loading || status.exists !== false) return null;

  return (
    <div
      style={{
        marginBottom: 20,
        padding: '12px 16px',
        background: 'rgba(220, 53, 69, 0.08)',
        border: '1px solid rgba(220, 53, 69, 0.4)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span style={{ fontSize: 24 }}>⚠️</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 3,
            color: '#dc3545',
          }}
        >
          No logo set for this gallery
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}
        >
          Any composite that uses a logo slot will render a "no logo"
          placeholder. Upload one at{' '}
          <strong>Settings → Gallery Assets</strong> before processing
          if a logo is expected.
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// ShippingBlock (Phase 13a — ShipStation integration)
// ──────────────────────────────────────────────────────────
//
// Renders the order's ShipStation status with controls to send,
// re-fetch, delete, and manually mark-shipped. Three visual states:
//
//   1. Not linked + ineligible → muted info card, no controls
//   2. Not linked + eligible   → form with carrier/service/weight/dims
//                                + "Send to ShipStation" button
//   3. Linked (sent)           → status panel with re-fetch + delete
//   4. Shipped                 → ✓ banner with carrier + tracking
//
// On mount, hits /api/shipstation/orders/:orderId/status to figure
// out which state we're in. Re-fetches after any action.

function ShippingBlock({ order, refreshTrigger }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  // Form values for the "Send" action. Initialized from app-settings
  // defaults once, then operator can override per-send. Not stored
  // back to settings — that'd require explicit "Save defaults"
  // controls, out of scope for 13a.
  const [carrierCode, setCarrierCode] = useState('');
  const [serviceCode, setServiceCode] = useState('');
  const [packageCode, setPackageCode] = useState('');
  const [weightOz, setWeightOz] = useState('');
  const [dimLength, setDimLength] = useState('');
  const [dimWidth, setDimWidth] = useState('');
  const [dimHeight, setDimHeight] = useState('');
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);

  // Action state
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [markingShipped, setMarkingShipped] = useState(false);

  // Mark-shipped form (collapsed by default)
  const [showShipForm, setShowShipForm] = useState(false);
  const [shipTrackingNumber, setShipTrackingNumber] = useState('');
  const [shipCarrier, setShipCarrier] = useState('usps');

  useEffect(() => {
    let cancelled = false;
    // Initialize from app-settings first (cheap fallback), then fetch
    // status which may include packaging engine output. If engine
    // output is present, it overrides the app-settings defaults.
    initFormFromDefaults();
    fetchStatus();
    return () => {
      cancelled = true;
    };

    async function fetchStatus() {
      try {
        const data = await api.get(
          `/api/shipstation/orders/${order.orderId}/status`
        );
        if (cancelled) return;
        setStatus(data);
        // Phase 13b: packaging engine drives the form when present.
        // Operators can still override before sending — the form
        // fields stay editable.
        if (data.packaging) {
          applyPackagingToForm(data.packaging);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    async function initFormFromDefaults() {
      // App-settings defaults as the floor — used until status arrives
      // with engine output (which overrides), or kept as-is if engine
      // can't decide / errors out.
      try {
        const data = await api.get('/api/shipstation/app-settings');
        if (cancelled) return;
        const s = data.settings || {};
        setCarrierCode(s.defaultCarrier?.value || 'stamps_com');
        setServiceCode(s.defaultService?.value || 'usps_first_class_mail');
        setPackageCode(
          s.defaultPackageCode?.value || 'large_envelope_or_flat'
        );
        setWeightOz(s.defaultWeightOz?.value || '4');
        setDimLength(s.defaultLengthIn?.value || '10');
        setDimWidth(s.defaultWidthIn?.value || '8');
        setDimHeight(s.defaultHeightIn?.value || '0.5');
        setDefaultsLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setCarrierCode('stamps_com');
          setServiceCode('usps_first_class_mail');
          setPackageCode('large_envelope_or_flat');
          setWeightOz('4');
          setDimLength('10');
          setDimWidth('8');
          setDimHeight('0.5');
          setDefaultsLoaded(true);
        }
      }
    }

    function applyPackagingToForm(pkg) {
      if (cancelled || !pkg) return;
      if (pkg.carrierCode) setCarrierCode(pkg.carrierCode);
      if (pkg.serviceCode) setServiceCode(pkg.serviceCode);
      if (pkg.packageCode) setPackageCode(pkg.packageCode);
      if (pkg.weight?.value != null) setWeightOz(String(pkg.weight.value));
      if (pkg.dimensions?.length != null)
        setDimLength(String(pkg.dimensions.length));
      if (pkg.dimensions?.width != null)
        setDimWidth(String(pkg.dimensions.width));
      if (pkg.dimensions?.height != null)
        setDimHeight(String(pkg.dimensions.height));
    }
  }, [order.orderId, refreshTrigger]);

  async function refreshStatus() {
    try {
      const data = await api.get(
        `/api/shipstation/orders/${order.orderId}/status`
      );
      setStatus(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSend() {
    if (
      !window.confirm(
        `Send order ${order.orderNumber || order.orderId} to ShipStation?`
      )
    ) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const overrides = {
        carrierCode,
        serviceCode,
        packageCode,
        weight: { value: parseFloat(weightOz) || 0, units: 'ounces' },
        dimensions: {
          length: parseFloat(dimLength) || 0,
          width: parseFloat(dimWidth) || 0,
          height: parseFloat(dimHeight) || 0,
          units: 'inches',
        },
      };
      await api.post(
        `/api/shipstation/orders/${order.orderId}/create`,
        overrides
      );
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleRefetch() {
    setRefreshing(true);
    setError(null);
    try {
      await api.post(`/api/shipstation/orders/${order.orderId}/refresh`, {});
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        `Delete this order from ShipStation? You can re-send it after deletion.`
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await api.del(`/api/shipstation/orders/${order.orderId}/link`);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleMarkShipped() {
    if (!shipTrackingNumber) {
      setError('Tracking number required');
      return;
    }
    setMarkingShipped(true);
    setError(null);
    try {
      await api.post(
        `/api/shipstation/orders/${order.orderId}/mark-shipped`,
        {
          carrierCode: shipCarrier,
          trackingNumber: shipTrackingNumber,
        }
      );
      setShowShipForm(false);
      setShipTrackingNumber('');
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setMarkingShipped(false);
    }
  }

  // ─── render ────────────────────────────────────────────

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>Shipping</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    );
  }

  // CASE: status fetch failed entirely. We have nothing useful to
  // render — eligibility, linked-state, all of it depend on the
  // status payload. Show the error honestly and offer a retry rather
  // than pretending this is a "not eligible" result. The most common
  // cause is that the /api/shipstation/* routes aren't mounted on the
  // server yet (see PHASE-13a-DEPLOY.txt for the server/index.js
  // wiring).
  if (!status && error) {
    return (
      <div style={containerStyle}>
        <div style={headerRowStyle}>
          <div style={headerStyle}>Shipping</div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            ShipStation
          </div>
        </div>
        <div style={shippingErrorBoxStyle}>
          <strong>Couldn't load ShipStation status:</strong> {error}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 12,
            lineHeight: 1.5,
          }}
        >
          If you see <code>Not found</code> here, the ShipStation routes
          probably aren't mounted in <code>server/index.js</code> yet —
          see the Phase 13a deploy notes. Otherwise, check the server
          log for details.
        </div>
        <button
          onClick={async () => {
            setError(null);
            setLoading(true);
            try {
              const data = await api.get(
                `/api/shipstation/orders/${order.orderId}/status`
              );
              setStatus(data);
            } catch (err) {
              setError(err.message);
            } finally {
              setLoading(false);
            }
          }}
          style={{
            background: 'transparent',
            border: '1px solid var(--border-color)',
            color: 'var(--text-secondary)',
            padding: '6px 12px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  // CASE: linked (already sent to ShipStation)
  if (status?.linked && status.link) {
    return (
      <LinkedShippingPanel
        link={status.link}
        error={error}
        refreshing={refreshing}
        deleting={deleting}
        markingShipped={markingShipped}
        showShipForm={showShipForm}
        setShowShipForm={setShowShipForm}
        shipTrackingNumber={shipTrackingNumber}
        setShipTrackingNumber={setShipTrackingNumber}
        shipCarrier={shipCarrier}
        setShipCarrier={setShipCarrier}
        onRefetch={handleRefetch}
        onDelete={handleDelete}
        onMarkShipped={handleMarkShipped}
      />
    );
  }

  // CASE: not linked. Show eligibility and (if eligible) the send form.
  const eligibility = status?.eligibility || {};
  const isEligible = !!eligibility.eligible;

  return (
    <div style={containerStyle}>
      <div style={headerRowStyle}>
        <div style={headerStyle}>Shipping</div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          ShipStation
        </div>
      </div>

      {error && (
        <div style={shippingErrorBoxStyle}>{error}</div>
      )}

      <div
        style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          marginBottom: isEligible ? 16 : 0,
        }}
      >
        <strong style={{ color: isEligible ? '#4caf50' : 'var(--text-muted)' }}>
          {isEligible ? 'Eligible:' : 'Not eligible:'}
        </strong>{' '}
        {eligibility.reason || 'Status unavailable.'}
        {eligibility.workflow && eligibility.workflow !== 'ship_to_home' && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginTop: 4,
            }}
          >
            Workflow is <code>{eligibility.workflow}</code> — auto-create
            during processing only fires for ship-to-home orders. You can
            still send manually below.
          </div>
        )}
      </div>

      {isEligible && defaultsLoaded && (
        <>
          {/* Phase 13b: show what the packaging engine decided so the
              operator understands why the form values look the way they
              do. If status.packaging is missing (engine error, fresh
              install, or eligibility was false) we just don't show the
              line — form values fall back to app-settings defaults. */}
          {status?.packaging && (
            <div
              style={{
                marginBottom: 12,
                padding: '8px 12px',
                background: 'rgba(74,127,193,0.10)',
                border: '1px solid rgba(74,127,193,0.30)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
              title={status.packaging.notes?.join(' · ') || ''}
            >
              <strong style={{ color: 'var(--text-primary)' }}>
                💡 Engine suggests:
              </strong>{' '}
              {status.packaging.packageTypeName} ·{' '}
              {status.packaging.weight.value}oz ·{' '}
              {status.packaging.carrierCode}/{status.packaging.serviceCode}
              {status.packaging.notes?.length > 0 && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    marginTop: 4,
                  }}
                >
                  {status.packaging.notes.join(' · ')}
                </div>
              )}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <FormField label="Carrier code">
              <TextField value={carrierCode} onChange={setCarrierCode} />
            </FormField>
            <FormField label="Service code">
              <TextField value={serviceCode} onChange={setServiceCode} />
            </FormField>
            <FormField label="Package code">
              <TextField value={packageCode} onChange={setPackageCode} />
            </FormField>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <FormField label="Weight (oz)">
              <TextField
                value={weightOz}
                onChange={setWeightOz}
                type="number"
              />
            </FormField>
            <FormField label="Length (in)">
              <TextField
                value={dimLength}
                onChange={setDimLength}
                type="number"
              />
            </FormField>
            <FormField label="Width (in)">
              <TextField
                value={dimWidth}
                onChange={setDimWidth}
                type="number"
              />
            </FormField>
            <FormField label="Height (in)">
              <TextField
                value={dimHeight}
                onChange={setDimHeight}
                type="number"
              />
            </FormField>
          </div>

          <button
            onClick={handleSend}
            disabled={sending}
            style={{
              background: '#4a7fc1',
              border: '1px solid #4a7fc1',
              color: '#fff',
              padding: '8px 18px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: sending ? 'wait' : 'pointer',
              fontFamily: 'inherit',
              opacity: sending ? 0.6 : 1,
            }}
          >
            {sending ? 'Sending…' : 'Send to ShipStation'}
          </button>
        </>
      )}
    </div>
  );
}

// ─── sub-component: linked (sent) state ─────────────────────

function LinkedShippingPanel({
  link,
  error,
  refreshing,
  deleting,
  markingShipped,
  showShipForm,
  setShowShipForm,
  shipTrackingNumber,
  setShipTrackingNumber,
  shipCarrier,
  setShipCarrier,
  onRefetch,
  onDelete,
  onMarkShipped,
}) {
  const isShipped = link.ss_order_status === 'shipped';

  return (
    <div style={containerStyle}>
      <div style={headerRowStyle}>
        <div style={headerStyle}>Shipping</div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          ShipStation
        </div>
      </div>

      {error && <div style={shippingErrorBoxStyle}>{error}</div>}

      {isShipped ? (
        <div
          style={{
            fontSize: 14,
            color: '#4caf50',
            marginBottom: 12,
          }}
        >
          <strong>✓ Shipped</strong>
          {link.tracking_number ? (
            <>
              {' — '}
              <span style={{ color: 'var(--text-primary)' }}>
                {(link.carrier_code || 'carrier').toUpperCase()}{' '}
                <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                  {link.tracking_number}
                </code>
              </span>
            </>
          ) : null}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            SS#{link.ss_order_id}
            {link.shipped_at &&
              ` · shipped ${new Date(link.shipped_at).toLocaleString()}`}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 14, marginBottom: 12 }}>
          <strong style={{ color: '#4caf50' }}>✓ Sent to ShipStation</strong>{' '}
          — SS#{link.ss_order_id}
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              marginTop: 4,
            }}
          >
            Status:{' '}
            <code>{link.ss_order_status || 'unknown'}</code>
            {link.carrier_code && link.service_code && (
              <>
                {' '}
                · {link.carrier_code}/{link.service_code}
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <SecondaryButton onClick={onRefetch} disabled={refreshing}>
          {refreshing ? 'Re-fetching…' : 'Re-fetch status'}
        </SecondaryButton>
        {!isShipped && (
          <SecondaryButton
            onClick={() => setShowShipForm((v) => !v)}
            disabled={markingShipped}
          >
            {showShipForm ? 'Hide' : 'Mark shipped'}
          </SecondaryButton>
        )}
        <SecondaryButton onClick={onDelete} disabled={deleting} danger>
          {deleting ? 'Deleting…' : 'Delete SS order'}
        </SecondaryButton>
      </div>

      {showShipForm && !isShipped && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            display: 'grid',
            gridTemplateColumns: '1fr 2fr auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <FormField label="Carrier">
            <TextField value={shipCarrier} onChange={setShipCarrier} />
          </FormField>
          <FormField label="Tracking number">
            <TextField
              value={shipTrackingNumber}
              onChange={setShipTrackingNumber}
            />
          </FormField>
          <button
            onClick={onMarkShipped}
            disabled={markingShipped || !shipTrackingNumber}
            style={{
              background: '#4caf50',
              border: '1px solid #4caf50',
              color: '#fff',
              padding: '8px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor:
                markingShipped || !shipTrackingNumber ? 'default' : 'pointer',
              fontFamily: 'inherit',
              opacity: markingShipped || !shipTrackingNumber ? 0.6 : 1,
            }}
          >
            {markingShipped ? 'Marking…' : 'Mark shipped'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── small local primitives ─────────────────────────────────
// Inline rather than pulled from SettingsForm because the order
// detail page doesn't already import those, and the styling here
// is slightly different from the settings pages.

function FormField({ label, children }) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 11,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {label}
      {children}
    </label>
  );
}

function TextField({ value, onChange, type = 'text' }) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '6px 10px',
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        color: 'var(--text-primary)',
        fontSize: 13,
        fontFamily: 'inherit',
        textTransform: 'none',
        letterSpacing: 0,
      }}
    />
  );
}

function SecondaryButton({ onClick, disabled, danger, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: `1px solid ${danger ? 'rgba(220,53,69,0.4)' : 'var(--border-color)'}`,
        color: danger ? '#dc3545' : 'var(--text-secondary)',
        padding: '6px 12px',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// Shared styles for ShippingBlock + LinkedShippingPanel
const containerStyle = {
  marginBottom: 20,
  padding: 16,
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
};
const headerStyle = {
  fontSize: 14,
  fontWeight: 600,
};
const headerRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
};
const shippingErrorBoxStyle = {
  marginBottom: 12,
  padding: '8px 12px',
  background: 'rgba(220,53,69,0.08)',
  border: '1px solid rgba(220,53,69,0.3)',
  borderRadius: 6,
  color: '#dc3545',
  fontSize: 12,
};

function ProcessResultDisplay({ result }) {
  const allOk = result.subOrders.every((s) => s.success);
  const ss = result.shipstation; // Phase 13c: optional auto-create result

  // SS step state for the headline:
  //   - undefined → SS wasn't attempted (older server, batch run, etc.)
  //   - ok && skipped → legit skip (non-home, all-digital, already-linked, etc.)
  //   - ok && !skipped → actually created an SS order
  //   - !ok → real failure; status was NOT updated
  const ssFailed = ss && !ss.ok;
  const ssCreated = ss && ss.ok && !ss.skipped;
  const ssSkipped = ss && ss.ok && ss.skipped;

  // Overall banner color: red if anything failed (sub-order or SS),
  // amber if there were warnings, green if everything's clean.
  const overallOk = allOk && !ssFailed;
  return (
    <div
      style={{
        padding: 12,
        background: overallOk ? 'rgba(76,175,80,0.08)' : 'rgba(224,179,65,0.08)',
        border: `1px solid ${overallOk ? 'rgba(76,175,80,0.3)' : 'rgba(224,179,65,0.3)'}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: overallOk ? '#4caf50' : '#e0b341',
          marginBottom: 8,
        }}
      >
        {overallOk
          ? `✓ Processed ${result.subOrders.length} sub-order${result.subOrders.length === 1 ? '' : 's'} successfully`
          : `⚠ Completed with errors`}
        {result.statusUpdated && (
          <span style={{ fontWeight: 500, marginLeft: 8 }}>
            (status → {result.newStatusId})
          </span>
        )}
      </div>

      {/* Phase 13c: ShipStation auto-create outcome. Shown as its own
          row right under the headline so the operator immediately sees
          whether SS happened, was skipped, or failed. */}
      {ss && (
        <div
          style={{
            padding: 8,
            marginBottom: 8,
            background: ssFailed
              ? 'rgba(220,53,69,0.08)'
              : ssCreated
              ? 'rgba(76,175,80,0.06)'
              : 'rgba(255,255,255,0.03)',
            border: `1px solid ${
              ssFailed
                ? 'rgba(220,53,69,0.3)'
                : ssCreated
                ? 'rgba(76,175,80,0.25)'
                : 'var(--border-color)'
            }`,
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <div
            style={{
              fontWeight: 600,
              marginBottom: ss.message || ss.error ? 4 : 0,
              color: ssFailed ? '#dc3545' : ssCreated ? '#4caf50' : 'inherit',
            }}
          >
            {ssFailed
              ? '✗ ShipStation: failed'
              : ssCreated
              ? `✓ ShipStation: created SS#${ss.orderId}`
              : `↻ ShipStation: skipped`}
            {ssCreated && ss.packageCodeDrift && (
              <span
                style={{
                  color: '#e0b341',
                  marginLeft: 8,
                  fontSize: 11,
                  fontWeight: 500,
                }}
                title={`Sent package code "${ss.packageCodeSent}" but ShipStation stored "${ss.packageCodeStored}". Usually means SS reassigned based on the carrier/service combo.`}
              >
                ⚠ packageCode drift ({ss.packageCodeSent} → {ss.packageCodeStored})
              </span>
            )}
          </div>
          {ss.message && (
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {ss.message}
            </div>
          )}
          {ss.error && (
            <div style={{ color: '#dc3545', fontSize: 11 }}>
              {ss.error}
            </div>
          )}
          {ssFailed && (
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: 11,
                marginTop: 4,
                fontStyle: 'italic',
              }}
            >
              Sytist status was NOT updated. Fix the underlying issue
              (check API keys in Settings → API Keys, or use the manual
              Send button on this page) and run Process again.
            </div>
          )}
        </div>
      )}

      {result.subOrders.map((sub, i) => {
        const scopeName =
          sub.scope === 'home'
            ? 'Whole order'
            : `Team: ${sub.scope.subGalleryName || '(unnamed)'}`;
        return (
          <div
            key={i}
            style={{
              padding: 8,
              marginTop: i === 0 ? 0 : 8,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {sub.success ? '✓' : '✗'} {scopeName}
              {sub.error && (
                <span style={{ color: '#dc3545', marginLeft: 8 }}>— {sub.error}</span>
              )}
            </div>
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                wordBreak: 'break-all',
              }}
            >
              {sub.txtPath && <div>📄 {sub.txtPath}</div>}
              {sub.specialtyTxtPath && <div>📄 {sub.specialtyTxtPath} (specialty)</div>}
              {sub.slipPath && <div>🧾 {sub.slipPath}</div>}
              {sub.dividerPath && <div>📋 {sub.dividerPath}</div>}
            </div>
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: 11,
                marginTop: 4,
              }}
            >
              {sub.photosDownloaded.length} photo{sub.photosDownloaded.length === 1 ? '' : 's'},{' '}
              {sub.imposedSheets.length} imposed sheet{sub.imposedSheets.length === 1 ? '' : 's'}
              {sub.photosFailed.length > 0 && (
                <span style={{ color: '#dc3545', marginLeft: 8 }}>
                  ⚠ {sub.photosFailed.length} failed
                </span>
              )}
            </div>
            {sub.warnings.length > 0 && (
              <details style={{ marginTop: 6 }}>
                <summary
                  style={{
                    fontSize: 11,
                    color: '#e0b341',
                    cursor: 'pointer',
                  }}
                >
                  {sub.warnings.length} warning{sub.warnings.length === 1 ? '' : 's'}
                </summary>
                <div
                  style={{
                    marginTop: 4,
                    paddingLeft: 12,
                    fontSize: 11,
                    color: 'var(--text-muted)',
                  }}
                >
                  {sub.warnings.map((w, j) => (
                    <div key={j}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono, monospace)',
                          fontSize: 10,
                          padding: '1px 4px',
                          background: 'rgba(224,179,65,0.18)',
                          color: '#e0b341',
                          borderRadius: 3,
                          marginRight: 6,
                        }}
                      >
                        {w.type}
                      </span>
                      {w.message ||
                        (w.cartId ? `cartId ${w.cartId}` : '')}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
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

// ─── Phase 8b: Composite preview ────────────────────────────
//
// Per-line-item composite preview. Renders the same engine that runs
// during processing — useful for spot-checking before processing an
// order. Only line items that have a composite mapping appear here;
// items without a mapping are skipped (composite is opt-in per SKU).

function CompositeBlock({ order }) {
  const [open, setOpen] = useState(false);
  const [mappings, setMappings] = useState(null);

  // Load mappings once on first expand so we know which line items have
  // composite SKUs.
  useEffect(() => {
    if (!open || mappings !== null) return;
    api
      .get('/api/sytist/composite/mappings')
      .then((r) => setMappings(r.mappings || []))
      .catch(() => setMappings([]));
  }, [open, mappings]);

  const candidateLineItems = (order.lineItems || []).filter((li) => {
    if (!li.photo || !li.photo.fullUrl) return false;
    const skipFlags = ['download', 'giftCert', 'creditProduct', 'booking', 'preSell'];
    if (skipFlags.some((f) => li.flags?.[f])) return false;
    if (!mappings) return true; // before mappings load, show all eligible
    return mappings.some((m) => String(m.externalId) === String(li.sku));
  });

  return (
    <Card title="Composite preview">
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
        {open ? 'Hide' : 'Show'} composites
      </button>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        Renders memory-mate-style composites for SKUs with a composite mapping.
        Player photo + team photo (auto-resolved from Sytist) + logo (from app
        config) + text overlays, composed per the layout's slot definitions.
      </div>

      {open && mappings === null && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          Loading mappings…
        </div>
      )}

      {open && mappings !== null && candidateLineItems.length === 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          No line items in this order have composite mappings. Set up mappings in
          Settings → Composites.
        </div>
      )}

      {open &&
        mappings !== null &&
        candidateLineItems.map((li) => (
          <CompositeItemRow
            key={li.cartId}
            order={order}
            lineItem={li}
            mapping={mappings.find(
              (m) => String(m.externalId) === String(li.sku)
            )}
          />
        ))}
    </Card>
  );
}

function CompositeItemRow({ order, lineItem, mapping }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Lazily fetch the preview when expanded — composite render is
  // bandwidth-heavy (downloads player + team photo from S3) so we
  // don't render until the operator asks.
  async function loadPreview() {
    if (loading || result) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.post('/api/sytist/composite/preview', {
        orderId: order.orderId,
        cartId: lineItem.cartId,
        layoutId: mapping?.layoutId,
      });
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!expanded) loadPreview();
    setExpanded((v) => !v);
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{lineItem.productName}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            cartId {lineItem.cartId} · SKU {lineItem.sku}
            {mapping ? (
              <>
                {' · '}layout{' '}
                <code style={{ fontSize: 10 }}>{mapping.layoutId}</code>
                {mapping.chainToImposition && (
                  <span
                    style={{
                      marginLeft: 6,
                      padding: '1px 5px',
                      fontSize: 9,
                      background: 'rgba(120,120,200,0.2)',
                      color: '#aab',
                      borderRadius: 3,
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      letterSpacing: 0.5,
                    }}
                  >
                    chain
                  </span>
                )}
              </>
            ) : null}
          </div>
        </div>
        <button
          onClick={toggle}
          style={{
            background: 'transparent',
            border: '1px solid var(--border-color)',
            color: 'var(--text-secondary)',
            padding: '4px 10px',
            borderRadius: 4,
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {expanded ? 'Hide' : 'Preview'}
        </button>
      </div>

      {expanded && loading && (
        <div
          style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}
        >
          Rendering composite…
        </div>
      )}

      {expanded && error && (
        <div
          style={{
            marginTop: 10,
            padding: 8,
            background: 'rgba(220,53,69,0.08)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 4,
            color: '#dc3545',
            fontSize: 11,
          }}
        >
          {error}
        </div>
      )}

      {expanded && result && (
        <div
          style={{
            marginTop: 10,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 12,
          }}
        >
          <img
            src={`data:image/jpeg;base64,${result.jpegBase64}`}
            alt="Composite preview"
            style={{
              maxWidth: 280,
              maxHeight: 360,
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              background: '#fff',
            }}
          />
          <div style={{ fontSize: 11, lineHeight: 1.6 }}>
            <DetailLine label="Variant" value={result.variant} />
            <DetailLine
              label="Output"
              value={
                result.dimensions
                  ? `${result.dimensions.width} × ${result.dimensions.height} px`
                  : '—'
              }
            />
            <DetailLine
              label="Team photo"
              value={
                result.teamPhotoFound ? (
                  <span style={{ color: '#4caf50' }}>✓ Found</span>
                ) : (
                  <span style={{ color: '#e0b341' }}>
                    ⚠ Missing ({result.teamPhotoReason})
                  </span>
                )
              }
            />
            <DetailLine
              label="Logo"
              value={
                result.logoFound ? (
                  <span style={{ color: '#4caf50' }}>✓ Found</span>
                ) : (
                  <span style={{ color: '#e0b341' }}>⚠ Missing</span>
                )
              }
            />
            <DetailLine
              label="Render bytes"
              value={result.sizeBytes ? `${(result.sizeBytes / 1024).toFixed(1)} KB` : '—'}
            />

            {result.warnings && result.warnings.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  padding: 6,
                  background: 'rgba(224,179,65,0.08)',
                  border: '1px solid rgba(224,179,65,0.3)',
                  borderRadius: 4,
                }}
              >
                {result.warnings.map((w, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 10,
                      color: '#e0b341',
                      marginBottom: 1,
                    }}
                  >
                    ⚠ {w.message || JSON.stringify(w)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailLine({ label, value }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 1fr',
        marginBottom: 2,
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}:</span>
      <span>{value}</span>
    </div>
  );
}
