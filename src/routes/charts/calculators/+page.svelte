<script>
  // Ported from src/pages/Calculators.jsx. initCalculators is vanilla
  // DOM code (ported verbatim from MedIndex, framework-agnostic) — this
  // page just mounts it into a container div, same as the original.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { doc, getDoc } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import { initCalculators } from "$lib/helpers/calculators.js";

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  const patientId = $derived(page.url.searchParams.get("patient"));

  // Reference tool, independent of any single patient — still show a
  // banner for orientation if we arrived here with one selected, but
  // never require one.
  let patient = $state(null);
  $effect(() => {
    if (!patientId) { patient = null; return; }
    (async () => {
      try {
        const snap = await getDoc(doc(db, "patients", patientId));
        if (snap.exists()) patient = snap.data();
      } catch (e) { /* non-critical — calculators still work without patient context */ }
    })();
  });

  let rootEl = $state(null);
  onMount(() => {
    if (rootEl) initCalculators(rootEl);
  });
</script>

<Topbar brand="Clinical Calculators">
  <button class="btn btn-secondary" style="padding: 6px 12px;" onclick={goBack}>Back</button>
</Topbar>
<div class="container">
  {#if patient}
    <div class="patient-banner">
      <div>
        <div class="pname">{patient.name || ""}</div>
        <div class="pmeta">EMR: {patient.emr || "\u2014"}{patient.diagnosis ? " | Diagnosis: " + patient.diagnosis : ""}</div>
      </div>
    </div>
  {/if}
  <div class="card-box">
    <div bind:this={rootEl}></div>
  </div>
</div>
