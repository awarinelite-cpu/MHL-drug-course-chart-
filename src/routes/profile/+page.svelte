<script>
  // Ported from src/pages/Profile.jsx. useAuth()'s user/profile/logout become
  // authState (see $lib/stores/auth.svelte.js); useNavigate/useGoBack become
  // goto()/window.history.back(), matching the pattern already used on
  // My Patients and Patient. Dose Due Alerts (push.js) aren't ported yet —
  // push notifications and the service worker are still on the "not yet
  // ported" list in the README, so that card is a disabled placeholder for
  // now instead of a broken toggle.
  import { goto } from "$app/navigation";
  import { doc, updateDoc } from "firebase/firestore";
  import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "firebase/auth";
  import { db } from "$lib/firebase.js";
  import { authState } from "$lib/stores/auth.svelte.js";
  import { avatarMarkup } from "$lib/helpers/avatar.js";
  import { WARD_OPTIONS } from "$lib/helpers/drugChartHelpers.js";
  import Topbar from "$lib/components/Topbar.svelte";

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/");
  }

  let name = $state(authState.profile?.name || "");
  let phone = $state(authState.profile?.phone || "");
  let gender = $state(authState.profile?.gender || "");
  /** @type {{type: 'error'|'info', text: string} | null} */
  let pfMsg = $state(null);

  let curpw = $state("");
  let newpw = $state("");
  let newpw2 = $state("");
  /** @type {{type: 'error'|'info', text: string} | null} */
  let pwMsg = $state(null);

  let wardBusy = $state(false);
  /** @type {{type: 'error'|'info', text: string} | null} */
  let wardMsg = $state(null);

  // Keep the edit fields in sync if the profile loads/changes after mount
  // (e.g. auth resolves after this page has already rendered once).
  $effect(() => {
    if (authState.profile) {
      name = authState.profile.name || "";
      phone = authState.profile.phone || "";
      gender = authState.profile.gender || "";
    }
  });

  async function handleLogout() {
    await authState.logout();
    goto("/login");
  }

  async function saveProfile() {
    pfMsg = null;
    const trimmedName = name.trim();
    if (!trimmedName) { pfMsg = { type: "error", text: "Name cannot be empty." }; return; }
    const updates = { name: trimmedName, phone: phone.trim(), gender };
    try {
      await updateDoc(doc(db, "users", authState.user.uid), updates);
    } catch (e) {
      pfMsg = { type: "error", text: "Save failed: " + (e.code || e.message || "unknown error") };
      return;
    }
    authState.updateLocalProfile(updates);
    pfMsg = { type: "info", text: "Profile updated." };
  }

  // Switches immediately on selection — a quick "I've moved wards" action
  // for the start of a shift or a ward transfer, not bundled with the rest
  // of the profile-edit form below.
  async function changeWard(newWard) {
    wardBusy = true;
    wardMsg = null;
    try {
      await updateDoc(doc(db, "users", authState.user.uid), { ward: newWard });
      authState.updateLocalProfile({ ward: newWard });
      wardMsg = { type: "info", text: newWard ? "Switched to " + newWard + "." : "Cleared — you'll see patients from every ward on Home." };
    } catch (e) {
      wardMsg = { type: "error", text: "Could not switch ward: " + (e.code || e.message || "unknown error") };
    }
    wardBusy = false;
  }

  async function changePassword() {
    pwMsg = null;
    if (!curpw || newpw.length < 6) {
      pwMsg = { type: "error", text: "Enter your current password and a new one with at least 6 characters." };
      return;
    }
    if (newpw !== newpw2) { pwMsg = { type: "error", text: "New passwords do not match." }; return; }
    try {
      const cred = EmailAuthProvider.credential(authState.user.email, curpw);
      await reauthenticateWithCredential(authState.user, cred);
      await updatePassword(authState.user, newpw);
    } catch (e) {
      pwMsg = { type: "error", text: e.code === "auth/wrong-password" ? "Current password is incorrect." : (e.message || "Failed to update password.") };
      return;
    }
    curpw = ""; newpw = ""; newpw2 = "";
    pwMsg = { type: "info", text: "Password updated." };
  }
</script>

{#if authState.profile}
  <Topbar brand="My Profile">
    <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
    <button class="btn btn-secondary" style="padding:6px 12px;" onclick={handleLogout}>Log Out</button>
  </Topbar>

  <div class="container">
    <div class="card-box">
      <h3 style="margin-top:0;">Current Ward</h3>
      <div class="field">
        <label for="profile-ward">You're seeing patients from this ward on Home</label>
        <select id="profile-ward" value={authState.profile.ward || ""} disabled={wardBusy}
          onchange={(e) => changeWard(e.target.value)}>
          <option value="">All Wards (not set)</option>
          {#each WARD_OPTIONS as w (w)}
            <option value={w}>{w}</option>
          {/each}
        </select>
      </div>
      {#if wardMsg}
        <div class={wardMsg.type === "error" ? "error-msg" : "info-msg"}>{wardMsg.text}</div>
      {/if}
    </div>

    <div class="card-box">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px;">
        <div class="avatar">{@html avatarMarkup({ name, gender }, 56)}</div>
        <div>
          <div style="font-size:18px;font-weight:bold;">{authState.profile.name || "Unnamed"}</div>
          <span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:bold;text-transform:uppercase;background:#eff6ff;color:#1d4ed8;margin-top:4px;">
            {authState.profile.role || ""}
          </span>
        </div>
      </div>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />

      <div class="field"><label for="profile-name">Full Name</label><input id="profile-name" type="text" bind:value={name} /></div>
      <div class="field"><label for="profile-phone">Phone Number</label><input id="profile-phone" type="text" placeholder="e.g. 080XXXXXXXX" bind:value={phone} /></div>
      <div class="field">
        <label for="profile-gender">Gender</label>
        <select id="profile-gender" bind:value={gender}>
          <option value="">Select gender…</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
      </div>

      <div class="field">
        <label for="profile-email">Email</label>
        <div id="profile-email" style="padding:10px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;font-size:14px;color:#374151;">
          {authState.profile.email || authState.user?.email || ""}
        </div>
      </div>
      <div class="field">
        <label for="profile-role">Role</label>
        <div id="profile-role" style="padding:10px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;font-size:14px;color:#374151;">
          {authState.profile.role || ""}
        </div>
      </div>

      <button class="btn btn-primary" onclick={saveProfile}>Save Changes</button>
      {#if pfMsg}
        <div class={pfMsg.type === "error" ? "error-msg" : "info-msg"} style="margin-top:10px;">{pfMsg.text}</div>
      {/if}
    </div>

    <div class="card-box">
      <h3 style="margin-top:0;">Dose Due Alerts</h3>
      <button class="btn btn-primary" disabled title="Coming soon — push notifications aren't wired up in this build yet.">
        Not available in this build yet
      </button>
      <div class="info-msg" style="margin-top:10px;">
        Dose Due Alerts need push notifications and a service worker, which haven't been ported to this app yet.
      </div>
    </div>

    <div class="card-box">
      <h3 style="margin-top:0;">Change Password</h3>
      <div class="field"><label for="profile-curpw">Current Password</label><input id="profile-curpw" type="password" bind:value={curpw} /></div>
      <div class="field"><label for="profile-newpw">New Password</label><input id="profile-newpw" type="password" placeholder="At least 6 characters" bind:value={newpw} /></div>
      <div class="field"><label for="profile-newpw2">Confirm New Password</label><input id="profile-newpw2" type="password" bind:value={newpw2} /></div>
      <button class="btn btn-purple" onclick={changePassword}>Update Password</button>
      {#if pwMsg}
        <div class={pwMsg.type === "error" ? "error-msg" : "info-msg"} style="margin-top:10px;">{pwMsg.text}</div>
      {/if}
    </div>
  </div>
{/if}
