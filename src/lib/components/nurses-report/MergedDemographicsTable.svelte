<script>
  // Ported from MergedDemographicsTable() in src/pages/nurses-report/WardNurse.jsx.
  // One shared, editable Patient Demographics table for a mergedTable
  // group with demographicsVariant: 'merged' (currently just PAED WARD) —
  // same Morning/Night/Total row shape as MergedShiftTable, but for the
  // shared DEMOGRAPHIC_FIELDS columns minus Children (every Paed patient
  // is already a child, so a separate subcount is redundant) — just
  // Male/Female/Soldiers/Civilians.
  import { SHIFTS, DEMOGRAPHIC_FIELDS } from "$lib/helpers/nursesReportCommon.js";

  let { panels } = $props();

  const fields = DEMOGRAPHIC_FIELDS.filter((f) => f.key !== "child");
  function getVal(p, shiftKey, key) {
    const v = (p.wardDoc.shifts[shiftKey] || {})[key];
    return typeof v === "number" ? v : 0;
  }
  const totals = $derived.by(() => {
    const out = {};
    fields.forEach((f) => {
      out[f.key] = panels.reduce((sum, p) => sum + SHIFTS.reduce((s, sh) => s + getVal(p, sh.key, f.key), 0), 0);
    });
    return out;
  });
  const colSpanAll = 1 + fields.length;
</script>

<table class="shift">
  <thead>
    <tr>
      <th>Shift</th>
      {#each fields as f (f.key)}<th>{f.label}</th>{/each}
    </tr>
  </thead>
  <tbody>
    {#each SHIFTS as s (s.key)}
      <tr class="shift-section-row"><td colspan={colSpanAll}>{s.label === "Am" ? "Morning" : "Night"}</td></tr>
      {#each panels as p (p.w.key)}
        <tr>
          <td class="shift-name">{p.w.label}</td>
          {#each fields as f (f.key)}
            <td>
              <input type="number" inputmode="numeric" disabled={!p.editable}
                value={getVal(p, s.key, f.key)} onchange={(e) => p.onField(s.key, f.key, e.target.value)} />
            </td>
          {/each}
        </tr>
      {/each}
    {/each}
    <tr class="total-row">
      <td class="shift-name">Total</td>
      {#each fields as f (f.key)}<td>{totals[f.key]}</td>{/each}
    </tr>
  </tbody>
</table>
