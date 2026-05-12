import React, { useEffect, useState, useCallback } from 'react';
import api from '../../services/api';
import HistoryModal from '../../components/HistoryModal';

/**
 * Settings → Packages
 *
 * Phase 15a: per-package SKU → constituent items configuration. This
 * is what drives the order-pipeline explosion: when a customer orders
 * a "Gold Package" (single ms_cart row), sytistDbService consults this
 * config to emit synthetic line items for each constituent so the
 * existing pipeline (composite, imposition, darkroom .txt, slip) sees
 * the full set of products to make.
 *
 * The page renders one card per package SKU. Each card has:
 *   - Editable name
 *   - Editable items list (SKU + qty per row)
 *   - Add-item dropdown populated from Settings → Packaging's product
 *     weights (so operators pick from real SKUs, not free-text)
 *   - Per-item warnings: missing imposition/composite mappings produce
 *     a one-line warning, since those items will print at full size
 *     instead of being multi-up imposed or composited.
 *   - Per-card Save button
 *
 * Also has a "Lint" panel at the top that shows config-wide warnings
 * (e.g. "Trading Cards has no imposition mapping — will print full
 * size") so operators can address everything from one place.
 */
export default function PackagesPage() {
  const [config, setConfig] = useState(null);
  const [productWeights, setProductWeights] = useState({});
  const [packagingBundles, setPackagingBundles] = useState({});
  const [lintWarnings, setLintWarnings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Phase 15a hotfix-2: add/remove package controls. The form is
  // hidden until the operator clicks "Add Package" — keeps the page
  // clean when no addition is in progress.
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPkgSku, setNewPkgSku] = useState('');
  const [newPkgName, setNewPkgName] = useState('');
  const [savingNew, setSavingNew] = useState(false);

  // Phase 16: history modal + import state.
  const [historyTarget, setHistoryTarget] = useState(null);
  const [importing, setImporting] = useState(false);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [pkgs, packagingResp, lint] = await Promise.all([
        api.get('/api/sytist/package-contents'),
        api.get('/api/shipstation/packaging/config'),
        api.get('/api/sytist/package-contents/lint'),
      ]);
      setConfig(pkgs.packages || {});
      // Phase 15a hotfix-1: the /packaging/config endpoint returns
      // { config: {...} }, not a flat object. Unwrap the inner config
      // before reading productWeights / packageBundles.
      const packaging = packagingResp.config || packagingResp || {};
      setProductWeights(packaging.productWeights || {});
      setPackagingBundles(packaging.packageBundles || {});
      setLintWarnings(lint.warnings || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handleSavePackage(packageSku, packageDef) {
    setError(null);
    try {
      const data = await api.put(
        `/api/sytist/package-contents/${packageSku}`,
        packageDef
      );
      setConfig(data.packages || {});
      // Re-lint after save since adding/removing items changes warnings
      try {
        const lint = await api.get('/api/sytist/package-contents/lint');
        setLintWarnings(lint.warnings || []);
      } catch {
        // ignore lint errors — not fatal
      }
    } catch (err) {
      setError(err.message);
    }
  }

  // Phase 15a hotfix-2: add a new package row. Validates SKU is
  // non-empty and not already a package; surfaces a soft warning
  // (not blocking) if the SKU doesn't appear in productWeights yet,
  // since the package row needs to exist in Sytist + packaging-config
  // for the explosion to actually fire on any real order.
  async function handleAddPackage() {
    setError(null);
    const sku = String(newPkgSku || '').trim();
    const name = String(newPkgName || '').trim();
    if (!sku) {
      setError('Package SKU is required');
      return;
    }
    if (config && config[sku]) {
      setError(`SKU ${sku} is already configured as a package`);
      return;
    }
    setSavingNew(true);
    try {
      const data = await api.put(`/api/sytist/package-contents/${sku}`, {
        name: name || `Package ${sku}`,
        items: [],
      });
      setConfig(data.packages || {});
      setShowAddForm(false);
      setNewPkgSku('');
      setNewPkgName('');
      // Re-lint
      try {
        const lint = await api.get('/api/sytist/package-contents/lint');
        setLintWarnings(lint.warnings || []);
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingNew(false);
    }
  }

  // Phase 15a hotfix-2: delete a package. Confirms first since this
  // is destructive — operator can't recover the items list without
  // re-entering it.
  async function handleDeletePackage(packageSku, packageName) {
    setError(null);
    const ok = window.confirm(
      `Remove "${packageName}" (SKU ${packageSku}) from the package contents config?\n\n` +
        `This only affects the dashboard's explosion config. Existing orders that already contain this package will no longer be exploded into their items.\n\n` +
        `If the package still exists in Sytist + Settings → Packaging, customers can still order it; it just won't be expanded by the production pipeline.`
    );
    if (!ok) return;
    try {
      const data = await api.del(
        `/api/sytist/package-contents/${packageSku}`
      );
      setConfig(data.packages || {});
      try {
        const lint = await api.get('/api/sytist/package-contents/lint');
        setLintWarnings(lint.warnings || []);
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(err.message);
    }
  }

  // Phase 16: export current config to JSON file.
  function handleExport() {
    const link = document.createElement('a');
    link.href = '/api/sytist/package-contents/export';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Phase 16: import config from JSON file. Wholesale replacement.
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
      const pkgCount = Object.keys(parsed.packages || parsed).length;
      const ok = window.confirm(
        `Import ${pkgCount} packages, replacing the current configuration?\n\n` +
          `This action is recorded in the audit history.`
      );
      if (!ok) return;
      await api.put('/api/sytist/package-contents/import', parsed);
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;
  }

  const packageSkus = Object.keys(config || {}).sort();

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
        <h2 style={{ margin: 0, fontSize: 18 }}>Packages</h2>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={handleExport}
            disabled={importing}
            title="Download current package contents as a JSON file"
            style={smallActionButton}
          >
            ↓ Export
          </button>
          <label
            style={{
              ...smallActionButton,
              cursor: importing ? 'default' : 'pointer',
            }}
          >
            {importing ? 'Importing…' : '↑ Import'}
            <input
              type="file"
              accept=".json,application/json"
              disabled={importing}
              onChange={(e) => {
                handleImport(e.target.files?.[0]);
                e.target.value = '';
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
        Sytist stores a customer's package as a single line item. This
        page defines what's inside each package so the production
        pipeline can make every constituent print, magnet, button, etc.
        The customer's selected photo is used for every item in the
        package.
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

      {lintWarnings.length > 0 && (
        <LintPanel warnings={lintWarnings} />
      )}

      {packageSkus.map((sku) => (
        <PackageCard
          key={sku}
          packageSku={sku}
          packageDef={config[sku]}
          productWeights={productWeights}
          packagingBundles={packagingBundles}
          warnings={lintWarnings.filter((w) => w.packageSku === sku)}
          onSave={(def) => handleSavePackage(sku, def)}
          onDelete={() => handleDeletePackage(sku, config[sku].name)}
          onViewHistory={() =>
            setHistoryTarget({
              packageSku: sku,
              name: config[sku].name || `Package ${sku}`,
            })
          }
        />
      ))}

      {/* Phase 15a hotfix-2: Add Package affordance. Operators can
          add a new package SKU to the explosion config from this UI.
          The actual SKU still needs to exist in Sytist's product
          catalog + Settings → Packaging's productWeights for the
          explosion to fire on real orders — this just defines the
          contents that will be expanded when it does. */}
      {showAddForm ? (
        <div
          style={{
            padding: 16,
            background: 'var(--bg-card)',
            border: '1px solid #4a7fc1',
            borderRadius: 8,
            marginBottom: 20,
          }}
        >
          <div
            style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}
          >
            Add new package
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                SKU
              </label>
              <input
                type="text"
                value={newPkgSku}
                onChange={(e) => setNewPkgSku(e.target.value)}
                placeholder="e.g. 4"
                style={{
                  padding: '6px 10px',
                  fontSize: 13,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                  width: 100,
                }}
                autoFocus
              />
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                flex: 1,
                minWidth: 200,
              }}
            >
              <label
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                Name
              </label>
              <input
                type="text"
                value={newPkgName}
                onChange={(e) => setNewPkgName(e.target.value)}
                placeholder="e.g. Platinum Package"
                style={{
                  padding: '6px 10px',
                  fontSize: 13,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                  width: '100%',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <button
                onClick={handleAddPackage}
                disabled={!newPkgSku.trim() || savingNew}
                style={{
                  padding: '6px 14px',
                  background:
                    !newPkgSku.trim() || savingNew ? 'transparent' : '#4a7fc1',
                  color:
                    !newPkgSku.trim() || savingNew
                      ? 'var(--text-muted)'
                      : '#fff',
                  border:
                    !newPkgSku.trim() || savingNew
                      ? '1px solid var(--border-color)'
                      : '1px solid #4a7fc1',
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor:
                    !newPkgSku.trim() || savingNew ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {savingNew ? 'Adding…' : 'Add'}
              </button>
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setNewPkgSku('');
                  setNewPkgName('');
                  setError(null);
                }}
                style={{
                  padding: '6px 14px',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
          {newPkgSku.trim() &&
            !productWeights[newPkgSku.trim()] &&
            !packagingBundles[newPkgSku.trim()] && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: '#e0b341',
                }}
              >
                ⚠️ SKU {newPkgSku.trim()} isn't in Settings → Packaging yet.
                You can still configure its contents here, but the
                explosion only fires for orders that actually contain
                this SKU. Add it to Settings → Packaging too if it's a
                real product.
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
            marginBottom: 20,
          }}
        >
          + Add Package
        </button>
      )}

      {/* Phase 16: history modal */}
      {historyTarget && (
        <HistoryModal
          configType="package"
          entityId={historyTarget.packageSku}
          title={`History — ${historyTarget.name} (SKU ${historyTarget.packageSku})`}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// LintPanel
// ──────────────────────────────────────────────────────────

function LintPanel({ warnings }) {
  const errors = warnings.filter((w) => w.severity === 'error');
  const warns = warnings.filter((w) => w.severity === 'warning');
  return (
    <div
      style={{
        padding: 12,
        background: 'rgba(224,179,65,0.06)',
        border: '1px solid rgba(224,179,65,0.3)',
        borderRadius: 6,
        marginBottom: 20,
        fontSize: 12,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: '#e0b341',
          marginBottom: 8,
        }}
      >
        ⚠️ Configuration issues ({errors.length + warns.length})
      </div>
      {errors.map((w, i) => (
        <div
          key={'e' + i}
          style={{ marginBottom: 4, color: '#dc3545' }}
        >
          <strong>{w.packageName}</strong>: {w.message}
        </div>
      ))}
      {warns.map((w, i) => (
        <div
          key={'w' + i}
          style={{ marginBottom: 4, color: 'var(--text-secondary)' }}
        >
          <strong>{w.packageName}</strong>: {w.message}
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// PackageCard — one editable card per package SKU
// ──────────────────────────────────────────────────────────

function PackageCard({
  packageSku,
  packageDef,
  productWeights,
  packagingBundles,
  warnings,
  onSave,
  onDelete,
  onViewHistory,
}) {
  // Local edit state (form is dirty until Save is clicked)
  const [name, setName] = useState(packageDef.name || '');
  const [items, setItems] = useState(packageDef.items || []);
  const [saving, setSaving] = useState(false);
  const [addSku, setAddSku] = useState('');
  const [addQty, setAddQty] = useState(1);

  // Reset state when the parent re-fetches (e.g. after save)
  useEffect(() => {
    setName(packageDef.name || '');
    setItems(packageDef.items || []);
  }, [packageDef]);

  const isDirty =
    name !== (packageDef.name || '') ||
    JSON.stringify(items) !== JSON.stringify(packageDef.items || []);

  // Compute total expected weight from constituent SKUs. Operators can
  // sanity-check against the packageBundles[].weight they may have set
  // earlier in Settings → Packaging.
  const totalOz = items.reduce((sum, item) => {
    const w = productWeights[String(item.sku)];
    if (!w) return sum;
    return sum + (w.weight || 0) * (item.qty || 1);
  }, 0);
  const bundleWeight = packagingBundles[String(packageSku)]?.weight ?? null;

  const productSkus = Object.keys(productWeights).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10)
  );

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({ name, items });
    } finally {
      setSaving(false);
    }
  }

  function handleAddItem() {
    if (!addSku) return;
    if (items.some((it) => String(it.sku) === String(addSku))) {
      alert(`SKU ${addSku} is already in this package`);
      return;
    }
    setItems([...items, { sku: String(addSku), qty: parseInt(addQty, 10) || 1 }]);
    setAddSku('');
    setAddQty(1);
  }

  function handleRemoveItem(sku) {
    setItems(items.filter((it) => String(it.sku) !== String(sku)));
  }

  function handleUpdateQty(sku, newQty) {
    const n = Math.max(1, parseInt(newQty, 10) || 1);
    setItems(
      items.map((it) =>
        String(it.sku) === String(sku) ? { ...it, qty: n } : it
      )
    );
  }

  return (
    <div
      style={{
        marginBottom: 20,
        padding: 16,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <code
            style={{
              fontSize: 12,
              padding: '2px 8px',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 3,
              color: 'var(--text-muted)',
            }}
          >
            SKU {packageSku}
          </code>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: 14,
              fontWeight: 600,
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              minWidth: 200,
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {onViewHistory && (
            <button
              onClick={onViewHistory}
              title="View edit history for this package"
              style={{
                padding: '6px 10px',
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              📜 History
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              title="Remove this package from the contents config"
              style={{
                padding: '6px 12px',
                background: 'transparent',
                color: '#dc3545',
                border: '1px solid var(--border-color)',
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              Delete
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            style={{
              padding: '6px 14px',
              background: !isDirty || saving ? 'transparent' : '#4a7fc1',
              color: !isDirty || saving ? 'var(--text-muted)' : '#fff',
              border:
                !isDirty || saving
                  ? '1px solid var(--border-color)'
                  : '1px solid #4a7fc1',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 500,
              cursor: !isDirty || saving ? 'default' : 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
          marginBottom: 8,
        }}
      >
        <thead>
          <tr>
            <th style={thStyle}>SKU</th>
            <th style={thStyle}>Product</th>
            <th style={thStyleRight}>Qty</th>
            <th style={thStyleRight}>Unit oz</th>
            <th style={thStyleRight}>Line oz</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td
                colSpan={6}
                style={{
                  ...tdStyle,
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                  textAlign: 'center',
                  padding: 16,
                }}
              >
                No items configured. Add items below.
              </td>
            </tr>
          ) : (
            items.map((item) => {
              const w = productWeights[String(item.sku)];
              const itemName = w ? w.name : null;
              const lineOz = w ? (w.weight || 0) * (item.qty || 1) : 0;
              const warningForItem = warnings.find(
                (warn) =>
                  String(warn.itemSku) === String(item.sku) &&
                  warn.severity === 'warning'
              );
              const errorForItem = warnings.find(
                (warn) =>
                  String(warn.itemSku) === String(item.sku) &&
                  warn.severity === 'error'
              );
              return (
                <tr key={item.sku}>
                  <td style={tdStyle}>
                    <code style={{ fontSize: 12 }}>{item.sku}</code>
                  </td>
                  <td style={tdStyle}>
                    {itemName || (
                      <span style={{ color: '#dc3545' }}>
                        (unknown SKU)
                      </span>
                    )}
                    {errorForItem && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#dc3545',
                          marginTop: 2,
                        }}
                      >
                        {errorForItem.message}
                      </div>
                    )}
                    {warningForItem && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#e0b341',
                          marginTop: 2,
                        }}
                      >
                        ⚠️ {warningForItem.message}
                      </div>
                    )}
                  </td>
                  <td style={tdStyleRight}>
                    <input
                      type="number"
                      min="1"
                      value={item.qty}
                      onChange={(e) =>
                        handleUpdateQty(item.sku, e.target.value)
                      }
                      style={qtyInputStyle}
                    />
                  </td>
                  <td style={tdStyleRight}>
                    {w
                      ? (w.weight || 0).toFixed(2)
                      : '—'}
                  </td>
                  <td style={tdStyleRight}>{lineOz.toFixed(2)}</td>
                  <td style={tdStyleRight}>
                    <button
                      onClick={() => handleRemoveItem(item.sku)}
                      title="Remove"
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border-color)',
                        color: '#dc3545',
                        padding: '2px 8px',
                        borderRadius: 3,
                        fontSize: 11,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {/* Totals row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
          padding: '8px 0',
          borderTop: '1px solid var(--border-color)',
          marginBottom: 12,
        }}
      >
        <div style={{ color: 'var(--text-muted)' }}>
          {items.length} item{items.length === 1 ? '' : 's'}
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Total weight: </span>
          <strong style={{ color: 'var(--text-secondary)' }}>
            {totalOz.toFixed(2)} oz
          </strong>
          {bundleWeight !== null && (
            <span
              style={{
                color:
                  Math.abs(bundleWeight - totalOz) > 0.5
                    ? '#e0b341'
                    : 'var(--text-muted)',
                marginLeft: 12,
                fontSize: 11,
              }}
              title="Compare against the bundle weight set in Settings → Packaging → Package bundles"
            >
              (bundle row says {bundleWeight} oz
              {Math.abs(bundleWeight - totalOz) > 0.5
                ? ' — mismatch'
                : ''}
              )
            </span>
          )}
        </div>
      </div>

      {/* Add item */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: 8,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Add item:
        </span>
        <select
          value={addSku}
          onChange={(e) => setAddSku(e.target.value)}
          style={{
            flex: 1,
            padding: '5px 8px',
            fontSize: 12,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            borderRadius: 3,
            fontFamily: 'inherit',
          }}
        >
          <option value="">— pick a SKU —</option>
          {productSkus
            .filter((sku) => !items.some((it) => String(it.sku) === sku))
            .map((sku) => (
              <option key={sku} value={sku}>
                SKU {sku} — {productWeights[sku].name}
              </option>
            ))}
        </select>
        <input
          type="number"
          min="1"
          value={addQty}
          onChange={(e) => setAddQty(e.target.value)}
          style={{ ...qtyInputStyle, width: 60 }}
          placeholder="qty"
        />
        <button
          onClick={handleAddItem}
          disabled={!addSku}
          style={{
            padding: '5px 12px',
            background: addSku ? '#4a7fc1' : 'transparent',
            color: addSku ? '#fff' : 'var(--text-muted)',
            border: '1px solid ' + (addSku ? '#4a7fc1' : 'var(--border-color)'),
            borderRadius: 3,
            fontSize: 12,
            fontWeight: 500,
            cursor: addSku ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
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
const tdStyle = {
  padding: '6px 8px 6px 0',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  verticalAlign: 'top',
};
const tdStyleRight = {
  ...tdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};
const qtyInputStyle = {
  width: 50,
  padding: '4px 6px',
  fontSize: 12,
  background: 'var(--bg-input)',
  border: '1px solid var(--border-color)',
  borderRadius: 3,
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  textAlign: 'right',
};

// Phase 16: small icon-style action button (export, import).
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
