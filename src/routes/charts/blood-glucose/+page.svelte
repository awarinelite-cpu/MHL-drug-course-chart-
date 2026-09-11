<script>
  // Ported from src/pages/BloodGlucose.jsx. useBackLock/useChartBack/
  // usePatientHeader are inlined (same convention as the other chart
  // pages in this rebuild). Rows are a plain spreadsheet grid — not
  // EntryChart-based, same as the original — because each row is a
  // free-form array of cell strings rather than a keyed entry object.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import PatientBanner from "$lib/components/PatientBanner.svelte";

  const STATUS_LABELS = { referred: "Referred to another hospital", transferred: "Transferred to another ward", discharged: "Discharged" };

  const CHART_DEFS = {
    "6point": {
      title: "6 Points Glycemic Chart",
      columns: [
        { label: "Date", type: "date" },
        { label: "Time", type: "time" },
        { label: "FBS", type: "text", glucose: true, glucoseType: "fasting" },
        { label: "2hrs Post Prandial", type: "text", glucose: true, glucoseType: "post" },
        { label: "Pre-Lunch", type: "text", glucose: true, glucoseType: "fasting" },
        { label: "2hrs Post Lunch", type: "text", glucose: true, glucoseType: "post" },
        { label: "Pre-Dinner", type: "text", glucose: true, glucoseType: "fasting" },
        { label: "2hrs Post Dinner", type: "text", glucose: true, glucoseType: "post" },
        { label: "Remark", type: "text" }
      ]
    },
    "3point": {
      title: "3 Points Glycemic Chart",
      columns: [
        { label: "Date", type: "date" },
        { label: "Time", type: "time" },
        { label: "FBS", type: "text", glucose: true, glucoseType: "fasting" },
        { label: "RBS", type: "text", glucose: true, glucoseType: "random" },
        { label: "RBS", type: "text", glucose: true, glucoseType: "random" },
        { label: "Remark", type: "text" }
      ]
    }
  };

  // How many columns each chart type had BEFORE the Time column was added
  // (right after Date). A saved row this short predates that change —
  // insert a blank Time cell at index 1 so its existing values land back
  // under the same headers they were saved under, instead of shifting one
  // column left.
  const PRE_TIME_COLUMN_COUNT = { "6point": 8, "3point": 5 };
  function migrateRow(type, row) {
    if (Array.isArray(row) && row.length === PRE_TIME_COLUMN_COUNT[type]) {
      return [row[0], "", ...row.slice(1)];
    }
    return row;
  }

  // 6-point glycemic chart normal ranges:
  //   Fasting / pre-meal (before breakfast, lunch, dinner): 70-99 mg/dL
  //   2 hrs post-prandial (after breakfast, lunch, dinner): under 140 mg/dL
  // Anything outside these ranges is flagged red. Random (3-point RBS)
  // readings fall back to a general hypo/hyperglycemia flag since no fixed
  // target applies.
  function isAbnormalGlucose(v, glucoseType) {
    const n = parseFloat(v);
    if (isNaN(n)) return false;
    if (glucoseType === "fasting") return n < 70 || n > 99;
    if (glucoseType === "post") return n < 70 || n >= 140;
    return n < 70 || n > 180;
  }

  function emptyRows() { return Array.from({ length: 10 }, () => []); }

  // On mobile, tapping a date/time input always opens the OS's full picker
  // sheet regardless of where on the field you tap. On desktop, clicking
  // the field just places a text cursor — the native dropdown picker only
  // opens if you click the small calendar/clock icon specifically, which
  // is easy to miss in a narrow table cell. Forcing showPicker() on click
  // makes desktop match the "tap anywhere to pick" behavior mobile already has.
  function openPicker(el) {
    if (!el || typeof el.showPicker !== "function") return;
    try { el.showPicker(); } catch (e) { /* not focused/supported here — typing still works */ }
  }

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

  onMount(() => {
    try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    const onPopState = () => goto(chartBackTarget(), { replaceState: true });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  let patient = $state(null);
  $effect(() => {
    if (!patientId) { patient = null; return; }
    let cancelled = false;
    getDoc(doc(db, "patients", patientId)).then((snap) => {
      if (cancelled) return;
      if (snap.exists()) patient = { id: snap.id, ...snap.data() };
    }).catch(() => { /* header just stays blank if this fails */ });
    return () => { cancelled = true; };
  });

  let currentType = $state("6point");
  // Each chart type keeps its own rows. Switching the toggle only changes
  // which one is on screen — it never deletes the other type's data.
  let rowsCache = $state({ "6point": [], "3point": [] });
  let saveStatus = $state("\u2014");
  let archiveMeta = $state(null);
  let loaded = $state(false);
  let saveTimerId = null;
  let chartRefPath = null;

  $effect(() => {
    if (!patientId) return;
    (async () => {
      let data = null;
      if (isArchived) {
        const admSnap = await getDoc(doc(db, "patients", patientId, "admissions", admissionId));
        if (admSnap.exists()) {
          const admData = admSnap.data();
          archiveMeta = admData;
          data = admData.bloodGlucose || null;
        }
      } else {
        chartRefPath = doc(db, "patients", patientId, "bloodGlucose", "main");
        const snap = await getDoc(chartRefPath);
        if (snap.exists()) data = snap.data();
      }

      // Rows are stored as { cells: [...] } (Firestore rejects bare nested
      // arrays) — unwrap back to a plain array for the table.
      const unwrap = (arr) => (arr || []).map(r => r.cells || r);
      const type = (data && data.chartType === "3point") ? "3point" : "6point";
      let nextCache = { "6point": [], "3point": [] };
      if (data && (data.rows6 || data.rows3)) {
        nextCache["6point"] = unwrap(data.rows6).map(r => migrateRow("6point", r));
        nextCache["3point"] = unwrap(data.rows3).map(r => migrateRow("3point", r));
      } else if (data && data.rows && data.rows.length) {
        nextCache[type] = unwrap(data.rows).map(r => migrateRow(type, r));
      }
      if (!isArchived) {
        if (!nextCache["6point"].length) nextCache["6point"] = emptyRows();
        if (!nextCache["3point"].length && type === "3point") nextCache["3point"] = emptyRows();
      }

      currentType = type;
      rowsCache = nextCache;
      saveStatus = isArchived ? "Viewing archived chart (read-only)" : "Changes save automatically — tap Save to confirm";
      loaded = true;
    })();
  });

  function scheduleSave() {
    if (isArchived) return;
    saveStatus = "Saving…";
    clearTimeout(saveTimerId);
    saveTimerId = setTimeout(saveChart, 600);
  }

  async function saveChart() {
    if (isArchived || !chartRefPath) return;
    // Defensive: a row can still be a sparse array (holes = undefined) if it
    // came from an older cached/loaded state. Firestore rejects `undefined`
    // field values outright, which is what made saving fail whenever a
    // column — or, for a day with no test strip, every column — was left
    // empty. Normalize every hole to '' so an all-empty row still saves.
    const toDocRows = (arr) => arr.map(cells => ({ cells: cells.map(c => (c === undefined ? '' : c)) }));
    try {
      await setDoc(chartRefPath, {
        chartType: currentType,
        rows6: toDocRows(rowsCache["6point"]),
        rows3: toDocRows(rowsCache["3point"]),
        updatedAt: serverTimestamp()
      }, { merge: true });
      saveStatus = "Saved " + new Date().toLocaleTimeString();
    } catch (e) {
      saveStatus = "Save failed: " + (e.code || e.message);
    }
  }

  function manualSave() {
    clearTimeout(saveTimerId);
    saveStatus = "Saving…";
    saveChart();
  }

  function switchType(type) {
    if (type === currentType) return;
    const cached = rowsCache[type];
    if (!cached || !cached.length) rowsCache = { ...rowsCache, [type]: emptyRows() };
    currentType = type;
    // Viewing a type doesn't trigger a write — only a real edit or manual Save does.
  }

  function updateCell(rowIdx, colIdx, value) {
    const rows = rowsCache[currentType].map((r, i) => {
      if (i !== rowIdx) return r;
      // Filling a later column (e.g. Remark) while earlier ones are still
      // blank leaves the skipped indices as real array holes rather than
      // empty strings — no strip was available so FBS/RBS etc were never
      // typed into. Firestore rejects holes (they read back as
      // `undefined`), which is what made the chart "refuse to save" when
      // some columns were deliberately left empty. Backfill every hole up
      // to colIdx with '' so the row is always a dense array of strings.
      const copy = Array.from({ length: Math.max(r.length, colIdx + 1) }, (_, idx) => (r[idx] === undefined ? '' : r[idx]));
      copy[colIdx] = value;
      return copy;
    });
    rowsCache = { ...rowsCache, [currentType]: rows };
    scheduleSave();
  }

  function addRow() {
    rowsCache = { ...rowsCache, [currentType]: [...rowsCache[currentType], []] };
    scheduleSave();
  }

  function removeRow() {
    const rows = rowsCache[currentType];
    if (!rows.length) return;
    rowsCache = { ...rowsCache, [currentType]: rows.slice(0, -1) };
    scheduleSave();
  }

  const cols = $derived(CHART_DEFS[currentType].columns);
  const rows = $derived(rowsCache[currentType] || []);
</script>

<Topbar brand="Blood Glucose Chart">
  <button class="btn btn-secondary" style="padding: 6px 12px;" onclick={goBack}>Back</button>
  <button class="btn btn-primary" style="padding: 6px 12px;" onclick={() => window.print()}>Print</button>
</Topbar>

<div class="container no-print">
  <PatientBanner {patient} />
  {#if isArchived && loaded}
    <div style="background: #fef3c7; border: 1px solid #f59e0b; color: #78350f; font-weight: bold; padding: 8px 12px; border-radius: 6px; margin-top: 10px; font-size: 13px;">
      Archived chart — {(archiveMeta?.archiveReasonLabel || STATUS_LABELS[archiveMeta?.archiveReason] || "Closed")}
      {archiveMeta?.archivedAtDisplay ? " on " + archiveMeta.archivedAtDisplay : ""}
    </div>
  {/if}
  <div style="font-size: 12px; color: #555; margin-top: 8px; text-align: right;">{saveStatus}</div>
</div>

<div class="sheet">
  <div class="sheet-title">{CHART_DEFS[currentType].title}</div>
  <div class="unit-note">All glucose readings in mg/dL</div>
  <div class="unit-note">Normal: Fasting/Pre-meal 70–99 &nbsp;•&nbsp; 2hrs Post-meal &lt;140 &nbsp;•&nbsp; readings outside these ranges are flagged red</div>

  {#if !isArchived}
    <div class="toggle-row no-print">
      <button class={"toggle-btn" + (currentType === "6point" ? " active" : "")} onclick={() => switchType("6point")}>6-Point</button>
      <button class={"toggle-btn" + (currentType === "3point" ? " active" : "")} onclick={() => switchType("3point")}>3-Point</button>
    </div>
  {/if}

  <div class="table-wrap">
    <table class="chart">
      <thead>
        <tr>{#each cols as c, i (i)}<th>{c.label}</th>{/each}</tr>
      </thead>
      <tbody>
        {#each rows as row, rIdx (rIdx)}
          <tr>
            {#each cols as col, cIdx (cIdx)}
              {@const val = row[cIdx] || ""}
              {@const abnormal = col.glucose && isAbnormalGlucose(val, col.glucoseType)}
              <td class={abnormal ? "flag-abnormal" : ""}>
                <input
                  type={col.type}
                  value={val}
                  readonly={isArchived}
                  oninput={(e) => updateCell(rIdx, cIdx, e.target.value)}
                  onclick={(col.type === "date" || col.type === "time") ? (e) => openPicker(e.currentTarget) : undefined}
                />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if !isArchived}
    <div class="no-print" style="margin-top: 10px;">
      <button class="btn btn-success" onclick={addRow}>+ Add Row</button>
      <button class="btn btn-secondary" onclick={removeRow}>− Remove Row</button>
      <button class="btn btn-primary" onclick={manualSave}>Save</button>
    </div>
  {/if}
  {#if !isArchived}
    <div class="no-print" style="font-size: 13px; color: #555; margin-top: 10px; text-align: center; font-weight: bold;">{saveStatus}</div>
  {/if}
</div>
