<script>
  // Ported from src/pages/LabReference.jsx. initLabReference is vanilla
  // DOM code (ported verbatim from MedIndex, framework-agnostic) — this
  // page just mounts it into a container div, same as the original.
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import Topbar from "$lib/components/Topbar.svelte";
  import { initLabReference } from "$lib/helpers/labReference.js";

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  let rootEl = $state(null);
  onMount(() => {
    if (rootEl) initLabReference(rootEl);
  });
</script>

<Topbar brand="Lab Reference">
  <button class="btn btn-secondary" style="padding: 6px 12px;" onclick={goBack}>Back</button>
</Topbar>
<div class="container">
  <div class="card-box">
    <div bind:this={rootEl}></div>
  </div>
</div>
