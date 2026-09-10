// Ported from src/lib/wardTransfer.js (React), then adapted so MHL and 68
// can share the same /patients record without sharing ward placement.
// Both apps point at the same shared /patients collection (see
// $lib/firebase.js) — the patient's demographics and every chart
// (drug course, vitals, blood glucose, intake & output, seizure) are the
// same record either hospital reads. Only *which ward the patient is
// currently on* is kept separate per hospital, using MHL's own fields:
//
//   wardMhl            instead of 68's `ward`
//   pendingTransferMhl instead of 68's `pendingTransfer`
//   pedBedTypeMhl      instead of 68's `pedBedType`
//
// A patient with no `wardMhl` set (because they were only ever admitted
// on 68, or haven't been placed on an MHL ward yet) simply won't match
// any MHL ward filter — they still turn up in a name/EMR search (Home's
// search is ward-agnostic) but not on any specific ward list until a
// nurse here transfers them onto one, exactly as if they were a brand
// new patient. 68 never reads these *Mhl fields, so an MHL transfer is
// invisible to 68's own ward lists, and vice versa.
import { doc, updateDoc, deleteField, serverTimestamp } from "firebase/firestore";
import { db } from "$lib/firebase.js";
import { AE_WARD_LABEL } from "./drugChartHelpers.js";

// Returns the patients (from a caller's already-fetched patients list)
// currently pending transfer INTO the given MHL ward — the "New Patient"
// queue a ward's nurse sees before choosing to accept or reject each one.
export function pendingTransfersFor(patients, ward) {
  if (!ward) return [];
  return (patients || []).filter(p => p.pendingTransferMhl && p.pendingTransferMhl.toWard === ward);
}

// Accepting moves the patient onto this MHL ward for real. Their charts
// were never touched during the transfer (only a real discharge/referral
// archives and resets them), so this is just the ward reassignment the
// receiving nurse has been holding off on — care continues on the same
// drug course chart, vitals, blood glucose, intake & output, and seizure
// records the sending ward was using. `pedBedType` ('Bed' | 'Cot') is
// only relevant when accepting into PEDIATRIC/NICU WARD.
export async function acceptTransfer(patientId, pendingTransferMhl, pedBedType) {
  const updates = {
    wardMhl: pendingTransferMhl.toWard,
    pendingTransferMhl: deleteField(),
    updatedAt: serverTimestamp()
  };
  if (pendingTransferMhl.toWard === "PEDIATRIC/NICU WARD") updates.pedBedTypeMhl = pedBedType || "";
  // Tag the receiving ward's roster picker blue for 24h — see
  // ADMISSION_TAG_LABEL/activeAdmissionTag in patientAdmissionStatus.js —
  // when this transfer originated on Accident & Emergency. An ordinary
  // ward-to-ward transfer (fromWard anything else) gets no admission tag;
  // the patient just reappears on the new ward's list normally.
  if (pendingTransferMhl.fromWard === AE_WARD_LABEL) {
    updates.admissionSource = "AE_TRANSFER";
    updates.admissionSourceAt = serverTimestamp();
  }
  await updateDoc(doc(db, "patients", patientId), updates);
}

// Rejecting (e.g. no bed space) just clears the pending transfer. The
// patient's `wardMhl` field was never actually changed while pending, so
// they reappear on their original MHL ward's list automatically (or stay
// out of every MHL ward list if they had no wardMhl to begin with) —
// nothing else needs to be undone.
export async function rejectTransfer(patientId) {
  await updateDoc(doc(db, "patients", patientId), {
    pendingTransferMhl: deleteField(),
    updatedAt: serverTimestamp()
  });
}
