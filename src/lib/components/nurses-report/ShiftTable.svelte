<script>
  // Ported from ShiftTable() in src/pages/nurses-report/WardNurse.jsx.
  import { SHIFTS } from "$lib/helpers/nursesReportCommon.js";
  import { movementColorClass } from "$lib/helpers/nursesReportCommon.js";
  import { SOLO_BEFORE, SOLO_AFTER, ORDERED_MOVEMENT } from "$lib/helpers/useWardReport.svelte.js";

  let { wardDoc, census, movementTotals, editable, onBeds, onField, onDuty } = $props();
</script>

<table class="shift">
  <thead>
    <tr>
      <th rowspan="2">Shift</th><th rowspan="2">Beds</th><th rowspan="2">Occ</th><th rowspan="2">Vac</th>
      {#each SOLO_BEFORE as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
      <th colspan="2">Int. Transfer</th>
      <th colspan="2">Ext. Transfer</th>
      {#each SOLO_AFTER as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
      <th rowspan="2">Nurses on Duty</th>
    </tr>
    <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
  </thead>
  <tbody>
    {#each SHIFTS as s (s.key)}
      <tr>
        <td class="shift-name">{s.label}</td>
        <td class={"stat-beds" + (s.key === "am" ? "" : " mirrored")}>
          {#if s.key === "am"}
            <input type="number" inputmode="numeric" disabled={!editable} value={wardDoc.beds} onchange={(e) => onBeds(e.target.value)} />
          {:else}
            {census.beds}
          {/if}
        </td>
        <td class="computed stat-occ">{census.perShiftOcc[s.key]}</td>
        <td class="computed stat-vac">{census.beds - census.perShiftOcc[s.key]}</td>
        {#each ORDERED_MOVEMENT as f (f.key)}
          <td class={movementColorClass(f.key)}>
            <input type="number" inputmode="numeric" disabled={!editable}
              value={wardDoc.shifts[s.key][f.key]} onchange={(e) => onField(s.key, f.key, e.target.value)} />
          </td>
        {/each}
        <td>
          <input type="text" class="duty-input" placeholder="Nurse name(s)" disabled={!editable}
            value={wardDoc.shifts[s.key].nurseOnDuty} onchange={(e) => onDuty(s.key, e.target.value)} />
        </td>
      </tr>
    {/each}
    <tr class="total-row">
      <td class="shift-name">Total</td>
      <td class="stat-beds">{census.beds}</td>
      <td class="stat-occ">{census.occ}</td>
      <td class="stat-vac">{census.vac}</td>
      {#each ORDERED_MOVEMENT as f (f.key)}<td class={movementColorClass(f.key)}>{movementTotals[f.key]}</td>{/each}
      <td style="text-align:left;">{wardDoc.shifts.pm.nurseOnDuty || "\u2014"}</td>
    </tr>
  </tbody>
</table>
