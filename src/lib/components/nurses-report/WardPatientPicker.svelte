<script>
  // Ported from WardPatientPicker() in src/pages/nurses-report/WardNurse.jsx.
  // "Select Patient" picker for a write-up card — a button that opens a
  // modal listing this ward's patients (wardPatientOptions), rather than a
  // plain <select>. A native <select>'s <option> can only ever be a single
  // line of plain text, so it can't carry the small red DISCHARGE/TRANS OUT
  // tag a patient needs once they've been discharged or referred out (see
  // dischargeStatus on wardPatientOptions, set by applyPatientStatus in
  // patientAdmissionStatus.js) — they stay on this list, tag and all, until
  // a closing report is submitted for them (see submitReport in
  // useWardReport.svelte.js), so the nurse can still find and tap them to
  // write that closing note.
  let { value = "", options = [], onSelect, id = undefined } = $props();

  let open = $state(false);

  let selected = $derived(options.find((o) => o.id === value));
  let label = $derived(selected ? ((selected.name || "Unnamed") + (selected.emr ? " (" + selected.emr + ")" : "")) : "\u2014 Select from ward \u2014");

  function pick(id) { onSelect(id); open = false; }
</script>

<button {id} type="button" class={"ward-patient-picker-btn" + (value ? " set" : "")} onclick={() => open = true}>
  <span class="ward-patient-picker-btn-text">{label}</span>
  <span class="sno-picker-caret">{"\u25BE"}</span>
</button>

{#if open}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) open = false; }}>
    <div class="modal-box">
      <div class="modal-header"><h3>Select Patient</h3><button class="modal-close" onclick={() => open = false}>&times;</button></div>
      <div class="modal-body ward-patient-picker-body">
        <div class="ward-patient-picker-row" onclick={() => pick("")}>
          <span class={"ward-patient-picker-name" + (!value ? " is-selected" : "")}>{"\u2014 Select from ward \u2014"}</span>
        </div>
        {#each options as o (o.id)}
          <div class="ward-patient-picker-row" onclick={() => pick(o.id)}>
            <div>
              <span class={"ward-patient-picker-name" + (o.id === value ? " is-selected" : "")}>
                {(o.name || "Unnamed") + (o.emr ? " (" + o.emr + ")" : "")}
              </span>
              {#if o.dischargeStatus}
                <div class="ward-patient-picker-tag">{o.dischargeStatus === "TRANS OUT" ? "TRANS OUT" : "Discharged"}</div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
