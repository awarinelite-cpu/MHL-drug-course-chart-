<script>
  // Ported from src/pages/MyPatients.jsx. useGoBack becomes a plain
  // goBack() that steps through real browser history, falling back to a
  // given path only when there's nowhere to go back to.
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { collection, getDocs, query, where, deleteDoc, doc } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import Topbar from "$lib/components/Topbar.svelte";

  function fmtWhen(ts, shift) {
    if (!ts || typeof ts.toDate !== "function") return shift || "";
    const d = ts.toDate();
    const dateStr = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const timeStr = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return dateStr + ", " + timeStr + (shift ? " · " + shift + " shift" : "");
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  let status = $state("loading"); // 'loading' | 'ready' | error string
  let allocations = $state([]);

  onMount(() => {
    if (authState.user) loadAllocations();
  });

  $effect(() => {
    if (authState.user) loadAllocations();
  });

  async function loadAllocations() {
    status = "loading";
    let docs = [];
    try {
      // A single equality filter (no orderBy alongside it) avoids needing a
      // composite Firestore index — sorted client-side instead.
      const snap = await getDocs(query(collection(db, "allocations"), where("uid", "==", authState.user.uid)));
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
    } catch (e) {
      status = "Couldn't load: " + (e.code || e.message || "unknown error");
      return;
    }
    // Most recently allocated first — matches "what did I just pick up"
    // better than alphabetical for a start-of-shift review.
    docs.sort((a, b) => {
      const at = a.allocatedAt && a.allocatedAt.toMillis ? a.allocatedAt.toMillis() : 0;
      const bt = b.allocatedAt && b.allocatedAt.toMillis ? b.allocatedAt.toMillis() : 0;
      return bt - at;
    });
    allocations = docs;
    status = "ready";
  }

  function openPatient(patientId) {
    goto("/patient?patient=" + patientId);
  }

  async function removeAllocation(allocationId, ev) {
    ev.stopPropagation();
    try {
      await deleteDoc(doc(db, "allocations", allocationId));
      allocations = allocations.filter(a => a.id !== allocationId);
    } catch (e) {
      alert("Couldn't remove: " + (e.code || e.message || "unknown error"));
    }
  }
</script>

<Topbar brand="My Patients">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
</Topbar>

<div class="container">
  <div class="card-box">
    <h2 style="margin-top:0;">My Allocated Patients</h2>
    <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">
      Patients you've allocated to yourself from the Search page. Tap a patient to open their chart, or remove them once you're done.
    </div>

    {#if status === "loading"}
      <div class="loading-note">Loading…</div>
    {/if}
    {#if typeof status === "string" && status !== "loading" && status !== "ready"}
      <div class="loading-note">{status}</div>
    {/if}

    {#if status === "ready" && allocations.length === 0}
      <div class="empty-note">
        No patients allocated yet. Search for a patient and tap "Allocate to Me" on their profile.
      </div>
    {/if}

    {#if status === "ready"}
      {#each allocations as a (a.id)}
        <div class="alloc-item" onclick={() => openPatient(a.patientId)}>
          <div class="alloc-main">
            <div class="alloc-name">{a.patientName || "Unnamed"}</div>
            <div class="alloc-meta">
              EMR: {a.patientEmr || "N/A"}
              {a.patientWard ? "  ·  Ward: " + a.patientWard : ""}
              {a.patientDiagnosis ? "  ·  " + a.patientDiagnosis : ""}
            </div>
            <div class="alloc-when">Allocated {fmtWhen(a.allocatedAt, a.shift)}</div>
          </div>
          <button class="alloc-remove" title="Remove from my list" onclick={(ev) => removeAllocation(a.id, ev)}>Remove</button>
        </div>
      {/each}
    {/if}
  </div>
</div>
