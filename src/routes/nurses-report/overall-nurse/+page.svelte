<script>
  // Ported from src/pages/nurses-report/OverallNurse.jsx. Local React
  // helper components (WardShiftTable, WardStatsSection,
  // GroupedWardShiftTable, WardPatientSection, PatientBlock, NoteLines)
  // become snippets below, in the same order. PatientBlock/NoteLines reuse
  // the already-ported PatientBlockView.svelte component instead of a
  // snippet, same as WardReportPanel does elsewhere.
  import { goto } from "$app/navigation";
  import {
    doc, updateDoc, collection, onSnapshot, serverTimestamp, writeBatch
  } from "firebase/firestore";
  import { getDocSafe, getDocsSafe } from "$lib/helpers/firestoreOffline.js";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import {
    WARDS, WARD_GROUPS, STAT_FIELDS, DEMOGRAPHIC_FIELDS,
    reportDateId, reportPeriodLabel, wardReportPeriodLabel, weekId, occDelta,
    defaultWardDoc, movementColorClass,
    loadWardNameOverrides, saveWardNameOverride,
    loadHeaderLabelOverrides, saveHeaderLabelOverride, headerLabel, GROUP_LABEL_IDS,
    CUSTOM_TEXT_COLUMNS, loadCustomColumns, addCustomColumn, renameCustomColumn, removeCustomColumn,
    isWardDocUntouched, SHIFTS
  } from "$lib/helpers/nursesReportCommon.js";
  import { SOLO_BEFORE, SOLO_AFTER, ORDERED_MOVEMENT } from "$lib/helpers/useWardReport.svelte.js";
  import { patientWardAndBedTypeForReportKey } from "$lib/helpers/wardNameMatch.js";
  import { wardHeadcount } from "$lib/helpers/wardCensus.js";
  import PatientBlockView from "$lib/components/nurses-report/PatientBlockView.svelte";
  import ReportContactModal from "$lib/components/nurses-report/ReportContactModal.svelte";
  import Topbar from "$lib/components/Topbar.svelte";

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/nurses-report/role-select");
  }

  const wk = weekId();
  const dateId = reportDateId();
  const roleRef = doc(db, "nurseReportRoles_mhl", wk);
  const wardsCol = collection(db, "nurseReports_mhl", dateId, "wards");

  /** @type {'checking'|'denied'|'granted'|'error'} */
  let access = $state("checking");
  let deniedMsg = $state("");
  let whoLabel = $state("");
  let wardData = $state({});
  let saveStatus = $state({ text: "", error: false });
  let syncBusy = $state(false);
  let syncStatus = $state({ text: "", error: false });
  let archiveBusy = $state(false);
  let archiveStatus = $state({ text: "", error: false });
  let usersByUid = $state({});
  /** @type {{name:string, phone:string, wardLabel:string}|null} */
  let contactModal = $state(null);
  // WARDS/STAT_FIELDS/CUSTOM_TEXT_COLUMNS are mutated in place by the
  // override loaders below (same module-level arrays every importer
  // shares) — plain property mutations on a non-$state array aren't
  // tracked, so this counter is read inside label()/customColumnsView()
  // purely to force those template reads to recompute after a rename.
  let overridesTick = $state(0);

  const isAdmin = $derived(authState.profile?.role === "admin");
  const isSubadmin = $derived(authState.profile?.role === "subadmin");

  function wardLabel(w) { overridesTick; return w.label; }
  function fieldLabel(f) { overridesTick; return f.label; }
  function groupHeaderLabel(id, def) { overridesTick; return headerLabel(id, def); }
  const customColumnsView = $derived.by(() => { overridesTick; return CUSTOM_TEXT_COLUMNS; });

  $effect(() => {
    if (!authState.user || !authState.profile) return;
    let unsub;
    let cancelled = false;
    (async () => {
      let roleSnap;
      try {
        roleSnap = await getDocSafe(roleRef);
      } catch (e) {
        deniedMsg = "Couldn't check the current Overall Nurse: " + (e.code || e.message || "unknown error");
        access = "error";
        return;
      }
      if (cancelled) return;
      const overall = roleSnap.exists() ? roleSnap.data().overallNurse : null;
      const isOverall = overall && overall.uid === authState.user.uid;

      if (!isAdmin && !isSubadmin && !isOverall) {
        deniedMsg = overall
          ? (overall.name || "Another nurse") + " is the Overall Nurse for this week. Ask them to hand off the role, or claim it yourself if it\u2019s free next week."
          : "No one has assumed the Overall Nurse role this week yet.";
        access = "denied";
        return;
      }

      whoLabel = "Overall Nurse this week: " + (overall ? overall.name : authState.profile.name) +
        (((isAdmin || isSubadmin) && !isOverall) ? " (viewing as " + authState.profile.role + ")" : "");

      await Promise.all([loadWardNameOverrides(db), loadHeaderLabelOverrides(db), loadCustomColumns(db)]);
      overridesTick += 1;

      try {
        const usersSnap = await getDocsSafe(collection(db, "users"));
        const map = {};
        usersSnap.forEach((d) => { map[d.id] = d.data(); });
        if (!cancelled) usersByUid = map;
      } catch (e) {
        // Non-fatal — the duty column just won't be able to show phone
        // numbers if this fails (e.g. permissions).
      }

      // Load and seed ward data BEFORE granting access, so the page (and
      // Save to Archive) never renders with stale/empty data ahead of the
      // onSnapshot listener below catching up.
      await ensureSeeded();
      if (cancelled) return;
      access = "granted";

      unsub = onSnapshot(wardsCol, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "removed") return;
          wardData = { ...wardData, [change.doc.id]: change.doc.data() };
        });
      }, (err) => {
        saveStatus = { text: "Live sync error: " + (err.code || err.message || "unknown error"), error: true };
      });
    })();
    return () => { cancelled = true; if (unsub) unsub(); };
  });

  async function ensureSeeded() {
    let snap;
    try {
      snap = await getDocsSafe(wardsCol);
    } catch (e) {
      saveStatus = { text: "Couldn't load ward data: " + (e.code || e.message || "unknown error"), error: true };
      return;
    }
    const map = {};
    snap.docs.forEach((d) => { map[d.id] = d.data(); });
    const existing = new Set(snap.docs.map((d) => d.id));
    const missing = WARDS.filter((w) => !existing.has(w.key));
    // Untouched existing docs (no shift figures entered on either shift
    // yet today, not submitted/locked) are still fair game to re-seed —
    // nothing real would be lost. Missing docs are always untouched by
    // definition, so both groups get the same live-census treatment.
    const untouchedExisting = WARDS.filter((w) => existing.has(w.key) && isWardDocUntouched(map[w.key]));
    if (!missing.length && !untouchedExisting.length) { wardData = map; return; }

    let patients = [];
    try {
      const patientsSnap = await getDocsSafe(collection(db, "patients_mhl"));
      patientsSnap.forEach((d) => patients.push(d.data()));
    } catch {
      // Fall through with an empty patient list — wards just seed at 0
      // occ below rather than the real census, same as if none of this
      // ran at all.
    }
    function headcountFor(w) {
      const info = patientWardAndBedTypeForReportKey(w.key);
      return info ? wardHeadcount(patients, info.wardLabel, info.bedType) : 0;
    }

    const batch = writeBatch(db);
    missing.forEach((w) => {
      const headcount = headcountFor(w);
      const data = defaultWardDoc(w, headcount);
      batch.set(doc(wardsCol, w.key), data);
      map[w.key] = data;
    });
    untouchedExisting.forEach((w) => {
      const headcount = headcountFor(w);
      const beds = typeof map[w.key].beds === "number" ? map[w.key].beds : w.beds;
      const patch = { startOcc: headcount, occ: headcount, vac: beds - headcount };
      batch.set(doc(wardsCol, w.key), patch, { merge: true });
      map[w.key] = { ...map[w.key], ...patch };
    });
    try {
      await batch.commit();
    } catch (e) {
      saveStatus = { text: "Couldn't seed ward list: " + (e.code || e.message || "unknown error"), error: true };
    }
    wardData = map;
  }

  // Manual override: unlike ensureSeeded()'s automatic reseed (which only
  // touches wards nobody's entered anything for today, and leaves a
  // locked or submitted doc alone), this forces every ward with a
  // matching patient-chart ward to match the live patient list right
  // now, regardless of lock/submitted status.
  async function resyncOccFromPatients() {
    if (!isAdmin) return;
    if (!confirm("This will reset every ward's Occ, Vac, and Previous Occ to match the patients currently registered under that ward in the app, overwriting today's current figures (even locked or submitted ones). Shift movement entries (Adm, Disch, etc.) are left alone. Continue?")) return;
    syncBusy = true;
    syncStatus = { text: "", error: false };
    try {
      const patientsSnap = await getDocsSafe(collection(db, "patients_mhl"));
      const patients = [];
      patientsSnap.forEach((d) => patients.push(d.data()));
      const batch = writeBatch(db);
      const nextWardData = { ...wardData };
      let touched = 0;
      WARDS.forEach((w) => {
        const info = patientWardAndBedTypeForReportKey(w.key);
        if (!info) return; // no patient-chart equivalent for this ward — leave it as-is
        const headcount = wardHeadcount(patients, info.wardLabel, info.bedType);
        const beds = typeof wardData[w.key]?.beds === "number" ? wardData[w.key].beds : w.beds;
        const patch = { startOcc: headcount, occ: headcount, vac: beds - headcount };
        batch.set(doc(wardsCol, w.key), patch, { merge: true });
        nextWardData[w.key] = { ...(nextWardData[w.key] || {}), ...patch };
        touched += 1;
      });
      await batch.commit();
      wardData = nextWardData;
      syncStatus = { text: "Synced " + touched + " ward(s) with the current patient list.", error: false };
    } catch (e) {
      syncStatus = { text: "Couldn't sync: " + (e.code || e.message || "unknown error"), error: true };
    }
    syncBusy = false;
  }

  async function toggleLock(wardKey) {
    const locked = !!(wardData[wardKey] && wardData[wardKey].locked);
    try {
      await updateDoc(doc(wardsCol, wardKey), { locked: !locked });
    } catch (e) {
      saveStatus = { text: "Couldn't change access: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  async function renameWard(w) {
    const newLabel = window.prompt('Rename ward "' + w.label + '" to:', w.label);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (!trimmed || trimmed === w.label) return;
    try {
      await saveWardNameOverride(db, w.key, trimmed);
      overridesTick += 1;
      saveStatus = { text: 'Ward renamed to "' + w.label + '".', error: false };
    } catch (e) {
      saveStatus = { text: "Couldn't rename ward: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  async function renameBuiltInColumn(f) {
    const newLabel = window.prompt('Rename column "' + f.label + '" to:', f.label);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (!trimmed || trimmed === f.label) return;
    try {
      await saveHeaderLabelOverride(db, f.key, trimmed, f.defaultLabel);
      overridesTick += 1;
      saveStatus = { text: "Column renamed.", error: false };
    } catch (e) {
      saveStatus = { text: "Couldn't rename column: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  async function renameGroupHeader(groupId, currentLabel, defaultLabel) {
    const newLabel = window.prompt('Rename column "' + currentLabel + '" to:', currentLabel);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (!trimmed || trimmed === currentLabel) return;
    try {
      await saveHeaderLabelOverride(db, groupId, trimmed, defaultLabel);
      overridesTick += 1;
      saveStatus = { text: "Column renamed.", error: false };
    } catch (e) {
      saveStatus = { text: "Couldn't rename column: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  async function renameCustomColumnPrompt(c) {
    const newLabel = window.prompt('Rename column "' + c.label + '" to (clear the text and OK to delete it):', c.label);
    if (newLabel === null) return;
    const trimmed = newLabel.trim();
    if (trimmed === c.label) return;
    if (!trimmed) {
      if (!window.confirm('Delete column "' + c.label + '"? This does not erase any data already entered under it, just removes the column from the tables.')) return;
      try {
        await removeCustomColumn(db, c.key);
        overridesTick += 1;
        saveStatus = { text: "Column deleted.", error: false };
      } catch (e) {
        saveStatus = { text: "Couldn't delete column: " + (e.code || e.message || "unknown error"), error: true };
      }
      return;
    }
    try {
      await renameCustomColumn(db, c.key, trimmed);
      overridesTick += 1;
      saveStatus = { text: "Column renamed.", error: false };
    } catch (e) {
      saveStatus = { text: "Couldn't rename column: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  async function addColumnPrompt() {
    const label = window.prompt("New column name:");
    if (label === null) return;
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      await addCustomColumn(db, trimmed);
      overridesTick += 1;
      saveStatus = { text: "Column added.", error: false };
    } catch (e) {
      saveStatus = { text: "Couldn't add column: " + (e.code || e.message || "unknown error"), error: true };
    }
  }

  // Opens the contact popup for whichever ward nurse submitted this ward's
  // report. Looks the phone number up by uid first (current data), falling
  // back to a name match for older reports submitted before uid was
  // recorded.
  function openNurseContact(w, data) {
    const name = data.submittedBy;
    if (!name) return;
    let userDoc = data.submittedByUid ? usersByUid[data.submittedByUid] : null;
    if (!userDoc) {
      userDoc = Object.values(usersByUid).find(
        (u) => (u.name || "").trim().toLowerCase() === name.trim().toLowerCase()
      );
    }
    contactModal = { name, phone: userDoc ? userDoc.phone : "", wardLabel: w.label };
  }

  const totals = $derived.by(() => {
    const out = {};
    STAT_FIELDS.forEach((f) => {
      let sum = 0;
      WARDS.forEach((w) => { const v = wardData[w.key] ? wardData[w.key][f.key] : undefined; sum += typeof v === "number" ? v : 0; });
      out[f.key] = sum;
    });
    return out;
  });

  const demoTotals = $derived.by(() => {
    const out = {};
    DEMOGRAPHIC_FIELDS.forEach((f) => {
      let sum = 0;
      WARDS.forEach((w) => { const v = wardData[w.key] ? wardData[w.key][f.key] : undefined; sum += typeof v === "number" ? v : 0; });
      out[f.key] = sum;
    });
    return out;
  });

  // Builds the Ward Reports list, merging any WARD_GROUPS members (PAED
  // BED + PAED COT) that have a submitted report into one entry so their
  // patient write-ups render under a single "PAED WARD" heading. The "All
  // Wards" statistics table above is untouched by this — it still lists
  // every ward from WARDS separately — and each grouped ward keeps its own
  // Shift Statistics table below, just labeled with a subheading.
  const reportGroups = $derived.by(() => {
    const groupedWardKeys = new Set(WARD_GROUPS.flatMap((g) => g.wardKeys));
    const groups = [];
    const seenGroupKeys = new Set();
    WARDS.forEach((w) => {
      if (groupedWardKeys.has(w.key)) {
        const group = WARD_GROUPS.find((g) => g.wardKeys.includes(w.key));
        if (seenGroupKeys.has(group.key)) return;
        seenGroupKeys.add(group.key);
        const allMembers = group.wardKeys.map((k) => ({ w: WARDS.find((x) => x.key === k), data: wardData[k] || {} }));
        if (!allMembers.some((m) => m.data.submitted)) return;
        // A merged table always shows every member row (paper always has
        // both Mothers and Cots), even if one hasn't been submitted yet —
        // the non-grouped case keeps the original submitted-only filter.
        let members = group.mergedTable ? allMembers : allMembers.filter((m) => m.data.submitted);
        // A patientLocationOptions group (Paed) saves every write-up
        // under the lead member's (first member's) own doc, tagged with
        // a "Located" field — split them back out per member here by
        // that tag so e.g. a patient marked PAED COT shows under PAED
        // COT below, not under PAED BED just because that's whose doc
        // it's physically stored in. Untagged patients (written before
        // this feature existed, or left blank) default to the lead
        // member.
        if (group.patientLocationOptions) {
          const leadPatients = Array.isArray(allMembers[0].data.patients) ? allMembers[0].data.patients : [];
          const leadLabel = allMembers[0].w.label;
          members = members.map((m) => ({
            ...m,
            data: { ...m.data, patients: leadPatients.filter((p) => (p.location || leadLabel) === m.w.label) }
          }));
        }
        groups.push({ key: group.key, label: group.label, members, mergedTable: !!group.mergedTable });
        return;
      }
      const data = wardData[w.key];
      if (data && data.submitted) groups.push({ key: w.key, label: w.label, members: [{ w, data }] });
    });
    return groups;
  });

  // Files the current 24-hour period to the permanent Ward Charts Archive:
  // one "overall_<dateId>" doc plus one "ward_<wardKey>_<dateId>" doc per
  // ward, all as a single batch. Matches firestore.rules, which only lets
  // the Overall Nurse *create* an archive entry — only admin/subadmin may
  // update an already-archived one.
  async function saveToArchive() {
    // Belt-and-suspenders guard alongside the load-order fix above: never
    // archive (and then reset-overwrite) live ward data unless every
    // ward's doc has actually loaded into wardData.
    const loadedWardCount = WARDS.filter((w) => wardData[w.key]).length;
    if (loadedWardCount < WARDS.length) {
      archiveStatus = { text: "Ward data is still loading (" + loadedWardCount + "/" + WARDS.length + " wards ready) \u2014 please wait a moment and try again.", error: true };
      return;
    }
    const overallRef = doc(db, "archives_mhl", "overall_" + dateId);
    let existingSnap;
    try {
      existingSnap = await getDocSafe(overallRef);
    } catch (e) {
      archiveStatus = { text: "Couldn't check the archive: " + (e.code || e.message || "unknown error"), error: true };
      return;
    }
    const alreadyArchived = existingSnap.exists();
    if (alreadyArchived && !isAdmin && !isSubadmin) {
      archiveStatus = { text: "This period is already archived. Only an admin or subadmin can update an archived report.", error: true };
      return;
    }
    const verb = alreadyArchived ? "update the archived copy of" : "save";
    if (!confirm("This will " + verb + " this 24-hour report (overall + all " + WARDS.length + " ward reports) to the permanent archive. Continue?")) return;

    archiveBusy = true;
    const who = authState.profile.name || "Unknown";
    const batch = writeBatch(db);

    const wardsSnapshot = {};
    WARDS.forEach((w) => { wardsSnapshot[w.key] = wardData[w.key] || {}; });
    const overallPayload = {
      type: "overall", dateId, weekId: wk,
      fileName: reportPeriodLabel(dateId),
      wards: wardsSnapshot,
      archivedBy: who, archivedByUid: authState.user.uid, archivedAt: serverTimestamp()
    };
    if (alreadyArchived) {
      overallPayload.lastEditedBy = who;
      overallPayload.lastEditedByUid = authState.user.uid;
      overallPayload.lastEditedAt = serverTimestamp();
      batch.update(overallRef, overallPayload);
    } else {
      batch.set(overallRef, overallPayload);
    }

    WARDS.forEach((w) => {
      const ref = doc(db, "archives_mhl", "ward_" + w.key + "_" + dateId);
      const payload = {
        type: "ward", wardKey: w.key, wardLabel: w.label, dateId, weekId: wk,
        fileName: wardReportPeriodLabel(dateId),
        data: wardData[w.key] || {},
        archivedBy: who, archivedByUid: authState.user.uid, archivedAt: serverTimestamp()
      };
      if (alreadyArchived) {
        payload.lastEditedBy = who;
        payload.lastEditedByUid = authState.user.uid;
        payload.lastEditedAt = serverTimestamp();
        batch.update(ref, payload);
      } else {
        batch.set(ref, payload);
      }
    });

    try {
      await batch.commit();
    } catch (e) {
      archiveStatus = { text: "Couldn't save to archive: " + (e.code || e.message || "unknown error"), error: true };
      archiveBusy = false;
      return;
    }

    archiveStatus = { text: "Archived. Resetting reports for the next period...", error: false };
    try {
      await resetWardReports();
    } catch (e) {
      archiveStatus = { text: "Archived, but resetting the live reports failed: " + (e.code || e.message || "unknown error") + ". Reload and try Save to Archive again to reset them.", error: true };
      archiveBusy = false;
      return;
    }

    goto("/nurses-report/archive-list?type=overall");
  }

  // Puts each ward's live doc back to its empty-state shape for the next
  // 24-hour period. Each ward's just-archived closing Occ is carried
  // forward as the new period's opening census.
  async function resetWardReports() {
    const batch = writeBatch(db);
    WARDS.forEach((w) => {
      const closingOcc = wardData[w.key] && typeof wardData[w.key].occ === "number" ? wardData[w.key].occ : 0;
      batch.set(doc(wardsCol, w.key), defaultWardDoc(w, closingOcc));
    });
    await batch.commit();
  }

  // ---- read-only rendering helpers (mirrors WardShiftTable/computeWardCensus) ----
  function computeWardCensus(w, data) {
    const shifts = data.shifts || {};
    const beds = typeof data.beds === "number" ? data.beds : (w.beds || 0);
    const startOcc = typeof data.startOcc === "number" ? data.startOcc : 0;
    let runningOcc = startOcc;
    const perShiftOcc = {};
    SHIFTS.forEach((s) => {
      runningOcc += occDelta(shifts[s.key] || {});
      if (runningOcc < 0) runningOcc = 0;
      perShiftOcc[s.key] = runningOcc;
    });
    const finalOcc = typeof data.occ === "number" ? data.occ : runningOcc;
    return { beds, perShiftOcc, finalOcc };
  }
  const colSpanAll = 4 + ORDERED_MOVEMENT.length + 1;
</script>

{#snippet wardShiftTable(w, data)}
  {@const census = computeWardCensus(w, data)}
  {@const shifts = data.shifts || {}}
  {@const pmDuty = (shifts.pm || {}).nurseOnDuty}
  <table class="ward-shift">
    <thead>
      <tr>
        <th rowspan="2">Shift</th><th rowspan="2">Beds</th><th rowspan="2">Occ</th><th rowspan="2">Vac</th>
        {#each SOLO_BEFORE as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th colspan="2">Int. Transfer</th><th colspan="2">Ext. Transfer</th>
        {#each SOLO_AFTER as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th rowspan="2">Nurses on Duty</th>
      </tr>
      <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each SHIFTS as s (s.key)}
        {@const sData = shifts[s.key] || {}}
        <tr>
          <td class="shift-name">{s.label}</td>
          <td class="stat-beds">{census.beds}</td>
          <td class="stat-occ">{census.perShiftOcc[s.key]}</td>
          <td class="stat-vac">{census.beds - census.perShiftOcc[s.key]}</td>
          {#each ORDERED_MOVEMENT as f (f.key)}<td class={movementColorClass(f.key)}>{typeof sData[f.key] === "number" ? sData[f.key] : 0}</td>{/each}
          <td style="text-align:left;">{sData.nurseOnDuty || "\u2014"}</td>
        </tr>
      {/each}
      <tr class="total-row">
        <td class="shift-name">Total</td>
        <td class="stat-beds">{census.beds}</td>
        <td class="stat-occ">{census.finalOcc}</td>
        <td class="stat-vac">{census.beds - census.finalOcc}</td>
        {#each ORDERED_MOVEMENT as f (f.key)}<td class={movementColorClass(f.key)}>{typeof data[f.key] === "number" ? data[f.key] : 0}</td>{/each}
        <td style="text-align:left;">{pmDuty || "\u2014"}</td>
      </tr>
    </tbody>
  </table>
{/snippet}

{#snippet wardStatsSection(w, data, labeled)}
  <div class="ward-report-sub">
    {#if labeled}<h3 class="ward-report-subheading">{w.label}</h3>{/if}
    <div class="table-wrap">{@render wardShiftTable(w, data)}</div>
  </div>
{/snippet}

{#snippet groupedWardShiftTable(group, members)}
  {@const memberData = members.map((m) => ({ w: m.w, data: m.data, census: computeWardCensus(m.w, m.data), shifts: m.data.shifts || {} }))}
  {@const totalBeds = memberData.reduce((s, m) => s + m.census.beds, 0)}
  {@const totalOcc = memberData.reduce((s, m) => s + m.census.finalOcc, 0)}
  {@const dutyNames = memberData.map((m) => (m.shifts.pm || {}).nurseOnDuty).filter(Boolean).join(", ")}
  <table class="ward-shift">
    <thead>
      <tr>
        <th rowspan="2">Shift</th><th rowspan="2">Beds</th><th rowspan="2">Occ</th><th rowspan="2">Vac</th>
        {#each SOLO_BEFORE as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th colspan="2">Int. Transfer</th><th colspan="2">Ext. Transfer</th>
        {#each SOLO_AFTER as f (f.key)}<th rowspan="2">{f.label}</th>{/each}
        <th rowspan="2">Nurses on Duty</th>
      </tr>
      <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
    </thead>
    <tbody>
      {#each SHIFTS as s (s.key)}
        <tr class="shift-section-row"><td colspan={colSpanAll}>{s.label === "Am" ? "Morning" : "Night"}</td></tr>
        {#each memberData as m (m.w.key)}
          {@const sData = m.shifts[s.key] || {}}
          <tr>
            <td class="shift-name">{m.w.label}</td>
            <td class="stat-beds">{m.census.beds}</td>
            <td class="stat-occ">{m.census.perShiftOcc[s.key]}</td>
            <td class="stat-vac">{m.census.beds - m.census.perShiftOcc[s.key]}</td>
            {#each ORDERED_MOVEMENT as f (f.key)}<td class={movementColorClass(f.key)}>{typeof sData[f.key] === "number" ? sData[f.key] : 0}</td>{/each}
            <td style="text-align:left;">{sData.nurseOnDuty || "\u2014"}</td>
          </tr>
        {/each}
      {/each}
      <tr class="total-row">
        <td class="shift-name">Total</td>
        <td class="stat-beds">{totalBeds}</td>
        <td class="stat-occ">{totalOcc}</td>
        <td class="stat-vac">{totalBeds - totalOcc}</td>
        {#each ORDERED_MOVEMENT as f (f.key)}
          <td class={movementColorClass(f.key)}>{memberData.reduce((s, m) => s + (typeof m.data[f.key] === "number" ? m.data[f.key] : 0), 0)}</td>
        {/each}
        <td style="text-align:left;">{dutyNames || "\u2014"}</td>
      </tr>
    </tbody>
  </table>
{/snippet}

{#snippet wardPatientSection(w, data, labeled)}
  {@const patients = Array.isArray(data.patients) ? data.patients : []}
  <div class="ward-report-sub">
    {#if labeled}<h3 class="ward-report-subheading">{w.label}</h3>{/if}
    {#if patients.length === 0}
      <div class="no-patients" style="margin-top:10px;">No patient write-ups submitted for this ward.</div>
    {:else}
      {#each patients as p, i (p.id || i)}<PatientBlockView {p} />{/each}
    {/if}
    {#if data.nightUpdate}
      <div class="night-update-block">
        <h3 class="patient-note-label">{"Night Update" + (data.nightUpdateBy ? " — " + data.nightUpdateBy : "") + ":"}</h3>
        <p class="patient-note-text">{data.nightUpdate}</p>
      </div>
    {/if}
  </div>
{/snippet}

<Topbar brand="Overall Nurse">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
  {#if access === "granted"}
    <button class="btn btn-secondary" style="padding:6px 12px;" onclick={() => goto("/nurses-report/archive-list?type=overall")}>{"\uD83D\uDCC1 Archive"}</button>
    <button class="btn btn-primary" style="padding:6px 12px;" onclick={() => window.print()}>Print</button>
  {/if}
</Topbar>

{#if access === "error"}
  <div class="container">
    <div class="card-box" style="text-align:center;">
      <h3 style="margin-top:0;">Couldn't open this report</h3>
      <p style="font-size:13px;color:#555;">{deniedMsg}</p>
      <button class="btn btn-primary" style="padding:8px 14px;" onclick={() => window.location.reload()}>Try Again</button>
    </div>
  </div>
{:else if access === "denied"}
  <div class="container">
    <div class="card-box" style="text-align:center;">
      <h3 style="margin-top:0;">Not the Overall Nurse</h3>
      <p style="font-size:13px;color:#555;">{deniedMsg}</p>
      <button class="btn btn-primary" style="padding:8px 14px;" onclick={() => goto("/nurses-report/role-select")}>Go to Role Selection</button>
    </div>
  </div>
{:else if access === "granted"}
  <div class="container">
    <div class="card-box">
      <h1 class="period-label">{reportPeriodLabel(dateId)}</h1>
      <div class="who-label">{whoLabel}</div>
    </div>

    <div class="card-box">
      <h2>All Wards — 24-Hour Statistics</h2>
      {#if isAdmin}
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
          <button class="btn btn-secondary" style="padding:6px 12px;font-size:13px;" disabled={syncBusy} onclick={resyncOccFromPatients}>
            {syncBusy ? "Syncing…" : "\u21BB Reset Occ from patient list"}
          </button>
          {#if syncStatus.text}<span style={"font-size:12px;color:" + (syncStatus.error ? "#dc2626" : "#16a34a") + ";"}>{syncStatus.text}</span>{/if}
        </div>
      {/if}
      <div class="table-wrap">
        <table class="report">
          <thead>
            <tr>
              <th rowspan="2">Ward</th>
              {#each STAT_FIELDS as f (f.key)}
                {#if f.key === "transferIn"}
                  <th colspan="2" class={isAdmin ? "renamable-col" : undefined}
                    title={isAdmin ? "Click to rename this column" : undefined}
                    onclick={isAdmin ? () => renameGroupHeader(GROUP_LABEL_IDS.intTransfer, groupHeaderLabel(GROUP_LABEL_IDS.intTransfer, "Int. Transfer"), "Int. Transfer") : undefined}>
                    {groupHeaderLabel(GROUP_LABEL_IDS.intTransfer, "Int. Transfer")}
                  </th>
                {:else if f.key === "transferOut"}
                {:else if f.key === "ext"}
                  <th colspan="2" class={isAdmin ? "renamable-col" : undefined}
                    title={isAdmin ? "Click to rename this column" : undefined}
                    onclick={isAdmin ? () => renameGroupHeader(GROUP_LABEL_IDS.extTransfer, groupHeaderLabel(GROUP_LABEL_IDS.extTransfer, "Ext. Transfer"), "Ext. Transfer") : undefined}>
                    {groupHeaderLabel(GROUP_LABEL_IDS.extTransfer, "Ext. Transfer")}
                  </th>
                {:else if f.key === "extOut"}
                {:else}
                  <th rowspan="2" class={isAdmin ? "renamable-col" : undefined}
                    title={isAdmin ? "Click to rename this column" : undefined}
                    onclick={isAdmin ? () => renameBuiltInColumn(f) : undefined}>
                    {fieldLabel(f)}
                  </th>
                {/if}
              {/each}
              {#each customColumnsView as c (c.key)}
                <th rowspan="2" class={isAdmin ? "renamable-col" : undefined}
                  title={isAdmin ? "Click to rename this column" : undefined}
                  onclick={isAdmin ? () => renameCustomColumnPrompt(c) : undefined}>
                  {c.label}
                </th>
              {/each}
              <th rowspan="2">Nurses on Duty</th>
              <th rowspan="2">Access</th>
              {#if isAdmin}
                <th rowspan="2">
                  <button type="button" class="btn btn-secondary" style="padding:3px 8px;font-size:11px;white-space:nowrap;" onclick={addColumnPrompt}>+ Column</button>
                </th>
              {/if}
            </tr>
            <tr>{#each ["In", "Out", "In", "Out"] as l, i (i)}<th>{l}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each WARDS as w (w.key)}
              {@const data = wardData[w.key] || {}}
              {@const locked = !!data.locked}
              <tr>
                <td class={"ward-name" + (isAdmin ? " renamable-col" : "")}
                  title={isAdmin ? "Click to rename this ward" : undefined}
                  onclick={isAdmin ? () => renameWard(w) : undefined}>{wardLabel(w)}</td>
                {#each STAT_FIELDS as f (f.key)}
                  <td class={movementColorClass(f.key)}>{typeof data[f.key] === "number" ? data[f.key] : (f.key === "beds" ? w.beds : 0)}</td>
                {/each}
                {#each customColumnsView as c (c.key)}
                  <td>{data[c.key] || "\u2014"}</td>
                {/each}
                <td style="text-align:left;">
                  {#if data.submittedBy}
                    <button type="button" class="duty-name-btn" onclick={() => openNurseContact(w, data)}>{data.submittedBy}</button>
                  {:else}
                    <span class="duty-name-btn" style="color:#9ca3af;text-decoration:none;">{"\u2014"}</span>
                  {/if}
                </td>
                <td>
                  <button class={"lock-btn " + (locked ? "locked" : "open")} onclick={() => toggleLock(w.key)}>
                    {locked ? "\uD83D\uDD12 Locked" : "\uD83D\uDD13 Open"}
                  </button>
                </td>
                {#if isAdmin}<td></td>{/if}
              </tr>
            {/each}
            <tr class="totals-row">
              <td class="ward-name">TOTAL</td>
              {#each STAT_FIELDS as f (f.key)}<td class={movementColorClass(f.key)}>{totals[f.key]}</td>{/each}
              {#each customColumnsView as c (c.key)}<td></td>{/each}
              <td></td><td></td>
              {#if isAdmin}<td></td>{/if}
            </tr>
          </tbody>
        </table>
      </div>
      <div class="save-status" style={"color:" + (saveStatus.error ? "#dc2626" : "#6b7280") + ";"}>{saveStatus.text}</div>
    </div>

    <div class="card-box">
      <h2>Patient Demographics</h2>
      <div class="table-wrap">
        <table class="report">
          <thead>
            <tr>
              <th>Ward</th>
              {#each DEMOGRAPHIC_FIELDS.filter((f) => f.key !== "child") as f (f.key)}<th>{f.label}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each WARDS as w (w.key)}
              {@const data = wardData[w.key] || {}}
              <tr>
                <td class="ward-name">{wardLabel(w)}</td>
                {#each DEMOGRAPHIC_FIELDS.filter((f) => f.key !== "child") as f (f.key)}<td>{typeof data[f.key] === "number" ? data[f.key] : 0}</td>{/each}
              </tr>
            {/each}
            <tr class="totals-row">
              <td class="ward-name">TOTAL</td>
              {#each DEMOGRAPHIC_FIELDS.filter((f) => f.key !== "child") as f (f.key)}<td>{demoTotals[f.key]}</td>{/each}
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card-box">
      <h2>Ward Reports</h2>
      {#if reportGroups.length === 0}
        <div class="ward-report-empty">No ward reports submitted yet.</div>
      {/if}
      {#each reportGroups as g (g.key)}
        {@const labeled = g.members.length > 1}
        <div class="ward-report-block">
          <h2 class="ward-report-heading">{g.label}</h2>
          {#if g.mergedTable}
            <div class="table-wrap">{@render groupedWardShiftTable(WARD_GROUPS.find((x) => x.key === g.key), g.members)}</div>
          {:else}
            {#each g.members as m ("stats-" + m.w.key)}{@render wardStatsSection(m.w, m.data, labeled)}{/each}
          {/if}
          {#each g.members as m ("patients-" + m.w.key)}{@render wardPatientSection(m.w, m.data, labeled)}{/each}
        </div>
      {/each}
    </div>

    <div class="card-box">
      <h2>Finalize This Report</h2>
      <p style="font-size:12px;color:#555;margin-top:-4px;">
        Once every ward report above looks right, save this 24-hour period to the permanent Ward Charts Archive.
        This files the overall report and all {WARDS.length} ward reports as read-only records. After saving,
        only an admin or subadmin can make corrections to it.
      </p>
      <button class="btn btn-primary" style="padding:10px 16px;" disabled={archiveBusy} onclick={saveToArchive}>{"\uD83D\uDCBE Save to Archive"}</button>
      <div class="save-status" style={"color:" + (archiveStatus.error ? "#dc2626" : "#6b7280") + ";"}>{archiveStatus.text}</div>
    </div>
  </div>
{/if}

<ReportContactModal nurse={contactModal} onClose={() => contactModal = null} />
