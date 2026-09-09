# P11 — Delinquency Filing Automation

Google Apps Script + Cloud Function pipeline that fills and sends Michigan
DC 100a (Demand for Possession — Nonpayment of Rent) forms for Green
Property Mgt.

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
