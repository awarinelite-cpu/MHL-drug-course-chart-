<script>
  // Ported from src/pages/Seizure.jsx — a thin EntryChart config.
  import EntryChart from "$lib/components/EntryChart.svelte";

  const columns = [
    { key: "time", label: "Time", type: "datetime-local" },
    { key: "duration", label: "Duration", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "description", label: "Description", type: "text" }
  ];
</script>

<EntryChart title="Seizure Chart" collectionName="seizure" {columns} entryNoun="Entry" />
