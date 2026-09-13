// Ported verbatim from src/pages/IntakeOutput.jsx (framework-agnostic logic,
// split out here so the +page.svelte stays a thin EntryChart config, same
// as Vitals/Seizure).
import { formatDateTime } from './time-format.svelte.js';

// 24-hour I&O periods run 6:00 AM to 6:00 AM the following day (standard
// nursing shift convention) rather than midnight to midnight.
const PERIOD_START_HOUR = 6;

// row.date is "YYYY-MM-DD" and row.time is "HH:MM" (separate entry columns —
// see EntryChart's normalizeRow, which also backfills both from any older
// entry that still only has a single combined datetime string). Combining
// them reconstructs the same local date/time it was entered as.
function rowDateTime(row) {
  return new Date(row.date + 'T' + (row.time || '00:00'));
}

// The 6:00 AM start of the 24-hour period that a given Date falls within
// (a time before 6 AM belongs to the period that started the previous day).
function periodStart(d) {
  const p = new Date(d);
  if (p.getHours() < PERIOD_START_HOUR) p.setDate(p.getDate() - 1);
  p.setHours(PERIOD_START_HOUR, 0, 0, 0);
  return p;
}
function periodKeyOf(row) {
  if (!row.date) return '';
  const d = rowDateTime(row);
  return isNaN(d) ? '' : periodStart(d).toISOString();
}
function periodRangeLabel(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const fmt = d => formatDateTime(d);
  return '24-Hour Balance (' + fmt(start) + ' \u2013 ' + fmt(end) + ')';
}

// Running balance for each entry, resetting to 0 at the start of each 6 AM–6 AM
// period, in strict time order regardless of whether a row is intake or output.
// Once a period has actually ended, a bold period-summary row is inserted right
// after its last entry — maroon when the period closed in deficit — before the
// next period's entries continue below it, restarting from 0.
//
// For a live chart a period only counts as "ended" once the real-world clock has
// passed its 6 AM cutoff (checked against `now`). For a closed admission (discharged/
// referred/transferred), `closeContext.closedAt` is set — the admission's final
// period is force-closed AT THAT MOMENT instead, since a closed record's last
// period will otherwise never reach its normal 6 AM boundary; that summary row's
// label reflects the actual discharge time rather than the usual next-6-AM mark.
// Rows come in oldest→newest; the summary rows keep that order too.
export function deriveIOBalance(ascRows, closeContext) {
  const closedAt = closeContext && closeContext.closedAt instanceof Date && !isNaN(closeContext.closedAt) ? closeContext.closedAt : null;
  const nowKey = periodStart(new Date()).toISOString();
  const out = [];
  let currentKey = null, currentStart = null, running = 0, periodIntake = 0, periodOutput = 0;

  function flushPeriod(isLast) {
    if (currentKey === null) return;
    const closedByClock = currentKey < nowKey;
    const closedByDischarge = isLast && closedAt;
    if (!closedByClock && !closedByDischarge) return;
    const rangeLabel = closedByDischarge
      ? '24-Hour Balance (' + formatDateTime(currentStart) + ' \u2013 ' + (closeContext.closedAtDisplay || formatDateTime(closedAt)) + ', admission closed)'
      : periodRangeLabel(currentStart);
    out.push({
      isPeriodSummary: true,
      summaryText: rangeLabel + ' \u2014 Total Intake: ' + periodIntake + ' ml, Total Output: ' + periodOutput + ' ml, Balance: ' + running + ' ml' + (running < 0 ? ' (deficit)' : ''),
      deficit: running < 0
    });
  }

  ascRows.forEach(row => {
    const key = periodKeyOf(row);
    if (key !== currentKey) {
      flushPeriod(false);
      currentKey = key;
      currentStart = periodStart(rowDateTime(row));
      running = 0; periodIntake = 0; periodOutput = 0;
    }
    const intake = parseFloat(row.intakeAmount) || 0;
    const output = parseFloat(row.outputAmount) || 0;
    running += intake - output;
    periodIntake += intake; periodOutput += output;
    out.push({ ...row, balance: running });
  });
  flushPeriod(true); // the most recent group — closed by clock, by discharge, or (if neither) left open
  return out;
}

// Totals for the current (ongoing) 24-hour period, used by the summary card
// and the auto-saved summary document. For a closed admission this instead
// totals the final period, up through the moment it was closed.
export function computeTodayTotals(rawRows, closeContext) {
  const closedAt = closeContext && closeContext.closedAt instanceof Date && !isNaN(closeContext.closedAt) ? closeContext.closedAt : null;
  let targetKey;
  if (closedAt) {
    const closedRows = rawRows.filter(r => r.date && r.time);
    targetKey = closedRows.length ? periodKeyOf(closedRows[closedRows.length - 1]) : periodStart(closedAt).toISOString();
  } else {
    targetKey = periodStart(new Date()).toISOString();
  }
  let intake = 0, output = 0;
  rawRows.forEach(row => {
    if (periodKeyOf(row) === targetKey) {
      intake += parseFloat(row.intakeAmount) || 0;
      output += parseFloat(row.outputAmount) || 0;
    }
  });
  return { intake, output, balance: intake - output };
}
