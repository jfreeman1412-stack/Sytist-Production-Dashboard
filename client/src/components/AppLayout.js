import React from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import HomePage from '../pages/HomePage';
import OrdersListPage from '../pages/OrdersListPage';
import OrderDetailPage from '../pages/OrderDetailPage';
import SettingsLayout from '../pages/settings/SettingsLayout';
import PathsSettings from '../pages/settings/PathsSettings';
import FolderSortSettings from '../pages/settings/FolderSortSettings';
import DarkroomSettings from '../pages/settings/DarkroomSettings';
import SlipSettings from '../pages/settings/SlipSettings';
import ImpositionSettings from '../pages/settings/ImpositionSettings';

/**
 * App shell shown to authenticated users.
 *
 * Header: brand + nav links + user identity / logout.
 * Main:   the matched route's page.
 *
 * Phase 4.5: adds /settings sub-routes (admin-gated inside SettingsLayout).
 */
export default function AppLayout({ user, onLogout }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Header user={user} onLogout={onLogout} />

      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/orders" element={<OrdersListPage />} />
          <Route path="/orders/:orderId" element={<OrderDetailPage />} />

          {/* Settings: nested routes inside SettingsLayout (sidebar + outlet).
              Default redirect → /settings/paths. */}
          <Route path="/settings" element={<SettingsLayout user={user} />}>
            <Route index element={<Navigate to="paths" replace />} />
            <Route path="paths" element={<PathsSettings />} />
            <Route path="folder-sort" element={<FolderSortSettings />} />
            <Route path="darkroom" element={<DarkroomSettings />} />
            <Route path="slip" element={<SlipSettings />} />
            <Route path="imposition" element={<ImpositionSettings />} />
          </Route>

          {/* Unknown paths fall back to home. Could be a 404 page later. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ user, onLogout }) {
  const navLinkStyle = ({ isActive }) => ({
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
    background: isActive ? 'var(--bg-input)' : 'transparent',
    textDecoration: 'none',
    fontWeight: isActive ? 600 : 500,
  });

  return (
    <header
      style={{
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <NavLink
          to="/"
          style={{
            fontSize: 16,
            fontWeight: 600,
            textDecoration: 'none',
            color: 'var(--text-primary)',
          }}
        >
          Sytist Dashboard
        </NavLink>

        <nav style={{ display: 'flex', gap: 4 }}>
          <NavLink to="/orders" style={navLinkStyle}>
            Orders
          </NavLink>
          {user.role === 'admin' && (
            <NavLink to="/settings" style={navLinkStyle}>
              Settings
            </NavLink>
          )}
        </nav>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13 }}>{user.displayName || user.username}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{user.role}</div>
        </div>
        <button
          className="btn btn-secondary"
          onClick={onLogout}
          style={{ padding: '6px 12px', fontSize: 12 }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
