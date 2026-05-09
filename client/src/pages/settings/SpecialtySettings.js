import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  Button,
  StatusBanner,
  settingsStyles,
} from '../../components/SettingsForm';

/**
 * Specialty products settings — registry of SKUs that get separate
 * routing during processing. Specialty items land in a dedicated folder
 * (basePath\subfolder) so the lab can pull them into their own bin.
 *
 * Three sub-sections:
 *   1. Base path — where specialty subfolders live. Empty = downloadBase\Specialty
 *   2. Products — externalId/productName/subfolder/dropShipped
 *   3. Highlight colors — slip row tints (specialty + qty>1)
 */
export default function SpecialtySettings() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const c = await api.get('/api/sytist/specialty/config');
      setConfig(c);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div>
        <PageHeader title="Specialty" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Specialty" />
        <StatusBanner kind="error" message={error} />
      </div>
    );
  }
  if (!config) return null;

  return (
    <div>
      <PageHeader
        title="Specialty"
        subtitle="Registry of SKUs that get separate routing during processing. Specialty items land in a dedicated folder so the lab can pull them into their own bin."
      />
      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}

      <BasePathSection
        basePath={config.basePath}
        onChange={load}
        onStatus={setStatus}
      />

      <ProductsSection
        products={config.products || []}
        onChange={load}
        onStatus={setStatus}
      />

      <HighlightColorsSection
        colors={config.highlightColors || {}}
        onChange={load}
        onStatus={setStatus}
      />
    </div>
  );
}

// ─── Base path ──────────────────────────────────────────────

function BasePathSection({ basePath, onChange, onStatus }) {
  const [value, setValue] = useState(basePath || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(basePath || '');
  }, [basePath]);

  const dirty = value !== (basePath || '');

  async function handleSave() {
    setSaving(true);
    try {
      await api.put('/api/sytist/specialty/base-path', { basePath: value });
      onStatus({ kind: 'success', message: 'Base path saved' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Base path"
      description="Root folder for specialty product output. Each product's subfolder is appended. Leave blank to use the default — downloadBase\\Specialty."
      actions={
        <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </Button>
      }
    >
      <FormRow
        hint="Tokens like {date} aren't substituted here — give an absolute path like Z:\\Sytist\\__Specialty"
      >
        <TextInput value={value} onChange={setValue} monospace placeholder="(use default downloadBase\\Specialty)" />
      </FormRow>
    </Section>
  );
}

// ─── Products CRUD ──────────────────────────────────────────

function ProductsSection({ products, onChange, onStatus }) {
  const [editingSku, setEditingSku] = useState(null);
  const [newSku, setNewSku] = useState('');
  const [newProductName, setNewProductName] = useState('');
  const [newSubfolder, setNewSubfolder] = useState('');
  const [newDropShipped, setNewDropShipped] = useState(false);
  const [editFields, setEditFields] = useState({});
  const [busy, setBusy] = useState(false);

  function startEdit(p) {
    setEditingSku(p.externalId);
    setEditFields({
      productName: p.productName || '',
      subfolder: p.subfolder || '',
      dropShipped: !!p.dropShipped,
    });
  }

  async function handleAdd() {
    if (!newSku.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/sytist/specialty/products', {
        externalId: newSku.trim(),
        productName: newProductName.trim(),
        subfolder: newSubfolder.trim() || newProductName.trim() || newSku.trim(),
        dropShipped: newDropShipped,
      });
      setNewSku('');
      setNewProductName('');
      setNewSubfolder('');
      setNewDropShipped(false);
      onStatus({ kind: 'success', message: 'Specialty product added' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Add failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(externalId) {
    setBusy(true);
    try {
      await api.put(`/api/sytist/specialty/products/${encodeURIComponent(externalId)}`, editFields);
      setEditingSku(null);
      onStatus({ kind: 'success', message: 'Specialty product updated' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(externalId) {
    if (!window.confirm(`Delete specialty product "${externalId}"?`)) return;
    setBusy(true);
    try {
      await api.del(`/api/sytist/specialty/products/${encodeURIComponent(externalId)}`);
      onStatus({ kind: 'success', message: 'Specialty product deleted' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Delete failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={`Products (${products.length})`}
      description="Each entry registers a SKU as a specialty product. During processing, the photo and (if applicable) imposed sheet land in basePath\\subfolder. Drop-shipped items will skip ShipStation in Phase 5+."
    >
      <table style={settingsStyles.table}>
        <thead>
          <tr>
            <th style={settingsStyles.th}>SKU</th>
            <th style={settingsStyles.th}>Product name</th>
            <th style={settingsStyles.th}>Subfolder</th>
            <th style={{ ...settingsStyles.th, width: 90, textAlign: 'center' }}>Drop-ship</th>
            <th style={{ ...settingsStyles.th, width: 160, textAlign: 'right' }}></th>
          </tr>
        </thead>
        <tbody>
          {products.length === 0 && (
            <tr>
              <td
                colSpan={5}
                style={{
                  ...settingsStyles.td,
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}
              >
                No specialty products defined yet.
              </td>
            </tr>
          )}
          {products.map((p) => {
            const isEditing = editingSku === p.externalId;
            return (
              <tr key={p.externalId}>
                <td style={{ ...settingsStyles.td, fontFamily: 'var(--font-mono, monospace)' }}>
                  {p.externalId}
                </td>
                <td style={settingsStyles.td}>
                  {isEditing ? (
                    <TextInput
                      value={editFields.productName}
                      onChange={(v) => setEditFields({ ...editFields, productName: v })}
                    />
                  ) : (
                    p.productName || (
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        (none)
                      </span>
                    )
                  )}
                </td>
                <td style={settingsStyles.td}>
                  {isEditing ? (
                    <TextInput
                      value={editFields.subfolder}
                      onChange={(v) => setEditFields({ ...editFields, subfolder: v })}
                      monospace
                    />
                  ) : (
                    <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                      {p.subfolder || p.productName || p.externalId}
                    </span>
                  )}
                </td>
                <td style={{ ...settingsStyles.td, textAlign: 'center' }}>
                  {isEditing ? (
                    <input
                      type="checkbox"
                      checked={!!editFields.dropShipped}
                      onChange={(e) =>
                        setEditFields({ ...editFields, dropShipped: e.target.checked })
                      }
                    />
                  ) : p.dropShipped ? (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: 'rgba(156,106,222,0.15)',
                        color: '#b48af0',
                        borderRadius: 3,
                        fontWeight: 600,
                      }}
                    >
                      DROP-SHIP
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
                  )}
                </td>
                <td
                  style={{
                    ...settingsStyles.td,
                    textAlign: 'right',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isEditing ? (
                    <>
                      <Button
                        variant="primary"
                        onClick={() => handleSaveEdit(p.externalId)}
                        disabled={busy}
                      >
                        Save
                      </Button>{' '}
                      <Button variant="ghost" onClick={() => setEditingSku(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button onClick={() => startEdit(p)}>Edit</Button>{' '}
                      <Button variant="danger" onClick={() => handleDelete(p.externalId)}>
                        Delete
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div
        style={{
          marginTop: 16,
          paddingTop: 16,
          borderTop: '1px solid var(--border-color)',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: 'var(--text-muted)',
            marginBottom: 12,
          }}
        >
          Add specialty product
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '0.7fr 1.5fr 1.5fr auto auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <FormRow label="SKU *">
            <TextInput value={newSku} onChange={setNewSku} placeholder="e.g. 32" monospace />
          </FormRow>
          <FormRow label="Product name">
            <TextInput
              value={newProductName}
              onChange={setNewProductName}
              placeholder="e.g. Acrylic 8x10"
            />
          </FormRow>
          <FormRow label="Subfolder" hint="Leave blank to use product name or SKU">
            <TextInput
              value={newSubfolder}
              onChange={setNewSubfolder}
              placeholder="(auto)"
              monospace
            />
          </FormRow>
          <FormRow label="">
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--text-secondary)',
                paddingBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={newDropShipped}
                onChange={(e) => setNewDropShipped(e.target.checked)}
              />
              Drop-ship
            </label>
          </FormRow>
          <FormRow label="">
            <Button variant="primary" onClick={handleAdd} disabled={busy || !newSku}>
              Add
            </Button>
          </FormRow>
        </div>
      </div>
    </Section>
  );
}

// ─── Highlight colors ─────────────────────────────────────

function HighlightColorsSection({ colors, onChange, onStatus }) {
  const [specialty, setSpecialty] = useState(colors.specialty || '#fff5e6');
  const [quantity, setQuantity] = useState(colors.quantity || '#fff0f0');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSpecialty(colors.specialty || '#fff5e6');
    setQuantity(colors.quantity || '#fff0f0');
  }, [colors.specialty, colors.quantity]);

  const dirty =
    specialty !== (colors.specialty || '#fff5e6') ||
    quantity !== (colors.quantity || '#fff0f0');

  async function handleSave() {
    setSaving(true);
    try {
      await api.put('/api/sytist/specialty/highlight-colors', {
        specialty,
        quantity,
      });
      onStatus({ kind: 'success', message: 'Highlight colors saved' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Highlight colors"
      description="Background tints applied to slip item rows. Specialty wins over quantity when both apply."
      actions={
        <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </Button>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <ColorRow
          label="Specialty (orange)"
          value={specialty}
          onChange={setSpecialty}
        />
        <ColorRow
          label="Quantity > 1 (pink)"
          value={quantity}
          onChange={setQuantity}
        />
      </div>
    </Section>
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
