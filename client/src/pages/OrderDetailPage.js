import React from 'react';
import { useParams, Link } from 'react-router-dom';

/**
 * Phase 3a: empty placeholder. Real detail view lands in sub-step 3c.
 * For now we confirm the route param parses and that we can navigate back.
 */
export default function OrderDetailPage() {
  const { orderId } = useParams();

  return (
    <div style={{ maxWidth: 1080, margin: '32px auto', padding: '0 24px', width: '100%' }}>
      <Link
        to="/orders"
        style={{
          fontSize: 13,
          color: 'var(--accent)',
          textDecoration: 'none',
        }}
      >
        ← Back to Orders
      </Link>

      <h1 style={{ fontSize: 22, margin: '16px 0 8px' }}>Order {orderId}</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
        Phase 3a placeholder. Real detail view ships in 3c.
      </p>
    </div>
  );
}
