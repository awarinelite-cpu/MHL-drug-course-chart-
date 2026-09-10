<script>
  // Ported from DemographicsTable() in src/pages/nurses-report/WardNurse.jsx.
  import { SHIFTS, DEMOGRAPHIC_FIELDS } from "$lib/helpers/nursesReportCommon.js";

  let { wardDoc, totals, editable, onField } = $props();
</script>

<table class="shift">
  <thead>
    <tr>
      <th>Shift</th>
      {#each DEMOGRAPHIC_FIELDS as f (f.key)}<th>{f.label}</th>{/each}
    </tr>
  </thead>
  <tbody>
    {#each SHIFTS as s (s.key)}
      <tr>
        <td class="shift-name">{s.label}</td>
        {#each DEMOGRAPHIC_FIELDS as f (f.key)}
          <td>
            <input type="number" inputmode="numeric" disabled={!editable}
              value={wardDoc.shifts[s.key][f.key]} onchange={(e) => onField(s.key, f.key, e.target.value)} />
          </td>
        {/each}
      </tr>
    {/each}
    <tr class="total-row">
      <td class="shift-name">Total</td>
      {#each DEMOGRAPHIC_FIELDS as f (f.key)}<td>{totals[f.key]}</td>{/each}
    </tr>
  </tbody>
</table>
