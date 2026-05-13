// ─────────────────────────────────────────────────────────────
// thumbnailBackends/s3Sytist.js — AWS S3 backend
// ─────────────────────────────────────────────────────────────
//
// Uploads composed JPEG thumbnails to an S3 bucket and returns
// public URLs. Phase 42 introduced as the production backend for
// green-screen thumbnails in ShipStation.
//
// Object key convention:
//   {keyPrefix}{orderId}/{cartId}.jpg
//
// Example with default prefix:
//   sytist-dashboard-composed/110692/481642.jpg
//
// Object is uploaded with:
//   - ContentType: image/jpeg
//   - CacheControl: public, max-age=3600 (1 hour — ShipStation
//                   doesn't strictly need long caching since each
//                   order is short-lived in their UI)
//   - ACL: public-read  (ShipStation needs to fetch without auth)
//
// IMPORTANT: For the public-read ACL to work, the bucket itself must
// either:
//   (a) Allow public-read ACLs at the bucket policy level, OR
//   (b) Have its "Block Public Access" bucket setting turned OFF
//       for ACLs.
// Modern AWS accounts have Block Public Access enabled by default,
// which silently rejects public-read ACLs. The deploy notes for
// Phase 42 cover this.
//
// Credentials come from appSettings (the dashboard's Settings UI),
// which mirrors them into process.env at startup. The AWS SDK
// picks them up via the standard env-var chain — no explicit
// credentials parameter passed.
//
// Failure handling: this module's publish() and cleanup() can throw.
// The composedThumbnailService wrapper catches those throws and
// converts to null/false. So callers never need to try/catch.

const appSettings = require('../../config/appSettings');

// Lazy-load the AWS SDK so the dependency is optional. If
// @aws-sdk/client-s3 isn't installed (e.g. operator hasn't run
// `npm install` after a Phase 42 deploy), this backend reports
// itself as not configured and composedThumbnailService falls
// back to 'skip'. The error message points the operator at the
// fix.
let S3Client = null;
let PutObjectCommand = null;
let DeleteObjectCommand = null;
let ListObjectsV2Command = null;
let DeleteObjectsCommand = null;
let sdkLoadError = null;

try {
  // eslint-disable-next-line global-require
  const sdk = require('@aws-sdk/client-s3');
  S3Client = sdk.S3Client;
  PutObjectCommand = sdk.PutObjectCommand;
  DeleteObjectCommand = sdk.DeleteObjectCommand;
  ListObjectsV2Command = sdk.ListObjectsV2Command;
  DeleteObjectsCommand = sdk.DeleteObjectsCommand;
} catch (err) {
  sdkLoadError = err.message;
}

// Cached S3 client instance. Created on first publish/cleanup call
// once we've confirmed isConfigured() === true. Built from current
// settings each time the cache is cleared.
let _client = null;
let _clientConfig = null;

function _readConfig() {
  return {
    accessKeyId: appSettings.getRawValueSync('awsAccessKeyId') || '',
    secretAccessKey: appSettings.getRawValueSync('awsSecretAccessKey') || '',
    region: appSettings.getRawValueSync('awsRegion') || 'us-east-1',
    bucket: appSettings.getRawValueSync('awsS3Bucket') || '',
    keyPrefix:
      appSettings.getRawValueSync('awsS3KeyPrefix') ||
      'sytist-dashboard-composed/',
    publicUrlBase:
      appSettings.getRawValueSync('awsS3PublicUrlBase') || '',
  };
}

function _getClient() {
  const cfg = _readConfig();
  if (
    !_client ||
    !_clientConfig ||
    _clientConfig.accessKeyId !== cfg.accessKeyId ||
    _clientConfig.region !== cfg.region
  ) {
    _client = new S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    _clientConfig = cfg;
  }
  return _client;
}

function _objectKey(orderId, cartId, prefix) {
  // Normalize prefix to end with exactly one /
  const p = prefix.endsWith('/') ? prefix : prefix + '/';
  return `${p}${orderId}/${cartId}.jpg`;
}

function _publicUrl(key, cfg) {
  // If operator configured a custom URL base (CloudFront, etc.), use
  // that. Otherwise fall back to the canonical S3 virtual-hosted-style
  // URL. Encode the key path so spaces/special chars survive the URL.
  if (cfg.publicUrlBase) {
    const base = cfg.publicUrlBase.endsWith('/')
      ? cfg.publicUrlBase.slice(0, -1)
      : cfg.publicUrlBase;
    return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  // Default S3 URL form: https://{bucket}.s3.{region}.amazonaws.com/{key}
  return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

module.exports = {
  name: 's3-sytist',

  /**
   * Validates that the SDK loaded AND all required credentials are
   * present. Called by composedThumbnailService at backend-resolution
   * time. If this returns false, the service falls back to 'skip'.
   */
  isConfigured() {
    if (sdkLoadError) {
      console.warn(
        `[s3Sytist] @aws-sdk/client-s3 not available: ${sdkLoadError}. ` +
          `Run \`npm install\` in the server directory.`
      );
      return false;
    }
    const cfg = _readConfig();
    if (!cfg.accessKeyId || !cfg.secretAccessKey) {
      console.warn(
        `[s3Sytist] AWS credentials not set in Settings → API Keys.`
      );
      return false;
    }
    if (!cfg.bucket) {
      console.warn(
        `[s3Sytist] S3 Bucket Name not set in Settings → API Keys.`
      );
      return false;
    }
    return true;
  },

  /**
   * Upload a composed JPEG. Object key is deterministic so
   * re-processing the same (order, cartId) overwrites the existing
   * object cleanly with no orphans.
   *
   * Returns the public URL the object can be fetched at.
   */
  async publish(orderId, cartId, composedJpegBuffer) {
    if (!Buffer.isBuffer(composedJpegBuffer)) {
      throw new Error('composedJpegBuffer must be a Buffer');
    }
    const cfg = _readConfig();
    const key = _objectKey(orderId, cartId, cfg.keyPrefix);

    const client = _getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: composedJpegBuffer,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=3600',
        ACL: 'public-read',
      })
    );

    const url = _publicUrl(key, cfg);
    console.log(
      `[s3Sytist] Published composed thumbnail for order ${orderId} cart ${cartId} → ${url}`
    );
    return url;
  },

  /**
   * Delete all composed thumbnails for an order. We don't track
   * cart IDs separately, so we list-and-delete by the order's key
   * prefix.
   *
   * Returns {ok, deleted}. Non-fatal on individual failures.
   */
  async cleanup(orderId) {
    const cfg = _readConfig();
    const orderPrefix = `${
      cfg.keyPrefix.endsWith('/') ? cfg.keyPrefix : cfg.keyPrefix + '/'
    }${orderId}/`;

    const client = _getClient();

    // List everything under the order prefix.
    let totalDeleted = 0;
    let continuationToken = undefined;

    // Loop in case of pagination (unlikely for our volume, but
    // correct).
    for (let i = 0; i < 10; i += 1) {
      const list = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: orderPrefix,
          ContinuationToken: continuationToken,
        })
      );

      const keys = (list.Contents || []).map((c) => ({ Key: c.Key }));
      if (keys.length === 0) break;

      // S3 DeleteObjects accepts up to 1000 keys per call. Chunk if
      // someone manages to put more than 1000 cart IDs in a single
      // order.
      for (let j = 0; j < keys.length; j += 1000) {
        const chunk = keys.slice(j, j + 1000);
        const delResult = await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.bucket,
            Delete: { Objects: chunk, Quiet: true },
          })
        );
        totalDeleted += chunk.length - (delResult.Errors?.length || 0);
        if (delResult.Errors?.length) {
          for (const err of delResult.Errors) {
            console.warn(
              `[s3Sytist] Failed to delete ${err.Key}: ${err.Message}`
            );
          }
        }
      }

      if (!list.IsTruncated) break;
      continuationToken = list.NextContinuationToken;
    }

    if (totalDeleted > 0) {
      console.log(
        `[s3Sytist] Cleaned up ${totalDeleted} composed thumbnail(s) for order ${orderId}`
      );
    }
    return { ok: true, deleted: totalDeleted };
  },

  // ─── Test helpers (exported for unit testing) ────────────
  _objectKey,
  _publicUrl,
  _readConfig,
};
