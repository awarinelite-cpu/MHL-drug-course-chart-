import { collection, doc, getDoc, getDocs, addDoc, updateDoc, setDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
import { db } from "$lib/firebase.js";
import { STATUS_LABELS, defaultRow } from "./drugChartHelpers.js";

function blankDrugs() { return Array(8).fill(null).map(() => ({ name: '', route: '', frequency: '', action: '', duration: '' })); }
function blankChartRows() { return Array(18).fill(null).map(() => defaultRow()); }

// The tag shown under a patient's name in the Ward Report's "Select from
// ward" picker (see WardPatientPicker.svelte / WardPanelRest.svelte) once
// they've been discharged or referred out — from here, from the Patient
// page's own status control, or from the Drug Course Chart's inline
// duplicate of this flow. `dischargeStatus` lives on the shared /patients
// doc (see wardCensus.js's note on shared vs per-hospital fields), so a
// discharge recorded from either 68 or MHL shows up the same way on both.
// Deliberately not set for 'transferred': a ward transfer already has its
// own pendingTransferMhl marker and the patient is expected to keep
// appearing normally once accepted onto the receiving MHL ward.
export const ROSTER_TAG_FOR_REASON = { discharged: 'DISCHARGE', referred: 'TRANS OUT' };

// Clears a patient's MHL ward placement (wardMhl/pedBedTypeMhl — not 68's
// own ward/pedBedType, see wardCensus.js) once their discharge/trans-out
// has been given a closing write-up and that Ward Report has been
// submitted (see submitReport in useWardReport.svelte.js) — the final
// step described on WardPatientPicker: the patient stays on the ward's
// picker, tagged DISCHARGE/TRANS OUT, so the nurse can tap their name and
// write that closing note, and only disappears from the roster once that
// note is actually submitted. Safe to call even if the patient was never
// tagged — it's just a no-op wipe of fields that were already blank.
export async function closeOutDischargedPatient(patientId) {
  try {
    await updateDoc(doc(db, 'patients', patientId), {
      wardMhl: '', pedBedTypeMhl: '', dischargeStatus: '', dischargeStatusAt: null, updatedAt: serverTimestamp()
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.code || e.message || 'unknown error' };
  }
}

// Archives every chart for a patient's current admission (drug course
// chart, blood glucose, vitals, intake & output, seizure) into a new
// `admissions` record, then resets all of those charts blank so the next
// admission starts clean. Same operation DrugCourseChart's own
// "Patient Status" control performs, but reads the drug chart straight
// from Firestore instead of an open editor's in-memory state — safe to
// call from anywhere (e.g. the Patient page, where no chart is open),
// and just as correct when called right after the chart page's own save
// flushes pending edits, since Firestore's offline cache makes that
// read-after-write consistent even before the server round trip finishes.
export async function applyPatientStatus({ patientId, reason, transferWard, fromWard, transferredByName }) {
  let label = STATUS_LABELS[reason];
  let wardChosen = '';
  if (reason === 'transferred') {
    wardChosen = transferWard;
    if (!wardChosen) return { ok: false, message: 'Please select which ward the patient is being transferred to.' };
    label = 'Transferred to ' + wardChosen;

    // A ward transfer isn't a discharge: the patient's admission carries
    // on, just on a different ward, so none of the current charts (drug
    // course chart, vitals, blood glucose, intake & output, seizure)
    // get archived or reset here. We only park the patient in a
    // pendingTransferMhl for the receiving MHL ward to accept — 68's own
    // transfer flow uses its own `pendingTransfer` field on this same
    // shared patient doc, so the two never collide. See wardTransfer.js's
    // acceptTransfer, which simply moves `wardMhl` over with everything
    // else (including the shared charts) left untouched.
    try {
      await updateDoc(doc(db, 'patients', patientId), {
        pendingTransferMhl: {
          toWard: wardChosen,
          fromWard: fromWard || '',
          transferredByName: transferredByName || '',
          transferredAt: serverTimestamp(),
          transferredAtDisplay: new Date().toLocaleString()
        },
        updatedAt: serverTimestamp()
      });
    } catch (e) {
      return { ok: false, message: 'Could not start the transfer: ' + (e.code || e.message) };
    }
    return { ok: true, label, wardChosen };
  }

  async function fetchEntries(collName) {
    const snap = await getDocs(collection(db, 'patients', patientId, collName));
    const arr = [];
    snap.forEach(d => arr.push(d.data()));
    return arr;
  }
  async function clearEntries(collName) {
    const snap = await getDocs(collection(db, 'patients', patientId, collName));
    await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'patients', patientId, collName, d.id))));
  }

  const chartRef = doc(db, 'patients', patientId, 'drugCourseChart', 'main');
  let drugChartData = {
    f_admission: '', f_discharge: '', f_diagnosis: '',
    rows: [], drugs: [], verbalOrders: [], careInstructions: [], auditLog: []
  };
  try {
    const chartSnap = await getDoc(chartRef);
    if (chartSnap.exists()) {
      const d = chartSnap.data();
      drugChartData = {
        f_admission: d.f_admission || '', f_discharge: d.f_discharge || '', f_diagnosis: d.f_diagnosis || '',
        rows: d.rows || [], drugs: d.drugs || [], verbalOrders: d.verbalOrders || [],
        careInstructions: d.careInstructions || [], auditLog: d.auditLog || []
      };
    }
  } catch (e) { /* fine to archive with a blank drug chart if this fails */ }

  // Discharge Date is locked (readonly) so it can only ever be set here,
  // automatically, the moment the patient is actually discharged.
  let dischargeDate = drugChartData.f_discharge;
  if (reason === 'discharged' && !dischargeDate) {
    dischargeDate = new Date().toISOString().slice(0, 10);
  }

  let bgData = { chartType: '6point', rows6: [], rows3: [] };
  try {
    const bgSnap = await getDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main'));
    if (bgSnap.exists()) {
      const d = bgSnap.data();
      bgData = { chartType: d.chartType || '6point', rows6: d.rows6 || [], rows3: d.rows3 || [] };
    }
  } catch (e) { /* fine to archive with blank glycemic data if this fails */ }

  let vitalsArr = [], ioArr = [], seizureArr = [];
  let ioSummary = { intake: 0, output: 0, balance: 0 };
  try {
    [vitalsArr, ioArr, seizureArr] = await Promise.all([fetchEntries('vitals'), fetchEntries('intakeOutput'), fetchEntries('seizure')]);
  } catch (e) { /* fine to archive with whatever we could gather */ }
  try {
    const ioSumSnap = await getDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current'));
    if (ioSumSnap.exists()) {
      const d = ioSumSnap.data();
      ioSummary = { intake: d.intake || 0, output: d.output || 0, balance: d.balance || 0 };
    }
  } catch (e) { /* fine to archive without the summary snapshot — derivable from intakeOutput entries */ }

  const admissionDoc = {
    diagnosis: drugChartData.f_diagnosis,
    archiveReason: reason,
    archiveReasonLabel: label,
    archivedAt: serverTimestamp(),
    archivedAtDisplay: new Date().toLocaleString(),
    drugCourseChart: { ...drugChartData, f_discharge: dischargeDate },
    bloodGlucose: bgData,
    vitals: vitalsArr,
    intakeOutput: ioArr,
    intakeOutputSummary: ioSummary,
    seizure: seizureArr
  };

  try {
    await addDoc(collection(db, 'patients', patientId, 'admissions'), admissionDoc);
  } catch (e) {
    return { ok: false, message: 'Could not save to Overview: ' + (e.code || e.message) };
  }

  const blankDrugChart = {
    f_admission: '', f_discharge: '', f_diagnosis: '',
    rows: blankChartRows(), drugs: blankDrugs(),
    verbalOrders: [], careInstructions: [], auditLog: [],
    updatedAt: serverTimestamp()
  };

  try {
    await Promise.all([
      setDoc(chartRef, blankDrugChart), // full overwrite (no merge) so old data doesn't linger
      setDoc(doc(db, 'patients', patientId, 'bloodGlucose', 'main'), { chartType: '6point', rows6: [], rows3: [], updatedAt: serverTimestamp() }),
      setDoc(doc(db, 'patients', patientId, 'intakeOutputSummary', 'current'), { intake: 0, output: 0, balance: 0, periodDate: new Date().toISOString().slice(0, 10), updatedAt: serverTimestamp() }),
      clearEntries('vitals'), clearEntries('intakeOutput'), clearEntries('seizure'),
      // Tag the patient doc itself so the Ward Report's "Select from ward"
      // picker can flag them DISCHARGE/TRANS OUT for the nurse, even
      // though they stay on the roster (still keyed by wardMhl) until a
      // closing report is submitted for them — see closeOutDischargedPatient.
      updateDoc(doc(db, 'patients', patientId), { dischargeStatus: ROSTER_TAG_FOR_REASON[reason] || '', dischargeStatusAt: serverTimestamp() })
    ]);
  } catch (e) {
    return { ok: false, archived: true, message: 'Archived, but could not fully reset the new charts: ' + (e.code || e.message) };
  }

  return { ok: true, label, wardChosen };
}
