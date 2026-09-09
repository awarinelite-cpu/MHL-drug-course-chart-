<script>
  // Ported from src/components/PatientBanner.jsx. React's `extra` render-prop
  // becomes a `extra` snippet slot the parent passes as
  // `{#snippet extra()}...{/snippet}`.
  const NO_ALLERGY_RE = /^(none|nil|none known)$/i;

  let { patient = null, ward = "", extra = null } = $props();

  const allergy = $derived((patient?.allergies || "").trim());
  const showAllergy = $derived(allergy && !NO_ALLERGY_RE.test(allergy));
</script>

<div class="patient-banner">
  <div class="patient-banner-row1">
    <div>
      <div class="pname">{patient ? (patient.name || "Unnamed") : "Loading…"}</div>
      <div class="pmeta">
        {#if patient}
          EMR: {patient.emr || "N/A"}&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;Diagnosis: {patient.diagnosis || "Not specified"}{patient.insurance ? "\u00a0\u00a0\u00a0|\u00a0\u00a0\u00a0" + patient.insurance : ""}
        {/if}
      </div>
      {#if ward}<div class="pward">Ward: {ward}</div>{/if}
    </div>
  </div>
  {#if extra}<div class="patient-banner-row2">{@render extra()}</div>{/if}
</div>
{#if showAllergy}<div class="allergy-alert">ALLERGY ALERT: {allergy}</div>{/if}
