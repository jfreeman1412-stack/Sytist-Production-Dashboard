import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  StatusBanner,
} from '../../components/SettingsForm';

// ─── PackagingPage (Phase 13b) ──────────────────────────────
//
// Settings UI for the packaging rules engine. Five sections:
//
//   1. Product weights (SKU → name, weight, category)
//   2. Packaging types (template dims + base weight per type)
//   3. Routing rules (forcePackageSKUs, boxRouteSKUs,
//      magnet threshold, packing slip weight)
//   4. Package bundles (Gold/Silver/Bronze SKU → weight,
//      forcePackage flag)
//   5. Test calculator (paste an order ID → see engine output)
//
// All state lives in component state. Save buttons per-section
// hit the appropriate /api/shipstation/packaging/... endpoint.
// Loading the page does one initial GET /packaging/config; saves
// re-fetch to pick up server-side normalizations.
//
// CATEGORIES used by the engine: 'flat', 'rigid', 'pano', 'bulky',
// 'digital'. The dropdown enforces these values to keep the engine
// happy.

const CATEGORIES = ['flat', 'rigid', 'pano', 'bulky', 'digital'];

export default function PackagingPage() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadConfig() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/api/shipstation/packaging/config');
      setConfig(data.config);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function noteSaved() {
    setSavedAt(new Date());
    // Auto-dismiss success after a few seconds so the page stays clean
    setTimeout(() => setSavedAt(null), 4000);
  }

  // ─── Section save helpers ──────────────────────────────

  async function saveConfigSubset(updates) {
    setError(null);
    try {
      const data = await api.put(
        '/api/shipstation/packaging/config',
        updates
      );
      setConfig(data.config);
      noteSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function putProductWeight(sku, payload) {
    setError(null);
    try {
      const data = await api.put(
        `/api/shipstation/packaging/product-weights/${encodeURIComponent(
          sku
        )}`,
        payload
      );
      setConfig((prev) => ({ ...prev, productWeights: data.productWeights }));
      noteSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteProductWeight(sku) {
    setError(null);
    try {
      const data = await api.del(
        `/api/shipstation/packaging/product-weights/${encodeURIComponent(
          sku
        )}`
      );
      setConfig((prev) => ({ ...prev, productWeights: data.productWeights }));
      noteSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function putPackagingType(typeId, payload) {
    setError(null);
    try {
      const data = await api.put(
        `/api/shipstation/packaging/types/${encodeURIComponent(typeId)}`,
        payload
      );
      setConfig((prev) => ({ ...prev, packagingTypes: data.packagingTypes }));
      noteSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function putPackageBundle(sku, payload) {
    setError(null);
    try {
      const data = await api.put(
        `/api/shipstation/packaging/bundles/${encodeURIComponent(sku)}`,
        payload
      );
      setConfig((prev) => ({ ...prev, packageBundles: data.packageBundles }));
      noteSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deletePackageBundle(sku) {
    setError(null);
    try {
      const data = await api.del(
        `/api/shipstation/packaging/bundles/${encodeURIComponent(sku)}`
      );
      setConfig((prev) => ({ ...prev, packageBundles: data.packageBundles }));
      noteSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  // ─── render ────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <PageHeader title="Packaging" />
        <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    );
  }

  if (!config && error) {
    return (
      <div>
        <PageHeader
          title="Packaging"
          subtitle="Rules for the ShipStation packaging engine."
        />
        <StatusBanner
          kind="error"
          message={`Couldn't load packaging config: ${error}`}
        />
        <button
          type="button"
          onClick={loadConfig}
          style={retryButtonStyle}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Packaging"
        subtitle="Rules for the ShipStation packaging engine. Settings on this page drive the weight, dimensions, carrier, and service the engine suggests for each order. The operator can still override per-order before sending."
      />

      {error && <StatusBanner kind="error" message={error} />}
      {savedAt && !error && (
        <StatusBanner
          kind="success"
          message={`Saved at ${savedAt.toLocaleTimeString()}.`}
        />
      )}

      <ProductWeightsSection
        productWeights={config.productWeights || {}}
        onSave={putProductWeight}
        onDelete={deleteProductWeight}
      />

      <PackagingTypesSection
        packagingTypes={config.packagingTypes || {}}
        onSave={putPackagingType}
      />

      <RoutingRulesSection
        config={config}
        onSave={saveConfigSubset}
      />

      <PackageBundlesSection
        packageBundles={config.packageBundles || {}}
        onSave={putPackageBundle}
        onDelete={deletePackageBundle}
      />

      <TestCalculatorSection />
    </div>
  );
}

// ─── Section 1: Product weights ───────────────────────────

function ProductWeightsSection({ productWeights, onSave, onDelete }) {
  // Keep a draft buffer so editing doesn't fire a save per keystroke.
  // Sorted by SKU for stable display.
  const skus = Object.keys(productWeights).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10)
  );

  // New-row state
  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newWeight, setNewWeight] = useState('');
  const [newCategory, setNewCategory] = useState('flat');
  const [newInstantPack, setNewInstantPack] = useState(false);

  async function handleAdd() {
    if (!newSku.trim()) return;
    await onSave(newSku.trim(), {
      name: newName.trim(),
      weight: parseFloat(newWeight) || 0,
      category: newCategory,
      instantPackEligible: newInstantPack,
    });
    setNewSku('');
    setNewName('');
    setNewWeight('');
    setNewCategory('flat');
    setNewInstantPack(false);
  }

  return (
    <Section
      title="Product weights"
      description="Per-SKU weight (in oz) and category. The engine uses these to compute order weight and route to the right packaging type."
    >
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>SKU</th>
            <th style={thStyle}>Name</th>
            <th style={thStyleRight}>Weight (oz)</th>
            <th style={thStyle}>Category</th>
            <th style={{ ...thStyle, textAlign: 'center' }} title="When checked, products with this SKU can be auto-packed/shipped without operator review. An order is Instant-Ship eligible only if EVERY physical item in it is checked (default off).">⚡ Instant-Ship Eligible</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {skus.map((sku) => (
            <ProductWeightRow
              key={sku}
              sku={sku}
              row={productWeights[sku]}
              onSave={onSave}
              onDelete={onDelete}
            />
          ))}
          {/* New row */}
          <tr style={{ background: 'rgba(74,127,193,0.05)' }}>
            <td style={tdStyle}>
              <CellInput
                value={newSku}
                onChange={setNewSku}
                placeholder="SKU"
                width={70}
              />
            </td>
            <td style={tdStyle}>
              <CellInput
                value={newName}
                onChange={setNewName}
                placeholder="Display name"
              />
            </td>
            <td style={tdStyleRight}>
              <CellInput
                value={newWeight}
                onChange={setNewWeight}
                type="number"
                placeholder="0"
                width={70}
                align="right"
              />
            </td>
            <td style={tdStyle}>
              <CellSelect
                value={newCategory}
                onChange={setNewCategory}
                options={CATEGORIES}
              />
            </td>
            <td style={{ ...tdStyle, textAlign: 'center' }}>
              <input
                type="checkbox"
                checked={newInstantPack}
                onChange={(e) => setNewInstantPack(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
            </td>
            <td style={tdStyle}>
              <button
                onClick={handleAdd}
                disabled={!newSku.trim()}
                style={smallButton('#4a7fc1')}
              >
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

function ProductWeightRow({ sku, row, onSave, onDelete }) {
  const [name, setName] = useState(row.name || '');
  const [weight, setWeight] = useState(String(row.weight ?? ''));
  const [category, setCategory] = useState(row.category || 'flat');
  const [instantPack, setInstantPack] = useState(row.instantPackEligible === true);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(row.name || '');
    setWeight(String(row.weight ?? ''));
    setCategory(row.category || 'flat');
    setInstantPack(row.instantPackEligible === true);
    setDirty(false);
  }, [row.name, row.weight, row.category, row.instantPackEligible]);

  function bump() {
    setDirty(true);
  }

  return (
    <tr>
      <td style={tdStyle}>
        <code>{sku}</code>
      </td>
      <td style={tdStyle}>
        <CellInput
          value={name}
          onChange={(v) => {
            setName(v);
            bump();
          }}
        />
      </td>
      <td style={tdStyleRight}>
        <CellInput
          value={weight}
          onChange={(v) => {
            setWeight(v);
            bump();
          }}
          type="number"
          width={70}
          align="right"
        />
      </td>
      <td style={tdStyle}>
        <CellSelect
          value={category}
          onChange={(v) => {
            setCategory(v);
            bump();
          }}
          options={CATEGORIES}
        />
      </td>
      <td style={{ ...tdStyle, textAlign: 'center' }}>
        <input
          type="checkbox"
          checked={instantPack}
          onChange={(e) => {
            setInstantPack(e.target.checked);
            bump();
          }}
          style={{ cursor: 'pointer' }}
        />
      </td>
      <td style={tdStyle}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            disabled={!dirty}
            onClick={() => onSave(sku, { name, weight, category, instantPackEligible: instantPack })}
            style={smallButton(dirty ? '#4a7fc1' : 'transparent', !dirty)}
          >
            Save
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Delete SKU ${sku} from product weights?`)) {
                onDelete(sku);
              }
            }}
            style={smallButton('transparent', false, true)}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Section 2: Packaging types ────────────────────────────

function PackagingTypesSection({ packagingTypes, onSave }) {
  const typeIds = Object.keys(packagingTypes).sort();

  return (
    <Section
      title="Packaging types"
      description="The templates the engine routes orders into. Dimensions are inches; base weight (oz) is added on top of line-item weights. Service is the SS packageCode (large_envelope_or_flat or package)."
    >
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Type ID</th>
            <th style={thStyle}>Name</th>
            <th style={thStyleRight}>Length</th>
            <th style={thStyleRight}>Width</th>
            <th style={thStyleRight}>Height</th>
            <th style={thStyleRight}>Base wt (oz)</th>
            <th style={thStyle}>Service</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {typeIds.map((id) => (
            <PackagingTypeRow
              key={id}
              typeId={id}
              row={packagingTypes[id]}
              onSave={onSave}
            />
          ))}
        </tbody>
      </table>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        Type IDs are referenced by the engine internally (e.g.{' '}
        <code>flat_6x8</code>, <code>medium_box</code>) and can't be
        renamed here without editing the JSON config directly.
      </div>
    </Section>
  );
}

function PackagingTypeRow({ typeId, row, onSave }) {
  const [name, setName] = useState(row.name || '');
  const [length, setLength] = useState(String(row.length ?? ''));
  const [width, setWidth] = useState(String(row.width ?? ''));
  const [height, setHeight] = useState(String(row.height ?? ''));
  const [baseWeight, setBaseWeight] = useState(String(row.baseWeight ?? ''));
  const [service, setService] = useState(row.service || 'package');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(row.name || '');
    setLength(String(row.length ?? ''));
    setWidth(String(row.width ?? ''));
    setHeight(String(row.height ?? ''));
    setBaseWeight(String(row.baseWeight ?? ''));
    setService(row.service || 'package');
    setDirty(false);
  }, [row.name, row.length, row.width, row.height, row.baseWeight, row.service]);

  function bump() {
    setDirty(true);
  }

  return (
    <tr>
      <td style={tdStyle}>
        <code>{typeId}</code>
      </td>
      <td style={tdStyle}>
        <CellInput
          value={name}
          onChange={(v) => {
            setName(v);
            bump();
          }}
        />
      </td>
      <td style={tdStyleRight}>
        <CellInput
          value={length}
          onChange={(v) => {
            setLength(v);
            bump();
          }}
          type="number"
          width={70}
          align="right"
        />
      </td>
      <td style={tdStyleRight}>
        <CellInput
          value={width}
          onChange={(v) => {
            setWidth(v);
            bump();
          }}
          type="number"
          width={70}
          align="right"
        />
      </td>
      <td style={tdStyleRight}>
        <CellInput
          value={height}
          onChange={(v) => {
            setHeight(v);
            bump();
          }}
          type="number"
          width={70}
          align="right"
        />
      </td>
      <td style={tdStyleRight}>
        <CellInput
          value={baseWeight}
          onChange={(v) => {
            setBaseWeight(v);
            bump();
          }}
          type="number"
          width={70}
          align="right"
        />
      </td>
      <td style={tdStyle}>
        <CellSelect
          value={service}
          onChange={(v) => {
            setService(v);
            bump();
          }}
          options={['large_envelope_or_flat', 'package']}
        />
      </td>
      <td style={tdStyle}>
        <button
          disabled={!dirty}
          onClick={() =>
            onSave(typeId, { name, length, width, height, baseWeight, service })
          }
          style={smallButton(dirty ? '#4a7fc1' : 'transparent', !dirty)}
        >
          Save
        </button>
      </td>
    </tr>
  );
}

// ─── Section 3: Routing rules ──────────────────────────────

function RoutingRulesSection({ config, onSave }) {
  // Phase 66: forcePackageSKUs retired — "force Package service" is driven by
  // the per-SKU category dropdown (rigid/bulky/pano) in the Product weights
  // section. No standalone field here anymore.
  const [boxRouteSKUs, setBoxRouteSKUs] = useState(
    (config.boxRouteSKUs || []).join(', ')
  );
  const [framedPanoSmallSKUs, setFramedPanoSmallSKUs] = useState(
    (config.framedPanoSmallSKUs || []).join(', ')
  );
  const [framedPanoLargeSKUs, setFramedPanoLargeSKUs] = useState(
    (config.framedPanoLargeSKUs || []).join(', ')
  );
  const [magnetSkus, setMagnetSkus] = useState(
    (config.magnetThreshold?.skus || []).join(', ')
  );
  const [magnetThreshold, setMagnetThreshold] = useState(
    String(config.magnetThreshold?.threshold ?? 3)
  );
  const [packingSlipWeightOz, setPackingSlipWeightOz] = useState(
    String(config.packingSlipWeightOz ?? 0.4)
  );
  const [packingSlipPosition, setPackingSlipPosition] = useState(
    config.packingSlipPosition || 'first'
  );
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setBoxRouteSKUs((config.boxRouteSKUs || []).join(', '));
    setFramedPanoSmallSKUs((config.framedPanoSmallSKUs || []).join(', '));
    setFramedPanoLargeSKUs((config.framedPanoLargeSKUs || []).join(', '));
    setMagnetSkus((config.magnetThreshold?.skus || []).join(', '));
    setMagnetThreshold(String(config.magnetThreshold?.threshold ?? 3));
    setPackingSlipWeightOz(String(config.packingSlipWeightOz ?? 0.4));
    setPackingSlipPosition(config.packingSlipPosition || 'first');
    setDirty(false);
    // Re-init when config arrives from server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config.boxRouteSKUs,
    config.framedPanoSmallSKUs,
    config.framedPanoLargeSKUs,
    config.magnetThreshold,
    config.packingSlipWeightOz,
    config.packingSlipPosition,
  ]);

  function parseCsv(s) {
    return s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  function handleSave() {
    onSave({
      boxRouteSKUs: parseCsv(boxRouteSKUs),
      framedPanoSmallSKUs: parseCsv(framedPanoSmallSKUs),
      framedPanoLargeSKUs: parseCsv(framedPanoLargeSKUs),
      magnetThreshold: {
        skus: parseCsv(magnetSkus),
        threshold: parseInt(magnetThreshold, 10) || 0,
      },
      packingSlipWeightOz: parseFloat(packingSlipWeightOz) || 0,
      packingSlipPosition,
    });
    setDirty(false);
  }

  function bump(setter) {
    return (v) => {
      setter(v);
      setDirty(true);
    };
  }

  return (
    <Section
      title="Routing rules"
      description="Lists of SKUs that trigger specific routing behaviors. Enter SKUs as comma-separated lists."
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 16,
        }}
      >
        <FieldGroup
          label="Force Package service"
          hint="Retired as a SKU list. An item ships as Package automatically when its category (in Product weights above) is rigid, bulky, or pano. Edit the SKU's category to change this."
        >
          <div style={{ fontSize: 13, color: '#666', padding: '8px 0' }}>
            Driven by per-SKU <strong>category</strong> (rigid / bulky / pano).
          </div>
        </FieldGroup>

        <FieldGroup
          label="boxRouteSKUs"
          hint="SKUs that need a box (in addition to legacy plaques 21/22). 1 rigid → medium box, 2+ → large box."
        >
          <CellInput
            value={boxRouteSKUs}
            onChange={bump(setBoxRouteSKUs)}
            placeholder="e.g. 40, 41"
            width="100%"
          />
        </FieldGroup>

        <FieldGroup
          label="framedPanoSmallSKUs"
          hint="Routes order to the 8×24 pano frame box (priority 2 rule)."
        >
          <CellInput
            value={framedPanoSmallSKUs}
            onChange={bump(setFramedPanoSmallSKUs)}
            placeholder="e.g. 34"
            width="100%"
          />
        </FieldGroup>

        <FieldGroup
          label="framedPanoLargeSKUs"
          hint="Routes order to the 10×30 pano frame box (priority 1 rule, highest)."
        >
          <CellInput
            value={framedPanoLargeSKUs}
            onChange={bump(setFramedPanoLargeSKUs)}
            placeholder="e.g. 37"
            width="100%"
          />
        </FieldGroup>

        <FieldGroup
          label="Magnet threshold SKUs"
          hint="The set of SKUs whose combined quantity is compared to the threshold."
        >
          <CellInput
            value={magnetSkus}
            onChange={bump(setMagnetSkus)}
            placeholder="15"
            width="100%"
          />
        </FieldGroup>

        <FieldGroup
          label="Magnet threshold count"
          hint="When combined quantity of the above reaches this, route to flat-as-package."
        >
          <CellInput
            value={magnetThreshold}
            onChange={bump(setMagnetThreshold)}
            type="number"
            placeholder="3"
            width={100}
          />
        </FieldGroup>

        <FieldGroup
          label="Packing slip weight (oz)"
          hint="Added to every order's total. Typical 250gsm photo paper ≈ 0.4oz."
        >
          <CellInput
            value={packingSlipWeightOz}
            onChange={bump(setPackingSlipWeightOz)}
            type="number"
            placeholder="0.4"
            width={100}
          />
        </FieldGroup>

        <FieldGroup
          label="Packing slip position"
          hint="Where the slip prints in the Darkroom .txt (first or last)."
        >
          <CellSelect
            value={packingSlipPosition}
            onChange={bump(setPackingSlipPosition)}
            options={['first', 'last']}
          />
        </FieldGroup>
      </div>

      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty}
          style={{
            padding: '8px 16px',
            background: dirty ? '#4a7fc1' : 'transparent',
            border: '1px solid ' + (dirty ? '#4a7fc1' : 'var(--border-color)'),
            color: dirty ? '#fff' : 'var(--text-muted)',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: dirty ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >
          {dirty ? 'Save routing rules' : 'Saved'}
        </button>
      </div>
    </Section>
  );
}

// ─── Section 4: Package bundles ────────────────────────────

function PackageBundlesSection({ packageBundles, onSave, onDelete }) {
  const skus = Object.keys(packageBundles).sort();

  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newWeight, setNewWeight] = useState('');
  const [newForcePackage, setNewForcePackage] = useState(false);

  async function handleAdd() {
    if (!newSku.trim()) return;
    await onSave(newSku.trim(), {
      name: newName.trim(),
      weight: parseFloat(newWeight) || 0,
      forcePackage: newForcePackage,
    });
    setNewSku('');
    setNewName('');
    setNewWeight('');
    setNewForcePackage(false);
  }

  return (
    <Section
      title="Package bundles"
      description="Gold/Silver/Bronze package SKUs that ship as a single line item with a single photo."
    >
      <div
        style={{
          marginBottom: 12,
          padding: '10px 12px',
          background: 'rgba(74,127,193,0.08)',
          border: '1px solid rgba(74,127,193,0.25)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>
          ℹ️ Bundles in Sytist are single line items.
        </strong>{' '}
        The bundle weight you enter here must represent the TOTAL weight
        of everything inside the package (Memory Mate + prints +
        wallets + magnets + etc.) — the engine has no way to look at
        the bundle's constituent items because they don't appear in
        the order as separate line items.
        <br />
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          Default weights are computed from each package's contents
          using the per-SKU weights above. If you change a per-SKU
          weight (e.g. bump Memory Mate from 0.5 to 0.6 oz), the
          bundle weights here won't update automatically — recompute
          and edit them manually.
        </span>
      </div>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>SKU</th>
            <th style={thStyle}>Name</th>
            <th style={thStyleRight}>Weight (oz)</th>
            <th style={thStyle}>Force Package</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {skus.map((sku) => (
            <PackageBundleRow
              key={sku}
              sku={sku}
              row={packageBundles[sku]}
              onSave={onSave}
              onDelete={onDelete}
            />
          ))}
          <tr style={{ background: 'rgba(74,127,193,0.05)' }}>
            <td style={tdStyle}>
              <CellInput
                value={newSku}
                onChange={setNewSku}
                placeholder="SKU"
                width={70}
              />
            </td>
            <td style={tdStyle}>
              <CellInput
                value={newName}
                onChange={setNewName}
                placeholder="Bundle name"
              />
            </td>
            <td style={tdStyleRight}>
              <CellInput
                value={newWeight}
                onChange={setNewWeight}
                type="number"
                width={70}
                align="right"
              />
            </td>
            <td style={tdStyle}>
              <input
                type="checkbox"
                checked={newForcePackage}
                onChange={(e) => setNewForcePackage(e.target.checked)}
              />
            </td>
            <td style={tdStyle}>
              <button
                onClick={handleAdd}
                disabled={!newSku.trim()}
                style={smallButton('#4a7fc1')}
              >
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

function PackageBundleRow({ sku, row, onSave, onDelete }) {
  const [name, setName] = useState(row.name || '');
  const [weight, setWeight] = useState(String(row.weight ?? ''));
  const [forcePackage, setForcePackage] = useState(!!row.forcePackage);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(row.name || '');
    setWeight(String(row.weight ?? ''));
    setForcePackage(!!row.forcePackage);
    setDirty(false);
  }, [row.name, row.weight, row.forcePackage]);

  function bump() {
    setDirty(true);
  }

  return (
    <tr>
      <td style={tdStyle}>
        <code>{sku}</code>
      </td>
      <td style={tdStyle}>
        <CellInput
          value={name}
          onChange={(v) => {
            setName(v);
            bump();
          }}
        />
      </td>
      <td style={tdStyleRight}>
        <CellInput
          value={weight}
          onChange={(v) => {
            setWeight(v);
            bump();
          }}
          type="number"
          width={70}
          align="right"
        />
      </td>
      <td style={tdStyle}>
        <input
          type="checkbox"
          checked={forcePackage}
          onChange={(e) => {
            setForcePackage(e.target.checked);
            bump();
          }}
        />
      </td>
      <td style={tdStyle}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            disabled={!dirty}
            onClick={() => onSave(sku, { name, weight, forcePackage })}
            style={smallButton(dirty ? '#4a7fc1' : 'transparent', !dirty)}
          >
            Save
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Delete bundle SKU ${sku}?`)) {
                onDelete(sku);
              }
            }}
            style={smallButton('transparent', false, true)}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Section 5: Test calculator ────────────────────────────

function TestCalculatorSection() {
  const [orderId, setOrderId] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function runPreview(e) {
    if (e?.preventDefault) e.preventDefault();
    if (!orderId.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.get(
        `/api/shipstation/packaging/preview/${encodeURIComponent(
          orderId.trim()
        )}`
      );
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      runPreview(e);
    }
  }

  return (
    <Section
      title="Test calculator"
      description="Paste a Sytist order ID to see exactly what the engine would do without sending anything to ShipStation."
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 240px' }}>
          <CellInput
            value={orderId}
            onChange={setOrderId}
            placeholder="Order ID (e.g. 110633)"
            onKeyDown={handleKeyDown}
            width="100%"
          />
        </div>
        <button
          onClick={runPreview}
          disabled={loading || !orderId.trim()}
          style={smallButton('#4a7fc1', loading || !orderId.trim())}
        >
          {loading ? 'Calculating…' : 'Run preview'}
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 12 }}>
          <StatusBanner kind="error" message={error} />
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <PreviewResult result={result} />
        </div>
      )}
    </Section>
  );
}

function PreviewResult({ result }) {
  const summary = result.orderSummary || {};
  const pkg = result.packaging;

  return (
    <div
      style={{
        padding: 16,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 12,
          lineHeight: 1.6,
        }}
      >
        Order {summary.orderNumber || result.orderId}{' '}
        {summary.customer && <>· customer: {summary.customer}</>}{' '}
        {summary.city && (
          <>
            · ships to: {summary.city}, {summary.state}
          </>
        )}
        {summary.workflow && (
          <>
            {' · '}
            <code>{summary.workflow}</code>
          </>
        )}
      </div>

      {!result.ok ? (
        <div style={{ color: '#dc3545' }}>
          {result.error || 'Engine returned no result'}
        </div>
      ) : (
        <>
          <table
            style={{
              fontSize: 13,
              width: '100%',
              borderCollapse: 'collapse',
              marginBottom: 12,
            }}
          >
            <tbody>
              <ResultRow label="Package type">
                {pkg.packageTypeName} <code>({pkg.packageType})</code>
              </ResultRow>
              <ResultRow label="Dimensions">
                {pkg.dimensions.length} × {pkg.dimensions.width} ×{' '}
                {pkg.dimensions.height} {pkg.dimensions.units}
              </ResultRow>
              <ResultRow label="Weight">
                {pkg.weight.value} {pkg.weight.units}
              </ResultRow>
              <ResultRow label="Carrier">
                <code>{pkg.carrierCode}</code>
              </ResultRow>
              <ResultRow label="Service">
                <code>{pkg.serviceCode}</code>
              </ResultRow>
              <ResultRow label="Package code">
                <code>{pkg.packageCode}</code>
              </ResultRow>
              <ResultRow label="Shippable items">
                {result.shippableCount}
                {result.skipped?.length > 0 &&
                  ` (${result.skipped.length} skipped)`}
              </ResultRow>
            </tbody>
          </table>

          {/* Phase 13b hotfix #2: weight breakdown panel. The headline
              "Weight" row above shows the FINAL number that goes to
              ShipStation. This panel decomposes it so you can pin down
              exactly which SKU or packaging type drove the discrepancy
              when a real-world scale weight disagrees with the engine. */}
          {pkg.weightBreakdown && (
            <WeightBreakdownPanel breakdown={pkg.weightBreakdown} />
          )}

          {pkg.notes?.length > 0 && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                marginBottom: 12,
              }}
            >
              <strong style={{ color: 'var(--text-secondary)' }}>
                Why this routing:
              </strong>
              <ul style={{ marginTop: 4, paddingLeft: 20 }}>
                {pkg.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          {pkg.itemWeights?.length > 0 && (
            <details>
              <summary
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                }}
              >
                Per-item weights ({pkg.itemWeights.length})
              </summary>
              <table
                style={{
                  fontSize: 12,
                  marginTop: 8,
                  borderCollapse: 'collapse',
                }}
              >
                <thead>
                  <tr>
                    <th style={thStyle}>Cart ID</th>
                    <th style={thStyle}>SKU</th>
                    <th style={thStyleRight}>Weight (oz)</th>
                  </tr>
                </thead>
                <tbody>
                  {pkg.itemWeights.map((iw, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>
                        <code>{iw.lineItemKey}</code>
                      </td>
                      <td style={tdStyle}>
                        <code>{iw.sku}</code>
                      </td>
                      <td style={tdStyleRight}>{iw.weightOz}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function WeightBreakdownPanel({ breakdown }) {
  const wb = breakdown;
  const hasFallback = wb.items.some((i) => i.source === 'fallback');

  // Same number formatter as the server-side _fmt, kept tiny.
  const fmt = (n) =>
    Number(n).toFixed(2).replace(/\.?0+$/, '');

  return (
    <div
      style={{
        marginBottom: 12,
        padding: 12,
        background: 'rgba(74,127,193,0.05)',
        border: '1px solid rgba(74,127,193,0.25)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginBottom: 8,
        }}
      >
        Weight breakdown
        {hasFallback && (
          <span
            style={{
              fontWeight: 500,
              marginLeft: 8,
              color: '#dc7700',
              fontSize: 11,
            }}
          >
            ⚠️ At least one SKU has no config — defaulted to 1oz
          </span>
        )}
      </div>

      {/* Items table */}
      <table
        style={{
          width: '100%',
          fontSize: 12,
          borderCollapse: 'collapse',
          marginBottom: 8,
        }}
      >
        <thead>
          <tr>
            <th style={breakdownThStyle}>SKU</th>
            <th style={breakdownThStyle}>Name</th>
            <th style={breakdownThRight}>Qty</th>
            <th style={breakdownThRight}>Unit oz</th>
            <th style={breakdownThRight}>Line oz</th>
            <th style={breakdownThStyle}>Source</th>
          </tr>
        </thead>
        <tbody>
          {wb.items.length === 0 ? (
            <tr>
              <td
                colSpan={6}
                style={{
                  ...breakdownTdStyle,
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}
              >
                No shippable items
              </td>
            </tr>
          ) : (
            wb.items.map((it, i) => (
              <tr key={i}>
                <td style={breakdownTdStyle}>
                  <code>{it.sku}</code>
                </td>
                <td style={breakdownTdStyle}>{it.name}</td>
                <td style={breakdownTdRight}>{it.qty}</td>
                <td style={breakdownTdRight}>{fmt(it.unitWeightOz)}</td>
                <td style={breakdownTdRight}>{fmt(it.lineWeightOz)}</td>
                <td style={breakdownTdStyle}>
                  {it.source === 'fallback' ? (
                    <span
                      style={{ color: '#dc7700', fontSize: 11 }}
                      title="No SKU config found — engine defaulted to 1oz. Add this SKU to Product weights above to fix."
                    >
                      ⚠️ fallback
                    </span>
                  ) : (
                    <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {it.source}
                    </code>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Summary math */}
      <table
        style={{
          width: '100%',
          fontSize: 12,
          borderCollapse: 'collapse',
        }}
      >
        <tbody>
          <BreakdownSumRow
            label="Items subtotal"
            value={fmt(wb.itemsSubtotalOz)}
            sign=""
          />
          {wb.packingSlipOz > 0 && (
            <BreakdownSumRow
              label="Packing slip"
              value={fmt(wb.packingSlipOz)}
              sign="+"
            />
          )}
          {wb.packagingTypeName && (
            <BreakdownSumRow
              label={`Packaging (${wb.packagingTypeName})`}
              value={fmt(wb.packagingBaseWeightOz)}
              sign="+"
            />
          )}
          <BreakdownSumRow
            label="Pre-ceiling total"
            value={fmt(wb.preCeilingOz)}
            sign="="
            emphasize
          />
          {wb.ceilingRemainderOz > 0.001 && (
            <BreakdownSumRow
              label="Ceiling rounding"
              value={fmt(wb.ceilingRemainderOz)}
              sign="+"
            />
          )}
          <BreakdownSumRow
            label="FINAL"
            value={wb.finalOz}
            sign="="
            unit="oz"
            final
          />
        </tbody>
      </table>

      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        To compare against a scale weight: weigh the assembled,
        sealed package. If the scale says something different than
        FINAL above, identify which row of the breakdown is wrong
        and edit it via{' '}
        {wb.items.some((i) => i.source === 'productWeights')
          ? 'Product weights'
          : 'Package bundles'}
        {' '}or Packaging types above.
      </div>
    </div>
  );
}

function BreakdownSumRow({ label, value, sign, unit, emphasize, final }) {
  return (
    <tr
      style={{
        borderTop: emphasize || final ? '1px solid var(--border-color)' : 'none',
      }}
    >
      <td
        style={{
          padding: '3px 12px 3px 0',
          color: final
            ? 'var(--text-primary)'
            : emphasize
            ? 'var(--text-secondary)'
            : 'var(--text-muted)',
          fontWeight: final ? 600 : emphasize ? 500 : 400,
        }}
      >
        {label}
      </td>
      <td
        style={{
          padding: '3px 0',
          width: 30,
          textAlign: 'right',
          color: 'var(--text-muted)',
        }}
      >
        {sign}
      </td>
      <td
        style={{
          padding: '3px 0 3px 4px',
          textAlign: 'right',
          width: 80,
          color: final ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: final ? 600 : 400,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value} {unit && <span style={{ color: 'var(--text-muted)' }}>{unit}</span>}
      </td>
    </tr>
  );
}

const breakdownThStyle = {
  textAlign: 'left',
  padding: '4px 8px 4px 0',
  fontSize: 10,
  fontWeight: 500,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  borderBottom: '1px solid var(--border-color)',
};
const breakdownThRight = { ...breakdownThStyle, textAlign: 'right' };
const breakdownTdStyle = {
  padding: '4px 8px 4px 0',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};
const breakdownTdRight = {
  ...breakdownTdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

function ResultRow({ label, children }) {
  return (
    <tr>
      <td
        style={{
          padding: '4px 12px 4px 0',
          color: 'var(--text-muted)',
          width: 140,
          verticalAlign: 'top',
        }}
      >
        {label}
      </td>
      <td style={{ padding: '4px 0', verticalAlign: 'top' }}>{children}</td>
    </tr>
  );
}

// ─── shared primitives ─────────────────────────────────────

function FieldGroup({ label, hint, children }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function CellInput({
  value,
  onChange,
  type = 'text',
  placeholder,
  width,
  align,
  onKeyDown,
}) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      style={{
        width: width || 140,
        padding: '5px 8px',
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        color: 'var(--text-primary)',
        fontSize: 13,
        fontFamily: 'inherit',
        textAlign: align || 'left',
      }}
    />
  );
}

function CellSelect({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '5px 8px',
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        color: 'var(--text-primary)',
        fontSize: 13,
        fontFamily: 'inherit',
      }}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};
const thStyle = {
  textAlign: 'left',
  padding: '8px 8px',
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  borderBottom: '1px solid var(--border-color)',
};
const thStyleRight = { ...thStyle, textAlign: 'right' };
const tdStyle = {
  padding: '6px 8px',
  borderBottom: '1px solid var(--border-color)',
  verticalAlign: 'middle',
};
const tdStyleRight = { ...tdStyle, textAlign: 'right' };

function smallButton(bg, disabled, danger) {
  return {
    padding: '5px 10px',
    background: disabled ? 'transparent' : bg,
    border:
      '1px solid ' +
      (danger
        ? 'rgba(220,53,69,0.4)'
        : disabled
        ? 'var(--border-color)'
        : bg),
    color: danger
      ? '#dc3545'
      : disabled
      ? 'var(--text-muted)'
      : bg === 'transparent'
      ? 'var(--text-secondary)'
      : '#fff',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
  };
}

const retryButtonStyle = {
  padding: '8px 16px',
  background: 'transparent',
  border: '1px solid var(--border-color)',
  color: 'var(--text-secondary)',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
  marginTop: 12,
};
