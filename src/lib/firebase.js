import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { browser } from "$app/environment";

export const firebaseConfig = {
  apiKey: "AIzaSyBLEzC5MusezdNS8RnDQQA8xoI7XbXEqiM",
  authDomain: "gen-lang-client-0406053716.firebaseapp.com",
  projectId: "gen-lang-client-0406053716",
  storageBucket: "gen-lang-client-0406053716.firebasestorage.app",
  messagingSenderId: "922657172970",
  appId: "1:922657172970:web:f7a5c8f6ce8bb536d0d693"
};

// SvelteKit modules can be evaluated during SSR/prerender, where none of
// the Firebase client SDKs (which assume window/indexedDB) are usable.
// This whole app is client-only (see +layout.js: `export const ssr = false`),
// so we simply skip initialization on the server and only ever construct
// the real app/auth/db instances in the browser.
export const app = browser && !getApps().length ? initializeApp(firebaseConfig) : (browser ? getApps()[0] : null);
export const auth = browser ? getAuth(app) : null;

// Offline-first: reads/writes go through a local IndexedDB cache first. Entries
// made with no network queue locally and are marked with hasPendingWrites until
// they reach the server; the SDK flushes that queue automatically as soon as
// the connection comes back. persistentMultipleTabManager lets more than one
// open tab/window share the same local cache safely.
export const db = browser
  ? initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    })
  : null;
