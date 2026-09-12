<script>
  // Ported from WardPanelRest() in src/pages/nurses-report/WardNurse.jsx.
  // Everything about one ward's report except the Shift Statistics table
  // itself: header/status/archive, locked notice, Previous Occ, [the Shift
  // Statistics table, when includeShiftTable], Patient Demographics,
  // Patients, Night Update, Save/Submit. See the flag doc-comments below —
  // ported verbatim from the original.
  import { goto } from "$app/navigation";
  import {
    PATIENT_FIELDS, PATIENT_STATUS_OPTIONS
  } from "$lib/helpers/nursesReportCommon.js";
  import { ADMISSION_TAG_LABEL } from "$lib/helpers/patientAdmissionStatus.js";
  import { autogrow } from "$lib/helpers/autogrow.js";
  import ShiftTable from "./ShiftTable.svelte";
  import DemographicsTable from "./DemographicsTable.svelte";
  import MaternityDemographicsTable from "./MaternityDemographicsTable.svelte";
  import PatientBlockView from "./PatientBlockView.svelte";
  import VitalsChipRow from "./VitalsChipRow.svelte";
  import WardPatientPicker from "./WardPatientPicker.svelte";

  let {
    h, showLabel, isAdmin,
    includeShiftTable = true, includePreviousOcc = true, includeHeader = true, includeDemographics = true,
    onSave = null, onSubmit = null, useMaternityDemographics = false, locationOptions = null
  } = $props();

  // Quick lookup only, not tied to any write-up — lets the nurse glance at
  // a patient's roster tag (Discharge/Trans Out/Death/admission tag) right
  // next to Previous Occ while tallying the Shift Statistics table above,
  // instead of scrolling all the way down to the Patients section to find
  // that same tag on a linked write-up.
  let quickLookupId = $state("");
  let quickLookupRecord = $derived((h.wardPatientOptions || []).find((o) => o.id === quickLookupId));
  let quickLookupTag = $derived(
    !quickLookupRecord ? null :
    quickLookupRecord.dischargeStatus
      ? (quickLookupRecord.dischargeStatus === "TRANS OUT" ? "TRANS OUT" : quickLookupRecord.dischargeStatus === "DEATH" ? "Death" : "Discharged")
      : quickLookupRecord.admissionTag
        ? (ADMISSION_TAG_LABEL[quickLookupRecord.admissionTag] || quickLookupRecord.admissionTag)
        : "Active \u2014 no status tag"
  );
</script>

{#if includeHeader && h.topStatus.text}
  <div class="save-status" style={"color:" + (h.topStatus.error ? "#dc2626" : "#6b7280") + ";margin:4px 0 0;"}>{h.topStatus.text}</div>
{/if}

{#if h.wardDoc}
  {#if h.wardDoc.locked}
    <div class="locked-notice">
      {isAdmin ? "This ward's report is locked." : "This ward's report is locked. Ask the Overall Nurse to grant access before editing."}
      {#if isAdmin && !h.adminEditOverride}
        <button class="admin-edit-btn" onclick={() => h.setAdminEditOverride(true)}>{"\u270F\uFE0F"}</button>
      {/if}
    </div>
  {/if}

  {#if includePreviousOcc}
    <div class="card-box">
      <div class="ward-select-row">
        <h2 style="margin:0;">{showLabel && h.w?.label ? h.w.label : "Previous Occ"}</h2>
        <span class={"status-pill " + h.pillClass}>{h.pillText}</span>
        {#if includeHeader && h.w}
          <button class="btn btn-secondary" style="padding:6px 12px;" type="button"
            onclick={() => goto("/nurses-report/archive-list?type=ward&ward=" + encodeURIComponent(h.w.key) + "&label=" + encodeURIComponent(h.w.label))}>
            {"\uD83D\uDCC1 Archive"}
          </button>
        {/if}
      </div>
      {#if showLabel && h.w?.label}<div style="font-size:13px;color:#6b7280;margin:6px 0 0;">Previous Occ</div>{/if}
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-top:4px;">
        <div class="patient-field" style="max-width:140px;margin-top:0;">
          <input type="number" inputmode="numeric" disabled={!h.editable} value={h.wardDoc.startOcc} onchange={(e) => h.updateStartOcc(e.target.value)} />
        </div>
        {#if h.wardPatientOptions && h.wardPatientOptions.length > 0}
          <div class="patient-field" style="min-width:220px;margin-top:0;">
            <label>Check a patient's status:</label>
            <WardPatientPicker value={quickLookupId} options={h.wardPatientOptions} onSelect={(id) => quickLookupId = id} />
            {#if quickLookupTag}
              <div style={"font-size:12px;margin-top:4px;font-weight:bold;color:" + (quickLookupRecord.dischargeStatus ? "#dc2626" : quickLookupRecord.admissionTag ? "#2563eb" : "#6b7280") + ";"}>
                {quickLookupTag}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if includeShiftTable}
    <div class="card-box">
      <h2>Shift Statistics</h2>
      <div class="table-wrap">
        <ShiftTable wardDoc={h.wardDoc} census={h.census} movementTotals={h.movementTotals} editable={h.editable}
          onBeds={h.updateBeds} onField={h.updateShiftField} onDuty={h.updateDuty} />
      </div>
    </div>
  {/if}

  {#if includeDemographics}
    <div class="card-box">
      <h2>Patient Demographics</h2>
      <div class="table-wrap">
        {#if useMaternityDemographics}
          <MaternityDemographicsTable wardDoc={h.wardDoc} editable={h.editable} onField={h.updateShiftField} />
        {:else}
          <DemographicsTable wardDoc={h.wardDoc} totals={h.demographicTotals} editable={h.editable} onField={h.updateShiftField} />
        {/if}
      </div>
    </div>
  {/if}

  <div class="card-box">
    <h2>Patients</h2>
    {#if h.editable}
      {#each h.wardDoc.patients as p (p.id)}
        <div class="patient-card">
          <button type="button" class="remove-btn" onclick={() => h.removePatient(p.id)}>Remove</button>
          {#if h.wardPatientOptions && h.wardPatientOptions.length > 0}
            <div class="patient-field">
              <label for={"select-patient-" + p.id}>Select Patient:</label>
              <WardPatientPicker value={p.sourcePatientId || ""} options={h.wardPatientOptions} onSelect={(id) => h.selectPatientFromWard(p.id, id)} />
            </div>
          {/if}
          {#if locationOptions}
            <div class="patient-field">
              <label for={"location-" + p.id}>Located:</label>
              <select id={"location-" + p.id} class={"status-select" + (p.location ? " set" : "")}
                value={p.location || ""} onchange={(e) => h.updatePatientField(p.id, "location", e.target.value)}>
                <option value="">{"\u2014 Select \u2014"}</option>
                {#each locationOptions as opt (opt)}<option value={opt}>{opt}</option>{/each}
              </select>
            </div>
          {/if}
          <div class="patient-field">
            <label for={"status-" + p.id}>Status:</label>
            <select id={"status-" + p.id} class={"status-select" + (p.status ? " set" : "")}
              value={p.status || ""} onchange={(e) => h.updatePatientStatus(p.id, e.target.value)}>
              <option value="">{"\u2014 Select status \u2014"}</option>
              {#each PATIENT_STATUS_OPTIONS as opt (opt)}<option value={opt}>{opt}</option>{/each}
            </select>
          </div>
          <div class="patient-grid">
            {#each PATIENT_FIELDS as f (f.key)}
              <div class="patient-field" style={f.type === "textarea" ? "grid-column:1 / -1;" : undefined}>
                <label for={f.key + "-" + p.id}>{f.label}:</label>
                {#if f.type === "textarea"}
                  <textarea id={f.key + "-" + p.id} class={f.big ? "big" : ""} value={p[f.key] || ""}
                    use:autogrow={{ min: f.big ? 110 : 60, max: 480 }}
                    oninput={(e) => f.key === "diagnosis" ? h.updateDiagnosisField(p.id, e.target.value) : h.updatePatientField(p.id, f.key, e.target.value)}></textarea>
                {:else}
                  <input id={f.key + "-" + p.id} type="text" value={p[f.key] || ""} oninput={(e) => h.updatePatientField(p.id, f.key, e.target.value)}
                    onblur={f.key === "emr" ? (e) => h.lookupPatientByEmr(p.id, e.target.value) : undefined} />
                {/if}
                {#if f.key === "diagnosis" && p.vitalsSnapshot}
                  <VitalsChipRow snapshot={p.vitalsSnapshot} onChange={(field, value) => h.updateVitalsSnapshotField(p.id, field, value)} />
                {/if}
                {#if f.key === "emr" && h.emrLookup[p.id]}
                  <div class="emr-lookup-note" style={"color:" + (h.emrLookup[p.id].error ? "#dc2626" : "#6b7280") + ";"}>
                    {h.emrLookup[p.id].text}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
      <button class="add-patient-btn" type="button" onclick={h.addPatient}>+ Add Patient</button>
    {:else if h.wardDoc.patients.length === 0}
      <div class="no-patients">No patient write-ups on this report.</div>
    {:else}
      {#each h.wardDoc.patients as p (p.id)}<PatientBlockView {p} />{/each}
    {/if}

    <h2 class="night-update-heading">Night Update</h2>
    {#if h.editable}
      <button class="btn btn-secondary" type="button" onclick={h.openNightUpdate}>{"\uD83C\uDF19 Night Update"}</button>
    {/if}
    {#if h.editable && h.nightUpdateOpen}
      <div class="patient-field" style="margin-top:10px;">
        <label class="patient-note-label" for="nightUpdateInput" style="margin-top:0;">Night update:</label>
        <textarea id="nightUpdateInput" placeholder="Type the night update here\u2026"
          use:autogrow={{ min: 140, max: 520 }}
          value={h.wardDoc.nightUpdate} oninput={(e) => h.updateWardDoc({ nightUpdate: e.target.value })}></textarea>
      </div>
    {/if}
    {#if !h.editable && h.wardDoc.nightUpdate}
      <div class="night-update-block">
        <h3 class="patient-note-label">{"Night Update" + (h.wardDoc.nightUpdateBy ? " \u2014 " + h.wardDoc.nightUpdateBy : "") + ":"}</h3>
        <p class="patient-note-text">{h.wardDoc.nightUpdate}</p>
      </div>
    {/if}
    {#if h.editable}<div class="night-update-meta">{h.wardDoc.nightUpdateBy ? "Added by " + h.wardDoc.nightUpdateBy : ""}</div>{/if}
  </div>

  <div class="card-box">
    {#if h.editable}
      <div class="submit-bar">
        <button class="btn btn-secondary" style="flex:1;padding:12px;" onclick={onSave || h.saveReport}>Save</button>
        <button class="btn btn-primary" style="flex:1;padding:12px;" onclick={onSubmit || h.submitReport}>Submit Report</button>
      </div>
    {/if}
    <div class="save-status" style={"color:" + (h.saveStatus.error ? "#dc2626" : "#6b7280") + ";"}>{h.saveStatus.text}</div>
  </div>
{/if}
