import React from 'react';
import { useSearchParams, Link } from 'react-router-dom';

/**
 * Phase 3a: empty placeholder. The real list, filters, and pagination land
 * in sub-step 3b. For now we just confirm the route works and that any
 * filter query params from a HomePage stat card click arrived intact.
 */
export default function OrdersListPage() {
  const [searchParams] = useSearchParams();
  const filters = Object.fromEntries(searchParams.entries());

  return (
    <div style={{ maxWidth: 1080, margin: '32px auto', padding: '0 24px', width: '100%' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Orders</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 24px' }}>
        Phase 3a placeholder. Real list, filters, and pagination ship in 3b.
      </p>

      <div
        style={{
          padding: 20,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
        }}
      >
        <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>Filters received from URL</h2>
        {Object.keys(filters).length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
            (none — visit from a stat card on the home page to test)
          </p>
        ) : (
          <pre
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              padding: 12,
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--text-secondary)',
              margin: 0,
            }}
          >
            {JSON.stringify(filters, null, 2)}
          </pre>
        )}
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 24 }}>
        Sample link to test detail route:{' '}
        <Link to="/orders/110855" style={{ color: 'var(--accent)' }}>
          /orders/110855
        </Link>
      </p>
    </div>
  );
}
