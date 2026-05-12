import React, { useEffect, useState, useCallback } from 'react';
import api from '../../services/api';
import HistoryModal from '../../components/HistoryModal';

/**
 * Settings → Add-ons
 *
 * Phase 15b: maps Sytist add-on option IDs (co_opt_id) to dashboard
 * SKUs so the order pipeline can materialize add-ons as production
 * items. An add-on is a "and one of these too" item attached to a
 * cart line (e.g. order a Memory Mate, add 2 Magnets for $8.49) —
 * it lives in ms_cart_options, not ms_cart, so today it's invisible
 * to the pipeline. Once mapped to a SKU here, the explosion logic
 * in sytistDbService synthesizes a real line item for each add-on
 * and the existing pipeline (composite, imposition, slip, .txt)
 * handles it naturally.
 *
 * Page layout:
 *   1. Existing mappings table — editable SKU per opt_id, with
 *      Delete + Save controls per row.
 *   2. Discovery panel — lists co_opt_id values observed in recent
 *      orders that aren't mapped yet. Each has a "Map" button that
 *      pre-fills a new row with the discovered name and occurrence
 *      stats.
 *   3. Manual add — for the rare case operator wants to add an
 *      opt_id ahead of time (before any order has used it).
 */
export default function AddonsPage() {
  const [mappings, setMappings] = useState({});
  const [productWeights, setProductWeights] = useState({});
  const [unmappedOptions, setUnmappedOptions] = useState([]);
  const [scannedOrders, setScannedOrders] = useState(0);
  // Phase 15c hotfix-2: configurable scan limit. Default 500
  // (matches server default). Operator can bump higher to surface
  // older/rarer add-ons.
  const [scanLimit, setScanLimit] = useState(500);
  const [scanning, setScanning] = useState(false);

  // Phase 16: history modal state — null when closed, { optId, name }
  // when open.
  const [historyTarget, setHistoryTarget] = useState(null);

  // Phase 16: import file picker state.
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Manual-add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newOptId, setNewOptId] = useState('');
  const [newName, setNewName] = useState('');
  // Phase 15c: type-aware form fields
  const [newType, setNewType] = useState('product');
  const [newSku, setNewSku] = useState('');
  const [newQty, setNewQty] = useState(1);
  const [newSuffix, setNewSuffix] = useState('');
  const [savingNew, setSavingNew] = useState(false);

  const loadAll = useCallback(async () => {
    setError(null);
    setScanning(true);
    try {
      const [maps, packagingResp, disc] = await Promise.all([
        api.get('/api/sytist/addon-mappings'),
        api.get('/api/shipstation/packaging/config'),
        api.get(`/api/sytist/addon-mappings/discovery?limit=${scanLimit}`),
      ]);
      setMappings(maps.mappings || {});
      const packaging = packagingResp.config || packagingResp || {};
      setProductWeights(packaging.productWeights || {});
      setUnmappedOptions(disc.unmappedOptions || []);
      setScannedOrders(disc.scannedOrders || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setScanning(false);
    }
  }, [scanLimit]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function refreshAfterChange() {
    setScanning(true);
    try {
      const [maps, disc] = await Promise.all([
        api.get('/api/sytist/addon-mappings'),
        api.get(`/api/sytist/addon-mappings/discovery?limit=${scanLimit}`),
      ]);
      setMappings(maps.mappings || {});
      setUnmappedOptions(disc.unmappedOptions || []);
      setScannedOrders(disc.scannedOrders || 0);
    } catch {
      // non-fatal
    } finally {
      setScanning(false);
    }
  }

  // Phase 15c hotfix-2: bump the scan limit. Triggers a reload via
  // the scanLimit dep in loadAll's useEffect.
  function handleScanMore() {
    const ladder = [500, 1000, 2000, 5000];
    const next = ladder.find((n) => n > scanLimit) || 5000;
    setScanLimit(next);
  }

  // Phase 16: Export current config to a JSON file via browser
  // download. Uses the export endpoint which sets Content-Disposition.
  function handleExport() {
    // Open in a new tab so the response triggers a download. Using
    // a direct anchor click rather than fetch+blob keeps the cookie
    // / session header behavior consistent with normal API calls.
    const link = document.createElement('a');
    link.href = '/api/sytist/addon-mappings/export';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Phase 16: Import a JSON file. Wholesale replaces config.
  async function handleImport(file) {
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Selected file isn't valid JSON.");
      }
      const ok = window.confirm(
        `Import ${Object.keys(parsed.mappings || parsed).length} mappings, ` +
          `replacing the current configuration?\n\n` +
          `This action is recorded in the audit history so you can ` +
          `review or partially reverse it later.`
      );
      if (!ok) return;
      await api.put('/api/sytist/addon-mappings/import', parsed);
      await refreshAfterChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleSaveMapping(optId, mapping) {
    setError(null);
    try {
      await api.put(`/api/sytist/addon-mappings/${optId}`, mapping);
      await refreshAfterChange();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeleteMapping(optId, name) {
    setError(null);
    const ok = window.confirm(
      `Remove mapping for option ${optId}${name ? ` (${name})` : ''}?\n\n` +
        `Future orders containing this option won't be expanded until you re-map it.`
    );
    if (!ok) return;
    try {
      await api.del(`/api/sytist/addon-mappings/${optId}`);
      await refreshAfterChange();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleAddManual() {
    setError(null);
    const optId = String(newOptId || '').trim();
    if (!optId) {
      setError('Option ID is required');
      return;
    }
    if (mappings[optId]) {
      setError(`Option ID ${optId} is already mapped`);
      return;
    }
    // Build the payload based on type. The server normalizes anyway,
    // but sending the right shape avoids confusion.
    const payload =
      newType === 'modifier'
        ? {
            type: 'modifier',
            name: newName.trim(),
            suffix: newSuffix,
          }
        : {
            type: 'product',
            name: newName.trim(),
            sku: newSku.trim(),
            qty: Math.max(1, parseInt(newQty, 10) || 1),
          };
    setSavingNew(true);
    try {
      await api.put(`/api/sytist/addon-mappings/${optId}`, payload);
      await refreshAfterChange();
      setShowAddForm(false);
      setNewOptId('');
      setNewName('');
      setNewType('product');
      setNewSku('');
      setNewQty(1);
      setNewSuffix('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingNew(false);
    }
  }

  async function handleMapDiscovered(discovered) {
    // Just pre-populate the manual form and scroll to it. Operator
    // picks the type, sets the SKU/suffix, and clicks Add.
    setNewOptId(discovered.optId);
    setNewName(discovered.optName);
    setNewType('product');
    setNewSku('');
    setNewQty(1);
    setNewSuffix('');
    setShowAddForm(true);
    // Best-effort scroll to the form
    setTimeout(() => {
      const el = document.getElementById('addon-add-form');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  }

  const mappedOptIds = Object.keys(mappings).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10)
  );

  return (
    <div style={{ maxWidth: 900 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 6,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Add-ons</h2>
        {/* Phase 16: export + import buttons. Small icon-style
            buttons so they don't dominate the header. Disabled
            during import to prevent double-clicks. */}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={handleExport}
            disabled={importing}
            title="Download current addon mappings as a JSON file"
            style={smallActionButton}
          >
            ↓ Export
          </button>
          <label style={{ ...smallActionButton, cursor: importing ? 'default' : 'pointer' }}>
            {importing ? 'Importing…' : '↑ Import'}
            <input
              type="file"
              accept=".json,application/json"
              disabled={importing}
              onChange={(e) => {
                handleImport(e.target.files?.[0]);
                e.target.value = ''; // allow re-import same file
              }}
              style={{ display: 'none' }}
            />
          </label>
        </div>
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--text-muted)',
          marginBottom: 16,
          lineHeight: 1.5,
        }}
      >
        Sytist stores add-ons in <code>ms_cart_options</code>, separate
        from the main cart. Map each option ID (<code>co_opt_id</code>)
        to a dashboard SKU so the production pipeline can include the
        add-on in the imposition / composite / slip / .txt steps.
      </div>

      {error && (
        <div
          style={{
            padding: 10,
            background: 'rgba(220,53,69,0.1)',
            border: '1px solid rgba(220,53,69,0.3)',
            borderRadius: 6,
            color: '#dc3545',
            marginBottom: 12,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* Discovery panel — always rendered so operator can scan
          deeper into history even when no unmapped options remain
          at the current scan depth. */}
      <DiscoveryPanel
        unmapped={unmappedOptions}
        scannedOrders={scannedOrders}
        scanLimit={scanLimit}
        scanning={scanning}
        onScanMore={handleScanMore}
        canScanMore={scanLimit < 5000}
        onMap={handleMapDiscovered}
      />

      {/* Existing mappings */}
      <Section title={`Configured mappings (${mappedOptIds.length})`}>
        {mappedOptIds.length === 0 ? (
          <div
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              fontStyle: 'italic',
              padding: 16,
              textAlign: 'center',
              border: '1px dashed var(--border-color)',
              borderRadius: 6,
            }}
          >
            No mappings yet. Add one from the discovery panel above, or
            add manually below.
          </div>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
            }}
          >
            <thead>
              <tr>
                <th style={thStyle}>Opt ID</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Maps to / Suffix</th>
                <th style={thStyleRight}></th>
              </tr>
            </thead>
            <tbody>
              {mappedOptIds.map((optId) => (
                <MappingRow
                  key={optId}
                  optId={optId}
                  mapping={mappings[optId]}
                  productWeights={productWeights}
                  onSave={(m) => handleSaveMapping(optId, m)}
                  onDelete={() =>
                    handleDeleteMapping(optId, mappings[optId].name)
                  }
                  onViewHistory={() =>
                    setHistoryTarget({
                      optId,
                      name: mappings[optId].name || optId,
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Manual add */}
      <Section title="Add manually">
        {showAddForm ? (
          <div
            id="addon-add-form"
            style={{
              padding: 16,
              background: 'var(--bg-card)',
              border: '1px solid #4a7fc1',
              borderRadius: 8,
            }}
          >
            {/* Type toggle */}
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 4,
                }}
              >
                Type
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <TypeChip
                  active={newType === 'product'}
                  onClick={() => setNewType('product')}
                  title="Add-on becomes a separate production item (gets imposed/composited/printed)"
                >
                  Product (creates a new item)
                </TypeChip>
                <TypeChip
                  active={newType === 'modifier'}
                  onClick={() => setNewType('modifier')}
                  title="Add-on modifies the parent item's description (e.g. Frame, Gloss)"
                >
                  Modifier (suffix on parent)
                </TypeChip>
              </div>
            </div>

            {/* Common: ID + name */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 1fr',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <FieldStack label="Option ID">
                <input
                  type="text"
                  value={newOptId}
                  onChange={(e) => setNewOptId(e.target.value)}
                  placeholder="e.g. 2007"
                  style={inputStyle}
                  autoFocus
                />
              </FieldStack>
              <FieldStack label="Display name">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. 2 Magnets, Frame"
                  style={inputStyle}
                />
              </FieldStack>
            </div>

            {/* Type-specific fields */}
            {newType === 'product' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 80px',
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                <FieldStack label="Maps to SKU">
                  <SkuPicker
                    value={newSku}
                    onChange={setNewSku}
                    productWeights={productWeights}
                  />
                </FieldStack>
                <FieldStack label="Qty">
                  <input
                    type="number"
                    min="1"
                    value={newQty}
                    onChange={(e) => setNewQty(e.target.value)}
                    style={inputStyle}
                  />
                </FieldStack>
              </div>
            ) : (
              <div style={{ marginBottom: 12 }}>
                <FieldStack label="Suffix appended to parent product name">
                  <input
                    type="text"
                    value={newSuffix}
                    onChange={(e) => setNewSuffix(e.target.value)}
                    placeholder="e.g.  (Framed)"
                    style={inputStyle}
                  />
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginTop: 4,
                    }}
                  >
                    Include leading space if you want spacing.{' '}
                    {newSuffix && newOptId && (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Preview: "8x10 Individual{newSuffix}"
                      </span>
                    )}
                  </div>
                </FieldStack>
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setNewOptId('');
                  setNewName('');
                  setNewType('product');
                  setNewSku('');
                  setNewQty(1);
                  setNewSuffix('');
                  setError(null);
                }}
                style={buttonStyle('secondary', false)}
              >
                Cancel
              </button>
              <button
                onClick={handleAddManual}
                disabled={!newOptId.trim() || savingNew}
                style={buttonStyle('primary', !newOptId.trim() || savingNew)}
              >
                {savingNew ? 'Adding…' : 'Add'}
              </button>
            </div>

            {newType === 'product' && !newSku.trim() && newOptId.trim() && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  color: '#e0b341',
                }}
              >
                ⚠️ Without a SKU, this mapping exists but the pipeline
                won't expand the option into a production item.
              </div>
            )}
            {newType === 'modifier' && !newSuffix && newOptId.trim() && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  color: '#e0b341',
                }}
              >
                ⚠️ Without a suffix, this modifier won't change anything
                on the slip or .txt file.
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            style={{
              padding: '8px 16px',
              background: 'transparent',
              color: 'var(--accent)',
              border: '1px dashed var(--border-color)',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              width: '100%',
            }}
          >
            + Add a mapping manually
          </button>
        )}
      </Section>

      {/* Phase 16: history modal — null when closed */}
      {historyTarget && (
        <HistoryModal
          configType="addon_mapping"
          entityId={historyTarget.optId}
          title={`History — ${historyTarget.name} (opt ${historyTarget.optId})`}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Discovery panel
// ──────────────────────────────────────────────────────────

function DiscoveryPanel({
  unmapped,
  scannedOrders,
  scanLimit,
  scanning,
  onScanMore,
  canScanMore,
  onMap,
}) {
  return (
    <div
      style={{
        padding: 12,
        background: 'rgba(74,127,193,0.06)',
        border: '1px solid rgba(74,127,193,0.3)',
        borderRadius: 6,
        marginBottom: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#4a7fc1',
          }}
        >
          {scanning
            ? `Scanning ${scanLimit.toLocaleString()} orders…`
            : `Unmapped add-ons in recent orders (${unmapped.length}; scanned ${scannedOrders.toLocaleString()} orders)`}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {canScanMore && (
            <button
              onClick={onScanMore}
              disabled={scanning}
              style={{
                padding: '4px 10px',
                background: scanning ? 'transparent' : '#4a7fc1',
                color: scanning ? 'var(--text-muted)' : '#fff',
                border:
                  '1px solid ' +
                  (scanning ? 'var(--border-color)' : '#4a7fc1'),
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 500,
                cursor: scanning ? 'default' : 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {scanning ? 'Scanning…' : 'Scan more orders'}
            </button>
          )}
        </div>
      </div>
      {unmapped.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
            padding: '6px 0',
          }}
        >
          No unmapped add-ons in the last {scannedOrders.toLocaleString()}{' '}
          orders.
          {canScanMore && ' Scan more to look further back.'}
        </div>
      ) : (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
          }}
        >
          <thead>
            <tr>
              <th style={thStyleTight}>Opt ID</th>
              <th style={thStyleTight}>Name (from Sytist)</th>
              <th style={thStyleTightRight}>Count</th>
              <th style={thStyleTightRight}>Avg price</th>
              <th style={thStyleTightRight}></th>
            </tr>
          </thead>
          <tbody>
            {unmapped.map((u) => (
              <tr key={u.optId}>
                <td style={tdStyleTight}>
                  <code>{u.optId}</code>
                </td>
                <td style={tdStyleTight}>
                  {u.optName || (
                    <span style={{ color: 'var(--text-muted)' }}>
                      (no name)
                    </span>
                  )}
                </td>
                <td style={tdStyleTightRight}>{u.occurrences}</td>
                <td style={tdStyleTightRight}>
                  ${(u.samplePrice || 0).toFixed(2)}
                </td>
                <td style={tdStyleTightRight}>
                  <button
                    onClick={() => onMap(u)}
                    style={{
                      padding: '3px 10px',
                      background: '#4a7fc1',
                      color: '#fff',
                      border: '1px solid #4a7fc1',
                      borderRadius: 3,
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Map
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// MappingRow — editable row for an existing opt_id → sku mapping
// ──────────────────────────────────────────────────────────

function MappingRow({ optId, mapping, productWeights, onSave, onDelete, onViewHistory }) {
  // Phase 15c: support both product and modifier mapping types.
  // Legacy mappings without an explicit type default to product
  // (the only behavior before 15c).
  const initialType = mapping.type === 'modifier' ? 'modifier' : 'product';
  const [type, setType] = useState(initialType);
  const [name, setName] = useState(mapping.name || '');
  const [sku, setSku] = useState(mapping.sku || '');
  const [qty, setQty] = useState(mapping.qty || 1);
  const [suffix, setSuffix] = useState(mapping.suffix || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setType(mapping.type === 'modifier' ? 'modifier' : 'product');
    setName(mapping.name || '');
    setSku(mapping.sku || '');
    setQty(mapping.qty || 1);
    setSuffix(mapping.suffix || '');
  }, [mapping]);

  const origType = mapping.type === 'modifier' ? 'modifier' : 'product';
  const isDirty =
    type !== origType ||
    name !== (mapping.name || '') ||
    (type === 'product' &&
      (sku !== (mapping.sku || '') ||
        (parseInt(qty, 10) || 1) !== (mapping.qty || 1))) ||
    (type === 'modifier' && suffix !== (mapping.suffix || ''));

  const skuInfo = productWeights[String(sku)];

  async function handleSave() {
    setSaving(true);
    try {
      if (type === 'modifier') {
        await onSave({ type: 'modifier', name, suffix });
      } else {
        await onSave({
          type: 'product',
          name,
          sku,
          qty: Math.max(1, parseInt(qty, 10) || 1),
        });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td style={tdStyle}>
        <code style={{ fontSize: 12 }}>{optId}</code>
      </td>
      <td style={tdStyle}>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          style={{ ...inputStyle, fontSize: 11 }}
        >
          <option value="product">Product</option>
          <option value="modifier">Modifier</option>
        </select>
      </td>
      <td style={tdStyle}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="(name)"
          style={{ ...inputStyle, width: '100%' }}
        />
      </td>
      <td style={tdStyle}>
        {type === 'product' ? (
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: 1, minWidth: 160 }}>
              <SkuPicker
                value={sku}
                onChange={setSku}
                productWeights={productWeights}
              />
            </div>
            <input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              style={{ ...inputStyle, width: 50, textAlign: 'right' }}
              title="Quantity"
            />
            {!sku ? (
              <span style={{ color: '#e0b341', fontSize: 11 }}>⚠️ No SKU</span>
            ) : !skuInfo ? (
              <span style={{ color: '#dc3545', fontSize: 11 }}>
                ⚠️ Unknown
              </span>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {skuInfo.name}
              </span>
            )}
          </div>
        ) : (
          <div>
            <input
              type="text"
              value={suffix}
              onChange={(e) => setSuffix(e.target.value)}
              placeholder=" (Framed)"
              style={{ ...inputStyle, width: '100%' }}
            />
            {!suffix && (
              <div style={{ fontSize: 10, color: '#e0b341', marginTop: 2 }}>
                ⚠️ Empty suffix has no effect
              </div>
            )}
          </div>
        )}
      </td>
      <td style={tdStyleRight}>
        <div
          style={{
            display: 'flex',
            gap: 6,
            justifyContent: 'flex-end',
            alignItems: 'center',
          }}
        >
          <button
            onClick={onViewHistory}
            title="View edit history"
            style={{
              ...buttonStyle('secondary', false),
              padding: '5px 8px',
              fontSize: 11,
            }}
          >
            📜
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            style={buttonStyle('primary', !isDirty || saving)}
          >
            {saving ? 'Saving…' : isDirty ? 'Save' : 'Saved'}
          </button>
          <button
            onClick={onDelete}
            style={{
              ...buttonStyle('secondary', false),
              color: '#dc3545',
            }}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

// ──────────────────────────────────────────────────────────
// SkuPicker — dropdown of all configured productWeights SKUs
// ──────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────
// TypeChip — segmented control for product vs modifier
// ──────────────────────────────────────────────────────────

function TypeChip({ active, onClick, children, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '5px 12px',
        background: active ? '#4a7fc1' : 'transparent',
        color: active ? '#fff' : 'var(--text-secondary)',
        border: '1px solid ' + (active ? '#4a7fc1' : 'var(--border-color)'),
        borderRadius: 4,
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function SkuPicker({ value, onChange, productWeights }) {
  const skus = Object.keys(productWeights).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10)
  );
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...inputStyle,
        width: '100%',
      }}
    >
      <option value="">— pick a SKU —</option>
      {skus.map((sku) => (
        <option key={sku} value={sku}>
          SKU {sku} — {productWeights[sku].name}
        </option>
      ))}
    </select>
  );
}

// ──────────────────────────────────────────────────────────
// Layout helpers
// ──────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3
        style={{
          fontSize: 13,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-muted)',
          marginBottom: 10,
          paddingBottom: 6,
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function FieldStack({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label
        style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  padding: '5px 8px',
  fontSize: 12,
  background: 'var(--bg-input)',
  border: '1px solid var(--border-color)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
};

// Phase 16: small icon-style action button (export, import, history).
const smallActionButton = {
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 500,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

function buttonStyle(variant, disabled) {
  const isPrimary = variant === 'primary';
  const enabled = !disabled;
  return {
    padding: '5px 12px',
    background:
      isPrimary && enabled
        ? '#4a7fc1'
        : 'transparent',
    color:
      isPrimary && enabled
        ? '#fff'
        : disabled
        ? 'var(--text-muted)'
        : 'var(--text-secondary)',
    border: isPrimary && enabled
      ? '1px solid #4a7fc1'
      : '1px solid var(--border-color)',
    borderRadius: 3,
    fontSize: 12,
    fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
}

const thStyle = {
  textAlign: 'left',
  padding: '6px 8px 6px 0',
  fontSize: 10,
  fontWeight: 500,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  borderBottom: '1px solid var(--border-color)',
};
const thStyleRight = { ...thStyle, textAlign: 'right' };
const thStyleTight = { ...thStyle, padding: '4px 6px 4px 0' };
const thStyleTightRight = { ...thStyleTight, textAlign: 'right' };
const tdStyle = {
  padding: '6px 8px 6px 0',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  verticalAlign: 'middle',
};
const tdStyleRight = {
  ...tdStyle,
  textAlign: 'right',
};
const tdStyleTight = {
  padding: '4px 6px 4px 0',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  fontSize: 12,
};
const tdStyleTightRight = { ...tdStyleTight, textAlign: 'right' };
