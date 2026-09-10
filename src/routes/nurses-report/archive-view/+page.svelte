<script>
  // Ported from src/pages/nurses-report/ArchiveView.jsx. Each local React
  // helper component becomes a Svelte snippet below, in the same order.
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import {
    WARDS, STAT_FIELDS, SHIFT_STAT_FIELDS, SHIFTS, PATIENT_FIELDS,
    PATIENT_STATUS_OPTIONS, DEMOGRAPHIC_FIELDS, occDelta, movementColorClass
  } from "$lib/helpers/nursesReportCommon.js";
  import Topbar from "$lib/components/Topbar.svelte";

  const movementFields = SHIFT_STAT_FIELDS;
  const byKey = k => movementFields.find(f => f.key === k);
  const SOLO_BEFORE = ["adm", "disch", "dama"].map(byKey);
  const SOLO_AFTER = ["sc", "vsc", "absc", "bid", "death"].map(byKey);
  const TRANSFER_PAIR = [byKey("transferIn"), byKey("transferOut")];
  const EXT_PAIR = [byKey("ext"), byKey("extOut")];
  const ORDERED_MOVEMENT = [...SOLO_BEFORE, ...TRANSFER_PAIR, ...EXT_PAIR, ...SOLO_AFTER];

  function fmtTimestamp(ts) {
    if (!ts || !ts.toDate) return "";
    const d = ts.toDate();
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function isNoteHeadingLine(line) {
    const t = line.trim();
    if (!t || t.length > 60) return false;
    const letters = t.replace(/[^A-Za-z]/g, "");
    return letters.length > 0 && letters === letters.toUpperCase();
  }
  function noteBlocks(text) {
    const lines = String(text).split("\n");
    const blocks = [];
    let paraLines = [];
    function flushPara() { if (paraLines.length) blocks.push({ type: "p", text: paraLines.join("\n") }); paraLines = []; }
    lines.forEach(line => {
      if (isNoteHeadingLine(line)) { flushPara(); blocks.push({ type: "h", text: line.trim() }); }
      else paraLines.push(line);
    });
    flushPara();
    return blocks;
  }

  function computeWardCensus(w, data) {
    const shifts = data.shifts || {};
    const beds = typeof data.beds === "number" ? data.beds : (w.beds || 0);
    const startOcc = typeof data.startOcc === "number" ? data.startOcc : 0;
    let occ = startOcc;
    const perShiftOcc = {};
    SHIFTS.forEach(s => {
      occ += occDelta(shifts[s.key] || {});
      if (occ < 0) occ = 0;
      perShiftOcc[s.key] = occ;
    });
    const finalOcc = typeof data.occ === "number" ? data.occ : occ;
    return { beds, perShiftOcc, finalOcc };
  }

  function setBeds(data, onChange, raw) { const n = parseFloat(raw); onChange({ ...data, beds: isNaN(n) ? 0 : n }); }
  function setShiftField(data, onChange, shiftKey, fieldKey, raw) {
    const shifts = data.shifts || {};
    const n = parseFloat(raw);
    onChange({ ...data, shifts: { ...shifts, [shiftKey]: { ...shifts[shiftKey], [fieldKey]: isNaN(n) ? 0 : n } } });
  }
  function setDuty(data, onChange, shiftKey, value) {
    const shifts = data.shifts || {};
    onChange({ ...data, shifts: { ...shifts, [shiftKey]: { ...shifts[shiftKey], nurseOnDuty: value } } });
  }

  function demoFields(w) {
    return w && w.key && w.key.startsWith("paed") ? DEMOGRAPHIC_FIELDS.filter(f => f.key !== "child") : DEMOGRAPHIC_FIELDS;
  }
  function demoTotals(data, fields) {
    const shifts = data.shifts || {};
    const totals = {};
    fields.forEach(f => {
      let sum = 0;
      SHIFTS.forEach(s => { const v = (shifts[s.key] || {})[f.key]; sum += typeof v === "number" ? v : 0; });
      totals[f.key] = sum;
    });
    return totals;
  }
  function setDemoField(data, onChange, shiftKey, fieldKey, raw) {
    const shifts = data.shifts || {};
    const n = parseFloat(raw);
    onChange({ ...data, shifts: { ...shifts, [shiftKey]: { ...shifts[shiftKey], [fieldKey]: isNaN(n) ? 0 : n } } });
  }

  let patientCounter = 0;
  function updatePatient(data, onChange, i, next) {
    const patients = Array.isArray(data.patients) ? data.patients : [];
    onChange({ ...data, patients: patients.map((p, idx) => (idx === i ? next : p)) });
  }
  function removePatient(data, onChange, i) {
    const patients = Array.isArray(data.patients) ? data.patients : [];
    onChange({ ...data, patients: patients.filter((_, idx) => idx !== i) });
  }
  function addPatient(data, onChange) {
    patientCounter += 1;
    const patients = Array.isArray(data.patients) ? data.patients : [];
    onChange({ ...data, patients: [...patients, { id: "a" + Date.now() + "_" + patientCounter, status: "" }] });
  }

  function statsTotals(wardsMeta, wardsMap) {
    const totals = {};
    STAT_FIELDS.forEach(f => totals[f.key] = 0);
    wardsMeta.forEach(w => STAT_FIELDS.forEach(f => {
      const data = wardsMap[w.key] || {};
      const v = f.key === "beds" ? (typeof data.beds === "number" ? data.beds : w.beds) : (typeof data[f.key] === "number" ? data[f.key] : 0);
      totals[f.key] += v;
    }));
    return totals;
  }
  function statValue(w, data, key) {
    return key === "beds" ? (typeof data.beds === "number" ? data.beds : w.beds) : (typeof data[key] === "number" ? data[key] : 0);
  }
  function demoStatsTotals(wardsMeta, wardsMap, fields) {
    const totals = {};
    fields.forEach(f => totals[f.key] = 0);
    wardsMeta.forEach(w => fields.forEach(f => {
      const data = wardsMap[w.key] || {};
      totals[f.key] += typeof data[f.key] === "number" ? data[f.key] : 0;
    }));
    return totals;
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/nurses-report/role-select");
  }

  const archiveId = $derived(page.url.searchParams.get("id"));
  const canEdit = $derived(authState.profile?.role === "admin" || authState.profile?.role === "subadmin");

  let archiveData = $state(null);
  let deniedMsg = $state("");
  let editMode = $state(false);
  let wardsMap = $state({});
  let saving = $state(false);
  let editStatus = $state({ text: "", error: false });

  async function load() {
    if (!archiveId) { deniedMsg = "No report was specified."; return; }
    let snap;
    try {
      snap = await getDoc(doc(db, "archives", archiveId));
    } catch (e) {
      deniedMsg = "Couldn't load this report: " + (e.code || e.message || "unknown error");
      return;
    }
    if (!snap.exists()) { deniedMsg = "This archived report no longer exists."; return; }
    const data = snap.data();
    archiveData = data;
    const isOverallType = data.type === "overall";
    wardsMap = isOverallType ? (data.wards || {}) : { [data.wardKey]: data.data || {} };
    editMode = false;
    editStatus = { text: "", error: false };
  }

  $effect(() => { if (archiveId) load(); });

  const isOverallType = $derived(archiveData?.type === "overall");
  const wardsMeta = $derived(
    !archiveData ? [] :
    isOverallType ? WARDS : [{ key: archiveData.wardKey, label: archiveData.wardLabel, beds: (archiveData.data || {}).beds || 0 }]
  );

  function updateWard(key, next) {
    wardsMap = { ...wardsMap, [key]: next };
  }

  async function saveChanges() {
    const payload = { lastEditedBy: authState.profile.name || "Unknown", lastEditedByUid: authState.user.uid, lastEditedAt: serverTimestamp() };
    if (isOverallType) payload.wards = wardsMap;
    else payload.data = wardsMap[archiveData.wardKey];

    saving = true;
    try {
      await updateDoc(doc(db, "archives", archiveId), payload);
      editStatus = { text: "Saved.", error: false };
      await load();
    } catch (e) {
      editStatus = { text: "Couldn't save: " + (e.code || e.message || "unknown error"), error: true };
    } finally {
      saving = false;
    }
  }

  function cancelEdit() {
    if (!confirm("Discard unsaved changes?")) return;
    load();
  }

  const meta = $derived.by(() => {
    if (!archiveData) return [];
    const m = ["Archived by " + (archiveData.archivedBy || "Unknown") + (archiveData.archivedAt ? " on " + fmtTimestamp(archiveData.archivedAt) : "")];
    if (archiveData.lastEditedAt) m.push("Last edited by " + (archiveData.lastEditedBy || "Unknown") + " on " + fmtTimestamp(archiveData.lastEditedAt));
    return m;
  });
</script>

{#snippet patientBlockView(p)}
  <div class="patient-block">
    {#if p.status}<div class="status-stamp">{p.status}</div>{/if}
    {#each PATIENT_FIELDS.filter(f => f.type !== "textarea") as f (f.key)}
      {#if p[f.key]}<div class="patient-line"><h3>{f.label}: </h3>{p[f.key]}</div>{/if}
    {/each}
    {#each PATIENT_FIELDS.filter(f => f.type === "textarea") as f (f.key)}
      {#if p[f.key]}
        <div>
          <h3 class="patient-note-label">{f.label}:</h3>
          {#each noteBlocks(p[f.key]) as b, i (i)}
            {#if b.type === "h"}<h4 class="patient-note-subheading">{b.text}</h4>{:else}<p class="patient-note-text">{b.text}</p>{/if}
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet wardShiftTableView(w, data)}
  {@const census = computeWardCensus(w, data)}
  {@const shifts = data.shifts || {}}
  {@const pmDuty = (shifts.pm || {}).nurseOnDuty}
  <table class="ward-shift">
    <thead>
      <tr>
        <th rowspan="2">Shift</th><th rowspan="2">Beds</th><th rowspan="2">Occ</th><th rowspan="2">Vac</th>
        {#each SOLO_BEFORE as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th colspan="2">Int. Transfer</th><th colspan="2">Ext. Transfer</th>
        {#each SOLO_AFTER as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th rowspan="2">Nurses on Duty</th>
      </tr>
      <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each SHIFTS as s (s.key)}
        {@const sData = shifts[s.key] || {}}
        <tr>
          <td class="shift-name">{s.label}</td>
          <td class="stat-beds">{census.beds}</td><td class="stat-occ">{census.perShiftOcc[s.key]}</td><td class="stat-vac">{census.beds - census.perShiftOcc[s.key]}</td>
          {#each ORDERED_MOVEMENT as f (f.key)}<td class={movementColorClass(f.key)}>{typeof sData[f.key] === "number" ? sData[f.key] : 0}</td>{/each}
          <td style="text-align:left;">{sData.nurseOnDuty || "—"}</td>
        </tr>
      {/each}
      <tr class="total-row">
        <td class="shift-name">Total</td>
        <td class="stat-beds">{census.beds}</td><td class="stat-occ">{census.finalOcc}</td><td class="stat-vac">{census.beds - census.finalOcc}</td>
        {#each ORDERED_MOVEMENT as f (f.key)}<td class={movementColorClass(f.key)}>{typeof data[f.key] === "number" ? data[f.key] : 0}</td>{/each}
        <td style="text-align:left;">{pmDuty || "—"}</td>
      </tr>
    </tbody>
  </table>
{/snippet}

{#snippet wardShiftTableEdit(w, data, onChange)}
  {@const census = computeWardCensus(w, data)}
  {@const shifts = data.shifts || {}}
  <table class="ward-shift">
    <thead>
      <tr>
        <th rowspan="2">Shift</th><th rowspan="2">Beds</th><th rowspan="2">Occ</th><th rowspan="2">Vac</th>
        {#each SOLO_BEFORE as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th colspan="2">Int. Transfer</th><th colspan="2">Ext. Transfer</th>
        {#each SOLO_AFTER as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th rowspan="2">Nurses on Duty</th>
      </tr>
      <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each SHIFTS as s (s.key)}
        <tr>
          <td class="shift-name">{s.label}</td>
          <td class="stat-beds">
            {#if s.key === "am"}<input type="number" inputmode="numeric" value={data.beds || 0} oninput={(e) => setBeds(data, onChange, e.target.value)} />{:else}{census.beds}{/if}
          </td>
          <td class="stat-occ">{census.perShiftOcc[s.key]}</td>
          <td class="stat-vac">{census.beds - census.perShiftOcc[s.key]}</td>
          {#each ORDERED_MOVEMENT as f (f.key)}
            <td class={movementColorClass(f.key)}>
              <input type="number" inputmode="numeric" value={(shifts[s.key] || {})[f.key] || 0} oninput={(e) => setShiftField(data, onChange, s.key, f.key, e.target.value)} />
            </td>
          {/each}
          <td><input type="text" class="duty-input" value={(shifts[s.key] || {}).nurseOnDuty || ""} oninput={(e) => setDuty(data, onChange, s.key, e.target.value)} /></td>
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet demographicsTableView(data, w)}
  {@const fields = demoFields(w)}
  {@const shifts = data.shifts || {}}
  {@const totals = demoTotals(data, fields)}
  <table class="shift">
    <thead><tr><th>Shift</th>{#each fields as f (f.key)}<th>{f.label}</th>{/each}</tr></thead>
    <tbody>
      {#each SHIFTS as s (s.key)}
        {@const sData = shifts[s.key] || {}}
        <tr>
          <td class="shift-name">{s.label}</td>
          {#each fields as f (f.key)}<td>{typeof sData[f.key] === "number" ? sData[f.key] : 0}</td>{/each}
        </tr>
      {/each}
      <tr class="total-row">
        <td class="shift-name">Total</td>
        {#each fields as f (f.key)}<td>{totals[f.key]}</td>{/each}
      </tr>
    </tbody>
  </table>
{/snippet}

{#snippet demographicsTableEdit(data, onChange, w)}
  {@const fields = demoFields(w)}
  {@const shifts = data.shifts || {}}
  <table class="shift">
    <thead><tr><th>Shift</th>{#each fields as f (f.key)}<th>{f.label}</th>{/each}</tr></thead>
    <tbody>
      {#each SHIFTS as s (s.key)}
        <tr>
          <td class="shift-name">{s.label}</td>
          {#each fields as f (f.key)}
            <td><input type="number" inputmode="numeric" value={(shifts[s.key] || {})[f.key] || 0} oninput={(e) => setDemoField(data, onChange, s.key, f.key, e.target.value)} /></td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet patientCardEdit(data, onChange, p, i)}
  <div class="patient-card">
    <button type="button" class="remove-btn" onclick={() => removePatient(data, onChange, i)}>Remove</button>
    <div class="patient-field">
      <label>Status:</label>
      <select class={"status-select" + (p.status ? " set" : "")} value={p.status || ""} onchange={(e) => updatePatient(data, onChange, i, { ...p, status: e.target.value })}>
        <option value="">— Select status —</option>
        {#each PATIENT_STATUS_OPTIONS as opt (opt)}<option value={opt}>{opt}</option>{/each}
      </select>
    </div>
    <div class="patient-grid">
      {#each PATIENT_FIELDS as f (f.key)}
        <div class="patient-field" style={f.type === "textarea" ? "grid-column:1 / -1;" : ""}>
          <label>{f.label}:</label>
          {#if f.type === "textarea"}
            <textarea value={p[f.key] || ""} oninput={(e) => updatePatient(data, onChange, i, { ...p, [f.key]: e.target.value })}></textarea>
          {:else}
            <input type="text" value={p[f.key] || ""} oninput={(e) => updatePatient(data, onChange, i, { ...p, [f.key]: e.target.value })} />
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet wardReportBlockView(w, data)}
  {@const patients = Array.isArray(data.patients) ? data.patients : []}
  <div class="ward-report-block">
    <h2 class="ward-report-heading">{w.label}</h2>
    <div class="table-wrap">{@render wardShiftTableView(w, data)}</div>
    <h3 class="patient-note-label" style="margin-top:14px;">Patient Demographics</h3>
    <div class="table-wrap">{@render demographicsTableView(data, w)}</div>
    {#if patients.length === 0}
      <div class="no-patients" style="margin-top:10px;">No patient write-ups submitted for this ward.</div>
    {:else}
      {#each patients as p, i (p.id || i)}{@render patientBlockView(p)}{/each}
    {/if}
    {#if data.nightUpdate}
      <div class="night-update-block">
        <h3 class="patient-note-label">{"Night Update" + (data.nightUpdateBy ? " — " + data.nightUpdateBy : "") + ":"}</h3>
        <p class="patient-note-text">{data.nightUpdate}</p>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet wardReportBlockEdit(w, data, onChange)}
  {@const patients = Array.isArray(data.patients) ? data.patients : []}
  <div class="ward-report-block">
    <h2 class="ward-report-heading">{w.label}</h2>
    <div class="patient-field">
      <label>Previous Occ:</label>
      <input type="number" inputmode="numeric" value={data.startOcc || 0}
        oninput={(e) => { const n = parseFloat(e.target.value); onChange({ ...data, startOcc: isNaN(n) ? 0 : n }); }} />
    </div>
    <div class="table-wrap">{@render wardShiftTableEdit(w, data, onChange)}</div>
    <h3 class="patient-note-label" style="margin-top:14px;">Patient Demographics</h3>
    <div class="table-wrap">{@render demographicsTableEdit(data, onChange, w)}</div>
    {#each patients as p, i (p.id || i)}{@render patientCardEdit(data, onChange, p, i)}{/each}
    <button type="button" class="add-patient-btn" onclick={() => addPatient(data, onChange)}>+ Add Patient</button>
    <div class="patient-field" style="margin-top:14px;">
      <label>Night Update:</label>
      <textarea value={data.nightUpdate || ""} oninput={(e) => onChange({ ...data, nightUpdate: e.target.value })}></textarea>
    </div>
  </div>
{/snippet}

{#snippet statsTableView(wardsMeta, wardsMap)}
  {@const totals = statsTotals(wardsMeta, wardsMap)}
  <table class="report">
    <thead>
      <tr>
        <th rowspan="2">Ward</th>
        {#each STAT_FIELDS as f (f.key)}
          {#if f.key === "transferIn"}<th colspan="2">Int. Transfer</th>
          {:else if f.key === "transferOut"}
          {:else if f.key === "ext"}<th colspan="2">Ext. Transfer</th>
          {:else if f.key === "extOut"}
          {:else}<th rowspan="2">{f.label}</th>{/if}
        {/each}
        <th rowspan="2">Nurses on Duty</th>
      </tr>
      <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each wardsMeta as w (w.key)}
        {@const data = wardsMap[w.key] || {}}
        <tr>
          <td class="ward-name">{w.label}</td>
          {#each STAT_FIELDS as f (f.key)}<td class={movementColorClass(f.key)}>{statValue(w, data, f.key)}</td>{/each}
          <td style="text-align:left;">{data.submittedBy || "—"}</td>
        </tr>
      {/each}
      <tr class="totals-row">
        <td class="ward-name">TOTAL</td>
        {#each STAT_FIELDS as f (f.key)}<td class={movementColorClass(f.key)}>{totals[f.key]}</td>{/each}
        <td></td>
      </tr>
    </tbody>
  </table>
{/snippet}

{#snippet statsTableEdit(wardsMeta, wardsMap, onChange)}
  {@const totals = statsTotals(wardsMeta, wardsMap)}
  <table class="report">
    <thead>
      <tr>
        <th rowspan="2">Ward</th>
        {#each STAT_FIELDS as f (f.key)}
          {#if f.key === "transferIn"}<th colspan="2">Int. Transfer</th>
          {:else if f.key === "transferOut"}
          {:else if f.key === "ext"}<th colspan="2">Ext. Transfer</th>
          {:else if f.key === "extOut"}
          {:else}<th rowspan="2">{f.label}</th>{/if}
        {/each}
        <th rowspan="2">Nurses on Duty</th>
      </tr>
      <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each wardsMeta as w (w.key)}
        {@const data = wardsMap[w.key] || {}}
        <tr>
          <td class="ward-name">{w.label}</td>
          {#each STAT_FIELDS as f (f.key)}
            <td class={movementColorClass(f.key)}>
              <input type="number" inputmode="numeric" value={statValue(w, data, f.key)}
                oninput={(e) => { const n = parseFloat(e.target.value); onChange(w.key, { ...data, [f.key]: isNaN(n) ? 0 : n }); }} />
            </td>
          {/each}
          <td><input type="text" class="duty-input" value={data.submittedBy || ""} oninput={(e) => onChange(w.key, { ...data, submittedBy: e.target.value })} /></td>
        </tr>
      {/each}
      <tr class="totals-row">
        <td class="ward-name">TOTAL</td>
        {#each STAT_FIELDS as f (f.key)}<td class={movementColorClass(f.key)}>{totals[f.key]}</td>{/each}
        <td></td>
      </tr>
    </tbody>
  </table>
{/snippet}

{#snippet demoStatsTableView(wardsMeta, wardsMap)}
  {@const fields = DEMOGRAPHIC_FIELDS.filter(f => f.key !== "child")}
  {@const totals = demoStatsTotals(wardsMeta, wardsMap, fields)}
  <table class="report">
    <thead><tr><th>Ward</th>{#each fields as f (f.key)}<th>{f.label}</th>{/each}</tr></thead>
    <tbody>
      {#each wardsMeta as w (w.key)}
        {@const data = wardsMap[w.key] || {}}
        <tr>
          <td class="ward-name">{w.label}</td>
          {#each fields as f (f.key)}<td>{typeof data[f.key] === "number" ? data[f.key] : 0}</td>{/each}
        </tr>
      {/each}
      <tr class="totals-row">
        <td class="ward-name">TOTAL</td>
        {#each fields as f (f.key)}<td>{totals[f.key]}</td>{/each}
      </tr>
    </tbody>
  </table>
{/snippet}

{#snippet demoStatsTableEdit(wardsMeta, wardsMap, onChange)}
  {@const fields = DEMOGRAPHIC_FIELDS.filter(f => f.key !== "child")}
  {@const totals = demoStatsTotals(wardsMeta, wardsMap, fields)}
  <table class="report">
    <thead><tr><th>Ward</th>{#each fields as f (f.key)}<th>{f.label}</th>{/each}</tr></thead>
    <tbody>
      {#each wardsMeta as w (w.key)}
        {@const data = wardsMap[w.key] || {}}
        <tr>
          <td class="ward-name">{w.label}</td>
          {#each fields as f (f.key)}
            <td><input type="number" inputmode="numeric" value={typeof data[f.key] === "number" ? data[f.key] : 0}
              oninput={(e) => { const n = parseFloat(e.target.value); onChange(w.key, { ...data, [f.key]: isNaN(n) ? 0 : n }); }} /></td>
          {/each}
        </tr>
      {/each}
      <tr class="totals-row">
        <td class="ward-name">TOTAL</td>
        {#each fields as f (f.key)}<td>{totals[f.key]}</td>{/each}
      </tr>
    </tbody>
  </table>
{/snippet}

<Topbar brand="Archived Report">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
  {#if !deniedMsg && archiveData}<button class="btn btn-primary" style="padding:6px 12px;" onclick={() => window.print()}>Print</button>{/if}
</Topbar>

{#if deniedMsg}
  <div class="container">
    <div class="card-box" style="text-align:center;">
      <h3 style="margin-top:0;">Not Found</h3>
      <p style="font-size:13px;color:#555;">{deniedMsg}</p>
    </div>
  </div>
{:else if archiveData}
  <div class="container">
    <div class="card-box">
      <h1 class="period-label">
        {archiveData.fileName || archiveData.dateId}
        <span class={editMode ? "editing-badge" : "readonly-badge"}>{editMode ? "Editing" : "Read-only"}</span>
        {#if canEdit}
          <button class="edit-toggle-btn" onclick={() => { if (editMode) { cancelEdit(); } else editMode = true; }}>
            {editMode ? "✖ Stop Editing" : "✏️ Edit"}
          </button>
        {/if}
      </h1>
      <div class="file-meta-row">{meta.join(" · ")}</div>
    </div>

    {#if isOverallType}
      <div class="card-box">
        <h2>All Wards — 24-Hour Statistics</h2>
        <div class="table-wrap">
          {#if editMode}{@render statsTableEdit(wardsMeta, wardsMap, updateWard)}{:else}{@render statsTableView(wardsMeta, wardsMap)}{/if}
        </div>
      </div>
      <div class="card-box">
        <h2>Patient Demographics</h2>
        <div class="table-wrap">
          {#if editMode}{@render demoStatsTableEdit(wardsMeta, wardsMap, updateWard)}{:else}{@render demoStatsTableView(wardsMeta, wardsMap)}{/if}
        </div>
      </div>
    {/if}

    <div class="card-box">
      <h2>{"Ward Report" + (isOverallType ? "s" : "")}</h2>
      {#each wardsMeta as w (w.key)}
        {@const data = wardsMap[w.key] || {}}
        {#if editMode}{@render wardReportBlockEdit(w, data, (next) => updateWard(w.key, next))}{:else}{@render wardReportBlockView(w, data)}{/if}
      {/each}
    </div>

    {#if editMode}
      <div class="card-box">
        <div class="edit-actions">
          <button class="btn btn-primary" style="flex:1;padding:12px;" disabled={saving} onclick={saveChanges}>Save Changes</button>
          <button class="btn btn-secondary" style="flex:1;padding:12px;" onclick={cancelEdit}>Cancel</button>
        </div>
        <div class="save-status" style={"color:" + (editStatus.error ? "#dc2626" : "#6b7280") + ";"}>{editStatus.text}</div>
      </div>
    {/if}
  </div>
{/if}
