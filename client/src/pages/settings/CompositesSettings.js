import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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

/**
 * Phase 8b — Composites settings page.
 *
 * Two sections:
 *   1. Composite Layouts — JSON editor for slot definitions. Visual
 *      designer is deferred to Phase 9.
 *   2. Composite Mappings — SKU → layout, with chainToImposition flag
 *      for products that need composite + imposition (e.g. memory mate
 *      magnet sheet: composite renders one memory mate, imposition
 *      tiles 4 of them onto the magnet sheet).
 */
export default function CompositesSettings() {
  return (
    <div>
      <PageHeader
        title="Composites"
        subtitle="Multi-image layouts (memory mates etc.) plus SKU → layout mappings. Composite output replaces the player photo path; if 'Chain to imposition' is set, imposition runs on the composite output afterward."
      />
      <LayoutsSection />
      <MappingsSection />
    </div>
  );
}

// ─── Layouts ──────────────────────────────────────────────

function LayoutsSection() {
  const [layouts, setLayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draftJson, setDraftJson] = useState('');
  const [draftError, setDraftError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/api/sytist/composite/layouts');
      setLayouts(r.layouts || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  function startEdit(layout) {
    setEditingId(layout.id);
    setDraftJson(JSON.stringify(layout, null, 2));
    setDraftError(null);
    setShowCreate(false);
  }

  function startCreate() {
    setShowCreate(true);
    setEditingId(null);
    setDraftJson(
      JSON.stringify(
        {
          id: 'new-layout-id',
          name: 'New Layout',
          sheetWidth: 5,
          sheetHeight: 7,
          dpi: 300,
          backgroundColor: '#ffffff',
          variants: {
            vertical: { slots: [] },
            horizontal: { slots: [] },
          },
        },
        null,
        2
      )
    );
    setDraftError(null);
  }

  async function handleSave() {
    setDraftError(null);
    let parsed;
    try {
      parsed = JSON.parse(draftJson);
    } catch (err) {
      setDraftError(`Invalid JSON: ${err.message}`);
      return;
    }
    setSaving(true);
    try {
      if (showCreate) {
        await api.post('/api/sytist/composite/layouts', parsed);
      } else {
        await api.put(
          `/api/sytist/composite/layouts/${encodeURIComponent(editingId)}`,
          parsed
        );
      }
      setEditingId(null);
      setShowCreate(false);
      setDraftJson('');
      await load();
    } catch (err) {
      setDraftError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setShowCreate(false);
    setDraftJson('');
    setDraftError(null);
  }

  async function handleDelete(id) {
    if (
      !window.confirm(
        `Delete layout "${id}"? Any mappings pointing at it will fail until updated.`
      )
    ) {
      return;
    }
    try {
      await api.del(
        `/api/sytist/composite/layouts/${encodeURIComponent(id)}`
      );
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section
      title={`Composite Layouts (${layouts.length})`}
      description="Slot-based layout definitions. Each layout has variants (vertical / horizontal) chosen automatically based on player photo orientation."
      actions={
        <Button variant="primary" onClick={startCreate} disabled={!!editingId || showCreate}>
          + New layout
        </Button>
      }
    >
      {error && <StatusBanner kind="error" message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          {(editingId || showCreate) && (
            <div
              style={{
                padding: 12,
                marginBottom: 16,
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-muted)',
                }}
              >
                {showCreate ? 'New layout' : `Editing: ${editingId}`}
              </div>
              <textarea
                value={draftJson}
                onChange={(e) => setDraftJson(e.target.value)}
                spellCheck={false}
                style={{
                  width: '100%',
                  minHeight: 400,
                  padding: 8,
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 12,
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  color: 'var(--text-primary)',
                  resize: 'vertical',
                }}
              />
              {draftError && (
                <div
                  style={{
                    marginTop: 8,
                    padding: 8,
                    background: 'rgba(220,53,69,0.08)',
                    border: '1px solid rgba(220,53,69,0.3)',
                    borderRadius: 4,
                    color: '#dc3545',
                    fontSize: 12,
                  }}
                >
                  {draftError}
                </div>
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <Button variant="primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="ghost" onClick={cancelEdit}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {layouts.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: 13,
              }}
            >
              No layouts defined yet. Click "+ New layout" to create one.
            </div>
          ) : (
            <table style={settingsStyles.table}>
              <thead>
                <tr>
                  <th style={settingsStyles.th}>ID</th>
                  <th style={settingsStyles.th}>Name</th>
                  <th style={settingsStyles.th}>Size</th>
                  <th style={settingsStyles.th}>Variants</th>
                  <th style={settingsStyles.th}>Slots</th>
                  <th style={{ ...settingsStyles.th, width: 160, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {layouts.map((l) => (
                  <tr key={l.id}>
                    <td
                      style={{
                        ...settingsStyles.td,
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: 11,
                      }}
                    >
                      {l.id}
                    </td>
                    <td style={settingsStyles.td}>{l.name}</td>
                    <td style={{ ...settingsStyles.td, fontSize: 11 }}>
                      {l.sheetWidth}″ × {l.sheetHeight}″ @ {l.dpi}dpi
                    </td>
                    <td style={{ ...settingsStyles.td, fontSize: 11 }}>
                      {Object.keys(l.variants || {}).join(', ') || '—'}
                    </td>
                    <td style={{ ...settingsStyles.td, fontSize: 11 }}>
                      {Object.entries(l.variants || {}).map(([name, v]) => (
                        <div key={name}>
                          {name}: {(v.slots || []).length}
                        </div>
                      ))}
                    </td>
                    <td
                      style={{
                        ...settingsStyles.td,
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Link
                        to={`/settings/composites/designer/${encodeURIComponent(l.id)}`}
                        style={{
                          padding: '4px 10px',
                          background: 'transparent',
                          border: '1px solid var(--border-color)',
                          color: 'var(--text-primary)',
                          borderRadius: 4,
                          fontSize: 11,
                          textDecoration: 'none',
                          display: 'inline-block',
                          fontFamily: 'inherit',
                          opacity: editingId || showCreate ? 0.4 : 1,
                          pointerEvents: editingId || showCreate ? 'none' : 'auto',
                        }}
                      >
                        Designer
                      </Link>{' '}
                      <Button
                        variant="ghost"
                        onClick={() => startEdit(l)}
                        disabled={!!editingId || showCreate}
                        title="Edit raw JSON (advanced — designer is preferred)"
                      >
                        JSON
                      </Button>{' '}
                      <Button
                        variant="danger"
                        onClick={() => handleDelete(l.id)}
                        disabled={!!editingId || showCreate}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Section>
  );
}

// ─── Mappings ─────────────────────────────────────────────

function MappingsSection() {
  const [mappings, setMappings] = useState([]);
  const [layouts, setLayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draftSku, setDraftSku] = useState('');
  const [draftLayout, setDraftLayout] = useState('');
  const [draftChain, setDraftChain] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [m, l] = await Promise.all([
        api.get('/api/sytist/composite/mappings'),
        api.get('/api/sytist/composite/layouts'),
      ]);
      setMappings(m.mappings || []);
      setLayouts(l.layouts || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  function startAdd() {
    setShowAdd(true);
    setDraftSku('');
    setDraftLayout(layouts[0]?.id || '');
    setDraftChain(false);
  }

  async function handleAdd() {
    if (!draftSku || !draftLayout) {
      setError('SKU and layout are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/sytist/composite/mappings', {
        externalId: draftSku,
        layoutId: draftLayout,
        chainToImposition: draftChain,
      });
      setShowAdd(false);
      setDraftSku('');
      setDraftLayout('');
      setDraftChain(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(externalId) {
    if (!window.confirm(`Remove composite mapping for SKU "${externalId}"?`)) return;
    try {
      await api.del(
        `/api/sytist/composite/mappings/${encodeURIComponent(externalId)}`
      );
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleToggleChain(mapping) {
    try {
      await api.put(
        `/api/sytist/composite/mappings/${encodeURIComponent(mapping.externalId)}`,
        { chainToImposition: !mapping.chainToImposition }
      );
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section
      title={`Composite Mappings (${mappings.length})`}
      description="Map a Sytist SKU (externalId) to a composite layout. When 'Chain to imposition' is checked, the composite output is fed into imposition for tiling — used for products like memory mate magnet sheets."
      actions={
        <Button variant="primary" onClick={startAdd} disabled={showAdd || layouts.length === 0}>
          + Add mapping
        </Button>
      }
    >
      {error && <StatusBanner kind="error" message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : layouts.length === 0 ? (
        <div
          style={{
            padding: 12,
            background: 'rgba(224,179,65,0.08)',
            border: '1px solid rgba(224,179,65,0.3)',
            borderRadius: 6,
            color: '#e0b341',
            fontSize: 13,
          }}
        >
          You need at least one composite layout before you can create a mapping.
          Create one above.
        </div>
      ) : (
        <>
          {showAdd && (
            <div
              style={{
                padding: 12,
                marginBottom: 16,
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr auto auto auto',
                gap: 8,
                alignItems: 'end',
              }}
            >
              <FormRow label="SKU (externalId)">
                <TextInput
                  value={draftSku}
                  onChange={setDraftSku}
                  placeholder="e.g. 99"
                  monospace
                />
              </FormRow>
              <FormRow label="Layout">
                <Select
                  value={draftLayout}
                  onChange={setDraftLayout}
                  options={layouts.map((l) => ({ value: l.id, label: l.name }))}
                />
              </FormRow>
              <FormRow label="">
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    padding: '8px 0',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={draftChain}
                    onChange={(e) => setDraftChain(e.target.checked)}
                  />
                  Chain to imposition
                </label>
              </FormRow>
              <FormRow label="">
                <Button variant="primary" onClick={handleAdd} disabled={saving}>
                  {saving ? 'Saving…' : 'Add'}
                </Button>
              </FormRow>
              <FormRow label="">
                <Button variant="ghost" onClick={() => setShowAdd(false)}>
                  Cancel
                </Button>
              </FormRow>
            </div>
          )}

          {mappings.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: 13,
              }}
            >
              No mappings defined yet.
            </div>
          ) : (
            <table style={settingsStyles.table}>
              <thead>
                <tr>
                  <th style={settingsStyles.th}>SKU</th>
                  <th style={settingsStyles.th}>Layout</th>
                  <th style={settingsStyles.th}>Chain to imposition</th>
                  <th style={{ ...settingsStyles.th, width: 100, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => {
                  const layout = layouts.find((l) => l.id === m.layoutId);
                  return (
                    <tr key={m.externalId}>
                      <td
                        style={{
                          ...settingsStyles.td,
                          fontFamily: 'var(--font-mono, monospace)',
                        }}
                      >
                        {m.externalId}
                      </td>
                      <td style={settingsStyles.td}>
                        {layout ? layout.name : (
                          <span style={{ color: '#dc3545' }}>
                            ⚠ Missing: {m.layoutId}
                          </span>
                        )}
                      </td>
                      <td style={settingsStyles.td}>
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: 'pointer',
                            fontSize: 12,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!m.chainToImposition}
                            onChange={() => handleToggleChain(m)}
                          />
                          {m.chainToImposition ? 'Yes' : 'No'}
                        </label>
                      </td>
                      <td
                        style={{
                          ...settingsStyles.td,
                          textAlign: 'right',
                        }}
                      >
                        <Button
                          variant="danger"
                          onClick={() => handleDelete(m.externalId)}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </Section>
  );
}
