<script>
  // Ported from src/components/OfflineBanner.jsx (React).
  import { onMount } from "svelte";

  let offline = $state(typeof navigator !== "undefined" ? !navigator.onLine : false);
  let bannerEl = $state(null);

  onMount(() => {
    const update = () => { offline = !navigator.onLine; };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });

  // The banner is position:fixed so it doesn't take up space in normal
  // document flow. Without this, it overlaps whatever sits at the top of
  // the page (topbar buttons, etc). Measure its real rendered height and
  // push the rest of the app down by that amount via a CSS variable, so
  // nothing underneath is ever covered.
  $effect(() => {
    function syncHeight() {
      const h = offline && bannerEl ? bannerEl.offsetHeight : 0;
      document.documentElement.style.setProperty("--offline-banner-h", h + "px");
    }
    syncHeight();
    document.body.classList.toggle("has-offline-banner", offline);
    if (!offline) return;
    window.addEventListener("resize", syncHeight);
    return () => window.removeEventListener("resize", syncHeight);
  });
</script>

<div
  bind:this={bannerEl}
  class={"gnav-offline-banner no-print" + (offline ? " gnav-show" : "")}
>
  You're offline. Entries are being saved on this device and will sync automatically once you're back online.
</div>
