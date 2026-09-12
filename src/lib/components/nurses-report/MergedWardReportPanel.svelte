<script>
  // Ported from MergedWardReportPanel() in src/pages/nurses-report/WardNurse.jsx.
  // A mergedTable group's full report (Maternity, Paed): one shared
  // editable Shift Statistics table for both member wards with both
  // members' Previous Occ inline just above it, and one Archive button
  // covering the whole group — all still writing to the two members' own
  // separate Firestore docs underneath. Save/Submit always saves BOTH
  // member wards' data together. What happens below the table depends on
  // group.demographicsVariant — see the doc-comment on the original.
  // Assumes exactly two member wards, true for every mergedTable group
  // defined today.
  import { goto } from "$app/navigation";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { createWardReport } from "$lib/helpers/useWardReport.svelte.js";
  import { ADMISSION_TAG_LABEL } from "$lib/helpers/patientAdmissionStatus.js";
  import MergedShiftTable from "./MergedShiftTable.svelte";
  import MergedDemographicsTable from "./MergedDemographicsTable.svelte";
  import WardPanelRest from "./WardPanelRest.svelte";
  import WardPatientPicker from "./WardPatientPicker.svelte";

  let { group } = $props();

  const isAdmin = $derived(authState.profile?.role === "admin");
  const hA = createWardReport(group.wardKeys[0], authState.profile, authState.user, () => isAdmin);
  const hB = createWardReport(group.wardKeys[1], authState.profile, authState.user, () => isAdmin);
  const hooks = [hA, hB];
  const bothLoaded = $derived(hooks.every((h) => h.wardDoc));
  const mergedDemographics = group.demographicsVariant === "merged";

  // Same quick lookup as WardPanelRest's own Previous Occ card — reads off
  // hA's wardPatientOptions since the Patients section below (rendered via
  // WardPanelRest with h={hA}) is always hA's, regardless of which member
  // ward the write-ups actually belong to.
  let quickLookupId = $state("");
  let quickLookupRecord = $derived((hA.wardPatientOptions || []).find((o) => o.id === quickLookupId));
  let quickLookupTag = $derived(
    !quickLookupRecord ? null :
    quickLookupRecord.dischargeStatus
      ? (quickLookupRecord.dischargeStatus === "TRANS OUT" ? "TRANS OUT" : quickLookupRecord.dischargeStatus === "DEATH" ? "Death" : "Discharged")
      : quickLookupRecord.admissionTag
        ? (ADMISSION_TAG_LABEL[quickLookupRecord.admissionTag] || quickLookupRecord.admissionTag)
        : "Active \u2014 no status tag"
  );

  async function saveBoth() { await Promise.all([hA.saveReport(), hB.saveReport()]); }
  async function submitBoth() { await Promise.all([hA.submitReport(), hB.submitReport()]); }
</script>

{#if bothLoaded}
  <div class="card-box">
    <div class="ward-select-row">
      <h2 style="margin:0;">{group.label} \u2014 Shift Statistics</h2>
      <button class="btn btn-secondary" style="padding:6px 12px;" type="button"
        onclick={() => goto("/nurses-report/archive-list?type=ward&ward=" + encodeURIComponent(hA.w.key) + "&label=" + encodeURIComponent(group.label))}>
        {"\uD83D\uDCC1 Archive"}
      </button>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;margin-bottom:12px;">
      {#each hooks as h (h.w.key)}
        <div class="patient-field" style="max-width:140px;">
          <label for={"prev-occ-" + h.w.key}>{"Previous Occ (" + h.w.label + ")"}</label>
          <input id={"prev-occ-" + h.w.key} type="number" inputmode="numeric" disabled={!h.editable} value={h.wardDoc.startOcc} onchange={(e) => h.updateStartOcc(e.target.value)} />
        </div>
      {/each}
      {#if hA.wardPatientOptions && hA.wardPatientOptions.length > 0}
        <div class="patient-field" style="min-width:220px;">
          <label>Check a patient's status:</label>
          <WardPatientPicker value={quickLookupId} options={hA.wardPatientOptions} onSelect={(id) => quickLookupId = id} />
          {#if quickLookupTag}
            <div style={"font-size:12px;margin-top:4px;font-weight:bold;color:" + (quickLookupRecord.dischargeStatus ? "#dc2626" : quickLookupRecord.admissionTag ? "#2563eb" : "#6b7280") + ";"}>
              {quickLookupTag}
            </div>
          {/if}
        </div>
      {/if}
    </div>
    <div class="table-wrap">
      <MergedShiftTable panels={hooks.map((h) => ({
        w: h.w, wardDoc: h.wardDoc, census: h.census, movementTotals: h.movementTotals,
        editable: h.editable, updateBeds: h.updateBeds, updateShiftField: h.updateShiftField, updateDuty: h.updateDuty
      }))} />
    </div>
  </div>
{/if}
{#if bothLoaded && mergedDemographics}
  <div class="card-box">
    <h2>Patient Demographics</h2>
    <div class="table-wrap">
      <MergedDemographicsTable panels={hooks.map((h) => ({ w: h.w, wardDoc: h.wardDoc, editable: h.editable, onField: h.updateShiftField }))} />
    </div>
  </div>
{/if}
<WardPanelRest h={hA} showLabel={false} {isAdmin}
  includeShiftTable={false} includePreviousOcc={false} includeHeader={false}
  includeDemographics={!mergedDemographics} useMaternityDemographics={group.demographicsVariant === "maternity"}
  locationOptions={group.patientLocationOptions}
  onSave={saveBoth} onSubmit={submitBoth} />
