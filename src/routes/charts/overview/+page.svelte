<script>
  // Ported from src/pages/Overview.jsx. usePatientHeader/useBackLock are
  // inlined (as $effect/onMount), same convention as the Patient page.
  // getDocSafe/getDocsSafe come from firestoreOffline.js, already ported.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { doc, collection, query, orderBy } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { getDocSafe, getDocsSafe } from "$lib/helpers/firestoreOffline.js";
  import { buildExportRecord, downloadRecordAsPdf, downloadRecordAsJson } from "$lib/helpers/export.js";
  import { STATUS_LABELS } from "$lib/helpers/drugChartHelpers.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import PatientBanner from "$lib/components/PatientBanner.svelte";

  const BADGE_CLASS = { referred: "badge-referred", transferred: "badge-transferred", discharged: "badge-discharged", died: "badge-died" };

  function formatTimestamp(ts) {
    if (!ts) return "";
    try { return ts.toDate().toLocaleString(); } catch (e) { return ""; }
  }

  const patientId = $derived(page.url.searchParams.get("patient"));

  // --- Patient header load (ported from usePatientHeader.js) ---
  let patient = $state(null);
  let patientError = $state(null);

  $effect(() => {
    if (!patientId) { goto("/"); return; }
    patientError = null;
    getDocSafe(doc(db, "patients", patientId)).then((snap) => {
      if (!snap.exists()) { goto("/"); return; }
      patient = { id: snap.id, ...snap.data() };
    }).catch((e) => {
      patientError = "Couldn't load patient: " + (e.code || e.message || "unknown error");
    });
  });

  // Device/OS Back always returns Home (ported from useBackLock.js)
  onMount(() => {
    try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    const onPopState = () => goto("/", { replaceState: true });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  let items = $state(null); // null = loading
  let itemsError = $state(null);
  let exportStatus = $state("");
  let exporting = $state(false);

  $effect(() => {
    const pid = patientId;
    if (!pid) return;
    let cancelled = false;
    items = null;
    itemsError = null;
    (async () => {
      const list = [];
      try {
        const [drugSnap, bgSnap, vitalsSnap, ioSnap, seizureSnap] = await Promise.all([
          getDocSafe(doc(db, "patients", pid, "drugCourseChart", "main")),
          getDocSafe(doc(db, "patients", pid, "bloodGlucose", "main")),
          getDocsSafe(collection(db, "patients", pid, "vitals")),
          getDocsSafe(collection(db, "patients", pid, "intakeOutput")),
          getDocsSafe(collection(db, "patients", pid, "seizure"))
        ]);

        const drugData = drugSnap.exists() ? drugSnap.data() : null;
        const bgData = bgSnap.exists() ? bgSnap.data() : null;
        const hasDrugData = !!(drugData && ((drugData.f_diagnosis || "") || (drugData.drugs || []).some(d => d && d.name) || (drugData.rows || []).some(r => r && (r.date || r.sno))));
        const hasBgData = !!(bgData && (bgData.rows || []).some(r => Array.isArray(r) && r.some(cell => cell)));
        const hasActiveData = hasDrugData || hasBgData || !vitalsSnap.empty || !ioSnap.empty || !seizureSnap.empty;

        if (hasActiveData) {
          list.push({
            kind: "active",
            diagnosis: (drugData && drugData.f_diagnosis) || "No diagnosis entered yet",
            dateLabel: "Currently active",
            href: "/charts/admission?patient=" + pid
          });
        }

        try {
          const q = query(collection(db, "patients", pid, "admissions"), orderBy("archivedAt", "desc"));
          const snap = await getDocsSafe(q);
          snap.forEach(d => {
            const data = d.data();
            list.push({
              kind: data.archiveReason || "closed",
              diagnosis: data.diagnosis || "No diagnosis recorded",
              dateLabel: (data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || "Closed") + " — " + (formatTimestamp(data.archivedAt) || data.archivedAtDisplay || ""),
              href: "/charts/admission?patient=" + pid + "&admission=" + d.id
            });
          });
        } catch (e) {
          const snap = await getDocsSafe(collection(db, "patients", pid, "admissions"));
          const archived = [];
          snap.forEach(d => archived.push({ id: d.id, ...d.data() }));
          archived.sort((a, b) => (b.archivedAtDisplay || "").localeCompare(a.archivedAtDisplay || ""));
          archived.forEach(data => {
            list.push({
              kind: data.archiveReason || "closed",
              diagnosis: data.diagnosis || "No diagnosis recorded",
              dateLabel: (data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || "Closed") + " — " + (data.archivedAtDisplay || ""),
              href: "/charts/admission?patient=" + pid + "&admission=" + data.id
            });
          });
        }

        if (!cancelled) items = list;
      } catch (e) {
        if (!cancelled) itemsError = "Couldn't load admissions: " + (e.code || e.message || "unknown error");
      }
    })();
    return () => { cancelled = true; };
  });

  async function runFullExport(kind) {
    exporting = true;
    exportStatus = "Gathering full admission history…";
    try {
      const record = await buildExportRecord(patientId, { scope: "all", exportedBy: authState.profile?.name });
      if (kind === "pdf") {
        exportStatus = "Building PDF…";
        await downloadRecordAsPdf(record, "full_history");
      } else {
        downloadRecordAsJson(record, "full_history");
      }
      exportStatus = "Export complete.";
    } catch (e) {
      exportStatus = "Export failed: " + (e.message || e.code || "unknown error");
    } finally {
      exporting = false;
    }
  }
</script>

<Topbar brand="Overview">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
</Topbar>

<div class="container">
  <PatientBanner {patient} />
  {#if patientError}<div class="empty-msg" style="margin-top:8px;">{patientError}</div>{/if}

  <div class="card-box" style="margin-top:16px;">
    <h3 style="margin-top:0;">Admissions</h3>
    <div>
      {#if items === null && !itemsError}Loading…{/if}
      {#if itemsError}<div class="empty-msg">{itemsError}</div>{/if}
      {#if items && items.length === 0}<div class="empty-msg">No admissions recorded yet for this patient.</div>{/if}
      {#if items}
        {#each items as item, i (i)}
          {@const badgeClass = item.kind === "active" ? "badge-active" : (BADGE_CLASS[item.kind] || "badge-discharged")}
          {@const badgeText = item.kind === "active" ? "Active" : (STATUS_LABELS[item.kind] || "Closed")}
          <div class="overview-item" onclick={() => goto(item.href)}>
            <div class="oi-left">
              <span class="oi-icon">📁</span>
              <div>
                <div class="oi-diagnosis">{item.diagnosis}</div>
                <div class="oi-meta">{item.dateLabel}</div>
              </div>
            </div>
            <span class={"oi-badge " + badgeClass}>{badgeText}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <div class="card-box no-print" style="margin-top:16px;">
    <h3 style="margin-top:0;">Export Full History</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-primary" style="padding:8px 14px;" disabled={exporting} onclick={() => runFullExport("pdf")}>Export as PDF</button>
      <button class="btn btn-secondary" style="padding:8px 14px;" disabled={exporting} onclick={() => runFullExport("json")}>Export as JSON</button>
    </div>
    <div style="font-size:12px;color:#555;margin-top:8px;">{exportStatus}</div>
  </div>
</div>
