<script>
  // Ported from src/components/PatientForm.jsx. React's controlled
  // `form`/`setForm` pair becomes a single $bindable object prop — the
  // parent does `<PatientForm bind:form={newForm} />` and edits here flow
  // straight back, same shape as before ({ ...form, [key]: value }).
  import { WARD_OPTIONS, PED_BED_TYPES } from "$lib/helpers/drugChartHelpers.js";

  let { form = $bindable() } = $props();

  function setWard(e) {
    const ward = e.target.value;
    form = { ...form, ward, pedBedType: ward === "PEDIATRIC/NICU WARD" ? form.pedBedType : "" };
  }
</script>

<div class="field"><label for="pf_name">Name</label><input id="pf_name" type="text" value={form.name} oninput={(e) => form = { ...form, name: e.target.value }} /></div>
<div class="field"><label for="pf_emr">EMR Number</label><input id="pf_emr" type="text" value={form.emr} oninput={(e) => form = { ...form, emr: e.target.value }} /></div>
<div class="field"><label for="pf_diagnosis">Diagnosis</label><input id="pf_diagnosis" type="text" value={form.diagnosis} oninput={(e) => form = { ...form, diagnosis: e.target.value }} /></div>
<div class="field">
  <label for="pf_ward">Ward</label>
  <select id="pf_ward" value={form.ward} onchange={setWard}>
    <option value="">Select ward…</option>
    {#each WARD_OPTIONS as w}<option value={w}>{w}</option>{/each}
  </select>
</div>
{#if form.ward === "PEDIATRIC/NICU WARD"}
  <div class="field">
    <label for="pf_bedtype">Bed / Cot</label>
    <select id="pf_bedtype" value={form.pedBedType || ""} onchange={(e) => form = { ...form, pedBedType: e.target.value }}>
      <option value="">Select…</option>
      {#each PED_BED_TYPES as t}<option value={t}>{t}</option>{/each}
    </select>
  </div>
{/if}
<div class="field"><label for="pf_age">Age</label><input id="pf_age" type="text" value={form.age} oninput={(e) => form = { ...form, age: e.target.value }} /></div>
<div class="field"><label for="pf_hospno">Hospital No</label><input id="pf_hospno" type="text" value={form.hospNo} oninput={(e) => form = { ...form, hospNo: e.target.value }} /></div>
<div class="field"><label for="pf_admdate">Date of Admission</label><input id="pf_admdate" type="date" value={form.admissionDate} oninput={(e) => form = { ...form, admissionDate: e.target.value }} /></div>
<div class="field"><label for="pf_allergies">Allergies</label><input id="pf_allergies" type="text" placeholder="None known / list allergies" value={form.allergies} oninput={(e) => form = { ...form, allergies: e.target.value }} /></div>
<div class="field"><label for="pf_insurance">Insurance</label><input id="pf_insurance" type="text" placeholder="e.g. NHIS, Private, HMO name" value={form.insurance || ""} oninput={(e) => form = { ...form, insurance: e.target.value }} /></div>
