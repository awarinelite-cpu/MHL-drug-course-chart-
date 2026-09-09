<script>
  import Topbar from "$lib/components/Topbar.svelte";
  import { authState } from "$lib/stores/auth.svelte.js";
</script>

<Topbar brand="68 NARHY Ward Charts" />

<div class="container">
  <div class="card-box">
    <h2 style="margin-top:0;">Welcome{authState.profile?.name ? ", " + authState.profile.name : ""}</h2>
    <p style="color:#666;">
      This is the Svelte rebuild of the ward-charts app, in progress. The Drug Course Chart page is fully
      ported and working end to end with Firestore (load, autosave, drugs, administration chart, verbal
      orders, care instructions, audit log, bulk drug upload). Everything else in the menu is a placeholder
      for now, ported next.
    </p>
    <a class="btn btn-primary" href="/charts/drug-course-chart">Open Drug Course Chart</a>
  </div>
</div>
