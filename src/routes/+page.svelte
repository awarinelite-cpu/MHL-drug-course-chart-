<script>
  // Ported from src/pages/Home.jsx.
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { collection, getDocs, getDoc, doc, setDoc, serverTimestamp } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { avatarMarkup } from "$lib/helpers/avatar.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import PatientForm from "$lib/components/PatientForm.svelte";
  import NewPatientTransfersModal from "$lib/components/NewPatientTransfersModal.svelte";
  import { parsePatientFields } from "$lib/helpers/patientParse.js";
  import { generateCsvTemplate, parsePatientCsv } from "$lib/helpers/patientCsv.js";
  import { pendingTransfersFor } from "$lib/helpers/wardTransfer.js";
  import { wardHeadcount } from "$lib/helpers/wardCensus.js";
  import { reportWardKeysForPatientWard, patientWardAndBedTypeForReportKey } from "$lib/helpers/wardNameMatch.js";
  import { WARDS } from "$lib/helpers/nursesReportCommon.js";

  const EMPTY_FORM = { name: "", emr: "", diagnosis: "", ward: "", pedBedType: "", age: "", hospNo: "", admissionDate: "", allergies: "", insurance: "" };

  // Wards are stored/compared in ALL CAPS; this is purely for display so
  // headings don't shout at the reader.
  function titleCase(str) {
    return (str || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  let searchInputEl = $state(null);
  let searchQuery = $state("");
  let allPatients = $state(null); // null = still loading

  let showNewForm = $state(false);
  let newForm = $state({ ...EMPTY_FORM });
  let newMsg = $state("");

  let showEmrPaste = $state(false);
  let emrPasteText = $state("");
  let emrParseMsg = $state("");

  let showTransfers = $state(false);

  let showBulkUpload = $state(false);
  let bulkFileName = $state("");
  let bulkRows = $state(null); // null = no file parsed yet
  let bulkMsg = $state("");
  let bulkSaving = $state(false);

  // --- Exit on double back (ported from useExitOnDoubleBack.js) ---
  const REARM_WINDOW_MS = 2000;
  let showExitToast = $state(false);
  let exitArmed = false;
  let exitTimer;

  onMount(() => {
    try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    const onPopState = () => {
      try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
      if (exitArmed) {
        clearTimeout(exitTimer);
        exitArmed = false;
        showExitToast = false;
        exitApp();
        return;
      }
      exitArmed = true;
      showExitToast = true;
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => { exitArmed = false; showExitToast = false; }, REARM_WINDOW_MS);
    };
    window.addEventListener("popstate", onPopState);
    return () => { window.removeEventListener("popstate", onPopState); clearTimeout(exitTimer); };
  });

  async function exitApp() {
    // Dynamic import so this stays a no-op in a plain browser/preview tab
    // (outside the Capacitor-wrapped Android app, the module has nothing
    // real to resolve to at runtime even though it's now a dependency).
    try {
      const { App } = await import("@capacitor/app");
      App.exitApp();
    } catch (e) {
      // Not running under Capacitor — nothing to exit.
    }
  }

  onMount(() => {
    if (window.location.hash === "#search" && searchInputEl) {
      searchInputEl.scrollIntoView({ behavior: "smooth", block: "center" });
      searchInputEl.focus();
    }
    loadAllPatients();

    // Ward-to-ward transfers, new admissions, etc. are written by other
    // devices, so a plain load-on-mount only shows what existed when this
    // page opened. Poll quietly in the background so an incoming transfer
    // (or any other change) shows up within 30s without a manual reload.
    // Paused while the tab/app is backgrounded so it doesn't burn reads
    // for a screen nobody's looking at, and skipped entirely while a form
    // is open so a background refresh can't blow away unsaved input.
    const POLL_MS = 30000;
    const pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (showNewForm || showBulkUpload || showEmrPaste) return;
      loadAllPatients(true);
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAllPatients(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  async function loadAllPatients(force) {
    if (allPatients && !force) return allPatients;
    const snap = await getDocs(collection(db, "patients_mhl"));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    allPatients = list;
    return list;
  }

  function openPatient(p) {
    try { sessionStorage.setItem("selectedPatientId", p.id); } catch (e) { /* ignore */ }
    goto("/patient?patient=" + p.id);
  }

  // --- Paste from EMR (bulk fill on patient registration) -------------------
  function parseEmrPaste() {
    emrParseMsg = "";
    if (!emrPasteText.trim()) { emrParseMsg = "Paste the patient's EMR text first."; return; }
    const fields = parsePatientFields(emrPasteText);
    newForm = {
      name: fields.name || newForm.name,
      emr: fields.emr || newForm.emr,
      diagnosis: fields.diagnosis || newForm.diagnosis,
      ward: fields.ward || newForm.ward,
      pedBedType: newForm.pedBedType,
      age: fields.age || newForm.age,
      hospNo: fields.hospNo || newForm.hospNo,
      admissionDate: fields.admissionDate || newForm.admissionDate,
      allergies: fields.allergies || newForm.allergies,
      insurance: fields.insurance || newForm.insurance
    };
    const foundCount = Object.values(fields).filter(Boolean).length;
    emrParseMsg =
      (foundCount ? "Filled " + foundCount + " patient field(s)." : "Could not find patient details in that text.") +
      " Please review everything before saving.";
  }
  function clearEmrPaste() { showEmrPaste = false; emrPasteText = ""; emrParseMsg = ""; }

  async function createPatient() {
    const name = newForm.name.trim();
    const emr = newForm.emr.trim();
    newMsg = "";
    if (!name || !emr) { newMsg = "Name and EMR number are required."; return; }
    const diagnosis = newForm.diagnosis.trim();
    const data = {
      name, emr,
      diagnosis, ward: newForm.ward.trim(),
      pedBedType: newForm.ward.trim() === "PEDIATRIC/NICU WARD" ? (newForm.pedBedType || "") : "",
      age: newForm.age.trim(),
      hospNo: newForm.hospNo.trim(), admissionDate: newForm.admissionDate.trim(), allergies: newForm.allergies.trim(),
      insurance: newForm.insurance.trim(),
      createdAt: serverTimestamp(), createdBy: authState.user ? authState.user.uid : null
    };

    // Client-generated ID — usable immediately even offline. Not awaited:
    // with offline persistence, the write lands in the local IndexedDB
    // cache synchronously; the returned Promise only resolves once back
    // online and the backend acknowledges it.
    const ref = doc(collection(db, "patients_mhl"));
    setDoc(ref, data).catch((e) => {
      console.warn("Patient write queued locally; will retry once back online:", e);
    });

    allPatients = allPatients ? [...allPatients, { id: ref.id, ...data }] : [{ id: ref.id, ...data }];
    showNewForm = false;
    newForm = { ...EMPTY_FORM };
    clearEmrPaste();
    openPatient({ id: ref.id });
  }

  // --- Bulk upload (CSV) --------------------------------------------------
  function downloadCsvTemplate() {
    const blob = new Blob([generateCsvTemplate()], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "patient-bulk-upload-template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleBulkFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file after a fix
    if (!file) return;
    bulkFileName = file.name;
    bulkMsg = "";
    bulkRows = null;
    const reader = new FileReader();
    reader.onload = () => {
      const { headerOk, rows } = parsePatientCsv(String(reader.result || ""));
      if (!headerOk) {
        bulkMsg = "Couldn't read that file — make sure it has \"Name\" and \"EMR Number\" columns (download the template below if unsure).";
        bulkRows = [];
        return;
      }
      if (!rows.length) {
        bulkMsg = "No patient rows found in that file.";
        bulkRows = [];
        return;
      }
      bulkRows = rows;
      const errorCount = rows.filter(r => r.errors.length).length;
      bulkMsg =
        rows.length + " row(s) found" +
        (errorCount ? ", " + errorCount + " with errors — fix or they'll be skipped." : ", all look good.");
    };
    reader.onerror = () => { bulkMsg = "Could not read that file."; };
    reader.readAsText(file);
  }

  // Matches an "add drugs to an existing patient" CSV row against a patient
  // already in Firestore, purely by EMR Number (case/whitespace-insensitive).
  function findExistingPatientByEmr(emr) {
    const norm = (emr || "").trim().toLowerCase();
    if (!norm) return null;
    return (allPatients || []).find(p => (p.emr || "").trim().toLowerCase() === norm) || null;
  }

  // Adds a CSV row's parsed drugs onto a patient's Drug Course Chart —
  // creating the chart doc if needed, skipping exact repeats.
  async function addDrugsToChart(patientId, drugsParsed) {
    if (!drugsParsed || !drugsParsed.length) return 0;
    const ref = doc(db, "patients_mhl", patientId, "drugCourseChart", "main");
    let existingDrugs = [];
    try {
      const snap = await getDoc(ref);
      if (snap.exists()) existingDrugs = Array.isArray(snap.data().drugs) ? snap.data().drugs : [];
    } catch (e) {
      console.warn("Could not read existing drug chart before merging bulk-uploaded drugs:", e);
    }
    const key = (d) => [d.name, d.route, d.frequency, d.duration].map(v => (v || "").trim().toLowerCase()).join("|");
    const existingKeys = new Set(existingDrugs.map(key));
    const toAdd = drugsParsed.filter(d => !existingKeys.has(key(d)));
    if (!toAdd.length) return 0;
    const merged = [...existingDrugs, ...toAdd];
    setDoc(ref, { drugs: merged, updatedAt: serverTimestamp() }, { merge: true }).catch((e) => {
      console.warn("Bulk-uploaded drugs write queued locally; will retry once back online:", e);
    });
    return toAdd.length;
  }

  async function saveBulkPatients() {
    if (authState.profile?.role !== "admin") { bulkMsg = "Only an admin can bulk upload patients."; return; }
    const validRows = (bulkRows || []).filter(r => r.errors.length === 0);
    if (!validRows.length) { bulkMsg = "No valid rows to upload."; return; }
    bulkSaving = true;
    const created = [];
    let newCount = 0, updatedCount = 0, drugCount = 0;
    for (const r of validRows) {
      const existing = findExistingPatientByEmr(r.data.emr);
      let patientId;
      if (existing) {
        patientId = existing.id;
        updatedCount++;
      } else {
        const data = {
          name: r.data.name, emr: r.data.emr, diagnosis: r.data.diagnosis,
          ward: r.data.ward, pedBedType: r.data.ward === "PEDIATRIC/NICU WARD" ? r.data.pedBedType : "",
          age: r.data.age, hospNo: r.data.hospNo, admissionDate: r.data.admissionDate,
          allergies: r.data.allergies, insurance: r.data.insurance,
          createdAt: serverTimestamp(), createdBy: authState.user ? authState.user.uid : null
        };
        const ref = doc(collection(db, "patients_mhl"));
        setDoc(ref, data).catch((e) => {
          console.warn("Bulk patient write queued locally; will retry once back online:", e);
        });
        created.push({ id: ref.id, ...data });
        patientId = ref.id;
        newCount++;
      }
      if (r.data.drugsParsed && r.data.drugsParsed.length) {
        drugCount += await addDrugsToChart(patientId, r.data.drugsParsed);
      }
    }
    allPatients = allPatients ? [...allPatients, ...created] : created;
    bulkSaving = false;
    bulkMsg =
      newCount + " new patient(s) created, " + updatedCount + " existing patient(s) matched by EMR" +
      (drugCount ? ", " + drugCount + " drug(s) added to their charts." : ".");
    bulkRows = null;
    bulkFileName = "";
  }

  function clearBulkUpload() {
    showBulkUpload = false;
    bulkRows = null;
    bulkFileName = "";
    bulkMsg = "";
  }

  const q = $derived(searchQuery.trim().toLowerCase());
  const myWard = $derived(authState.profile?.ward || "");
  // Patients mid-transfer (pendingTransfer set) are held out of every
  // normal ward list — they only show up in the receiving ward's "New
  // Patient" queue until a nurse there accepts or rejects them. The
  // search box is a general patient lookup, not a ward-scoped one.
  const visiblePatients = $derived((allPatients || []).filter(p =>
    !p.pendingTransfer &&
    (q
      ? ((p.emr || "").toLowerCase().includes(q) || (p.name || "").toLowerCase().includes(q))
      : (!myWard || p.ward === myWard))
  ));
  const reportWardKeys = $derived(reportWardKeysForPatientWard(myWard));
  const isSplitWard = $derived(reportWardKeys.length > 1);
  // Per report-ward-key headcount so the badge always matches the patient
  // list right below it. For a split ward (PEDIATRIC/NICU WARD), each
  // key's headcount is further narrowed to matching pedBedType.
  const wardBreakdown = $derived(reportWardKeys.map((k) => {
    const info = patientWardAndBedTypeForReportKey(k);
    const count = wardHeadcount(allPatients, myWard, info?.bedType);
    return { key: k, bedType: info?.bedType || null, count };
  }));
  const wardPatientCount = $derived(reportWardKeys.length
    ? wardBreakdown.reduce((sum, x) => sum + x.count, 0)
    : wardHeadcount(allPatients, myWard));
  const incomingTransfers = $derived(pendingTransfersFor(allPatients, myWard));
  // Grouped view of the patient list for a split ward — Bed / Cot sections
  // plus an "unset" bucket. Only makes sense for the unfiltered "my ward"
  // view; a cross-ward search stays a flat list.
  const pedGroups = $derived((isSplitWard && !q)
    ? (() => {
        const groups = wardBreakdown.map((b) => ({
          ...b,
          label: (WARDS.find((w) => w.key === b.key) || {}).label || b.key,
          patients: visiblePatients.filter((p) => p.pedBedType === b.bedType)
        }));
        const assigned = new Set(groups.flatMap((g) => g.patients.map((p) => p.id)));
        const unassigned = visiblePatients.filter((p) => !assigned.has(p.id));
        return { groups, unassigned };
      })()
    : null);

  function focusSearch() { searchInputEl && searchInputEl.focus(); }
</script>

<Topbar brand="MILITARY HOSPITAL LAGOS Ward Charts">
  <a class="whoami-link" onclick={(e) => { e.preventDefault(); goto("/profile"); }} href="/profile">
    <span class="whoami-avatar">{@html authState.profile ? avatarMarkup(authState.profile, 32) : ""}</span>
    <span class="whoami-name">{authState.profile ? authState.profile.name + " (" + authState.profile.role + ")" : ""}</span>
  </a>
  {#if authState.profile?.role === "admin"}
    <a href="/admin" class="btn btn-purple" style="padding:6px 12px;" onclick={(e) => { e.preventDefault(); goto("/admin"); }}>Admin</a>
  {/if}
  <a href="/my-patients" class="btn btn-secondary" style="padding:6px 12px;" onclick={(e) => { e.preventDefault(); goto("/my-patients"); }}>My Patients</a>
  {#if myWard}
    <a href="#" class="btn btn-secondary notif-bell-btn" style="padding:6px 12px;" onclick={(e) => { e.preventDefault(); showTransfers = true; }}>
      🔔 New Patient
      {#if incomingTransfers.length > 0}<span class="notif-count-badge">{incomingTransfers.length}</span>{/if}
    </a>
  {/if}
</Topbar>

<div class="container">
  <div class="card-box">
    <label for="searchInput">Search Patient (EMR number or name)</label>
    <div class="search-row">
      <input
        id="searchInput"
        bind:this={searchInputEl}
        type="text"
        placeholder="e.g. EMR12345 or John Doe"
        bind:value={searchQuery}
      />
      <button class="btn btn-primary" onclick={focusSearch}>Search</button>
      <button class="btn btn-success" onclick={() => { newForm = { ...newForm, ward: newForm.ward || myWard }; showNewForm = true; }}>+ New Patient</button>
      {#if authState.profile?.role === "admin"}
        <button class="btn btn-secondary" onclick={() => showBulkUpload = true}>📁 Bulk Upload</button>
      {/if}
    </div>
  </div>

  {#if showBulkUpload && authState.profile?.role === "admin"}
    <div class="card-box">
      <h3 style="margin-top:0;">Bulk Upload Patients (CSV)</h3>
      <p style="font-size:12px;color:#555;">
        Upload a CSV of patients and they'll be created and sorted into their wards automatically — same fields
        as the New Patient form, plus an optional Drugs column that's added straight to each patient's Drug
        Course Chart. Re-uploading with the same EMR Number and just the Drugs column filled in adds drugs to
        that existing patient instead of creating a duplicate. Not sure of the format? Download the template first.
      </p>
      <div style="margin-bottom:10px;">
        <button class="btn btn-secondary" onclick={downloadCsvTemplate}>⬇ Download CSV Template</button>
      </div>
      <div class="field">
        <label for="bulkFile">Choose CSV file</label>
        <input id="bulkFile" type="file" accept=".csv,text/csv" onchange={handleBulkFile} />
      </div>
      {#if bulkFileName}<div style="font-size:12px;color:#555;">{bulkFileName}</div>{/if}
      {#if bulkMsg}<div style="font-size:12px;color:#555;margin-top:6px;">{bulkMsg}</div>{/if}

      {#if bulkRows && bulkRows.length > 0}
        <div style="margin-top:10px;overflow-x:auto;">
          <table style="border-collapse:collapse;width:100%;">
            <thead>
              <tr>
                <th style="border:1px solid #000;padding:3px;font-size:12px;">Line</th>
                <th style="border:1px solid #000;padding:3px;font-size:12px;">Name</th>
                <th style="border:1px solid #000;padding:3px;font-size:12px;">EMR</th>
                <th style="border:1px solid #000;padding:3px;font-size:12px;">Ward</th>
                <th style="border:1px solid #000;padding:3px;font-size:12px;">Drugs</th>
                <th style="border:1px solid #000;padding:3px;font-size:12px;">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each bulkRows as r (r.line)}
                <tr style={r.errors.length ? "background:#fef2f2;" : ""}>
                  <td style="border:1px solid #000;padding:3px;font-size:12px;">{r.line}</td>
                  <td style="border:1px solid #000;padding:3px;font-size:12px;">{r.data.name || "—"}</td>
                  <td style="border:1px solid #000;padding:3px;font-size:12px;">{r.data.emr || "—"}</td>
                  <td style="border:1px solid #000;padding:3px;font-size:12px;">{r.data.ward || "—"}</td>
                  <td style="border:1px solid #000;padding:3px;font-size:12px;">
                    {r.data.drugsParsed && r.data.drugsParsed.length ? r.data.drugsParsed.length + " drug(s)" : "—"}
                    {#if findExistingPatientByEmr(r.data.emr)}
                      <div style="color:#2563eb;">existing patient — drugs only</div>
                    {/if}
                  </td>
                  <td style="border:1px solid #000;padding:3px;font-size:12px;color:{r.errors.length ? '#b91c1c' : '#16a34a'};">
                    {r.errors.length ? r.errors.join("; ") : "OK"}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div style="font-size:11px;color:#888;margin-top:4px;">
            Rows in red have errors and will be skipped. Fix them in your CSV and re-upload if needed.
          </div>
        </div>
      {/if}

      <div style="margin-top:10px;">
        <button class="btn btn-primary" disabled={bulkSaving || !bulkRows || !bulkRows.some(r => r.errors.length === 0)} onclick={saveBulkPatients}>
          {bulkSaving ? "Uploading…" : "Upload Patients"}
        </button>
        <button class="btn btn-secondary" onclick={clearBulkUpload}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if showNewForm}
    <div class="card-box">
      <h3 style="margin-top:0;">Register New Patient</h3>

      <button class="btn btn-secondary" style="margin-bottom:10px;" onclick={() => showEmrPaste = !showEmrPaste}>
        {showEmrPaste ? "Hide Paste from EMR" : "📋 Paste from EMR"}
      </button>

      {#if showEmrPaste}
        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:14px;">
          <label for="emrPasteText">Paste the patient's EMR page (header + notes) here</label>
          <textarea
            id="emrPasteText"
            rows="6"
            style="width:100%;font-family:monospace;font-size:12px;"
            placeholder="Copy everything from the patient's EMR page and paste it here…"
            bind:value={emrPasteText}
          ></textarea>
          <div style="margin-top:8px;">
            <button class="btn btn-primary" onclick={parseEmrPaste}>Parse</button>
            <button class="btn btn-secondary" onclick={clearEmrPaste}>Clear</button>
          </div>
          {#if emrParseMsg}<div style="font-size:12px;color:#555;margin-top:6px;">{emrParseMsg}</div>{/if}
        </div>
      {/if}

      <PatientForm bind:form={newForm} />
      <button class="btn btn-primary" onclick={createPatient}>Save Patient</button>
      <button class="btn btn-secondary" onclick={() => { showNewForm = false; clearEmrPaste(); }}>Cancel</button>
      {#if newMsg}<div class="error-msg">{newMsg}</div>{/if}
    </div>
  {/if}

  <div class="card-box">
    <h3 style="margin-top:0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <span>Patients on {myWard ? titleCase(myWard) : "All Wards"} <span class="ward-count-badge">{wardPatientCount}</span></span>
      <a href="/profile" onclick={(e) => { e.preventDefault(); goto("/profile"); }} style="font-size:12px;font-weight:normal;">
        {myWard ? "Switch ward" : "Set your ward"}
      </a>
    </h3>
    {#if isSplitWard}
      <div class="ward-split-counts">
        {#each wardBreakdown as { key: k, count } (k)}
          {@const w = WARDS.find((x) => x.key === k)}
          <span class="ward-split-badge">{w ? w.label : k}<span class="ward-count-badge">{count}</span></span>
        {/each}
      </div>
    {/if}
    <div class="search-results">
      {#if allPatients === null}
        Loading patients…
      {/if}
      {#if allPatients && visiblePatients.length === 0}
        <div class="error-msg">
          {#if q}
            No patient matches that search.
          {:else}
            {myWard ? "No patients on " + myWard + " yet. Use \"+ New Patient\" to register one." : "No patients registered yet. Use \"+ New Patient\" to register one."}
          {/if}
        </div>
      {/if}
      {#if allPatients && visiblePatients.length > 0 && pedGroups}
        {#each pedGroups.groups as g (g.key)}
          <div style="margin-bottom:10px;">
            <div style="font-weight:bold;font-size:13px;margin:8px 0 4px;">{g.label} ({g.patients.length})</div>
            {#if g.patients.length === 0}<div style="font-size:12px;color:#888;">No patients yet.</div>{/if}
            {#each g.patients as p (p.id)}
              <div class="search-result-item" onclick={() => openPatient(p)}>
                <span><b>{p.name || "Unnamed"}</b>. EMR: {p.emr || "N/A"}</span>
                <span>{p.diagnosis || ""}</span>
              </div>
            {/each}
          </div>
        {/each}
        {#if pedGroups.unassigned.length > 0}
          <div style="margin-bottom:10px;">
            <div style="font-weight:bold;font-size:13px;margin:8px 0 4px;color:#b45309;">
              Bed/Cot not set ({pedGroups.unassigned.length})
            </div>
            {#each pedGroups.unassigned as p (p.id)}
              <div class="search-result-item" onclick={() => openPatient(p)}>
                <span><b>{p.name || "Unnamed"}</b>. EMR: {p.emr || "N/A"}</span>
                <span>{p.diagnosis || ""}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
      {#if allPatients && visiblePatients.length > 0 && !pedGroups}
        {#each visiblePatients as p (p.id)}
          <div class="search-result-item" onclick={() => openPatient(p)}>
            <span><b>{p.name || "Unnamed"}</b>. EMR: {p.emr || "N/A"}{q && p.ward ? ". Ward: " + p.ward : ""}</span>
            <span>{p.diagnosis || ""}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

{#if showTransfers}
  <NewPatientTransfersModal
    ward={myWard}
    transfers={incomingTransfers}
    onClose={() => showTransfers = false}
    onResolved={() => loadAllPatients(true)}
  />
{/if}

{#if showExitToast}
  <div class="exit-toast no-print" role="status">Press back again to exit</div>
{/if}
