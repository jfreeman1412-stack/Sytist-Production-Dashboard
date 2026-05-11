// Sytist MySQL data layer.
//
// Phase 2a: connection pool + healthCheck.
// Phase 2b Step 1: simple lookup queries (statuses + galleries).
// Phase 2b Step 2: getOrdersByWorkflow — assembles the canonical order shape.
// Phase 2c (later): updateOrderStatus.

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Display name for production status 0. Sytist has no row in ms_order_status
// for status 0; we synthesize a label for it. Internal Sytist convention
// historically called this "Queue"; Sportsline operationally calls it "Open".
const STATUS_OPEN_NAME = 'Open';

// ─── Shipping option mapping ──────────────────────────────
// Loaded once at module init; reload by restarting the server.
const SHIPPING_MAPPING_PATH = path.join(
  __dirname,
  '..',
  'config',
  'shipping-option-mappings.json'
);

let SHIPPING_MAP = {
  ship_to_home: [],
  ship_to_managers: [],
  ship_to_league: [],
};
try {
  const raw = fs.readFileSync(SHIPPING_MAPPING_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  SHIPPING_MAP = {
    ship_to_home: parsed.ship_to_home || [],
    ship_to_managers: parsed.ship_to_managers || [],
    ship_to_league: parsed.ship_to_league || [],
  };
  console.log(
    `[SytistDB] Loaded shipping mappings: ${SHIPPING_MAP.ship_to_home.length} home, ${SHIPPING_MAP.ship_to_managers.length} managers, ${SHIPPING_MAP.ship_to_league.length} league`
  );
} catch (err) {
  console.warn(
    `[SytistDB] Could not load ${SHIPPING_MAPPING_PATH}: ${err.message}`
  );
  console.warn('[SytistDB] All orders will hit numeric fallback.');
}

/**
 * Map an order_shipping_option string + cost to a workflow bucket.
 *
 * 1. Explicit mapping wins (config-file driven).
 * 2. Falls back to numeric rule based on shipping cost.
 * 3. Returns { workflow, uncategorized: bool } so UI can show warning badge.
 */
function categorizeShipping(optionName, cost) {
  const opt = (optionName || '').trim();

  if (SHIPPING_MAP.ship_to_home.includes(opt)) {
    return { workflow: 'ship_to_home', uncategorized: false };
  }
  if (SHIPPING_MAP.ship_to_managers.includes(opt)) {
    return { workflow: 'ship_to_managers', uncategorized: false };
  }
  if (SHIPPING_MAP.ship_to_league.includes(opt)) {
    return { workflow: 'ship_to_league', uncategorized: false };
  }

  // Numeric fallback. Operator should add this option to the JSON.
  const n = Number(cost) || 0;
  let workflow;
  if (n > 1.01) workflow = 'ship_to_home';
  else if (n === 1.0) workflow = 'ship_to_managers';
  else workflow = 'ship_to_league'; // n <= 0.99 (or anything weird)

  return { workflow, uncategorized: true };
}

// Phase 14a: SQL predicate equivalent of categorizeShipping(), for use
// in the WHERE clause when filtering by workflow. Must match the JS
// function's behavior exactly so that the workflow-filtered list,
// the order-counts endpoint, and per-order categorization all agree.
//
// The shape of the predicate is:
//   (option_name IN (mapped names for this workflow))
//   OR
//   (option_name NOT IN (any mapped name) AND
//      <numeric fallback predicate for this workflow>)
//
// The fallback bucket boundaries come from categorizeShipping:
//   cost > 1.01    → ship_to_home
//   cost === 1.0   → ship_to_managers
//   cost <= 0.99   → ship_to_league
//
// Returns { sql, params } where `sql` is a single parenthesized
// expression suitable for AND-joining into a WHERE clause. Returns
// null if the workflow string isn't recognized.
function _buildWorkflowSqlPredicate(workflow) {
  const allMappedNames = [
    ...SHIPPING_MAP.ship_to_home,
    ...SHIPPING_MAP.ship_to_managers,
    ...SHIPPING_MAP.ship_to_league,
  ];

  // Fallback predicates for orders whose option name isn't in any
  // configured list. The 'else' bucket in categorizeShipping is
  // ship_to_league, which means anything < 1.0 (and the operator
  // didn't map). We use cost <= 0.99 to match the JS check that
  // n is treated as `n <= 0.99` after the >1.01 and ===1.0 checks
  // fail. Anything between 0.99 and 1.0 exclusive ends up in league
  // per the JS logic, so we include that interval too.
  const fallbackByWorkflow = {
    ship_to_home: 'o.order_shipping > 1.01',
    ship_to_managers: 'o.order_shipping = 1.00',
    ship_to_league: 'o.order_shipping < 1.00 OR o.order_shipping IS NULL',
  };

  const mappedNames = SHIPPING_MAP[workflow];
  const fallback = fallbackByWorkflow[workflow];
  if (!mappedNames || !fallback) return null;

  const params = [];
  const parts = [];

  // Branch 1: option name is explicitly in this workflow's mapping.
  if (mappedNames.length > 0) {
    // mysql2's pool.query() expands (?) when given an array, so we
    // pass the array as a single param and emit a single placeholder.
    parts.push('o.order_shipping_option IN (?)');
    params.push(mappedNames);
  }

  // Branch 2: option name is NOT in any mapping → use numeric fallback.
  // If the mapped-names list is empty for ALL workflows the user has
  // a misconfigured shipping map, but the SQL still works (every order
  // hits the fallback bucket).
  const notInClause =
    allMappedNames.length > 0 ? 'o.order_shipping_option NOT IN (?) AND ' : '';
  if (allMappedNames.length > 0) {
    params.push(allMappedNames);
  }
  parts.push(`(${notInClause}(${fallback}))`);

  // Final predicate joins the branches with OR. Wrapped in parens so
  // it composes safely with AND-joined siblings.
  return { sql: `(${parts.join(' OR ')})`, params };
}

// ─── Subject field normalization ──────────────────────────
//
// Sytist stores extra fields as label/value pairs in 5 slots:
//   order_extra_field_N (label), order_extra_val_N (value)
// Labels often include trailing colons ("Athlete's Name:"). Strip those.
function normalizeSubjectFields(orderRow) {
  const fields = [];
  for (let i = 1; i <= 5; i++) {
    const rawLabel = orderRow[`order_extra_field_${i}`] || '';
    const value = orderRow[`order_extra_val_${i}`] || '';
    const label = rawLabel.replace(/[:\s]+$/, '').trim();
    if (label) {
      fields.push({ label, value });
    }
  }
  return fields;
}

// ─── Photo URL assembly ───────────────────────────────────
//
// Photos live on S3. The full URL is:
//   https://{pic_amazon_endpoint}/{pic_bucket}/{pic_bucket_folder}/{filename}
// Where filename varies by size:
//   pic_full   — original (use this for production prints)
//   pic_large  — display size
//   pic_th     — thumbnail (use this for UI)
//
// When pic_amazon = 0 the photo is local to the Sytist server (rare in prod).
function buildPhotoUrls(photoRow) {
  if (!photoRow) return null;

  if (photoRow.pic_amazon !== 1) {
    // Non-S3 photo. Phase 4 needs to handle this; for Phase 2b we just flag it.
    return {
      isS3: false,
      originalFilename: photoRow.pic_org || '',
      width: photoRow.pic_width || 0,
      height: photoRow.pic_height || 0,
    };
  }

  const baseUrl = `https://${photoRow.pic_amazon_endpoint}/${photoRow.pic_bucket}/${photoRow.pic_bucket_folder}`;

  return {
    isS3: true,
    originalFilename: photoRow.pic_org || '',
    width: photoRow.pic_width || 0,
    height: photoRow.pic_height || 0,
    fullUrl: photoRow.pic_full ? `${baseUrl}/${photoRow.pic_full}` : null,
    largeUrl: photoRow.pic_large ? `${baseUrl}/${photoRow.pic_large}` : null,
    thumbUrl: photoRow.pic_th ? `${baseUrl}/${photoRow.pic_th}` : null,
  };
}

// ──────────────────────────────────────────────────────────

class SytistDbService {
  constructor() {
    this.pool = null;
    this._lastError = null;
  }

  init() {
    if (this.pool) return this.pool;

    const config = {
      host: process.env.SYTIST_DB_HOST,
      port: parseInt(process.env.SYTIST_DB_PORT || '3306', 10),
      user: process.env.SYTIST_DB_USER,
      password: process.env.SYTIST_DB_PASSWORD,
      database: process.env.SYTIST_DB_NAME,
      connectionLimit: 5,
      queueLimit: 0,
      waitForConnections: true,
      charset: 'utf8mb4',
      connectTimeout: 10_000,
      dateStrings: true,
    };

    if (!config.host || !config.user || !config.database) {
      throw new Error(
        'SYTIST_DB_HOST, SYTIST_DB_USER, and SYTIST_DB_NAME must be set in .env'
      );
    }

    this.pool = mysql.createPool(config);
    console.log(
      `[SytistDB] Pool created → ${config.user}@${config.host}:${config.port}/${config.database}`
    );
    return this.pool;
  }

  getPool() {
    if (!this.pool) this.init();
    return this.pool;
  }

  async healthCheck() {
    const pool = this.getPool();
    const start = Date.now();

    try {
      const [[ping]] = await pool.query('SELECT 1 AS ok');
      const [[ident]] = await pool.query(
        'SELECT DATABASE() AS db, VERSION() AS version, USER() AS user'
      );
      const elapsedMs = Date.now() - start;

      this._lastError = null;
      return {
        ok: ping.ok === 1,
        database: ident.db,
        version: ident.version,
        user: ident.user,
        elapsedMs,
      };
    } catch (err) {
      this._lastError = err;
      const safeMsg = String(err.message || err)
        .replace(/password=[^&\s]+/gi, 'password=***')
        .replace(/PASSWORD\s*=\s*'[^']*'/gi, "PASSWORD='***'");
      const wrapped = new Error(`Sytist DB health check failed: ${safeMsg}`);
      wrapped.code = err.code;
      throw wrapped;
    }
  }

  // ─── Lookup queries (Step 1) ───────────────────────────

  async getOrderStatuses() {
    const pool = this.getPool();
    const [rows] = await pool.query(
      `SELECT status_id, status_name, status_descr, status_show_order
       FROM ms_order_status
       ORDER BY status_show_order, status_name`
    );
    return rows.map((r) => ({
      id: r.status_id,
      name: r.status_name,
      description: r.status_descr || '',
      showOrder: r.status_show_order,
    }));
  }

  async getGalleryHierarchy({ monthsBack = 18 } = {}) {
    const pool = this.getPool();
    const dateFilter =
      monthsBack > 0
        ? `AND o.order_date >= DATE_SUB(NOW(), INTERVAL ? MONTH)`
        : '';
    const dateParams = monthsBack > 0 ? [monthsBack] : [];

    const [galleries] = await pool.query(
      `
      SELECT
        cal.date_id        AS galleryId,
        cal.date_title     AS galleryName,
        cat.cat_id         AS categoryId,
        cat.cat_name       AS categoryName,
        COUNT(DISTINCT o.order_id) AS orderCount,
        MAX(o.order_date)  AS lastOrderDate
      FROM ms_calendar cal
      LEFT JOIN ms_blog_categories cat ON cat.cat_id = cal.date_cat
      INNER JOIN ms_cart c   ON c.cart_pic_date_id = cal.date_id
      INNER JOIN ms_orders o ON o.order_id = c.cart_order
      WHERE o.order_status = 0
        AND o.order_open_status = 0
        AND o.order_erased = 0
        AND o.order_payment_status = 'Completed'
        ${dateFilter}
      GROUP BY cal.date_id, cal.date_title, cat.cat_id, cat.cat_name
      ORDER BY MAX(o.order_date) DESC
      `,
      dateParams
    );

    if (galleries.length === 0) return [];

    const galleryIds = galleries.map((g) => g.galleryId);
    const [subRows] = await pool.query(
      `
      SELECT
        sub.sub_id          AS subId,
        sub.sub_date_id     AS galleryId,
        sub.sub_name        AS subName,
        COUNT(DISTINCT o.order_id) AS orderCount,
        MAX(o.order_date)   AS lastOrderDate
      FROM ms_sub_galleries sub
      INNER JOIN ms_cart c   ON c.cart_sub_gal_id = sub.sub_id
      INNER JOIN ms_orders o ON o.order_id = c.cart_order
      WHERE sub.sub_date_id IN (?)
        AND o.order_status = 0
        AND o.order_open_status = 0
        AND o.order_erased = 0
        AND o.order_payment_status = 'Completed'
        ${dateFilter}
      GROUP BY sub.sub_id, sub.sub_date_id, sub.sub_name
      ORDER BY sub.sub_name
      `,
      [galleryIds, ...dateParams]
    );

    const subsByGallery = new Map();
    for (const s of subRows) {
      const list = subsByGallery.get(s.galleryId) || [];
      list.push({
        subId: s.subId,
        subName: s.subName,
        orderCount: Number(s.orderCount),
        lastOrderDate: s.lastOrderDate,
      });
      subsByGallery.set(s.galleryId, list);
    }

    return galleries.map((g) => ({
      galleryId: g.galleryId,
      galleryName: g.galleryName,
      categoryId: g.categoryId,
      categoryName: g.categoryName,
      orderCount: Number(g.orderCount),
      lastOrderDate: g.lastOrderDate,
      subGalleries: subsByGallery.get(g.galleryId) || [],
    }));
  }

  // ─── Order queries (Step 2) ────────────────────────────

  /**
   * Returns an array of canonical-shaped orders matching the given filter.
   *
   * Strategy: three queries (orders → cart lines → cart options) joined in JS
   * to avoid Cartesian explosion. Cart vs cart_archive handled via UNION ALL
   * with the order_archive_table flag matching the right table.
   *
   * Options:
   *   workflow         — 'ship_to_home' | 'ship_to_managers' | 'ship_to_league' | 'all' (default 'all')
   *   productionStatus — number | 'all' (default 0 = "Queue")
   *   limit            — pagination size (default 50, max 1000)
   *   offset           — pagination offset (default 0)
   *   galleryId        — optional ms_calendar.date_id filter
   *   subGalleryId     — optional ms_sub_galleries.sub_id filter
   *
   * Returns:
   *   { orders: [...], total: number, elapsedMs: number }
   */
  async getOrdersByWorkflow(opts = {}) {
    const {
      workflow = 'all',
      productionStatus = 0,
      limit = 50,
      offset = 0,
      galleryId = null,
      subGalleryId = null,
      shippingOption = null,
      sort = 'date_asc',  // 'date_asc' (oldest first) | 'date_desc' (newest first)
    } = opts;

    const pool = this.getPool();
    const start = Date.now();

    // ─── Build the shared WHERE clause ─────────────────────
    //
    // Phase 14a fix: workflow filter must happen in SQL so that LIMIT
    // and OFFSET work correctly. Previously this filter ran in JS
    // AFTER the LIMITed result was already returned, which meant:
    //   (1) Asking for ship_to_home with default LIMIT 50 would
    //       fetch 50 orders of ANY workflow, then keep only the
    //       ship_to_home ones — usually far fewer than 50.
    //   (2) `total` reported `orders.length` (post-JS-filter), so
    //       the UI couldn't tell how many ship_to_home orders
    //       actually existed.
    //
    // The fix uses the SHIPPING_MAP option-name lists to build an
    // IN(...) predicate, plus a numeric-cost predicate for the
    // uncategorized fallback path (matching categorizeShipping's
    // n>1.01 / n===1.0 / n<=0.99 buckets exactly).
    const where = [
      "o.order_payment_status = 'Completed'",
      'o.order_status = 0',
      'o.order_erased = 0',
    ];
    const params = [];

    if (productionStatus !== 'all') {
      where.push('o.order_open_status = ?');
      params.push(productionStatus);
    }

    if (shippingOption) {
      where.push('o.order_shipping_option = ?');
      params.push(shippingOption);
    }

    // Workflow filter — in SQL now (Phase 14a fix).
    if (workflow !== 'all') {
      const wfPredicate = _buildWorkflowSqlPredicate(workflow);
      if (wfPredicate) {
        where.push(wfPredicate.sql);
        params.push(...wfPredicate.params);
      }
    }

    // Gallery filter requires a join to ms_cart, so we use EXISTS to avoid
    // duplicating order rows.
    if (galleryId) {
      where.push(
        '(EXISTS (SELECT 1 FROM ms_cart c WHERE c.cart_order = o.order_id AND c.cart_pic_date_id = ?)' +
          ' OR EXISTS (SELECT 1 FROM ms_cart_archive ca WHERE ca.cart_order = o.order_id AND ca.cart_pic_date_id = ?))'
      );
      params.push(galleryId, galleryId);
    }
    if (subGalleryId) {
      where.push(
        '(EXISTS (SELECT 1 FROM ms_cart c WHERE c.cart_order = o.order_id AND c.cart_sub_gal_id = ?)' +
          ' OR EXISTS (SELECT 1 FROM ms_cart_archive ca WHERE ca.cart_order = o.order_id AND ca.cart_sub_gal_id = ?))'
      );
      params.push(subGalleryId, subGalleryId);
    }

    const limitSafe = Math.max(1, Math.min(parseInt(limit, 10) || 50, 1000));
    const offsetSafe = Math.max(0, parseInt(offset, 10) || 0);

    // Sort: only two options for now. Default ASC (oldest first) since the
    // operator workflow is "process older orders first".
    const orderByClause =
      sort === 'date_desc' ? 'o.order_date DESC' : 'o.order_date ASC';

    // ─── Query 0: TRUE total matching the filters ──────────
    //
    // Counts orders that match the full WHERE clause (now including
    // workflow). Used by the UI to render "Showing X-Y of Z" so
    // operators can see how many pages remain.
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM ms_orders o WHERE ${where.join(' AND ')}`,
      params
    );
    const totalMatching = Number(countRows[0]?.total || 0);

    // ─── Query 1: orders matching base filter ──────────────
    const [orderRows] = await pool.query(
      `
      SELECT
        o.*,
        st.status_name AS productionStatusName
      FROM ms_orders o
      LEFT JOIN ms_order_status st ON st.status_id = o.order_open_status
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderByClause}
      LIMIT ? OFFSET ?
      `,
      [...params, limitSafe, offsetSafe]
    );

    if (orderRows.length === 0) {
      return { orders: [], total: totalMatching, elapsedMs: Date.now() - start };
    }

    // Workflow categorization is still applied in JS for the canonical
    // shape (each order's `shipping.workflow` field). The SQL filter
    // above ensures LIMIT/OFFSET respect the workflow, but the
    // per-order categorization still needs to run so each returned
    // order carries its workflow tag.
    const orderRowsByWorkflow = orderRows;

    if (orderRowsByWorkflow.length === 0) {
      return { orders: [], total: 0, elapsedMs: Date.now() - start };
    }

    const orderIds = orderRowsByWorkflow.map((r) => r.order_id);

    // ─── Query 2: cart lines for those orders ──────────────
    //
    // UNION ALL across ms_cart and ms_cart_archive. Only orders with
    // order_archive_table = 1 will have lines in archive; the WHERE clauses
    // ensure we don't double-fetch.
    const archiveOrderIds = orderRowsByWorkflow
      .filter((r) => r.order_archive_table === 1)
      .map((r) => r.order_id);
    const liveOrderIds = orderRowsByWorkflow
      .filter((r) => r.order_archive_table !== 1)
      .map((r) => r.order_id);

    const cartUnionSql = [];
    const cartUnionParams = [];

    if (liveOrderIds.length > 0) {
      cartUnionSql.push(`
        SELECT
          c.cart_id, c.cart_order,
          c.cart_product_name, c.cart_sku, c.cart_qty, c.cart_price,
          c.cart_photo_prod, c.cart_photo_prod_connect,
          c.cart_pic_id, c.cart_pic_org,
          c.cart_pic_date_id, c.cart_pic_date_org,
          c.cart_sub_gal_id,
          c.cart_download, c.cart_package, c.cart_gift_certificate,
          c.cart_credit_product, c.cart_booking, c.cart_photo_bg,
          c.cart_pre_sell, c.cart_pre_sold, c.cart_pre_sold_gallery,
          c.cart_thumb, c.cart_notes,
          c.cart_frame_size, c.cart_canvas_id,
          0 AS fromArchive
        FROM ms_cart c
        WHERE c.cart_order IN (?)
      `);
      cartUnionParams.push(liveOrderIds);
    }

    if (archiveOrderIds.length > 0) {
      cartUnionSql.push(`
        SELECT
          ca.cart_id, ca.cart_order,
          ca.cart_product_name, ca.cart_sku, ca.cart_qty, ca.cart_price,
          ca.cart_photo_prod, ca.cart_photo_prod_connect,
          ca.cart_pic_id, ca.cart_pic_org,
          ca.cart_pic_date_id, ca.cart_pic_date_org,
          ca.cart_sub_gal_id,
          ca.cart_download, ca.cart_package, ca.cart_gift_certificate,
          ca.cart_credit_product, ca.cart_booking, ca.cart_photo_bg,
          ca.cart_pre_sell, ca.cart_pre_sold, ca.cart_pre_sold_gallery,
          ca.cart_thumb, ca.cart_notes,
          ca.cart_frame_size, ca.cart_canvas_id,
          1 AS fromArchive
        FROM ms_cart_archive ca
        WHERE ca.cart_order IN (?)
      `);
      cartUnionParams.push(archiveOrderIds);
    }

    const [cartRows] = await pool.query(
      cartUnionSql.join(' UNION ALL ') +
        ' ORDER BY cart_order, cart_id',
      cartUnionParams
    );

    // ─── Query 3: photos referenced by cart lines ──────────
    // Phase 10: also pull background photos referenced via
    // cart_photo_bg. Same ms_photos table, same query — just
    // expand the IN list to include both pic IDs. One round trip.
    const picIds = [
      ...new Set([
        ...cartRows.map((r) => r.cart_pic_id).filter((id) => id > 0),
        ...cartRows.map((r) => r.cart_photo_bg).filter((id) => id > 0),
      ]),
    ];
    let photosById = new Map();
    if (picIds.length > 0) {
      const [photoRows] = await pool.query(
        `
        SELECT
          pic_id, pic_org, pic_full, pic_large, pic_th,
          pic_amazon, pic_amazon_endpoint, pic_bucket, pic_bucket_folder,
          pic_width, pic_height
        FROM ms_photos
        WHERE pic_id IN (?)
        `,
        [picIds]
      );
      photosById = new Map(photoRows.map((p) => [p.pic_id, p]));
    }

    // ─── Query 4: sub-galleries referenced by cart lines ───
    const subIds = [
      ...new Set(cartRows.map((r) => r.cart_sub_gal_id).filter((id) => id > 0)),
    ];
    let subsById = new Map();
    if (subIds.length > 0) {
      const [subRows] = await pool.query(
        `
        SELECT sub_id, sub_name
        FROM ms_sub_galleries
        WHERE sub_id IN (?)
        `,
        [subIds]
      );
      subsById = new Map(subRows.map((s) => [s.sub_id, s.sub_name]));
    }

    // ─── Query 5: cart options for cart lines ──────────────
    const cartIdsList = cartRows.map((r) => r.cart_id);
    let optionsByCartId = new Map();
    if (cartIdsList.length > 0) {
      const [optRows] = await pool.query(
        `
        SELECT co_cart_id, co_opt_name, co_select_name, co_price
        FROM ms_cart_options
        WHERE co_cart_id IN (?)
        ORDER BY co_id
        `,
        [cartIdsList]
      );
      for (const o of optRows) {
        const list = optionsByCartId.get(o.co_cart_id) || [];
        list.push({
          name: o.co_opt_name || '',
          selectedValue: o.co_select_name || '',
          price: Number(o.co_price) || 0,
        });
        optionsByCartId.set(o.co_cart_id, list);
      }
    }

    // ─── Stitch into canonical shape ───────────────────────
    const cartByOrderId = new Map();
    for (const c of cartRows) {
      const list = cartByOrderId.get(c.cart_order) || [];
      list.push(c);
      cartByOrderId.set(c.cart_order, list);
    }

    const orders = orderRowsByWorkflow.map((o) => {
      const lines = cartByOrderId.get(o.order_id) || [];

      const lineItems = lines.map((c) => {
        const photoRow = c.cart_pic_id > 0 ? photosById.get(c.cart_pic_id) : null;
        // Phase 10: pull the background photo when cart_photo_bg points
        // at a real ms_photos row. Same shape as `photo`, just a
        // separate field on the line item. processingService picks this
        // up for layouts that have a `playerBackground` slot.
        const bgPhotoRow =
          c.cart_photo_bg > 0 ? photosById.get(c.cart_photo_bg) : null;
        return {
          cartId: c.cart_id,
          productName: c.cart_product_name || '',
          sku: c.cart_sku || '',
          qty: Number(c.cart_qty) || 0,
          price: Number(c.cart_price) || 0,
          photoProductId: c.cart_photo_prod || 0,

          galleryId: c.cart_pic_date_id || 0,
          galleryName: c.cart_pic_date_org || '',
          subGalleryId: c.cart_sub_gal_id || 0,
          subGalleryName:
            c.cart_sub_gal_id > 0
              ? subsById.get(c.cart_sub_gal_id) || ''
              : '',

          photo: photoRow
            ? buildPhotoUrls({
                ...photoRow,
                pic_id: c.cart_pic_id,
              })
            : null,

          backgroundPhoto: bgPhotoRow
            ? buildPhotoUrls({
                ...bgPhotoRow,
                pic_id: c.cart_photo_bg,
              })
            : null,

          flags: {
            download: c.cart_download === 1,
            package: c.cart_package > 0,
            giftCert: c.cart_gift_certificate === 1,
            creditProduct: c.cart_credit_product > 0,
            booking: c.cart_booking > 0,
            greenScreen: c.cart_photo_bg > 0,
            framed: c.cart_frame_size > 0,
            canvas: c.cart_canvas_id > 0,
            preSell: c.cart_pre_sell === 1,
            preSold: c.cart_pre_sold === 1,
            fromArchive: c.fromArchive === 1,
          },

          options: optionsByCartId.get(c.cart_id) || [],

          thumbPath: c.cart_thumb || '',
          notes: c.cart_notes || '',
        };
      });

      // Order-level gallery: take the first cart line's gallery as primary.
      // Sibling detection: distinct sub-galleries across lines.
      const distinctSubGalleries = new Set(
        lineItems
          .map((li) => li.subGalleryId)
          .filter((id) => id > 0)
      );
      const isSibling = distinctSubGalleries.size > 1;

      const primaryGallery =
        lineItems.find((li) => li.galleryId > 0) || null;

      const shipping = categorizeShipping(
        o.order_shipping_option,
        o.order_shipping
      );

      return {
        source: 'sytist',
        orderId: String(o.order_id),
        orderNumber: String(o.order_id),
        orderDate: o.order_date,
        paymentStatus: o.order_payment_status,
        productionStatus: {
          id: o.order_open_status || 0,
          name: o.productionStatusName || (o.order_open_status === 0 ? STATUS_OPEN_NAME : ''),
        },
        orderStatus: o.order_status,
        orderArchiveTable: o.order_archive_table === 1,

        customer: {
          firstName: o.order_first_name || '',
          lastName: o.order_last_name || '',
          email: o.order_email || '',
          phone: o.order_phone || '',
          businessName: o.order_business_name || '',
        },

        shipTo: {
          firstName: o.order_ship_first_name || '',
          lastName: o.order_ship_last_name || '',
          address1: o.order_ship_address || '',
          address2: o.order_ship_addres_2 || '',
          city: o.order_ship_city || '',
          state: o.order_ship_state || '',
          zip: o.order_ship_zip || '',
          country: o.order_ship_country || '',
          phone: o.order_phone || '',
          businessName: o.order_ship_business || '',
        },

        shipping: {
          cost: Number(o.order_shipping) || 0,
          optionName: o.order_shipping_option || '',
          workflow: shipping.workflow,
          uncategorized: shipping.uncategorized,
        },

        totals: {
          subtotal: Number(o.order_sub_total) || 0,
          tax: Number(o.order_tax) || 0,
          total: Number(o.order_total) || 0,
          paymentFee: Number(o.order_payment_fee) || 0,
        },

        subject: {
          fields: normalizeSubjectFields(o),
        },

        galleryId: primaryGallery ? primaryGallery.galleryId : 0,
        galleryName: primaryGallery ? primaryGallery.galleryName : '',
        subGalleryId: primaryGallery ? primaryGallery.subGalleryId : 0,
        subGalleryName: primaryGallery ? primaryGallery.subGalleryName : '',

        lineItems,
        isSibling,

        dueDate:
          o.order_due_date && o.order_due_date !== '0000-00-00'
            ? o.order_due_date
            : null,
        customerNotes: o.order_notes || '',
        adminNotes: o.order_admin_notes || '',

        cardLastFour: o.order_card_last_four || '',
        payType: o.order_pay_type || '',
      };
    });

    return {
      orders,
      // Phase 14a fix: report the SQL COUNT(*) of the filtered set,
      // not orders.length. orders.length is just the page size; the
      // UI needs the absolute total to render "X-Y of Z" and decide
      // whether to enable the Next button.
      total: totalMatching,
      pageSize: orders.length,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Returns a single canonical-shaped order, or null if not found.
   *
   * Uses the same stitching logic as getOrdersByWorkflow but filters down to
   * a single order ID. Bypasses the workflow filter (returns the order even
   * if its workflow is something we don't normally show).
   *
   * Pagination/status filters are also bypassed — we want this exact order
   * regardless of whether it's open, archived, or in any production status.
   */
  async getOrderById(orderId) {
    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('Invalid order ID');
    }

    const pool = this.getPool();

    // Single-order query — bypass the open/paid filters since the caller
    // explicitly asked for THIS order, whatever state it's in.
    const [orderRows] = await pool.query(
      `
      SELECT
        o.*,
        st.status_name AS productionStatusName
      FROM ms_orders o
      LEFT JOIN ms_order_status st ON st.status_id = o.order_open_status
      WHERE o.order_id = ?
        AND o.order_erased = 0
      LIMIT 1
      `,
      [id]
    );

    if (orderRows.length === 0) return null;

    // Reuse the multi-order pipeline by calling getOrdersByWorkflow with a
    // filter that matches just this one order... actually no, easier to just
    // assemble inline. The cart/photo/options query logic is identical but
    // for a single ID we can simplify.
    //
    // Implementation note: rather than duplicate the stitching logic, we
    // shortcut by going through getOrdersByWorkflow with productionStatus
    // = 'all' AND a fake workflow that matches everything. But filtering
    // by orderId isn't currently a parameter. So we duplicate the stitching
    // here. The duplication is a real cost but keeps each method clean.

    const o = orderRows[0];

    // Cart lines from correct table.
    const fromArchive = o.order_archive_table === 1;
    const cartTable = fromArchive ? 'ms_cart_archive' : 'ms_cart';
    const cartAlias = fromArchive ? 'ca' : 'c';

    const [cartRows] = await pool.query(
      `
      SELECT
        ${cartAlias}.cart_id, ${cartAlias}.cart_order,
        ${cartAlias}.cart_product_name, ${cartAlias}.cart_sku, ${cartAlias}.cart_qty, ${cartAlias}.cart_price,
        ${cartAlias}.cart_photo_prod, ${cartAlias}.cart_photo_prod_connect,
        ${cartAlias}.cart_pic_id, ${cartAlias}.cart_pic_org,
        ${cartAlias}.cart_pic_date_id, ${cartAlias}.cart_pic_date_org,
        ${cartAlias}.cart_sub_gal_id,
        ${cartAlias}.cart_download, ${cartAlias}.cart_package, ${cartAlias}.cart_gift_certificate,
        ${cartAlias}.cart_credit_product, ${cartAlias}.cart_booking, ${cartAlias}.cart_photo_bg,
        ${cartAlias}.cart_pre_sell, ${cartAlias}.cart_pre_sold, ${cartAlias}.cart_pre_sold_gallery,
        ${cartAlias}.cart_thumb, ${cartAlias}.cart_notes,
        ${cartAlias}.cart_frame_size, ${cartAlias}.cart_canvas_id,
        ${fromArchive ? 1 : 0} AS fromArchive
      FROM ${cartTable} ${cartAlias}
      WHERE ${cartAlias}.cart_order = ?
      ORDER BY ${cartAlias}.cart_id
      `,
      [id]
    );

    // Photos.
    // Phase 10: include both player and background pic IDs.
    const picIds = [
      ...new Set([
        ...cartRows.map((r) => r.cart_pic_id).filter((p) => p > 0),
        ...cartRows.map((r) => r.cart_photo_bg).filter((p) => p > 0),
      ]),
    ];
    let photosById = new Map();
    if (picIds.length > 0) {
      const [photoRows] = await pool.query(
        `
        SELECT
          pic_id, pic_org, pic_full, pic_large, pic_th,
          pic_amazon, pic_amazon_endpoint, pic_bucket, pic_bucket_folder,
          pic_width, pic_height
        FROM ms_photos
        WHERE pic_id IN (?)
        `,
        [picIds]
      );
      photosById = new Map(photoRows.map((p) => [p.pic_id, p]));
    }

    // Sub-galleries.
    const subIds = [
      ...new Set(cartRows.map((r) => r.cart_sub_gal_id).filter((sid) => sid > 0)),
    ];
    let subsById = new Map();
    if (subIds.length > 0) {
      const [subRows] = await pool.query(
        `SELECT sub_id, sub_name FROM ms_sub_galleries WHERE sub_id IN (?)`,
        [subIds]
      );
      subsById = new Map(subRows.map((s) => [s.sub_id, s.sub_name]));
    }

    // Cart options.
    const cartIdsList = cartRows.map((r) => r.cart_id);
    let optionsByCartId = new Map();
    if (cartIdsList.length > 0) {
      const [optRows] = await pool.query(
        `
        SELECT co_cart_id, co_opt_name, co_select_name, co_price
        FROM ms_cart_options
        WHERE co_cart_id IN (?)
        ORDER BY co_id
        `,
        [cartIdsList]
      );
      for (const op of optRows) {
        const list = optionsByCartId.get(op.co_cart_id) || [];
        list.push({
          name: op.co_opt_name || '',
          selectedValue: op.co_select_name || '',
          price: Number(op.co_price) || 0,
        });
        optionsByCartId.set(op.co_cart_id, list);
      }
    }

    // Stitch line items.
    const lineItems = cartRows.map((c) => {
      const photoRow = c.cart_pic_id > 0 ? photosById.get(c.cart_pic_id) : null;
      // Phase 10: background photo (cart_photo_bg → ms_photos)
      const bgPhotoRow =
        c.cart_photo_bg > 0 ? photosById.get(c.cart_photo_bg) : null;
      return {
        cartId: c.cart_id,
        productName: c.cart_product_name || '',
        sku: c.cart_sku || '',
        qty: Number(c.cart_qty) || 0,
        price: Number(c.cart_price) || 0,
        photoProductId: c.cart_photo_prod || 0,

        galleryId: c.cart_pic_date_id || 0,
        galleryName: c.cart_pic_date_org || '',
        subGalleryId: c.cart_sub_gal_id || 0,
        subGalleryName:
          c.cart_sub_gal_id > 0 ? subsById.get(c.cart_sub_gal_id) || '' : '',

        photo: photoRow
          ? buildPhotoUrls({ ...photoRow, pic_id: c.cart_pic_id })
          : null,

        backgroundPhoto: bgPhotoRow
          ? buildPhotoUrls({ ...bgPhotoRow, pic_id: c.cart_photo_bg })
          : null,

        flags: {
          download: c.cart_download === 1,
          package: c.cart_package > 0,
          giftCert: c.cart_gift_certificate === 1,
          creditProduct: c.cart_credit_product > 0,
          booking: c.cart_booking > 0,
          greenScreen: c.cart_photo_bg > 0,
          framed: c.cart_frame_size > 0,
          canvas: c.cart_canvas_id > 0,
          preSell: c.cart_pre_sell === 1,
          preSold: c.cart_pre_sold === 1,
          fromArchive: c.fromArchive === 1,
        },

        options: optionsByCartId.get(c.cart_id) || [],
        thumbPath: c.cart_thumb || '',
        notes: c.cart_notes || '',
      };
    });

    const distinctSubGalleries = new Set(
      lineItems.map((li) => li.subGalleryId).filter((sid) => sid > 0)
    );
    const isSibling = distinctSubGalleries.size > 1;
    const primaryGallery = lineItems.find((li) => li.galleryId > 0) || null;
    const shipping = categorizeShipping(o.order_shipping_option, o.order_shipping);

    return {
      source: 'sytist',
      orderId: String(o.order_id),
      orderNumber: String(o.order_id),
      orderDate: o.order_date,
      paymentStatus: o.order_payment_status,
      productionStatus: {
        id: o.order_open_status || 0,
        name: o.productionStatusName || (o.order_open_status === 0 ? STATUS_OPEN_NAME : ''),
      },
      orderStatus: o.order_status,
      orderArchiveTable: o.order_archive_table === 1,

      customer: {
        firstName: o.order_first_name || '',
        lastName: o.order_last_name || '',
        email: o.order_email || '',
        phone: o.order_phone || '',
        businessName: o.order_business_name || '',
      },

      shipTo: {
        firstName: o.order_ship_first_name || '',
        lastName: o.order_ship_last_name || '',
        address1: o.order_ship_address || '',
        address2: o.order_ship_addres_2 || '',
        city: o.order_ship_city || '',
        state: o.order_ship_state || '',
        zip: o.order_ship_zip || '',
        country: o.order_ship_country || '',
        phone: o.order_phone || '',
        businessName: o.order_ship_business || '',
      },

      shipping: {
        cost: Number(o.order_shipping) || 0,
        optionName: o.order_shipping_option || '',
        workflow: shipping.workflow,
        uncategorized: shipping.uncategorized,
      },

      totals: {
        subtotal: Number(o.order_sub_total) || 0,
        tax: Number(o.order_tax) || 0,
        total: Number(o.order_total) || 0,
        paymentFee: Number(o.order_payment_fee) || 0,
      },

      subject: { fields: normalizeSubjectFields(o) },

      galleryId: primaryGallery ? primaryGallery.galleryId : 0,
      galleryName: primaryGallery ? primaryGallery.galleryName : '',
      subGalleryId: primaryGallery ? primaryGallery.subGalleryId : 0,
      subGalleryName: primaryGallery ? primaryGallery.subGalleryName : '',

      lineItems,
      isSibling,

      dueDate:
        o.order_due_date && o.order_due_date !== '0000-00-00'
          ? o.order_due_date
          : null,
      customerNotes: o.order_notes || '',
      adminNotes: o.order_admin_notes || '',

      cardLastFour: o.order_card_last_four || '',
      payType: o.order_pay_type || '',
    };
  }

  /**
   * Updates the production status of a single order.
   *
   * Writes ONLY to ms_orders.order_open_status. Does NOT write to
   * ms_order_status_logs (owned by the existing Sytist automation).
   *
   * Validates statusId against ms_order_status (or 0 for "Queue") before
   * writing. Reads the previous value first so the caller can confirm what
   * changed.
   *
   * Returns:
   *   {
   *     orderId,
   *     previousStatus: { id, name },
   *     newStatus:      { id, name },
   *     affectedRows
   *   }
   *
   * Throws:
   *   - Order not found
   *   - Order erased (soft-deleted)
   *   - Invalid statusId (not 0 and not in ms_order_status)
   */
  async updateOrderStatus(orderId, statusId) {
    const id = parseInt(orderId, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw new Error('Invalid order ID');
    }

    const newStatusId = parseInt(statusId, 10);
    if (Number.isNaN(newStatusId) || newStatusId < 0) {
      throw new Error('Invalid status ID');
    }

    const pool = this.getPool();

    // 1. Validate the new status exists (or is 0 = Queue).
    let newStatusName = '';
    if (newStatusId === 0) {
      newStatusName = STATUS_OPEN_NAME;
    } else {
      const [[statusRow]] = await pool.query(
        'SELECT status_id, status_name FROM ms_order_status WHERE status_id = ?',
        [newStatusId]
      );
      if (!statusRow) {
        throw new Error(`Status ID ${newStatusId} does not exist in ms_order_status`);
      }
      newStatusName = statusRow.status_name;
    }

    // 2. Read current state. Confirm order exists and isn't erased.
    const [[currentRow]] = await pool.query(
      `
      SELECT
        o.order_id, o.order_open_status, o.order_erased,
        st.status_name AS currentStatusName
      FROM ms_orders o
      LEFT JOIN ms_order_status st ON st.status_id = o.order_open_status
      WHERE o.order_id = ?
      `,
      [id]
    );

    if (!currentRow) {
      throw new Error(`Order ${id} not found`);
    }
    if (currentRow.order_erased === 1) {
      throw new Error(`Order ${id} is erased; refusing to update`);
    }

    const previousStatusId = currentRow.order_open_status || 0;
    const previousStatusName =
      previousStatusId === 0 ? STATUS_OPEN_NAME : currentRow.currentStatusName || '';

    // 3. The actual write. Single row, by primary key, no triggers we control.
    //
    // Logging here so the action shows up in the dev console — useful while
    // we're verifying behavior. Can quiet this down in phase 12.
    console.log(
      `[SytistDB] updateOrderStatus: order ${id}: ${previousStatusId} (${previousStatusName}) → ${newStatusId} (${newStatusName})`
    );

    const [result] = await pool.query(
      'UPDATE ms_orders SET order_open_status = ? WHERE order_id = ?',
      [newStatusId, id]
    );

    return {
      orderId: id,
      previousStatus: { id: previousStatusId, name: previousStatusName },
      newStatus: { id: newStatusId, name: newStatusName },
      affectedRows: result.affectedRows,
    };
  }

  /**
   * Returns aggregate counts for the home dashboard cards.
   *
   * Three groupings, all over open + paid orders:
   *   - byStatus:   counts keyed by order_open_status (0 = Queue, 12, 40, etc.)
   *   - byWorkflow: counts keyed by workflow bucket (ship_to_home/managers/league)
   *                 — only counts the QUEUE (order_open_status = 0), since that's
   *                 the actionable bucket; "shipped" and "in production" are tracked
   *                 by the byStatus card row instead.
   *   - total:      sum of all open + paid orders regardless of status
   *
   * Single round-trip: one query for status counts (cheap — indexed), one for
   * workflow assembly (slightly more work — needs the option string + cost so
   * we can apply categorizeShipping in JS).
   *
   * Shape:
   *   {
   *     total: 12345,
   *     byStatus:   { "0": 5894, "40": 257, "12": 4, ... },
   *     byWorkflow: { "ship_to_home": 4500, "ship_to_managers": 600, "ship_to_league": 794, "uncategorized": 0 },
   *     elapsedMs: 89
   *   }
   */
  async getOrderCounts() {
    const pool = this.getPool();
    const start = Date.now();

    // 1. Counts grouped by production status.
    const [statusRows] = await pool.query(
      `
      SELECT order_open_status AS statusId, COUNT(*) AS count
      FROM ms_orders
      WHERE order_payment_status = 'Completed'
        AND order_status = 0
        AND order_erased = 0
      GROUP BY order_open_status
      `
    );

    const byStatus = {};
    let total = 0;
    for (const r of statusRows) {
      const id = String(r.statusId == null ? 0 : r.statusId);
      const n = Number(r.count) || 0;
      byStatus[id] = n;
      total += n;
    }

    // 2. Workflow counts — restricted to queue (order_open_status = 0) since
    //    that's the actionable view operators care about.
    const [workflowRows] = await pool.query(
      `
      SELECT order_shipping_option AS optionName, order_shipping AS cost, COUNT(*) AS count
      FROM ms_orders
      WHERE order_payment_status = 'Completed'
        AND order_status = 0
        AND order_erased = 0
        AND order_open_status = 0
      GROUP BY order_shipping_option, order_shipping
      `
    );

    const byWorkflow = {
      ship_to_home: 0,
      ship_to_managers: 0,
      ship_to_league: 0,
      uncategorized: 0,
    };

    for (const r of workflowRows) {
      const cat = categorizeShipping(r.optionName, r.cost);
      const n = Number(r.count) || 0;
      byWorkflow[cat.workflow] += n;
      if (cat.uncategorized) {
        byWorkflow.uncategorized += n;
      }
    }

    return {
      total,
      byStatus,
      byWorkflow,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Phase 8a: locate a team photo for a sub-gallery.
   *
   * Used by the composite engine to find the team photo to layer onto
   * memory mates. The discovery rule is structural — we don't pattern-
   * match filenames or derive orientation from metadata; we just look
   * for a photo assigned to the team-photo price list AND linked to the
   * sub-gallery.
   *
   *   ms_blog_photos.bp_pl  = listId       (price list discriminator)
   *   ms_blog_photos.bp_sub = subGalleryId (which team)
   *
   * Returns the same shape as buildPhotoUrls() — { isS3, originalFilename,
   * width, height, fullUrl, largeUrl, thumbUrl } — or null if no match.
   *
   * @param {object} opts
   * @param {number} opts.subGalleryId  ms_sub_galleries.sub_id
   * @param {number} opts.listId        ms_photo_products_list.list_id
   *                                    (default: 268, configurable per
   *                                    teamPhotoService settings)
   */
  /**
   * Phase 8a-hotfix: list every sub-gallery in a gallery, no order
   * filter applied.
   *
   * Different from getGalleryHierarchy() which filters sub-galleries
   * to those with paid/open/non-erased orders. The verification UI
   * needs to look up team photos for sub-galleries that may not have
   * orders yet (typical at gallery setup time, before customers buy).
   *
   * NOT a replacement for getGalleryHierarchy in the orders/dashboard
   * flow — those should stay filtered. Only the team photo lookup
   * tester should call this.
   */
  async getAllSubGalleries(galleryId) {
    if (!galleryId || galleryId <= 0) return [];
    const pool = this.getPool();
    const [rows] = await pool.query(
      `
      SELECT
        sub_id   AS subGalleryId,
        sub_name AS subGalleryName
      FROM ms_sub_galleries
      WHERE sub_date_id = ?
      ORDER BY sub_name
      `,
      [galleryId]
    );
    return rows.map((r) => ({
      subGalleryId: r.subGalleryId,
      subGalleryName: r.subGalleryName,
    }));
  }

  async findTeamPhoto({ subGalleryId, listId = 268 }) {
    if (!subGalleryId || subGalleryId <= 0) return null;
    const pool = this.getPool();

    // Phase 8b: LIMIT 2 (rather than 1) so the caller can detect when
    // multiple team photos exist for the same sub-gallery. We still
    // return only the most-recently-added photo (ORDER BY bp_id DESC),
    // but we surface candidateCount so the caller can warn the operator.
    // This addresses the legacy data where some old sub-galleries have
    // multiple photos on the team-photo price list.
    const [rows] = await pool.query(
      `
      SELECT
        p.pic_id,
        p.pic_org,
        p.pic_full,
        p.pic_large,
        p.pic_th,
        p.pic_amazon,
        p.pic_amazon_endpoint,
        p.pic_bucket,
        p.pic_bucket_folder,
        p.pic_width,
        p.pic_height,
        bp.bp_blog AS galleryId,
        bp.bp_sub  AS subGalleryId,
        bp.bp_id   AS bpId
      FROM ms_blog_photos bp
      INNER JOIN ms_photos p ON p.pic_id = bp.bp_pic
      WHERE bp.bp_pl  = ?
        AND bp.bp_sub = ?
      ORDER BY bp.bp_id DESC
      LIMIT 2
      `,
      [listId, subGalleryId]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    const photo = buildPhotoUrls(row);
    if (!photo) return null;

    // Annotate with the IDs we matched on so callers can verify the
    // lookup hit the row they expected. candidateCount tells the caller
    // whether multiple matches existed (≥2 means there's a tiebreaker
    // situation worth surfacing).
    return {
      ...photo,
      photoId: row.pic_id,
      galleryId: row.galleryId,
      subGalleryId: row.subGalleryId,
      bpId: row.bpId,
      candidateCount: rows.length, // 1 = clean match, 2 = multi-match (we returned newest)
    };
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = new SytistDbService();
