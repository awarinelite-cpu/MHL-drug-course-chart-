<script>
  // Ported from WardReportPanel() in src/pages/nurses-report/WardNurse.jsx.
  // One ward's full report — Previous Occ, Shift Statistics, Patient
  // Demographics, Patients, Night Update, Save/Submit. Used once per
  // selected ward, and twice side-by-side when the nurse picks a grouped
  // option that isn't a mergedTable group (e.g. PAED WARD) — each instance
  // loads and saves its own Firestore doc under its own wardKey,
  // completely independently.
  import { authState } from "$lib/stores/auth.svelte.js";
  import { createWardReport } from "$lib/helpers/useWardReport.svelte.js";
  import WardPanelRest from "./WardPanelRest.svelte";

  let { wardKey, showLabel } = $props();

  const isAdmin = $derived(authState.profile?.role === "admin");
  const h = createWardReport(wardKey, authState.profile, authState.user, () => isAdmin);
</script>

<WardPanelRest {h} {showLabel} {isAdmin} includeShiftTable={true} />
