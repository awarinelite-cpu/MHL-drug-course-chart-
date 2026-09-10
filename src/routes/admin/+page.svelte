<script>
  // Ported from src/pages/Admin.jsx. React state becomes $state runes;
  // useAuth()/useGoBack/useNavigate become authState/window.history.back()/
  // goto(), same pattern as My Patients, Patient, and Profile. The
  // secondary-Firebase-app trick for creating a nurse account without
  // signing the admin out of their own session is unchanged.
  import { goto } from "$app/navigation";
  import { initializeApp, deleteApp } from "firebase/app";
  import { getAuth, createUserWithEmailAndPassword, signOut } from "firebase/auth";
  import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";
  import { getFunctions, httpsCallable } from "firebase/functions";
  import { app, db, firebaseConfig } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { downloadFullBackup } from "$lib/helpers/export.js";
  import { avatarMarkup } from "$lib/helpers/avatar.js";
  import {
    SOUND_OPTIONS, APPEARANCE_OPTIONS, REPEAT_OPTIONS, ALL_FREQUENCIES, GLUCOSE_INTERVAL_OPTIONS,
    OVERDUE_REPEAT_OPTIONS, loadAlarmSettings, saveAlarmSettings as persistAlarmSettings
  } from "$lib/helpers/alarm-settings.js";
  import Topbar from "$lib/components/Topbar.svelte";

  // Every chart type and archived-admission record a patient can accumulate.
  // Firestore doesn't cascade-delete subcollections when the parent doc is
  // removed, so each one has to be cleared out explicitly first, or the data
  // would keep sitting there orphaned (invisible in the app, but still using
  // storage and still technically recoverable — not acceptable for a real delete).
  const PATIENT_SUBCOLLECTIONS = ["admissions", "bloodGlucose", "drugCourseChart", "intakeOutput", "intakeOutputSummary", "seizure", "vitals"];

  // Normalizes typed confirmation text before comparing: trims edge whitespace,
  // collapses internal whitespace, and lowercases. Mobile keyboards (especially
  // in a PWA/WebView) can silently inject a trailing space via autocomplete/
  // suggestion-bar taps or auto-capitalize the first character, which made the
  // old exact-match check fail even when the admin typed the right EMR.
  function normalizeConfirmText(s) {
    return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  const functionsInstance = getFunctions(app);
  const deleteUserAccountFn = httpsCallable(functionsInstance, "deleteUserAccount");

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  let users = $state([]);
  let name = $state("");
  let email = $state("");
  let password = $state("");
  let gender = $state("");
  /** @type {{type: 'error'|'info', text: string} | null} */
  let msg = $state(null);

  let allPatients = $state([]);
  let patientFilter = $state("");
  let patientStatus = $state("");

  // Delete modal is shared between patients and users — deleteTarget.type
  // says which one confirmDelete() below should act on.
  /** @type {{type: 'patient'|'user', record: any} | null} */
  let deleteTarget = $state(null);
  let deleteInput = $state("");
  let deleteError = $state("");
  let userDeletingId = $state(null);

  /** @type {any | null} */
  let alarm = $state(null); // null while loading
  let freqChecked = $state({});
  let alarmSaving = $state(false);
  /** @type {{type: 'error'|'info', text: string} | null} */
  let alarmMsg = $state(null);

  let backupRunning = $state(false);
  let backupStatus = $state("");

  loadUsers();
  loadPatients();
  (async () => {
    const settings = await loadAlarmSettings(db);
    alarm = settings;
    const checked = {};
    ALL_FREQUENCIES.forEach(f => { checked[f] = settings.frequencies.includes(f); });
    freqChecked = checked;
  })();

  async function loadUsers() {
    const snap = await getDocs(collection(db, "users"));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    users = list;
  }

  async function loadPatients() {
    const snap = await getDocs(collection(db, "patients"));
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    allPatients = list;
  }

  async function handleLogout() {
    await authState.logout();
    goto("/login");
  }

  async function runBackup() {
    backupRunning = true;
    try {
      const result = await downloadFullBackup(authState.profile.name, (done, total) => {
        backupStatus = "Backing up patient " + done + " of " + total + "…";
      });
      backupStatus = "Done — " + result.count + " patient record(s) saved to your downloads.";
    } catch (e) {
      backupStatus = "Backup failed: " + (e.message || e.code || "unknown error");
    } finally {
      backupRunning = false;
    }
  }

  async function createNurse() {
    msg = null;
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail || password.length < 6) {
      msg = { type: "error", text: "Fill in all fields; password needs at least 6 characters." };
      return;
    }
    try {
      const secondaryApp = initializeApp(firebaseConfig, "Secondary-" + Date.now());
      const secondaryAuth = getAuth(secondaryApp);
      const cred = await createUserWithEmailAndPassword(secondaryAuth, trimmedEmail, password);
      await setDoc(doc(db, "users", cred.user.uid), {
        name: trimmedName, email: trimmedEmail, gender, role: "nurse", createdAt: serverTimestamp()
      });
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      msg = { type: "info", text: "Nurse account created for " + trimmedEmail + "." };
      name = ""; email = ""; password = ""; gender = "";
      loadUsers();
    } catch (e) {
      msg = { type: "error", text: e.message || "Failed to create account." };
    }
  }

  let filteredPatients = $derived.by(() => {
    const q = patientFilter.trim().toLowerCase();
    return !q ? allPatients : allPatients.filter(p =>
      (p.name || "").toLowerCase().includes(q) || (p.emr || "").toLowerCase().includes(q) || (p.ward || "").toLowerCase().includes(q)
    );
  });

  function openPatient(p) { goto("/charts/overview?patient=" + p.id); }

  function openDeletePatientModal(p) {
    deleteTarget = { type: "patient", record: p };
    deleteInput = "";
    deleteError = "";
  }

  function openDeleteUserModal(u) {
    if (u.id === authState.user.uid) { alert("You can't delete your own account."); return; }
    deleteTarget = { type: "user", record: u };
    deleteInput = "";
    deleteError = "";
  }

  function closeDeleteModal() { deleteTarget = null; }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { type, record } = deleteTarget;
    const expected = type === "patient" ? ((record.emr || "").trim() || "DELETE") : ((record.email || "").trim() || "DELETE");
    if (normalizeConfirmText(deleteInput) !== normalizeConfirmText(expected)) {
      deleteError = "That didn't match — nothing was deleted. Please re-type it exactly.";
      return;
    }
    deleteTarget = null;
    if (type === "patient") await runDeletePatient(record);
    else await runDeleteUser(record);
  }

  async function runDeletePatient(p) {
    patientStatus = "Deleting " + (p.name || "patient") + "…";
    async function deleteAllInSubcollection(sub) {
      const snap = await getDocs(collection(db, "patients", p.id, sub));
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, "patients", p.id, sub, d.id))));
    }
    try {
      await Promise.all(PATIENT_SUBCOLLECTIONS.map(deleteAllInSubcollection));
      await deleteDoc(doc(db, "patients", p.id));
    } catch (e) {
      alert("Delete failed: " + (e.code || e.message || "unknown error"));
      patientStatus = "";
      return;
    }
    allPatients = allPatients.filter(x => x.id !== p.id);
    patientStatus = "";
  }

  async function runDeleteUser(u) {
    userDeletingId = u.id;
    try {
      await deleteUserAccountFn({ uid: u.id });
    } catch (e) {
      alert("Delete failed: " + (e.message || e.code || "unknown error"));
      userDeletingId = null;
      loadUsers();
      return;
    }
    userDeletingId = null;
    loadUsers();
  }

  async function setUserRole(u, newRole) {
    try {
      await updateDoc(doc(db, "users", u.id), { role: newRole });
    } catch (e) {
      alert("Couldn't update role: " + (e.code || e.message || "unknown error"));
    }
    loadUsers();
  }

  function toggleFreq(f) { freqChecked = { ...freqChecked, [f]: !freqChecked[f] }; }

  async function saveAlarmSettings() {
    const selectedFrequencies = ALL_FREQUENCIES.filter(f => freqChecked[f]);
    if (!selectedFrequencies.length) {
      alarmMsg = { type: "error", text: "Select at least one frequency, or nurses will never get an alert." };
      return;
    }
    alarmSaving = true;
    alarmMsg = null;
    try {
      const saved = await persistAlarmSettings(db, { ...alarm, frequencies: selectedFrequencies });
      alarm = saved;
      alarmMsg = { type: "info", text: "Alarm settings saved." };
    } catch (e) {
      alarmMsg = { type: "error", text: e.message || "Failed to save alarm settings." };
    } finally {
      alarmSaving = false;
    }
  }

  let deleteLabel = $derived(
    deleteTarget?.type === "patient"
      ? (deleteTarget.record.name || "Unnamed") + " (EMR: " + (deleteTarget.record.emr || "N/A") + ")"
      : deleteTarget ? (deleteTarget.record.name || "Unnamed") + " (" + (deleteTarget.record.email || "no email on file") + ")" : ""
  );
  let deletePromptLabel = $derived(
    deleteTarget?.type === "patient"
      ? ((deleteTarget.record.emr || "").trim() ? ("Type the patient's EMR number to confirm: " + deleteTarget.record.emr) : "No EMR on file — type DELETE to confirm")
      : deleteTarget ? ((deleteTarget.record.email || "").trim() ? ("Type the user's email to confirm: " + deleteTarget.record.email) : "No email on file — type DELETE to confirm") : ""
  );
</script>

{#if authState.profile}
  <Topbar brand="68 NARHY Ward Charts — Admin">
    <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back Home</button>
    <button class="btn btn-secondary" style="padding:6px 12px;" onclick={handleLogout}>Log Out</button>
  </Topbar>

  <div class="container">
    <div class="card-box">
      <h3 style="margin-top:0;">Create Nurse Account</h3>
      <div class="field"><label for="admin-name">Full Name</label><input id="admin-name" type="text" bind:value={name} /></div>
      <div class="field"><label for="admin-email">Email</label><input id="admin-email" type="email" bind:value={email} /></div>
      <div class="field"><label for="admin-password">Temporary Password</label><input id="admin-password" type="text" placeholder="At least 6 characters" bind:value={password} /></div>
      <div class="field">
        <label for="admin-gender">Gender</label>
        <select id="admin-gender" bind:value={gender}>
          <option value="">Select gender…</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
      </div>
      <button class="btn btn-primary" onclick={createNurse}>Create Account</button>
      {#if msg}
        <div class={msg.type === "error" ? "error-msg" : "info-msg"}>{msg.text}</div>
      {/if}
      <p style="font-size:12px;color:#666;margin-top:10px;">
        Share this email and temporary password with the nurse directly. They can change it anytime using
        "Forgot password?" on the login page, which sends a reset link to their own email.
      </p>
    </div>

    <div class="card-box">
      <h3 style="margin-top:0;">All Patients</h3>
      <div class="search-row">
        <input type="text" placeholder="Filter by name, EMR, or ward" bind:value={patientFilter} />
      </div>
      <div style="font-size:12px;color:#666;margin-top:6px;">
        {patientStatus || (filteredPatients.length + " of " + allPatients.length + " patient(s)" + (patientFilter.trim() ? " matching \"" + patientFilter.trim() + "\"" : ""))}
      </div>
      <div class="table-wrap">
        <table class="entries">
          <thead><tr><th>Name</th><th>EMR</th><th>Ward</th><th>Diagnosis</th><th>Admission Date</th><th></th></tr></thead>
          <tbody>
            {#if !filteredPatients.length}
              <tr><td colspan="6" style="color:#666;">No patients found.</td></tr>
            {/if}
            {#each filteredPatients as p (p.id)}
              <tr>
                <td style="text-align:left;cursor:pointer;" title={"Open " + (p.name || "this patient") + "'s overview"} onclick={() => openPatient(p)}>{p.name || "Unnamed"}</td>
                <td style="cursor:pointer;" onclick={() => openPatient(p)}>{p.emr || "-"}</td>
                <td style="cursor:pointer;" onclick={() => openPatient(p)}>{p.ward || "-"}</td>
                <td style="text-align:left;cursor:pointer;" onclick={() => openPatient(p)}>{p.diagnosis || "Not specified"}</td>
                <td style="cursor:pointer;" onclick={() => openPatient(p)}>{p.admissionDate || "-"}</td>
                <td>
                  <button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;background:#dc2626;color:#fff;border:none;"
                    onclick={(e) => { e.stopPropagation(); openDeletePatientModal(p); }}>Delete</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card-box">
      <h3 style="margin-top:0;">All Users</h3>
      <div class="table-wrap">
        <table class="entries">
          <thead><tr><th></th><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
          <tbody>
            {#each users as u (u.id)}
              <tr>
                <td>{@html avatarMarkup(u, 32)}</td>
                <td>{u.name || ""}</td><td>{u.email || ""}</td><td>{u.role || ""}</td>
                <td>
                  {#if u.id !== authState.user.uid && (u.role === "nurse" || u.role === "subadmin")}
                    <button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;margin-right:6px;"
                      onclick={() => setUserRole(u, u.role === "subadmin" ? "nurse" : "subadmin")}>
                      {u.role === "subadmin" ? "Remove Subadmin" : "Make Subadmin"}
                    </button>
                  {/if}
                  {#if u.id !== authState.user.uid}
                    <button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;background:#dc2626;color:#fff;border:none;"
                      disabled={userDeletingId === u.id} onclick={() => openDeleteUserModal(u)}>
                      {userDeletingId === u.id ? "Deleting…" : "Delete"}
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card-box">
      <h3 style="margin-top:0;">Drug-Due Alarm Settings</h3>
      <p style="font-size:12px;color:#666;margin-top:-6px;">
        Controls the alert nurses get when a drug dose is due — see "Alerts" on the Profile page for how a nurse
        opts a device in. Changes here apply to every nurse's device; already-open tabs pick them up live, no
        reload needed.
      </p>
      {#if alarm}
        <div class="field">
          <label for="alarm-sound">Alarm Sound</label>
          <select id="alarm-sound" value={alarm.sound} onchange={(e) => alarm = { ...alarm, sound: e.target.value }}>
            {#each SOUND_OPTIONS as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="alarm-appearance">Alarm Type (how it appears)</label>
          <select id="alarm-appearance" value={alarm.appearance} onchange={(e) => alarm = { ...alarm, appearance: e.target.value }}>
            {#each APPEARANCE_OPTIONS as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="alarm-repeat">Repeat Behavior</label>
          <select id="alarm-repeat" value={alarm.repeat} onchange={(e) => alarm = { ...alarm, repeat: e.target.value }}>
            {#each REPEAT_OPTIONS as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label>
            <input type="checkbox" style="width:auto;margin-right:6px;vertical-align:middle;"
              checked={alarm.quietHours.enabled} onchange={(e) => alarm = { ...alarm, quietHours: { ...alarm.quietHours, enabled: e.target.checked } }} />
            Quiet Hours (mute alerts overnight)
          </label>
        </div>
        <div style="display:flex;gap:10px;">
          <div class="field" style="flex:1;">
            <label for="alarm-quiet-start">Quiet From</label>
            <input id="alarm-quiet-start" type="time" value={alarm.quietHours.start} onchange={(e) => alarm = { ...alarm, quietHours: { ...alarm.quietHours, start: e.target.value } }} />
          </div>
          <div class="field" style="flex:1;">
            <label for="alarm-quiet-end">Quiet Until</label>
            <input id="alarm-quiet-end" type="time" value={alarm.quietHours.end} onchange={(e) => alarm = { ...alarm, quietHours: { ...alarm.quietHours, end: e.target.value } }} />
          </div>
        </div>
        <div class="field">
          <label for="alarm-overdue">Repeat While Overdue</label>
          <select id="alarm-overdue" value={String(alarm.overdueRepeatMinutes)} onchange={(e) => alarm = { ...alarm, overdueRepeatMinutes: Number(e.target.value) }}>
            {#each OVERDUE_REPEAT_OPTIONS as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
          <p style="font-size:12px;color:#666;margin:2px 0 0;">
            If a dose stays overdue (not yet given), nurses keep getting pushed a reminder at this interval
            until it's given — instead of only the one alert when it first became due.
          </p>
        </div>
        <div class="field">
          <label for="alarm-frequencies">Alarm Schedule — Which Frequencies Alert</label>
          <div id="alarm-frequencies" style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:4px;">
            {#each ALL_FREQUENCIES as f (f)}
              <label style="display:flex;align-items:center;gap:5px;font-weight:normal;font-size:13px;">
                <input type="checkbox" style="width:auto;" checked={!!freqChecked[f]} onchange={() => toggleFreq(f)} />{f}
              </label>
            {/each}
          </div>
        </div>

        <hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0;" />

        <div class="field">
          <label>
            <input type="checkbox" style="width:auto;margin-right:6px;vertical-align:middle;"
              checked={alarm.glucose.enabled} onchange={(e) => alarm = { ...alarm, glucose: { ...alarm.glucose, enabled: e.target.checked } }} />
            Glycemic Check Reminders
          </label>
          <p style="font-size:12px;color:#666;margin:2px 0 0;">
            Reminds nurses when a patient's blood glucose reading is overdue, timed from their last recorded
            reading (see the Time column on the Glycemic Chart) — same alarm sound/appearance/quiet-hours above.
          </p>
        </div>
        <div class="field">
          <label for="alarm-glucose-interval">Remind Every</label>
          <select id="alarm-glucose-interval" value={String(alarm.glucose.intervalHours)} onchange={(e) => alarm = { ...alarm, glucose: { ...alarm.glucose, intervalHours: Number(e.target.value) } }}>
            {#each GLUCOSE_INTERVAL_OPTIONS as o (o.value)}
              <option value={o.value}>{o.label}</option>
            {/each}
          </select>
        </div>

        <button class="btn btn-primary" disabled={alarmSaving} onclick={saveAlarmSettings}>Save Alarm Settings</button>
        {#if alarmMsg}
          <div class={alarmMsg.type === "error" ? "error-msg" : "info-msg"}>{alarmMsg.text}</div>
        {/if}
      {/if}
    </div>

    <div class="card-box">
      <h3 style="margin-top:0;">Backup All Patients</h3>
      <p style="font-size:12px;color:#666;margin-top:-6px;">
        Downloads every patient's full record (active + closed admissions) as one JSON file, independent of
        Firestore — for legal/audit purposes or disaster recovery. This runs on demand rather than a fixed
        schedule — save the file somewhere safe (e.g. Google Drive) and run it on whatever cadence you want,
        e.g. weekly.
      </p>
      <button class="btn btn-primary" disabled={backupRunning} onclick={runBackup}>Download Full Backup (JSON)</button>
      <div style="font-size:12px;color:#555;margin-top:8px;">{backupStatus}</div>
    </div>
  </div>

  {#if deleteTarget}
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;">
      <div class="card-box" style="max-width:420px;width:100%;margin:0;">
        <h3 style="margin-top:0;color:#dc2626;">{deleteTarget.type === "patient" ? "Delete Patient" : "Delete User"}</h3>
        <p style="font-size:14px;color:#374151;">
          {deleteTarget.type === "patient"
            ? "This permanently deletes " + deleteLabel + " and every chart, drug list, and closed-admission record for this patient. This cannot be undone."
            : "This permanently removes " + deleteLabel + "'s account and sign-in access. This cannot be undone."}
        </p>
        <div class="field">
          <label for="delete-confirm-input">{deletePromptLabel}</label>
          <input id="delete-confirm-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
            bind:value={deleteInput}
            onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmDelete(); } else if (e.key === "Escape") closeDeleteModal(); }} />
        </div>
        {#if deleteError}
          <div class="error-msg">{deleteError}</div>
        {/if}
        <div style="display:flex;gap:10px;margin-top:6px;">
          <button class="btn btn-secondary" style="flex:1;" onclick={closeDeleteModal}>Cancel</button>
          <button class="btn" style="flex:1;background:#dc2626;color:#fff;" onclick={confirmDelete}>Delete</button>
        </div>
      </div>
    </div>
  {/if}
{/if}
