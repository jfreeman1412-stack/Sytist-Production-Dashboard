import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  Button,
  StatusBanner,
} from '../../components/SettingsForm';

/**
 * Packing slip settings — studio info that appears in the slip footer
 * and highlight colors for items rows.
 */
export default function SlipSettings() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  // Edit state — initialized from config on load.
  const [studio, setStudio] = useState(null);
  const [highlightColors, setHighlightColors] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.get('/api/sytist/slip/config');
      setConfig(d);
      setStudio({
        name: d.studio?.name || '',
        email: d.studio?.email || '',
        phone: d.studio?.phone || '',
        showReturnAddress: !!d.studio?.showReturnAddress,
        returnAddress: {
          address1: d.studio?.returnAddress?.address1 || '',
          city: d.studio?.returnAddress?.city || '',
          state: d.studio?.returnAddress?.state || '',
          zipCode: d.studio?.returnAddress?.zipCode || '',
        },
      });
      setHighlightColors({
        specialty: d.highlightColors?.specialty || '#fff5e6',
        quantity: d.highlightColors?.quantity || '#fff0f0',
      });
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
    if (!config || !studio) return false;
    if (studio.name !== (config.studio?.name || '')) return true;
    if (studio.email !== (config.studio?.email || '')) return true;
    if (studio.phone !== (config.studio?.phone || '')) return true;
    if (studio.showReturnAddress !== !!config.studio?.showReturnAddress) return true;
    const ra = studio.returnAddress;
    const cra = config.studio?.returnAddress || {};
    if (ra.address1 !== (cra.address1 || '')) return true;
    if (ra.city !== (cra.city || '')) return true;
    if (ra.state !== (cra.state || '')) return true;
    if (ra.zipCode !== (cra.zipCode || '')) return true;
    if (highlightColors.specialty !== (config.highlightColors?.specialty || '')) return true;
    if (highlightColors.quantity !== (config.highlightColors?.quantity || '')) return true;
    return false;
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await api.put('/api/sytist/slip/config', {
        studio,
        highlightColors,
      });
      setStatus({ kind: 'success', message: 'Slip config saved' });
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
        <PageHeader title="Packing Slip" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Packing Slip" />
        <StatusBanner kind="error" message={error} />
      </div>
    );
  }
  if (!studio || !highlightColors) return null;

  const dirty = isDirty();

  return (
    <div>
      <PageHeader
        title="Packing Slip"
        subtitle="Studio info shown in the slip footer and item-row highlight colors."
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

      <Section title="Studio info" description="Renders next to the QR code in the slip footer.">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FormRow label="Studio name">
            <TextInput
              value={studio.name}
              onChange={(v) => setStudio({ ...studio, name: v })}
            />
          </FormRow>
          <FormRow label="Email">
            <TextInput
              value={studio.email}
              onChange={(v) => setStudio({ ...studio, email: v })}
            />
          </FormRow>
          <FormRow
            label="Phone"
            hint="Auto-formatted as (XXX) XXX-XXXX in the rendered slip."
          >
            <TextInput
              value={studio.phone}
              onChange={(v) => setStudio({ ...studio, phone: v })}
              placeholder="6125551234"
            />
          </FormRow>
        </div>
      </Section>

      <Section
        title="Return address"
        description="Optional. When enabled, renders below the studio info in the slip footer."
        actions={
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={studio.showReturnAddress}
              onChange={(e) =>
                setStudio({ ...studio, showReturnAddress: e.target.checked })
              }
            />
            Show on slip
          </label>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.7fr 1fr', gap: 12 }}>
          <FormRow label="Address line 1">
            <TextInput
              value={studio.returnAddress.address1}
              onChange={(v) =>
                setStudio({
                  ...studio,
                  returnAddress: { ...studio.returnAddress, address1: v },
                })
              }
              disabled={!studio.showReturnAddress}
            />
          </FormRow>
          <FormRow label="City">
            <TextInput
              value={studio.returnAddress.city}
              onChange={(v) =>
                setStudio({
                  ...studio,
                  returnAddress: { ...studio.returnAddress, city: v },
                })
              }
              disabled={!studio.showReturnAddress}
            />
          </FormRow>
          <FormRow label="State">
            <TextInput
              value={studio.returnAddress.state}
              onChange={(v) =>
                setStudio({
                  ...studio,
                  returnAddress: { ...studio.returnAddress, state: v },
                })
              }
              disabled={!studio.showReturnAddress}
            />
          </FormRow>
          <FormRow label="ZIP">
            <TextInput
              value={studio.returnAddress.zipCode}
              onChange={(v) =>
                setStudio({
                  ...studio,
                  returnAddress: { ...studio.returnAddress, zipCode: v },
                })
              }
              disabled={!studio.showReturnAddress}
            />
          </FormRow>
        </div>
      </Section>

      <Section
        title="Highlight colors"
        description="Backgrounds applied to slip item rows. Specialty highlights items flagged by the future specialtyService (Phase 4.5+); quantity highlights items with qty > 1."
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <ColorRow
            label="Specialty"
            value={highlightColors.specialty}
            onChange={(v) =>
              setHighlightColors({ ...highlightColors, specialty: v })
            }
          />
          <ColorRow
            label="Quantity > 1"
            value={highlightColors.quantity}
            onChange={(v) =>
              setHighlightColors({ ...highlightColors, quantity: v })
            }
          />
        </div>
      </Section>
    </div>
  );
}

function ColorRow({ label, value, onChange }) {
  return (
    <FormRow label={label}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 56,
            height: 36,
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            cursor: 'pointer',
            background: 'var(--bg-input)',
          }}
        />
        <TextInput value={value} onChange={onChange} monospace />
      </div>
    </FormRow>
  );
}
