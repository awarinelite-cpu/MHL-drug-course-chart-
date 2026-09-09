import { browser } from "$app/environment";

const THEME_KEY = "wardcharts-app-theme";
// Same key the Lab Reference page already uses for its own night-mode toggle,
// kept in sync here so the whole app shares one consistent dark mode.
const LAB_NIGHT_KEY = "wardcharts-labs-night";

function getInitialTheme() {
  if (!browser) return "light";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch (e) { /* ignore */ }
  return "light";
}

function createThemeState() {
  let theme = $state(getInitialTheme());

  $effect.root(() => {
    $effect(() => {
      if (!browser) return;
      document.documentElement.setAttribute("data-theme", theme);
      try {
        localStorage.setItem(THEME_KEY, theme);
        localStorage.setItem(LAB_NIGHT_KEY, theme === "dark" ? "1" : "0");
      } catch (e) { /* ignore */ }
    });
  });

  return {
    get theme() { return theme; },
    toggleTheme() { theme = theme === "dark" ? "light" : "dark"; }
  };
}

export const themeState = createThemeState();
