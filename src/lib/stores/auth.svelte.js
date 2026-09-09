import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase.js";
import { browser } from "$app/environment";

// Ported from src/contexts/AuthContext.jsx. React's useState/useContext
// becomes plain $state runes on a module-level object — Svelte doesn't need
// a Context/Provider wrapper for app-wide state like this, any component can
// just `import { authState } from "$lib/stores/auth.svelte.js"` and read it
// reactively.
function createAuthState() {
  let user = $state(null);
  let profile = $state(null);
  /** @type {'loading'|'ready'|'signed-out'|'error'} */
  let status = $state("loading");
  let error = $state(null);

  if (browser) {
    onAuthStateChanged(auth, async (u) => {
      if (!u) {
        user = null;
        profile = null;
        status = "signed-out";
        return;
      }

      const userRef = doc(db, "users", u.uid);
      let snap;
      try {
        snap = await getDoc(userRef);
      } catch (e) {
        error = "Couldn't reach the database: " + (e.code || e.message || "unknown error") +
          " — make sure Firestore Database has been created for this Firebase project.";
        status = "error";
        return;
      }

      // Every account has to be created by an admin (via the Admin page) —
      // there's no self-service signup and no seed-admin bootstrap, so a
      // signed-in Firebase Auth user with no matching Firestore profile
      // means their account isn't fully set up yet.
      if (!snap.exists()) {
        error = "Your account isn't set up yet. Please contact your admin.";
        status = "error";
        await signOut(auth);
        return;
      }

      user = u;
      profile = snap.data();
      status = "ready";
    });
  }

  return {
    get user() { return user; },
    get profile() { return profile; },
    get status() { return status; },
    get error() { return error; },
    updateLocalProfile(patch) { profile = { ...profile, ...patch }; },
    logout() { return signOut(auth); }
  };
}

export const authState = createAuthState();
