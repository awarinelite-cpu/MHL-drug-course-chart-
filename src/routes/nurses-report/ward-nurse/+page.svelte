<script>
  // Ported from the default export of src/pages/nurses-report/WardNurse.jsx.
  import { goto } from "$app/navigation";
  import { wardSelectorOptions } from "$lib/helpers/nursesReportCommon.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import WardReportPanel from "$lib/components/nurses-report/WardReportPanel.svelte";
  import MergedWardReportPanel from "$lib/components/nurses-report/MergedWardReportPanel.svelte";
  import wardSelectBg from "$lib/assets/ward-select-bg.svg";

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/nurses-report/role-select");
  }

  const wardOptions = wardSelectorOptions();
  let groupKey = $state("");
  const activeOption = $derived(wardOptions.find((o) => o.key === groupKey) || null);
</script>

<Topbar brand="Ward Nurse">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
</Topbar>
<div class="ward-select-page" style={"background-image:url(" + wardSelectBg + ");"}></div>
<div class="container">
  <div class="card-box">
    <div class="ward-select-row">
      <select bind:value={groupKey}>
        <option value="">-- Select your ward --</option>
        {#each wardOptions as o (o.key)}<option value={o.key}>{o.label}</option>{/each}
      </select>
    </div>
  </div>

  {#if activeOption}
    {#key activeOption.key}
      {#if activeOption.mergedTable}
        <MergedWardReportPanel group={activeOption} />
      {:else}
        {#each activeOption.wardKeys as key (key)}
          <WardReportPanel wardKey={key} showLabel={activeOption.wardKeys.length > 1} />
        {/each}
      {/if}
    {/key}
  {/if}
</div>
