// Address audit — replays every unit in an AppFolio Unit Directory export
// through the real resolveAddress_ in Code.js and compares the street address
// the notice would carry against AppFolio's own "Unit Street Address 1".
//
// Run before deploying any change to address resolution, and whenever
// properties are added in AppFolio or Sheet2:
//
//   node test/audit_addresses.js <Sheet2.csv> <unit_directory.csv>
//
// Sheet2.csv         = "Delinquency Info" tab, File > Download > CSV
// unit_directory.csv = AppFolio Unit Directory report with columns
//                      Unit Name, Unit Street Address 1, Property
// Exits 1 if any unit would be filed at the wrong street address or if two
// different units would be treated as the same one.
const fs = require('fs'), vm = require('vm'), path = require('path');

// Units where AppFolio's unit street address is itself wrong (confirmed by Matt).
const KNOWN_APPFOLIO_TYPOS = { '2131': '2121 Leonard St NE is correct; unit street address says 2131' };

const [sheetPath, udPath] = process.argv.slice(2);
if (!sheetPath || !udPath) { console.error('usage: node test/audit_addresses.js <Sheet2.csv> <unit_directory.csv>'); process.exit(2); }

function parseCsv(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows;
}

const gas = { Logger: { log() {} } };
vm.createContext(gas);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8'), gas);

const sheet2Map = {};
parseCsv(fs.readFileSync(sheetPath, 'utf8')).slice(1).forEach(r => {
  const addy = (r[1] || '').trim(), key = gas.normalizeAddrKey_(addy);
  if (key) sheet2Map[key] = { pm: (r[0] || '').trim(), addy, units: parseInt(r[2]) || 1, owner: (r[5] || '').trim() };
});

// House number + first street word, tolerant of "5957B 8th Ave SW," style values.
const truthKey = a => { const m = String(a).trim().match(/^(\d+)[A-Za-z]?\s+([A-Za-z0-9]+)/); return m ? m[1] + '|' + m[2].toLowerCase() : null; };

const units = parseCsv(fs.readFileSync(udPath, 'utf8').replace(/^﻿/, ''))
  .filter(r => r.length >= 3 && r[0] !== 'Unit Name' && (r[2] || '').trim());

const wrong = [], flagged = [], badCity = [], identity = {};
let ok = 0, skipped = 0;
units.forEach(r => {
  const unit = r[0].trim(), street1 = r[1].trim(), prop = r[2].trim();
  const dash = prop.lastIndexOf(' - ');
  const addr = dash >= 0 ? prop.slice(dash + 3) : prop;
  if (gas.isCommercialUnit_(unit) || gas.isSkippedProperty_(prop)) { skipped++; return; }
  const res = gas.resolveAddress_(addr, unit, sheet2Map);
  if (!res) { skipped++; return; }
  if (res.flag) { flagged.push(`${unit} | ${prop} | ${res.reason}`); return; }

  const id = res.sheetKey + ' unit "' + gas.normalizeUnitForMatch_(res.unit) + '"';
  (identity[id] = identity[id] || []).push(`${unit} (${street1})`);
  if (!res.city || !res.zip || /\b(Cedar|Howard|East|Byron|Comstock|Grand)$/.test(res.street)) badCity.push(`${unit} | street "${res.street}" city "${res.city}" zip "${res.zip}"`);

  if (truthKey(street1) === gas.normalizeAddrKey_(res.street) || KNOWN_APPFOLIO_TYPOS[unit]) ok++;
  else wrong.push(`${unit} | AppFolio: ${street1} | notice: ${res.street}${res.unit ? ', Unit ' + res.unit : ''} | ${prop}`);
});
const merged = Object.keys(identity).filter(k => identity[k].length > 1).map(k => `${k} <= ${identity[k].join(' ; ')}`);

const section = (title, list) => { console.log(`\n${title}: ${list.length}`); list.forEach(x => console.log('  ' + x)); };
console.log(`${units.length} units: ${ok} correct, ${skipped} skipped by rule`);
section('WRONG STREET ADDRESS', wrong);
section('DIFFERENT UNITS MERGED INTO ONE', merged);
section('BAD CITY/ZIP SPLIT', badCity);
section('Not in Sheet2 (flagged to admin, never filed)', flagged);
process.exit(wrong.length || merged.length || badCity.length ? 1 : 0);
