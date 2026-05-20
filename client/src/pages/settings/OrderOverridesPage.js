import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
} from '../../components/SettingsForm';

/**
 * Phase 11 — Order Overrides landing page.
 *
 * Workflow:
 *   1. Operator types an order ID.
 *   2. Clicks "Load" — fetches the order via /api/sytist/orders/:orderId.
 *   3. The order's photo line items appear as a clickable list with
 *      thumbnails. Items that already have an override get a badge.
 *   4. Click a line item → navigates to the override editor for that
 *      cart line.
 *
 * The line items picker reuses the same UX pattern as the layout
 * designer's preview picker (Phase 10a) for consistency. Operators
 * who learned the designer flow already know this one.
 *
 * Why a dedicated landing page rather than launching the editor
 * directly from the orders list: the orders list isn't refactored
 * to know about overrides yet, and override editing is rare enough
 * (only when something's actually wrong) that a dedicated entry
 * point is fine for v1.
 */
export default function OrderOverridesPage() {
  const navigate = useNavigate();
  const [orderId, setOrderId] = useState('');
  const [orderLineItems, setOrderLineItems] = useState(null);
  const [overridesByCartId, setOverridesByCartId] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadedOrderId, setLoadedOrderId] = useState('');

  async function loadOrder() {
    if (!orderId) return;
    setLoading(true);
    setError(null);
    setOrderLineItems(null);
    setOverridesByCartId({});

    try {
      // Fetch the order
      const orderResp = await api.get(
        `/api/sytist/orders/${encodeURIComponent(orderId)}`
      );
      const order = orderResp.order;
      if (!order) {
        setError('Order not found');
        return;
      }
      // Filter to line items with photos. Items without a photo
      // (downloads, gift certs) can't be overridden — there's nothing
      // to fix.
      const items = (order.lineItems || []).filter(
        (li) => li.photo && li.photo.fullUrl
      );
      if (items.length === 0) {
        setError('Order has no photo line items');
        return;
      }
      setOrderLineItems(items);
      setLoadedOrderId(String(orderId));

      // Also fetch any existing overrides for this order so we can
      // badge the line items that already have one.
      try {
        const ovResp = await api.get(
          `/api/sytist/overrides/by-order/${encodeURIComponent(orderId)}`
        );
        const map = {};
        for (const o of ovResp.overrides || []) {
          map[o.cart_id] = o;
        }
        setOverridesByCartId(map);
      } catch {
        // Non-fatal — operator can still create new overrides
        // without seeing existing-override badges.
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openEditor(cartId) {
    navigate(`/settings/overrides/${loadedOrderId}/${cartId}`);
  }

  return (
    <div>
      <PageHeader
        title="Order Overrides"
        subtitle="Tweak slot positions for one specific cart line. Overrides only affect that order — the original layout stays untouched."
      />

      <Section title="Find an order">
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-end',
          }}
        >
          <div style={{ flex: 1 }}>
            <FormRow
              label="Order ID"
              hint="Type an order ID and press Enter (or click Load) to see its line items."
            >
              <TextInput
                value={orderId}
                onChange={(v) => {
                  setOrderId(v);
                  // If the operator changes the ID, drop stale results
                  if (String(v) !== loadedOrderId) {
                    setOrderLineItems(null);
                    setError(null);
                  }
                }}
                onKeyDown={(e) => {
                  // Phase 11h: Enter triggers Load. Saves a mouse trip
                  // for a flow operators run repeatedly.
                  if (
                    e.key === 'Enter' &&
                    !loading &&
                    orderId
                  ) {
                    e.preventDefault();
                    loadOrder();
                  }
                }}
                placeholder="e.g. 110951"
                monospace
                autoFocus
                style={{
                  fontSize: 16,
                  padding: '10px 12px',
                }}
              />
            </FormRow>
          </div>
          <button
            type="button"
            onClick={loadOrder}
            disabled={!orderId || loading}
            style={{
              padding: '11px 22px',
              background: 'var(--accent, #4a7fc1)',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: loading || !orderId ? 'default' : 'pointer',
              fontFamily: 'inherit',
              fontSize: 15,
              fontWeight: 600,
              opacity: loading || !orderId ? 0.5 : 1,
              marginBottom: 20,
              whiteSpace: 'nowrap',
            }}
          >
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>

        {error && (
          <div
            style={{
              marginTop: 4,
              fontSize: 13,
              color: '#dc3545',
            }}
          >
            {error}
          </div>
        )}
      </Section>

      {orderLineItems && orderLineItems.length > 0 && (
        <Section title={`Line items in order ${loadedOrderId}`}>
          <div
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              marginBottom: 10,
            }}
          >
            Click a line item to open the override editor. Items
            already overridden show a badge.
          </div>
          <div
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            {orderLineItems.map((li) => {
              const existing = overridesByCartId[li.cartId];
              // Phase 11i: use fullUrl for un-watermarked thumbnails.
              // largeUrl is watermarked (Sportsline Photography across
              // the player), which is confusing when picking which
              // line item to override. fullUrl is bigger but loads
              // once per item and the browser caches it. Falls back
              // through largeUrl → thumbUrl if fullUrl is missing.
              const thumbUrl =
                li.photo?.fullUrl ||
                li.photo?.largeUrl ||
                li.photo?.thumbUrl;
              return (
                <div
                  key={li.cartId}
                  onClick={() => openEditor(li.cartId)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 18,
                    padding: '16px 18px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--border-color)',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background =
                      'rgba(74,127,193,0.08)')
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = 'transparent')
                  }
                >
                  {thumbUrl ? (
                    <img
                      src={thumbUrl}
                      alt=""
                      style={{
                        width: 140,
                        height: 140,
                        objectFit: 'cover',
                        borderRadius: 4,
                        background: '#222',
                        flexShrink: 0,
                      }}
                      onError={(e) => {
                        e.target.style.display = 'none';
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 140,
                        height: 140,
                        background: '#444',
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 16,
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginBottom: 3,
                      }}
                    >
                      {li.productNameDisplay || '(unnamed product)'}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono, monospace)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {li.sku || '(no SKU)'}
                      {li.photo?.originalFilename
                        ? ` · ${li.photo.originalFilename}`
                        : ''}
                      {' · cart '}
                      {li.cartId}
                      {' · qty '}
                      {li.qty}
                      {li.backgroundPhoto ? ' · 🖼️ has BG' : ''}
                    </div>
                  </div>
                  {existing && (
                    <div
                      style={{
                        padding: '5px 12px',
                        background: '#4a7fc1',
                        color: 'white',
                        borderRadius: 14,
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                      title={`Override created ${existing.created_at}`}
                    >
                      OVERRIDE
                    </div>
                  )}
                  <span
                    style={{
                      color: 'var(--text-muted)',
                      fontSize: 22,
                    }}
                  >
                    ›
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}
