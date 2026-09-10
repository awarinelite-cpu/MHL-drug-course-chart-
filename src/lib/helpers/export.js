// Ported from src/lib/export.js (React) — JSON-export half only. The PDF
// half (jsPDF/jspdf-autotable table-building, downloadRecordAsPdf,
// getRecordPdfFile, sharePdf) is deferred: it's the separate "PDF export"
// item still on the README's not-yet-ported list, and no page in this app
// calls it yet. downloadRecordAsJson (single-admission/patient export) is
// ported too even though nothing calls it yet, since it shares all its
// data-gathering with downloadFullBackup below and the Admin page's
// per-patient rows are natural future callers.
import { doc, getDoc, collection, getDocs, query, orderBy } from "firebase/firestore";
import { db } from "$lib/firebase.js";

// ---------- data gathering ----------

function toRows(snap) { const arr = []; snap.forEach(d => arr.push(d.data())); return arr; }

async function gatherPatient(patientId) {
  const snap = await getDoc(doc(db, "patients", patientId));
  if (!snap.exists()) throw new Error("Patient not found.");
  return { id: patientId, ...snap.data() };
}

async function gatherActiveAdmission(patientId) {
  const [drugSnap, bgSnap, vitalsSnap, ioSnap, ioSumSnap, seizureSnap] = await Promise.all([
    getDoc(doc(db, "patients", patientId, "drugCourseChart", "main")),
    getDoc(doc(db, "patients", patientId, "bloodGlucose", "main")),
    getDocs(query(collection(db, "patients", patientId, "vitals"), orderBy("time", "asc"))),
    getDocs(query(collection(db, "patients", patientId, "intakeOutput"), orderBy("time", "asc"))),
    getDoc(doc(db, "patients", patientId, "intakeOutputSummary", "current")),
    getDocs(query(collection(db, "patients", patientId, "seizure"), orderBy("time", "asc")))
  ]);
  return {
    kind: "active",
    diagnosis: (drugSnap.exists() && drugSnap.data().f_diagnosis) || "No diagnosis entered yet",
    statusLabel: "Currently active",
    drugCourseChart: drugSnap.exists() ? drugSnap.data() : null,
    bloodGlucose: bgSnap.exists() ? bgSnap.data() : null,
    vitals: toRows(vitalsSnap),
    intakeOutput: toRows(ioSnap),
    intakeOutputSummary: ioSumSnap.exists() ? ioSumSnap.data() : null,
    seizure: toRows(seizureSnap)
  };
}

// Reads glycemic rows for whichever chart type is active, handling both the
// current per-type schema (rows6/rows3, each row wrapped as { cells } since
// Firestore rejects bare nested arrays) and older archived docs that only
// have a single 'rows' field (which belonged to whichever chartType was
// active when it was saved).
function pickGlucoseRows(bg) {
  const unwrap = arr => (arr || []).map(r => r.cells || r);
  const chartType = bg.chartType === "3point" ? "3point" : "6point";
  if (bg.rows6 || bg.rows3) {
    return { chartType, rows: unwrap(chartType === "6point" ? bg.rows6 : bg.rows3) };
  }
  return { chartType, rows: unwrap(bg.rows) };
}

function hasActiveData(a) {
  const dc = a.drugCourseChart;
  const hasDrug = !!(dc && ((dc.f_diagnosis || "") || (dc.drugs || []).some(d => d && d.name) || (dc.rows || []).some(r => r && (r.date || r.sno))));
  const bg = a.bloodGlucose;
  const hasBg = !!(bg && pickGlucoseRows(bg).rows.some(r => Array.isArray(r) && r.some(cell => cell)));
  return hasDrug || hasBg || a.vitals.length > 0 || a.intakeOutput.length > 0 || a.seizure.length > 0;
}

function normalizeArchived(data, id) {
  const STATUS_LABELS = { referred: "Referred to another hospital", transferred: "Transferred to another ward", discharged: "Discharged" };
  return {
    kind: data.archiveReason || "closed",
    id,
    diagnosis: data.diagnosis || "No diagnosis recorded",
    statusLabel: (data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || "Closed") + (data.archivedAtDisplay ? " — " + data.archivedAtDisplay : ""),
    drugCourseChart: data.drugCourseChart || null,
    bloodGlucose: data.bloodGlucose || null,
    vitals: data.vitals || [],
    intakeOutput: data.intakeOutput || [],
    intakeOutputSummary: data.intakeOutputSummary || null,
    seizure: data.seizure || []
  };
}

async function gatherArchivedAdmission(patientId, admissionId) {
  const snap = await getDoc(doc(db, "patients", patientId, "admissions", admissionId));
  if (!snap.exists()) throw new Error("Admission record not found.");
  return normalizeArchived(snap.data(), admissionId);
}

async function gatherAllArchivedAdmissions(patientId) {
  const out = [];
  try {
    const q = query(collection(db, "patients", patientId, "admissions"), orderBy("archivedAt", "asc"));
    const snap = await getDocs(q);
    snap.forEach(d => out.push(normalizeArchived(d.data(), d.id)));
  } catch (e) {
    // Composite index may not exist yet — fall back to an unordered fetch, sorted client-side.
    const snap = await getDocs(collection(db, "patients", patientId, "admissions"));
    const raw = [];
    snap.forEach(d => raw.push({ id: d.id, ...d.data() }));
    raw.sort((a, b) => (a.archivedAtDisplay || "").localeCompare(b.archivedAtDisplay || ""));
    raw.forEach(data => out.push(normalizeArchived(data, data.id)));
  }
  return out;
}

// scope: 'this' (default) uses admissionId if given, else the active admission.
//        'all' gathers the full history — every closed admission plus the
//        active one, if it has any data at all.
export async function buildExportRecord(patientId, { admissionId, scope, exportedBy } = {}) {
  const patient = await gatherPatient(patientId);
  let admissions;
  if (scope === "all") {
    const active = await gatherActiveAdmission(patientId);
    const archived = await gatherAllArchivedAdmissions(patientId);
    admissions = [...(hasActiveData(active) ? [active] : []), ...archived];
  } else if (admissionId) {
    admissions = [await gatherArchivedAdmission(patientId, admissionId)];
  } else {
    admissions = [await gatherActiveAdmission(patientId)];
  }
  return { patient, admissions, exportedAt: new Date(), exportedBy: exportedBy || null };
}

// ---------- filenames / downloads ----------

function safeSlug(s) {
  return String(s || "").trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "patient";
}

function filenameFor(record, tag) {
  const date = record.exportedAt.toISOString().slice(0, 10);
  return safeSlug(record.patient.name) + "_" + safeSlug(record.patient.emr || record.patient.id) + "_" + tag + "_" + date;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function jsonReplacer(key, value) {
  if (value && typeof value === "object" && typeof value.toDate === "function") {
    try { return value.toDate().toISOString(); } catch (e) { return null; }
  }
  return value;
}

export function downloadRecordAsJson(record, tag) {
  const blob = new Blob([JSON.stringify(record, jsonReplacer, 2)], { type: "application/json" });
  triggerDownload(blob, filenameFor(record, tag) + ".json");
}

// ---------- admin: full-database backup ----------
// There's no server here to run this on a real cron schedule — this is a
// client-side app talking to Firestore directly, with no Cloud Functions
// deployed for it. This is the honest substitute: a one-click, on-demand
// export of every patient's full history that an admin can run on whatever
// cadence they choose (e.g. weekly) and store off-platform.

async function gatherAllPatientIds() {
  const snap = await getDocs(collection(db, "patients"));
  const ids = [];
  snap.forEach(d => ids.push(d.id));
  return ids;
}

export async function downloadFullBackup(exportedBy, onProgress) {
  const ids = await gatherAllPatientIds();
  const patients = [];
  for (let i = 0; i < ids.length; i++) {
    if (onProgress) onProgress(i + 1, ids.length);
    try {
      patients.push(await buildExportRecord(ids[i], { scope: "all", exportedBy }));
    } catch (e) {
      patients.push({ patientId: ids[i], error: e.message || String(e) });
    }
  }
  const bundle = { exportedAt: new Date(), exportedBy: exportedBy || null, patientCount: patients.length, patients };
  const blob = new Blob([JSON.stringify(bundle, jsonReplacer, 2)], { type: "application/json" });
  triggerDownload(blob, "hospital_backup_" + new Date().toISOString().slice(0, 10) + ".json");
  return { count: patients.length };
}
