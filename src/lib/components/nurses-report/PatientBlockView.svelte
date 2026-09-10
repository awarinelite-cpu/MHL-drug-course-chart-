<script>
  // Ported from PatientBlockView() and NoteLines() in
  // src/pages/nurses-report/WardNurse.jsx. Read-only render of one
  // patient write-up card (used once a ward's report is locked/submitted).
  import { PATIENT_FIELDS } from "$lib/helpers/nursesReportCommon.js";
  import { noteBlocks } from "$lib/helpers/useWardReport.svelte.js";

  let { p } = $props();

  const summaryFields = PATIENT_FIELDS.filter((f) => f.type !== "textarea");
  const textFields = PATIENT_FIELDS.filter((f) => f.type === "textarea");
</script>

<div class="patient-block">
  {#if p.status}<div class="status-stamp">{p.status}</div>{/if}
  {#if p.location}<div class="status-stamp">{p.location}</div>{/if}
  {#each summaryFields as f (f.key)}
    {#if p[f.key]}<div class="patient-line"><h3>{f.label}: </h3>{p[f.key]}</div>{/if}
  {/each}
  {#each textFields as f (f.key)}
    {#if p[f.key]}
      <div>
        <h3 class="patient-note-label">{f.label}:</h3>
        {#each noteBlocks(p[f.key]) as b, i (i)}
          {#if b.type === "h"}
            <h4 class="patient-note-subheading">{b.text}</h4>
          {:else}
            <p class="patient-note-text">{b.text}</p>
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
</div>
