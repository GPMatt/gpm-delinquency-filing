'use strict';

// ============================================================
// P11 — Delinquency Form Automation
// Michigan DC 100a: Demand for Possession Nonpayment of Rent
// ============================================================
//
// SETUP (run once before first use):
//   Set Script Properties (Project Settings → Script Properties):
//     CLOUD_FUNCTION_URL     — deployed Cloud Function endpoint
//     APPFOLIO_EMAIL_SENDER  — AppFolio sender domain (e.g. appfolio.com)
//     SHEET2_ID              — Google Sheet ID of "Delinquency Info" workbook
//     PM_EMAIL_JODY_BETSCH   — Jody Betsch's email address
//     PM_EMAIL_BLAKE_ROUSH   — Blake Roush's email address
//     PM_EMAIL_MIKE_GREEN    — Mike Green's email address
//     PM_EMAIL_JILL_ODONNELL — Jill O'Donnell's email address
//     PM_EMAIL_BEN_STEVENS   — Ben Stevens's email address
//     (add more as: PM_EMAIL_ + PM name uppercased, spaces/apostrophes → underscores)
//     ADMIN_EMAIL            — receives flagged-row report + test PDFs
//
//   Run installTrigger() once to enable automation.
//
// SCHEDULE (fallback — always runs regardless of the web app):
//   4th of month — Victory on Leonard (VoL) only
//   6th of month — all other properties (Jefferson, Oakwood, Pinery, IVA, AF11)
//   If the 4th/6th falls on a weekend or a court holiday, the run shifts to
//   the next court business day and uses THAT day's date and AppFolio data
//   (see dailyFilingCheck_ / effectiveFilingDate_ / isCourtHoliday_).
//
// ON-DEMAND WEB APP:
//   Deploy → New deployment → Web app. Execute as: Me. Access: Anyone
//   within [domain]. PMs open the URL, pick themselves + a $ threshold,
//   review the preview (name/address/amount), then click "Let's File."
//   Runs ALL properties together against the MOST RECENT report in the
//   inbox (not date-gated like the scheduled runs). Update PM_LIST above
//   if the roster of initiating PMs changes.
// ============================================================

var PROPERTY_GROUPS = {
  Jefferson: 6,
  Oakwood:   6,
  Pinery:    6,
  IVA:       6,
  AF11:      6,
  VoL:       4,
};

var ALL_LABELS = ['Jefferson', 'Oakwood', 'Pinery', 'IVA', 'AF11', 'VoL'];

// Names shown in the "Let's File" web app dropdown — must match Sheet2's PM column values,
// except ADMIN_INITIATORS entries (see below), which aren't a Sheet2 PM and bypass the filter.
var PM_LIST = ['Jody Betsch', 'Blake Roush', 'Mike Green', 'Laura Porter', 'Matthieu Fournier'];

// Initiators who see/file every property's delinquencies in the on-demand app instead of
// only rows where Sheet2's PM column matches their name. Not tied to any Sheet2 property —
// filed notices go to the initiator, regardless of the row's actual Sheet2 PM.
var ADMIN_INITIATORS = ['Laura Porter', 'Matthieu Fournier'];

var AMOUNT_THRESHOLD = 100;
var VICTORY_STREET   = '900 Leonard St NW';

function cfg_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}


// ============================================================
// ENTRY POINTS (called by triggers)
// ============================================================
function runVictoryFiling()  { runFiling_(['VoL'], false); }
function runStandardFiling() { runFiling_(['Jefferson', 'Oakwood', 'Pinery', 'IVA', 'AF11'], true); }


// ============================================================
// SHARED FILING LOGIC
// opts (all optional):
//   threshold  — dollar floor, default AMOUNT_THRESHOLD
//   useLatest  — true: grab the most recent report in the inbox regardless
//                of date (on-demand). false/omitted: today's report only
//                (scheduled runs).
//   meta       — { manual:true, initiator, threshold } passed through to
//                the admin summary email
// ============================================================
function runFiling_(labels, skipVictory, opts) {
  opts = opts || {};
  var threshold = (typeof opts.threshold === 'number') ? opts.threshold : AMOUNT_THRESHOLD;
  var useLatest = !!opts.useLatest;

  Logger.log('Filing run for: ' + labels.join(', ') +
             (useLatest ? ' (on-demand, latest report)' : ' (scheduled, today only)') +
             ' — threshold $' + threshold);

  var today       = new Date();
  var sheet2Map   = loadSheet2_();
  if (!sheet2Map) {
    Logger.log('ERROR: Could not load Sheet2. Check SHEET2_ID script property.');
    var adminEmail = cfg_('ADMIN_EMAIL');
    if (adminEmail) GmailApp.sendEmail(adminEmail, '⚠️ Delinquency Automation ERROR — Sheet2 failed to load', 'Could not load Sheet2. Check SHEET2_ID script property.');
    return;
  }

  var attachments = findEmailAttachmentsBySubject_(labels, useLatest);
  var directory   = attachments.directoryText   ? parseTenantDirectory_(attachments.directoryText)                                        : [];
  var delinquents = attachments.delinquencyText ? parseDelinquencyCSV_(attachments.delinquencyText, sheet2Map, skipVictory, threshold) : { resolved: [], flagged: [], skipped: 0 };

  Logger.log('To file: ' + delinquents.resolved.length +
             '  Skipped: ' + delinquents.skipped +
             '  Flagged: ' + delinquents.flagged.length);

  var pmBlobs = {};
  var errors  = [];
  var directoryKeyCache = {};

  delinquents.resolved.forEach(function(row) {
    try {
      var formData = buildFormData_(row, directory, today, sheet2Map, directoryKeyCache);
      var pdfB64   = callCloudFunction_(formData);
      var blob     = makePDFBlob_(pdfB64, row, today);
      Logger.log('✓ ' + row.primaryName + ' — ' + row.street +
                 (row.unit ? ', Unit ' + row.unit : '') + ' ($' + row.amount + ')');
      var pm = row.pm || 'UNKNOWN';
      if (!pmBlobs[pm]) pmBlobs[pm] = [];
      pmBlobs[pm].push(blob);
    } catch (e) {
      Logger.log('✗ ' + row.primaryName + ': ' + e.message);
      errors.push({ name: row.primaryName, reason: e.message });
    }
  });

  Logger.log('Done. Filed: ' + (Object.keys(pmBlobs).reduce(function(s,k){return s+pmBlobs[k].length;},0)) + '  Errors: ' + errors.length);
  sendPMEmails_(pmBlobs, delinquents.flagged, errors, attachments.missingLabels, today, opts.meta);
}


// ============================================================
// SHEET2 LOADER
// Reads Delinquency Info Google Sheet via SpreadsheetApp.
// Returns map: normalizeAddrKey_(addy) → row object
// ============================================================
function loadSheet2_() {
  var id = cfg_('SHEET2_ID');
  if (!id) { Logger.log('SHEET2_ID not set.'); return null; }
  try {
    var ss    = SpreadsheetApp.openById(id);
    var sheet = ss.getSheetByName('Delinquency Info');
    if (!sheet) { Logger.log('ERROR: "Delinquency Info" tab not found in Sheet2 spreadsheet.'); return null; }
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) { Logger.log('Sheet2 appears empty.'); return null; }

    var map = {};
    for (var i = 1; i < data.length; i++) {
      var r    = data[i];
      var addy = String(r[1] || '').trim();
      if (!addy) continue;
      var key = normalizeAddrKey_(addy);
      if (!key) continue;
      map[key] = {
        pm:          String(r[0] || '').trim(),
        addy:        addy,
        units:       parseInt(r[2]) || 1,
        unitExample: String(r[3] || '').trim(),
        owner:       String(r[5] || '').trim(),
      };
    }
    Logger.log('Sheet2 loaded: ' + Object.keys(map).length + ' properties.');
    return map;
  } catch (e) {
    Logger.log('ERROR loading Sheet2: ' + e.message);
    return null;
  }
}

// "900 Leonard St NW Grand Rapids, MI 49504" → "900|leonard"
function normalizeAddrKey_(addr) {
  var m = String(addr || '').trim().match(/^(\d+)\s+([A-Za-z0-9]+)/);
  return m ? (m[1] + '|' + m[2].toLowerCase()) : null;
}


// ============================================================
// GMAIL — fetch CSVs by subject line per property label
// useLatest=true: skip the same-day check entirely and take the newest
// matching email in the inbox (on-demand filing). useLatest=false: only
// today's email counts (scheduled runs).
// ============================================================
function findEmailAttachmentsBySubject_(labels, useLatest) {
  var sender = cfg_('APPFOLIO_EMAIL_SENDER') || 'appfolio.com';
  var today  = useLatest ? null : new Date();

  var delinquencyParts = [];
  var directoryParts   = [];
  var missingLabels    = [];

  labels.forEach(function(label) {
    // Date filter removed from query — after:/before: use a slow search index.
    // Same-day check (when applicable) is applied per-message using getDate(),
    // which reads metadata directly. Gmail returns threads newest-first, so
    // when useLatest is true the first attachment found is the most recent one.
    var dQuery = 'from:(' + sender + ') subject:"' + label + ' Delinquency"';
    var tQuery = 'from:(' + sender + ') subject:"' + label + ' Tenants"';

    var dText = extractFirstCSV_(GmailApp.search(dQuery, 0, 10), today);
    var tText = extractFirstCSV_(GmailApp.search(tQuery, 0, 10), today);

    if (!dText) { Logger.log('WARNING: No delinquency CSV found for: ' + label); missingLabels.push(label + ' Delinquency'); }
    else        { Logger.log('Delinquency CSV found: ' + label); delinquencyParts.push(dText); }

    if (!tText) { Logger.log('WARNING: No tenant directory CSV found for: ' + label); missingLabels.push(label + ' Tenants'); }
    else        { Logger.log('Tenant directory CSV found: ' + label); directoryParts.push(tText); }
  });

  return {
    delinquencyText: mergeCSVParts_(delinquencyParts),
    directoryText:   mergeCSVParts_(directoryParts),
    missingLabels:   missingLabels,
  };
}

// Return the text of the first CSV attachment from targetDate across the given threads.
// Date check uses msg.getDate() — reads message metadata directly, no search index needed.
function extractFirstCSV_(threads, targetDate) {
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    // AppFolio reuses the same subject every day, so Gmail groups these into one
    // long-running thread. getMessages() returns oldest-first, so without this we'd
    // grab the CSV from the very first email ever sent in the thread instead of the
    // most recent one — stale tenant/delinquency data (2026-09-16: missing an
    // e-service email added to the directory after the thread's first message).
    for (var j = messages.length - 1; j >= 0; j--) {
      var msg = messages[j];
      if (targetDate) {
        var d = msg.getDate();
        if (d.getFullYear() !== targetDate.getFullYear() ||
            d.getMonth()    !== targetDate.getMonth()    ||
            d.getDate()     !== targetDate.getDate()) continue;
      }
      var atts = msg.getAttachments();
      for (var k = 0; k < atts.length; k++) {
        var att  = atts[k];
        var name = att.getName().toLowerCase();
        var type = att.getContentType().toLowerCase();
        if (type.indexOf('csv') >= 0 || name.slice(-4) === '.csv') {
          return att.getDataAsString();
        }
      }
    }
  }
  return null;
}

// Merge multiple CSV texts: keep header from first, strip header from rest
function mergeCSVParts_(parts) {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  var lines = parts[0].trimRight().split('\n');
  for (var i = 1; i < parts.length; i++) {
    var tail = parts[i].trimRight().split('\n').slice(1);
    lines = lines.concat(tail);
  }
  return lines.join('\n');
}


// ============================================================
// CSV PARSING
// Delinquency CSV columns: Name, Amount Receivable, Unit, Property Address
// ============================================================
var DCOL = { NAME: 0, AMOUNT: 1, UNIT: 2, ADDRESS: 3 };

function parseDelinquencyCSV_(text, sheet2Map, skipVictory, threshold) {
  if (typeof threshold !== 'number') threshold = AMOUNT_THRESHOLD;
  var rows       = Utilities.parseCsv(text);
  var resolved   = [];
  var flagged    = [];
  var skipped    = 0;
  var victoryKey = normalizeAddrKey_(VICTORY_STREET);

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row || row.length < 4) continue;

    var name    = (row[DCOL.NAME]    || '').trim();
    var amtRaw  = (row[DCOL.AMOUNT]  || '').trim();
    var rawUnit = (row[DCOL.UNIT]    || '').trim();
    var rawAddr = (row[DCOL.ADDRESS] || '').trim();

    if (!name || name.toLowerCase() === 'total') continue;
    if (!rawAddr) continue;

    var amount = parseFloat(amtRaw.replace(/[$,]/g, ''));
    if (isNaN(amount) || amount < threshold) { skipped++; continue; }

    if (skipVictory && normalizeAddrKey_(rawAddr) === victoryKey) { skipped++; continue; }
    if (isCommercialUnit_(rawUnit)) { skipped++; continue; }
    if (isSkippedProperty_(rawAddr)) { skipped++; continue; }
    if (isCommercialTenantName_(name)) { skipped++; continue; }

    var result = resolveAddress_(rawAddr, rawUnit, sheet2Map);
    if (!result) { skipped++; continue; }

    if (result.flag) {
      flagged.push({ name: name, rawUnit: rawUnit, rawAddr: rawAddr, reason: result.reason });
      Logger.log('FLAGGED: ' + name + ' | ' + rawAddr + ' / ' + rawUnit + ' — ' + result.reason);
      continue;
    }

    resolved.push({
      primaryName: name,
      street:      result.street,
      unit:        result.unit,
      city:        result.city,
      state:       result.state,
      zip:         result.zip,
      owner:       result.owner,
      pm:          result.pm,
      sheetKey:    result.sheetKey,
      rawAddr:     rawAddr,
      rawUnit:     rawUnit,
      amount:      formatAmount_(amount),
    });
  }

  return { resolved: resolved, flagged: flagged, skipped: skipped };
}

// Tenant directory columns: Property, Unit, Tenant, Tenant Type
var TCOL = { PROPERTY: 0, UNIT: 1, TENANT: 2, TYPE: 3, EMAIL: 4 };

function parseTenantDirectory_(text) {
  var rows = Utilities.parseCsv(text);
  var out  = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length < 4) continue;
    var property = (r[TCOL.PROPERTY] || '').trim();
    var unit     = (r[TCOL.UNIT]     || '').trim();
    var tenant   = (r[TCOL.TENANT]   || '').trim();
    var type_    = (r[TCOL.TYPE]     || '').trim();
    var email    = (r[TCOL.EMAIL]    || '').trim();
    if (!tenant || !property) continue;
    out.push({ property: property, unit: unit, tenant: tenant, tenantType: type_, email: email });
  }
  return out;
}


// ============================================================
// SKIP HELPERS
// ============================================================
function isCommercialUnit_(unit) {
  var u = unit.toLowerCase().trim();
  return u.indexOf('suite') === 0 || u === 'parking lot' || u === "chuck's auto";
}

function isSkippedProperty_(addr) {
  var a = addr.toLowerCase();
  return a.indexOf('prairie winds') >= 0 || a.indexOf('65 monroe') >= 0;
}

// Commercial tenants that should never be filed on regardless of which
// unit/address they show up under. Match is a lowercase substring against
// the delinquency CSV's Name column — add more as: 'a distinctive lowercase
// fragment of the business name'.
var COMMERCIAL_TENANT_NAMES = [
  'family dollar',
  'great lakes ace hardware',
];

function isCommercialTenantName_(name) {
  var n = name.toLowerCase();
  return COMMERCIAL_TENANT_NAMES.some(function(needle) { return n.indexOf(needle) >= 0; });
}


// ============================================================
// ADDRESS RESOLUTION
// Returns { street, unit, city, state, zip, owner, pm, flag:false }
//      or { flag:true, reason }
// Returns null for silent skip.
// ============================================================
function resolveAddress_(rawAddr, rawUnit, sheet2Map) {
  var addr = rawAddr.trim();
  var unit = rawUnit.trim();

  // A. Wealthy / Sheldon — unit starts with "W " or "S " + digits (+ optional ADA)
  var wsMatch = unit.match(/^([WwSs])\s+(\d+)(?:\s+ADA)?$/i);
  if (wsMatch) {
    var prefix    = wsMatch[1].toUpperCase();
    var unitNum   = wsMatch[2];
    var canonical = prefix === 'W'
      ? '90 Wealthy Street SE, Grand Rapids, MI 49503'
      : '415 Sheldon Ave SE, Grand Rapids, MI 49503';
    var row = sheet2Map[normalizeAddrKey_(canonical)];
    if (!row) return { flag: true, reason: 'Sheet2 missing: ' + canonical };
    return makeResult_(parseFullAddress_(row.addy), unitNum, row);
  }

  // B. Cardinal Point — unit matches NNN-NNN
  var cpMatch = unit.match(/^(\d{3})-(\d{3})$/);
  if (cpMatch) {
    var streetNum = cpMatch[1];
    var unitPart  = String(parseInt(cpMatch[2]));
    var row = lookupByStreetNum_(streetNum, sheet2Map);
    if (!row) return { flag: true, reason: 'Sheet2 missing Cardinal Point: ' + streetNum };
    return makeResult_(parseFullAddress_(row.addy), unitPart, row);
  }

  // C. Eaglebrook — AppFolio property = "5943 8th Ave", unit = 4-digit-number + letter
  if (addr.indexOf('5943 8th Ave') >= 0) {
    var ebMatch = unit.match(/^(\d{4})([A-Za-z]{1,2})(?:\s+ADA)?$/i);
    if (ebMatch) {
      var row = lookupByStreetNum_(ebMatch[1], sheet2Map);
      if (!row) return { flag: true, reason: 'Sheet2 missing Eaglebrook: ' + ebMatch[1] };
      return makeResult_(parseFullAddress_(row.addy), ebMatch[2].toUpperCase(), row);
    }
  }

  // D. IVA codes — unit like "1960 IVA06"
  var ivaMatch = unit.match(/^(\d{4})\s+IVA(\d+)$/i);
  if (ivaMatch) {
    var unitNum = String(parseInt(ivaMatch[2]));
    var row = lookupByStreetNum_(ivaMatch[1], sheet2Map);
    if (!row) return { flag: true, reason: 'Sheet2 missing IVA: ' + ivaMatch[1] };
    return makeResult_(parseFullAddress_(row.addy), unitNum, row);
  }

  // E. Address-prefixed unit — unit starts with a DIFFERENT 4-digit street number
  var unitNumM = unit.match(/^(\d{4,})\s+/);
  if (unitNumM) {
    var embeddedNum = unitNumM[1];
    var propNum     = (addr.match(/^(\d+)/) || [null, null])[1];
    if (embeddedNum !== propNum) {
      var apResult = tryAddressPrefixedLookup_(embeddedNum, unit, sheet2Map);
      if (apResult) return makeResult_(parseFullAddress_(apResult.row.addy), apResult.unit, apResult.row);
      return { flag: true, reason: 'No Sheet2 match for embedded address: ' + embeddedNum };
    }
  }

  // Standard direct lookup
  var row = sheet2Map[normalizeAddrKey_(addr)];
  if (!row) return { flag: true, reason: 'No Sheet2 match for: ' + addr };

  var unitSuffix = decodeUnit_(row, unit);
  return makeResult_(parseFullAddress_(row.addy), unitSuffix, row);
}

function makeResult_(parsed, unit, row) {
  return {
    street:   parsed.street,
    unit:     unit,
    city:     parsed.city,
    state:    parsed.state,
    zip:      parsed.zip,
    owner:    row.owner,
    pm:       row.pm,
    sheetKey: normalizeAddrKey_(row.addy),
    flag:     false,
  };
}

// Find Sheet2 row whose key starts with "streetNum|". Matches on house number
// alone, so two properties sharing a leading number (e.g. "411 College Ave SW"
// vs "411 Paris Ave SE") are ambiguous — fail safe (null, same as no match)
// instead of silently guessing whichever row happens to come first in the
// sheet, and log it so an ambiguity is diagnosable instead of invisible.
function lookupByStreetNum_(streetNum, sheet2Map) {
  var prefix  = streetNum + '|';
  var matches = Object.keys(sheet2Map).filter(function(k) { return k.indexOf(prefix) === 0; });
  if (matches.length > 1) {
    Logger.log('AMBIGUOUS street number ' + streetNum + ': ' +
               matches.map(function(k) { return sheet2Map[k].addy; }).join(' | '));
    return null;
  }
  return matches.length === 1 ? sheet2Map[matches[0]] : null;
}

// Handle address-prefixed units: "2715 McKee Ave SW 16" → row for 2715 McKee, unit "16"
function tryAddressPrefixedLookup_(embeddedNum, rawUnit, sheet2Map) {
  var row = lookupByStreetNum_(embeddedNum, sheet2Map);
  if (!row) return null;
  var tokens    = rawUnit.trim().split(/\s+/);
  var lastToken = tokens[tokens.length - 1];
  var unitVal   = /^\d+$/.test(lastToken) ? String(parseInt(lastToken)) : lastToken;
  return { row: row, unit: unitVal };
}

function decodeUnit_(row, rawUnit) {
  if (row.units <= 1) return '';
  return extractUnitCore_(rawUnit);
}

function extractUnitCore_(rawUnit) {
  var u = rawUnit.trim();

  // Strip "Unit #?", "Apt.? #?" prefix
  var stripped = u.replace(/^(unit\s*#?|apt\.?\s*#?|apartment\s*#?)\s*/i, '').trim();
  if (stripped !== u && stripped.length > 0) return stripped;

  // Multi-token starting with digit → last token is unit
  var tokens = u.split(/\s+/);
  if (tokens.length > 1 && /^\d/.test(tokens[0])) {
    var last = tokens[tokens.length - 1];
    return /^\d+$/.test(last) ? String(parseInt(last)) : last;
  }

  // Multi-token, last token is numeric
  if (tokens.length > 1) {
    var last = tokens[tokens.length - 1];
    if (/^\d+$/.test(last)) return String(parseInt(last));
  }

  // Pure numeric, possibly zero-padded
  if (/^\d+$/.test(u)) return String(parseInt(u));

  return u;
}


// ============================================================
// FORM DATA BUILDER
// ============================================================
function buildFormData_(row, directory, date, sheet2Map, directoryKeyCache) {
  // row.unit (decoded, e.g. "5A") not row.rawUnit ("Unit 5A") — the Tenant Directory's
  // Unit column is already bare like the decoded form, not AppFolio's raw prefixed value.
  // Co-signers are never named/served on the notice — only Financially Responsible occupants.
  var allTenants = lookupAllTenants_(row.sheetKey, row.unit, directory, sheet2Map, directoryKeyCache)
    .filter(function(t) { return normalizeForMatch_(t.tenantType) !== 'co-signer'; });

  var primaryFmt = formatName_(row.primaryName);
  var otherNames = allTenants
    .filter(function(t) {
      return normalizeForMatch_(t.tenant) !== normalizeForMatch_(row.primaryName);
    })
    .map(function(t) { return formatName_(t.tenant); });

  var tenantNames = [primaryFmt].concat(otherNames).join(', ');

  var emails = allTenants
    .map(function(t) { return (t.email || '').trim(); })
    .filter(function(e, i, arr) { return e && arr.indexOf(e) === i; }); // non-blank, deduped

  return {
    tenant_names:  tenantNames,
    street:        row.street,
    unit:          row.unit,
    city:          row.city,
    state:         row.state,
    zip:           row.zip,
    landlord_name: row.owner,
    amount:        row.amount,
    served_on:     tenantNames,
    // Fills the PDF's "electronic service address" field — checked in place of
    // first class mail (main.py's CHECKBOX_ON/OFF) since notices are now served
    // electronically. Co-signers excluded above, so this matches tenant_names.
    electronic_service_email: emails.join(', '),
    // Fills the PDF's "Date" and "Date of Certificate Of Service" fields
    // (main.py's fill_form reads data.notice_date). Previously never sent
    // by either the scheduled or on-demand path — both left this blank
    // on every filed DC 100a until 2026-09-09. Pinned to America/New_York
    // (Eastern) explicitly rather than relying on the script's project
    // timezone, so this stays correct even if that ever changes.
    notice_date:   Utilities.formatDate(date || new Date(), 'America/New_York', 'MM/dd/yyyy'),
  };
}

// All tenant types included (Responsible, Cosigner, Non-Responsible)
// Tenant Directory "Property" values are AppFolio nicknames — either the full
// address on its own (e.g. "11075 52nd Ave Allendale, MI 49401") or a friendly
// label with the full address repeated after it (e.g. "The Oakwood - 547
// Cherry St SE Grand Rapids, MI 49503", "Cardinal Point - 445 Knapp St NE
// Grand Rapids, MI 49505"). Strip to the address portion (after the last
// " - ", if present) and run it through the same normalizeAddrKey_ every
// other address in this file resolves through — full street-number+name key,
// not just the number, so unlike a house-number-only lookup this can't
// collide with an unrelated property that happens to share a leading number.
function resolveDirectoryPropertyKey_(propertyNickname, sheet2Map, cache) {
  if (Object.prototype.hasOwnProperty.call(cache, propertyNickname)) return cache[propertyNickname];

  var dashIdx  = propertyNickname.lastIndexOf(' - ');
  var addrPart = dashIdx >= 0 ? propertyNickname.slice(dashIdx + 3) : propertyNickname;

  var key = normalizeAddrKey_(addrPart);
  if (key && !sheet2Map[key]) key = null; // parsed but no matching Sheet2 row — don't guess further

  cache[propertyNickname] = key; // cache misses too (null) to avoid re-parsing
  return key;
}

// "N/A" (single-unit properties in the Tenant Directory) should match the
// decoded '' unit decodeUnit_ produces for single-unit Sheet2 rows.
function normalizeUnitForMatch_(u) {
  var s = (u || '').toLowerCase().trim();
  return (s === 'n/a' || s === 'na') ? '' : s;
}

function lookupAllTenants_(sheetKey, unit, directory, sheet2Map, directoryKeyCache) {
  var unitNorm = normalizeUnitForMatch_(unit);
  return directory.filter(function(entry) {
    if (!entry.tenant) return false;
    if (resolveDirectoryPropertyKey_(entry.property, sheet2Map, directoryKeyCache) !== sheetKey) return false;
    return normalizeUnitForMatch_(entry.unit) === unitNorm;
  });
}


// ============================================================
// PM EMAIL DELIVERY
// ============================================================

// "Jody Betsch" → "PM_EMAIL_JODY_BETSCH"
function pmEmailKey_(pmName) {
  return 'PM_EMAIL_' + pmName.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_');
}

function chunkBlobs_(blobs) {
  var LIMIT   = 20 * 1024 * 1024;
  var batches = []; var sizes = []; var current = []; var curSize = 0;
  blobs.forEach(function(blob) {
    var sz = blob.getBytes().length;
    if (current.length > 0 && curSize + sz > LIMIT) { batches.push(current); sizes.push(curSize); current = []; curSize = 0; }
    current.push(blob); curSize += sz;
  });
  if (current.length > 0) { batches.push(current); sizes.push(curSize); }
  return { batches: batches, totalSize: sizes.reduce(function(s,x){return s+x;},0) };
}

function sendPMEmails_(pmBlobs, flaggedRows, errors, missingLabels, date, meta) {
  meta = meta || {};
  var adminEmail = cfg_('ADMIN_EMAIL');
  var dateStr    = Utilities.formatDate(date, Session.getScriptTimeZone(), 'MMMM d, yyyy');

  // Chunk blobs once per PM — reused for both sending and admin summary (getBytes called once)
  var pmChunks = {};
  Object.keys(pmBlobs).forEach(function(pm) { pmChunks[pm] = chunkBlobs_(pmBlobs[pm]); });

  Object.keys(pmChunks).forEach(function(pm) {
    var email = cfg_(pmEmailKey_(pm));
    if (!email) {
      Logger.log('No email set for PM: ' + pm + ' (' + pmEmailKey_(pm) + ') — skipped.');
      return;
    }
    var result = pmChunks[pm];
    var total  = pmBlobs[pm].length;
    result.batches.forEach(function(batch, idx) {
      var part = result.batches.length > 1 ? ' (Part ' + (idx + 1) + ' of ' + result.batches.length + ')' : '';
      GmailApp.sendEmail(
        email,
        'Demand for Possession — ' + total + ' notices — ' + dateStr + part,
        total + ' Demand for Possession form(s) attached — ' + dateStr + '.',
        { attachments: batch }
      );
    });
    Logger.log('Emailed ' + pm + ': ' + total + ' form(s) in ' + result.batches.length + ' email(s), ' +
               (result.totalSize / (1024 * 1024)).toFixed(1) + ' MB');
  });

  if (!adminEmail) return;

  var totalSent = Object.keys(pmBlobs).reduce(function(sum, pm) { return sum + pmBlobs[pm].length; }, 0);
  var hasIssues = errors.length > 0 || flaggedRows.length > 0 || missingLabels.length > 0;

  var summary = meta.manual
    ? 'Manual delinquency filing — initiated by ' + meta.initiator + ' — ' + dateStr + '\n\n'
    : 'Delinquency filing complete — ' + dateStr + '\n\n';
  if (meta.manual) summary += 'Threshold used: $' + Number(meta.threshold).toFixed(2) + '\n';
  if (meta.manual && meta.deselected > 0) summary += meta.deselected + ' row(s) met the threshold but were unchecked by the PM and NOT filed.\n';
  summary += 'PDFs sent: ' + totalSent + '\n';
  Object.keys(pmChunks).forEach(function(pm) {
    var result = pmChunks[pm];
    var sizeMB = (result.totalSize / (1024 * 1024)).toFixed(1);
    summary += '  • ' + pm + ': ' + pmBlobs[pm].length + ' notice(s), ' + sizeMB + ' MB';
    if (result.batches.length > 1) summary += ' (' + result.batches.length + ' emails)';
    summary += '\n';
  });

  if (missingLabels.length > 0) {
    summary += '\n⚠️ MISSING EMAILS — these AppFolio emails were not found in the inbox today.\n';
    summary += 'Those properties were NOT filed. Check if AppFolio sent them or if they arrived late.\n';
    missingLabels.forEach(function(l) { summary += '  • ' + l + '\n'; });
  }

  if (errors.length > 0) {
    summary += '\n' + errors.length + ' PDF(s) failed to generate and were NOT sent:\n';
    errors.forEach(function(e) { summary += '  • ' + e.name + ': ' + e.reason + '\n'; });
  }

  if (flaggedRows.length > 0) {
    summary += '\n' + flaggedRows.length + ' row(s) could not be matched to Sheet2 and were NOT filed:\n\n';
    flaggedRows.forEach(function(f) {
      summary += '• ' + f.name + '\n  Address: ' + f.rawAddr + '\n  Unit: ' + f.rawUnit +
                 '\n  Reason: ' + f.reason + '\n\n';
    });
    summary += 'Fix: add or update the matching row in Delinquency Info Sheet2, then re-run.';
  }

  var subjectPrefix = meta.manual ? '[Manual — ' + meta.initiator + '] ' : '';
  var subject = subjectPrefix + (hasIssues
    ? '⚠️ Delinquency Filed — ' + totalSent + ' sent' +
      (missingLabels.length > 0 ? ', ' + missingLabels.length + ' missing email(s)' : '') +
      (errors.length       > 0 ? ', ' + errors.length + ' failed'                  : '') +
      (flaggedRows.length  > 0 ? ', ' + flaggedRows.length + ' unfiled'            : '') +
      ' — ' + dateStr
    : 'Delinquency Filed — ' + totalSent + ' notices sent — ' + dateStr);

  GmailApp.sendEmail(adminEmail, subject, summary);
  Logger.log('Admin confirmation sent to: ' + adminEmail);
}


// ============================================================
// UTILITIES
// ============================================================

// "900 Leonard St NW Grand Rapids, MI 49504"  → { street:"900 Leonard St NW", city:"Grand Rapids", ... }
// "1960 Burton St SE, Grand Rapids, MI 49506" → { street:"1960 Burton St SE", city:"Grand Rapids", ... }
function parseFullAddress_(addr) {
  var s = String(addr).trim();
  // Anchor on ", ST ZIPCODE" — this part is always unambiguous
  var m = s.match(/^(.*),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!m) return { street: s, city: '', state: 'MI', zip: '' };
  var state = m[2], zip = m[3], front = m[1].trim();
  // If there's a comma in the remainder, last comma cleanly splits street from city
  var lastComma = front.lastIndexOf(',');
  if (lastComma >= 0) {
    return { street: front.slice(0, lastComma).trim(), city: front.slice(lastComma + 1).trim(), state: state, zip: zip };
  }
  // No comma (e.g. "900 Leonard St NW Grand Rapids"): match against known portfolio cities
  var CITIES = ['Grand Rapids', 'Grandville', 'Wyoming', 'Grand Haven', 'Holland', 'Kentwood', 'Walker', 'Comstock Park'];
  for (var i = 0; i < CITIES.length; i++) {
    if (front.endsWith(' ' + CITIES[i])) {
      return { street: front.slice(0, front.length - CITIES[i].length - 1).trim(), city: CITIES[i], state: state, zip: zip };
    }
  }
  // Fallback: treat last space-separated word as city
  var sp = front.lastIndexOf(' ');
  return sp >= 0
    ? { street: front.slice(0, sp).trim(), city: front.slice(sp + 1).trim(), state: state, zip: zip }
    : { street: front, city: '', state: state, zip: zip };
}

// "Kishawi, Yaser S." → "Yaser S. Kishawi"
function formatName_(n) {
  var idx = n.indexOf(',');
  if (idx < 0) return n.trim();
  return n.slice(idx + 1).trim() + ' ' + n.slice(0, idx).trim();
}

function normalizeForMatch_(name) {
  return name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

function formatAmount_(amount) {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}


// ============================================================
// CLOUD FUNCTION
// ============================================================
function callCloudFunction_(formData) {
  var url = cfg_('CLOUD_FUNCTION_URL');
  if (!url) throw new Error('CLOUD_FUNCTION_URL not set');
  var resp = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ data: formData }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200)
    throw new Error('Cloud Function ' + resp.getResponseCode() + ': ' + resp.getContentText());
  var json = JSON.parse(resp.getContentText());
  if (!json.filledPdf) throw new Error('No filledPdf in response');
  return json.filledPdf;
}


// ============================================================
// PDF BLOB — in memory only, no Drive save
// ============================================================
function makePDFBlob_(pdfB64, row, date) {
  var dateStr  = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var lastName = row.primaryName.split(',')[0].trim().replace(/\s+/g, '_');
  var unitPart = row.unit ? '_Unit' + row.unit.replace(/\s+/g, '') : '';
  var filename = 'Demand_' + lastName + unitPart + '_' + dateStr + '.pdf';
  return Utilities.newBlob(Utilities.base64Decode(pdfB64), 'application/pdf', filename);
}


// ============================================================
// WEB APP — on-demand filing portal for property managers
// Deployed as a Web App (executeAs: me, access: domain). Runs across ALL
// properties (Standard + Victory on Leonard) in one pass, against the
// most recent report in the inbox, at a PM-chosen dollar threshold.
// ============================================================
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('GPM Delinquency Filing')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function webGetPmList() {
  return PM_LIST;
}

// CacheService rejects any single value over 100KB ("Argument too large:
// value") — the full tenant directory across all 6 properties blows past
// that easily. These helpers transparently chunk a JSON payload across
// multiple cache keys so the caller doesn't have to think about the limit.
var CACHE_CHUNK_SIZE = 90000;

function cachePutJSON_(token, obj) {
  var str   = JSON.stringify(obj);
  var cache = CacheService.getScriptCache();
  var chunkCount = Math.max(1, Math.ceil(str.length / CACHE_CHUNK_SIZE));
  for (var i = 0; i < chunkCount; i++) {
    cache.put(token + '_' + i, str.slice(i * CACHE_CHUNK_SIZE, (i + 1) * CACHE_CHUNK_SIZE), 1800);
  }
  cache.put(token + '_meta', String(chunkCount), 1800);
}

function cacheGetJSON_(token) {
  var cache    = CacheService.getScriptCache();
  var countStr = cache.get(token + '_meta');
  if (!countStr) return null;
  var count = parseInt(countStr, 10);
  var str   = '';
  for (var i = 0; i < count; i++) {
    var part = cache.get(token + '_' + i);
    if (part === null) return null; // one chunk expired — treat whole thing as gone
    str += part;
  }
  return JSON.parse(str);
}

function cacheRemoveJSON_(token) {
  var cache    = CacheService.getScriptCache();
  var countStr = cache.get(token + '_meta');
  var count    = countStr ? parseInt(countStr, 10) : 0;
  var keys     = [token + '_meta'];
  for (var i = 0; i < count; i++) keys.push(token + '_' + i);
  cache.removeAll(keys);
}

// Shrinks the tenant directory to just the units that actually have a
// delinquent row — the only entries buildFormData_ will ever look up —
// instead of caching every tenant company-wide.
function filterRelevantDirectory_(directory, resolvedRows, sheet2Map, directoryKeyCache) {
  var wanted = {};
  resolvedRows.forEach(function(row) {
    wanted[row.sheetKey + '|' + normalizeUnitForMatch_(row.unit)] = true;
  });
  return directory.filter(function(entry) {
    var key = resolveDirectoryPropertyKey_(entry.property, sheet2Map, directoryKeyCache);
    return wanted[key + '|' + normalizeUnitForMatch_(entry.unit)];
  });
}

// Fetches the latest report, resolves + filters it, and returns a preview
// for the PM to confirm. Nothing is filed yet. Resolved rows are cached
// under a token so "Let's File" re-uses exactly what was previewed instead
// of re-fetching (which could pick up a different "latest" email).
function webPreview(thresholdRaw, initiator) {
  var threshold = parseFloat(thresholdRaw);
  if (isNaN(threshold) || threshold < 0) throw new Error('Enter a valid dollar threshold.');
  if (PM_LIST.indexOf(initiator) < 0) throw new Error('Select who is initiating this filing.');

  var sheet2Map = loadSheet2_();
  if (!sheet2Map) throw new Error('Could not load the property directory (Sheet2). Try again or contact admin.');

  var attachments = findEmailAttachmentsBySubject_(ALL_LABELS, true);
  if (!attachments.delinquencyText) {
    throw new Error('No delinquency report found in the inbox for any property yet.');
  }

  var directory   = attachments.directoryText ? parseTenantDirectory_(attachments.directoryText) : [];
  var delinquents = parseDelinquencyCSV_(attachments.delinquencyText, sheet2Map, false, threshold);

  // PMs only see their own properties (Sheet2 PM column). ADMIN_INITIATORS bypass this
  // and see everything, but filed notices still route to each row's actual Sheet2 PM.
  var isAdmin = ADMIN_INITIATORS.indexOf(initiator) >= 0;
  var resolvedForPM = isAdmin
    ? delinquents.resolved
    : delinquents.resolved.filter(function(row) { return row.pm === initiator; });

  var directoryKeyCache = {};
  var relevantDir = filterRelevantDirectory_(directory, resolvedForPM, sheet2Map, directoryKeyCache);

  var token = Utilities.getUuid();
  cachePutJSON_(token, {
    threshold:     threshold,
    initiator:     initiator,
    directory:     relevantDir,
    resolved:      resolvedForPM,
    flagged:       delinquents.flagged,
    missingLabels: attachments.missingLabels,
  }); // 30 min TTL — long enough to review, short enough to force a refetch if stale

  return {
    token:         token,
    threshold:     threshold,
    rows: resolvedForPM.map(function(row) {
      return {
        name:    row.primaryName,
        address: row.street + (row.unit ? ', Unit ' + row.unit : '') + ', ' + row.city + ', ' + row.state + ' ' + row.zip,
        amount:  row.amount,
      };
    }),
    flagged: delinquents.flagged.map(function(f) {
      return { name: f.name, address: f.rawAddr, unit: f.rawUnit, reason: f.reason };
    }),
    missingLabels: attachments.missingLabels,
  };
}

// Files only the rows the PM checked in the preview (selectedIndices —
// positions into the resolved array webPreview returned, same order as
// the `rows` list shown in the UI), using the cached token.
function webConfirmFiling(token, selectedIndices) {
  var data = cacheGetJSON_(token);
  if (!data) throw new Error('This preview has expired. Please refresh and try again.');
  cacheRemoveJSON_(token);

  var indices = Array.isArray(selectedIndices) ? selectedIndices : [];
  var toFile  = indices
    .map(function(i) { return data.resolved[i]; })
    .filter(function(row) { return !!row; });
  if (toFile.length === 0) throw new Error('No units were selected to file.');

  var today   = new Date();
  var pmBlobs = {};
  var errors  = [];
  var sheet2Map = loadSheet2_();
  var directoryKeyCache = {};

  toFile.forEach(function(row) {
    try {
      var formData = buildFormData_(row, data.directory, today, sheet2Map, directoryKeyCache);
      var pdfB64   = callCloudFunction_(formData);
      var blob     = makePDFBlob_(pdfB64, row, today);
      // Route to whoever initiated this on-demand filing, not the row's Sheet2 PM —
      // for non-admins these are always the same person (webPreview filters to their
      // own rows); for ADMIN_INITIATORS this sends the notice to the admin instead of
      // silently emailing the property's actual PM.
      var pm = data.initiator;
      if (!pmBlobs[pm]) pmBlobs[pm] = [];
      pmBlobs[pm].push(blob);
    } catch (e) {
      errors.push({ name: row.primaryName, reason: e.message });
    }
  });

  sendPMEmails_(pmBlobs, data.flagged, errors, data.missingLabels, today, {
    manual:      true,
    initiator:   data.initiator,
    threshold:   data.threshold,
    deselected:  data.resolved.length - toFile.length,
  });

  return {
    filed:  Object.keys(pmBlobs).reduce(function(s, k) { return s + pmBlobs[k].length; }, 0),
    errors: errors.length,
  };
}


// ============================================================
// SETUP — one daily dispatcher trigger at 9 AM ET
// Replaces the old fixed onMonthDay(4)/onMonthDay(6) triggers, which fired
// on those calendar days even on a weekend/court holiday when nobody could
// actually file. Now a single daily trigger checks whether TODAY is the
// effective filing day (the 4th/6th, or — if that date falls on a weekend
// or a court holiday — the next court business day), and runs using that
// day's date and that day's AppFolio data, same as any other scheduled run.
// ============================================================
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runVictoryFiling' || fn === 'runStandardFiling' || fn === 'dailyFilingCheck_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('dailyFilingCheck_')
    .timeBased().everyDays(1).atHour(9).inTimezone('America/Detroit').create();
  Logger.log('Trigger installed: dailyFilingCheck_ daily at 9 AM Eastern — fires runVictoryFiling ' +
             'on the effective 4th and runStandardFiling on the effective 6th (weekend/holiday-shifted).');
}

// Called by the daily trigger. Fires the real filing functions only on
// their effective day (see effectiveFilingDate_ below); a no-op every
// other day.
function dailyFilingCheck_() {
  var today = new Date();
  if (sameDate_(today, effectiveFilingDate_(4, today))) runVictoryFiling();
  if (sameDate_(today, effectiveFilingDate_(6, today))) runStandardFiling();
}

// The day a filing scheduled for `targetDay` of the month actually runs:
// targetDay itself, unless that date is a weekend or court holiday, in
// which case it rolls forward to the next court business day (handles
// cascading cases too, e.g. a Sunday 6th that rolls into a Monday holiday
// rolls again to Tuesday).
function effectiveFilingDate_(targetDay, monthDate) {
  var d = new Date(monthDate.getFullYear(), monthDate.getMonth(), targetDay);
  return nextCourtBusinessDay_(d);
}

function sameDate_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function nextCourtBusinessDay_(date) {
  var d = new Date(date);
  while (!isCourtBusinessDay_(d)) d.setDate(d.getDate() + 1);
  return d;
}

function isCourtBusinessDay_(date) {
  var dow = date.getDay();
  if (dow === 0 || dow === 6) return false; // Sun/Sat
  return !isCourtHoliday_(date);
}

// Standard federal holiday list (Michigan courts follow this). Edit here
// if GPM's filing venues observe a different set.
function isCourtHoliday_(date) {
  var y   = date.getFullYear();
  var m   = date.getMonth();
  var day = date.getDate();
  var md  = function(mm, dd) { return m === mm && day === dd; };
  var nthWeekday = function(month, weekday, n) {
    var d = new Date(y, month, 1);
    var count = 0;
    while (true) {
      if (d.getDay() === weekday) { count++; if (count === n) return d.getDate(); }
      d.setDate(d.getDate() + 1);
    }
  };
  var lastWeekday = function(month, weekday) {
    var d = new Date(y, month + 1, 0); // last day of month
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d.getDate();
  };
  if (md(0, 1))                             return true;  // New Year's Day
  if (m === 0  && day === nthWeekday(0, 1, 3))  return true;  // MLK Day — 3rd Mon Jan
  if (m === 1  && day === nthWeekday(1, 1, 3))  return true;  // Presidents Day — 3rd Mon Feb
  if (m === 4  && day === lastWeekday(4, 1))    return true;  // Memorial Day — last Mon May
  if (md(5, 19))                            return true;  // Juneteenth
  if (md(6, 4))                             return true;  // Independence Day
  if (m === 8  && day === nthWeekday(8, 1, 1))  return true;  // Labor Day — 1st Mon Sep
  if (md(10, 11))                           return true;  // Veterans Day
  if (m === 10 && day === nthWeekday(10, 4, 4)) return true;  // Thanksgiving — 4th Thu Nov
  if (md(11, 25))                           return true;  // Christmas Day
  return false;
}


// ============================================================
// LAUNCH HEALTH CHECK — one-time, self-deleting, 3 days only
// Run installHealthCheckTriggers() ONCE from the editor (Run menu) to
// verify the on-demand pipeline: did today's AppFolio emails arrive, and
// did they parse into the expected columns? No infra beyond this script
// is needed — it reuses the same Gmail access and ADMIN_EMAIL already
// configured for filing. Each trigger is one-time (.at(date)) so it fires
// once and Apps Script removes it automatically — nothing to clean up
// after day 3, and no calendar-style upkeep in the meantime.
// ============================================================
function installHealthCheckTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkInboxHealth') ScriptApp.deleteTrigger(t);
  });
  for (var i = 1; i <= 3; i++) {
    var d = new Date();
    d.setDate(d.getDate() + i);
    d.setHours(10, 0, 0, 0); // 10 AM script timezone (America/Detroit) — after AppFolio's morning send
    ScriptApp.newTrigger('checkInboxHealth').timeBased().at(d).create();
  }
  Logger.log('Installed 3 one-time checkInboxHealth triggers, 10 AM ET each of the next 3 days. Each self-deletes after firing.');
}

// Checks every property label for today's Delinquency + Tenants email,
// and sanity-checks the CSV shape (right number of columns) without
// filing anything. Emails a pass/fail summary to ADMIN_EMAIL. Safe to
// run manually any time — this is also the function the 3-day triggers
// call, and what to run by hand tomorrow to check today's emails now.
function checkInboxHealth() {
  var sender  = cfg_('APPFOLIO_EMAIL_SENDER') || 'appfolio.com';
  var today   = new Date();
  var dateStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'MMMM d, yyyy');
  var lines   = [];
  var allOk   = true;

  ALL_LABELS.forEach(function(label) {
    var dQuery = 'from:(' + sender + ') subject:"' + label + ' Delinquency"';
    var tQuery = 'from:(' + sender + ') subject:"' + label + ' Tenants"';
    var dText  = extractFirstCSV_(GmailApp.search(dQuery, 0, 10), today);
    var tText  = extractFirstCSV_(GmailApp.search(tQuery, 0, 10), today);

    if (!dText) { allOk = false; lines.push('✗ ' + label + ' Delinquency — NOT received today'); }
    else {
      var dCheck = checkCSVShape_(dText, DCOL);
      if (!dCheck.ok) { allOk = false; lines.push('⚠️ ' + label + ' Delinquency — received but ' + dCheck.reason); }
      else lines.push('✓ ' + label + ' Delinquency — ' + dCheck.rowCount + ' row(s), parsed OK');
    }

    if (!tText) { allOk = false; lines.push('✗ ' + label + ' Tenants — NOT received today'); }
    else {
      var tCheck = checkCSVShape_(tText, TCOL);
      if (!tCheck.ok) { allOk = false; lines.push('⚠️ ' + label + ' Tenants — received but ' + tCheck.reason); }
      else lines.push('✓ ' + label + ' Tenants — ' + tCheck.rowCount + ' row(s), parsed OK');
    }
  });

  var subject = (allOk ? '✅' : '⚠️') + ' Delinquency inbox check — ' + dateStr;
  var body    = 'Daily post-launch inbox/parse check (auto-expires after 3 days — see installHealthCheckTriggers).\n\n' + lines.join('\n');

  var adminEmail = cfg_('ADMIN_EMAIL');
  if (adminEmail) GmailApp.sendEmail(adminEmail, subject, body);
  Logger.log(body);
}

// Confirms a CSV's header row has the columns a given COL map expects.
function checkCSVShape_(text, colMap) {
  var rows = Utilities.parseCsv(text);
  if (rows.length < 1) return { ok: false, reason: 'empty file' };
  var maxCol = 0;
  Object.keys(colMap).forEach(function(k) { if (colMap[k] > maxCol) maxCol = colMap[k]; });
  if (rows[0].length <= maxCol) {
    return { ok: false, reason: 'only ' + rows[0].length + ' column(s) in header, expected at least ' + (maxCol + 1) };
  }
  return { ok: true, rowCount: Math.max(0, rows.length - 1) };
}


// ============================================================
// TEST HELPERS
// ============================================================

// Verify address resolution against known Sheet2 expected outputs
function testAddressResolution() {
  var sheet2Map = loadSheet2_();
  if (!sheet2Map) { Logger.log('Cannot load Sheet2'); return; }

  var cases = [
    ['Numeric unit (Leonard)',       '900 Leonard St NW Grand Rapids, MI 49504',     '316',                  '900 Leonard', '316'],
    ['Eaglebrook 4-digit+letter',    '5943 8th Ave Grandville, MI 49418',            '6029G',                '6029 8th Ave', 'G'],
    ['Wealthy W-prefix',             '90 Wealthy Street SE, Grand Rapids, MI 49503', 'W 401',                '90 Wealthy', '401'],
    ['Sheldon S-prefix',             '90 Wealthy Street SE, Grand Rapids, MI 49503', 'S 402',                '415 Sheldon', '402'],
    ['Cardinal Point same building', '445 Knapp St NE Grand Rapids, MI 49505',       '445-102',              '445 Knapp', '102'],
    ['Cardinal Point alt building',  '445 Knapp St NE Grand Rapids, MI 49505',       '453-202',              '453 Knapp', '202'],
    ['IVA code',                     '1960 Burton St SE, Grand Rapids, MI 49506',    '1960 IVA06',           '1960 Burton', '6'],
    ['Address-prefixed (McKee)',     '2700 Clyde Park Ave SW Wyoming, MI 49509',     '2715 McKee Ave SW 16', '2715 McKee', '16'],
    ['Address-same-num (Clyde Pk)',  '2700 Clyde Park Ave SW Wyoming, MI 49509',     '2700 Clyde Park Ave SW 25', '2700 Clyde', '25'],
    ['Zero-padded unit',             '258 Quimby St NE Grand Rapids, MI 49505',      '02',                   '258 Quimby', '2'],
  ];

  var passed = 0; var failed = 0;
  cases.forEach(function(c) {
    var r  = resolveAddress_(c[1], c[2], sheet2Map);
    var ok = r && !r.flag &&
             r.street.toLowerCase().indexOf(c[3].toLowerCase()) >= 0 &&
             r.unit === c[4];
    if (ok) {
      Logger.log('✓ ' + c[0]);
      passed++;
    } else {
      Logger.log('✗ ' + c[0] + ' | street=' + (r ? r.street : 'null') +
                 ' unit=' + (r ? r.unit : 'null') + ' flag=' + (r ? r.flag : 'N/A') +
                 (r && r.reason ? ' reason=' + r.reason : ''));
      failed++;
    }
  });
  Logger.log('--- ' + passed + ' passed, ' + failed + ' failed ---');
}

// Verify one form end-to-end against the Cloud Function — emails result to ADMIN_EMAIL
function testSingleTenant() {
  var formData = {
    tenant_names:  'Yaser S. Kishawi',
    street:        '900 Leonard St NW',
    unit:          '316',
    city:          'Grand Rapids',
    state:         'MI',
    zip:           '49504',
    landlord_name: '900 W Leonard LLC',
    amount:        '3,300.00',
    served_on:     'Yaser S. Kishawi',
    notice_date:   Utilities.formatDate(new Date(), 'America/New_York', 'MM/dd/yyyy'),
  };
  var pdfB64 = callCloudFunction_(formData);
  var blob   = Utilities.newBlob(Utilities.base64Decode(pdfB64), 'application/pdf', 'TEST_Kishawi_Unit316.pdf');
  var admin  = cfg_('ADMIN_EMAIL');
  if (!admin) { Logger.log('Set ADMIN_EMAIL to receive test PDF.'); return; }
  GmailApp.sendEmail(admin, 'TEST — Single Tenant PDF', 'Test PDF attached.', { attachments: [blob] });
  Logger.log('Test PDF emailed to: ' + admin);
}

// Full pipeline test — bypasses date check.
// Change mode to 'vol' to test Victory on Leonard (day-4 path).
function testFullRun() {
  var mode   = 'standard'; // ← change to 'vol' for Victory on Leonard
  var labels      = mode === 'vol' ? ['VoL'] : ['Jefferson', 'Oakwood', 'Pinery', 'IVA', 'AF11'];
  var skipVictory = mode !== 'vol';
  runFiling_(labels, skipVictory);
}

// Exercises the on-demand web app path (all properties, latest email,
// custom threshold) without going through the browser UI.
function testOnDemandRun() {
  runFiling_(ALL_LABELS, false, {
    threshold: 100,
    useLatest: true,
    meta: { manual: true, initiator: 'Jody Betsch', threshold: 100 },
  });
}
