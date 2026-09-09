<script>
  import { navState } from "$lib/stores/nav.svelte.js";
  import { themeState } from "$lib/stores/theme.svelte.js";

  let { brand = "", children } = $props();
</script>

<div class="topbar">
  <div class="gnav-topbar-left no-print">
    <button class="gnav-toggle" aria-label="Open menu" onclick={navState.openDrawer}>&#9776;</button>
    <div class="brand">{brand}</div>
  </div>
  <div class="right">
    <button
      class="theme-toggle-btn no-print"
      type="button"
      aria-label="Toggle dark mode"
      onclick={themeState.toggleTheme}
    >
      {themeState.theme === "dark" ? "🌙 Night" : "☀️ Day"}
    </button>
    {@render children?.()}
  </div>
</div>
