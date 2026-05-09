import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  Select,
  Button,
  StatusBanner,
} from '../../components/SettingsForm';

/**
 * Processing settings — controls behavior of the "Process this order"
 * orchestrator. Currently exposes one decision: whether to flip the
 * order's open_status automatically after a successful process, and to
 * what status.
 *
 * Defaults to off so the operator changes status manually after
 * verifying. When enabled, the orchestrator will only update status
 * if EVERY sub-order succeeded (no partial-success status flips).
 */
export default function ProcessingSettings() {
  const [settings, setSettings] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  // Edit state (committed on Save)
  const [autoStatusUpdate, setAutoStatusUpdate] = useState(false);
  const [targetStatusId, setTargetStatusId] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [s, sl] = await Promise.all([
        api.get('/api/sytist/process/settings'),
        api.get('/api/sytist/order-statuses'),
      ]);
      setSettings(s);
      setStatuses(sl.statuses || []);
      setAutoStatusUpdate(!!s.autoStatusUpdate);
      setTargetStatusId(
        s.targetStatusId !== null && s.targetStatusId !== undefined
          ? String(s.targetStatusId)
          : ''
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function isDirty() {
    if (!settings) return false;
    if (autoStatusUpdate !== !!settings.autoStatusUpdate) return true;
    const currentTarget =
      settings.targetStatusId !== null && settings.targetStatusId !== undefined
        ? String(settings.targetStatusId)
        : '';
    if (targetStatusId !== currentTarget) return true;
    return false;
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await api.put('/api/sytist/process/settings', {
        autoStatusUpdate,
        targetStatusId:
          targetStatusId === '' ? null : parseInt(targetStatusId, 10),
      });
      setStatus({ kind: 'success', message: 'Processing settings saved' });
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Processing" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Processing" />
        <StatusBanner kind="error" message={error} />
      </div>
    );
  }

  const dirty = isDirty();

  // Build the status options. "Open / Queue" is always status 0.
  const statusOptions = [
    { value: '', label: '— Off (no automatic update) —' },
    { value: '0', label: 'Open (status 0)' },
    ...statuses.map((s) => ({
      value: String(s.id),
      label: `${s.name} (status ${s.id})`,
    })),
  ];

  return (
    <div>
      <PageHeader
        title="Processing"
        subtitle="Behavior of the 'Process this order' orchestrator. Off by default — flip status manually after verifying."
        actions={
          <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
          </Button>
        }
      />
      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}

      <Section
        title="Automatic status update"
        description="When enabled, a successfully-processed order's status is set to the target value below. Status only changes when EVERY sub-order succeeded — partial successes leave the status alone."
      >
        <FormRow>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={autoStatusUpdate}
              onChange={(e) => setAutoStatusUpdate(e.target.checked)}
            />
            <span>Update order status after successful processing</span>
          </label>
        </FormRow>

        <FormRow
          label="Target status"
          hint="Pick from existing Sytist statuses. Setting the same status the order already has is a no-op."
        >
          <Select
            value={targetStatusId}
            onChange={setTargetStatusId}
            options={statusOptions}
            disabled={!autoStatusUpdate}
          />
        </FormRow>

        {autoStatusUpdate && targetStatusId === '' && (
          <div
            style={{
              fontSize: 12,
              color: '#e0b341',
              background: 'rgba(224,179,65,0.1)',
              border: '1px solid rgba(224,179,65,0.3)',
              borderRadius: 4,
              padding: 8,
            }}
          >
            ⚠ Auto-update is on but no target status is selected. No status changes
            will fire until you pick one.
          </div>
        )}
      </Section>

      <Section title="Notes">
        <ul
          style={{
            margin: 0,
            paddingLeft: 20,
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
          }}
        >
          <li>
            Processing is non-destructive: it writes new files to your
            configured output paths but never deletes anything from Sytist.
          </li>
          <li>
            Failed sub-orders surface in the result UI; the operator handles
            those manually.
          </li>
          <li>
            Phase 4.7 will switch path mode from <code>test</code> to{' '}
            <code>production</code> — verify on a few real orders here first.
          </li>
        </ul>
      </Section>
    </div>
  );
}
