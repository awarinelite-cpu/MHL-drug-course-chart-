<script>
  // Ported from src/pages/IntakeOutput.jsx — a thin EntryChart config;
  // the derive/summary logic lives in $lib/helpers/intakeOutputHelpers.js.
  import EntryChart from "$lib/components/EntryChart.svelte";
  import { deriveIOBalance, computeTodayTotals } from "$lib/helpers/intakeOutputHelpers.js";

  const columns = [
    // Single datetime input drives entry (and sorting/day-boundary logic), but
    // the table shows it as separate Date and Time columns — see
    // dateDisplayOf/timeDisplayOf and deriveIOBalance.
    { key: "time", label: "Time", type: "datetime-local", formOnly: true },
    { key: "dateDisplay", label: "Date", computed: true },
    { key: "timeDisplay", label: "Time", computed: true },
    {
      // Dropdown (not free text) for route of intake, with an "OTHERS" option
      // that reveals a small textarea to specify the custom route. Starts on
      // "SELECT" (placeholder) — this is the on/off switch for the whole
      // intake group: leaving it on SELECT means nothing gets recorded for
      // intake on this entry, even if Nature of Fluid / Intake Vol. were filled in.
      key: "intakeType", label: "Route of Intake", type: "select",
      options: ["Oral", "NG/PEG", "IV", "OTHERS"], placeholder: "SELECT",
      otherOption: "OTHERS", otherPlaceholder: "Specify the route",
      group: "intake", groupGate: true,
      groupLabel: "Intake", groupColor: "rgba(46, 204, 113, 0.12)"
    },
    {
      // Free text (fluid names vary too much for a fixed dropdown). In the
      // Entries table this shows as a truncated, tappable cell that opens
      // a popup with the full name — same pattern as the Diagnosis field on
      // the Drug Course Chart — so long fluid names don't break the layout.
      key: "natureOfFluid", label: "Nature of Fluid", type: "text", popup: true, group: "intake"
    },
    { key: "intakeAmount", label: "Intake Vol. (ml)", type: "text", group: "intake" },
    {
      // Starts on "SELECT" — the on/off switch for the output group: leaving
      // it on SELECT means nothing gets recorded for output on this entry,
      // even if Output Vol. was filled in.
      key: "outputType", label: "Type of Output", type: "select",
      options: ["URINE", "VOMITING", "DRAINAGE", "DRAIN/OTHER"], placeholder: "SELECT",
      group: "output", groupGate: true,
      groupLabel: "Output", groupColor: "rgba(255, 152, 0, 0.12)"
    },
    { key: "outputAmount", label: "Output Vol. (ml)", type: "text", group: "output" },
    { key: "balance", label: "Balance (ml)", computed: true, abnormal: v => parseFloat(v) < 0, deficitShade: true },
    { key: "notes", label: "Notes", type: "text" }
  ];

  const summary = {
    label: "24-Hour Balance (Today)",
    archivedLabel: "Balance at Close (Last 24-Hour Period)",
    storeAt: ["intakeOutputSummary", "current"],
    archivedKey: "intakeOutputSummary",
    compute: computeTodayTotals
  };
</script>

<EntryChart
  title="Intake & Output Chart"
  collectionName="intakeOutput"
  {columns}
  deriveRows={deriveIOBalance}
  sortOrder="asc"
  {summary}
  entryNoun="Entry"
/>
