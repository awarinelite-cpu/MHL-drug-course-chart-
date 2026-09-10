<script>
  // Ported from VitalsChipRow() in src/pages/nurses-report/WardNurse.jsx.
  // The row of tappable vitals shown under Diagnosis/Notes once a "VITAL
  // SIGNS:" trigger has pulled a reading in. Tapping one turns it into a
  // small inline input; committing it (blur or Enter) regenerates the
  // note's vitals line in place via onChange.
  import { VITALS_CHIPS } from "$lib/helpers/useWardReport.svelte.js";

  let { snapshot, onChange } = $props();

  let editingKey = $state(null);
  let draft = $state("");

  function startEdit(key) {
    editingKey = key;
    draft = snapshot[key] || "";
  }
  function commit(key) {
    onChange(key, draft.trim());
    editingKey = null;
  }
</script>

<div class="vitals-chip-row" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
  {#each VITALS_CHIPS as c (c.key)}
    {#if editingKey === c.key}
      <span class="vitals-chip vitals-chip-editing"
        style="display:inline-flex;align-items:center;gap:4px;background:#eef2ff;border:1px solid #6366f1;border-radius:999px;padding:3px 8px;font-size:13px;">
        {c.label}-
        <input autofocus type="text" bind:value={draft} style="width:54px;border:none;background:transparent;font:inherit;outline:none;"
          onblur={() => commit(c.key)}
          onkeydown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(c.key); }
            if (e.key === "Escape") editingKey = null;
          }} />
        {c.suffix}
      </span>
    {:else}
      <button type="button" class="vitals-chip" title="Tap to edit"
        style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:999px;padding:3px 10px;font-size:13px;color:#3730a3;cursor:pointer;"
        onclick={() => startEdit(c.key)}>
        {c.label}-{snapshot[c.key] || "\u2014"}{c.suffix}
      </button>
    {/if}
  {/each}
</div>
