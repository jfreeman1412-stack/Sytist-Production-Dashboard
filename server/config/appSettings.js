// ─────────────────────────────────────────────────────────────
// appSettings.js — masked-secrets settings store
// ─────────────────────────────────────────────────────────────
//
// Phase 13a: ported from PhotoDay dashboard. Provides a UI-backed
// store for API credentials and other configurable values without
// requiring an .env edit + server restart.
//
// How it works:
//   - FIELD_DEFINITIONS describes every configurable value, including
//     env-var key, label, default, and whether it's a secret.
//   - Storage is server/config/app-settings.json. Only non-empty
//     values overriding defaults are persisted.
//   - At startup, init() applies any saved values to process.env so
//     downstream consumers (services that read process.env directly)
//     see the override without restarting.
//   - getSettings() returns a UI-safe view with secrets masked as
//     "••••••••" and an isOverridden flag per field.
//   - updateSettings() accepts new values; a "••••••••" placeholder
//     means "don't change this secret."
//   - getRawValue() lets server-side code fetch the actual value
//     (override > env > default) when it needs the real secret.

// Phase 13a hotfix #5: use Node's built-in `fs` instead of fs-extra.
// The dependency wasn't in the Sytist project (it was a PhotoDay
// holdover) and we don't need anything fs-extra-specific — only
// JSON read/write helpers which are one-liners with built-in fs.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'app-settings.json');

// Small helpers replacing fs-extra's readJson/writeJson. Kept private
// because the public surface of this file is the class instance, not
// the file format.
async function readJsonAsync(file) {
  const buf = await fsp.readFile(file, 'utf8');
  return JSON.parse(buf);
}
async function writeJsonAsync(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}
function readJsonSync(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonSync(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const SECRET_FIELDS = [
  'shipstationApiKey',
  'shipstationApiSecret',
  'awsSecretAccessKey',
  // Phase 62 — shared secret paired with Customer Manager's
  // dashboard_push_secret setting. Masks in the UI + omitted from
  // Settings API responses; only getRawValueSync returns the real
  // value to services/pushShippingMetaToCM.js.
  'dashboardPushToCmSecret',
];

// Field definitions. Adding a new configurable value: append here,
// then read it via getRawValue(key) wherever it's needed.
const FIELD_DEFINITIONS = [
  // ShipStation
  {
    key: 'shipstationApiKey',
    envKey: 'SHIPSTATION_API_KEY',
    label: 'ShipStation API Key',
    section: 'shipstation',
    default: '',
    secret: true,
    hint: 'From ShipStation → Account → API Settings.',
  },
  {
    key: 'shipstationApiSecret',
    envKey: 'SHIPSTATION_API_SECRET',
    label: 'ShipStation API Secret',
    section: 'shipstation',
    default: '',
    secret: true,
    hint: 'Issued alongside the API key. Keep private.',
  },
  {
    key: 'shipstationBaseUrl',
    envKey: 'SHIPSTATION_API_BASE_URL',
    label: 'ShipStation API Base URL',
    section: 'shipstation',
    default: 'https://ssapi.shipstation.com',
    secret: false,
    hint: 'Production endpoint. Override only for testing.',
  },

  // Shipping defaults — fall-back values used when buildOrderFromSytist
  // can't determine packaging another way. Phase 13b will introduce a
  // proper packaging engine; until then these are what the
  // OrderDetailPage's Ship card uses as initial form values.
  {
    key: 'defaultCarrier',
    envKey: 'DEFAULT_CARRIER',
    label: 'Default Carrier Code',
    section: 'shipping_defaults',
    default: 'stamps_com',
    secret: false,
    hint: 'e.g. stamps_com, ups_walleted, fedex, ups',
  },
  {
    key: 'defaultService',
    envKey: 'DEFAULT_SERVICE',
    label: 'Default Service Code',
    section: 'shipping_defaults',
    default: 'usps_first_class_mail',
    secret: false,
    hint: 'e.g. usps_first_class_mail, usps_ground_advantage',
  },
  {
    key: 'defaultPackageCode',
    envKey: 'DEFAULT_PACKAGE_CODE',
    label: 'Default Package Code',
    section: 'shipping_defaults',
    default: 'large_envelope_or_flat',
    secret: false,
    hint: 'e.g. large_envelope_or_flat, package',
  },
  {
    key: 'defaultWeightOz',
    envKey: 'DEFAULT_WEIGHT_OZ',
    label: 'Default Weight (oz)',
    section: 'shipping_defaults',
    default: '4',
    secret: false,
    hint: 'Order weight when no packaging rules apply.',
  },
  {
    key: 'defaultLengthIn',
    envKey: 'DEFAULT_LENGTH_IN',
    label: 'Default Length (in)',
    section: 'shipping_defaults',
    default: '10',
    secret: false,
  },
  {
    key: 'defaultWidthIn',
    envKey: 'DEFAULT_WIDTH_IN',
    label: 'Default Width (in)',
    section: 'shipping_defaults',
    default: '8',
    secret: false,
  },
  {
    key: 'defaultHeightIn',
    envKey: 'DEFAULT_HEIGHT_IN',
    label: 'Default Height (in)',
    section: 'shipping_defaults',
    default: '0.5',
    secret: false,
  },

  // Phase 42: AWS S3 — used by composedThumbnailService to publish
  // composed green-screen thumbnails (subject + background) so they
  // can be sent to ShipStation as imageUrl. Optional: when any of
  // these are empty, the service falls back to backend='skip' which
  // simply doesn't send imageUrl for green-screen items.
  //
  // To enable:
  //   1. Fill in all four (region, bucket, access key, secret) here.
  //   2. Set 'composedThumbnailBackend' to 's3-sytist' (below).
  //   3. Restart the server.
  //
  // The bucket can be Sytist's bucket if you have write access, or
  // a separate bucket you own. The objects need to be publicly
  // readable so ShipStation can fetch them.
  {
    key: 'awsAccessKeyId',
    envKey: 'AWS_ACCESS_KEY_ID',
    label: 'AWS Access Key ID',
    section: 'aws_s3',
    default: '',
    secret: false,
    hint: 'Public half of the AWS credential pair.',
  },
  {
    key: 'awsSecretAccessKey',
    envKey: 'AWS_SECRET_ACCESS_KEY',
    label: 'AWS Secret Access Key',
    section: 'aws_s3',
    default: '',
    secret: true,
    hint: 'Private half. Keep secret.',
  },
  {
    key: 'awsRegion',
    envKey: 'AWS_REGION',
    label: 'AWS Region',
    section: 'aws_s3',
    default: 'us-east-1',
    secret: false,
    hint: 'e.g. us-east-1, us-west-2',
  },
  {
    key: 'awsS3Bucket',
    envKey: 'AWS_S3_BUCKET',
    label: 'S3 Bucket Name',
    section: 'aws_s3',
    default: '',
    secret: false,
    hint: 'Bucket to upload composed thumbnails into.',
  },
  {
    key: 'awsS3KeyPrefix',
    envKey: 'AWS_S3_KEY_PREFIX',
    label: 'S3 Key Prefix',
    section: 'aws_s3',
    default: 'sytist-dashboard-composed/',
    secret: false,
    hint: 'Folder inside the bucket. Include trailing /',
  },
  {
    key: 'awsS3PublicUrlBase',
    envKey: 'AWS_S3_PUBLIC_URL_BASE',
    label: 'S3 Public URL Base (optional)',
    section: 'aws_s3',
    default: '',
    secret: false,
    hint: 'Optional CDN/CloudFront URL. Leave empty to use s3.amazonaws.com.',
  },
  {
    key: 'composedThumbnailBackend',
    envKey: 'COMPOSED_THUMBNAIL_BACKEND',
    label: 'Composed Thumbnail Backend',
    section: 'aws_s3',
    default: 'skip',
    secret: false,
    hint: 'skip = no green-screen thumbnails in SS. s3-sytist = upload to S3.',
  },

  // Phase 62 — push shipping metadata to Customer Manager on ship.
  // See server/services/pushShippingMetaToCM.js. Registered here (in
  // FIELD_DEFINITIONS) rather than read directly from the JSON so
  // the values (a) show in the Settings UI, (b) mask the secret,
  // (c) are read via getRawValueSync() the same way every other
  // dashboard service reads its config. Reading raw file paths at
  // ad-hoc nesting levels drifts silently — this is exactly the
  // bug that shipped Phase 62 as a silent no-op.
  {
    key: 'dashboardPushToCmUrl',
    envKey: 'DASHBOARD_PUSH_TO_CM_URL',
    label: 'Customer Manager shipping-meta URL',
    section: 'customer_manager',
    default: '',
    secret: false,
    hint: 'e.g. https://campaigns.sportslinephotography.com/api/sytist/shipping-meta. Blank disables the push.',
  },
  {
    key: 'dashboardPushToCmSecret',
    envKey: 'DASHBOARD_PUSH_TO_CM_SECRET',
    label: 'Customer Manager X-Dashboard-Secret',
    section: 'customer_manager',
    default: '',
    secret: true,
    hint: 'Paired with CM\'s dashboard_push_secret setting. 64 hex chars from `openssl rand -hex 32`.',
  },
];

class AppSettingsService {
  constructor() {
    this._ensureConfig();
  }

  _ensureConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
      writeJsonSync(CONFIG_PATH, { settings: {} });
    }
  }

  async _read() {
    return readJsonAsync(CONFIG_PATH);
  }

  async _write(data) {
    await writeJsonAsync(CONFIG_PATH, data);
  }

  /**
   * Returns all settings with secrets masked. Each entry includes
   * { key, label, section, secret, hasValue, isOverridden, hint, value }.
   * `hasValue` is true if anything (override or env) is set.
   * `isOverridden` is true only when the operator has saved a value
   * via this store (not from env). Lets the UI distinguish "factory
   * default" from "manually set."
   */
  async getSettings() {
    const data = await this._read();
    const saved = data.settings || {};

    const result = {};
    for (const field of FIELD_DEFINITIONS) {
      const savedValue = saved[field.key];
      const envValue = process.env[field.envKey];
      const effectiveValue = savedValue || envValue || field.default;
      result[field.key] = {
        key: field.key,
        label: field.label,
        section: field.section,
        secret: field.secret,
        hasValue: !!(savedValue || envValue),
        isOverridden: !!savedValue,
        hint: field.hint || null,
        value:
          field.secret && effectiveValue
            ? '••••••••'
            : effectiveValue,
      };
    }
    return result;
  }

  getFieldDefinitions() {
    return FIELD_DEFINITIONS.map((f) => ({
      key: f.key,
      label: f.label,
      section: f.section,
      secret: f.secret,
      default: f.default,
      hint: f.hint || null,
    }));
  }

  /**
   * Update one or more settings. Each key is matched against the
   * registered FIELD_DEFINITIONS — unknown keys are silently ignored
   * to avoid storing arbitrary client-supplied junk in the JSON.
   *
   * For secret fields, the placeholder "••••••••" means "keep the
   * existing value" — useful since the UI shows that mask when
   * loading and we don't want a noop save to wipe the secret.
   */
  async updateSettings(updates) {
    const data = await this._read();
    const saved = data.settings || {};

    for (const [key, value] of Object.entries(updates)) {
      const field = FIELD_DEFINITIONS.find((f) => f.key === key);
      if (!field) continue;
      if (field.secret && value === '••••••••') continue;
      if (typeof value === 'string' && value.trim()) {
        saved[key] = value.trim();
      } else if (value === '' || value == null) {
        delete saved[key];
      } else {
        saved[key] = String(value);
      }
    }

    data.settings = saved;
    await this._write(data);
    this._applyToEnv(saved);
    return this.getSettings();
  }

  /**
   * Get the raw (unmasked) value for a setting. Used internally by
   * services that need the actual secret. Falls through override →
   * env → default.
   */
  async getRawValue(key) {
    const field = FIELD_DEFINITIONS.find((f) => f.key === key);
    if (!field) return null;
    const data = await this._read();
    const saved = data.settings || {};
    return saved[key] || process.env[field.envKey] || field.default;
  }

  /**
   * Synchronous version used by services that can't easily go async
   * at the call site (e.g. inside a constructor). Reads the on-disk
   * file synchronously — fine since it's a small JSON file and the
   * caller probably already has the cost.
   */
  getRawValueSync(key) {
    const field = FIELD_DEFINITIONS.find((f) => f.key === key);
    if (!field) return null;
    let saved = {};
    try {
      const data = readJsonSync(CONFIG_PATH);
      saved = data.settings || {};
    } catch (e) {
      // ignore — fall through to env/default
    }
    return saved[field.key] || process.env[field.envKey] || field.default;
  }

  _applyToEnv(saved) {
    for (const field of FIELD_DEFINITIONS) {
      if (saved[field.key]) {
        process.env[field.envKey] = saved[field.key];
      }
    }
  }

  /**
   * Called from server/index.js at startup so saved values reach
   * process.env before any service that reads from env initializes.
   */
  async init() {
    try {
      const data = await this._read();
      const saved = data.settings || {};
      this._applyToEnv(saved);
    } catch (e) {
      console.warn(
        '[appSettings] init failed — using env/defaults only:',
        e.message
      );
    }
  }

  /** Exposed for use by route handlers that need to mask secrets. */
  static SECRET_FIELDS = SECRET_FIELDS;
}

module.exports = new AppSettingsService();
