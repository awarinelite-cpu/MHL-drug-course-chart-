<script>
  // Ported from MergedShiftTable() in src/pages/nurses-report/WardNurse.jsx.
  // One shared, editable Shift Statistics table for a mergedTable group
  // (currently just MATERNITY WARD) — matches the paper Minute Book
  // exactly: a Morning section with a Mothers row then a Cots row, a Night
  // section the same way, and one combined Total row. `panels` is one
  // entry per member ward, each still writing to its own wardDoc/Firestore
  // record via its own handlers — this table only combines display/totals.
  import { SHIFTS, movementColorClass } from "$lib/helpers/nursesReportCommon.js";
  import { SOLO_BEFORE, SOLO_AFTER, ORDERED_MOVEMENT } from "$lib/helpers/useWardReport.svelte.js";

  let { panels } = $props();

  const totalBeds = $derived(panels.reduce((s, p) => s + p.census.beds, 0));
  const totalOcc = $derived(panels.reduce((s, p) => s + p.census.occ, 0));
  const totalVac = $derived(panels.reduce((s, p) => s + p.census.vac, 0));
  const totalMovement = $derived.by(() => {
    const out = {};
    ORDERED_MOVEMENT.forEach((f) => {
      out[f.key] = panels.reduce((s, p) => s + (typeof p.movementTotals[f.key] === "number" ? p.movementTotals[f.key] : 0), 0);
    });
    return out;
  });
  const dutyNames = $derived(panels.map((p) => p.wardDoc.shifts.pm.nurseOnDuty).filter(Boolean).join(", "));
  const colSpanAll = 4 + ORDERED_MOVEMENT.length + 1;
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
      <tr class="shift-section-row"><td colspan={colSpanAll}>{s.label === "Am" ? "Morning" : "Night"}</td></tr>
      {#each panels as p (p.w.key)}
        <tr>
          <td class="shift-name">{p.w.label}</td>
          <td class={"stat-beds" + (s.key === "am" ? "" : " mirrored")}>
            {#if s.key === "am"}
              <input type="number" inputmode="numeric" disabled={!p.editable} value={p.wardDoc.beds} onchange={(e) => p.updateBeds(e.target.value)} />
            {:else}
              {p.census.beds}
            {/if}
          </td>
          <td class="computed stat-occ">{p.census.perShiftOcc[s.key]}</td>
          <td class="computed stat-vac">{p.census.beds - p.census.perShiftOcc[s.key]}</td>
          {#each ORDERED_MOVEMENT as f (f.key)}
            <td class={movementColorClass(f.key)}>
              <input type="number" inputmode="numeric" disabled={!p.editable}
                value={p.wardDoc.shifts[s.key][f.key]} onchange={(e) => p.updateShiftField(s.key, f.key, e.target.value)} />
            </td>
          {/each}
          <td>
            <input type="text" class="duty-input" placeholder="Nurse name(s)" disabled={!p.editable}
              value={p.wardDoc.shifts[s.key].nurseOnDuty} onchange={(e) => p.updateDuty(s.key, e.target.value)} />
          </td>
        </tr>
      {/each}
    {/each}
    <tr class="total-row">
      <td class="shift-name">Total</td>
      <td class="stat-beds">{totalBeds}</td>
      <td class="stat-occ">{totalOcc}</td>
      <td class="stat-vac">{totalVac}</td>
      {#each ORDERED_MOVEMENT as f (f.key)}<td class={movementColorClass(f.key)}>{totalMovement[f.key]}</td>{/each}
      <td style="text-align:left;">{dutyNames || "\u2014"}</td>
    </tr>
  </tbody>
</table>
