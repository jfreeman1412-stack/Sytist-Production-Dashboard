import React, { useState } from 'react';
import api from '../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  Button,
  StatusBanner,
} from '../components/SettingsForm';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Profile page (Phase 73).
 *
 * Top-level route (/profile) — accessible to any authenticated user,
 * intentionally NOT under /settings/* because that subtree is admin-only.
 * Reached via the clickable username in AppLayout's header.
 *
 * Calls PUT /api/auth/profile (already wired server-side) to update display
 * name and/or password for the currently-signed-in user.
 *
 * Session behaviour after a self-password change: the existing session
 * KEEPS WORKING. Sessions are UUID-keyed and stored in SQLite with no tie
 * to the password (see authService.validateSession — joins on users.active=1
 * but not on password_hash; authService.updateUser({password}) updates the
 * users row, never touches the sessions row). The next sign-in requires the
 * new password. UX message after a successful password change makes this
 * explicit so the operator doesn't worry they need to sign back in.
 */
export default function ProfilePage({ user, onUserUpdate }) {
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  async function handleSave(e) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        return;
      }
      if (password !== passwordConfirm) {
        setError('Password and confirmation do not match');
        return;
      }
    }

    const updates = {};
    const trimmedName = displayName.trim();
    if (trimmedName !== (user.displayName || '')) {
      updates.displayName = trimmedName;
    }
    if (password) {
      updates.password = password;
    }
    if (Object.keys(updates).length === 0) {
      setError('No changes to save');
      return;
    }

    setSaving(true);
    try {
      const result = await api.updateProfile(updates);
      const passwordChanged = Boolean(updates.password);
      const nameChanged = Boolean(updates.displayName !== undefined);
      let msg = 'Profile updated.';
      if (passwordChanged) {
        msg +=
          ' Your current session remains active — the new password is required at the next sign-in.';
      }
      if (nameChanged && !passwordChanged) {
        msg = 'Display name updated.';
      }
      setSuccess(msg);
      setPassword('');
      setPasswordConfirm('');
      // Notify the App shell so the header reflects the new display name
      // immediately without a reload.
      if (result && result.user && typeof onUserUpdate === 'function') {
        onUserUpdate(result.user);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 32px' }}>
      <PageHeader
        title="Profile"
        subtitle="Change your display name and password. Admin actions on other users live in Settings → Users."
      />

      {error && <StatusBanner kind="error" message={error} />}
      {success && <StatusBanner kind="success" message={success} />}

      <Section title="Identity">
        <FormRow label="Username" hint="Username is set by an admin and cannot be changed here.">
          <TextInput value={user.username} onChange={() => {}} disabled />
        </FormRow>
        <FormRow label="Role" hint="Roles are set by an admin.">
          <TextInput value={user.role} onChange={() => {}} disabled />
        </FormRow>
      </Section>

      <form onSubmit={handleSave}>
        <Section title="Display name">
          <FormRow label="Display name" hint="Shown in the header and in audit lines.">
            <TextInput value={displayName} onChange={setDisplayName} />
          </FormRow>
        </Section>

        <Section title="Change password">
          <FormRow
            label="New password"
            hint={`Leave blank to keep your current password. Minimum ${MIN_PASSWORD_LENGTH} characters if changing.`}
          >
            <TextInput
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete="new-password"
            />
          </FormRow>
          <FormRow label="Confirm new password">
            <TextInput
              value={passwordConfirm}
              onChange={setPasswordConfirm}
              type="password"
              autoComplete="new-password"
            />
          </FormRow>
        </Section>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </div>
  );
}
