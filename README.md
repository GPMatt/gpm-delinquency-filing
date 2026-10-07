# P11 — Delinquency Filing Automation

Google Apps Script + Cloud Function pipeline that fills and sends Michigan
DC 100a (Demand for Possession — Nonpayment of Rent) forms for Green
Property Management.

## Pieces

- **`Code.js`** — GAS orchestration: pulls the AppFolio delinquency + tenant
  directory CSVs from Gmail, resolves each row to a property via the
  "Delinquency Info" Sheet2, calls the Cloud Function to fill the official
  DC 100a PDF, and emails the results to the right PM.
- **`Index.html`** — the on-demand filing web app UI (see below).
- **`appsscript.json`** — manifest, including the Web App deployment config.
- Cloud Function source (Python, fills the PDF) lives separately in GCP
  project `delinquency-filing-497819`.

## Two ways filings happen

1. **Scheduled (automatic)** — `runVictoryFiling()` on the 4th and
   `runStandardFiling()` on the 6th of each month, 9 AM ET. Only fires
   against that day's report.
2. **On-demand (web app)** — PMs no longer have to wait for the schedule.
   Deploy as a Web App and open the URL: pick who's requesting it, set a
   $ threshold, preview the exact names/addresses/amounts about to be
   filed, then confirm. Runs across every property at once against the
   most recent report sitting in the inbox — not date-gated.

## Setup

Script Properties required (Project Settings → Script Properties):

| Property | Value |
|---|---|
| `CLOUD_FUNCTION_URL` | deployed Cloud Function endpoint |
| `APPFOLIO_EMAIL_SENDER` | e.g. `appfolio.com` |
| `SHEET2_ID` | "Delinquency Info" Sheet ID |
| `ADMIN_EMAIL` | receives flagged-row reports + confirmations |
| `PM_EMAIL_<NAME>` | one per PM (e.g. `PM_EMAIL_JODY_BETSCH`) |

Run `installTrigger()` once to enable the scheduled runs. Deploy → New
deployment → Web app (execute as: me, access: anyone within domain) to
enable the on-demand portal; update `PM_LIST` in `Code.js` if the roster
of initiating PMs changes.

## Post-launch inbox check

Run `installHealthCheckTriggers()` once from the editor to verify, for
the next 3 days, that each property's AppFolio emails actually arrive and
parse correctly — no new infra, it reuses this script's own Gmail access
and emails a pass/fail summary to `ADMIN_EMAIL` each day, then self-deletes.
Run `checkInboxHealth()` directly any time to check right now instead of
waiting for the next scheduled check.

## Who is named, and the pre-send check

Every notice names and serves everyone AppFolio lists on the lease for the
unit: Financially Responsible tenants first, then co-signers. All of their
email addresses go on the electronic-service line.

Before a notice is sent to a PM it has to pass a check. A notice that fails
is held: the PM does not get it, and the admin summary lists it with the
reason (the held form is attached there for reference). A notice is held when:

- nobody in the Tenant Directory matched the unit
- there is no email address for anyone named, or an address is malformed
- a required value is blank (name, address, owner, amount, date)
- a value will not print in full on the form, or has a character the form
  cannot print
- the court form itself has changed (a field or checkbox is missing)
- the filled PDF does not read back the way it was written

The web app preview runs the first two checks up front and shows, per row,
who will be named and which addresses will be served.

The Cloud Function writes each text field at the largest size that fits
(10pt down to 6pt) instead of leaving layout to the PDF viewer, which used
to clip long values. Deploy the Cloud Function before pushing `Code.js`:
`Code.js` holds every notice if the function does not return check results.

Tests, run before deploying a change to either side:

    node test/notice_checks.js
    python3 test/form_checks.py

## Address audit

One AppFolio property can cover several street addresses (28 and 30 Gold Ave SW, 16 and 18 Packard Ave SE).
Before deploying any change to address resolution, or after adding properties, replay every unit through the resolver:

```
node test/audit_addresses.js <Delinquency Info tab as CSV> <AppFolio Unit Directory CSV>
```

The Unit Directory export needs the columns Unit Name, Unit Street Address 1, Property. The script exits 1 if any
unit would be filed at the wrong street address or if two different units would be treated as one.
