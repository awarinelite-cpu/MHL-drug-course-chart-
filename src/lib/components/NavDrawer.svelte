<script>
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { navState } from "$lib/stores/nav.svelte.js";
  import { authState } from "$lib/stores/auth.svelte.js";

  // Falls back to the currently selected patient (stored by Home in
  // sessionStorage) so the Overview link still works from the home page,
  // where the selection lives in session storage rather than the URL.
  function getActivePatientId() {
    return page.url.searchParams.get("patient") || sessionStorage.getItem("selectedPatientId");
  }

  let patientId = $derived(getActivePatientId());
  let overviewHref = $derived(patientId ? "/charts/overview?patient=" + encodeURIComponent(patientId) : null);

  function go(path) {
    navState.closeDrawer();
    goto(path);
  }

  async function handleLogout() {
    navState.closeDrawer();
    await authState.logout();
    goto("/login");
  }

  function handleSearch() {
    navState.closeDrawer();
    if (window.location.pathname === "/") {
      const input = document.getElementById("searchInput");
      if (input) { input.scrollIntoView({ behavior: "smooth", block: "center" }); input.focus(); }
    } else {
      goto("/#search");
    }
  }
</script>

<div class={"gnav-overlay no-print" + (navState.open ? " gnav-open" : "")} onclick={navState.closeDrawer}></div>
<div class={"gnav-drawer no-print" + (navState.open ? " gnav-open" : "")}>
  <div class="gnav-drawer-head">
    <span>MILITARY HOSPITAL LAGOS Ward Charts</span>
    <button class="gnav-drawer-close" aria-label="Close menu" onclick={navState.closeDrawer}>&times;</button>
  </div>
  <div class="gnav-who">{authState.profile ? authState.profile.name + " (" + authState.profile.role + ")" : ""}</div>
  <div class="gnav-drawer-body">
    <button class="gnav-link" onclick={() => go("/")}><span class="gnav-icon">&#127968;</span>Home</button>
    <button class="gnav-link" onclick={handleSearch}><span class="gnav-icon">&#128269;</span>Search</button>
    <button
      class={"gnav-link" + (overviewHref ? "" : " gnav-disabled")}
      onclick={() => overviewHref && go(overviewHref)}
    >
      <span class="gnav-icon">&#128203;</span>Overview
    </button>
    <button class="gnav-link" onclick={() => go("/profile")}><span class="gnav-icon">&#128100;</span>My Profile</button>
    <button class="gnav-link" onclick={() => go("/my-patients")}><span class="gnav-icon">&#128101;</span>My Patients</button>
    <button class="gnav-link" onclick={() => go("/nurses-report/role-select")}><span class="gnav-icon">&#128203;</span>Nurses Report</button>
    <button class="gnav-link" onclick={() => go(patientId ? "/charts/calculators?patient=" + encodeURIComponent(patientId) : "/charts/calculators")}><span class="gnav-icon">&#129518;</span>Calculators</button>
    <button class="gnav-link" onclick={() => go("/charts/lab-reference")}><span class="gnav-icon">&#128300;</span>Lab Reference</button>
    {#if authState.profile?.role === "admin"}
      <button class="gnav-link" onclick={() => go("/admin")}><span class="gnav-icon">&#9881;&#65039;</span>Admin</button>
    {/if}
  </div>
  <div class="gnav-drawer-foot">
    <button class="gnav-link" onclick={handleLogout}><span class="gnav-icon">&#128682;</span>Log Out</button>
  </div>
</div>
