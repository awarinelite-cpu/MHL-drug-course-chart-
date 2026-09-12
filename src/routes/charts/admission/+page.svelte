<script>
  // Ported from src/pages/Admission.jsx. usePatientHeader/useGoBack/useBackLock
  // are inlined here (as $effect/onMount), same convention as Overview and
  // Patient. getDocSafe/getDocsSafe come from firestoreOffline.js.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { doc, setDoc, deleteDoc, addDoc, collection, serverTimestamp } from "firebase/firestore";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { getDocSafe, getDocsSafe } from "$lib/helpers/firestoreOffline.js";
  import { buildExportRecord, downloadRecordAsPdf, downloadRecordAsJson, sharePdf } from "$lib/helpers/export.js";
  import { STATUS_LABELS } from "$lib/helpers/drugChartHelpers.js";
  import Topbar from "$lib/components/Topbar.svelte";
  import PatientBanner from "$lib/components/PatientBanner.svelte";

  const BADGE_CLASS = { referred: "badge-referred", transferred: "badge-transferred", discharged: "badge-discharged", died: "badge-died" };

  const CHARTS = [
    { key: "drug-course-chart", label: "Drug Course Chart", icon: "💊" },
    { key: "vitals", label: "Vital Signs", icon: "❤️" },
    { key: "blood-glucose", label: "Glycemic Chart", icon: "🩸" },
    { key: "intake-output", label: "Intake & Output", icon: "💧" },
    { key: "seizure", label: "Seizure Chart", icon: "⚡" }
  ];

  const patientId = $derived(page.url.searchParams.get("patient"));
  const admissionId = $derived(page.url.searchParams.get("admission"));
  const isArchived = $derived(!!admissionId);
  const backTarget = $derived(patientId ? "/charts/overview?patient=" + patientId : "/");

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

  // Device/OS Back always returns to the Overview page (ported from useBackLock.js)
  onMount(() => {
    try { window.history.pushState({ __backGuard: true }, "", window.location.href); } catch (e) { /* ignore */ }
    const onPopState = () => goto(backTarget, { replaceState: true });
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto(backTarget);
  }

  let info = $state(null); // { diagnosis, metaLabel, badgeText, badgeClass }
  let notFound = $state(false);
  let archiveReason = $state(null);
  let archivedAdmissionData = null; // not reactive — only read inside readmitPatient
  let readmitBusy = $state(false);
  let readmitStatus = $state({ color: "", text: "" });

  let shareBusy = $state(false);
  let shareStatus = $state({ color: "#b91c1c", text: "" });

  let exportBusy = $state(false);
  let exportStatus = $state("");

  $effect(() => {
    const pid = patientId;
    const aid = admissionId;
    const archived = isArchived;
    if (!pid) return;
    (async () => {
      if (archived) {
        const snap = await getDocSafe(doc(db, "patients", pid, "admissions", aid));
        if (!snap.exists()) { notFound = true; return; }
        const data = snap.data();
        archivedAdmissionData = data;
        archiveReason = data.archiveReason || null;
        info = {
          diagnosis: data.diagnosis || "No diagnosis recorded",
          metaLabel: data.archivedAtDisplay ? "Closed on " + data.archivedAtDisplay : "",
          badgeText: data.archiveReasonLabel || STATUS_LABELS[data.archiveReason] || "Closed",
          badgeClass: BADGE_CLASS[data.archiveReason] || "badge-discharged"
        };
      } else {
        const drugSnap = await getDocSafe(doc(db, "patients", pid, "drugCourseChart", "main"));
        info = {
          diagnosis: (drugSnap.exists() && drugSnap.data().f_diagnosis) || "No diagnosis entered yet",
          metaLabel: "Currently active",
          badgeText: "Active",
          badgeClass: "badge-active"
        };
      }
    })();
  });

  $effect(() => {
    if (notFound && patientId) goto("/charts/overview?patient=" + patientId);
  });

  // Mirrors Overview's own hasActiveData check — used to make sure
  // readmitting doesn't silently overwrite a newer admission that's already
  // in progress on the live charts.
  async function hasActiveData() {
    const [drugSnap, bgSnap, vitalsSnap, ioSnap, seizureSnap] = await Promise.all([
      getDocSafe(doc(db, "patients", patientId, "drugCourseChart", "main")),
      getDocSafe(doc(db, "patients", patientId, "bloodGlucose", "main")),
      getDocsSafe(collection(db, "patients", patientId, "vitals")),
      getDocsSafe(collection(db, "patients", patientId, "intakeOutput")),
      getDocsSafe(collection(db, "patients", patientId, "seizure"))
    ]);
    const drugData = drugSnap.exists() ? drugSnap.data() : null;
    const bgData = bgSnap.exists() ? bgSnap.data() : null;
    const hasDrugData = !!(drugData && ((drugData.f_diagnosis || "") || (drugData.drugs || []).some(d => d && d.name) || (drugData.rows || []).some(r => r && (r.date || r.sno))));
    const hasCells = arr => (arr || []).some(r => (r.cells || r || []).some(cell => cell));
    const hasBgData = !!(bgData && (hasCells(bgData.rows6) || hasCells(bgData.rows3) || hasCells(bgData.rows)));
    return hasDrugData || hasBgData || !vitalsSnap.empty || !ioSnap.empty || !seizureSnap.empty;
  }

  async function readmitPatient() {
    const patientName = (patient?.name || "").trim() || "this patient";
    if (!confirm("Readmit " + patientName + "?\n\nThis cancels the discharge and restores the drug chart, vitals, glycemic chart, intake & output, and seizure chart from this admission back to active. Care continues from exactly where it left off.")) return;

    // Same reasoning as applyStatusAction's guard on the drug chart page:
    // this restores multiple collections from the archived record and then
    // deletes the archive doc, all in a specific order that depends on each
    // step actually completing — not something to risk running against a
    // stale offline cache.
    if (!navigator.onLine) {
      readmitStatus = { color: "#b91c1c", text: "This needs an internet connection — readmitting restores several charts from the archived record and then removes it, and doing that safely requires reading the real data. Please try again once online." };
      return;
    }

    readmitBusy = true;
    readmitStatus = { color: "#555", text: "Checking for a newer admission already in progress…" };

    try {
      if (await hasActiveData()) {
        readmitStatus = { color: "#b91c1c", text: "This patient already has an active admission in progress — readmitting this record would overwrite it. Close out or resolve the current admission first, or contact an admin." };
        readmitBusy = false;
        return;
      }

      readmitStatus = { color: "#555", text: "Restoring charts…" };
      const admData = archivedAdmissionData || {};
      const dc = admData.drugCourseChart || {};
      const restoredAuditLog = Array.isArray(dc.auditLog) ? dc.auditLog.slice() : [];
      restoredAuditLog.push({
        text: "Patient readmitted — discharge on " + (admData.archivedAtDisplay || "an earlier date") + " cancelled; care continues.",
        nurse: authState.profile?.name || "Unknown",
        at: new Date().toISOString()
      });
      const restoredDrugChart = {
        ...dc,
        f_discharge: "", // no longer discharged
        auditLog: restoredAuditLog,
        updatedAt: serverTimestamp()
      };
      const bg = admData.bloodGlucose || { chartType: "6point", rows6: [], rows3: [] };
      const ioSummary = admData.intakeOutputSummary || { intake: 0, output: 0, balance: 0, periodDate: new Date().toISOString().slice(0, 10) };

      await Promise.all([
        setDoc(doc(db, "patients", patientId, "drugCourseChart", "main"), restoredDrugChart),
        setDoc(doc(db, "patients", patientId, "bloodGlucose", "main"), {
          chartType: bg.chartType || "6point",
          // A record archived before per-type storage existed may still only
          // have the old single 'rows' field — carry it into whichever type
          // it belonged to instead of dropping it.
          rows6: bg.rows6 || (bg.chartType !== "3point" ? (bg.rows || []) : []),
          rows3: bg.rows3 || (bg.chartType === "3point" ? (bg.rows || []) : []),
          updatedAt: serverTimestamp()
        }),
        setDoc(doc(db, "patients", patientId, "intakeOutputSummary", "current"), { ...ioSummary, updatedAt: serverTimestamp() }),
        ...(admData.vitals || []).map(entry => addDoc(collection(db, "patients", patientId, "vitals"), entry)),
        ...(admData.intakeOutput || []).map(entry => addDoc(collection(db, "patients", patientId, "intakeOutput"), entry)),
        ...(admData.seizure || []).map(entry => addDoc(collection(db, "patients", patientId, "seizure"), entry))
      ]);

      // The discharge is cancelled, not just superseded — remove the
      // archived record so it doesn't keep showing as a closed admission
      // alongside the now-active one it was restored into.
      await deleteDoc(doc(db, "patients", patientId, "admissions", admissionId));

      readmitStatus = { color: "#16a34a", text: "Readmitted — redirecting to the active chart…" };
      setTimeout(() => goto("/charts/drug-course-chart?patient=" + patientId + "&from=admission"), 900);
    } catch (e) {
      readmitStatus = { color: "#b91c1c", text: "Readmit failed: " + (e.code || e.message || "unknown error") };
      readmitBusy = false;
    }
  }

  function chartHref(key) {
    return "/charts/" + key + "?patient=" + patientId + (isArchived ? "&admission=" + admissionId : "") + "&from=admission";
  }

  async function shareAdmission() {
    shareBusy = true;
    shareStatus = { color: "#555", text: "" };
    try {
      const record = await buildExportRecord(patientId, { admissionId: isArchived ? admissionId : null });
      const diagnosis = (info?.diagnosis || "").trim();
      const patientName = (patient?.name || "").trim();
      const result = await sharePdf(record, isArchived ? "admission" : "active_admission", diagnosis + " — " + patientName);
      if (result.downloaded) {
        shareStatus = { color: "#555", text: "Your browser can’t share files directly, so the PDF was downloaded instead — you can share it from there." };
      } else {
        shareStatus = { color: "#555", text: "" };
      }
    } catch (e) {
      shareStatus = { color: "#b91c1c", text: "Could not prepare the PDF to share: " + (e.message || e.code || "unknown error") };
    } finally {
      shareBusy = false;
    }
  }

  async function runExport(kind) {
    exportBusy = true;
    exportStatus = "Gathering this admission’s record…";
    try {
      const record = await buildExportRecord(patientId, { admissionId: isArchived ? admissionId : null, exportedBy: authState.profile?.name });
      if (kind === "pdf") {
        exportStatus = "Building PDF…";
        await downloadRecordAsPdf(record, isArchived ? "admission" : "active_admission");
      } else {
        downloadRecordAsJson(record, isArchived ? "admission" : "active_admission");
      }
      exportStatus = "Export complete.";
    } catch (e) {
      exportStatus = "Export failed: " + (e.message || e.code || "unknown error");
    } finally {
      exportBusy = false;
    }
  }
</script>

<Topbar brand="Admission Overview">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
  <button class="btn btn-secondary" style="padding:6px 12px;" disabled={shareBusy} onclick={shareAdmission}>
    {shareBusy ? "Preparing…" : "Share"}
  </button>
  <button class="btn btn-primary" style="padding:6px 12px;" onclick={() => window.print()}>Print</button>
</Topbar>
{#if shareStatus.text}
  <div class="no-print" style={"font-size:12px;color:" + shareStatus.color + ";padding:4px 16px 0;"}>{shareStatus.text}</div>
{/if}

<div class="container">
  <PatientBanner {patient} />
  {#if patientError}<div class="empty-msg" style="margin-top:8px;">{patientError}</div>{/if}

  <div class="card-box" style="margin-top:16px;">
    <div class="pname" style="font-size:17px;">
      {info?.diagnosis || "—"}
      {#if info}<span class={"badge " + info.badgeClass}>{info.badgeText}</span>{/if}
    </div>
    {#if isArchived && archiveReason === "discharged"}
      <button class="badge no-print" style="border:none;cursor:pointer;background:#2563eb;margin-top:6px;padding:4px 10px;"
        disabled={readmitBusy} onclick={readmitPatient}>
        {readmitBusy ? "Working…" : "↺ Readmit"}
      </button>
    {/if}
    <div class="pmeta" style="margin-top:4px;">{info?.metaLabel || ""}</div>
    {#if readmitStatus.text}<div class="no-print" style={"font-size:12px;margin-top:6px;color:" + readmitStatus.color + ";"}>{readmitStatus.text}</div>{/if}
  </div>

  <div class="chart-grid">
    {#each CHARTS as c (c.key)}
      <div class="chart-card" onclick={() => goto(chartHref(c.key))}><span class="icon">{c.icon}</span>{c.label}</div>
    {/each}
  </div>

  <div class="card-box no-print" style="margin-top:16px;">
    <h3 style="margin-top:0;">Export This Admission</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-primary" style="padding:8px 14px;" disabled={exportBusy} onclick={() => runExport("pdf")}>Export as PDF</button>
      <button class="btn btn-secondary" style="padding:8px 14px;" disabled={exportBusy} onclick={() => runExport("json")}>Export as JSON</button>
    </div>
    <div style="font-size:12px;color:#555;margin-top:8px;">{exportStatus}</div>
  </div>
</div>
