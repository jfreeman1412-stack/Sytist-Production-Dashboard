import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  Button,
  StatusBanner,
  TokenList,
  settingsStyles,
} from '../../components/SettingsForm';

const FILENAME_TOKENS = [
  { token: '{order_number}', description: 'Sytist order number' },
  { token: '{first_name}', description: 'Customer first name' },
  { token: '{last_name}', description: 'Customer last name' },
  { token: '{gallery}', description: 'Gallery name' },
  { token: '{date}', description: "Order date YYYY-MM-DD" },
];

export default function DarkroomSettings() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.get('/api/sytist/darkroom/config');
      setData(d);
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
        <PageHeader title="Darkroom" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Darkroom" />
        <StatusBanner kind="error" message={error} />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div>
      <PageHeader
        title="Darkroom"
        subtitle="Size and template mappings used when generating Darkroom .txt files. Filename pattern controls the output .txt filename."
      />
      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}

      <SizeMappingsSection
        mappings={data.sizeMappings}
        defaultSize={data.defaultSize}
        onChange={load}
        onStatus={setStatus}
      />

      <TemplateMappingsSection
        mappings={data.templateMappings}
        onChange={load}
        onStatus={setStatus}
      />

      <FilenameSection
        filenameConfig={data.filenameConfig}
        onChange={load}
        onStatus={setStatus}
      />
    </div>
  );
}

// ─── Size mappings ──────────────────────────────────────────

function SizeMappingsSection({ mappings, defaultSize, onChange, onStatus }) {
  const [newSku, setNewSku] = useState('');
  const [newSize, setNewSize] = useState('');
  const [newProductName, setNewProductName] = useState('');
  const [editingSku, setEditingSku] = useState(null);
  const [editSize, setEditSize] = useState('');
  const [editProductName, setEditProductName] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleAdd() {
    if (!newSku.trim() || !newSize.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/sytist/darkroom/size-mappings', {
        externalId: newSku.trim(),
        size: newSize.trim(),
        productName: newProductName.trim(),
      });
      setNewSku('');
      setNewSize('');
      setNewProductName('');
      onStatus({ kind: 'success', message: 'Size mapping added' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Add failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  function startEdit(m) {
    setEditingSku(m.externalId);
    setEditSize(m.size);
    setEditProductName(m.productName || '');
  }

  async function handleSaveEdit(externalId) {
    setBusy(true);
    try {
      await api.put(`/api/sytist/darkroom/size-mappings/${encodeURIComponent(externalId)}`, {
        size: editSize.trim(),
        productName: editProductName.trim(),
      });
      setEditingSku(null);
      onStatus({ kind: 'success', message: 'Size mapping updated' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(externalId) {
    if (!window.confirm(`Delete size mapping for SKU "${externalId}"?`)) return;
    setBusy(true);
    try {
      await api.del(`/api/sytist/darkroom/size-mappings/${encodeURIComponent(externalId)}`);
      onStatus({ kind: 'success', message: 'Size mapping deleted' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Delete failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={`Size mappings (${mappings.length})`}
      description={`Maps SKUs to print sizes for the Darkroom .txt 'Size=' line. Falls back to product-name parse, then default size "${defaultSize}".`}
    >
      <table style={settingsStyles.table}>
        <thead>
          <tr>
            <th style={settingsStyles.th}>SKU</th>
            <th style={settingsStyles.th}>Size</th>
            <th style={settingsStyles.th}>Product name</th>
            <th style={{ ...settingsStyles.th, width: 160, textAlign: 'right' }}></th>
          </tr>
        </thead>
        <tbody>
          {mappings.length === 0 && (
            <tr>
              <td
                colSpan={4}
                style={{ ...settingsStyles.td, color: 'var(--text-muted)', fontStyle: 'italic' }}
              >
                No size mappings yet.
              </td>
            </tr>
          )}
          {mappings.map((m) => {
            const isEditing = editingSku === m.externalId;
            return (
              <tr key={m.externalId}>
                <td style={{ ...settingsStyles.td, fontFamily: 'var(--font-mono, monospace)' }}>
                  {m.externalId}
                </td>
                <td style={settingsStyles.td}>
                  {isEditing ? (
                    <TextInput value={editSize} onChange={setEditSize} />
                  ) : (
                    <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{m.size}</span>
                  )}
                </td>
                <td style={settingsStyles.td}>
                  {isEditing ? (
                    <TextInput value={editProductName} onChange={setEditProductName} />
                  ) : (
                    m.productName || (
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        (none)
                      </span>
                    )
                  )}
                </td>
                <td style={{ ...settingsStyles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {isEditing ? (
                    <>
                      <Button
                        variant="primary"
                        onClick={() => handleSaveEdit(m.externalId)}
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
                      <Button onClick={() => startEdit(m)}>Edit</Button>{' '}
                      <Button variant="danger" onClick={() => handleDelete(m.externalId)}>
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
          Add new mapping
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 2fr auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <FormRow label="SKU">
            <TextInput value={newSku} onChange={setNewSku} placeholder="e.g. 6" monospace />
          </FormRow>
          <FormRow label="Size">
            <TextInput value={newSize} onChange={setNewSize} placeholder="e.g. 8x10" monospace />
          </FormRow>
          <FormRow label="Product name (optional)">
            <TextInput
              value={newProductName}
              onChange={setNewProductName}
              placeholder="e.g. Memory Mate"
            />
          </FormRow>
          <FormRow label="">
            <Button variant="primary" onClick={handleAdd} disabled={busy || !newSku || !newSize}>
              Add
            </Button>
          </FormRow>
        </div>
      </div>
    </Section>
  );
}

// ─── Template mappings ─────────────────────────────────────

function TemplateMappingsSection({ mappings, onChange, onStatus }) {
  const [newSku, setNewSku] = useState('');
  const [newProductName, setNewProductName] = useState('');
  const [newSize, setNewSize] = useState('');
  const [newTemplate, setNewTemplate] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleAdd() {
    if (!newTemplate.trim()) return;
    if (!newSku.trim() && !newProductName.trim()) {
      onStatus({ kind: 'error', message: 'Provide at least SKU or Product name' });
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/sytist/darkroom/template-mappings', {
        externalId: newSku.trim() || null,
        productName: newProductName.trim() || null,
        size: newSize.trim() || null,
        templatePath: newTemplate.trim(),
      });
      setNewSku('');
      setNewProductName('');
      setNewSize('');
      setNewTemplate('');
      onStatus({ kind: 'success', message: 'Template mapping added' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Add failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this template mapping?')) return;
    setBusy(true);
    try {
      await api.del(`/api/sytist/darkroom/template-mappings/${id}`);
      onStatus({ kind: 'success', message: 'Template mapping deleted' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Delete failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={`Template mappings (${mappings.length})`}
      description="Maps products to a Darkroom border template path. Lookup tries SKU exact match, then productName exact match, then productName substring match."
    >
      <table style={settingsStyles.table}>
        <thead>
          <tr>
            <th style={settingsStyles.th}>SKU</th>
            <th style={settingsStyles.th}>Product name</th>
            <th style={settingsStyles.th}>Size</th>
            <th style={settingsStyles.th}>Template path</th>
            <th style={{ ...settingsStyles.th, width: 100, textAlign: 'right' }}></th>
          </tr>
        </thead>
        <tbody>
          {mappings.length === 0 && (
            <tr>
              <td
                colSpan={5}
                style={{ ...settingsStyles.td, color: 'var(--text-muted)', fontStyle: 'italic' }}
              >
                No template mappings yet. Templates are optional — items without a mapping print without a border.
              </td>
            </tr>
          )}
          {mappings.map((m) => (
            <tr key={m.id}>
              <td style={{ ...settingsStyles.td, fontFamily: 'var(--font-mono, monospace)' }}>
                {m.externalId || '—'}
              </td>
              <td style={settingsStyles.td}>{m.productName || '—'}</td>
              <td style={{ ...settingsStyles.td, fontFamily: 'var(--font-mono, monospace)' }}>
                {m.size || '—'}
              </td>
              <td
                style={{
                  ...settingsStyles.td,
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 11,
                  wordBreak: 'break-all',
                }}
              >
                {m.templatePath}
              </td>
              <td style={{ ...settingsStyles.td, textAlign: 'right' }}>
                <Button variant="danger" onClick={() => handleDelete(m.id)}>
                  Delete
                </Button>
              </td>
            </tr>
          ))}
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
          Add new template
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1.5fr 0.7fr 2.5fr auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <FormRow label="SKU">
            <TextInput value={newSku} onChange={setNewSku} placeholder="(optional)" monospace />
          </FormRow>
          <FormRow label="Product name">
            <TextInput
              value={newProductName}
              onChange={setNewProductName}
              placeholder="(optional)"
            />
          </FormRow>
          <FormRow label="Size">
            <TextInput value={newSize} onChange={setNewSize} placeholder="(optional)" monospace />
          </FormRow>
          <FormRow label="Template path *">
            <TextInput
              value={newTemplate}
              onChange={setNewTemplate}
              placeholder="X:\Templates\Borders\..."
              monospace
            />
          </FormRow>
          <FormRow label="">
            <Button variant="primary" onClick={handleAdd} disabled={busy || !newTemplate}>
              Add
            </Button>
          </FormRow>
        </div>
      </div>
    </Section>
  );
}

// ─── Filename config ────────────────────────────────────────

function FilenameSection({ filenameConfig, onChange, onStatus }) {
  const [pattern, setPattern] = useState(filenameConfig.pattern || '{order_number}');
  const [extension, setExtension] = useState(filenameConfig.extension || '.txt');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPattern(filenameConfig.pattern || '{order_number}');
    setExtension(filenameConfig.extension || '.txt');
  }, [filenameConfig]);

  const dirty =
    pattern !== (filenameConfig.pattern || '') ||
    extension !== (filenameConfig.extension || '');

  async function handleSave() {
    setSaving(true);
    try {
      await api.put('/api/sytist/darkroom/filename-config', { pattern, extension });
      onStatus({ kind: 'success', message: 'Filename config updated' });
      await onChange();
    } catch (err) {
      onStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  // Build a sample filename from the current pattern
  const sampleContext = {
    '{order_number}': '110855',
    '{first_name}': 'Heather',
    '{last_name}': 'Matthews',
    '{gallery}': 'Lincoln HS Football 2025',
    '{date}': '2025-10-15',
  };
  let sample = pattern;
  for (const [t, v] of Object.entries(sampleContext)) {
    sample = sample.split(t).join(v);
  }
  sample = sample.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() + extension;

  return (
    <Section
      title="Filename pattern"
      description="Pattern for the generated .txt file. Tokens are replaced per-order at write time."
      actions={
        <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
        </Button>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: 12 }}>
        <FormRow label="Pattern">
          <TextInput value={pattern} onChange={setPattern} monospace />
        </FormRow>
        <FormRow label="Extension">
          <TextInput value={extension} onChange={setExtension} monospace />
        </FormRow>
      </div>
      <FormRow label="Preview" hint="Sample using stand-in values for the tokens.">
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 13,
            color: 'var(--text-primary)',
          }}
        >
          {sample}
        </div>
      </FormRow>
      <TokenList tokens={FILENAME_TOKENS} />
    </Section>
  );
}
