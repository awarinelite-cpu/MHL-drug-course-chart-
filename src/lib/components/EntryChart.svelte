<script>
  // Ported from src/components/EntryChart.jsx. The generic entry-log chart
  // shared by Vitals, Seizure, and Intake & Output — a `columns` config
  // drives the entry form and the table, same as the React version.
  // useBackLock/useChartBack/usePatientHeader are inlined (see the
  // Drug Course Chart and Patient page ports for the same convention).
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import {
    collection, deleteDoc, doc, getDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp
  } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import PatientBanner from "$lib/components/PatientBanner.svelte";

  const STATUS_LABELS = { referred: "Referred to another hospital", transferred: "Transferred to another ward", discharged: "Discharged" };

  let {
    title, collectionName, columns, deriveRows = null, summary = null,
    entryNoun = "Entry", sortOrder = "desc"
  } = $props();

  function cellValue(row, col) {
    return (row[col.key] !== undefined && row[col.key] !== null && row[col.key] !== "") ? row[col.key] : "";
  }

  // See BloodGlucose for why: mobile's date/time inputs always open the
  // full OS picker on tap, but desktop only opens the native dropdown if
  // you click the small calendar/clock icon exactly — clicking elsewhere
  // on the field just starts text editing. Forcing showPicker() on click
  // makes desktop behave the same "click anywhere to pick" way mobile
  // already does.
  function openPicker(el) {
    if (!el || typeof el.showPicker !== "function") return;
    try { el.showPicker(); } catch (e) { /* not focused/supported here — typing still works */ }
  }

  function cellClass(col, row) {
    if (typeof col.abnormal === "function") {
      const raw = row[col.key];
      if (raw !== undefined && raw !== null && raw !== "" && col.abnormal(raw, row)) {
        return col.deficitShade ? "flag-deficit" : "flag-abnormal";
      }
    }
    return "";
  }

  // Sorts oldest→newest, runs deriveRows() to attach computed fields (e.g.
  // balance) and possibly insert period-summary rows, then orders for display.
  function withDerivedRows(rawRows, sortOrd, closeContext) {
    const asc = rawRows.slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const derived = typeof deriveRows === "function" ? deriveRows(asc, closeContext) : asc;
    return sortOrd === "asc" ? derived : derived.slice().sort((a, b) => (b.time || "").localeCompare(a.time || ""));
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

  // Device/OS Back always returns to the same target (ported from useBackLock.js)
  onMount(() => {
    try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    const onPopState = () => goto(chartBackTarget(), { replaceState: true });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  // --- Patient header (ported from usePatientHeader.js) ---
  let patient = $state(null);
  $effect(() => {
    if (!patientId) { patient = null; return; }
    let cancelled = false;
    getDoc(doc(db, "patients_mhl", patientId)).then((snap) => {
      if (cancelled) return;
      if (snap.exists()) patient = { id: snap.id, ...snap.data() };
    }).catch(() => { /* header just stays blank if this fails */ });
    return () => { cancelled = true; };
  });

  const displayColumns = $derived(columns.filter(c => !c.formOnly));
  const enterableColumns = $derived(columns.filter(c => !c.computed));

  function initialEntryValues() {
    const initial = {};
    columns.filter(c => !c.computed).forEach(c => {
      if (c.key === "time") {
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        initial[c.key] = now.toISOString().slice(0, 16);
      } else initial[c.key] = "";
    });
    return initial;
  }

  let entryValues = $state(initialEntryValues());
  let entryOtherValues = $state({});

  let rawRows = $state([]);
  let loadedArchive = $state(false);
  let archiveMeta = $state(null);
  let archiveRows = $state([]);
  let summaryTotals = $state(null);
  let popup = $state(null); // { label, value } | null
  let saveIntervalId = null;

  const closeContext = $derived(isArchived && archiveMeta ? {
    closedAt: archiveMeta.archivedAt?.toDate ? archiveMeta.archivedAt.toDate() : null,
    closedAtDisplay: archiveMeta.archivedAtDisplay || null
  } : null);

  // Live subscription (non-archived only)
  let unsubLive = null;
  $effect(() => {
    if (unsubLive) { unsubLive(); unsubLive = null; }
    if (isArchived || !patientId) return;
    const q = query(collection(db, "patients_mhl", patientId, collectionName), orderBy("time", "desc"));
    unsubLive = onSnapshot(q, (snap) => {
      const rows = [];
      snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
      rawRows = rows;
    });
  });
  onDestroy(() => { if (unsubLive) unsubLive(); });

  // Archived load
  $effect(() => {
    if (!isArchived || !patientId) return;
    (async () => {
      const admSnap = await getDoc(doc(db, "patients_mhl", patientId, "admissions", admissionId));
      const admData = admSnap.exists() ? admSnap.data() : {};
      archiveMeta = admData;
      archiveRows = admData[collectionName] || [];
      loadedArchive = true;
    })();
  });

  async function saveSummary(rows) {
    if (!summary || !summary.storeAt || isArchived || !patientId) return;
    const totals = summary.compute(rows);
    const [collName, docId] = summary.storeAt;
    try {
      await setDoc(doc(db, "patients_mhl", patientId, collName, docId), {
        ...totals, periodDate: new Date().toISOString().slice(0, 10), updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) { /* summary is a convenience record — a failed save here isn't fatal */ }
  }

  // Summary card: recompute live for an active chart (and re-save every
  // 15 min so the closed-period totals appear on schedule); for an
  // archived admission, prefer the totals preserved at archive time.
  $effect(() => {
    if (!summary) return;
    if (isArchived) {
      if (!loadedArchive) return;
      const preserved = summary.archivedKey ? archiveMeta?.[summary.archivedKey] : null;
      summaryTotals = preserved || summary.compute(archiveRows, closeContext);
      return;
    }
    summaryTotals = summary.compute(rawRows);
    saveSummary(rawRows);
  });

  $effect(() => {
    if (!summary || isArchived) return;
    if (saveIntervalId) clearInterval(saveIntervalId);
    saveIntervalId = setInterval(() => {
      summaryTotals = summary.compute(rawRows);
      saveSummary(rawRows);
    }, 15 * 60 * 1000);
    return () => clearInterval(saveIntervalId);
  });

  // Reads an entry field's value — for a 'select' column with otherOption
  // selected, folds the paired textarea's text into the saved value as
  // "<otherOption>: <text>".
  function readInputValue(col) {
    const val = entryValues[col.key] || "";
    if (col.type === "select" && col.otherOption && val === col.otherOption) {
      const otherText = (entryOtherValues[col.key] || "").trim();
      return otherText ? (col.otherOption + ": " + otherText) : col.otherOption;
    }
    return val;
  }

  function addEntry() {
    const data = {};
    enterableColumns.forEach(col => { data[col.key] = readInputValue(col); });

    // Group gating: a column marked groupGate acts as an on/off switch for
    // every other column sharing its `group`. If the gate's dropdown is
    // left on its placeholder (blank), every other field in that group is
    // cleared before saving — even if something was typed into it.
    const groupGateValue = {};
    columns.forEach(col => { if (col.groupGate) groupGateValue[col.group] = data[col.key]; });
    columns.forEach(col => {
      if (col.group && !col.groupGate && groupGateValue[col.group] === "") data[col.key] = "";
    });

    if (!data.time) { alert("Please set the time."); return; }
    data.createdAt = serverTimestamp();
    data.enteredBy = authState.profile?.name;
    // Client-generated ID via setDoc instead of addDoc, fired without
    // awaiting — same offline-hang fix as elsewhere in this app: with
    // offline persistence, this queues in the local cache immediately and
    // syncs on reconnect, but addDoc()'s Promise wouldn't resolve until
    // then. That left "Add Entry"/"Add Reading" silently doing nothing
    // while offline — no error, form never cleared, entry never appeared.
    setDoc(doc(collection(db, "patients_mhl", patientId, collectionName)), data).catch((e) => {
      console.warn("Entry queued locally; will retry once back online:", e);
    });

    const next = { ...entryValues };
    Object.keys(next).forEach((k) => { if (k !== "time") next[k] = ""; });
    entryValues = next;
    entryOtherValues = {};
  }

  async function deleteEntry(id) {
    if (confirm("Delete this entry?")) await deleteDoc(doc(db, "patients_mhl", patientId, collectionName, id));
  }

  const displayRows = $derived(isArchived
    ? withDerivedRows(archiveRows, sortOrder, closeContext)
    : withDerivedRows(rawRows, sortOrder, null));
</script>

<Topbar brand={title}>
  <button class="btn btn-secondary" style="padding: 6px 12px;" onclick={goBack}>Back</button>
  <button class="btn btn-primary" style="padding: 6px 12px;" onclick={() => window.print()}>Print</button>
</Topbar>
<div class="container">
  <PatientBanner {patient} />

  {#if isArchived && loadedArchive}
    <div style="background: #fef3c7; border: 1px solid #f59e0b; color: #78350f; font-weight: bold; padding: 8px 12px; border-radius: 6px; margin-top: 10px; font-size: 13px;">
      Archived chart — {(archiveMeta?.archiveReasonLabel || STATUS_LABELS[archiveMeta?.archiveReason] || "Closed")}
      {archiveMeta?.archivedAtDisplay ? " on " + archiveMeta.archivedAtDisplay : ""}
    </div>
  {/if}

  {#if summary && summaryTotals}
    <div class="card-box">
      <h3 style="margin-top: 0;">{isArchived && summary.archivedLabel ? summary.archivedLabel : summary.label}</h3>
      <div style="display: flex; gap: 18px; flex-wrap: wrap; font-size: 14px;">
        <div><b>Total Intake:</b> {summaryTotals.intake} ml</div>
        <div><b>Total Output:</b> {summaryTotals.output} ml</div>
        <div class={summaryTotals.balance < 0 ? "flag-deficit" : ""} style="padding: 2px 8px; border-radius: 4px;">
          <b>Balance:</b> {summaryTotals.balance} ml{summaryTotals.balance < 0 ? " (deficit)" : ""}
        </div>
      </div>
      <div style="font-size: 11px; color: #777; margin-top: 6px;">
        {isArchived ? "Saved at the time this admission was closed." : "Recalculates automatically as entries are added, and saves every 24 hours."}
      </div>
    </div>
  {/if}

  {#if !isArchived}
    <div class="card-box no-print">
      <h3 style="margin-top: 0;">New {entryNoun === "Reading" ? "Reading" : "Entry"}</h3>
      <div style="display: flex; flex-wrap: wrap; gap: 10px;">
        {#each (() => {
          const rendered = [];
          const groupedAlready = new Set();
          enterableColumns.forEach((col) => {
            if (col.group) {
              if (groupedAlready.has(col.group)) return;
              groupedAlready.add(col.group);
              rendered.push({ kind: "group", key: col.group, cols: enterableColumns.filter(c => c.group === col.group) });
            } else {
              rendered.push({ kind: "single", key: col.key, col });
            }
          });
          return rendered;
        })() as item (item.key)}
          {#if item.kind === "group"}
            {@const styled = item.cols.find(c => c.groupColor || c.groupLabel) || item.cols[0]}
            <div style="flex: 1 1 240px; display: flex; flex-direction: column; gap: 10px; padding: 10px; border-radius: 8px; background: {styled.groupColor || 'transparent'};">
              {#if styled.groupLabel}<div style="font-weight: 600;">{styled.groupLabel}</div>{/if}
              {#each item.cols as c (c.key)}
                {#if c.type === "select"}
                  <div class="field" style="flex: 1 1 140px;">
                    <label for={"ec_" + c.key}>{c.label}</label>
                    <select id={"ec_" + c.key} value={entryValues[c.key] || ""} onchange={(e) => entryValues = { ...entryValues, [c.key]: e.target.value }}>
                      {#if c.placeholder}<option value="">{c.placeholder}</option>{/if}
                      {#each (c.options || []) as opt}<option value={opt}>{opt}</option>{/each}
                    </select>
                    {#if c.otherOption}
                      <textarea rows="1" placeholder={c.otherPlaceholder || "Please specify"}
                        style="display: {entryValues[c.key] === c.otherOption ? 'block' : 'none'}; width: 100%; margin-top: 4px; font-family: inherit;"
                        value={entryOtherValues[c.key] || ""} oninput={(e) => entryOtherValues = { ...entryOtherValues, [c.key]: e.target.value }}></textarea>
                    {/if}
                  </div>
                {:else}
                  <div class="field" style="flex: 1 1 140px;">
                    <label for={"ec_" + c.key}>{c.label}</label>
                    <input id={"ec_" + c.key} type={c.type || "text"} value={entryValues[c.key] || ""}
                      oninput={(e) => entryValues = { ...entryValues, [c.key]: e.target.value }}
                      onclick={(c.type === "date" || c.type === "time" || c.type === "datetime-local") ? (e) => openPicker(e.currentTarget) : undefined} />
                  </div>
                {/if}
              {/each}
            </div>
          {:else}
            {@const col = item.col}
            {#if col.type === "select"}
              <div class="field" style="flex: 1 1 140px;">
                <label for={"ec_" + col.key}>{col.label}</label>
                <select id={"ec_" + col.key} value={entryValues[col.key] || ""} onchange={(e) => entryValues = { ...entryValues, [col.key]: e.target.value }}>
                  {#if col.placeholder}<option value="">{col.placeholder}</option>{/if}
                  {#each (col.options || []) as opt}<option value={opt}>{opt}</option>{/each}
                </select>
                {#if col.otherOption}
                  <textarea rows="1" placeholder={col.otherPlaceholder || "Please specify"}
                    style="display: {entryValues[col.key] === col.otherOption ? 'block' : 'none'}; width: 100%; margin-top: 4px; font-family: inherit;"
                    value={entryOtherValues[col.key] || ""} oninput={(e) => entryOtherValues = { ...entryOtherValues, [col.key]: e.target.value }}></textarea>
                {/if}
              </div>
            {:else}
              <div class="field" style="flex: 1 1 140px;">
                <label for={"ec_" + col.key}>{col.label}</label>
                <input id={"ec_" + col.key} type={col.type || "text"} value={entryValues[col.key] || ""}
                  oninput={(e) => entryValues = { ...entryValues, [col.key]: e.target.value }}
                  onclick={(col.type === "date" || col.type === "time" || col.type === "datetime-local") ? (e) => openPicker(e.currentTarget) : undefined} />
              </div>
            {/if}
          {/if}
        {/each}
      </div>
      <button class="btn btn-primary" onclick={addEntry}>Add {entryNoun}</button>
    </div>
  {/if}

  <div class="card-box">
    <h3 style="margin-top: 0;">{entryNoun === "Reading" ? "Readings" : "Entries"}</h3>
    <div class="table-wrap">
      <table class="entries">
        <thead>
          <tr>
            {#each displayColumns as c (c.key)}<th>{c.label}</th>{/each}
            {#if !isArchived}<th class="no-print"></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#if isArchived && loadedArchive && displayRows.length === 0}
            <tr><td colspan={displayColumns.length} style="color: #777;">No entries recorded for this admission.</td></tr>
          {/if}
          {#if !isArchived && rawRows.length === 0}
            <tr><td colspan={displayColumns.length + 1} style="color: #777;">No entries yet.</td></tr>
          {/if}
          {#each displayRows as row, idx (row.id || (row.time + "-" + idx))}
            {#if row.isPeriodSummary}
              <tr>
                <td colspan={displayColumns.length + (isArchived ? 0 : 1)}
                  style="font-weight: bold; padding: 8px 10px; background: #f3f4f6; color: {row.deficit ? 'maroon' : 'inherit'};">
                  {row.summaryText}
                </td>
              </tr>
            {:else}
              <tr>
                {#each displayColumns as col (col.key)}
                  {#if col.popup}
                    <td class={cellClass(col, row) + " popup-cell"} title="Tap to view full text" onclick={() => popup = { label: col.label, value: cellValue(row, col) }}>
                      {cellValue(row, col)}
                    </td>
                  {:else}
                    <td class={cellClass(col, row)}>{cellValue(row, col)}</td>
                  {/if}
                {/each}
                {#if !isArchived}
                  <td class="no-print"><button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick={() => deleteEntry(row.id)}>Delete</button></td>
                {/if}
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>

{#if popup}
  <div class="field-popup-overlay no-print" style="display: flex;" onclick={(e) => { if (e.target === e.currentTarget) popup = null; }}>
    <div class="field-popup-box">
      <div class="field-popup-header"><h3>{popup.label}</h3><button type="button" class="field-popup-close" aria-label="Close" onclick={() => popup = null}>&times;</button></div>
      <div class="field-popup-body"><p class="field-popup-text">{popup.value || "(Not entered)"}</p></div>
    </div>
  </div>
{/if}
