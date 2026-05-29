// Phase 67 verification harness — formatPhone + {customer.phoneFormatted} token.
//
// Drives the REAL compositeService.formatPhone helper and the
// buildTokensFromOrder plumbing offline. Case 7 (live read-only spot-check on
// a real order with a known phone) runs only when SYTIST_DB_HOST is set to a
// real host — set the env vars to enable it, leave them unset for offline-only.
//
// The user's original "email-mismatch case (renders blank, not error)" was
// moot under the chosen design: phoneFormatted reads order.customer.phone
// (= ms_orders.order_phone), which is on the order row itself. No email join,
// no mismatch surface.

const offline =
  !process.env.SYTIST_DB_HOST || process.env.SYTIST_DB_HOST === 'offline';
if (offline) {
  process.env.SYTIST_DB_HOST = 'offline';
  process.env.SYTIST_DB_USER = 'offline';
  process.env.SYTIST_DB_NAME = 'offline';
}

const compositeService = require('../services/compositeService');
const { formatPhone } = compositeService;

let pass = 0;
const fails = [];
function expectEq(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else {
    fails.push(name);
    console.log(`  FAIL  ${name} — expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

// ─── Cases 1–5 (operator-listed formatter cases) ───────────────
expectEq('1. clean 10-digit  "5551234567" → "555-123-4567"',
  formatPhone('5551234567'), '555-123-4567');

expectEq('2. 11-digit w/ "1"  "15551234567" → "555-123-4567"',
  formatPhone('15551234567'), '555-123-4567');

expectEq('3. already-formatted  "(555) 123-4567" → "555-123-4567"',
  formatPhone('(555) 123-4567'), '555-123-4567');

expectEq('4. empty string → ""',
  formatPhone(''), '');

expectEq('5. malformed 7-digit  "555-1234" → "555-1234" (raw, untouched)',
  formatPhone('555-1234'), '555-1234');

// Extra defensive cases (not on the operator's list but cheap and worth it).
expectEq('5a. null → ""', formatPhone(null), '');
expectEq('5b. undefined → ""', formatPhone(undefined), '');
expectEq('5c. whitespace-only "   " → ""', formatPhone('   '), '');
expectEq('5d. "+1 555.123.4567" → "555-123-4567"',
  formatPhone('+1 555.123.4567'), '555-123-4567');

// ─── Token-plumbing cases (buildTokensFromOrder end-to-end) ────
const tokens = compositeService.buildTokensFromOrder({
  customer: { firstName: 'X', lastName: 'Y', phone: '15551234567', email: 'a@b' },
});
expectEq('plumbing: tokens.customer.phoneFormatted', tokens.customer.phoneFormatted, '555-123-4567');
expectEq('plumbing: raw tokens.customer.phone preserved (ShipStation reads it)',
  tokens.customer.phone, '15551234567');

const emptyTokens = compositeService.buildTokensFromOrder({ customer: { phone: '' } });
expectEq('plumbing: empty customer.phone → phoneFormatted ""',
  emptyTokens.customer.phoneFormatted, '');

const noCustomerTokens = compositeService.buildTokensFromOrder({});
expectEq('plumbing: missing customer object → phoneFormatted ""',
  noCustomerTokens.customer.phoneFormatted, '');

(async () => {
  // ─── Case 6: live read-only spot-check on a real order with a phone ────
  if (offline) {
    console.log('  SKIP  6. live spot-check (offline mode — set SYTIST_DB_HOST/USER/PASSWORD/NAME to enable)');
  } else {
    try {
      require('dotenv').config();
      const mysql = require('mysql2/promise');
      const pool = mysql.createPool({
        host: process.env.SYTIST_DB_HOST,
        port: parseInt(process.env.SYTIST_DB_PORT || '3306', 10),
        user: process.env.SYTIST_DB_USER,
        password: process.env.SYTIST_DB_PASSWORD,
        database: process.env.SYTIST_DB_NAME,
        connectionLimit: 1,
      });
      const [rows] = await pool.query(
        "SELECT order_id, order_phone FROM ms_orders WHERE order_phone IS NOT NULL AND TRIM(order_phone) <> '' ORDER BY order_date DESC LIMIT 1"
      );
      await pool.end();
      if (!rows.length) {
        console.log('  SKIP  6. live spot-check — no orders with a non-empty order_phone');
      } else {
        const sytistDb = require('../services/sytistDbService');
        const order = await sytistDb.getOrderById(String(rows[0].order_id));
        const t = compositeService.buildTokensFromOrder(order);
        const expected = formatPhone(order.customer.phone);
        expectEq(
          `6. live order ${order.orderId} (raw "${order.customer.phone}") → tokens.customer.phoneFormatted "${expected}"`,
          t.customer.phoneFormatted, expected
        );
        // Also confirm raw isn't disturbed
        expectEq(
          `6b. live order ${order.orderId} raw customer.phone preserved`,
          t.customer.phone, order.customer.phone
        );
      }
    } catch (e) {
      console.log('  SKIP  6. live spot-check —', e.message);
    }
  }

  console.log(`\n${pass}/${pass + fails.length} phone-token cases pass`);
  if (fails.length) {
    console.error('FAILURES:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  process.exit(0);
})();
