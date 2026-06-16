import React, { useEffect, useState, useCallback } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  Select,
  Button,
  StatusBanner,
  settingsStyles,
} from '../../components/SettingsForm';

// Phase 73: username sanitization rule. UI hygiene only — the server's
// authService.createUser accepts any non-empty string. The rule helps keep
// audit lines like "[Processing] ranBy=joey" readable across the codebase.
const USERNAME_REGEX = /^[A-Za-z0-9_.-]+$/;
const MIN_PASSWORD_LENGTH = 8;
const ROLES = ['admin', 'operator', 'viewer'];

function relativeTime(iso) {
  if (!iso) return 'Never';
  const then = new Date(iso);
  if (isNaN(then.getTime())) return 'Unknown';
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

/**
 * Settings → Users (Phase 73).
 *
 * Admin-only (gated by SettingsLayout). Lists, adds, edits, and deactivates
 * users via /api/auth/users (already role-gated server-side). Self-protection
 * mirrors the server-side last-admin invariant in authService.updateUser:
 * the "Deactivate" button and the role <select> are disabled with a tooltip
 * when the target is the only active admin. The server is authoritative —
 * the UI just avoids round-trips for the obvious case.
 *
 * Soft-delete by design: "Deactivate" sets active=0 (preserves audit history
 * + the unique username constraint); "Reactivate" flips it back. There is no
 * hard-delete UI — see CLAUDE.md "Soft-delete for users" landmine.
 */
export default function UsersSettings({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get('/api/auth/users');
      setUsers(r.users || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeAdminCount = users.filter(
    (u) => u.role === 'admin' && u.active
  ).length;

  async function handleActiveToggle(u, makeActive) {
    const verb = makeActive ? 'Reactivate' : 'Deactivate';
    if (!window.confirm(`${verb} user "${u.username}"?`)) return;
    try {
      if (makeActive) {
        await api.put(`/api/auth/users/${u.id}`, { active: true });
      } else {
        await api.del(`/api/auth/users/${u.id}`);
      }
      load();
    } catch (e) {
      window.alert(e.message);
    }
  }

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Add, edit, and deactivate dashboard users. At least one active admin must always exist."
        actions={
          !showAddForm && !editingId ? (
            <Button variant="primary" onClick={() => setShowAddForm(true)}>
              Add user
            </Button>
          ) : null
        }
      />

      {error && <StatusBanner kind="error" message={error} />}

      {showAddForm && (
        <AddUserForm
          onCancel={() => setShowAddForm(false)}
          onSaved={() => {
            setShowAddForm(false);
            load();
          }}
        />
      )}

      <Section title="Existing users">
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Loading…
          </div>
        ) : (
          <table style={settingsStyles.table}>
            <thead>
              <tr>
                <th style={settingsStyles.th}>Username</th>
                <th style={settingsStyles.th}>Display name</th>
                <th style={settingsStyles.th}>Role</th>
                <th style={settingsStyles.th}>Status</th>
                <th style={settingsStyles.th}>Created</th>
                <th style={settingsStyles.th}>Last login</th>
                <th
                  style={{
                    ...settingsStyles.th,
                    width: 220,
                    textAlign: 'right',
                  }}
                />
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      ...settingsStyles.td,
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                    }}
                  >
                    No users
                  </td>
                </tr>
              )}
              {users.map((u) => {
                if (editingId === u.id) {
                  return (
                    <EditRow
                      key={u.id}
                      user={u}
                      activeAdminCount={activeAdminCount}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        load();
                      }}
                    />
                  );
                }
                const isSelf = currentUser && currentUser.id === u.id;
                const isLastActiveAdmin =
                  u.role === 'admin' && u.active && activeAdminCount === 1;
                const rowStyle = u.active ? {} : { opacity: 0.55 };
                return (
                  <tr key={u.id} style={rowStyle}>
                    <td
                      style={{
                        ...settingsStyles.td,
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: 13,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {u.username}
                      {isSelf && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            color: 'var(--text-muted)',
                          }}
                        >
                          (you)
                        </span>
                      )}
                    </td>
                    <td style={settingsStyles.td}>{u.displayName || '—'}</td>
                    <td style={settingsStyles.td}>
                      <RoleBadge role={u.role} />
                    </td>
                    <td style={settingsStyles.td}>
                      <ActiveBadge active={u.active} />
                    </td>
                    <td
                      style={{
                        ...settingsStyles.td,
                        fontSize: 12,
                        color: 'var(--text-muted)',
                      }}
                      title={u.createdAt || ''}
                    >
                      {formatDate(u.createdAt)}
                    </td>
                    <td
                      style={{
                        ...settingsStyles.td,
                        fontSize: 12,
                        color: 'var(--text-muted)',
                      }}
                      title={u.lastLoginAt || 'Never signed in'}
                    >
                      {relativeTime(u.lastLoginAt)}
                    </td>
                    <td
                      style={{
                        ...settingsStyles.td,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Button
                        variant="ghost"
                        onClick={() => setEditingId(u.id)}
                      >
                        Edit
                      </Button>{' '}
                      {u.active ? (
                        <Button
                          variant="danger"
                          disabled={isLastActiveAdmin}
                          title={
                            isLastActiveAdmin
                              ? 'Cannot deactivate the last active admin'
                              : `Deactivate ${u.username}`
                          }
                          onClick={() => handleActiveToggle(u, false)}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => handleActiveToggle(u, true)}
                        >
                          Reactivate
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function RoleBadge({ role }) {
  const palette = {
    admin: { color: '#b91c1c', border: 'rgba(185,28,28,0.4)' },
    operator: { color: '#1d4ed8', border: 'rgba(29,78,216,0.4)' },
    viewer: { color: '#525252', border: 'rgba(82,82,82,0.4)' },
  };
  const p = palette[role] || palette.viewer;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        fontSize: 10,
        fontWeight: 700,
        color: p.color,
        border: `1px solid ${p.border}`,
        borderRadius: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {role}
    </span>
  );
}

function ActiveBadge({ active }) {
  return active ? (
    <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>
      Active
    </span>
  ) : (
    <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>
      Deactivated
    </span>
  );
}

function AddUserForm({ onCancel, onSaved }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('admin');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function validate() {
    const u = username.trim();
    if (!u) return 'Username is required';
    if (!USERNAME_REGEX.test(u)) {
      return 'Username may contain only letters, numbers, dot, dash, underscore';
    }
    if (!password) return 'Password is required';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/auth/users', {
        username: username.trim(),
        password,
        displayName: displayName.trim() || undefined,
        role,
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Add user"
      actions={
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      }
    >
      <form onSubmit={handleSubmit}>
        {error && <StatusBanner kind="error" message={error} />}
        <FormRow
          label="Username"
          hint="Letters, numbers, dot, dash, underscore. Must be unique (deactivated users still hold their username — reactivate instead of recreating)."
        >
          <TextInput value={username} onChange={setUsername} autoFocus />
        </FormRow>
        <FormRow
          label="Password"
          hint={`Minimum ${MIN_PASSWORD_LENGTH} characters. No complexity rules enforced server-side.`}
        >
          <TextInput value={password} onChange={setPassword} type="password" />
        </FormRow>
        <FormRow
          label="Display name"
          hint="Optional. Falls back to username if blank."
        >
          <TextInput value={displayName} onChange={setDisplayName} />
        </FormRow>
        <FormRow label="Role">
          <Select
            value={role}
            onChange={setRole}
            options={ROLES.map((r) => ({ value: r, label: r }))}
          />
        </FormRow>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create user'}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Section>
  );
}

function EditRow({ user, activeAdminCount, onCancel, onSaved }) {
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [role, setRole] = useState(user.role);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isLastActiveAdmin =
    user.role === 'admin' && user.active && activeAdminCount === 1;

  async function handleSave() {
    setError(null);
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    const updates = {};
    if (displayName.trim() !== (user.displayName || '')) {
      updates.displayName = displayName.trim();
    }
    if (role !== user.role) updates.role = role;
    if (password) updates.password = password;
    if (Object.keys(updates).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await api.put(`/api/auth/users/${user.id}`, updates);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr style={{ background: 'var(--bg-input)' }}>
      <td colSpan={7} style={{ padding: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            marginBottom: 12,
            gap: 12,
          }}
        >
          <strong
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 14,
              color: 'var(--text-primary)',
            }}
          >
            {user.username}
          </strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            (editing)
          </span>
        </div>
        {error && <StatusBanner kind="error" message={error} />}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
          }}
        >
          <FormRow
            label="Display name"
            hint="Optional. Falls back to username if blank."
          >
            <TextInput value={displayName} onChange={setDisplayName} />
          </FormRow>
          <FormRow
            label="Role"
            hint={
              isLastActiveAdmin
                ? 'Cannot change — this is the last active admin'
                : undefined
            }
          >
            <Select
              value={role}
              onChange={setRole}
              disabled={isLastActiveAdmin}
              options={ROLES.map((r) => ({ value: r, label: r }))}
            />
          </FormRow>
        </div>
        <FormRow
          label="New password"
          hint={`Leave blank to keep the current password. Minimum ${MIN_PASSWORD_LENGTH} characters if changing.`}
        >
          <TextInput value={password} onChange={setPassword} type="password" />
        </FormRow>
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </td>
    </tr>
  );
}
