<script>
  // Ported from MaternityDemographicsTable() in src/pages/nurses-report/WardNurse.jsx.
  // Maternity's own Patient Demographics table: no flat "Children" count —
  // instead a "COT" group header spans Male/Female sub-columns tracking
  // newborns' sex, since every patient on Mothers is an adult woman.
  // Soldiers/Civilians sit under their own "MOTHERS" group header. Uses two
  // dedicated fields (childMale/childFemale) rather than the shared
  // DEMOGRAPHIC_FIELDS' male/female/child keys, so this never mixes into
  // other wards' adult counts or the "All Wards" grand totals.
  import { SHIFTS } from "$lib/helpers/nursesReportCommon.js";

  let { wardDoc, editable, onField } = $props();

  function getVal(shiftKey, key) {
    const v = (wardDoc.shifts[shiftKey] || {})[key];
    return typeof v === "number" ? v : 0;
  }
  function totalFor(key) {
    return SHIFTS.reduce((sum, s) => sum + getVal(s.key, key), 0);
  }
</script>

<table class="shift">
  <thead>
    <tr>
      <th rowspan="2">Shift</th>
      <th colspan="2">COT</th>
      <th colspan="2">MOTHERS</th>
    </tr>
    <tr><th>Male</th><th>Female</th><th>Soldiers</th><th>Civilians</th></tr>
  </thead>
  <tbody>
    {#each SHIFTS as s (s.key)}
      <tr>
        <td class="shift-name">{s.label}</td>
        <td>
          <input type="number" inputmode="numeric" disabled={!editable}
            value={getVal(s.key, "childMale")} onchange={(e) => onField(s.key, "childMale", e.target.value)} />
        </td>
        <td>
          <input type="number" inputmode="numeric" disabled={!editable}
            value={getVal(s.key, "childFemale")} onchange={(e) => onField(s.key, "childFemale", e.target.value)} />
        </td>
        <td>
          <input type="number" inputmode="numeric" disabled={!editable}
            value={getVal(s.key, "soldier")} onchange={(e) => onField(s.key, "soldier", e.target.value)} />
        </td>
        <td>
          <input type="number" inputmode="numeric" disabled={!editable}
            value={getVal(s.key, "civilian")} onchange={(e) => onField(s.key, "civilian", e.target.value)} />
        </td>
      </tr>
    {/each}
    <tr class="total-row">
      <td class="shift-name">Total</td>
      <td>{totalFor("childMale")}</td>
      <td>{totalFor("childFemale")}</td>
      <td>{totalFor("soldier")}</td>
      <td>{totalFor("civilian")}</td>
    </tr>
  </tbody>
</table>
