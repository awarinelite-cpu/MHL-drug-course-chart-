// Ported from the `useWardReport` hook in src/pages/nurses-report/WardNurse.jsx
// (React). All of one ward's report state/logic — loading, editing, saving,
// submitting — with no rendering. useState -> $state, useMemo -> $derived,
// useEffect -> $effect. Returns a plain object of getters/methods (a
// Svelte 5 "custom hook" factory, same shape as the module-level stores in
// $lib/stores/*.svelte.js but instantiated per call instead of as a
// singleton) so WardReportPanel/MergedWardReportPanel can call it once per
// ward, same as the original's `useWardReport(wardKey, isAdmin, profile, user)`.
import {
  doc, getDocs, collection, query, where, orderBy, limit, setDoc, serverTimestamp
} from "firebase/firestore";
import { getDocSafe, getDocsSafe } from "./firestoreOffline.js";
import { db } from "../firebase.js";
import {
  WARDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS,
  PATIENT_STATUS_ARCHIVE_REASON,
  DEMOGRAPHIC_FIELDS, computeDemographicTotals, movementColorClass,
  reportDateId, occDelta, blankShift, defaultWardDoc,
  isWardDocUntouched
} from "./nursesReportCommon.js";
import { patientWardAndBedTypeForReportKey } from "./wardNameMatch.js";
import { wardHeadcount } from "./wardCensus.js";
import { applyPatientStatus, closeOutDischargedPatient } from "./patientAdmissionStatus.js";

export const movementFields = SHIFT_STAT_FIELDS;
const byKey = (k) => movementFields.find((f) => f.key === k);
export const SOLO_BEFORE = ["adm", "disch", "dama"].map(byKey);
export const SOLO_AFTER = ["sc", "vsc", "absc", "bid", "death"].map(byKey);
export const TRANSFER_PAIR = [byKey("transferIn"), byKey("transferOut")];
export const EXT_PAIR = [byKey("ext"), byKey("extOut")];
export const ORDERED_MOVEMENT = [...SOLO_BEFORE, ...TRANSFER_PAIR, ...EXT_PAIR, ...SOLO_AFTER];

const dateId = reportDateId();

function prevDateId(id) {
  const [y, m, d] = id.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
}

export function computeCensus(wardDoc) {
  const beds = typeof wardDoc.beds === "number" ? wardDoc.beds : 0;
  const start = typeof wardDoc.startOcc === "number" ? wardDoc.startOcc : 0;
  let occ = start;
  const perShiftOcc = {};
  SHIFTS.forEach((s) => {
    occ += occDelta(wardDoc.shifts[s.key] || {});
    if (occ < 0) occ = 0;
    perShiftOcc[s.key] = occ;
  });
  return { beds, occ, vac: beds - occ, perShiftOcc };
}

export function computeMovementTotals(wardDoc) {
  const totals = {};
  movementFields.forEach((f) => {
    let sum = 0;
    SHIFTS.forEach((s) => { const v = wardDoc.shifts[s.key][f.key]; sum += typeof v === "number" ? v : 0; });
    totals[f.key] = sum;
  });
  return totals;
}

// Typing "VITAL SIGNS:" (or "Vitals:", any case, with or without the extra
// space) as the last line of a patient's Diagnosis/Notes triggers an
// auto-pull of that patient's most recent reading from the Vital Signs
// Chart (see updateDiagnosisField below). Tolerant of spacing/case so
// "Vital signs:", "VITALS:", "Vital  Signs :" etc. all match.
const VITALS_TRIGGER_RE = /^(vital\s*signs|vitals)\s*:\s*$/i;

// A patient write-up card is "linked" to a real patient record either via
// the Select Patient dropdown (sourcePatientId) or, more loosely, via a
// successful EMR lookup (emrPatientId, set below) — either is enough to
// know whose Vital Signs Chart to read from. Only sourcePatientId is ever
// used for the discharge/referral archiving side effect in submitReport().
function linkedPatientIdFor(p) {
  return (p && (p.sourcePatientId || p.emrPatientId)) || "";
}

// Matches the Vitals Chart's own field keys (temp/pulse/resp/bp/spo2) and
// mirrors how a nurse writes it on paper: "T-36.8⁰c P-98b/m R-20c/m BP-
// 123/80mmHg SPO2- 99%." Missing values render as an em dash rather than
// being silently dropped, so it's obvious a reading is incomplete.
export function formatVitalsLine(v) {
  const val = (x) => (x === undefined || x === null || x === "") ? "\u2014" : x;
  return `T-${val(v.temp)}\u2070c P-${val(v.pulse)}b/m R-${val(v.resp)}c/m BP- ${val(v.bp)}mmHg SPO2- ${val(v.spo2)}%.`;
}

async function fetchLatestVitals(patientId) {
  const q = query(collection(db, "patients", patientId, "vitals"), orderBy("time", "desc"), limit(1));
  const snap = await getDocsSafe(q);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

export const VITALS_CHIPS = [
  { key: "temp", label: "T", suffix: "\u2070c" },
  { key: "pulse", label: "P", suffix: "b/m" },
  { key: "resp", label: "R", suffix: "c/m" },
  { key: "bp", label: "BP", suffix: "mmHg" },
  { key: "spo2", label: "SPO2", suffix: "%" }
];

// A nurse's free-text write-up often has its own section headers inside it
// (LEFT UPPER LIMB FRACTURE / NURSING DIAGNOSIS / etc, by convention typed
// in ALL CAPS on their own line). Detect those so NoteLines.svelte can
// render them as bold sub-headings within the note, splitting the
// surrounding text into paragraphs around them — still one continuous note.
function isNoteHeadingLine(line) {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase();
}
export function noteBlocks(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let paraLines = [];
  function flushPara() {
    if (paraLines.length) blocks.push({ type: "p", text: paraLines.join("\n") });
    paraLines = [];
  }
  lines.forEach((line) => {
    if (isNoteHeadingLine(line)) { flushPara(); blocks.push({ type: "h", text: line.trim() }); }
    else paraLines.push(line);
  });
  flushPara();
  return blocks;
}

// One ward's report state/logic — loading, editing, saving, submitting.
// `wardKey` is fixed for the lifetime of the caller (the route wraps
// selection in a {#key} block so switching wards recreates this from
// scratch, matching the original's key={key}-forced remount).
export function createWardReport(wardKey, profile, user, getIsAdmin) {
  let wardDoc = $state(null);
  let adminEditOverride = $state(false);
  let nightUpdateOpen = $state(false);
  let topStatus = $state({ text: "Loading\u2026", error: false });
  let saveStatus = $state({ text: "", error: false });
  // Per-patient status for the EMR auto-fill lookup — keyed by patient id.
  let emrLookup = $state({});
  let wardPatientOptions = $state([]);
  let patientCounter = 0;
  const w = WARDS.find((x) => x.key === wardKey);

  $effect(() => {
    let cancelled = false;
    (async () => {
      const info = patientWardAndBedTypeForReportKey(wardKey);
      if (!info) { wardPatientOptions = []; return; }
      try {
        const q = query(collection(db, "patients"), where("wardMhl", "==", info.wardLabel));
        const snap = await getDocsSafe(q);
        const list = [];
        snap.forEach((d) => {
          const data = d.data();
          if (data.pendingTransferMhl) return;
          if (info.bedType && (data.pedBedTypeMhl || "") !== info.bedType) return;
          // dischargeStatus ('DISCHARGE' / 'TRANS OUT') is set by
          // applyPatientStatus the moment a patient is discharged/referred
          // — via this report's own status dropdown, via the Patient page,
          // or straight off the Drug Course Chart. The patient stays on
          // this list (still keyed by wardMhl) so the nurse can tap their
          // name and write a closing note; see WardPatientPicker.svelte for
          // how it's shown, and submitReport below for how they finally
          // drop off once that note is submitted.
          list.push({ id: d.id, name: data.name || "", emr: data.emr || "", age: data.age || "", admissionDate: data.admissionDate || "", diagnosis: data.diagnosis || "", dischargeStatus: data.dischargeStatus || "" });
        });
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        if (!cancelled) wardPatientOptions = list;
      } catch (e) {
        if (!cancelled) wardPatientOptions = [];
      }
    })();
    return () => { cancelled = true; };
  });

  $effect(() => {
    let cancelled = false;
    (async () => {
      adminEditOverride = false; // default to read-only even for admin; they tap the edit icon per ward
      wardDoc = null;
      topStatus = { text: "Loading\u2026", error: false };
      const ref = doc(db, "nurseReports_mhl", dateId, "wards", wardKey);
      let snap;
      try {
        snap = await getDocSafe(ref);
      } catch (e) {
        if (!cancelled) topStatus = { text: "Couldn't load this ward's report: " + (e.code || e.message || "unknown error"), error: true };
        return;
      }
      let next = snap.exists() ? Object.assign(defaultWardDoc(w), snap.data()) : defaultWardDoc(w);
      next.shifts = next.shifts || {};
      SHIFTS.forEach((s) => { next.shifts[s.key] = Object.assign(blankShift(), next.shifts[s.key] || {}); });
      next.patients = Array.isArray(next.patients) ? next.patients : [];
      next.patients.forEach((p) => { if (!p.id) p.id = "p" + Math.random().toString(36).slice(2); if (typeof p.status !== "string") p.status = ""; });
      next.nightUpdate = typeof next.nightUpdate === "string" ? next.nightUpdate : "";
      next.nightUpdateBy = next.nightUpdateBy || "";

      // On taking over — the first time this ward's report for today is
      // opened, OR any later time it's opened while still untouched — seed
      // Previous Occ from the actual patient list rather than a stale
      // carried-forward number. See isWardDocUntouched.
      if (!snap.exists() || isWardDocUntouched(next)) {
        const patientWardInfo = patientWardAndBedTypeForReportKey(wardKey);
        let filledFromPatients = false;
        if (patientWardInfo) {
          try {
            const patientsSnap = await getDocs(collection(db, "patients"));
            const patients = [];
            patientsSnap.forEach((d) => patients.push(d.data()));
            const headcount = wardHeadcount(patients, patientWardInfo.wardLabel, patientWardInfo.bedType);
            next = { ...next, startOcc: headcount, occ: headcount, vac: (next.beds || 0) - headcount };
            filledFromPatients = true;
          } catch (e) { /* fall through to the old carry-forward below */ }
        }
        if (!filledFromPatients && !snap.exists()) {
          try {
            const prevRef = doc(db, "nurseReports_mhl", prevDateId(dateId), "wards", wardKey);
            const prevSnap = await getDocSafe(prevRef);
            if (prevSnap.exists() && typeof prevSnap.data().occ === "number") next = { ...next, startOcc: prevSnap.data().occ };
          } catch (e) { /* non-fatal — leave startOcc at 0, nurse can correct it */ }
        }
      }

      if (cancelled) return;
      topStatus = { text: "", error: false };
      nightUpdateOpen = !!next.nightUpdate;
      wardDoc = next;
    })();
    return () => { cancelled = true; };
  });

  function updateWardDoc(patch) { wardDoc = { ...wardDoc, ...patch }; }
  function updateShiftField(shiftKey, fieldKey, raw) {
    const num = parseFloat(raw);
    wardDoc = { ...wardDoc, shifts: { ...wardDoc.shifts, [shiftKey]: { ...wardDoc.shifts[shiftKey], [fieldKey]: isNaN(num) ? 0 : num } } };
  }
  function updateDuty(shiftKey, value) {
    wardDoc = { ...wardDoc, shifts: { ...wardDoc.shifts, [shiftKey]: { ...wardDoc.shifts[shiftKey], nurseOnDuty: value } } };
  }
  function updateBeds(raw) { const n = parseFloat(raw); updateWardDoc({ beds: isNaN(n) ? 0 : n }); }
  function updateStartOcc(raw) { const n = parseFloat(raw); updateWardDoc({ startOcc: isNaN(n) ? 0 : n }); }

  function addPatient() {
    patientCounter += 1;
    const id = "p" + Date.now() + "_" + patientCounter;
    const blank = { id, status: "" };
    PATIENT_FIELDS.forEach((f) => { blank[f.key] = ""; });
    wardDoc = { ...wardDoc, patients: [...wardDoc.patients, blank] };
  }
  function removePatient(id) { wardDoc = { ...wardDoc, patients: wardDoc.patients.filter((p) => p.id !== id) }; }
  function updatePatientField(id, key, value) { wardDoc = { ...wardDoc, patients: wardDoc.patients.map((p) => p.id === id ? { ...p, [key]: value } : p) }; }
  function updatePatientStatus(id, value) { wardDoc = { ...wardDoc, patients: wardDoc.patients.map((p) => p.id === id ? { ...p, status: value } : p) }; }

  // Diagnosis/Notes edits go through here instead of updatePatientField so
  // a trailing "VITAL SIGNS:" / "Vitals:" line can auto-pull that
  // patient's latest Vitals Chart reading right underneath it.
  async function updateDiagnosisField(id, value) {
    updatePatientField(id, "diagnosis", value);

    const lines = value.split("\n");
    const triggerLine = lines[lines.length - 1];
    if (!VITALS_TRIGGER_RE.test(triggerLine.trim())) return;

    const p = wardDoc.patients.find((x) => x.id === id);
    const patientId = linkedPatientIdFor(p);
    if (!patientId) return;

    try {
      const latest = await fetchLatestVitals(patientId);
      if (!latest) return;
      const snapshot = { temp: latest.temp || "", pulse: latest.pulse || "", resp: latest.resp || "", bp: latest.bp || "", spo2: latest.spo2 || "" };
      const vitalsLine = formatVitalsLine(snapshot);
      wardDoc = {
        ...wardDoc,
        patients: wardDoc.patients.map((x) => {
          if (x.id !== id) return x;
          if (!x.diagnosis || !x.diagnosis.endsWith(triggerLine)) return x;
          return { ...x, diagnosis: x.diagnosis + "\n" + vitalsLine, vitalsSnapshot: snapshot, vitalsLine };
        })
      };
    } catch (e) {
      // Non-fatal — the nurse can still type vitals in by hand.
    }
  }

  // Fired when the nurse edits one of the auto-filled vitals chips under
  // Diagnosis/Notes — regenerates just that reading's line and swaps it
  // into the note text in place.
  function updateVitalsSnapshotField(id, field, value) {
    wardDoc = {
      ...wardDoc,
      patients: wardDoc.patients.map((p) => {
        if (p.id !== id || !p.vitalsSnapshot) return p;
        const nextSnapshot = { ...p.vitalsSnapshot, [field]: value };
        const nextLine = formatVitalsLine(nextSnapshot);
        const nextDiagnosis = p.vitalsLine && p.diagnosis ? p.diagnosis.replace(p.vitalsLine, nextLine) : p.diagnosis;
        return { ...p, vitalsSnapshot: nextSnapshot, vitalsLine: nextLine, diagnosis: nextDiagnosis };
      })
    };
  }

  // Looks the typed EMR number up against the `patients` collection and,
  // if found, fills in Age/Name/Sex/DOA — only the fields still blank, so
  // it never clobbers anything the nurse already typed. Fires on blur.
  async function lookupPatientByEmr(id, rawEmr) {
    const emr = (rawEmr || "").trim();
    if (!emr) { emrLookup = { ...emrLookup, [id]: null }; return; }
    emrLookup = { ...emrLookup, [id]: { text: "Looking up patient\u2026", error: false } };
    try {
      const q = query(collection(db, "patients"), where("emr", "==", emr), limit(1));
      const snap = await getDocsSafe(q);
      if (snap.empty) {
        emrLookup = { ...emrLookup, [id]: { text: "No patient found with that EMR number \u2014 fill in details manually.", error: false } };
        return;
      }
      const record = snap.docs[0].data();
      const foundId = snap.docs[0].id;
      wardDoc = {
        ...wardDoc,
        patients: wardDoc.patients.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p, emrPatientId: foundId };
          if (!next.name && record.name) next.name = record.name;
          if (!next.age && record.age) next.age = record.age;
          if (!next.doa && record.admissionDate) next.doa = record.admissionDate;
          return next;
        })
      };
      emrLookup = { ...emrLookup, [id]: { text: "Filled in from the patient record.", error: false } };
    } catch (e) {
      emrLookup = { ...emrLookup, [id]: { text: "Couldn't look up patient: " + (e.code || e.message || "unknown error"), error: true } };
    }
  }

  // Fills a write-up card straight from the "Select Patient" dropdown —
  // same blank-fields-only fill as lookupPatientByEmr, but keyed off a
  // chosen wardPatientOptions entry. Also remembers sourcePatientId,
  // which submitReport() needs to actually discharge/refer that patient.
  function selectPatientFromWard(id, sourcePatientId) {
    if (!sourcePatientId) { wardDoc = { ...wardDoc, patients: wardDoc.patients.map((p) => p.id === id ? { ...p, sourcePatientId: "" } : p) }; return; }
    const record = wardPatientOptions.find((p) => p.id === sourcePatientId);
    if (!record) return;
    wardDoc = {
      ...wardDoc,
      patients: wardDoc.patients.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p, sourcePatientId };
        if (!next.emr && record.emr) next.emr = record.emr;
        if (!next.name && record.name) next.name = record.name;
        if (!next.age && record.age) next.age = record.age;
        if (!next.doa && record.admissionDate) next.doa = record.admissionDate;
        if (!next.diagnosis && record.diagnosis) next.diagnosis = record.diagnosis;
        // Picking someone already tagged DISCHARGE/TRANS OUT (see
        // WardPatientPicker.svelte) means this write-up is their closing
        // note — pre-fill Status to match so submitReport recognizes it
        // and the nurse doesn't have to set it by hand, but never
        // override something the nurse already picked themselves.
        if (!next.status && record.dischargeStatus) next.status = record.dischargeStatus;
        return next;
      })
    };
    emrLookup = { ...emrLookup, [id]: { text: "Filled in from " + (record.name || "the patient") + "\u2019s record.", error: false } };
  }

  function openNightUpdate() {
    if (!editable) return;
    const opening = !nightUpdateOpen;
    nightUpdateOpen = opening;
    if (!opening) return;
    if (!wardDoc.shifts.pm.nurseOnDuty && profile?.name) updateDuty("pm", profile.name);
  }

  const census = $derived(wardDoc ? computeCensus(wardDoc) : null);
  const movementTotals = $derived(wardDoc ? computeMovementTotals(wardDoc) : null);
  const demographicTotals = $derived(wardDoc ? computeDemographicTotals(wardDoc) : null);

  let editable = $derived(wardDoc ? ((getIsAdmin() && adminEditOverride) || !wardDoc.locked) : false);

  async function saveReport() {
    if (!wardDoc || !editable) return;
    let doc_ = wardDoc;
    if (!doc_.shifts.am.nurseOnDuty && profile?.name) {
      doc_ = { ...doc_, shifts: { ...doc_.shifts, am: { ...doc_.shifts.am, nurseOnDuty: profile.name } } };
      wardDoc = doc_;
    }
    const ref = doc(db, "nurseReports_mhl", dateId, "wards", wardKey);
    const finalDoc = { ...doc_, occ: census.occ, vac: census.vac, ...movementTotals, ...demographicTotals };
    try {
      await setDoc(ref, { ...finalDoc, updatedAt: serverTimestamp(), updatedBy: profile.name || "Unknown" }, { merge: true });
      saveStatus = { text: "Saved.", error: false };
    } catch (e) {
      saveStatus = { text: "Couldn't save: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  async function submitReport() {
    if (!wardDoc || !editable) return;
    const hasNightUpdate = !!(wardDoc.nightUpdate && wardDoc.nightUpdate.trim());
    let doc_ = wardDoc;
    if (hasNightUpdate && !doc_.shifts.pm.nurseOnDuty && profile?.name) {
      doc_ = { ...doc_, shifts: { ...doc_.shifts, pm: { ...doc_.shifts.pm, nurseOnDuty: profile.name } } };
    }

    // A write-up linked to a real patient record whose status is
    // DISCHARGE or TRANS OUT finalizes that patient on submit. Two
    // cases, handled the same way from here on:
    //  - Freshly set here (wardPatientOptions didn't already show them
    //    tagged DISCHARGE/TRANS OUT): archive their current admission for
    //    real — the same archive-and-reset flow as the Drug Course
    //    Chart's own Patient Status control.
    //  - Already tagged (the nurse picked them off the roster where they
    //    showed the small red DISCHARGE/TRANS OUT tag — see
    //    WardPatientPicker.svelte — because they were discharged/referred
    //    straight off the Drug Course Chart, or off the Patient page,
    //    earlier): already archived, so this write-up is just their
    //    closing note — skip re-archiving.
    // Either way, once submitted this closes them out
    // (closeOutDischargedPatient) so they finally drop off this and every
    // other ward-scoped patient list. Skips anything already finalized
    // this way or with no linked record.
    const alreadyTaggedIds = new Set(wardPatientOptions.filter((p) => p.dischargeStatus).map((p) => p.id));
    const toFinalize = doc_.patients.filter((p) => p.sourcePatientId && !p.archivedFromReport && PATIENT_STATUS_ARCHIVE_REASON[p.status]);
    if (toFinalize.length && !navigator.onLine) {
      saveStatus = { text: "Some patients here are marked Discharge/Trans Out \u2014 closing them out needs an internet connection. Please try again once online, or clear their status to submit without closing them out.", error: true };
      return;
    }

    // A patient not already tagged (wardPatientOptions had no
    // dischargeStatus for them) is about to be discharged/referred for
    // real, right now, purely because this write-up's own Status field
    // says so — this is the "second route" into a discharge: a nurse who
    // knows the patient is leaving marks it here even though nobody set
    // that from the Drug Course Chart (e.g. the nurse who actually
    // discharged them forgot to). Confirm before doing anything
    // irreversible, same as the Drug Course Chart's own Patient Status
    // control and the Patient page's do for this exact archive.
    const freshDischarges = toFinalize.filter((p) => !alreadyTaggedIds.has(p.sourcePatientId));
    if (freshDischarges.length) {
      const names = freshDischarges.map((p) => (p.name || p.emr || "Unnamed") + " \u2014 " + p.status).join("\n");
      if (!confirm("Submitting this report will discharge/refer the following patient(s) and archive their current chart:\n\n" + names + "\n\nContinue?")) {
        saveStatus = { text: "Submission cancelled — clear or change the Status field on the patient(s) listed above if that wasn't intended.", error: true };
        return;
      }
    }

    const archiveErrors = [];
    if (toFinalize.length) {
      const results = await Promise.all(toFinalize.map(async (p) => {
        const name = p.name || p.emr || "A patient";
        if (!alreadyTaggedIds.has(p.sourcePatientId)) {
          const r = await applyPatientStatus({
            patientId: p.sourcePatientId, reason: PATIENT_STATUS_ARCHIVE_REASON[p.status],
            transferWard: "", fromWard: w?.label || "", transferredByName: profile?.name || "Unknown"
          });
          if (!r.ok) return { id: p.id, ok: false, message: r.message, name };
        }
        const closed = await closeOutDischargedPatient(p.sourcePatientId);
        if (!closed.ok) return { id: p.id, ok: false, message: closed.message, name };
        return { id: p.id, ok: true, name };
      }));
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      results.forEach((r) => { if (!r.ok) archiveErrors.push(r.name + ": " + r.message); });
      doc_ = { ...doc_, patients: doc_.patients.map((p) => okIds.has(p.id) ? { ...p, archivedFromReport: true } : p) };
    }

    const finalDoc = { ...doc_, occ: census.occ, vac: census.vac, ...movementTotals, ...demographicTotals };
    const ref = doc(db, "nurseReports_mhl", dateId, "wards", wardKey);
    const payload = {
      ...finalDoc, submitted: true, locked: true,
      submittedBy: profile.name || "Unknown", submittedByUid: user?.uid || null, submittedAt: serverTimestamp(),
      updatedAt: serverTimestamp(), updatedBy: profile.name || "Unknown"
    };
    if (hasNightUpdate) {
      payload.nightUpdateBy = doc_.nightUpdateBy || profile.name || "Unknown";
      payload.nightUpdatedAt = doc_.nightUpdatedAt || serverTimestamp();
    }
    try {
      await setDoc(ref, payload, { merge: true });
      saveStatus = archiveErrors.length
        ? { text: "Report submitted, but could not archive: " + archiveErrors.join("; "), error: true }
        : { text: "Report submitted.", error: false };
      wardDoc = { ...wardDoc, ...doc_, submitted: true, locked: true, nightUpdateBy: payload.nightUpdateBy || wardDoc.nightUpdateBy };
    } catch (e) {
      saveStatus = { text: "Couldn't submit: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  const pillClass = $derived(!wardDoc ? "" : wardDoc.locked ? "locked" : wardDoc.submitted ? "submitted" : "draft");
  const pillText = $derived(!wardDoc ? "" : wardDoc.locked ? "Locked" : wardDoc.submitted ? "Submitted" : "Draft");

  return {
    w,
    get wardDoc() { return wardDoc; },
    get adminEditOverride() { return adminEditOverride; },
    setAdminEditOverride(v) { adminEditOverride = v; },
    get nightUpdateOpen() { return nightUpdateOpen; },
    get topStatus() { return topStatus; },
    get saveStatus() { return saveStatus; },
    get emrLookup() { return emrLookup; },
    get wardPatientOptions() { return wardPatientOptions; },
    get census() { return census; },
    get movementTotals() { return movementTotals; },
    get demographicTotals() { return demographicTotals; },
    get editable() { return editable; },
    updateWardDoc, updateShiftField, updateDuty, updateBeds, updateStartOcc,
    addPatient, removePatient, updatePatientField, updateDiagnosisField, updateVitalsSnapshotField,
    updatePatientStatus, lookupPatientByEmr, selectPatientFromWard,
    openNightUpdate, saveReport, submitReport,
    get pillClass() { return pillClass; },
    get pillText() { return pillText; }
  };
}
