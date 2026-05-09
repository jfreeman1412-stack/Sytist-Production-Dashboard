import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  Button,
  StatusBanner,
} from '../../components/SettingsForm';

/**
 * Folder sort: shows the configured order of sort levels (gallery → team
 * etc.) and lets admins reorder, add, and remove them.
 *
 * 'no_sort' is a special case — when chosen it must be the only level.
 * The UI surfaces this as a separate toggle to avoid the "no_sort cannot
 * be combined with others" error path.
 */
export default function FolderSortSettings() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  // Local edit state — committed to server on Save.
  const [pendingLevels, setPendingLevels] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/api/sytist/paths/config');
      setConfig(data);
      setPendingLevels(data.folderSort.currentLevels || ['no_sort']);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await api.put('/api/sytist/paths/folder-sort', { sortLevels: pendingLevels });
      setStatus({ kind: 'success', message: 'Folder sort updated' });
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  function isDirty() {
    if (!config) return false;
    const current = config.folderSort.currentLevels || [];
    if (current.length !== pendingLevels.length) return true;
    return current.some((v, i) => v !== pendingLevels[i]);
  }

  function setNoSort() {
    setPendingLevels(['no_sort']);
  }

  function addLevel(id) {
    if (pendingLevels.includes(id)) return;
    if (pendingLevels.includes('no_sort')) {
      // Replacing no_sort with this level
      setPendingLevels([id]);
      return;
    }
    setPendingLevels([...pendingLevels, id]);
  }

  function removeLevel(id) {
    const filtered = pendingLevels.filter((l) => l !== id);
    if (filtered.length === 0) {
      setPendingLevels(['no_sort']);
      return;
    }
    setPendingLevels(filtered);
  }

  function moveLevel(idx, direction) {
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= pendingLevels.length) return;
    const next = [...pendingLevels];
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    setPendingLevels(next);
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="Folder Sort" />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <PageHeader title="Folder Sort" />
        <StatusBanner kind="error" message={error} />
      </div>
    );
  }
  if (!config) return null;

  const allOptions = config.folderSort.availableOptions || [];
  const isNoSort = pendingLevels.length === 1 && pendingLevels[0] === 'no_sort';
  const dirty = isDirty();

  return (
    <div>
      <PageHeader
        title="Folder Sort"
        subtitle="Sub-folder layout under each output base. Files are filed into folders matching these levels in order."
        actions={
          <>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
            </Button>
          </>
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
        title="Active configuration"
        description={
          isNoSort
            ? "All files land flat in the base output folder — no sub-folders."
            : `Files filed into: ${pendingLevels.map((l) => allOptions.find((o) => o.id === l)?.label || l).join(' › ')}`
        }
        actions={
          <Button
            variant={isNoSort ? 'primary' : 'ghost'}
            onClick={setNoSort}
            disabled={isNoSort}
          >
            {isNoSort ? '✓ No Sort' : 'Use No Sort'}
          </Button>
        }
      >
        {!isNoSort && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pendingLevels.map((id, idx) => {
              const opt = allOptions.find((o) => o.id === id);
              return (
                <div
                  key={id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 14px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      width: 20,
                    }}
                  >
                    {idx + 1}.
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {opt?.label || id}
                    </div>
                    {opt?.description && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {opt.description}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Button
                      variant="ghost"
                      onClick={() => moveLevel(idx, -1)}
                      disabled={idx === 0}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => moveLevel(idx, 1)}
                      disabled={idx === pendingLevels.length - 1}
                    >
                      ↓
                    </Button>
                    <Button variant="danger" onClick={() => removeLevel(id)}>
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {!isNoSort && (
        <Section
          title="Add a level"
          description="Click to append to the active configuration."
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {allOptions
              .filter((opt) => opt.id !== 'no_sort' && !pendingLevels.includes(opt.id))
              .map((opt) => (
                <Button key={opt.id} onClick={() => addLevel(opt.id)}>
                  + {opt.label}
                </Button>
              ))}
            {allOptions.filter((opt) => opt.id !== 'no_sort' && !pendingLevels.includes(opt.id)).length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                All available levels are already in use.
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
