import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  StatusBanner,
} from '../../components/SettingsForm';

// ─── ApiKeysPage (Phase 13a) ────────────────────────────────
//
// UI for editing values backed by server/config/appSettings.js. The
// server returns field definitions (label, secret flag, hint, etc.)
// alongside the current values, so we can lay out the form generically
// without hard-coding fields here. New fields added to appSettings
// show up automatically.
//
// Secrets come back as "••••••••" — we treat that as "no change."
// The user has to actively type to update one, which prevents an
// accidental reload-and-save from wiping their credentials.

export default function ApiKeysPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // On mount, fetch settings. loadSettings is defined below and is
  // reused by the load-failed retry button, so we keep one canonical
  // path for the fetch logic.
  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      // Build update map. Skip values that match the masked placeholder
      // for secrets so we don't accidentally clear them — the server
      // already does this check too, but keeping the UI honest helps.
      const updates = {};
      for (const [key, value] of Object.entries(values)) {
        const field = fields.find((f) => f.key === key);
        if (!field) continue;
        if (field.secret && value === '••••••••') continue;
        updates[key] = value;
      }
      const data = await api.put('/api/shipstation/app-settings', updates);
      // Reset masked secrets to the masked value so the next render
      // doesn't show the actual saved secret (server response uses
      // the same masking).
      const newValues = { ...values };
      for (const f of fields) {
        if (f.secret) {
          newValues[f.key] = data.settings[f.key]?.value || '';
        }
      }
      setValues(newValues);
      setSavedAt(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // Centralized load function so the dedicated error state can
  // reuse it for a retry button.
  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/api/shipstation/app-settings');
      const settingsMap = data.settings || {};
      const fieldDefs = data.fields || [];
      const initialValues = {};
      for (const f of fieldDefs) {
        initialValues[f.key] = settingsMap[f.key]?.value || '';
      }
      setFields(fieldDefs.map((f) => ({ ...f, current: settingsMap[f.key] })));
      setValues(initialValues);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="API Keys" />
        <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    );
  }

  // CASE: load failed (no fields received). Don't pretend we have
  // form fields to save — show the error explicitly with a retry.
  // The most common cause is /api/shipstation routes not being
  // mounted in server/index.js yet.
  if (fields.length === 0 && error) {
    return (
      <div>
        <PageHeader
          title="API Keys"
          subtitle="API credentials and feature defaults."
        />
        <StatusBanner
          kind="error"
          message={`Couldn't load settings: ${error}`}
        />
        <div
          style={{
            padding: 16,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
          }}
        >
          {error && error.toLowerCase().includes('not found') ? (
            <>
              <strong style={{ color: 'var(--text-primary)' }}>
                Likely cause: ShipStation routes not mounted on the server.
              </strong>
              <br />
              Open <code>server/index.js</code> and add the two wiring
              snippets from the Phase 13a deploy notes — specifically{' '}
              <code>app.use('/api/shipstation', ...)</code> alongside your
              other <code>app.use('/api/...')</code> calls, and{' '}
              <code>await require('./config/appSettings').init()</code> at
              startup. Then restart the server.
            </>
          ) : (
            <>
              Couldn't reach the settings endpoint. Check the server log
              for details.
            </>
          )}
        </div>
        <button
          type="button"
          onClick={loadSettings}
          style={{
            padding: '8px 16px',
            background: 'transparent',
            border: '1px solid var(--border-color)',
            color: 'var(--text-secondary)',
            borderRadius: 6,
            fontSize: 13,
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

  // Group fields by section for a tidy presentation. We render a
  // Section per group rather than one giant form so the operator can
  // scan to the bit they care about.
  const grouped = {};
  for (const f of fields) {
    const sec = f.section || 'other';
    grouped[sec] = grouped[sec] || [];
    grouped[sec].push(f);
  }
  const sectionOrder = ['shipstation', 'shipping_defaults', 'other'];
  const sectionTitles = {
    shipstation: 'ShipStation',
    shipping_defaults: 'Shipping defaults',
    other: 'Other',
  };

  return (
    <div>
      <PageHeader
        title="API Keys"
        subtitle="API credentials and feature defaults. Stored locally on the server (server/config/app-settings.json). Secrets are masked after save."
      />

      {error && <StatusBanner kind="error" message={error} />}
      {savedAt && !error && (
        <StatusBanner
          kind="success"
          message={`Saved at ${savedAt.toLocaleTimeString()}. Changes take effect immediately — no restart needed.`}
        />
      )}

      {sectionOrder
        .filter((s) => grouped[s])
        .map((section) => (
          <Section key={section} title={sectionTitles[section] || section}>
            {grouped[section].map((f) => (
              <FormRow key={f.key} label={f.label} hint={f.hint}>
                <TextInput
                  value={values[f.key] || ''}
                  onChange={(v) =>
                    setValues((prev) => ({ ...prev, [f.key]: v }))
                  }
                  monospace={f.secret || /Code|Url/i.test(f.label)}
                  placeholder={f.default}
                  // Mark secrets as type=password so screen / shoulder
                  // surfing doesn't reveal a freshly-typed key before
                  // save.
                  type={f.secret ? 'password' : 'text'}
                />
                {f.current?.isOverridden && (
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginTop: 4,
                    }}
                  >
                    Currently overridden from default.
                  </div>
                )}
              </FormRow>
            ))}
          </Section>
        ))}

      <div style={{ marginTop: 24 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '10px 20px',
            background: 'var(--accent, #4a7fc1)',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1,
            fontFamily: 'inherit',
          }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <div
        style={{
          marginTop: 24,
          padding: 12,
          background: 'rgba(74,127,193,0.06)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>
          ShipStation API V1 credentials
        </strong>
        <br />
        Find them in ShipStation → Account → API Settings. The dashboard
        uses Basic auth with key:secret. If credentials change, paste
        new values here and click Save — no restart.
      </div>
    </div>
  );
}
