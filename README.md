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

**Not yet ported** (placeholder pages, linked from the nav so routing
doesn't break): Profile, Admin, Overview, Admission, the Nurses Report
section, PDF export, push notifications, the service worker, and the
Capacitor Android wrapper.

**Intentionally deferred:** the Drug Course Chart's patient status-change
flow (referred / transferred / discharged) — in the original this reads
and archives Vitals, Glycemic, Intake & Output and Seizure charts together,
none of which exist in this app yet. It's stubbed with a note in the UI
until those pages are built.
