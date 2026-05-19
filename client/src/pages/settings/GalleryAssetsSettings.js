import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../services/api';
import {
  PageHeader,
  Section,
  FormRow,
  TextInput,
  Select,
  Button,
  StatusBanner,
  NumberInput,
  settingsStyles,
} from '../../components/SettingsForm';

/**
 * Phase 8a — Gallery Assets settings page.
 *
 * Three independent sections:
 *
 *   1. Team Photo Lookup Tester — pick a gallery + sub-gallery, click
 *      "Look up", see what the team photo discovery would find. Used
 *      to verify the price-list filter is correct before we wire the
 *      composite engine into the orchestrator (Phase 8b).
 *
 *   2. Team Photo Settings — configurable price list ID (default 268).
 *
 *   3. Logo Uploader — pick a gallery, upload a logo, see the recorded
 *      asset. Logos live inside the app config dir (joey's requirement
 *      to avoid Z: share rename failures).
 */
export default function GalleryAssetsSettings() {
  const [galleries, setGalleries] = useState([]);
  const [galleriesLoading, setGalleriesLoading] = useState(true);
  const [globalStatus, setGlobalStatus] = useState(null);

  // Load gallery hierarchy on mount — used by both lookup tester and logo uploader.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get('/api/sytist/galleries');
        if (!cancelled) setGalleries(data.galleries || []);
      } catch (err) {
        if (!cancelled) {
          setGlobalStatus({
            kind: 'error',
            message: `Failed to load galleries: ${err.message}`,
          });
        }
      } finally {
        if (!cancelled) setGalleriesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <PageHeader
        title="Gallery Assets"
        subtitle="Logos, overlays, and team photo lookup configuration for memory-mate composites. Phase 8a delivers verification tools before the orchestrator is wired in."
      />
      {globalStatus && (
        <StatusBanner
          kind={globalStatus.kind}
          message={globalStatus.message}
          onDismiss={() => setGlobalStatus(null)}
        />
      )}

      <TeamPhotoLookupSection
        galleries={galleries}
        galleriesLoading={galleriesLoading}
      />

      <TeamPhotoSettingsSection />

      <LogosSection
        galleries={galleries}
        galleriesLoading={galleriesLoading}
      />
    </div>
  );
}

// ─── Team photo lookup tester ──────────────────────────────

function TeamPhotoLookupSection({ galleries, galleriesLoading }) {
  const [galleryId, setGalleryId] = useState('');
  const [subGalleryId, setSubGalleryId] = useState('');
  const [overrideListId, setOverrideListId] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Phase 8a-hotfix: sub-galleries fetched on-demand from a dedicated
  // endpoint (no order filter), since the team photo lookup needs to
  // work for galleries that haven't had orders yet. Earlier we tried
  // to read sub-galleries off the gallery hierarchy but that's filtered
  // by paid orders — wrong for verification.
  const [subGalleries, setSubGalleries] = useState([]);
  const [subGalleriesLoading, setSubGalleriesLoading] = useState(false);
  const [subGalleriesError, setSubGalleriesError] = useState(null);

  // Refetch sub-galleries whenever the gallery selection changes.
  useEffect(() => {
    if (!galleryId) {
      setSubGalleries([]);
      return;
    }
    let cancelled = false;
    setSubGalleriesLoading(true);
    setSubGalleriesError(null);
    api
      .get(`/api/sytist/galleries/${galleryId}/sub-galleries`)
      .then((data) => {
        if (!cancelled) {
          setSubGalleries(data.subGalleries || []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSubGalleriesError(err.message);
          setSubGalleries([]);
        }
      })
      .finally(() => {
        if (!cancelled) setSubGalleriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [galleryId]);

  async function handleLookup() {
    if (!subGalleryId) {
      setError('Pick a sub-gallery first');
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams();
      params.set('subGalleryId', subGalleryId);
      if (overrideListId) params.set('listId', overrideListId);
      const r = await api.get(
        `/api/sytist/team-photo/lookup?${params.toString()}`
      );
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Section
      title="Team Photo Lookup Tester"
      description="Verifies team photo discovery for a specific sub-gallery. Use this BEFORE wiring composites into the orchestrator — confirm the lookup returns the photo you expect for several galleries."
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 0.7fr auto',
          gap: 8,
          alignItems: 'end',
        }}
      >
        <FormRow label="Gallery">
          <Select
            value={galleryId}
            onChange={(v) => {
              setGalleryId(v);
              setSubGalleryId('');
              setResult(null);
              setError(null);
            }}
            disabled={galleriesLoading}
            options={[
              { value: '', label: galleriesLoading ? 'Loading…' : 'Select…' },
              ...galleries.map((g) => ({
                value: String(g.galleryId),
                label: g.galleryName,
              })),
            ]}
          />
        </FormRow>
        <FormRow
          label="Sub-gallery (team)"
          hint={
            galleryId
              ? subGalleriesLoading
                ? 'Loading sub-galleries…'
                : subGalleriesError
                ? `Error: ${subGalleriesError}`
                : `${subGalleries.length} sub-galler${subGalleries.length === 1 ? 'y' : 'ies'} in this gallery`
              : null
          }
        >
          <Select
            value={subGalleryId}
            onChange={(v) => {
              setSubGalleryId(v);
              setResult(null);
              setError(null);
            }}
            disabled={!galleryId || subGalleriesLoading}
            options={[
              {
                value: '',
                label: !galleryId
                  ? '(pick gallery first)'
                  : subGalleriesLoading
                  ? 'Loading…'
                  : subGalleries.length === 0
                  ? '(no sub-galleries in this gallery)'
                  : 'Select…',
              },
              ...subGalleries.map((s) => ({
                value: String(s.subGalleryId),
                label: s.subGalleryName,
              })),
            ]}
          />
        </FormRow>
        <FormRow label="Override list ID" hint="Defaults to settings value (268)">
          <TextInput
            value={overrideListId}
            onChange={setOverrideListId}
            placeholder="(optional)"
            monospace
          />
        </FormRow>
        <FormRow label="">
          <Button
            variant="primary"
            onClick={handleLookup}
            disabled={running || !subGalleryId}
          >
            {running ? 'Looking up…' : 'Look up'}
          </Button>
        </FormRow>
      </div>

      {error && <StatusBanner kind="error" message={error} onDismiss={() => setError(null)} />}

      {result && <LookupResultDisplay result={result} />}
    </Section>
  );
}

function LookupResultDisplay({ result }) {
  if (!result.found) {
    return (
      <div
        style={{
          marginTop: 16,
          padding: 12,
          background: 'rgba(220,53,69,0.08)',
          border: '1px solid rgba(220,53,69,0.3)',
          borderRadius: 6,
          fontSize: 13,
          color: '#dc3545',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          ✗ No team photo found
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Reason: <code>{result.reason}</code>
          {result.message && <span> — {result.message}</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          List ID used: {result.listIdUsed}
        </div>
      </div>
    );
  }

  const photo = result.photo;
  return (
    <div
      style={{
        marginTop: 16,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 16,
      }}
    >
      <div
        style={{
          width: 240,
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderRadius: 6,
          padding: 4,
        }}
      >
        {photo.thumbUrl || photo.fullUrl ? (
          <img
            src={photo.thumbUrl || photo.fullUrl}
            alt="Team photo"
            style={{
              width: '100%',
              display: 'block',
              borderRadius: 4,
            }}
          />
        ) : (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}
          >
            (no thumbnail URL available)
          </div>
        )}
      </div>
      <div style={{ fontSize: 12 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#4caf50',
            marginBottom: 8,
          }}
        >
          ✓ Team photo found
        </div>
        <DetailRow label="Filename" value={photo.originalFilename} mono />
        <DetailRow label="Photo ID" value={photo.photoId} mono />
        <DetailRow
          label="Dimensions"
          value={`${photo.width} × ${photo.height} (${photo.orientation})`}
        />
        <DetailRow label="Gallery ID" value={photo.galleryId} mono />
        <DetailRow label="Sub-gallery ID" value={photo.subGalleryId} mono />
        <DetailRow label="List ID used" value={result.listIdUsed} />
        {photo.fullUrl && (
          <div style={{ marginTop: 8 }}>
            <a
              href={photo.fullUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11,
                color: '#4a7fc1',
                textDecoration: 'none',
              }}
            >
              Open full-size →
            </a>
          </div>
        )}
        {result.warnings && result.warnings.length > 0 && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              background: 'rgba(224,179,65,0.1)',
              border: '1px solid rgba(224,179,65,0.3)',
              borderRadius: 4,
            }}
          >
            {result.warnings.map((w, i) => (
              <div
                key={i}
                style={{ fontSize: 11, color: '#e0b341', marginBottom: 2 }}
              >
                ⚠ {w.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 1fr',
        marginBottom: 3,
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}:</span>
      <span style={mono ? { fontFamily: 'var(--font-mono, monospace)' } : null}>
        {value === null || value === undefined ? '—' : String(value)}
      </span>
    </div>
  );
}

// ─── Team photo settings ──────────────────────────────────

function TeamPhotoSettingsSection() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listId, setListId] = useState('');
  const [warnPortrait, setWarnPortrait] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const s = await api.get('/api/sytist/team-photo/settings');
      setSettings(s);
      setListId(String(s.teamPhotoListId));
      setWarnPortrait(!!s.warnOnPortraitOrientation);
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const dirty =
    settings &&
    (String(settings.teamPhotoListId) !== listId ||
      !!settings.warnOnPortraitOrientation !== warnPortrait);

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await api.put('/api/sytist/team-photo/settings', {
        teamPhotoListId: listId === '' ? null : parseInt(listId, 10),
        warnOnPortraitOrientation: warnPortrait,
      });
      setStatus({ kind: 'success', message: 'Settings saved' });
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Section title="Team Photo Settings">
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      </Section>
    );
  }

  return (
    <Section
      title="Team Photo Settings"
      description="Sytist price list ID used to identify team photos. Default 268 — change only if your Sytist install uses a different list ID for team photos."
      actions={
        <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'No changes'}
        </Button>
      }
    >
      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <FormRow
          label="Team Photo List ID"
          hint="ms_photo_products_list.list_id — e.g. 268"
        >
          <TextInput value={listId} onChange={setListId} monospace />
        </FormRow>
        <FormRow
          label=""
          hint="Surface a warning if the matched team photo is portrait-oriented (composites expect horizontal)."
        >
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              cursor: 'pointer',
              padding: '8px 10px',
            }}
          >
            <input
              type="checkbox"
              checked={warnPortrait}
              onChange={(e) => setWarnPortrait(e.target.checked)}
            />
            Warn on portrait-oriented team photos
          </label>
        </FormRow>
      </div>
    </Section>
  );
}

// ─── Logo uploader ─────────────────────────────────────────

function LogosSection({ galleries, galleriesLoading }) {
  const [logos, setLogos] = useState({});
  const [loadingLogos, setLoadingLogos] = useState(true);
  const [galleryId, setGalleryId] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState(null);

  // Phase 58a: honour ?galleryId=<id> in the URL (e.g. from the orders-
  // list "Missing Logo" badge click) — preselect that gallery in the
  // uploader dropdown so the operator lands at the upload control for
  // that specific gallery instead of the empty default. Gated on
  // `galleryId === ''` so we only auto-apply while the dropdown is
  // still untouched; manual operator selection is never overridden.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (galleriesLoading || galleries.length === 0) return;
    if (galleryId !== '') return;
    const paramId = searchParams.get('galleryId');
    if (!paramId) return;
    const exists = galleries.some(
      (g) => String(g.galleryId) === String(paramId)
    );
    if (exists) setGalleryId(String(paramId));
  }, [galleries, galleriesLoading, searchParams, galleryId]);

  async function loadLogos() {
    setLoadingLogos(true);
    try {
      const r = await api.get('/api/sytist/gallery-assets/logos');
      setLogos(r.logos || {});
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    } finally {
      setLoadingLogos(false);
    }
  }

  useEffect(() => {
    loadLogos();
  }, []);

  async function handleUpload() {
    if (!galleryId || !file) return;
    setUploading(true);
    setStatus(null);
    try {
      const dataBase64 = await fileToBase64(file);
      await api.post(`/api/sytist/gallery-assets/logos/${galleryId}`, {
        filename: file.name,
        dataBase64,
      });
      setStatus({ kind: 'success', message: 'Logo uploaded' });
      setFile(null);
      await loadLogos();
    } catch (err) {
      setStatus({ kind: 'error', message: `Upload failed: ${err.message}` });
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(gid) {
    if (
      !window.confirm(
        `Delete logo for gallery ${gid}? The file will be removed from disk and the registry entry cleared.`
      )
    ) {
      return;
    }
    try {
      await api.del(`/api/sytist/gallery-assets/logos/${gid}`);
      setStatus({ kind: 'success', message: 'Logo deleted' });
      await loadLogos();
    } catch (err) {
      setStatus({ kind: 'error', message: `Delete failed: ${err.message}` });
    }
  }

  const galleriesWithLogos = Object.keys(logos);
  const galleriesWithoutLogos = galleries.filter(
    (g) => !logos[g.galleryId]
  );

  return (
    <Section
      title={`Gallery Logos (${galleriesWithLogos.length})`}
      description="Logos live inside the app config dir (server/config/gallery-assets/logos/) so they aren't vulnerable to file moves on the Z: share. Max 10MB per file. PNG, JPG, or WebP."
    >
      {status && (
        <StatusBanner
          kind={status.kind}
          message={status.message}
          onDismiss={() => setStatus(null)}
        />
      )}

      {/* Upload form */}
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
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: 'var(--text-muted)',
            marginBottom: 12,
          }}
        >
          Upload logo
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 2fr auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <FormRow label="Gallery">
            <Select
              value={galleryId}
              onChange={setGalleryId}
              disabled={galleriesLoading}
              options={[
                { value: '', label: galleriesLoading ? 'Loading…' : 'Select…' },
                ...galleries.map((g) => ({
                  value: String(g.galleryId),
                  label:
                    g.galleryName +
                    (logos[g.galleryId] ? ' (has logo — will replace)' : ''),
                })),
              ]}
            />
          </FormRow>
          <FormRow label="File">
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              style={{
                width: '100%',
                padding: 6,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                color: 'var(--text-primary)',
                fontSize: 12,
              }}
            />
          </FormRow>
          <FormRow label="">
            <Button
              variant="primary"
              onClick={handleUpload}
              disabled={uploading || !galleryId || !file}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </FormRow>
        </div>
      </div>

      {/* Logos table */}
      {loadingLogos ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : galleriesWithLogos.length === 0 ? (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 13,
          }}
        >
          No logos uploaded yet.
        </div>
      ) : (
        <table style={settingsStyles.table}>
          <thead>
            <tr>
              <th style={{ ...settingsStyles.th, width: 100 }}>Preview</th>
              <th style={settingsStyles.th}>Gallery</th>
              <th style={settingsStyles.th}>Filename</th>
              <th style={settingsStyles.th}>Uploaded</th>
              <th style={settingsStyles.th}>Size</th>
              <th style={{ ...settingsStyles.th, width: 100, textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {galleriesWithLogos.map((gid) => {
              const meta = logos[gid];
              const gallery = galleries.find(
                (g) => String(g.galleryId) === String(gid)
              );
              return (
                <tr key={gid}>
                  <td style={settingsStyles.td}>
                    <img
                      src={`/api/sytist/gallery-assets/logos/${gid}/preview?v=${encodeURIComponent(meta.uploadedAt)}`}
                      alt="logo"
                      style={{
                        width: 64,
                        height: 64,
                        objectFit: 'contain',
                        background: '#f0f0f0',
                        borderRadius: 4,
                      }}
                    />
                  </td>
                  <td style={settingsStyles.td}>
                    {gallery ? gallery.galleryName : `Gallery ${gid}`}
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono, monospace)',
                      }}
                    >
                      ID: {gid}
                    </div>
                  </td>
                  <td
                    style={{
                      ...settingsStyles.td,
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 11,
                    }}
                  >
                    {meta.logoFilename}
                  </td>
                  <td style={{ ...settingsStyles.td, fontSize: 11 }}>
                    {formatTime(meta.uploadedAt)}
                    {meta.uploadedBy && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                        by {meta.uploadedBy}
                      </div>
                    )}
                  </td>
                  <td style={{ ...settingsStyles.td, fontSize: 11 }}>
                    {formatBytes(meta.sizeBytes)}
                  </td>
                  <td style={{ ...settingsStyles.td, textAlign: 'right' }}>
                    <Button variant="danger" onClick={() => handleDelete(gid)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!loadingLogos && galleriesWithoutLogos.length > 0 && (
        <div
          style={{
            marginTop: 12,
            fontSize: 11,
            color: 'var(--text-muted)',
          }}
        >
          {galleriesWithoutLogos.length} galler
          {galleriesWithoutLogos.length === 1 ? 'y' : 'ies'} without a logo:{' '}
          {galleriesWithoutLogos
            .slice(0, 5)
            .map((g) => g.galleryName)
            .join(', ')}
          {galleriesWithoutLogos.length > 5 && ` (and ${galleriesWithoutLogos.length - 5} more)`}
        </div>
      )}
    </Section>
  );
}

// ─── helpers ─────────────────────────────────────────────

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      // Strip the "data:image/png;base64," prefix
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
