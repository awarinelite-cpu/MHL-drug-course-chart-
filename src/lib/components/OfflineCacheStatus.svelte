<script>
  // Ported from src/components/OfflineCacheStatus.jsx (React).
  import { onMount } from "svelte";

  const STORAGE_KEY = "narhy-cache-status";

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function saveStored(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* private mode etc */ }
  }

  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator;

  // phase: 'unsupported' | 'checking' | 'caching' | 'ready' | 'error'
  let phase = $state(supported ? (loadStored()?.phase === "ready" ? "ready" : "checking") : "unsupported");
  let progress = $state({ cached: 0, total: 0 });
  let expanded = $state(true);
  let readyAt = $state(loadStored()?.readyAt || null);
  let collapseTimer;

  onMount(() => {
    if (!("serviceWorker" in navigator)) return;

    function handleMessage(event) {
      const msg = event.data;
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "PRECACHE_PROGRESS") {
        phase = "caching";
        progress = { cached: msg.cached, total: msg.total };
      } else if (msg.type === "PRECACHE_DONE") {
        const ok = msg.failed === 0 || msg.cached > 0;
        phase = ok ? "ready" : "error";
        progress = { cached: msg.cached, total: msg.total };
        if (ok) {
          const now = Date.now();
          readyAt = now;
          saveStored({ phase: "ready", readyAt: now });
        }
      } else if (msg.type === "PRECACHE_STATUS") {
        if (msg.ready) {
          const now = Date.now();
          phase = "ready";
          readyAt = readyAt || now;
          saveStored({ phase: "ready", readyAt: now });
        } else {
          // Worker exists but hasn't finished this version's cache yet —
          // an install is presumably already in flight; PRECACHE_PROGRESS
          // messages will arrive shortly and override this.
          phase = phase === "caching" ? phase : "checking";
        }
      }
    }

    navigator.serviceWorker.addEventListener("message", handleMessage);

    // Ask whatever worker is already controlling this tab for its status —
    // covers the common case of reopening the app in a later session, when
    // no fresh 'install' event (and therefore no PRECACHE_PROGRESS) fires.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "CHECK_CACHE_STATUS" });
    } else {
      navigator.serviceWorker.ready
        .then((reg) => reg.active && reg.active.postMessage({ type: "CHECK_CACHE_STATUS" }))
        .catch(() => {});
    }

    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
  });

  // Auto-collapse to a small dot a few seconds after settling into 'ready'
  // or 'error' — stays fully visible the whole time it's actively caching,
  // since that's the state a nurse most needs to see before going offline.
  $effect(() => {
    clearTimeout(collapseTimer);
    if (phase === "ready" || phase === "error") {
      expanded = true;
      collapseTimer = setTimeout(() => { expanded = false; }, 4000);
    } else if (phase === "caching") {
      expanded = true;
    }
    return () => clearTimeout(collapseTimer);
  });

  const label = $derived(
    phase === "caching" ? "Caching for offline use…" + (progress.total ? " " + progress.cached + "/" + progress.total : "") :
    phase === "ready" ? "Ready for offline use" :
    "Couldn't fully cache for offline use"
  );

  const dot = $derived(phase === "caching" ? "gnav-cache-dot-busy" : phase === "ready" ? "gnav-cache-dot-ok" : "gnav-cache-dot-warn");
  const title = $derived(readyAt ? label + " · last cached " + new Date(readyAt).toLocaleString() : label);
</script>

{#if phase !== "unsupported" && phase !== "checking"}
  <button
    type="button"
    class={"gnav-cache-status no-print" + (expanded ? " gnav-cache-expanded" : "")}
    onclick={() => { expanded = true; }}
    {title}
  >
    <span class={"gnav-cache-dot " + dot} aria-hidden="true"></span>
    {#if expanded}<span class="gnav-cache-label">{label}</span>{/if}
  </button>
{/if}
