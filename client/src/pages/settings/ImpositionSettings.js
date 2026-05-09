import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  TextArea,
  Select,
  Button,
  StatusBanner,
  TokenList,
  settingsStyles,
} from '../../components/SettingsForm';

/**
 * Imposition settings — two tabs: Layouts and Mappings.
 *
 * Layouts: a table view + JSON editor modal. The full layout schema has
 * 14 numeric fields plus a nested textOverlays array, so building a
 * form-driven editor would mean a small WYSIWYG. JSON-with-validation
 * is a pragmatic compromise — operators can copy from an existing
 * layout, tweak fields, and save.
 *
 * Mappings: simple form-driven table — SKU, layout, orientation. Adding
 * a layout via mapping immediately surfaces in the imposition preview
 * on order pages.
 *
 * Tabs persist via the URL hash so a refresh keeps you on the right tab.
 */
export default function ImpositionSettings() {
  const initialTab =
    typeof window !== 'undefined' && window.location.hash === '#mappings'
      ? 'mappings'
      : 'layouts';
  const [tab, setTab] = useState(initialTab);
  const [status, setStatus] = useState(null);

  function changeTab(t) {
    setTab(t);
    if (typeof window !== 'undefined') {
      window.location.hash = t === 'layouts' ? '' : `#${t}`;
    }
  }

  return (
    <div>
      <PageHeader
        title="Imposition"
        subtitle="Multi-up sheet layouts and the SKU → layout mappings that drive imposition."
      />
      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}

      <div
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 20,
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <TabButton active={tab === 'layouts'} onClick={() => changeTab('layouts')}>
          Layouts
        </TabButton>
        <TabButton active={tab === 'mappings'} onClick={() => changeTab('mappings')}>
          Mappings
        </TabButton>
        <TabButton active={tab === 'tokens'} onClick={() => changeTab('tokens')}>
          Tokens
        </TabButton>
      </div>

      {tab === 'layouts' && <LayoutsTab onStatus={setStatus} />}
      {tab === 'mappings' && <MappingsTab onStatus={setStatus} />}
      {tab === 'tokens' && <TokensTab />}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        padding: '8px 14px',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        borderBottom: active ? '2px solid #4a7fc1' : '2px solid transparent',
        cursor: 'pointer',
        marginBottom: -1,
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

// ─── LAYOUTS TAB ────────────────────────────────────────────

function LayoutsTab({ onStatus }) {
  const [layouts, setLayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingLayout, setEditingLayout] = useState(null); // layout object or "new"
  const [editingJson, setEditingJson] = useState('');
  const [editingError, setEditingError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.get('/api/sytist/imposition/layouts');
      setLayouts(d.layouts || []);
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
    setEditingLayout(layout);
    setEditingJson(JSON.stringify(layout, null, 2));
    setEditingError(null);
  }

  function startNew() {
    const blank = {
      id: '',
      name: 'New Layout',
      cols: 1,
      rows: 1,
      itemWidth: 5,
      itemHeight: 7,
      sheetWidth: 5,
      sheetHeight: 8,
      dpi: 300,
      colGap: 0,
      rowGap: 0,
      centerOnSheet: false,
      marginLeft: 0,
      marginTop: 0,
      textOverlays: [],
    };
    setEditingLayout('new');
    setEditingJson(JSON.stringify(blank, null, 2));
    setEditingError(null);
  }

  function startDuplicate(layout) {
    const copy = {
      ...layout,
      id: '',
      name: `${layout.name} (copy)`,
    };
    setEditingLayout('new');
    setEditingJson(JSON.stringify(copy, null, 2));
    setEditingError(null);
  }

  function closeModal() {
    setEditingLayout(null);
    setEditingJson('');
    setEditingError(null);
  }

  async function handleSaveModal() {
    let parsed;
    try {
      parsed = JSON.parse(editingJson);
    } catch (err) {
      setEditingError(`Invalid JSON: ${err.message}`);
      return;
    }
    setSaving(true);
    setEditingError(null);
    try {
      if (editingLayout === 'new') {
        await api.post('/api/sytist/imposition/layouts', parsed);
        onStatus({ kind: 'success', message: `Layout "${parsed.name}" added` });
      } else {
        const id = parsed.id || editingLayout.id;
        await api.put(`/api/sytist/imposition/layouts/${id}`, parsed);
        onStatus({ kind: 'success', message: `Layout "${parsed.name}" updated` });
      }
      closeModal();
      await load();
    } catch (err) {
      setEditingError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(layout) {
    if (
      !window.confirm(
        `Delete layout "${layout.name}"?\n\nAny mappings referencing this layout will also be removed.`
      )
    ) {
      return;
    }
    try {
      await api.del(`/api/sytist/imposition/layouts/${layout.id}`);
      onStatus({ kind: 'success', message: `Layout "${layout.name}" deleted` });
      await load();
    } catch (err) {
      onStatus({ kind: 'error', message: `Delete failed: ${err.message}` });
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;
  if (error) return <StatusBanner kind="error" message={error} />;

  return (
    <Section
      title={`Layouts (${layouts.length})`}
      description="Multi-up sheet definitions. Edit as JSON; schema is well-known so you can copy from a similar layout, tweak, and save."
      actions={
        <Button variant="primary" onClick={startNew}>
          + New layout
        </Button>
      }
    >
      <table style={settingsStyles.table}>
        <thead>
          <tr>
            <th style={settingsStyles.th}>Name</th>
            <th style={settingsStyles.th}>Grid</th>
            <th style={settingsStyles.th}>Item</th>
            <th style={settingsStyles.th}>Sheet</th>
            <th style={settingsStyles.th}>DPI</th>
            <th style={settingsStyles.th}>Overlays</th>
            <th style={{ ...settingsStyles.th, width: 220, textAlign: 'right' }}></th>
          </tr>
        </thead>
        <tbody>
          {layouts.length === 0 && (
            <tr>
              <td
                colSpan={7}
                style={{ ...settingsStyles.td, color: 'var(--text-muted)', fontStyle: 'italic' }}
              >
                No layouts defined.
              </td>
            </tr>
          )}
          {layouts.map((l) => (
            <tr key={l.id}>
              <td style={settingsStyles.td}>
                <div style={{ fontWeight: 500 }}>{l.name}</div>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                >
                  {l.id}
                </div>
              </td>
              <td style={settingsStyles.td}>
                {l.cols}×{l.rows}
              </td>
              <td style={settingsStyles.td}>
                {l.itemWidth}×{l.itemHeight}″
              </td>
              <td style={settingsStyles.td}>
                {l.sheetWidth}×{l.sheetHeight}″
              </td>
              <td style={settingsStyles.td}>{l.dpi}</td>
              <td style={settingsStyles.td}>{(l.textOverlays || []).length}</td>
              <td style={{ ...settingsStyles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                <Button onClick={() => startEdit(l)}>Edit</Button>{' '}
                <Button onClick={() => startDuplicate(l)}>Duplicate</Button>{' '}
                <Button variant="danger" onClick={() => handleDelete(l)}>
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editingLayout && (
        <Modal
          title={
            editingLayout === 'new'
              ? 'New layout'
              : `Edit layout: ${editingLayout.name}`
          }
          onClose={closeModal}
        >
          <FormRow
            label="Layout JSON"
            hint="Required: name, cols, rows, itemWidth, itemHeight, sheetWidth, sheetHeight, dpi. Optional: colGap, rowGap, centerOnSheet, marginLeft, marginTop, textOverlays. ID is generated if omitted."
          >
            <TextArea
              value={editingJson}
              onChange={setEditingJson}
              rows={20}
              monospace
            />
          </FormRow>
          {editingError && <StatusBanner kind="error" message={editingError} />}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={closeModal}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSaveModal} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}
    </Section>
  );
}

// ─── MAPPINGS TAB ──────────────────────────────────────────

function MappingsTab({ onStatus }) {
  const [mappings, setMappings] = useState([]);
  const [layouts, setLayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newSku, setNewSku] = useState('');
  const [newLayoutId, setNewLayoutId] = useState('');
  const [newOrientation, setNewOrientation] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [m, l] = await Promise.all([
        api.get('/api/sytist/imposition/mappings'),
        api.get('/api/sytist/imposition/layouts'),
      ]);
      setMappings(m.mappings || []);
      setLayouts(l.layouts || []);
      if (!newLayoutId && l.layouts && l.layouts.length > 0) {
        setNewLayoutId(l.layouts[0].id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd() {
    if (!newSku.trim() || !newLayoutId) return;
    setBusy(true);
    try {
      await api.post('/api/sytist/imposition/mappings', {
        externalId: newSku.trim(),
        layoutId: newLayoutId,
        orientation: newOrientation || null,
      });
      setNewSku('');
      setNewOrientation('');
      onStatus({ kind: 'success', message: 'Mapping added' });
      await load();
    } catch (err) {
      onStatus({ kind: 'error', message: `Add failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(m) {
    const orientationLabel = m.orientation || 'any';
    if (
      !window.confirm(
        `Delete mapping for SKU "${m.externalId}" (orientation: ${orientationLabel})?`
      )
    ) {
      return;
    }
    try {
      const url = m.orientation
        ? `/api/sytist/imposition/mappings/${encodeURIComponent(m.externalId)}?orientation=${m.orientation}`
        : `/api/sytist/imposition/mappings/${encodeURIComponent(m.externalId)}`;
      await api.del(url);
      onStatus({ kind: 'success', message: 'Mapping deleted' });
      await load();
    } catch (err) {
      onStatus({ kind: 'error', message: `Delete failed: ${err.message}` });
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;
  if (error) return <StatusBanner kind="error" message={error} />;

  return (
    <Section
      title={`Mappings (${mappings.length})`}
      description="SKU → layout mappings. A SKU can have one mapping per orientation, or one orientation-agnostic mapping."
    >
      <table style={settingsStyles.table}>
        <thead>
          <tr>
            <th style={settingsStyles.th}>SKU</th>
            <th style={settingsStyles.th}>Layout</th>
            <th style={settingsStyles.th}>Orientation</th>
            <th style={{ ...settingsStyles.th, width: 100, textAlign: 'right' }}></th>
          </tr>
        </thead>
        <tbody>
          {mappings.length === 0 && (
            <tr>
              <td
                colSpan={4}
                style={{ ...settingsStyles.td, color: 'var(--text-muted)', fontStyle: 'italic' }}
              >
                No mappings defined.
              </td>
            </tr>
          )}
          {mappings.map((m, i) => (
            <tr key={`${m.externalId}-${m.orientation || 'any'}-${i}`}>
              <td style={{ ...settingsStyles.td, fontFamily: 'var(--font-mono, monospace)' }}>
                {m.externalId}
              </td>
              <td style={settingsStyles.td}>{m.layoutName}</td>
              <td style={settingsStyles.td}>
                {m.orientation ? (
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono, monospace)',
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: 'rgba(120,120,200,0.18)',
                      color: '#aab',
                    }}
                  >
                    {m.orientation}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>any</span>
                )}
              </td>
              <td style={{ ...settingsStyles.td, textAlign: 'right' }}>
                <Button variant="danger" onClick={() => handleDelete(m)}>
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
          Add new mapping
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 2fr 1fr auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <FormRow label="SKU">
            <TextInput value={newSku} onChange={setNewSku} placeholder="e.g. 17" monospace />
          </FormRow>
          <FormRow label="Layout">
            <Select
              value={newLayoutId}
              onChange={setNewLayoutId}
              options={[
                { value: '', label: '— select a layout —' },
                ...layouts.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
          </FormRow>
          <FormRow label="Orientation">
            <Select
              value={newOrientation}
              onChange={setNewOrientation}
              options={[
                { value: '', label: 'any' },
                { value: 'vertical', label: 'vertical' },
                { value: 'horizontal', label: 'horizontal' },
              ]}
            />
          </FormRow>
          <FormRow label="">
            <Button
              variant="primary"
              onClick={handleAdd}
              disabled={busy || !newSku || !newLayoutId}
            >
              Add
            </Button>
          </FormRow>
        </div>
      </div>
    </Section>
  );
}

// ─── TOKENS TAB ────────────────────────────────────────────

function TokensTab() {
  const [tokens, setTokens] = useState([]);
  useEffect(() => {
    api
      .get('/api/sytist/imposition/text-variables')
      .then((d) => setTokens(d.variables || []))
      .catch(() => setTokens([]));
  }, []);

  return (
    <Section
      title="Text overlay tokens"
      description="Tokens you can use in a layout's textOverlays[].text. Substituted per-order at composition time. Token matching is case-insensitive."
    >
      {tokens.length > 0 ? (
        <TokenList tokens={tokens} title="" />
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      )}
    </Section>
  );
}

// ─── Modal ─────────────────────────────────────────────────

function Modal({ title, onClose, children }) {
  // Close on escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          padding: 24,
          width: '100%',
          maxWidth: 800,
          maxHeight: '90vh',
          overflow: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            paddingBottom: 12,
            borderBottom: '1px solid var(--border-color)',
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 22,
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
