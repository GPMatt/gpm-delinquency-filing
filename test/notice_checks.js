// Who gets named and served on a notice, and what the pre-send check holds
// back — runs the real functions in Code.js against a small made-up directory.
//
//   node test/notice_checks.js
//
// Exits 1 on any failure. Run before deploying a change to buildFormData_,
// noticeParties_ or checkNotice_.
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');

const gas = {
  Logger: { log() {} },
  Utilities: { formatDate: () => '10/07/2026' },
};
vm.createContext(gas);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8'), gas);

const ADDR = '900 Leonard St NW Grand Rapids, MI 49504';
const sheet2Map = {};
sheet2Map[gas.normalizeAddrKey_(ADDR)] = { pm: 'Jody Betsch', addy: ADDR, units: 100, unitExample: '', owner: '900 W Leonard LLC' };

const dir = (unit, tenant, type, email) =>
  ({ property: 'Victory on Leonard - ' + ADDR, unit, tenant, tenantType: type, email });
const directory = [
  dir('316', 'Parent, Pat',      'Co-signer',               'pat.parent@example.com'),
  dir('316', 'Bouwens, Brooke P.', 'Financially Responsible', 'brooke@example.com'),
  dir('316', 'Roomie, Sam',      'Financially Responsible', ''),
  dir('317', 'Other, Olive',     'Financially Responsible', 'olive@example.com; OLIVE@example.com, olive2@example.com'),
  dir('318', 'Nomail, Ned',      'Financially Responsible', ''),
  dir('319', 'Typo, Tina',       'Financially Responsible', 'tina@gmail'),
  dir('320', 'Someone, Else',    'Financially Responsible', 'else@example.com'),
];

function notice(unit, primaryName) {
  const r = gas.resolveAddress_(ADDR, unit, sheet2Map);
  assert(r && !r.flag, 'test address should resolve');
  const row = Object.assign({ primaryName, owner: r.owner, amount: '1,200.00' }, r);
  const parties = gas.noticeParties_(row, directory, sheet2Map, {});
  const formData = gas.buildFormData_(row, parties, new Date());
  return Object.assign({ formData }, gas.checkNotice_(row, formData, parties));
}

let failed = 0;
function check(label, fn) {
  try { fn(); console.log('ok   ' + label); }
  catch (e) { failed++; console.log('FAIL ' + label + '\n     ' + e.message); }
}

check('co-signer is named, after the tenants, primary first', () => {
  const n = notice('316', 'Bouwens, Brooke P.');
  assert.strictEqual(n.formData.tenant_names, 'Brooke P. Bouwens, Sam Roomie, Pat Parent');
  assert.strictEqual(n.formData.served_on, n.formData.tenant_names);
});
check('co-signer email is served, tenants first', () => {
  const n = notice('316', 'Bouwens, Brooke P.');
  assert.strictEqual(n.formData.electronic_service_email, 'brooke@example.com, pat.parent@example.com');
  assert.deepStrictEqual(Array.from(n.problems), []);
});
check('several addresses in one cell are split and de-duplicated', () => {
  const n = notice('317', 'Other, Olive');
  assert.strictEqual(n.formData.electronic_service_email, 'olive@example.com, olive2@example.com');
  assert.deepStrictEqual(Array.from(n.problems), []);
});
check('no email for anyone is held', () => {
  const n = notice('318', 'Nomail, Ned');
  assert(n.problems.some(p => /No email address on file/.test(p)), JSON.stringify(n.problems));
});
check('malformed email is held', () => {
  const n = notice('319', 'Typo, Tina');
  assert(n.problems.some(p => /not a valid email/.test(p)), JSON.stringify(n.problems));
});
check('unit with no directory match is held', () => {
  const n = notice('999', 'Ghost, Gary');
  assert(n.problems.some(p => /No one in the Tenant Directory/.test(p)), JSON.stringify(n.problems));
});
check('primary missing from the directory is noted, not held', () => {
  const n = notice('320', 'Stranger, Stan');
  assert.deepStrictEqual(Array.from(n.problems), []);
  assert(n.notes.some(t => /not in the Tenant Directory/.test(t)), JSON.stringify(n.notes));
});

console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
