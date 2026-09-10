<script>
  // Ported from src/pages/nurses-report/ArchiveList.jsx.
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { collection, query, where, getDocs } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import Topbar from "$lib/components/Topbar.svelte";

  function fmtTimestamp(ts) {
    if (!ts || !ts.toDate) return "";
    const d = ts.toDate();
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/nurses-report/role-select");
  }

  const type = $derived(page.url.searchParams.get("type") === "ward" ? "ward" : "overall");
  const wardKey = $derived(page.url.searchParams.get("ward") || "");
  const wardLabel = $derived(page.url.searchParams.get("label") || "");

  let allFiles = $state([]);
  let searchText = $state("");
  let emptyMsg = $state("No archived reports yet.");

  $effect(() => {
    const t = type;
    const wk = wardKey;
    (async () => {
      let snap;
      try {
        snap = t === "ward"
          ? await getDocs(query(collection(db, "archives"), where("wardKey", "==", wk)))
          : await getDocs(query(collection(db, "archives"), where("type", "==", "overall")));
      } catch (e) {
        emptyMsg = "Couldn't load the archive: " + (e.code || e.message || "unknown error");
        return;
      }
      const files = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      files.sort((a, b) => (b.dateId || "").localeCompare(a.dateId || ""));
      allFiles = files;
      emptyMsg = "No archived reports yet.";
    })();
  });

  const filtered = $derived.by(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return allFiles;
    return allFiles.filter(f =>
      f.dateId.toLowerCase().includes(q) || (f.fileName || "").toLowerCase().includes(q)
    );
  });

  const brand = $derived(type === "ward" ? wardLabel + " Archive" : "Overall Archive");
  const title = $derived(type === "ward" ? wardLabel + " — Ward Report Archive" : "Overall Report Archive");
  const subtitle = $derived(type === "ward" ? "Every finalized 24-hour ward report for " + wardLabel + "." : "Every finalized 24-hour overall report.");
</script>

<Topbar brand={brand}>
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
</Topbar>
<div class="container">
  <div class="card-box">
    <h2>{title}</h2>
    <p style="font-size:12px;color:#555;margin-top:-6px;">{subtitle}</p>
    <div class="search-row">
      <input type="text" placeholder="Search by date, e.g. 01/09/26 or 2026-09-01" bind:value={searchText} />
    </div>
    <div style="font-size:12px;color:#666;margin-top:8px;">{filtered.length} file{filtered.length === 1 ? "" : "s"}</div>
    <div class="archive-grid">
      {#each filtered as f (f.id)}
        <div class="archive-card" tabindex="0"
          onclick={() => goto("/nurses-report/archive-view?id=" + encodeURIComponent(f.id))}
          onkeydown={(e) => { if (e.key === "Enter") goto("/nurses-report/archive-view?id=" + encodeURIComponent(f.id)); }}>
          <div class="file-icon">📄</div>
          <div class="file-name">{f.fileName || f.dateId}</div>
          <div class="file-meta">
            Archived by {f.archivedBy || "Unknown"}
            {#if f.archivedAt}<br />{fmtTimestamp(f.archivedAt)}{/if}
          </div>
          {#if f.lastEditedAt}<div class="edited-badge">Edited</div>{/if}
        </div>
      {/each}
    </div>
    {#if filtered.length === 0}<div class="archive-empty">{emptyMsg}</div>{/if}
  </div>
</div>
