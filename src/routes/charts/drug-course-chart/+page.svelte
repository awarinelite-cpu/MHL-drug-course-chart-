<script>
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import {
    doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection, serverTimestamp
  } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { getDocSafe } from "$lib/helpers/firestoreOffline.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import {
    ROUTE_OPTIONS, FREQ_OPTIONS, ACTION_OPTIONS, STATUS_LABELS, WARD_OPTIONS,
    actionColor, defaultRow, dueLabelFor, withDrugCompletionChecked, computeRouteFromSno,
    parseBulkText, parseDoseSequence, administrationTimesFor, flaggedDrugRefs, flaggedDrugMessage,
    diffFields, autoDurationForFrequency, buildSnoSegments, buildSnoText, abbreviateReason
  } from "$lib/helpers/drugChartHelpers.js";
  import { ROSTER_TAG_FOR_REASON, clearAllocationsForPatient } from "$lib/helpers/patientAdmissionStatus.js";

  const FIELD_IDS = ["f_admission", "f_discharge", "f_diagnosis"];

  function blankDrugs() { return Array(8).fill(null).map(() => ({ name: "", route: "", frequency: "", action: "", duration: "" })); }
  function blankChartRows() { return Array(18).fill(null).map(() => defaultRow()); }

  function rowsFromDoc(dataRows) {
    return (dataRows && dataRows.length)
      ? dataRows.map(r => Array.isArray(r)
        ? { date: r[0] || "", sno: r[1] || "", time: r[2] || "", dose: r[3] || "AP", route: r[4] || "", nurse: r[5] || "", remark: r[6] || "", skipped: [] }
        : { ...r, dose: r.dose || "AP", skipped: Array.isArray(r.skipped) ? r.skipped : [] })
      : blankChartRows();
  }

  // --- Query params / patient header (ported from usePatientHeader.js + useChartBack.js) ---
  const patientId = $derived(page.url.searchParams.get("patient"));
  const admissionId = $derived(page.url.searchParams.get("admission"));
  const from = $derived(page.url.searchParams.get("from"));
  const isArchived = $derived(!!admissionId);

  function chartBackTarget() {
    if (!patientId) return "/";
    if (from === "patient" && !admissionId) return "/patient?patient=" + patientId;
    return "/charts/admission?patient=" + patientId + (admissionId ? "&admission=" + admissionId : "");
  }
  function goBack() { goto(chartBackTarget()); }

  let patient = $state(null);
  $effect(() => {
    if (!patientId) { goto("/"); return; }
    getDocSafe(doc(db, "patients", patientId)).then((snap) => {
      if (!snap.exists()) { goto("/"); return; }
      patient = { id: snap.id, ...snap.data() };
    }).catch(() => { /* offline-tolerant: header just stays blank */ });
  });

  // Device/OS Back always returns to a known route (ported from useBackLock.js)
  onMount(() => {
    try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    const onPopState = () => goto(chartBackTarget(), { replaceState: true });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  const currentNurseName = $derived(authState.profile?.name || "");

  let loaded = $state(false);
  let fields = $state({ f_admission: "", f_discharge: "", f_diagnosis: "" });
  let drugs = $state([]);
  let drugsEditMode = $state(false);
  let editingDrugRows = $state({});
  let chartRows = $state([]);
  let chartEditMode = $state(false);
  let editingChartRows = $state({});
  let verbalOrders = $state([]);
  let careInstructions = $state([]);
  let auditLog = $state([]);
  let saveStatus = $state("—");
  let now = $state(new Date());
  let archiveMeta = $state(null);

  let statusAction = $state("");
  let transferWard = $state("");
  let statusMsg = $state({ color: "", text: "" });
  let statusApplying = $state(false);

  let chartRefPath = null;
  let saveTimer = null;
  let lastAppliedUpdatedAt = null;
  let drugRowSnapshots = {};
  let chartRowSnapshots = {};

  let verbalModalOpen = $state(false);
  let verbalInput = $state("");
  let editingVerbalIndex = $state(-1);
  let verbalEditText = $state("");

  let careModalOpen = $state(false);
  let careInput = $state("");
  let editingCareIndex = $state(-1);
  let careEditText = $state("");

  let auditModalOpen = $state(false);

  const seenStorageKey = $derived("chartSeen_" + patientId + (isArchived ? "_" + admissionId : ""));
  function readSeenCount(suffix) {
    try {
      const raw = localStorage.getItem(seenStorageKey + suffix);
      return raw ? parseInt(raw, 10) || 0 : 0;
    } catch (e) { return 0; }
  }
  let careSeenCount = $state(0);
  let auditSeenCount = $state(0);
  const careUnreadCount = $derived(Math.max(0, careInstructions.length - careSeenCount));
  const auditUnreadCount = $derived(Math.max(0, auditLog.length - auditSeenCount));
  function markCareSeen() { careSeenCount = careInstructions.length; try { localStorage.setItem(seenStorageKey + "_care", String(careInstructions.length)); } catch (e) {} }
  function markAuditSeen() { auditSeenCount = auditLog.length; try { localStorage.setItem(seenStorageKey + "_audit", String(auditLog.length)); } catch (e) {} }
  function openAuditModal() { markAuditSeen(); auditModalOpen = true; }

  let diagModalOpen = $state(false);
  let diagEditing = $state(false);
  let diagEditText = $state("");

  let bulkModalOpen = $state(false);
  let bulkStep = $state(1);
  let bulkText = $state("");
  let bulkParseMsg = $state("");
  let bulkParsed = $state([]);

  let freqModalOpen = $state(false);
  let freqModalText = $state("");
  let freqApply = null;

  let snoPickerRow = $state(-1);
  let snoPickerSelected = $state([]);
  let snoPickerSkipped = $state({});
  let snoPickerEditingNum = $state(-1);
  let snoPickerEditText = $state("");
  let skipReasonPopup = $state(null);

  function logAudit(text) {
    auditLog = [...auditLog, { at: new Date().toISOString(), nurse: currentNurseName, text }];
  }

  // --- Load ---
  $effect(() => {
    if (!patientId) return;
    (async () => {
      let data = null;
      if (isArchived) {
        const admSnap = await getDoc(doc(db, "patients", patientId, "admissions", admissionId));
        if (admSnap.exists()) {
          const admData = admSnap.data();
          data = admData.drugCourseChart || null;
          archiveMeta = admData;
        }
      } else {
        chartRefPath = doc(db, "patients", patientId, "drugCourseChart", "main");
        const snap = await getDoc(chartRefPath);
        if (snap.exists()) { data = snap.data(); lastAppliedUpdatedAt = data.updatedAt || null; }
      }

      if (data) {
        const nextFields = { f_admission: "", f_discharge: "", f_diagnosis: "" };
        FIELD_IDS.forEach(id => { if (data[id]) nextFields[id] = data[id]; });
        fields = { ...fields, ...nextFields };

        const nextDrugs = (data.drugs && data.drugs.length) ? data.drugs : blankDrugs();
        drugs = nextDrugs;

        let nextRows = rowsFromDoc(data.rows);
        chartRows = nextRows.map(row => (row.sno && !row.route) ? { ...row, route: computeRouteFromSno(row.sno, nextDrugs) } : row);
        verbalOrders = data.verbalOrders || [];
        careInstructions = data.careInstructions || [];
        auditLog = data.auditLog || [];
      } else {
        drugs = blankDrugs();
        chartRows = blankChartRows();
        verbalOrders = [];
        careInstructions = [];
        auditLog = [];
      }
      careSeenCount = readSeenCount("_care");
      auditSeenCount = readSeenCount("_audit");
      saveStatus = isArchived ? "Viewing archived chart (read-only)" : "Changes save automatically";
      loaded = true;
    })();
  });

  // Date of Admission defaults to the patient's registered admission date
  $effect(() => {
    if (loaded && patient?.admissionDate && !fields.f_admission) {
      fields = { ...fields, f_admission: patient.admissionDate };
    }
  });

  // Due-label ticker + periodic completion re-check
  onMount(() => {
    const tick = setInterval(() => { now = new Date(); }, 60 * 1000);
    return () => clearInterval(tick);
  });

  $effect(() => {
    if (!loaded || isArchived) return;
    const next = withDrugCompletionChecked(drugs, chartRows);
    if (next !== drugs) { drugs = next; scheduleSave(); }
  });

  // Cross-device sync polling: every 30s, pull in newer data as long as
  // nobody's mid-edit and no field is actively focused.
  onMount(() => {
    const poll = setInterval(async () => {
      if (isArchived || !chartRefPath || chartEditMode || drugsEditMode) return;
      const active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      try {
        const snap = await getDoc(chartRefPath);
        if (!snap.exists()) return;
        const data = snap.data();
        const remoteMs = data.updatedAt?.toMillis ? data.updatedAt.toMillis() : 0;
        const localMs = lastAppliedUpdatedAt?.toMillis ? lastAppliedUpdatedAt.toMillis() : 0;
        if (remoteMs > localMs) {
          lastAppliedUpdatedAt = data.updatedAt;
          const nextFields = { f_admission: "", f_discharge: "", f_diagnosis: "" };
          FIELD_IDS.forEach(id => { if (data[id] !== undefined) nextFields[id] = data[id]; });
          fields = { ...fields, ...nextFields };
          const nextDrugs = (data.drugs && data.drugs.length) ? data.drugs : drugs;
          let nextRows = rowsFromDoc(data.rows);
          nextRows = nextRows.map(row => (row.sno && !row.route) ? { ...row, route: computeRouteFromSno(row.sno, nextDrugs) } : row);
          drugs = nextDrugs;
          chartRows = nextRows;
          verbalOrders = data.verbalOrders || [];
          careInstructions = data.careInstructions || [];
          auditLog = data.auditLog || [];
        }
      } catch (e) { /* offline-tolerant: just skip this poll */ }
    }, 30000);
    return () => clearInterval(poll);
  });

  function saveChart() {
    if (isArchived || !chartRefPath) return;
    const data = { ...fields, rows: chartRows, drugs, verbalOrders, careInstructions, auditLog, updatedAt: serverTimestamp() };
    // Not awaited — with offline persistence this writes to the local cache
    // immediately and syncs on reconnect; the Promise only resolves once the
    // backend acknowledges it, so awaiting it would leave "Saving…" stuck
    // forever offline.
    setDoc(chartRefPath, data, { merge: true }).catch((e) => {
      saveStatus = "Save failed: " + (e.code || e.message);
    });
    saveStatus = "Saved " + new Date().toLocaleTimeString();
    return Promise.resolve();
  }

  function scheduleSave() {
    if (isArchived) return;
    saveStatus = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveChart, 600);
  }

  // Safety net: flush pending changes periodically and on tab hide/close.
  onMount(() => {
    const iv = setInterval(() => { if (chartEditMode || drugsEditMode) saveChart(); }, 15000);
    const onVis = () => { if (document.visibilityState === "hidden" && (chartEditMode || drugsEditMode)) saveChart(); };
    const onUnload = () => { if (chartEditMode || drugsEditMode) saveChart(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onUnload);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("beforeunload", onUnload); };
  });

  function updateField(id, value) {
    fields = { ...fields, [id]: value };
    scheduleSave();
  }

  // --- Diagnosis modal ---
  function openDiagnosisModal(startInEdit) {
    diagEditText = fields.f_diagnosis || "";
    diagEditing = !!startInEdit && !isArchived;
    diagModalOpen = true;
  }
  function saveDiagnosisEdit() {
    const oldVal = (fields.f_diagnosis || "").trim();
    const newVal = diagEditText.trim();
    if (oldVal !== newVal) logAudit('Diagnosis: "' + (oldVal || "—") + '" → "' + (newVal || "—") + '"');
    updateField("f_diagnosis", diagEditText);
    diagModalOpen = false;
  }

  // --- Drugs table ---
  function enterDrugsEditMode() { drugsEditMode = true; editingDrugRows = {}; }
  function exitDrugsEditMode() { drugsEditMode = false; editingDrugRows = {}; scheduleSave(); }
  function unlockDrugRow(i) { drugRowSnapshots[i] = { ...drugs[i] }; editingDrugRows = { ...editingDrugRows, [i]: true }; }
  function lockDrugRow(i) {
    const before = drugRowSnapshots[i] || {};
    const after = drugs[i] || {};
    const wasBlank = !before.name && !before.route && !before.frequency && !before.action && !before.duration;
    const changes = diffFields(before, after, { name: "Name", route: "Route", frequency: "Frequency", action: "Action", duration: "Duration" });
    if (changes.length) {
      const prefix = wasBlank ? ("Drug added (#" + (i + 1) + "): ") : ("Drug #" + (i + 1) + " edited: ");
      logAudit(prefix + changes.join(", "));
    }
    delete drugRowSnapshots[i];
    const n = { ...editingDrugRows }; delete n[i]; editingDrugRows = n;
  }
  function addDrug() {
    const blank = { name: "", route: "", frequency: "", action: "", duration: "", createdAt: new Date().toISOString() };
    drugs = [...drugs, blank];
    drugRowSnapshots[drugs.length - 1] = { ...blank };
    editingDrugRows = { ...editingDrugRows, [drugs.length - 1]: true };
    scheduleSave();
  }
  function updateDrug(i, patch) {
    drugs = drugs.map((row, idx) => idx === i ? { ...row, ...patch } : row);
    scheduleSave();
  }
  function removeDrug(i) {
    if (!confirm("Remove this drug from the list?")) return;
    logAudit("Drug removed (#" + (i + 1) + "): " + (drugs[i]?.name || "(unnamed)"));
    delete drugRowSnapshots[i];
    drugs = drugs.filter((_, idx) => idx !== i);
    const n = { ...editingDrugRows }; delete n[i]; editingDrugRows = n;
    scheduleSave();
  }

  function openFreqModal(currentText, onApply) { freqModalText = currentText || ""; freqApply = onApply; freqModalOpen = true; }
  function cancelFreqModal() { freqModalOpen = false; freqApply = null; }
  function applyFreqModal() {
    const text = freqModalText.trim();
    freqModalOpen = false;
    const apply = freqApply; freqApply = null;
    if (apply) apply(text);
  }
  function handleFreqPick(i, val) {
    const drug = drugs[i];
    const isCustom = !!drug.frequency && !FREQ_OPTIONS.includes(drug.frequency);
    if (val === "Other") openFreqModal(isCustom ? drug.frequency : "", (text) => updateDrug(i, { frequency: text, duration: autoDurationForFrequency(text) || drug.duration }));
    else updateDrug(i, { frequency: val, duration: autoDurationForFrequency(val) || drug.duration });
  }

  // --- Chart table ---
  function enterChartEditMode() { chartEditMode = true; editingChartRows = {}; }
  function exitChartEditMode() { chartEditMode = false; editingChartRows = {}; scheduleSave(); }
  function unlockChartRow(i) { chartRowSnapshots[i] = { ...chartRows[i] }; editingChartRows = { ...editingChartRows, [i]: true }; }
  function lockChartRow(i) {
    const row = chartRows[i];
    const blocked = flaggedDrugRefs(row?.sno, drugs);
    if (blocked.length) { alert(flaggedDrugMessage(blocked) + "\n\nPlease correct the Drug S/N before continuing."); return; }
    const before = chartRowSnapshots[i] || {};
    const wasBlank = !before.sno && !before.date && !before.time && !(before.skipped || []).length;
    const changes = diffFields(before, row || {}, { date: "Date", sno: "Drug S/N", time: "Time", dose: "Dose", route: "Route", remark: "Remark" });
    if (changes.length) {
      const prefix = wasBlank ? ("Dose recorded (row " + (i + 1) + "): ") : ("Chart entry edited (row " + (i + 1) + "): ");
      logAudit(prefix + changes.join(", "));
    }
    delete chartRowSnapshots[i];
    const n = { ...editingChartRows }; delete n[i]; editingChartRows = n;
  }
  function touchRowNurse(row) { return (!row.nurse && currentNurseName) ? { ...row, nurse: currentNurseName } : row; }
  function updateChartRow(i, patch) {
    chartRows = chartRows.map((row, idx) => idx === i ? touchRowNurse({ ...row, ...patch }) : row);
    scheduleSave();
  }

  function activeDrugNumbers() {
    return drugs.map((d, i) => i + 1).filter(n => { const dr = drugs[n - 1]; return !dr.action || dr.action === "Ongoing"; });
  }
  function openSnoPicker(i) {
    const nums = (chartRows[i]?.sno || "").match(/\d+/g) || [];
    const active = activeDrugNumbers();
    snoPickerSelected = nums.map(n => parseInt(n, 10)).filter(n => active.includes(n));
    const skipMap = {};
    (chartRows[i]?.skipped || []).forEach(({ num, reason }) => { skipMap[num] = reason; });
    snoPickerSkipped = skipMap;
    snoPickerEditingNum = -1;
    snoPickerEditText = "";
    snoPickerRow = i;
  }
  function closeSnoPicker() { snoPickerRow = -1; snoPickerSelected = []; snoPickerSkipped = {}; snoPickerEditingNum = -1; snoPickerEditText = ""; }
  function toggleSnoPickerDrug(num) {
    const wasSelected = snoPickerSelected.includes(num);
    if (!wasSelected && snoPickerSkipped[num]) { const n = { ...snoPickerSkipped }; delete n[num]; snoPickerSkipped = n; }
    snoPickerSelected = wasSelected ? snoPickerSelected.filter(n => n !== num) : [...snoPickerSelected, num].sort((a, b) => a - b);
  }
  function openSnoSkipEditor(num) { snoPickerEditText = snoPickerSkipped[num] || ""; snoPickerEditingNum = num; }
  function cancelSnoSkipEditor() { snoPickerEditingNum = -1; snoPickerEditText = ""; }
  function saveSnoSkipReason() {
    const num = snoPickerEditingNum;
    const text = snoPickerEditText.trim();
    const n = { ...snoPickerSkipped };
    if (text) n[num] = text; else delete n[num];
    snoPickerSkipped = n;
    if (text) snoPickerSelected = snoPickerSelected.filter(x => x !== num);
    snoPickerEditingNum = -1;
    snoPickerEditText = "";
  }
  function clearSnoSkipReason(num) {
    const n = { ...snoPickerSkipped }; delete n[num]; snoPickerSkipped = n;
    if (snoPickerEditingNum === num) { snoPickerEditingNum = -1; snoPickerEditText = ""; }
  }
  function applySnoPicker() {
    const i = snoPickerRow;
    const sno = snoPickerSelected.join(", ");
    const skipped = Object.entries(snoPickerSkipped)
      .filter(([, reason]) => reason && reason.trim())
      .map(([num, reason]) => ({ num: parseInt(num, 10), reason: reason.trim() }));
    updateChartRow(i, { sno, route: computeRouteFromSno(sno, drugs), skipped });
    closeSnoPicker();
  }

  function addChartRow(count) {
    const additions = Array.from({ length: count }, () => defaultRow());
    const startIdx = chartRows.length;
    chartRows = [...chartRows, ...additions];
    const n = { ...editingChartRows };
    for (let i = 0; i < count; i++) { n[startIdx + i] = true; chartRowSnapshots[startIdx + i] = { ...defaultRow() }; }
    editingChartRows = n;
    scheduleSave();
  }
  function removeChartRow() {
    if (!chartRows.length) return;
    const last = chartRows[chartRows.length - 1];
    if (last && (last.sno || last.date || last.time)) {
      logAudit('Chart row removed (row ' + chartRows.length + '): Drug S/N="' + (last.sno || "") + '", Date=' + (last.date || "—") + ", Time=" + (last.time || "—"));
    }
    delete chartRowSnapshots[chartRows.length - 1];
    const n = { ...editingChartRows }; delete n[chartRows.length - 1]; editingChartRows = n;
    chartRows = chartRows.slice(0, -1);
    scheduleSave();
  }

  // --- Verbal orders ---
  function openVerbalModal() { editingVerbalIndex = -1; verbalModalOpen = true; }
  function closeVerbalModal() { editingVerbalIndex = -1; verbalModalOpen = false; }
  async function submitVerbalOrder() {
    const text = verbalInput.trim();
    if (!text) return;
    verbalOrders = [...verbalOrders, { text, nurse: currentNurseName, at: new Date().toISOString() }];
    logAudit("Verbal order added: " + text.slice(0, 80));
    verbalInput = "";
    await saveChart();
  }
  async function saveVerbalEdit(i) {
    const trimmed = verbalEditText.trim();
    if (!trimmed) return;
    verbalOrders = verbalOrders.map((o, idx) => idx === i ? { ...o, text: trimmed, editedAt: new Date().toISOString() } : o);
    logAudit("Verbal order edited: " + trimmed.slice(0, 80));
    editingVerbalIndex = -1;
    await saveChart();
  }
  async function deleteVerbalOrder(i) {
    if (!confirm("Delete this verbal order? This cannot be undone.")) return;
    logAudit("Verbal order deleted: " + (verbalOrders[i]?.text || "").slice(0, 80));
    verbalOrders = verbalOrders.filter((_, idx) => idx !== i);
    if (editingVerbalIndex === i) editingVerbalIndex = -1;
    await saveChart();
  }

  // --- Care instructions ---
  function openCareModal() { editingCareIndex = -1; careModalOpen = true; markCareSeen(); }
  function closeCareModal() { editingCareIndex = -1; careModalOpen = false; }
  async function submitCareInstruction() {
    const lines = careInput.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    careInstructions = [...careInstructions, ...lines.map(text => ({ text, nurse: currentNurseName, at: new Date().toISOString() }))];
    lines.forEach(text => logAudit("Care instruction added: " + text.slice(0, 80)));
    careInput = "";
    await saveChart();
  }
  async function saveCareEdit(i) {
    const trimmed = careEditText.trim();
    if (!trimmed) return;
    careInstructions = careInstructions.map((o, idx) => idx === i ? { ...o, text: trimmed, editedAt: new Date().toISOString() } : o);
    logAudit("Care instruction edited: " + trimmed.slice(0, 80));
    editingCareIndex = -1;
    await saveChart();
  }
  async function deleteCareInstruction(i) {
    if (!confirm("Delete this care instruction? This cannot be undone.")) return;
    logAudit("Care instruction deleted: " + (careInstructions[i]?.text || "").slice(0, 80));
    careInstructions = careInstructions.filter((_, idx) => idx !== i);
    if (editingCareIndex === i) editingCareIndex = -1;
    await saveChart();
  }

  // --- Bulk upload ---
  function openBulkModal() { bulkText = ""; bulkParseMsg = ""; bulkParsed = []; bulkStep = 1; bulkModalOpen = true; }
  function closeBulkModal() { bulkModalOpen = false; }
  function parseBulk() {
    const parsed = parseBulkText(bulkText);
    if (!parsed.length) { bulkParseMsg = "Paste at least one drug line first."; return; }
    bulkParsed = parsed;
    bulkStep = 2;
  }
  function updateBulkRow(i, patch) { bulkParsed = bulkParsed.map((r, idx) => idx === i ? { ...r, ...patch } : r); }
  function removeBulkRow(i) { bulkParsed = bulkParsed.filter((_, idx) => idx !== i); }
  function confirmBulkImport() {
    if (!bulkParsed.length) { closeBulkModal(); return; }
    const next = drugs.map(d => ({ ...d }));
    bulkParsed.forEach((d) => {
      const emptySlotIdx = next.findIndex(x => !x.name && !x.route && !x.frequency && !x.duration);
      if (emptySlotIdx !== -1) next[emptySlotIdx] = d; else next.push(d);
    });
    drugs = next;
    closeBulkModal();
    if (!drugsEditMode) drugsEditMode = true;
    scheduleSave();
  }

  // --- Patient status change: referred / transferred / discharged --------
  // Ported from src/pages/DrugCourseChart.jsx's applyStatusAction(). Svelte's
  // $state is read live (no latestRef.current indirection needed like the
  // React version) — `fields`, `chartRows`, `drugs`, etc. below are already
  // the latest in-memory values.
  async function applyStatusAction() {
    if (isArchived) return;
    const reason = statusAction;
    if (!reason) { statusMsg = { color: "#dc2626", text: "Please select an action first." }; return; }

    // Discharging or referring reads across five collections (vitals,
    // glycemic, intake & output, seizure, plus this chart) and then DELETES
    // the live entries once archived. Getting that sequence right needs the
    // real data, not whatever happens to be sitting in the local offline
    // cache — so those two are blocked until back online instead of being
    // made offline-tolerant like saveChart() above. Transferring wards
    // doesn't archive or clear anything (see below), so it's exempt.
    if (reason !== "transferred" && !navigator.onLine) {
      statusMsg = { color: "#dc2626", text: "This needs an internet connection — referring or discharging archives records from several charts at once and then clears them, and doing that safely requires reading the real data rather than whatever's cached locally. Please try again once online." };
      return;
    }

    let label = STATUS_LABELS[reason];
    if (reason === "transferred") {
      const wardChosen = transferWard;
      if (!wardChosen) { statusMsg = { color: "#dc2626", text: "Please select which ward the patient is being transferred to." }; return; }
      label = "Transferred to " + wardChosen;

      if (!confirm("Confirm: " + label + "?\n\nThe patient moves to " + wardChosen + "’s New Patient queue — a nurse there still has to accept them before they show up on that ward’s patient list. Their drug chart, vitals, glycemic chart, intake & output, and seizure chart all stay exactly as they are; care just continues on the new ward.")) return;

      logAudit("Patient status set: " + label);
      statusApplying = true;
      statusMsg = { color: "#555", text: "Sending transfer…" };
      await saveChart(); // flush latest drug-chart edits first

      // A ward transfer isn't a discharge: the admission carries on, just
      // on a different ward, so none of the charts get archived or reset
      // here. We only park the patient in a pendingTransferMhl for the
      // receiving MHL ward to accept — same flow as the Patient page's
      // status control. See $lib/helpers/wardTransfer.js.
      try {
        await updateDoc(doc(db, "patients", patientId), {
          pendingTransferMhl: {
            toWard: wardChosen,
            fromWard: patient?.wardMhl || "",
            transferredByName: authState.profile?.name || "",
            transferredAt: serverTimestamp(),
            transferredAtDisplay: new Date().toLocaleString()
          },
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        statusMsg = { color: "#dc2626", text: "Could not start the transfer: " + (e.code || e.message) };
        statusApplying = false;
        return;
      }

      // Sending ward's allocation no longer applies once the patient is on
      // their way to a different ward — see clearAllocationsForPatient.
      // Best-effort: the transfer itself already succeeded.
      clearAllocationsForPatient(patientId).catch((e) => console.warn("Could not clear allocations after transfer:", e));

      statusMsg = { color: "#16a34a", text: "Sent to " + wardChosen + " — awaiting acceptance there. Redirecting…" };
      setTimeout(() => goto("/"), 900);
      return;
    }

    // Discharge Date is locked (readonly) so it can only ever be set here,
    // automatically, the moment the patient is actually discharged — never
    // typed in manually.
    let dischargeDate = fields.f_discharge;
    if (reason === "discharged" && !dischargeDate) {
      dischargeDate = new Date().toISOString().slice(0, 10);
      fields = { ...fields, f_discharge: dischargeDate };
    }

    if (!confirm("Confirm: " + label + "?\n\nAll care records for this admission (drug chart, vitals, glycemic chart, intake & output, seizure chart) will be saved together to Overview, and fresh charts will open for this patient.")) return;

    logAudit("Patient status set: " + label);
    statusApplying = true;
    statusMsg = { color: "#555", text: "Saving all charts for this admission…" };
    await saveChart(); // flush latest drug-chart edits first

    async function fetchEntries(collName) {
      const snap = await getDocs(collection(db, "patients", patientId, collName));
      const arr = [];
      snap.forEach(d => arr.push(d.data()));
      return arr;
    }
    async function clearEntries(collName) {
      const snap = await getDocs(collection(db, "patients", patientId, collName));
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, "patients", patientId, collName, d.id))));
    }

    // Each chart type (6-point / 3-point) keeps its own saved rows — both
    // must be archived, not just whichever was on screen last, or switching
    // chart type before discharge would lose data.
    let bgData = { chartType: "6point", rows6: [], rows3: [] };
    try {
      const bgSnap = await getDoc(doc(db, "patients", patientId, "bloodGlucose", "main"));
      if (bgSnap.exists()) {
        const d = bgSnap.data();
        bgData = { chartType: d.chartType || "6point", rows6: d.rows6 || [], rows3: d.rows3 || [] };
      }
    } catch (e) { /* fine to archive with blank glycemic data if this fails */ }

    let vitalsArr = [], ioArr = [], seizureArr = [];
    let ioSummary = { intake: 0, output: 0, balance: 0 };
    try {
      [vitalsArr, ioArr, seizureArr] = await Promise.all([fetchEntries("vitals"), fetchEntries("intakeOutput"), fetchEntries("seizure")]);
    } catch (e) { /* fine to archive with whatever we could gather */ }
    try {
      const ioSumSnap = await getDoc(doc(db, "patients", patientId, "intakeOutputSummary", "current"));
      if (ioSumSnap.exists()) {
        const d = ioSumSnap.data();
        ioSummary = { intake: d.intake || 0, output: d.output || 0, balance: d.balance || 0 };
      }
    } catch (e) { /* fine to archive without the summary snapshot — derivable from intakeOutput entries */ }

    const drugChartData = { ...fields, f_discharge: dischargeDate, rows: chartRows, drugs, verbalOrders, careInstructions, auditLog };

    const admissionDoc = {
      diagnosis: fields.f_diagnosis,
      archiveReason: reason,
      archiveReasonLabel: label,
      archivedAt: serverTimestamp(),
      archivedAtDisplay: new Date().toLocaleString(),
      drugCourseChart: drugChartData,
      bloodGlucose: bgData,
      vitals: vitalsArr,
      intakeOutput: ioArr,
      intakeOutputSummary: ioSummary,
      seizure: seizureArr
    };

    try {
      await addDoc(collection(db, "patients", patientId, "admissions"), admissionDoc);
    } catch (e) {
      statusMsg = { color: "#dc2626", text: "Could not save to Overview: " + (e.code || e.message) };
      statusApplying = false;
      return;
    }

    const blankDrugChart = {
      f_admission: "", f_discharge: "", f_diagnosis: "",
      rows: blankChartRows(), drugs: blankDrugs(),
      verbalOrders: [], careInstructions: [], auditLog: [],
      updatedAt: serverTimestamp()
    };

    try {
      await Promise.all([
        setDoc(chartRefPath, blankDrugChart), // full overwrite (no merge) so old data doesn't linger
        setDoc(doc(db, "patients", patientId, "bloodGlucose", "main"), { chartType: "6point", rows6: [], rows3: [], updatedAt: serverTimestamp() }),
        setDoc(doc(db, "patients", patientId, "intakeOutputSummary", "current"), { intake: 0, output: 0, balance: 0, periodDate: new Date().toISOString().slice(0, 10), updatedAt: serverTimestamp() }),
        clearEntries("vitals"), clearEntries("intakeOutput"), clearEntries("seizure"),
        // Tag the patient doc so the Ward Report's "Select from ward"
        // picker can flag them DISCHARGE/TRANS OUT for the nurse — they
        // stay on that ward's roster until a closing report is submitted
        // for them (see closeOutDischargedPatient in patientAdmissionStatus.js).
        updateDoc(doc(db, "patients", patientId), { dischargeStatus: ROSTER_TAG_FOR_REASON[reason] || "", dischargeStatusAt: serverTimestamp() })
      ]);
    } catch (e) {
      statusMsg = { color: "#dc2626", text: "Archived, but could not fully reset the new charts: " + (e.code || e.message) };
      statusApplying = false;
      return;
    }

    // Admission is over — see clearAllocationsForPatient. Best-effort, same
    // reasoning as the transfer branch above.
    clearAllocationsForPatient(patientId).catch((e) => console.warn("Could not clear allocations after discharge/refer:", e));

    statusMsg = { color: "#16a34a", text: "Saved to Overview. Redirecting…" };
    setTimeout(() => goto("/"), 900);
  }

  onDestroy(() => { clearTimeout(saveTimer); });
</script>

<Topbar brand="Drug Course Chart">
  <button class="btn btn-secondary no-print" onclick={goBack}>&larr; Back</button>
  <button class="btn btn-primary no-print" onclick={() => window.print()}>Print</button>
</Topbar>

<div class="container no-print">
  {#if patient}
    <div class="patient-banner">
      <div>
        <div class="pname">{patient.name || "Unnamed"}</div>
        <div class="pmeta">EMR: {patient.emr || "N/A"}</div>
      </div>
    </div>
  {/if}
  {#if isArchived && archiveMeta}
    <div style="background:#fef3c7;border:1px solid #f59e0b;color:#78350f;font-weight:bold;padding:8px 12px;border-radius:6px;margin-top:10px;font-size:13px;">
      Archived chart — {archiveMeta.archiveReasonLabel || STATUS_LABELS[archiveMeta.archiveReason] || "Closed"}
      {#if archiveMeta.archivedAtDisplay} on {archiveMeta.archivedAtDisplay}{/if}
    </div>
  {/if}
  <div style="font-size:12px;color:#555;margin-top:8px;text-align:right;">{saveStatus}</div>
</div>

{#if !loaded}
  <div class="container"><div class="card-box"><div class="loading-note">Loading chart…</div></div></div>
{:else}
  <div class="sheet">
    <div class="header"><h1>MILITARY HOSPITAL LAGOS</h1></div>
    <div class="header-sub"><h2>Drugs Course Chart</h2></div>

    <div class="info-grid-wrap">
      <div class="info-grid">
        <div class="info-row"><label for="">NAME:</label><span class="val">{patient?.name || ""}</span></div>
        <div class="info-row"><label for="">EMR:</label><span class="val">{patient?.emr || ""}</span></div>
        <div class="info-row"><label for="">WARD:</label><span class="val">{patient?.wardMhl || ""}</span></div>
        <div class="info-row"><label for="">Hospital No:</label><span class="val">{patient?.hospNo || ""}</span></div>
        <div class="info-row"><label for="">AGE:</label><span class="val">{patient?.age || ""}</span></div>
        <div class="info-row">
          <label for="f_admission">Date of Admission:</label>
          <input id="f_admission" type="date" readonly={isArchived} value={fields.f_admission}
            onchange={(e) => updateField("f_admission", e.target.value)} />
        </div>
        <div class="info-row">
          <label for="">Diagnosis:</label>
          <input type="text" placeholder="Enter diagnosis for this chart" readonly value={fields.f_diagnosis}
            onclick={() => openDiagnosisModal(false)} />
        </div>
        <div class="info-row">
          <label for="">Discharge Date:</label>
          <input type="date" readonly value={fields.f_discharge}
            title="Auto-filled when the patient is discharged — cannot be entered manually"
            style="background:#f3f4f6;cursor:not-allowed;pointer-events:none;" />
        </div>
      </div>
    </div>

    <div class="no-print" style="margin:-4px 0 14px;">
      <button class="btn btn-secondary" style="position:relative;" onclick={openCareModal}>
        {careInstructions.length ? "\uD83D\uDCAC Care Instructions (" + careInstructions.length + ")" : "+ Care Instructions"}
        {#if careUnreadCount > 0}<span class="notif-badge">{careUnreadCount > 99 ? "99+" : careUnreadCount}</span>{/if}
      </button>
      <button class="btn btn-secondary" style="position:relative;" onclick={openAuditModal}>
        {"\uD83D\uDD53 Audit Log" + (auditLog.length ? " (" + auditLog.length + ")" : "")}
        {#if auditUnreadCount > 0}<span class="notif-badge">{auditUnreadCount > 99 ? "99+" : auditUnreadCount}</span>{/if}
      </button>
    </div>

    <div class="drugs-block">
      <h3>Drugs</h3>
      <div class="table-wrap">
        <table class="drugs-table">
          <thead>
            <tr>
              {#if drugsEditMode}<th class="col-rowedit no-print"></th>{/if}
              <th style="width:34px;">No.</th><th class="col-drugname">Drug Name</th><th>Route</th><th>Frequency</th><th>Action</th><th>Duration</th>
              <th class="no-print">Due</th>
              {#if drugsEditMode}<th class="no-print" style="width:34px;"></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each drugs as drug, i (i)}
              {@const due = dueLabelFor(drug, i, chartRows, now)}
              {@const seq = parseDoseSequence(drug.frequency)}
              {@const editing = drugsEditMode && editingDrugRows[i]}
              {@const showPencil = drugsEditMode && !editing}
              {#if editing}
                <tr>
                  <td class="col-rowedit no-print"><button class="row-lock-btn" title="Done editing this row" onclick={() => lockDrugRow(i)}>&#10003;</button></td>
                  <td>{i + 1}</td>
                  <td class="col-drugname"><input type="text" value={drug.name || ""} oninput={(e) => updateDrug(i, { name: e.target.value })} /></td>
                  <td>
                    <select value={drug.route || ""} onchange={(e) => updateDrug(i, { route: e.target.value })}>
                      {#each ROUTE_OPTIONS as opt}<option value={opt}>{opt || "—"}</option>{/each}
                    </select>
                  </td>
                  <td>
                    <select value={FREQ_OPTIONS.includes(drug.frequency) ? drug.frequency : (drug.frequency ? "Other" : "")}
                      onchange={(e) => handleFreqPick(i, e.target.value)}>
                      {#each FREQ_OPTIONS as opt}<option value={opt}>{opt || "—"}</option>{/each}
                    </select>
                    {#if drug.frequency && !FREQ_OPTIONS.includes(drug.frequency)}
                      <div style="font-size:10px;color:#555;font-style:italic;margin-top:2px;cursor:pointer;" role="button" tabindex="0"
                        onclick={() => openFreqModal(drug.frequency, (text) => updateDrug(i, { frequency: text }))}>
                        {drug.frequency}
                      </div>
                    {/if}
                  </td>
                  <td>
                    <select value={drug.action || ""} onchange={(e) => updateDrug(i, { action: e.target.value })}
                      style={drug.action ? "background:" + actionColor(drug.action) + ";color:#fff;font-weight:bold;" : ""}>
                      {#each ACTION_OPTIONS as opt}<option value={opt}>{opt || "—"}</option>{/each}
                    </select>
                  </td>
                  <td>
                    <input type="text" placeholder="e.g. 3/7 or 5 days" value={drug.duration || ""} oninput={(e) => {
                      const val = e.target.value;
                      const patch = { duration: val };
                      if (val && !drug.startDate) patch.startDate = new Date().toISOString().slice(0, 10);
                      updateDrug(i, patch);
                    }} />
                  </td>
                  <td class="no-print" style={due.overdue ? "color:#dc2626;font-weight:bold;" : due.skippedPending ? "color:#d97706;font-weight:bold;" : ""}
                    title={due.skippedPending ? "Last due dose was documented as not given" : undefined}>{due.text}</td>
                  <td class="no-print"><button class="remove-drug-btn" onclick={() => removeDrug(i)}>x</button></td>
                </tr>
              {:else}
                <tr>
                  {#if showPencil}<td class="col-rowedit no-print"><button class="row-edit-btn" title="Edit this row" onclick={() => unlockDrugRow(i)}>&#128394;</button></td>{/if}
                  <td>{i + 1}</td>
                  <td class="col-drugname">
                    {drug.name || "—"}
                    {#if seq}
                      <div class="dose-seq-badges">
                        {#each seq as hr, idx}
                          {@const given = idx < administrationTimesFor(chartRows, i).length}
                          <span class={"dose-seq-pill " + (given ? "given" : "pending")}>{hr}h{given ? " ✓" : ""}</span>
                        {/each}
                      </div>
                    {/if}
                  </td>
                  <td>{drug.route || "—"}</td>
                  <td>{drug.frequency || "—"}</td>
                  <td>{#if drug.action}<span style={"display:inline-block;padding:2px 8px;border-radius:10px;color:#fff;font-size:11px;font-weight:bold;background:" + actionColor(drug.action) + ";"}>{drug.action}</span>{:else}—{/if}</td>
                  <td>{drug.duration || "—"}</td>
                  <td class="no-print" style={due.overdue ? "color:#dc2626;font-weight:bold;" : due.skippedPending ? "color:#d97706;font-weight:bold;" : ""}
                    title={due.skippedPending ? "Last due dose was documented as not given" : undefined}>{due.text}</td>
                  {#if showPencil}<td class="no-print"></td>{/if}
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>

      {#if !isArchived}
        <div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap;">
          {#if !drugsEditMode}
            <button class="btn btn-purple" onclick={enterDrugsEditMode}>Edit</button>
          {:else}
            <button class="btn btn-success" onclick={exitDrugsEditMode}>Save</button>
          {/if}
          {#if drugsEditMode}
            <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick={openVerbalModal}>
              {verbalOrders.length ? "\uD83D\uDCAC Verbal Order (" + verbalOrders.length + ")" : "+ Verbal Order"}
            </button>
            <button class="btn btn-secondary" onclick={addDrug}>+ Add Drug</button>
            <button class="btn btn-secondary" onclick={openBulkModal}>+ Bulk Upload</button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="table-wrap">
      <table class="chart">
        <thead>
          <tr>
            {#if chartEditMode}<th class="col-rowedit no-print"></th>{/if}
            <th class="col-date">Date</th><th class="col-sno">Drug S/N</th><th class="col-time">Time</th>
            <th class="col-dose">Dose</th><th class="col-route">Route</th><th class="col-nurse">Nurses Name</th><th class="col-remark">Remark</th>
          </tr>
        </thead>
        <tbody>
          {#each chartRows as row, i (i)}
            {@const editing = chartEditMode && editingChartRows[i]}
            {@const showPencil = chartEditMode && !editing}
            {#if editing}
              <tr>
                <td class="col-rowedit no-print"><button class="row-lock-btn" title="Done editing this row" onclick={() => lockChartRow(i)}>&#10003;</button></td>
                <td class="col-date"><input type="date" value={row.date || ""} onchange={(e) => updateChartRow(i, { date: e.target.value })} /></td>
                <td class="col-sno"><button type="button" class="sno-picker-btn" onclick={() => openSnoPicker(i)}>
                  <span class="sno-picker-text">{buildSnoText(row.sno, row.skipped) || "Select drug(s)"}</span>
                  <span class="sno-picker-caret">&#9662;</span>
                </button></td>
                <td class="col-time"><input type="time" value={row.time || ""} onchange={(e) => updateChartRow(i, { time: e.target.value })} /></td>
                <td class="col-dose"><input type="text" value={row.dose || "AP"} oninput={(e) => updateChartRow(i, { dose: e.target.value })} /></td>
                <td class="col-route"><input type="text" value={row.route || ""} oninput={(e) => updateChartRow(i, { route: e.target.value })} /></td>
                <td class="col-nurse"><input type="text" readonly value={row.nurse || ""} /></td>
                <td class="col-remark"><input type="text" value={row.remark || ""} oninput={(e) => updateChartRow(i, { remark: e.target.value })} /></td>
              </tr>
            {:else}
              {@const segs = buildSnoSegments(row.sno, row.skipped)}
              {@const givenSegs = segs.filter((s) => s.type === "given")}
              {@const skipSegs = segs.filter((s) => s.type === "skip")}
              <tr>
                {#if showPencil}<td class="col-rowedit no-print"><button class="row-edit-btn" title="Edit this row" onclick={() => unlockChartRow(i)}>&#128394;</button></td>{/if}
                <td class="col-date view-cell">{row.date || "\u00A0"}</td>
                <td class="col-sno view-cell">
                  {#if !segs.length}
                    {"\u00A0"}
                  {:else}
                    {#each givenSegs as s, idx}<span>{s.text}</span>{/each}
                    {#if givenSegs.length > 0 && skipSegs.length > 0}<br />{/if}
                    {#each skipSegs as s, idx}
                      <span class="sno-skip-text sno-skip-tap" onclick={() => skipReasonPopup = { nums: s.nums, reason: s.fullReason }}>
                        {(idx > 0 ? ". " : "") + s.text}
                      </span>
                    {/each}
                  {/if}
                </td>
                <td class="col-time view-cell">{row.time || "\u00A0"}</td>
                <td class="col-dose view-cell">{row.dose || "AP"}</td>
                <td class="col-route view-cell">{row.route || "\u00A0"}</td>
                <td class="col-nurse view-cell">{row.nurse || "\u00A0"}</td>
                <td class="col-remark view-cell">{row.remark || "\u00A0"}</td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    {#if !isArchived}
      <div class="no-print" style="margin-top:10px;">
        {#if !chartEditMode}
          <button class="btn btn-purple" onclick={enterChartEditMode}>Edit</button>
        {:else}
          <button class="btn btn-success" onclick={exitChartEditMode}>Save</button>
          <button class="btn btn-success" onclick={() => addChartRow(1)}>+ Add Row</button>
          <button class="btn btn-secondary" onclick={removeChartRow}>&minus; Remove Row</button>
        {/if}
      </div>
    {/if}

    {#if !isArchived}
      <div class="no-print" style="margin-top:18px;padding-top:16px;border-top:1px solid #e5e7eb;">
        <label style="font-weight:bold;font-size:13px;display:block;margin-bottom:6px;">Patient Status</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select style="width:auto;min-width:220px;" value={statusAction}
            onchange={(e) => { statusAction = e.target.value; if (e.target.value !== "transferred") transferWard = ""; }}>
            <option value="">Select action…</option>
            <option value="referred">Referred to another hospital</option>
            <option value="transferred">Transferred to another ward</option>
            <option value="discharged">Discharged</option>
          </select>
          {#if statusAction === "transferred"}
            <select style="width:auto;min-width:220px;" value={transferWard} onchange={(e) => transferWard = e.target.value}>
              <option value="">Select ward…</option>
              {#each WARD_OPTIONS as w}<option value={w}>{w}</option>{/each}
            </select>
          {/if}
          <button class="btn btn-primary" style="padding:8px 14px;font-size:13px;" disabled={statusApplying} onclick={applyStatusAction}>Apply</button>
        </div>
        {#if statusMsg.text}<div style="font-size:12px;margin-top:8px;color:{statusMsg.color};">{statusMsg.text}</div>{/if}
      </div>
    {/if}
  </div>
{/if}

<!-- Diagnosis modal -->
{#if diagModalOpen}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) diagModalOpen = false; }}>
    <div class="modal-box diag-modal-box">
      <div class="modal-header">
        <h3>Diagnosis</h3>
        <div class="diag-header-actions">
          {#if !isArchived && !diagEditing}
            <button class="diag-edit-btn" title="Edit diagnosis" onclick={() => { diagEditText = fields.f_diagnosis || ""; diagEditing = true; }}>✏️</button>
          {/if}
          <button class="diag-edit-btn" title="Close" onclick={() => diagModalOpen = false}>&times;</button>
        </div>
      </div>
      <div class="diag-modal-body">
        {#if diagEditing}
          <textarea class="diag-edit-textarea" rows="3" placeholder="Enter diagnosis for this chart" bind:value={diagEditText}></textarea>
        {:else}
          <p class="diag-full-text">{fields.f_diagnosis || "(No diagnosis entered)"}</p>
        {/if}
      </div>
      {#if diagEditing}
        <div class="diag-modal-footer modal-footer">
          <button class="btn btn-secondary" onclick={() => { diagEditText = fields.f_diagnosis || ""; diagEditing = false; }}>Cancel</button>
          <button class="btn btn-primary" onclick={saveDiagnosisEdit}>Save</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Frequency modal -->
{#if freqModalOpen}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) cancelFreqModal(); }}>
    <div class="modal-box" style="max-width:560px;">
      <div class="modal-header"><h3>Custom Frequency</h3><button class="modal-close" onclick={cancelFreqModal}>&times;</button></div>
      <div class="modal-body">
        <textarea rows="4" style="width:100%;font-size:14px;padding:8px;box-sizing:border-box;resize:vertical;"
          placeholder="e.g. STAT, then 40mg 12hrly" bind:value={freqModalText}></textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick={cancelFreqModal}>Cancel</button>
        <button class="btn btn-primary" onclick={applyFreqModal}>Apply</button>
      </div>
    </div>
  </div>
{/if}

<!-- Sno picker modal -->
{#if snoPickerRow !== -1}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) closeSnoPicker(); }}>
    <div class="modal-box">
      <div class="modal-header"><h3>Select Drug(s) Given</h3><button class="modal-close" onclick={closeSnoPicker}>&times;</button></div>
      <div class="modal-body">
        {#if activeDrugNumbers().length === 0}
          <p style="color:#777;font-size:13px;margin:0;">No active drugs on this chart yet.</p>
        {/if}
        {#each activeDrugNumbers() as num}
          {@const drug = drugs[num - 1]}
          {@const due = dueLabelFor(drug, num - 1, chartRows, now)}
          {@const checked = snoPickerSelected.includes(num)}
          {@const skipReason = snoPickerSkipped[num]}
          {@const editingThis = snoPickerEditingNum === num}
          <div class="sno-picker-row">
            <label class="sno-picker-option">
              <input type="checkbox" {checked} onchange={() => toggleSnoPickerDrug(num)} />
              <span class="sno-picker-option-text" style={due.overdue ? "color:#dc2626;font-weight:bold;" : skipReason ? "color:#d97706;" : ""}>
                {num}{drug?.name ? " - " + drug.name : ""}{drug?.route ? " (" + drug.route + ")" : ""}
              </span>
              {#if due.overdue}<span class="sno-picker-due-tag">Due {due.text}</span>{/if}
              <button type="button" class="sno-picker-pencil-btn" title="Not given — write a reason" aria-label="Not given — write a reason"
                onclick={(e) => { e.preventDefault(); openSnoSkipEditor(num); }}>✏️</button>
            </label>
          </div>
          {#if skipReason && !editingThis}
            <div class="sno-picker-skip-note" onclick={() => openSnoSkipEditor(num)}>{num} {abbreviateReason(skipReason)}</div>
          {/if}
          {#if editingThis}
            <div class="sno-picker-skip-editor">
              <textarea rows="2" placeholder="Reason not given, e.g. No IV line" bind:value={snoPickerEditText}></textarea>
              <div style="display:flex;gap:6px;margin-top:4px;">
                <button class="btn btn-primary" style="padding:4px 10px;font-size:12px;" onclick={saveSnoSkipReason}>Save</button>
                {#if skipReason}<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick={() => clearSnoSkipReason(num)}>Clear</button>{/if}
                <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick={cancelSnoSkipEditor}>Cancel</button>
              </div>
            </div>
          {/if}
        {/each}
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" style="flex:1;" onclick={applySnoPicker}>Done</button>
      </div>
    </div>
  </div>
{/if}

{#if skipReasonPopup}
  <div class="field-popup-overlay no-print" style="display:flex;" onclick={(e) => { if (e.target === e.currentTarget) skipReasonPopup = null; }}>
    <div class="field-popup-box">
      <div class="field-popup-header"><h3>Drug {skipReasonPopup.nums.join(", ")} — Not Given</h3><button class="field-popup-close" onclick={() => skipReasonPopup = null}>&times;</button></div>
      <div class="field-popup-body"><p class="field-popup-text">{skipReasonPopup.reason}</p></div>
    </div>
  </div>
{/if}

<!-- Verbal orders modal -->
{#if verbalModalOpen}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) closeVerbalModal(); }}>
    <div class="modal-box">
      <div class="modal-header"><h3>Verbal Orders</h3><button class="modal-close" onclick={closeVerbalModal}>&times;</button></div>
      <div class="modal-body">
        {#if !isArchived}
          <textarea rows="2" style="width:100%;" placeholder="New verbal order" bind:value={verbalInput}></textarea>
          <button class="btn btn-primary" style="margin-top:6px;" onclick={submitVerbalOrder}>Add</button>
        {/if}
        {#each verbalOrders as order, i}
          <div class="audit-entry">
            <div class="audit-meta">{order.nurse || "Unknown"} · {order.at ? new Date(order.at).toLocaleString() : ""}</div>
            {#if editingVerbalIndex === i}
              <textarea rows="2" style="width:100%;" bind:value={verbalEditText}></textarea>
              <div style="display:flex;gap:6px;margin-top:4px;">
                <button class="btn btn-primary" style="padding:4px 10px;font-size:12px;" onclick={() => saveVerbalEdit(i)}>Save</button>
                <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick={() => editingVerbalIndex = -1}>Cancel</button>
              </div>
            {:else}
              <div class="audit-text">{order.text}</div>
              {#if !isArchived}
                <div style="display:flex;gap:6px;margin-top:4px;">
                  <button class="btn btn-secondary" style="padding:2px 8px;font-size:12px;" onclick={() => { editingVerbalIndex = i; verbalEditText = order.text; }}>Edit</button>
                  <button class="btn btn-secondary" style="padding:2px 8px;font-size:12px;" onclick={() => deleteVerbalOrder(i)}>Delete</button>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<!-- Care instructions modal -->
{#if careModalOpen}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) closeCareModal(); }}>
    <div class="modal-box">
      <div class="modal-header"><h3>Care Instructions</h3><button class="modal-close" onclick={closeCareModal}>&times;</button></div>
      <div class="modal-body">
        {#if !isArchived}
          <textarea rows="3" style="width:100%;" placeholder="One instruction per line" bind:value={careInput}></textarea>
          <button class="btn btn-primary" style="margin-top:6px;" onclick={submitCareInstruction}>Add</button>
        {/if}
        {#each careInstructions as instr, i}
          <div class="audit-entry">
            <div class="audit-meta">{instr.nurse || "Unknown"} · {instr.at ? new Date(instr.at).toLocaleString() : ""}</div>
            {#if editingCareIndex === i}
              <textarea rows="2" style="width:100%;" bind:value={careEditText}></textarea>
              <div style="display:flex;gap:6px;margin-top:4px;">
                <button class="btn btn-primary" style="padding:4px 10px;font-size:12px;" onclick={() => saveCareEdit(i)}>Save</button>
                <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick={() => editingCareIndex = -1}>Cancel</button>
              </div>
            {:else}
              <div class="audit-text">{instr.text}</div>
              {#if !isArchived}
                <div style="display:flex;gap:6px;margin-top:4px;">
                  <button class="btn btn-secondary" style="padding:2px 8px;font-size:12px;" onclick={() => { editingCareIndex = i; careEditText = instr.text; }}>Edit</button>
                  <button class="btn btn-secondary" style="padding:2px 8px;font-size:12px;" onclick={() => deleteCareInstruction(i)}>Delete</button>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<!-- Audit log modal -->
{#if auditModalOpen}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) auditModalOpen = false; }}>
    <div class="modal-box">
      <div class="modal-header"><h3>🕓 Audit Log</h3><button class="modal-close" onclick={() => auditModalOpen = false}>&times;</button></div>
      <div class="modal-body">
        {#if !auditLog.length}<p style="color:#777;font-size:13px;margin:0;">No changes logged yet.</p>{/if}
        {#each [...auditLog].reverse() as entry}
          <div class="audit-entry">
            <div class="audit-meta">{entry.nurse || "Unknown"} · {entry.at ? new Date(entry.at).toLocaleString() : ""}</div>
            <div class="audit-text">{entry.text}</div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<!-- Bulk upload modal -->
{#if bulkModalOpen}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) closeBulkModal(); }}>
    <div class="modal-box" style="max-width:640px;">
      <div class="modal-header"><h3>Bulk Upload Drugs</h3><button class="modal-close" onclick={closeBulkModal}>&times;</button></div>
      <div class="modal-body">
        {#if bulkStep === 1}
          <textarea rows="10" style="width:100%;font-family:inherit;font-size:13px;box-sizing:border-box;padding:8px;"
            placeholder={"Tabs Omeprazole 20mg bd x2/52\nIV Ceftriaxone 1g 12hrly\nTab Doxycycline 100mg bd"}
            bind:value={bulkText}></textarea>
          {#if bulkParseMsg}<div style="font-size:12px;color:#dc2626;margin-top:6px;">{bulkParseMsg}</div>{/if}
        {:else}
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead><tr style="background:#f2f2f2;">
                <th style="border:1px solid #000;padding:4px;">Drug Name</th>
                <th style="border:1px solid #000;padding:4px;">Route</th>
                <th style="border:1px solid #000;padding:4px;">Frequency</th>
                <th style="border:1px solid #000;padding:4px;">Duration</th>
                <th style="border:1px solid #000;padding:4px;"></th>
              </tr></thead>
              <tbody>
                {#each bulkParsed as d, i}
                  <tr>
                    <td style="border:1px solid #000;padding:3px;"><input type="text" style="width:100%;border:none;font-size:12px;" value={d.name} oninput={(e) => updateBulkRow(i, { name: e.target.value })} /></td>
                    <td style="border:1px solid #000;padding:3px;">
                      <select style="font-size:12px;" value={d.route || ""} onchange={(e) => updateBulkRow(i, { route: e.target.value })}>
                        {#each ROUTE_OPTIONS as opt}<option value={opt}>{opt || "—"}</option>{/each}
                      </select>
                    </td>
                    <td style="border:1px solid #000;padding:3px;"><input type="text" style="width:100%;border:none;font-size:12px;" value={d.frequency} oninput={(e) => updateBulkRow(i, { frequency: e.target.value })} /></td>
                    <td style="border:1px solid #000;padding:3px;"><input type="text" style="width:100%;border:none;font-size:12px;" value={d.duration} oninput={(e) => updateBulkRow(i, { duration: e.target.value })} /></td>
                    <td style="border:1px solid #000;padding:3px;text-align:center;"><button class="remove-drug-btn" onclick={() => removeBulkRow(i)}>x</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
      {#if bulkStep === 1}
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick={closeBulkModal}>Cancel</button>
          <button class="btn btn-primary" onclick={parseBulk}>Parse</button>
        </div>
      {:else}
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick={() => bulkStep = 1}>Back</button>
          <button class="btn btn-success" onclick={confirmBulkImport}>Add to List</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
