<script>
  // Ported from src/pages/Patient.jsx. usePatientHeader/useGoBack/useBackLock
  // are inlined here (as $effect/onMount) rather than extracted into
  // reusable hooks, matching the convention already used by the Home and
  // Drug Course Chart pages in this rebuild.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { doc, getDoc, setDoc, deleteDoc, updateDoc, serverTimestamp } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { getDocSafe } from "$lib/helpers/firestoreOffline.js";
  import { applyPatientStatus } from "$lib/helpers/patientAdmissionStatus.js";
  import { STATUS_LABELS, WARD_OPTIONS } from "$lib/helpers/drugChartHelpers.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import PatientBanner from "$lib/components/PatientBanner.svelte";
  import PatientForm from "$lib/components/PatientForm.svelte";

  const SELECTED_PATIENT_KEY = "selectedPatientId";

  const patientId = $derived(page.url.searchParams.get("patient"));

  // --- Patient header load (ported from usePatientHeader.js) ---
  let patient = $state(null);
  let loading = $state(true);
  let patientError = $state(null);

  $effect(() => {
    if (!patientId) { goto("/"); return; }
    loading = true;
    patientError = null;
    getDocSafe(doc(db, "patients_mhl", patientId)).then((snap) => {
      if (!snap.exists()) { goto("/"); return; }
      patient = { id: snap.id, ...snap.data() };
      loading = false;
    }).catch((e) => {
      patientError = "Couldn't load patient: " + (e.code || e.message || "unknown error");
      loading = false;
    });
  });

  // Kept in sync so NavDrawer's Overview/Calculators shortcuts still work
  // from pages (like Profile) that don't carry ?patient= in their own URL.
  $effect(() => {
    if (patientId) sessionStorage.setItem(SELECTED_PATIENT_KEY, patientId);
  });

  // Device/OS Back always returns Home (ported from useBackLock.js)
  onMount(() => {
    try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    const onPopState = () => goto("/", { replaceState: true });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  let showEditForm = $state(false);
  let editForm = $state(null);
  let editMsg = $state("");

  let allocatedToMe = $state(false);
  let allocBusy = $state(false);

  let chartDiagnosis = $state("");

  let showStatusForm = $state(false);
  let statusAction = $state("");
  let transferWard = $state("");
  let statusApplying = $state(false);
  let statusMsg = $state({ color: "", text: "" });

  function allocationDocRef() {
    return doc(db, "allocations_mhl", "alloc_" + authState.user.uid + "_" + patientId);
  }

  // Africa/Lagos (WAT) is UTC+1 with no DST, so shifting the UTC clock by
  // 1hr gives WAT wall-clock hours via the UTC getters. Morning 8:00–16:59,
  // Night 17:00–7:59.
  function currentShiftLabel() {
    const watHour = new Date(Date.now() + 60 * 60 * 1000).getUTCHours();
    return (watHour >= 8 && watHour < 17) ? "Morning" : "Night";
  }

  $effect(() => {
    if (!patient || !authState.user) { allocatedToMe = false; return; }
    let cancelled = false;
    getDoc(allocationDocRef()).then((snap) => {
      if (!cancelled) allocatedToMe = snap.exists();
    }).catch(() => {
      // Can't confirm current state (offline, etc.) — leave the button
      // usable rather than stuck disabled; toggleAllocation() re-derives
      // the actual state from its own write attempt either way.
      if (!cancelled) allocatedToMe = false;
    });
    return () => { cancelled = true; };
  });

  $effect(() => {
    if (!patientId) { chartDiagnosis = ""; return; }
    let cancelled = false;
    getDocSafe(doc(db, "patients_mhl", patientId, "drugCourseChart", "main")).then((snap) => {
      if (!cancelled && snap.exists()) chartDiagnosis = snap.data().f_diagnosis || "";
    }).catch(() => {
      // No connection and nothing cached — fall back to the patient
      // record's own diagnosis field further down.
    });
    return () => { cancelled = true; };
  });

  async function toggleAllocation() {
    if (!patient || !authState.user) return;
    allocBusy = true;
    const ref = allocationDocRef();
    // Not awaited — with offline persistence the write queues locally and
    // syncs automatically, but the Promise itself won't resolve until back
    // online, which would leave the Allocate button stuck disabled
    // indefinitely while offline.
    if (allocatedToMe) {
      deleteDoc(ref).catch((e) => console.warn("Allocation removal queued locally; will retry once back online:", e));
      allocatedToMe = false;
    } else {
      setDoc(ref, {
        uid: authState.user.uid,
        nurseName: authState.profile?.name || "",
        patientId: patient.id,
        patientName: patient.name || "Unnamed",
        patientEmr: patient.emr || "",
        patientWard: patient.ward || "",
        patientDiagnosis: patient.diagnosis || "",
        shift: currentShiftLabel(),
        allocatedAt: serverTimestamp()
      }).catch((e) => console.warn("Allocation queued locally; will retry once back online:", e));
      allocatedToMe = true;
    }
    allocBusy = false;
  }

  function openEditPatient() {
    if (!patient) return;
    editForm = {
      name: patient.name || "", emr: patient.emr || "",
      diagnosis: patient.diagnosis || "", ward: patient.ward || "",
      pedBedType: patient.pedBedType || "",
      age: patient.age || "", hospNo: patient.hospNo || "",
      admissionDate: patient.admissionDate || "", allergies: patient.allergies || "",
      insurance: patient.insurance || ""
    };
    editMsg = "";
    showEditForm = true;
  }

  async function saveEditPatient() {
    if (!patient) return;
    const name = editForm.name.trim();
    const emr = editForm.emr.trim();
    editMsg = "";
    if (!name || !emr) { editMsg = "Name and EMR number are required."; return; }
    const updates = {
      name, emr,
      diagnosis: editForm.diagnosis.trim(), ward: editForm.ward.trim(),
      pedBedType: editForm.ward.trim() === "PEDIATRIC/NICU WARD" ? (editForm.pedBedType || "") : "",
      age: editForm.age.trim(),
      hospNo: editForm.hospNo.trim(), admissionDate: editForm.admissionDate.trim(), allergies: editForm.allergies.trim(),
      insurance: editForm.insurance.trim(),
      updatedAt: serverTimestamp()
    };
    // Not awaited — same offline-hang reason as toggleAllocation above.
    updateDoc(doc(db, "patients_mhl", patient.id), updates).catch((e) => {
      console.warn("Patient edit queued locally; will retry once back online:", e);
    });
    patient = { ...patient, ...updates };
    showEditForm = false;
  }

  async function applyStatus() {
    if (!patient) return;
    const reason = statusAction;
    if (!reason) { statusMsg = { color: "#dc2626", text: "Please select an action first." }; return; }
    if (reason === "transferred" && !transferWard) {
      statusMsg = { color: "#dc2626", text: "Please select which ward the patient is being transferred to." };
      return;
    }

    // Same as the Drug Course Chart's own Patient Status control: discharging
    // or referring reads across five collections and then deletes the live
    // entries once archived, so those two are blocked until back online
    // rather than made offline-tolerant like the rest of this page's edits.
    // Transferring wards no longer touches any of that — it's just a single
    // pendingTransfer write — so it doesn't need this gate.
    if (reason !== "transferred" && !navigator.onLine) {
      statusMsg = { color: "#dc2626", text: "This needs an internet connection — referring or discharging archives records from several charts at once and then clears them, and doing that safely requires reading the real data rather than whatever's cached locally. Please try again once online." };
      return;
    }

    const label = reason === "transferred" ? ("Transferred to " + transferWard) : STATUS_LABELS[reason];
    const confirmBody = reason === "transferred"
      ? "The patient moves to " + transferWard + "\u2019s New Patient queue \u2014 a nurse there still has to accept them before they show up on that ward\u2019s patient list. Their drug chart, vitals, glycemic chart, intake & output, and seizure chart all stay exactly as they are; care just continues on the new ward."
      : "All care records for this admission (drug chart, vitals, glycemic chart, intake & output, seizure chart) will be saved together to Overview, and fresh charts will open for this patient.";
    if (!confirm("Confirm: " + label + "?\n\n" + confirmBody)) return;

    statusApplying = true;
    statusMsg = { color: "#555", text: reason === "transferred" ? "Sending transfer…" : "Saving all charts for this admission…" };

    const result = await applyPatientStatus({ patientId: patient.id, reason, transferWard, fromWard: patient.ward, transferredByName: authState.profile?.name });
    if (!result.ok) {
      statusMsg = { color: "#dc2626", text: result.message };
      statusApplying = false;
      return;
    }

    statusMsg = {
      color: "#16a34a",
      text: reason === "transferred"
        ? "Sent to " + transferWard + " \u2014 awaiting acceptance there. Redirecting…"
        : "Saved to Overview. Redirecting…"
    };
    setTimeout(() => goto("/"), 900);
  }

  function openChart(chartName) {
    if (!patient) return;
    goto("/charts/" + chartName + "?patient=" + patient.id + "&from=patient");
  }

  function openOverview() {
    if (!patient) return;
    goto("/charts/overview?patient=" + patient.id);
  }
</script>

<Topbar brand="Patient">
  <button class="btn btn-secondary" style="padding: 6px 12px;" onclick={goBack}>Back</button>
</Topbar>

<div class="container">
  {#if loading}<div class="card-box">Loading patient…</div>{/if}
  {#if patientError}<div class="card-box error-msg">{patientError}</div>{/if}

  {#if patient}
    <div class="card-box">
      <PatientBanner
        patient={{ ...patient, diagnosis: chartDiagnosis || patient.diagnosis }}
        ward={patient.ward}
      >
        {#snippet extra()}
          <button class="btn btn-secondary edit-patient-btn" title="Edit patient information" onclick={openEditPatient}>✎</button>
          <button class={"btn " + (allocatedToMe ? "btn-success" : "btn-secondary")}
            style="padding: 4px 10px; font-size: 12px; margin-left: 6px; white-space: normal; line-height: 1.25; text-align: center;"
            disabled={allocBusy} onclick={toggleAllocation}>
            {#if allocBusy}…{:else if allocatedToMe}✓ Allocated<br /><span style="font-size: 10px; font-weight: 400;">tap to remove</span>{:else}Allocate to Me{/if}
          </button>
          <button class="btn btn-purple" style="padding: 4px 10px; font-size: 12px; margin-left: 6px;" onclick={openOverview}>Overview</button>
          <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px; margin-left: 6px;" onclick={() => showStatusForm = !showStatusForm}>Status</button>
        {/snippet}
      </PatientBanner>

      {#if showStatusForm}
        <div class="card-box" style="margin-top: 12px; box-shadow: none; border: 1px solid #e5e7eb;">
          <label style="font-weight: bold; font-size: 13px; display: block; margin-bottom: 6px;">Patient Status</label>
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <select style="width: auto; min-width: 220px;" bind:value={statusAction}>
              <option value="">Select action…</option>
              <option value="discharged">{STATUS_LABELS.discharged}</option>
              <option value="transferred">{STATUS_LABELS.transferred}</option>
              <option value="referred">{STATUS_LABELS.referred}</option>
            </select>
            {#if statusAction === "transferred"}
              <select style="width: auto; min-width: 220px;" bind:value={transferWard}>
                <option value="">Select ward…</option>
                {#each WARD_OPTIONS as w}<option value={w}>{w}</option>{/each}
              </select>
            {/if}
            <button class="btn btn-primary" style="padding: 8px 14px; font-size: 13px;" disabled={statusApplying} onclick={applyStatus}>Apply</button>
          </div>
          {#if statusMsg.text}<div style="font-size: 12px; margin-top: 8px; color: {statusMsg.color};">{statusMsg.text}</div>{/if}
        </div>
      {/if}

      {#if showEditForm && editForm}
        <div class="card-box" style="margin-top: 12px; box-shadow: none; border: 1px solid #e5e7eb;">
          <h3 style="margin-top: 0;">Edit Patient Information</h3>
          <PatientForm bind:form={editForm} />
          <button class="btn btn-primary" onclick={saveEditPatient}>Save Changes</button>
          <button class="btn btn-secondary" onclick={() => showEditForm = false}>Cancel</button>
          {#if editMsg}<div class="error-msg">{editMsg}</div>{/if}
        </div>
      {/if}

      <div class="chart-grid">
        <div class="chart-card" onclick={() => openChart("drug-course-chart")}><span class="icon">💊</span>Drug Course Chart</div>
        <div class="chart-card" onclick={() => openChart("vitals")}><span class="icon">❤️</span>Vital Signs</div>
        <div class="chart-card" onclick={() => openChart("intake-output")}><span class="icon">💧</span>Intake &amp; Output</div>
        <div class="chart-card" onclick={() => openChart("blood-glucose")}><span class="icon">🩸</span>Blood Glucose</div>
        <div class="chart-card" onclick={() => openChart("seizure")}><span class="icon">⚡</span>Seizure Chart</div>
      </div>
    </div>
  {/if}
</div>
