// ============================================================
// PAST FILINGS AUDIT — one-off, read-only. Run auditPastFilings() from the
// editor. Nothing is filed and no PM is emailed.
//
// Before the 2026-10-06 address fix, some notices went out with the wrong
// street address, another household's tenants, a junk unit line, or a
// mis-split city. The admin summaries never listed who was filed, so this
// re-reads the AppFolio delinquency report from each past filing day (all
// affected properties are in the AF11 database) and emails ADMIN_EMAIL every
// row at or above the standard threshold that would have hit one of those
// defects. On-demand filing days list candidates only — the PM picked the
// rows and the threshold, so check those against what was actually sent.
// ============================================================
var PAST_FILING_DATES = [
  '2026-05-30', '2026-06-03', '2026-06-06', '2026-07-06', '2026-08-06', '2026-09-06',  // scheduled
  '2026-09-11', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-23',                // on-demand
];

// One AppFolio property, two households — the old lookup merged their tenants.
var PAST_MERGED_PROPERTY_KEYS = ['28|gold', '16|packard', '538|56th', '717|5th', '811|park', '917|park', '1956|crestmoor', '1044|muskegon'];

function auditPastFilings() {
  var sheet2Map = loadSheet2_();
  if (!sheet2Map) { Logger.log('Cannot load Sheet2'); return; }
  var sender  = cfg_('APPFOLIO_EMAIL_SENDER') || 'appfolio.com';
  var threads = GmailApp.search('from:(' + sender + ') subject:"AF11 Delinquency"', 0, 10);

  var lines = [];
  PAST_FILING_DATES.forEach(function(ymd) {
    var p    = ymd.split('-');
    var text = extractFirstCSV_(threads, new Date(+p[0], +p[1] - 1, +p[2]));
    if (!text) { lines.push(ymd + ': no AF11 Delinquency email found for this day'); return; }

    var hits = [];
    Utilities.parseCsv(text).slice(1).forEach(function(row) {
      if (!row || row.length < 4) return;
      var name    = (row[DCOL.NAME]    || '').trim();
      var rawUnit = (row[DCOL.UNIT]    || '').trim();
      var rawAddr = (row[DCOL.ADDRESS] || '').trim();
      var amount  = parseFloat((row[DCOL.AMOUNT] || '').replace(/[$,]/g, ''));
      if (!name || name.toLowerCase() === 'total' || !rawAddr) return;
      if (isNaN(amount) || amount < AMOUNT_THRESHOLD) return;
      if (isCommercialUnit_(rawUnit) || isSkippedProperty_(rawAddr) || isCommercialTenantName_(name)) return;

      var problems = pastFilingProblems_(rawAddr, rawUnit, sheet2Map);
      if (problems.length) {
        hits.push('  • ' + name + ' — ' + rawAddr + ' / ' + rawUnit + ' — ' + formatAmount_(amount) + '\n      ' + problems.join('\n      '));
      }
    });
    lines.push(ymd + ': ' + (hits.length ? hits.length + ' affected row(s)\n' + hits.join('\n') : 'none'));
  });

  var body = 'Rows that would have been filed with a defect before the 2026-10-06 address fix.\n\n' + lines.join('\n\n');
  Logger.log(body);
  var adminEmail = cfg_('ADMIN_EMAIL');
  if (adminEmail) GmailApp.sendEmail(adminEmail, 'Delinquency — past filings address audit', body);
}

// What the pre-fix code got wrong for this row, as a list of plain sentences.
function pastFilingProblems_(rawAddr, rawUnit, sheet2Map) {
  var res = resolveAddress_(rawAddr, rawUnit, sheet2Map);
  if (!res || res.flag) return [];
  var out     = [];
  var addrKey = normalizeAddrKey_(rawAddr);
  var unitKey = normalizeAddrKey_(rawUnit);
  var correct = res.street + (res.unit ? ', Unit ' + res.unit : '');

  if (res.sheetKey !== addrKey && unitKey === res.sheetKey && !/^\d{4,}\s+/.test(rawUnit)) {
    out.push('WRONG ADDRESS: notice said ' + rawAddr + '; should be ' + correct);
  } else if (res.sheetKey !== addrKey && /^\d+$/.test(rawUnit)) {
    out.push('WRONG ADDRESS: notice said ' + rawAddr + '; should be ' + correct);
  } else if (res.sheetKey !== addrKey && unitKey === res.sheetKey && sheet2Map[res.sheetKey].units <= 1) {
    out.push('JUNK UNIT LINE: notice said "Unit ' + rawUnit.trim().split(/\s+/).pop() + '"; should be ' + correct);
  }
  if (PAST_MERGED_PROPERTY_KEYS.indexOf(addrKey) >= 0) {
    out.push('TENANTS: may also name or e-serve the household at the other address/unit of this property');
  }
  var addy = sheet2Map[res.sheetKey].addy;
  if (/[^,] (Cedar Springs|Howard City|East Grand Rapids), [A-Z]{2} /.test(addy) || /, (NE|NW|SE|SW) /.test(addy) || /\(unit/i.test(addy)) {
    out.push('CITY LINE: street and city were split wrong; should be ' + res.street + ' / ' + res.city + ', ' + res.state + ' ' + res.zip);
  }
  if (res.sheetKey === addrKey && !/^[WwSs]\s+\d/.test(rawUnit) && (/ADA$/i.test(rawUnit) || rawUnit.indexOf('&') >= 0)) {
    out.push('UNIT: notice said "Unit ' + rawUnit.trim().split(/\s+/).pop() + '"; should be Unit ' + res.unit);
  }
  return out;
}
