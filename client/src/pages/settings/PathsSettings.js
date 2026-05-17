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
} from '../../components/SettingsForm';

const KNOWN_TOKENS = [
  { token: '{date}', description: "Order date in YYYY-MM-DD" },
  { token: '{orderId}', description: "Sytist order ID" },
  { token: '{gallery}', description: "Gallery name (sanitized)" },
  { token: '{subGallery}', description: "Sub-gallery / team name (sanitized)" },
  { token: '{workflow}', description: "ship_to_home / ship_to_managers / ship_to_league" },
];

const OUTPUT_TYPE_LABELS = {
  downloadBase: 'Download base',
  darkroomTxtBase: 'Darkroom .txt base',
  packingSlipBase: 'Packing slip base',
  impositionBase: 'Imposition base',
  darkroomTemplateBase: 'Darkroom template base (input)',
};

export default function PathsSettings() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [savingMode, setSavingMode] = useState(false);
  const [pendingTemplates, setPendingTemplates] = useState({}); // { test: { downloadBase: '...' }, production: { ... } }
  const [savingKey, setSavingKey] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/api/sytist/paths/config/full');
      setConfig(data);
      setPendingTemplates({});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function getTemplate(mode, outputType) {
    const pending = pendingTemplates[mode]?.[outputType];
    if (pending !== undefined) return pending;
    return config.modes[mode]?.[outputType] || '';
  }

  function setTemplate(mode, outputType, value) {
    setPendingTemplates((prev) => ({
      ...prev,
      [mode]: { ...(prev[mode] || {}), [outputType]: value },
    }));
  }

  function isDirty(mode, outputType) {
    const pending = pendingTemplates[mode]?.[outputType];
    return pending !== undefined && pending !== config.modes[mode]?.[outputType];
  }

  async function handleSaveTemplate(mode, outputType) {
    const newValue = pendingTemplates[mode]?.[outputType];
    if (newValue === undefined) return;
    const key = `${mode}.${outputType}`;
    setSavingKey(key);
    setStatus(null);
    try {
      await api.put(`/api/sytist/paths/templates/${mode}/${outputType}`, {
        template: newValue,
      });
      setStatus({ kind: 'success', message: `Saved ${mode}.${outputType}` });
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setSavingKey(null);
    }
  }

  async function handleModeSwitch(newMode) {
    if (newMode === config.mode) return;

    if (newMode === 'production') {
      const ok = window.confirm(
        'Switch path mode to PRODUCTION?\n\n' +
          'Files will start landing on the live Z: share instead of the test sandbox. ' +
          'Make sure Phase 4 is fully verified before doing this.\n\n' +
          'Click OK to proceed, or Cancel to abort.'
      );
      if (!ok) return;
    }

    setSavingMode(true);
    setStatus(null);
    try {
      await api.put('/api/sytist/paths/mode', { mode: newMode });
      setStatus({ kind: 'success', message: `Mode switched to ${newMode}` });
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: `Mode switch failed: ${err.message}` });
    } finally {
      setSavingMode(false);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Paths" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Paths" />
        <StatusBanner kind="error" message={error} />
      </div>
    );
  }
  if (!config) return null;

  const modeNames = Object.keys(config.modes || {});

  return (
    <div>
      <PageHeader
        title="Paths"
        subtitle="Output path templates and the active mode. Tokens like {date} and {orderId} are substituted per-order at resolution time."
      />

      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}

      {/* Phase 51: cross-reference so operators don't assume specialty
          output follows downloadBase. The two roots are independent —
          see CLAUDE.md "Output path configuration". */}
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          fontStyle: 'italic',
          marginBottom: 16,
          paddingLeft: 2,
        }}
      >
        Specialty product output is configured separately and does not
        follow these templates. See{' '}
        <strong>Settings → Specialty → Base path</strong>.
      </div>

      <Section
        title="Active mode"
        description="The mode determines whether files land in the test sandbox or on the production share. Switching to production requires confirmation."
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}
        >
          <ModeChip mode={config.mode} />
          <div style={{ display: 'flex', gap: 8 }}>
            {modeNames.map((m) => (
              <Button
                key={m}
                variant={m === config.mode ? 'primary' : 'secondary'}
                disabled={savingMode || m === config.mode}
                onClick={() => handleModeSwitch(m)}
              >
                Switch to {m}
              </Button>
            ))}
          </div>
        </div>
      </Section>

      <PreflightSection modes={modeNames} currentMode={config.mode} />

      {modeNames.map((mode) => (
        <Section
          key={mode}
          title={`${mode} templates`}
          description={
            mode === config.mode
              ? "These templates are currently in use."
              : `Inactive — these templates are persisted but only kick in if you switch to "${mode}".`
          }
        >
          {(config.outputTypes || []).map((ot) => {
            const isTemplate = ot.endsWith('TemplateBase');
            const dirty = isDirty(mode, ot);
            const saving = savingKey === `${mode}.${ot}`;
            return (
              <FormRow
                key={ot}
                label={
                  <>
                    {OUTPUT_TYPE_LABELS[ot] || ot}{' '}
                    <span
                      style={{
                        fontFamily: 'var(--font-mono, monospace)',
                        fontWeight: 400,
                        color: 'var(--text-muted)',
                        fontSize: 11,
                      }}
                    >
                      ({ot})
                    </span>
                  </>
                }
                hint={isTemplate ? 'Input path — folder-sort segments are not appended here.' : undefined}
              >
                <div style={{ display: 'flex', gap: 8 }}>
                  <TextInput
                    monospace
                    value={getTemplate(mode, ot)}
                    onChange={(v) => setTemplate(mode, ot, v)}
                  />
                  <Button
                    variant="primary"
                    disabled={!dirty || saving}
                    onClick={() => handleSaveTemplate(mode, ot)}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </FormRow>
            );
          })}
        </Section>
      ))}

      <Section title="Tokens">
        <TokenList tokens={KNOWN_TOKENS} />
      </Section>
    </div>
  );
}

function ModeChip({ mode }) {
  const isProd = mode === 'production';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '4px 12px',
        borderRadius: 12,
        background: isProd ? 'rgba(76,175,80,0.15)' : 'rgba(224,179,65,0.15)',
        color: isProd ? '#4caf50' : '#e0b341',
        border: `1px solid ${isProd ? 'rgba(76,175,80,0.4)' : 'rgba(224,179,65,0.4)'}`,
        textTransform: 'uppercase',
        letterSpacing: 0.8,
      }}
    >
      {mode}
    </span>
  );
}

/**
 * Phase 4.7 — pre-flight check section. Lets the operator verify that
 * the production paths are reachable and writable BEFORE flipping
 * modes. Each output type is tested with mkdir + write + read + delete.
 *
 * Defaults to the OPPOSITE of the current mode (because that's what the
 * operator is most likely about to switch to). Both modes are still
 * available via the dropdown.
 */
function PreflightSection({ modes, currentMode }) {
  // Default target = the mode you're NOT in
  const initialTarget = modes.find((m) => m !== currentMode) || currentMode;
  const [targetMode, setTargetMode] = useState(initialTarget);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleRun() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.post('/api/sytist/paths/preflight', { mode: targetMode });
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Section
      title="Pre-flight check"
      description="Verify write access for the resolved paths under the target mode. Tests mkdir + write + read + delete on a marker file. Run this before switching to production."
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <FormRow label="Target mode">
          <select
            value={targetMode}
            onChange={(e) => {
              setTargetMode(e.target.value);
              setResult(null);
              setError(null);
            }}
            style={{
              padding: '8px 10px',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              color: 'var(--text-primary)',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          >
            {modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </FormRow>
        <Button variant="primary" onClick={handleRun} disabled={running}>
          {running ? 'Running checks…' : `Run pre-flight on ${targetMode}`}
        </Button>
      </div>

      {error && <StatusBanner kind="error" message={error} />}

      {result && (
        <div>
          <div
            style={{
              padding: 10,
              marginBottom: 12,
              background: result.allOk
                ? 'rgba(76,175,80,0.08)'
                : 'rgba(220,53,69,0.08)',
              border: `1px solid ${
                result.allOk ? 'rgba(76,175,80,0.3)' : 'rgba(220,53,69,0.3)'
              }`,
              borderRadius: 6,
              fontSize: 13,
              color: result.allOk ? '#4caf50' : '#dc3545',
              fontWeight: 600,
            }}
          >
            {result.allOk
              ? `✓ All paths writable for "${result.mode}" mode`
              : `✗ Some paths failed for "${result.mode}" mode — fix before switching`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {result.checks.map((c) => (
              <div
                key={c.outputType}
                style={{
                  padding: 10,
                  background: c.ok
                    ? 'rgba(76,175,80,0.05)'
                    : 'rgba(220,53,69,0.08)',
                  border: `1px solid ${
                    c.ok ? 'rgba(76,175,80,0.2)' : 'rgba(220,53,69,0.3)'
                  }`,
                  borderRadius: 4,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    {c.ok ? '✓' : '✗'} {c.outputType}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: c.ok ? '#4caf50' : '#dc3545',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      fontWeight: 600,
                    }}
                  >
                    {c.ok ? 'OK' : 'FAILED'}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--font-mono, monospace)',
                    color: 'var(--text-muted)',
                    wordBreak: 'break-all',
                    marginBottom: 6,
                  }}
                >
                  {c.resolvedPath || c.template}
                </div>
                {!c.ok && c.error && (
                  <div
                    style={{
                      fontSize: 11,
                      color: '#dc3545',
                      padding: 6,
                      background: 'rgba(220,53,69,0.05)',
                      border: '1px solid rgba(220,53,69,0.2)',
                      borderRadius: 3,
                    }}
                  >
                    {c.error}
                  </div>
                )}
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    marginTop: 4,
                  }}
                >
                  {(c.steps || []).map((s, i) => (
                    <span
                      key={i}
                      style={{
                        padding: '2px 6px',
                        borderRadius: 3,
                        background: s.ok
                          ? 'rgba(76,175,80,0.1)'
                          : 'rgba(220,53,69,0.1)',
                        color: s.ok ? '#4caf50' : '#dc3545',
                      }}
                    >
                      {s.ok ? '✓' : '✗'} {s.step}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
