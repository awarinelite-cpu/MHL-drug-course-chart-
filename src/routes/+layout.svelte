<script>
  import { onMount } from "svelte";
  import "../lib/styles.css";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { themeState } from "$lib/stores/theme.svelte.js";
  import NavDrawer from "$lib/components/NavDrawer.svelte";
  import { initForegroundAlertsIfEnabled } from "$lib/helpers/push.js";

  let { children } = $props();

  // Ported from useServiceWorker.js + useForegroundAlerts.js — both ran
  // once for the whole app in React's App.jsx, so both live here in the
  // root layout rather than on any one page. A page load with no foreground
  // listener registered means an FCM push that arrives while this tab is
  // open and focused has nothing to catch it (see $lib/helpers/push.js) —
  // background alerts still work via static/sw.js regardless.
  onMount(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Non-fatal — the app still works online, it just won't have an offline app shell.
      });
    }
    initForegroundAlertsIfEnabled().catch(() => {});

    // Ported from useHardwareBackButton.js — ran once for the whole app in
    // React's App.jsx, so it lives here in the root layout too. Capacitor's
    // native Android back button, left unhandled, falls straight through to
    // the OS default (finish the activity) instead of stepping back through
    // the WebView's history — it depends on how many history entries are
    // stacked at that moment, not on the page's own back logic. Every page
    // already drives its own back behavior off popstate (see the per-page
    // __backGuard listeners, e.g. +page.svelte's exit-on-double-back), so the
    // fix is to make the hardware button always issue a plain history.back()
    // and let those existing handlers decide what happens.
    //
    // @capacitor/app resolves to a real module once the app is wrapped with
    // Capacitor (see /android); a bare `import("@capacitor/app")` would fail
    // the Vite build outside that context, so this is a dynamic import behind
    // a try/catch, exactly like the original.
    let backButtonHandle;
    let cancelled = false;
    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const h = await App.addListener("backButton", () => {
          window.history.back();
        });
        if (cancelled) h.remove();
        else backButtonHandle = h;
      } catch (e) {
        // Not running under Capacitor (e.g. plain browser/preview) — nothing to wire up.
      }
    })();
    return () => {
      cancelled = true;
      if (backButtonHandle) backButtonHandle.remove();
    };
  });

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
