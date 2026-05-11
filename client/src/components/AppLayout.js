import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import api from '../services/api';
import HomePage from '../pages/HomePage';
import OrdersListPage from '../pages/OrdersListPage';
import OrderDetailPage from '../pages/OrderDetailPage';
import SettingsLayout from '../pages/settings/SettingsLayout';
import PathsSettings from '../pages/settings/PathsSettings';
import FolderSortSettings from '../pages/settings/FolderSortSettings';
import DarkroomSettings from '../pages/settings/DarkroomSettings';
import SlipSettings from '../pages/settings/SlipSettings';
import ImpositionSettings from '../pages/settings/ImpositionSettings';
import ProcessingSettings from '../pages/settings/ProcessingSettings';
import SpecialtySettings from '../pages/settings/SpecialtySettings';
import ProcessHistoryPage from '../pages/settings/ProcessHistoryPage';
import GalleryAssetsSettings from '../pages/settings/GalleryAssetsSettings';
import CompositesSettings from '../pages/settings/CompositesSettings';
import LayoutDesignerPage from '../pages/settings/LayoutDesignerPage';
import OrderOverridesPage from '../pages/settings/OrderOverridesPage';
import OverrideEditorPage from '../pages/settings/OverrideEditorPage';

/**
 * App shell shown to authenticated users.
 *
 * Header: brand + nav links + user identity / logout.
 * Main:   the matched route's page.
 *
 * Phase 4.5: adds /settings sub-routes (admin-gated inside SettingsLayout).
 * Phase 4.7: production-mode banner across the top + Process History.
 */
export default function AppLayout({ user, onLogout }) {
  // Phase 4.7 — fetch the current path mode so we can show the
  // PRODUCTION banner. We refetch periodically (every 30s) so a mode
  // change made in another tab/session reflects here without a reload.
  const [pathMode, setPathMode] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const refresh = async () => {
      try {
        const cfg = await api.get('/api/sytist/paths/config');
        if (!cancelled) setPathMode(cfg.mode || null);
      } catch (err) {
        // Swallow — don't crash the app if /paths/config is briefly
        // unreachable. The banner just won't show until next refresh.
      }
      if (!cancelled) timer = setTimeout(refresh, 30000);
    };
    refresh();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

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
      {pathMode === 'production' && <ProductionBanner />}

      <Header user={user} onLogout={onLogout} pathMode={pathMode} />

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
            <Route path="processing" element={<ProcessingSettings />} />
            <Route path="specialty" element={<SpecialtySettings />} />
            <Route path="gallery-assets" element={<GalleryAssetsSettings />} />
            <Route path="composites" element={<CompositesSettings />} />
            <Route
              path="composites/designer/:layoutId"
              element={<LayoutDesignerPage />}
            />
            {/* Phase 11: per-order layout overrides */}
            <Route path="overrides" element={<OrderOverridesPage />} />
            <Route
              path="overrides/:orderId/:cartId"
              element={<OverrideEditorPage />}
            />
            <Route path="process-history" element={<ProcessHistoryPage />} />
          </Route>

          {/* Unknown paths fall back to home. Could be a 404 page later. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ user, onLogout, pathMode }) {
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {pathMode && <ModeChip mode={pathMode} />}
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

function ModeChip({ mode }) {
  const isProd = mode === 'production';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: '3px 9px',
        borderRadius: 10,
        background: isProd ? '#b91c1c' : 'rgba(224,179,65,0.15)',
        color: isProd ? '#ffffff' : '#e0b341',
        border: isProd ? '1px solid #991b1b' : '1px solid rgba(224,179,65,0.4)',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
        whiteSpace: 'nowrap',
      }}
      title={isProd ? 'Production mode — Darkroom will pick up writes' : 'Test sandbox — files do not reach Darkroom'}
    >
      {isProd ? 'PROD' : 'TEST'}
    </span>
  );
}

/**
 * Phase 4.7 — full-width red banner across the top of the app when path
 * mode is "production". Always-on (not dismissible) since the entire
 * point is to make sure the operator never accidentally processes
 * thinking they're in test mode.
 */
function ProductionBanner() {
  return (
    <div
      style={{
        background: 'linear-gradient(90deg, #b91c1c 0%, #991b1b 50%, #b91c1c 100%)',
        color: '#ffffff',
        padding: '8px 24px',
        textAlign: 'center',
        fontSize: 13,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 1,
        boxShadow: '0 2px 8px rgba(185,28,28,0.5)',
        borderBottom: '2px solid #7f1d1d',
        position: 'relative',
        zIndex: 100,
      }}
    >
      <span style={{ marginRight: 8 }}>⚠</span>
      Production Mode — files written here are picked up by Darkroom
      <span style={{ marginLeft: 8 }}>⚠</span>
    </div>
  );
}
