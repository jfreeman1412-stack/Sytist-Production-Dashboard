import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';

/**
 * Settings page shell. Renders a sidebar of section links on the left
 * and the active section's content in the right pane via <Outlet>.
 *
 * Admin-only — non-admin users see an access denied message instead.
 *
 * The sidebar items map 1:1 to routes registered in AppLayout under
 * /settings/*. Adding a new section: register the route in AppLayout,
 * add a SidebarLink here.
 */
export default function SettingsLayout({ user }) {
  if (!user || user.role !== 'admin') {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center' }}>
        <div
          style={{
            display: 'inline-block',
            padding: 24,
            background: 'rgba(220,53,69,0.08)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 8,
            color: '#dc3545',
            maxWidth: 480,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
            Access denied
          </div>
          <div style={{ fontSize: 13 }}>
            Settings is restricted to administrators. You're signed in as{' '}
            <strong>{user?.role || 'unknown'}</strong>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        minHeight: 0,
      }}
    >
      <Sidebar />
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '24px 32px',
          minWidth: 0,
        }}
      >
        <Outlet />
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-color)',
        padding: '20px 12px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          padding: '0 12px 12px',
        }}
      >
        Settings
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SidebarLink to="paths" label="Paths" />
        <SidebarLink to="folder-sort" label="Folder Sort" />
        <SidebarLink to="darkroom" label="Darkroom" />
        <SidebarLink to="slip" label="Packing Slip" />
        <SidebarLink to="imposition" label="Imposition" />
      </nav>
    </aside>
  );
}

function SidebarLink({ to, label }) {
  return (
    <NavLink
      to={to}
      end
      style={({ isActive }) => ({
        display: 'block',
        padding: '8px 12px',
        borderRadius: 6,
        fontSize: 13,
        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
        background: isActive ? 'var(--bg-input)' : 'transparent',
        textDecoration: 'none',
        fontWeight: isActive ? 600 : 500,
      })}
    >
      {label}
    </NavLink>
  );
}
