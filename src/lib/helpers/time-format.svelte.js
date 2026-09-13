// System-wide clock format (12-hour with AM/PM, or 24-hour). Admin-only
// control on the Admin page; every page that displays a time reads this
// live via Firestore so a change takes effect everywhere — for every nurse,
// on every device — without anyone needing to reload.
//
// Single doc at settings/system, same "one ward, one shared policy" pattern
// as settings/alarm in alarm-settings.js.
import { browser } from "$app/environment";
import { doc, setDoc, onSnapshot, serverTimestamp } from "firebase/firestore";
import { db } from "$lib/firebase.js";

export const TIME_SETTINGS_DOC_PATH = ["settings", "system"];

const CACHE_KEY = "wardcharts-time-format";
const DEFAULT_FORMAT = "24";

function getCachedFormat() {
  if (!browser) return DEFAULT_FORMAT;
  try {
    const saved = localStorage.getItem(CACHE_KEY);
    return saved === "12" || saved === "24" ? saved : DEFAULT_FORMAT;
  } catch (e) {
    return DEFAULT_FORMAT;
  }
}

function createTimeFormatState() {
  // Seeded from the last-known value (localStorage) so pages render with the
  // right format immediately, then kept in sync with Firestore — the same
  // "cached-first, live-synced" approach push.js already uses for settings.
  let format = $state(getCachedFormat());
  let ready = $state(!browser); // true once the first Firestore snapshot has arrived (or we're on the server)

  if (browser && db) {
    onSnapshot(
      doc(db, ...TIME_SETTINGS_DOC_PATH),
      (snap) => {
        const val = snap.exists() ? snap.data().timeFormat : null;
        format = val === "12" ? "12" : DEFAULT_FORMAT;
        ready = true;
        try {
          localStorage.setItem(CACHE_KEY, format);
        } catch (e) {
          /* ignore */
        }
      },
      () => {
        // Offline, no permission yet, doc doesn't exist, etc. — keep
        // whatever we already had cached rather than breaking every
        // timestamp in the app.
        ready = true;
      }
    );
  }

  return {
    get format() {
      return format;
    },
    get is12Hour() {
      return format === "12";
    },
    get ready() {
      return ready;
    },
    async setFormat(next) {
      const clean = next === "12" ? "12" : "24";
      format = clean;
      try {
        localStorage.setItem(CACHE_KEY, clean);
      } catch (e) {
        /* ignore */
      }
      await setDoc(
        doc(db, ...TIME_SETTINGS_DOC_PATH),
        { timeFormat: clean, updatedAt: serverTimestamp() },
        { merge: true }
      );
      return clean;
    }
  };
}

export const timeFormatState = createTimeFormatState();

// Accepts a Date, a Firestore Timestamp (anything with .toDate()), an ISO
// string, or an epoch number — every shape that shows up across the app's
// various "at"/"exportedAt"/"archivedAtDisplay" style fields.
function toDateSafe(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") {
    try {
      return value.toDate();
    } catch (e) {
      return null;
    }
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Drop-in replacement for `date.toLocaleTimeString()` that respects the
// admin's chosen system time format instead of the browser's locale default.
export function formatTime(value, opts = {}) {
  const d = toDateSafe(value);
  if (!d) return "";
  return d.toLocaleTimeString([], {
    hour: opts.hour || "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" } : {}),
    hour12: timeFormatState.is12Hour
  });
}

// Drop-in replacement for `date.toLocaleString()` — date portion always
// follows the browser locale (day/month order etc.); only the time portion
// switches between 12-hour AM/PM and 24-hour.
export function formatDateTime(value, opts = {}) {
  const d = toDateSafe(value);
  if (!d) return "";
  const datePart = d.toLocaleDateString(
    [],
    opts.dateStyle ? { dateStyle: opts.dateStyle } : { month: "short", day: "numeric", ...(opts.year ? { year: "numeric" } : {}) }
  );
  return datePart + " " + formatTime(d, opts);
}
