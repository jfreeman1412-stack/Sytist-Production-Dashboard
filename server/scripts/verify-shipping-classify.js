// Phase 60 verification harness — workflow classification for digital-only
// orders. Exercises the REAL categorizeShipping (exposed as
// sytistDbService._categorizeShipping) without a DB.
//
// The bug: a customer ordering only digital downloads pays $0.00 shipping
// with an empty shipping option, which fell through the numeric fallback
// into ship_to_league. Fix: such orders go to the 'digital' bucket instead.
//
// Cases deliberately exercise the bug class (empty option + $0.00 + digital)
// AND the must-not-regress neighbours: name-matched options must still win
// over digital status, physical $0.00 orders must stay league, and the
// >1.01 / =1.00 cost branches must be unaffected by the digital flag.
//
// NOTE: this tests the JS decision only. The SQL predicate
// (_buildWorkflowSqlPredicate) must classify identically and is verified
// live against the database — see SPEC §60.

// Minimal env so the module's pool init doesn't throw on require.
process.env.SYTIST_DB_HOST = process.env.SYTIST_DB_HOST || 'offline';
process.env.SYTIST_DB_USER = process.env.SYTIST_DB_USER || 'offline';
process.env.SYTIST_DB_NAME = process.env.SYTIST_DB_NAME || 'offline';

const sytistDb = require('../services/sytistDbService');
const categorize = sytistDb._categorizeShipping;

if (typeof categorize !== 'function') {
  console.error('FAIL: sytistDbService._categorizeShipping is not exposed');
  process.exit(1);
}

// [name, optionName, cost, isDigitalOnly, expectedWorkflow, expectedUncategorized]
const cases = [
  // The bug case + its physical twin (same option/cost, differ only by digital):
  ['empty option + $0.00 + digital-only → digital', '', 0.0, true, 'digital', false],
  ['empty option + $0.00 + has-physical → league', '', 0.0, false, 'ship_to_league', true],

  // Name match ALWAYS wins, even for a digital-only order:
  ['Home option + $0.00 + digital → home (name wins)', 'USPS-Ship to Home', 0.0, true, 'ship_to_home', false],
  ['Managers option + $0.00 + digital → managers (name wins)', 'Discounted Group Shipping', 0.0, true, 'ship_to_managers', false],
  ['League option + $0.00 + digital → league (name wins)', 'Free Shipping to League Representative', 0.0, true, 'ship_to_league', false],

  // Cost branches unaffected by the digital flag (a $0 digital order can't hit
  // these, but assert the flag never hijacks a paid order):
  ['empty + $5.00 + physical → home', '', 5.0, false, 'ship_to_home', true],
  ['empty + $5.00 + digital → home (cost>1.01 wins)', '', 5.0, true, 'ship_to_home', true],
  ['empty + $1.00 + physical → managers', '', 1.0, false, 'ship_to_managers', true],
  ['empty + $1.00 + digital → managers (=1.00 wins over digital)', '', 1.0, true, 'ship_to_managers', true],

  // Null/odd cost handling:
  ['empty + null cost + digital → digital', '', null, true, 'digital', false],
  ['empty + null cost + physical → league', '', null, false, 'ship_to_league', true],
];

let pass = 0;
const fails = [];
for (const [name, opt, cost, dig, wantWf, wantUncat] of cases) {
  const got = categorize(opt, cost, dig);
  const ok = got.workflow === wantWf && got.uncategorized === wantUncat;
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`         got {workflow:${got.workflow}, uncategorized:${got.uncategorized}} want {${wantWf}, ${wantUncat}}`);
  }
}

console.log(`\n${pass}/${cases.length} classification cases pass`);
if (fails.length) {
  console.error('FAILURES:\n  ' + fails.join('\n  '));
  process.exit(1);
}
process.exit(0);
