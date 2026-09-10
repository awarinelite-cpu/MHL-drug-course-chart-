<script>
  // Ported from src/pages/nurses-report/RoleSelect.jsx.
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { doc, setDoc, serverTimestamp } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { getDocSafe } from "$lib/helpers/firestoreOffline.js";
  import { weekId } from "$lib/helpers/nursesReportCommon.js";
  import Topbar from "$lib/components/Topbar.svelte";

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  const wk = weekId();
  const roleRef = doc(db, "nurseReportRoles_mhl", wk);

  let status = $state({ text: "Checking…", className: "status" });

  async function refreshStatus() {
    let snap;
    try {
      snap = await getDocSafe(roleRef);
    } catch (e) {
      status = { text: "Couldn't check current status.", className: "status" };
      return null;
    }
    const data = snap.exists() ? snap.data() : null;
    const overall = data && data.overallNurse;
    if (!overall) {
      status = { text: "Unassigned this week — tap to take the role.", className: "status status-open" };
    } else if (authState.user && overall.uid === authState.user.uid) {
      status = { text: "You're the Overall Nurse this week.", className: "status status-you" };
    } else {
      status = { text: (overall.name || "Another nurse") + " is the Overall Nurse this week.", className: "status status-taken" };
    }
    return overall;
  }

  $effect(() => { if (authState.user) refreshStatus(); });

  async function assumeOverall() {
    if (!authState.user) return;
    const overall = await refreshStatus();
    if (overall && overall.uid !== authState.user.uid) {
      const ok = confirm((overall.name || "Another nurse") + " is currently the Overall Nurse for this week. Take over this role?");
      if (!ok) return;
    }
    try {
      await setDoc(roleRef, {
        weekId: wk,
        overallNurse: { uid: authState.user.uid, name: authState.profile.name || "Unknown", assignedAt: serverTimestamp() }
      }, { merge: true });
    } catch (e) {
      alert("Couldn't assign the role: " + (e.code || e.message || "unknown error"));
      return;
    }
    goto("/nurses-report/overall-nurse");
  }
</script>

<Topbar brand="Nurses Report">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
</Topbar>
<div class="container">
  <p style="font-size:13px;color:#555;">Choose your role for this shift. The Overall Nurse role runs for the whole week.</p>
  <div class="role-grid">
    <button class="role-card" onclick={assumeOverall}>
      <span class="icon">🗂️</span>
      <span class="title">ASSUME OVERALL</span>
      <span class="desc">Become the Overall Nurse for this week — monitor and manage every ward's 24-hour report.</span>
      <div class={status.className}>{status.text}</div>
    </button>
    <button class="role-card" onclick={() => goto("/nurses-report/ward-nurse")}>
      <span class="icon">🏥</span>
      <span class="title">WARD NURSE</span>
      <span class="desc">Submit and manage your own ward's 24-hour report.</span>
    </button>
    <button class="role-card" onclick={() => goto("/nurses-report/analytics")}>
      <span class="icon">📈</span>
      <span class="title">ANALYTICS</span>
      <span class="desc">Charts and trends across every ward — Today, This Week, This Month, or This Year.</span>
    </button>
  </div>
</div>
