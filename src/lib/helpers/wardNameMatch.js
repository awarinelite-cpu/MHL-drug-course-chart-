// Ported 1:1 from src/lib/wardNameMatch.js (React), with imports updated to
// this project's file layout (nursesReportCommon.js instead of
// nurses-report-common.js, drugChartHelpers.js in the same helpers/ folder).
import { WARDS } from "./nursesReportCommon.js";
import { WARD_OPTIONS } from "./drugChartHelpers.js";

// Patient charts (WARD_OPTIONS) and nurse reports (WARDS) were built as two
// separate lists and don't line up 1:1 — the report splits Maternity and
// Pediatric into Bed/Cot, abbreviates several names (A/E, FMW I, FSW II,
// ORTHO, MMW), and has a few wards (ECO I/II, AMENITY, FSW EXT) patient
// charts have no equivalent for. Rather than guess at a semantic mapping,
// we only treat two wards as "the same ward" automatically when their
// names already match once normalized — case, punctuation, and the
// standalone word "WARD" stripped out — or via the explicit
// WARD_LABEL_ALIASES below for the abbreviated ones normalization can't
// safely guess.
function normalizeWardLabel(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/["']/g, "")
    .split(/\s+/)
    .filter(w => w && w !== "WARD")
    .join(" ")
    .trim();
}

// A few wards are confirmed to be the same physical ward even though their
// names don't normalize to the same thing (the report abbreviates them).
const WARD_LABEL_ALIASES = {
  "MALE MEDICAL WARD": "mmw",
  "ACCIDENT & EMERGENCY": "ae",
  "FEMALE MEDICAL WARD": "fmw1",
  "FEMALE SURGICAL WARD": "fsw2",
  "ORTHOPEDIC WARD": "ortho",
  // Maternity's "Cots" row (newborns) has no patient-chart equivalent —
  // babies aren't given their own patient record in this app — so only
  // the Mothers row (matbed) maps back to real patients here.
  "MATERNITY WARD": "matbed"
};

// Given a patient-chart ward label (a value from WARD_OPTIONS), returns
// the matching nurse-report ward key (from WARDS), or null if none of
// the report wards normalize to the same name.
export function reportWardKeyForPatientWard(patientWardLabel) {
  const upper = String(patientWardLabel || "").toUpperCase().trim();
  if (WARD_LABEL_ALIASES[upper]) return WARD_LABEL_ALIASES[upper];
  const norm = normalizeWardLabel(patientWardLabel);
  if (!norm) return null;
  const match = WARDS.find(w => normalizeWardLabel(w.label) === norm);
  return match ? match.key : null;
}

// A handful of patient-chart wards cover what the nurse report tracks as
// two separate physical areas with their own Occ each — normalized-name
// matching alone can't find these since e.g. "PEDIATRIC/NICU WARD" shares
// no words with "PAED BED" or "PAED COT".
const SPLIT_PATIENT_WARDS = {
  "PEDIATRIC/NICU WARD": ["paedbed", "paedcot"]
};

// Given a patient-chart ward label, returns every matching nurse-report
// ward key — normally zero or one, but two for a known split ward like
// PEDIATRIC/NICU WARD.
export function reportWardKeysForPatientWard(patientWardLabel) {
  const upper = String(patientWardLabel || "").toUpperCase().trim();
  if (SPLIT_PATIENT_WARDS[upper]) return SPLIT_PATIENT_WARDS[upper];
  const single = reportWardKeyForPatientWard(patientWardLabel);
  return single ? [single] : [];
}

// Report keys behind PEDIATRIC/NICU WARD's split map to a Bed/Cot value on
// the patient record rather than to a wholly separate ward label.
const PED_BED_TYPE_BY_REPORT_KEY = { paedbed: "Bed", paedcot: "Cot" };

// The reverse lookup: given a nurse-report ward key, returns the matching
// patient-chart ward label (a value from WARD_OPTIONS), or null.
export function patientWardForReportKey(reportWardKey) {
  if (PED_BED_TYPE_BY_REPORT_KEY[reportWardKey]) return "PEDIATRIC/NICU WARD";
  const aliased = Object.keys(WARD_LABEL_ALIASES).find(label => WARD_LABEL_ALIASES[label] === reportWardKey);
  if (aliased) return aliased;
  const w = WARDS.find(x => x.key === reportWardKey);
  if (!w) return null;
  const norm = normalizeWardLabel(w.label);
  return WARD_OPTIONS.find(label => normalizeWardLabel(label) === norm) || null;
}

// Like patientWardForReportKey, but also returns which pedBedType value
// (if any) further narrows that ward label — non-null only for
// paedbed/paedcot.
export function patientWardAndBedTypeForReportKey(reportWardKey) {
  const wardLabel = patientWardForReportKey(reportWardKey);
  if (!wardLabel) return null;
  return { wardLabel, bedType: PED_BED_TYPE_BY_REPORT_KEY[reportWardKey] || null };
}
