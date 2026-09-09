<script>
  import "../lib/styles.css";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { themeState } from "$lib/stores/theme.svelte.js";
  import NavDrawer from "$lib/components/NavDrawer.svelte";

  let { children } = $props();

  const isLoginRoute = $derived(page.url.pathname === "/login");

  // Ported from RequireAuth.jsx. A cold-started window — e.g. tapping a
  // drug-due notification, which opens a fresh window/tab straight at a
  // deep chart URL instead of "/" — has to wait for Firebase Auth to
  // rehydrate its persisted session from IndexedDB before onAuthStateChanged
  // fires even once. That's normally near-instant, but on the ward's wifi
  // (or a slow first cold-start of the service worker) it can stall.
  // STUCK_MS gives a visible "still working on it" + manual reload instead
  // of stalling forever on a blank page.
  const STUCK_MS = 8000;
  let stuck = $state(false);
  let stuckTimer;

  $effect(() => {
    // touch theme so it's applied even before auth resolves
    void themeState.theme;
  });

  $effect(() => {
    if (authState.status !== "loading") { stuck = false; clearTimeout(stuckTimer); return; }
    stuckTimer = setTimeout(() => { stuck = true; }, STUCK_MS);
    return () => clearTimeout(stuckTimer);
  });

  $effect(() => {
    if (!isLoginRoute && authState.status === "signed-out") {
      goto("/login", { replaceState: true });
    }
  });
</script>

<svelte:head>
  <title>68 NARHY Ward Charts</title>
</svelte:head>

{#if isLoginRoute}
  {@render children?.()}
{:else if authState.status === "loading"}
  <div class="container" style="max-width:480px;margin-top:60px;">
    <div class="card-box">
      <div class="loading-note">Loading…</div>
      {#if stuck}
        <div class="loading-note" style="margin-top:8px;">
          Still working on it — this is taking longer than usual.
        </div>
        <button class="btn btn-primary" style="margin-top:12px;" onclick={() => window.location.reload()}>
          Reload
        </button>
      {/if}
    </div>
  </div>
{:else if authState.status === "signed-out"}
  <!-- goto("/login") above is in flight; render nothing in the meantime -->
{:else if authState.status === "error"}
  <div class="container" style="max-width:480px;margin-top:60px;">
    <div class="card-box">
      <div class="error-msg">{authState.error}</div>
    </div>
  </div>
{:else}
  <NavDrawer />
  {@render children?.()}
{/if}
