// Ported 1:1 from src/lib/nurses-report-common.js (React). Shared constants
// and date helpers for the Nurses Report feature (role-select, overall-nurse,
// ward-nurse). Renamed to nursesReportCommon.js to match this project's
// camelCase helper filenames — same module, same exports.
import { doc, getDoc, setDoc } from "firebase/firestore";

// The hospital's fixed ward list, in the same order as the paper "24 Hours
// Overall Report" — beds is the default bed capacity, editable per ward.
export const WARDS = [
  { key: "ae",       label: "A/E",       beds: 20 },
  { key: "matbed",   label: "MOTHERS",   beds: 20 },
  { key: "matcot",   label: "COTS",      beds: 20 },
  { key: "officers", label: "OFFICERS",  beds: 9  },
  { key: "fmw1",     label: "FMW I",     beds: 18 },
  { key: "fsw2",     label: "FSW II",    beds: 20 },
  { key: "mmw",      label: "MMW",       beds: 20 },
  { key: "paedbed",  label: "PAED BED",  beds: 10 },
  { key: "paedcot",  label: "PAED COT",  beds: 18 },
  { key: "ortho",    label: "ORTHO",     beds: 20 },
  { key: "gynae",    label: "GYNAE",     beds: 18 },
  { key: "award",    label: "A WARD",    beds: 44 },
  { key: "fswext",   label: "FSW EXT",   beds: 20 },
  { key: "eco1",     label: "ECO I",     beds: 3  },
  { key: "eco2",     label: "ECO II",    beds: 3  },
  { key: "icu",      label: "ICU",       beds: 6  },
  { key: "amenity",  label: "AMENITY",   beds: 3  },
  { key: "msw",      label: "MSW",       beds: 18 },
  { key: "esw",      label: "ESW",       beds: 20 }
];

// Ward keys and bed counts are fixed, but an admin can rename a ward's
// display label. Overrides live in a single Firestore doc so every
// page/device shows the same names. WARDS is mutated in place — every
// module that imports WARDS shares this one array instance.
WARDS.forEach(w => { w.defaultLabel = w.label; });

// The Ward Nurse role covers PAED BED and PAED COT together (one nurse,
// mergedTable: true), and MATERNITY covers MOTHERS and COTS together.
export const WARD_GROUPS = [
  { key: "paedward", label: "PAED WARD", wardKeys: ["paedbed", "paedcot"], mergedTable: true, demographicsVariant: "merged", patientLocationOptions: ["PAED BED", "PAED COT"] },
  { key: "matward", label: "MATERNITY WARD", wardKeys: ["matbed", "matcot"], mergedTable: true, demographicsVariant: "maternity" }
];

// Builds the Ward Nurse page's ward-selection list.
export function wardSelectorOptions() {
  const groupedKeys = new Set(WARD_GROUPS.flatMap(g => g.wardKeys));
  const out = [];
  WARDS.forEach(w => {
    if (!groupedKeys.has(w.key)) { out.push({ key: w.key, label: w.label, wardKeys: [w.key] }); return; }
    const group = WARD_GROUPS.find(g => g.wardKeys[0] === w.key);
    if (group) out.push({
      key: group.key, label: group.label, wardKeys: group.wardKeys, mergedTable: !!group.mergedTable,
      demographicsVariant: group.demographicsVariant, patientLocationOptions: group.patientLocationOptions
    });
  });
  return out;
}

export const WARD_NAMES_COLLECTION = "nurseReportConfig";
export const WARD_NAMES_DOC = "wardNames";

export function applyWardNameOverrides(overrides) {
  const map = overrides || {};
  WARDS.forEach(w => {
    const custom = map[w.key];
    w.label = (typeof custom === "string" && custom.trim()) ? custom.trim() : w.defaultLabel;
  });
}

export async function loadWardNameOverrides(db) {
  try {
    const snap = await getDoc(doc(db, WARD_NAMES_COLLECTION, WARD_NAMES_DOC));
    applyWardNameOverrides(snap.exists() ? snap.data() : {});
  } catch (e) {
    // Non-fatal — page just keeps showing the default hospital ward names.
  }
}

export async function saveWardNameOverride(db, wardKey, newLabel) {
  const trimmed = (newLabel || "").trim();
  const w = WARDS.find(x => x.key === wardKey);
  const valueToStore = trimmed && w && trimmed !== w.defaultLabel ? trimmed : null;
  await setDoc(doc(db, WARD_NAMES_COLLECTION, WARD_NAMES_DOC), { [wardKey]: valueToStore }, { merge: true });
  if (w) w.label = trimmed || w.defaultLabel;
}

// Numeric columns, in display order, matching the ward-level "24Hrs Ward
// Report" paper form.
export const STAT_FIELDS = [
  { key: "beds",        label: "Beds" },
  { key: "occ",         label: "Occ" },
  { key: "vac",         label: "Vac" },
  { key: "adm",         label: "Adm" },
  { key: "disch",       label: "Disch" },
  { key: "dama",        label: "Dama" },
  { key: "transferIn",  label: "Transfer In" },
  { key: "transferOut", label: "Transfer Out" },
  { key: "ext",         label: "Ext In" },
  { key: "extOut",      label: "Ext Out" },
  { key: "sc",          label: "S/C" },
  { key: "vsc",         label: "VS/C" },
  { key: "absc",        label: "Absc" },
  { key: "bid",         label: "BID" },
  { key: "death",       label: "Death" }
];

STAT_FIELDS.forEach(f => { f.defaultLabel = f.label; });

export const HEADER_LABELS_COLLECTION = "nurseReportConfig";
export const HEADER_LABELS_DOC = "headerLabels";
export const HEADER_LABEL_OVERRIDES = {};
export const GROUP_LABEL_IDS = { intTransfer: "_group_int_transfer", extTransfer: "_group_ext_transfer" };

export function applyHeaderLabelOverrides(overrides) {
  Object.keys(HEADER_LABEL_OVERRIDES).forEach(k => delete HEADER_LABEL_OVERRIDES[k]);
  Object.assign(HEADER_LABEL_OVERRIDES, overrides || {});
  STAT_FIELDS.forEach(f => {
    const custom = HEADER_LABEL_OVERRIDES[f.key];
    f.label = (typeof custom === "string" && custom.trim()) ? custom.trim() : f.defaultLabel;
  });
}

export async function loadHeaderLabelOverrides(db) {
  try {
    const snap = await getDoc(doc(db, HEADER_LABELS_COLLECTION, HEADER_LABELS_DOC));
    applyHeaderLabelOverrides(snap.exists() ? snap.data() : {});
  } catch (e) {
    // Non-fatal — page just keeps showing the default column names.
  }
}

export async function saveHeaderLabelOverride(db, id, newLabel, defaultLabel) {
  const trimmed = (newLabel || "").trim();
  const valueToStore = trimmed && trimmed !== defaultLabel ? trimmed : null;
  await setDoc(doc(db, HEADER_LABELS_COLLECTION, HEADER_LABELS_DOC), { [id]: valueToStore }, { merge: true });
  if (valueToStore) HEADER_LABEL_OVERRIDES[id] = valueToStore; else delete HEADER_LABEL_OVERRIDES[id];
  const f = STAT_FIELDS.find(x => x.key === id);
  if (f) f.label = trimmed || f.defaultLabel;
}

export function headerLabel(id, defaultLabel) {
  return HEADER_LABEL_OVERRIDES[id] || defaultLabel;
}

// Admin-added free-text columns layered on top of the fixed STAT_FIELDS list.
export const CUSTOM_COLUMNS_COLLECTION = "nurseReportConfig";
export const CUSTOM_COLUMNS_DOC = "customColumns";
export const CUSTOM_TEXT_COLUMNS = [];

export function applyCustomColumns(list) {
  CUSTOM_TEXT_COLUMNS.length = 0;
  (Array.isArray(list) ? list : []).forEach(c => {
    if (c && c.key && c.label) CUSTOM_TEXT_COLUMNS.push({ key: c.key, label: c.label });
  });
}

export async function loadCustomColumns(db) {
  try {
    const snap = await getDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC));
    applyCustomColumns(snap.exists() ? snap.data().columns : []);
  } catch (e) {
    // Non-fatal — page just shows no custom columns.
  }
}

function slugColumnKey(label) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "col";
  return "custom_" + slug + "_" + Math.random().toString(36).slice(2, 6);
}

export async function addCustomColumn(db, label) {
  const trimmed = (label || "").trim();
  if (!trimmed) throw new Error("A column name is required.");
  const col = { key: slugColumnKey(trimmed), label: trimmed };
  const next = CUSTOM_TEXT_COLUMNS.concat([col]);
  await setDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC), { columns: next }, { merge: true });
  applyCustomColumns(next);
  return col;
}

export async function renameCustomColumn(db, key, newLabel) {
  const trimmed = (newLabel || "").trim();
  if (!trimmed) throw new Error("A column name is required.");
  const next = CUSTOM_TEXT_COLUMNS.map(c => (c.key === key ? { key, label: trimmed } : c));
  await setDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC), { columns: next }, { merge: true });
  applyCustomColumns(next);
}

export async function removeCustomColumn(db, key) {
  const next = CUSTOM_TEXT_COLUMNS.filter(c => c.key !== key);
  await setDoc(doc(db, CUSTOM_COLUMNS_COLLECTION, CUSTOM_COLUMNS_DOC), { columns: next }, { merge: true });
  applyCustomColumns(next);
}

export const SHIFTS = [
  { key: "am", label: "Am" },
  { key: "pm", label: "Pm" }
];

export const SHIFT_STAT_FIELDS = STAT_FIELDS.filter(
  f => f.key !== "beds" && f.key !== "occ" && f.key !== "vac"
);

export const OCC_INCREASE_KEYS = ["adm", "transferIn", "ext"];
export const OCC_DECREASE_KEYS = ["disch", "dama", "transferOut", "extOut", "absc", "death"];

export function movementColorClass(key) {
  if (key === "beds") return "stat-beds";
  if (key === "occ") return "stat-occ";
  if (key === "vac") return "stat-vac";
  if (OCC_DECREASE_KEYS.includes(key)) return "stat-out";
  if (OCC_INCREASE_KEYS.includes(key)) return "stat-in";
  return "";
}

export function occDelta(shiftData) {
  const get = k => (typeof shiftData[k] === "number" ? shiftData[k] : 0);
  const inc = OCC_INCREASE_KEYS.reduce((sum, k) => sum + get(k), 0);
  const dec = OCC_DECREASE_KEYS.reduce((sum, k) => sum + get(k), 0);
  return inc - dec;
}

export function blankShift() {
  const s = {};
  SHIFT_STAT_FIELDS.forEach(f => { s[f.key] = 0; });
  DEMOGRAPHIC_FIELDS.forEach(f => { s[f.key] = 0; });
  s.nurseOnDuty = "";
  return s;
}

export function isWardDocUntouched(wardDoc) {
  if (!wardDoc || wardDoc.submitted || wardDoc.locked) return false;
  const shifts = wardDoc.shifts || {};
  return SHIFTS.every(s => {
    const shift = shifts[s.key] || {};
    if (shift.nurseOnDuty) return false;
    return SHIFT_STAT_FIELDS.every(f => !shift[f.key]) &&
      DEMOGRAPHIC_FIELDS.every(f => !shift[f.key]);
  });
}

export function defaultWardDoc(w, startOcc = 0) {
  const occ = typeof startOcc === "number" ? startOcc : 0;
  const d = {
    label: w.label, beds: w.beds, startOcc: occ, occ: occ, vac: w.beds - occ,
    locked: false, submitted: false,
    shifts: {}, patients: [], nightUpdate: "", nightUpdateBy: "", nightUpdatedAt: null
  };
  SHIFTS.forEach(s => { d.shifts[s.key] = blankShift(); });
  SHIFT_STAT_FIELDS.forEach(f => { d[f.key] = 0; });
  DEMOGRAPHIC_FIELDS.forEach(f => { d[f.key] = 0; });
  return d;
}

export function computeDemographicTotals(wardDoc) {
  const totals = {};
  DEMOGRAPHIC_FIELDS.forEach(f => {
    let sum = 0;
    SHIFTS.forEach(s => { const v = wardDoc.shifts[s.key]?.[f.key]; sum += typeof v === "number" ? v : 0; });
    totals[f.key] = sum;
  });
  return totals;
}

export const DEMOGRAPHIC_FIELDS = [
  { key: "male",     label: "Male" },
  { key: "female",   label: "Female" },
  { key: "child",    label: "Children" },
  { key: "soldier",  label: "Soldiers" },
  { key: "civilian", label: "Civilians" }
];

export const PATIENT_FIELDS = [
  { key: "emr",       label: "EMR",       type: "text" },
  { key: "age",       label: "Age",       type: "text" },
  { key: "name",      label: "Name",      type: "text" },
  { key: "sex",       label: "Sex",       type: "text" },
  { key: "doa",       label: "DOA",       type: "text" },
  { key: "diagnosis", label: "Diagnosis / Notes", type: "textarea", big: true }
];

export const PATIENT_STATUS_OPTIONS = [
  "DISCHARGE",
  "TRANS OUT",
  "NEW PATIENT",
  "TRANS IN FROM A&E",
  "DEATH",
  "ONGOING RX"
];

export const PATIENT_STATUS_ARCHIVE_REASON = {
  "DISCHARGE": "discharged",
  "TRANS OUT": "referred"
};

function pad(n) { return String(n).padStart(2, "0"); }

// Ward is Africa/Lagos — WAT, UTC+1 year-round, no DST.
function wardLocalParts(d) {
  const wat = new Date(d.getTime() + 60 * 60 * 1000);
  return { y: wat.getUTCFullYear(), m: wat.getUTCMonth(), day: wat.getUTCDate(), hour: wat.getUTCHours() };
}

// 24-hour report periods run 9:00 AM to 9:00 AM the next day.
export function reportDateId(d = new Date()) {
  const p = wardLocalParts(d);
  const base = new Date(Date.UTC(p.y, p.m, p.day - (p.hour < 9 ? 1 : 0)));
  return base.getUTCFullYear() + "-" + pad(base.getUTCMonth() + 1) + "-" + pad(base.getUTCDate());
}

export function reportPeriodLabel(dateId, kind = "OVERALL") {
  const [y, m, d] = dateId.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  const fmt = dt => pad(dt.getUTCDate()) + "/" + pad(dt.getUTCMonth() + 1) + "/" + String(dt.getUTCFullYear()).slice(2);
  return "24 HOURS " + kind + " REPORT WEF 0900HRS OF " + fmt(start) + " TO 0900HRS OF " + fmt(end);
}

export function wardReportPeriodLabel(dateId) {
  return reportPeriodLabel(dateId, "WARD");
}

export function weekId(d = new Date()) {
  const p = wardLocalParts(d);
  const date = new Date(Date.UTC(p.y, p.m, p.day));
  const dow = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((dow + 6) % 7));
  return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate());
}
