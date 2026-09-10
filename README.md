# MHL Drug Course Chart — Svelte rebuild

This is a SvelteKit rebuild of the original React app (`68-drug-course`), a
patient ward-charting app for 68 NARHY, being ported over page by page.

## Stack

- SvelteKit (Svelte 5, runes), built as a static SPA via `@sveltejs/adapter-static`
  with `fallback: 'index.html'` — same client-only deploy model as the
  original Vite + React app (Firebase Auth/Firestore need the browser, so
  SSR is off, see `src/routes/+layout.js`).
- Firebase (Auth + Firestore, offline persistence with multi-tab cache)
- Chart.js, jsPDF (installed, not yet wired up to a ported page)

## Run it

```
npm install
npm run dev
```

## Build

```
npm run build   # outputs to /build as a static SPA
npm run preview
```

## Port status

**Fully ported and working:**
- Firebase client setup, Auth store, Theme store, Nav store
  (`src/lib/firebase.js`, `src/lib/stores/*.svelte.js`)
- App shell: root layout with the auth guard (loading / signed-out / error
  states), Topbar, NavDrawer
- Login page (email/password + password reset)
- **Drug Course Chart** (`/charts/drug-course-chart`) — the flagship page.
  Loads/saves to Firestore with debounced autosave, drugs list with edit
  mode and a custom-frequency modal, the administration chart with a
  Drug-S/N picker (including "not given" reasons), bulk drug upload/parse,
  verbal orders, care instructions, and an audit log — all with the same
  data model as the original so it reads/writes the same Firestore
  documents.
- **Home** (`/`) — search, ward patient list with PEDIATRIC/NICU Bed/Cot
  split, register new patient (incl. Paste from EMR parsing), admin CSV
  bulk upload, incoming ward-transfer queue, exit-on-double-back.
- **My Patients** (`/my-patients`) — allocated-patient list with remove
  action.
- **Patient** (`/patient`) — banner (name/EMR/diagnosis/allergy alert),
  edit-patient form, allocate/unallocate, Patient Status (discharge /
  transfer / refer, archiving all charts for the admission to Overview),
  and the chart-grid links into the five per-patient charts.
- **Vitals, Seizure, Intake & Output** (`/charts/vitals`,
  `/charts/seizure`, `/charts/intake-output`) — all three are thin configs
  on a new shared `EntryChart.svelte` component (grouped/gated fields,
  select+Other textareas, popup cells, abnormal-value flagging, live vs.
  archived-admission data, auto-saved summary card for I&O's 24-hour
  balance).
- **Blood Glucose** (`/charts/blood-glucose`) — 6-point/3-point glycemic
  spreadsheet grid (not EntryChart-based, same as the original, since
  each row is a free-form array of cells rather than a keyed entry
  object): type toggle with separate cached rows per type, abnormal-range
  flagging, debounced autosave + manual Save, legacy short-row migration,
  archived read-only view.
- **Calculators, Lab Reference** (`/charts/calculators`,
  `/charts/lab-reference`) — thin pages that mount the vanilla-JS
  `calculators.js`/`labReference.js` modules (ported verbatim from
  MedIndex, same as the original React pages did) into a container div
  via `onMount`.
- Business-logic helpers (`src/lib/helpers/drugChartHelpers.js`,
  `firestoreOffline.js`, `patientAdmissionStatus.js`,
  `intakeOutputHelpers.js`, `avatar.js`, `wardCensus.js`, `wardTransfer.js`,
  `patientParse.js`, `patientCsv.js`, `wardNameMatch.js`,
  `nursesReportCommon.js`, `calculators.js`, `labReference.js`,
  `labs-data.js`) were ported verbatim — they're framework-agnostic JS,
  not React-specific.

- **Profile** (`/profile`) — current-ward switcher, edit name/phone/gender
  with the same avatar preview as the original, read-only email/role, and
  change-password (reauthenticate + `updatePassword`). Dose Due Alerts is a
  disabled placeholder here since push notifications/the service worker
  aren't ported yet (see below) — the original's toggle can't do anything
  useful without them.
- **Admin** (`/admin`) — create-nurse-account (via a secondary Firebase app
  so the admin's own session stays signed in), All Patients (filter +
  destructive delete with typed-EMR confirmation, wiping every chart
  subcollection first), All Users (subadmin toggle, delete via the
  `deleteUserAccount` Cloud Function with typed-email confirmation),
  Drug-Due Alarm Settings (sound/appearance/repeat/quiet-hours/per-frequency
  schedule/glycemic-reminder interval, shared `settings/alarm` Firestore
  doc), and Backup All Patients (on-demand full JSON export of every
  patient's active + archived admissions). Ported `alarm-settings.js`
  verbatim into `src/lib/helpers/`.
- **Overview** (`/charts/overview`) — per-patient admission history: the
  active admission (if it has any data) plus every archived admission,
  each linking into `/charts/admission`, and Export Full History as
  PDF or JSON across the patient's whole record. This is what completed
  `src/lib/helpers/export.js` — it now carries both halves of the original
  `export.js` (JSON gathering, shared by Admin's backup, plus the full
  jsPDF/jspdf-autotable report builder), so **PDF export is no longer a
  separate not-yet-ported item.**

- **Admission** (`/charts/admission`) — the hub page for one admission
  (active or archived): diagnosis + status badge, Readmit action for a
  discharged admission (guarded by an online check and a hasActiveData
  check so it can't clobber a newer admission already in progress), the
  five-chart grid, and per-admission Share/Print/Export (PDF/JSON).

- **Nurses Report** (`/nurses-report/*`) — Role Select, Ward Nurse (incl.
  the PAED WARD merged-panel selector), Analytics, Archive List, Archive
  View, and **Overall Nurse** (the All Wards 24-hour statistics table with
  admin ward/column renaming and custom columns, Patient Demographics
  totals, grouped Ward Reports for PAED WARD/MATERNITY WARD, per-ward
  lock toggle, nurse-on-duty contact popup, "Reset Occ from patient list",
  and Save to Archive). All ported onto the same `nursesReportCommon.js` /
  `useWardReport.svelte.js` helpers as Ward Nurse and Archive View, so
  overrides and Firestore doc shapes match everywhere.

**Not yet ported** (placeholder pages, linked from the nav so routing
doesn't break): push notifications and the service worker (dose-due
alerts), and the Capacitor Android wrapper.

**Intentionally deferred:** the Drug Course Chart's patient status-change
flow (referred / transferred / discharged) — in the original this reads
and archives Vitals, Glycemic, Intake & Output and Seizure charts together.
Those four now all exist in this app, so the flow is unblocked, but it's
still stubbed with a note in the UI pending its own pass.
