<script>
  // Ported from src/pages/nurses-report/Analytics.jsx. Refs become
  // bind:this locals; useEffect chart-drawing becomes $effect blocks.
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { collection, query, where, getDocs } from "firebase/firestore";
  import Chart from "chart.js/auto";
  import { db } from "$lib/firebase.js";
  import { themeState } from "$lib/stores/theme.svelte.js";
  import {
    WARDS, DEMOGRAPHIC_FIELDS, STAT_FIELDS, OCC_INCREASE_KEYS, OCC_DECREASE_KEYS,
    reportDateId, weekId
  } from "$lib/helpers/nursesReportCommon.js";
  import { shadeHex, barFrontGradient, pieFrontGradient, bar3dPlugin, pieDepthPlugin, dropShadowPlugin } from "$lib/helpers/chart3d.js";
  import Topbar from "$lib/components/Topbar.svelte";

  const CLINICAL_KEYS = ["adm", "death", "bid", "sc", "vsc"];
  const CLINICAL_FIELDS = CLINICAL_KEYS.map(k => STAT_FIELDS.find(f => f.key === k)).filter(Boolean);

  const MOVEMENT_KEYS = OCC_INCREASE_KEYS.concat(OCC_DECREASE_KEYS);
  const MOVEMENT_FIELDS = STAT_FIELDS
    .filter(f => MOVEMENT_KEYS.includes(f.key))
    .map(f => ({ key: f.key, label: f.label, direction: OCC_INCREASE_KEYS.includes(f.key) ? "increase" : "decrease" }));

  const NEUTRAL_FIELDS = CLINICAL_FIELDS
    .filter(f => !MOVEMENT_KEYS.includes(f.key))
    .map(f => ({ key: f.key, label: f.label, direction: "neutral" }));
  const MOVEMENT_GRID_FIELDS = MOVEMENT_FIELDS.concat(NEUTRAL_FIELDS);

  const ALL_NUMERIC_FIELDS = (() => {
    const seen = new Set();
    const out = [];
    CLINICAL_FIELDS.concat(MOVEMENT_FIELDS, DEMOGRAPHIC_FIELDS).forEach(f => {
      if (seen.has(f.key)) return;
      seen.add(f.key);
      out.push(f);
    });
    return out;
  })();

  function pad(n) { return String(n).padStart(2, "0"); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addDaysId(dateId, days) {
    const [y, m, d] = dateId.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate());
  }
  function isoWeekNumber(d) {
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
    return 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  }

  function computeRange(period, selection) {
    const todayId = reportDateId();
    let startId, endId;
    if (period === "today") {
      startId = endId = selection || todayId;
    } else if (period === "week") {
      let monday;
      if (selection) {
        const jan4 = new Date(Date.UTC(selection.isoYear, 0, 4));
        const ref = new Date(jan4);
        ref.setUTCDate(jan4.getUTCDate() + (selection.isoWeek - 1) * 7);
        monday = weekId(ref);
      } else {
        monday = weekId();
      }
      startId = monday;
      endId = addDaysId(monday, 6);
    } else if (period === "month") {
      const [ty, tm] = todayId.split("-").map(Number);
      const y = selection ? selection.year : ty;
      const m = selection ? selection.month : tm;
      startId = y + "-" + pad(m) + "-01";
      endId = y + "-" + pad(m) + "-" + pad(daysInMonth(y, m));
    } else {
      const y = selection || Number(todayId.split("-")[0]);
      startId = y + "-01-01";
      endId = y + "-12-31";
    }
    if (endId > todayId) endId = todayId;
    if (startId > endId) startId = endId;
    return { startId, endId, todayId };
  }

  function fmtDate(dateId) {
    const [y, m, d] = dateId.split("-");
    return d + "/" + m + "/" + y;
  }

  function blankTotals() {
    const t = {};
    ALL_NUMERIC_FIELDS.forEach(f => { t[f.key] = 0; });
    return t;
  }
  function blankPerWardTotals() {
    const t = {};
    WARDS.forEach(w => { t[w.key] = blankTotals(); });
    return t;
  }
  function sumWardsMap(wardsMap, into) {
    WARDS.forEach(w => {
      const data = (wardsMap && wardsMap[w.key]) || {};
      ALL_NUMERIC_FIELDS.forEach(f => { into[f.key] += typeof data[f.key] === "number" ? data[f.key] : 0; });
    });
  }
  function sumWardsMapPerWard(wardsMap, into) {
    WARDS.forEach(w => {
      const data = (wardsMap && wardsMap[w.key]) || {};
      ALL_NUMERIC_FIELDS.forEach(f => { into[w.key][f.key] += typeof data[f.key] === "number" ? data[f.key] : 0; });
    });
  }

  async function loadTotals(period, selection) {
    const { startId, endId, todayId } = computeRange(period, selection);
    const totals = blankTotals();
    const perWard = blankPerWardTotals();
    let daysCovered = 0;

    const archiveSnap = await getDocs(query(collection(db, "archives"), where("type", "==", "overall")));
    let todayArchived = false;
    archiveSnap.forEach(docSnap => {
      const data = docSnap.data();
      if (!data.dateId || data.dateId < startId || data.dateId > endId) return;
      sumWardsMap(data.wards, totals);
      sumWardsMapPerWard(data.wards, perWard);
      daysCovered += 1;
      if (data.dateId === todayId) todayArchived = true;
    });

    if (todayId >= startId && todayId <= endId && !todayArchived) {
      const wardsSnap = await getDocs(collection(db, "nurseReports", todayId, "wards"));
      const liveWardsMap = {};
      wardsSnap.forEach(d => { liveWardsMap[d.id] = d.data(); });
      if (Object.keys(liveWardsMap).length) {
        sumWardsMap(liveWardsMap, totals);
        sumWardsMapPerWard(liveWardsMap, perWard);
        daysCovered += 1;
      }
    }

    return { totals, perWard, startId, endId, daysCovered };
  }

  function openPicker(input) {
    if (!input) return;
    try {
      if (typeof input.showPicker === "function") { input.showPicker(); return; }
    } catch (e) { /* fall through to the click fallback */ }
    input.focus();
    input.click();
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else goto("/nurses-report/role-select");
  }

  const chartTextColor = $derived(themeState.theme === "dark" ? "#F1F5F9" : "#232F56");
  const chartGridColor = $derived(themeState.theme === "dark" ? "rgba(255,255,255,0.18)" : "rgba(15,35,80,0.12)");
  const chartSliceBorder = $derived(themeState.theme === "dark" ? "#132030" : "#FFFFFF");

  let activePeriod = $state("today");
  let phase = $state("loading"); // 'loading' | 'summary' | 'empty' | 'error'
  let errorText = $state("");
  let rangeLabel = $state("");
  let totals = $state(null);
  let perWard = $state(null);
  let breakdownWard = $state(WARDS[0]?.key || "");

  const periodSelection = { today: null, week: null, month: null, year: null };
  let loadToken = 0;

  let dayPicker, weekPicker, monthPicker, yearPicker;
  let movementCanvas, sexPieCanvas, affiliationPieCanvas, wardBreakdownCanvas;
  let movementChart = null, sexPie = null, affiliationPie = null, wardBreakdownChart = null;

  const todayIdForYears = Number(reportDateId().split("-")[0]);
  const yearOptions = [];
  for (let y = todayIdForYears; y >= todayIdForYears - 5; y--) yearOptions.push(y);

  onMount(() => {
    const todayIdForCaps = reportDateId();
    if (dayPicker) dayPicker.max = todayIdForCaps;
    if (monthPicker) monthPicker.max = todayIdForCaps.slice(0, 7);
    if (weekPicker) {
      const nowMonday = weekId();
      const [wy, wm, wd] = nowMonday.split("-").map(Number);
      weekPicker.max = wy + "-W" + pad(isoWeekNumber(new Date(Date.UTC(wy, wm - 1, wd))));
    }
    loadAndRender("today");
  });

  onDestroy(() => {
    [movementChart, sexPie, affiliationPie, wardBreakdownChart].forEach(c => { if (c) c.destroy(); });
  });

  async function loadAndRender(period) {
    activePeriod = period;
    const myToken = ++loadToken;
    phase = "loading";

    let result;
    try {
      result = await loadTotals(period, periodSelection[period]);
    } catch (e) {
      if (myToken !== loadToken) return;
      errorText = "Couldn't load: " + (e.code || e.message || "unknown error");
      phase = "error";
      return;
    }
    if (myToken !== loadToken) return;

    const { totals: t, perWard: pw, startId, endId, daysCovered } = result;
    rangeLabel =
      (startId === endId ? fmtDate(startId) : fmtDate(startId) + " – " + fmtDate(endId)) +
      (daysCovered ? " · " + daysCovered + " day" + (daysCovered === 1 ? "" : "s") + " of reports" : "");

    if (daysCovered === 0) {
      totals = null;
      perWard = null;
      phase = "empty";
      return;
    }

    totals = t;
    perWard = pw;
    phase = "summary";
  }

  // Bar / movement / pie charts — redraw whenever totals or theme changes.
  $effect(() => {
    if (!totals || !movementCanvas) return;
    const t = totals;
    const textColor = chartTextColor, gridColor = chartGridColor, sliceBorder = chartSliceBorder;

    if (movementChart) movementChart.destroy();
    movementChart = new Chart(movementCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: MOVEMENT_FIELDS.map(f => f.label),
        datasets: [{
          data: MOVEMENT_FIELDS.map(f => t[f.key]),
          backgroundColor: (c) => {
            const hex = MOVEMENT_FIELDS[c.dataIndex].direction === "increase" ? "#16a34a" : "#dc2626";
            return barFrontGradient(c.chart.ctx, c.chart.chartArea, hex);
          },
          borderColor: MOVEMENT_FIELDS.map(f => shadeHex(f.direction === "increase" ? "#16a34a" : "#dc2626", -0.25)),
          borderWidth: 1.5,
          borderRadius: 2,
          _solidColors: MOVEMENT_FIELDS.map(f => f.direction === "increase" ? "#16a34a" : "#dc2626")
        }]
      },
      plugins: [dropShadowPlugin, bar3dPlugin],
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 12, right: 12 } },
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: textColor }, grid: { color: gridColor } },
          y: { beginAtZero: true, ticks: { precision: 0, color: textColor }, grid: { color: gridColor } }
        }
      }
    });

    if (sexPie) sexPie.destroy();
    sexPie = new Chart(sexPieCanvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: ["Male", "Female", "Children"],
        datasets: [{
          data: [t.male, t.female, t.child],
          backgroundColor: (c) => {
            const colors = ["#2563eb", "#db2777", "#f59e0b"];
            return pieFrontGradient(c.chart.ctx, c.chart.chartArea, colors[c.dataIndex]);
          },
          borderColor: sliceBorder, borderWidth: 2,
          offset: 10,
          _solidColors: ["#2563eb", "#db2777", "#f59e0b"]
        }]
      },
      plugins: [pieDepthPlugin, dropShadowPlugin],
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { bottom: 18 } },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 }, color: textColor } } }
      }
    });

    if (affiliationPie) affiliationPie.destroy();
    affiliationPie = new Chart(affiliationPieCanvas.getContext("2d"), {
      type: "pie",
      data: {
        labels: ["Soldiers", "Civilians"],
        datasets: [{
          data: [t.soldier, t.civilian],
          backgroundColor: (c) => {
            const colors = ["#16a34a", "#6b7280"];
            return pieFrontGradient(c.chart.ctx, c.chart.chartArea, colors[c.dataIndex]);
          },
          borderColor: sliceBorder, borderWidth: 2,
          offset: 10,
          _solidColors: ["#16a34a", "#6b7280"]
        }]
      },
      plugins: [pieDepthPlugin, dropShadowPlugin],
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { bottom: 18 } },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 }, color: textColor } } }
      }
    });
  });

  const breakdownLeaderText = $derived.by(() => {
    if (!perWard) return "";
    const w = WARDS.find(x => x.key === breakdownWard) || WARDS[0];
    if (!w) return "";
    const wardTotals = perWard[w.key] || {};
    const ranked = MOVEMENT_GRID_FIELDS
      .map(f => ({ label: f.label, count: wardTotals[f.key] || 0 }))
      .sort((a, b) => b.count - a.count);
    if (ranked[0] && ranked[0].count > 0) {
      const tiedLeaders = ranked.filter(r => r.count === ranked[0].count);
      return tiedLeaders.length > 1
        ? tiedLeaders.map(r => r.label).join(", ") + " tied for the most on " + w.label + " (" + ranked[0].count + " each)"
        : ranked[0].label + " led on " + w.label + " with " + ranked[0].count;
    }
    return "Nothing recorded for " + w.label + " this period.";
  });

  // Ward Breakdown chart — redraw whenever perWard, the chosen ward, or theme changes.
  $effect(() => {
    if (!perWard || !wardBreakdownCanvas) return;
    const w = WARDS.find(x => x.key === breakdownWard) || WARDS[0];
    if (!w) return;
    const wardTotals = perWard[w.key] || {};
    const colorFor = (f) => f.direction === "increase" ? "#16a34a" : f.direction === "decrease" ? "#dc2626" : "#2563eb";
    const textColor = chartTextColor, gridColor = chartGridColor;

    if (wardBreakdownChart) wardBreakdownChart.destroy();
    wardBreakdownChart = new Chart(wardBreakdownCanvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: MOVEMENT_GRID_FIELDS.map(f => f.label),
        datasets: [{
          data: MOVEMENT_GRID_FIELDS.map(f => wardTotals[f.key] || 0),
          backgroundColor: (c) => barFrontGradient(c.chart.ctx, c.chart.chartArea, colorFor(MOVEMENT_GRID_FIELDS[c.dataIndex])),
          borderColor: MOVEMENT_GRID_FIELDS.map(f => shadeHex(colorFor(f), -0.25)),
          borderWidth: 1.5,
          borderRadius: 2,
          _solidColors: MOVEMENT_GRID_FIELDS.map(colorFor)
        }]
      },
      plugins: [dropShadowPlugin, bar3dPlugin],
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 12, right: 12 } },
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0, color: textColor }, grid: { color: gridColor } },
          y: { ticks: { color: textColor }, grid: { color: gridColor } }
        }
      }
    });
  });

  const additions = $derived(totals ? MOVEMENT_FIELDS.filter(f => f.direction === "increase").reduce((s, f) => s + totals[f.key], 0) : 0);
  const reductions = $derived(totals ? MOVEMENT_FIELDS.filter(f => f.direction === "decrease").reduce((s, f) => s + totals[f.key], 0) : 0);
  const net = $derived(additions - reductions);
</script>

<Topbar brand="Analytics">
  <button class="btn btn-secondary" style="padding:6px 12px;" onclick={goBack}>Back</button>
</Topbar>

<div class="container">
  <div class="card-box">
    <h1 style="margin:0;font-size:18px;">Hospital Statistics</h1>
    <div class="period-row">
      <span class="picker-anchor">
        <button class={"period-btn" + (activePeriod === "today" ? " active" : "")} onclick={() => openPicker(dayPicker)}>Today</button>
        <input type="date" bind:this={dayPicker} class="hidden-picker" aria-hidden="true" tabindex="-1"
          onchange={e => { if (!e.target.value) return; periodSelection.today = e.target.value; loadAndRender("today"); }} />
      </span>
      <span class="picker-anchor">
        <button class={"period-btn" + (activePeriod === "week" ? " active" : "")} onclick={() => openPicker(weekPicker)}>This Week</button>
        <input type="week" bind:this={weekPicker} class="hidden-picker" aria-hidden="true" tabindex="-1"
          onchange={e => {
            if (!e.target.value) return;
            const [yStr, wStr] = e.target.value.split("-W");
            periodSelection.week = { isoYear: Number(yStr), isoWeek: Number(wStr) };
            loadAndRender("week");
          }} />
      </span>
      <span class="picker-anchor">
        <button class={"period-btn" + (activePeriod === "month" ? " active" : "")} onclick={() => openPicker(monthPicker)}>This Month</button>
        <input type="month" bind:this={monthPicker} class="hidden-picker" aria-hidden="true" tabindex="-1"
          onchange={e => {
            if (!e.target.value) return;
            const [yStr, mStr] = e.target.value.split("-");
            periodSelection.month = { year: Number(yStr), month: Number(mStr) };
            loadAndRender("month");
          }} />
      </span>
      <span class="picker-anchor">
        <button class={"period-btn" + (activePeriod === "year" ? " active" : "")} onclick={() => openPicker(yearPicker)}>This Year</button>
        <select bind:this={yearPicker} class="hidden-picker" aria-hidden="true" tabindex="-1"
          value={yearOptions[0]}
          onchange={e => { periodSelection.year = Number(e.target.value); loadAndRender("year"); }}>
          {#each yearOptions as y (y)}<option value={y}>{y}</option>{/each}
        </select>
      </span>
    </div>
    <div class="range-label">{rangeLabel}</div>
    {#if phase === "loading"}<div class="loading-note">Loading…</div>{/if}
    {#if phase === "error"}<div class="loading-note">{errorText}</div>{/if}
  </div>

  {#if phase === "summary" && totals}
    <div class="card-box">
      <h2>HOSPITAL STATISTICS</h2>
      <div class="stat-grid">
        <div class="stat-box"><div class="n" style="color:#16a34a;">{additions}</div><div class="l">Total Additions</div></div>
        <div class="stat-box"><div class="n" style="color:#dc2626;">{reductions}</div><div class="l">Total Reductions</div></div>
        <div class="stat-box"><div class="n" style={"color:" + (net >= 0 ? "#16a34a" : "#dc2626") + ";"}>{net > 0 ? "+" : ""}{net}</div><div class="l">Net Change</div></div>
      </div>
      <div class="stat-grid" style="margin-top:6px;">
        {#each MOVEMENT_GRID_FIELDS as f (f.key)}
          {@const color = f.direction === "increase" ? "#16a34a" : f.direction === "decrease" ? "#dc2626" : "#374151"}
          <div class="stat-box">
            <div class="n" style={"color:" + color + ";"}>{totals[f.key]}</div>
            <div class="l">{f.label}</div>
          </div>
        {/each}
      </div>
      <h3>Patient Demographics</h3>
      <div class="stat-grid">
        {#each DEMOGRAPHIC_FIELDS as f (f.key)}
          <div class="stat-box demo">
            <div class="n">{totals[f.key]}</div>
            <div class="l">{f.label}</div>
          </div>
        {/each}
      </div>
    </div>

    <div class="card-box">
      <h2>HOSPITAL STATISTICS BREAKDOWN</h2>
      <div class="chart-wrap"><canvas bind:this={movementCanvas}></canvas></div>

      <div class="pie-grid">
        <div>
          <h3>Male / Female / Children</h3>
          <div class="chart-wrap" style="height:220px;"><canvas bind:this={sexPieCanvas}></canvas></div>
        </div>
        <div>
          <h3>Soldiers / Civilians</h3>
          <div class="chart-wrap" style="height:220px;"><canvas bind:this={affiliationPieCanvas}></canvas></div>
        </div>
      </div>
    </div>

    <div class="card-box">
      <h2>Ward Breakdown</h2>
      <div class="range-label" style="margin-top:0;">Pick a ward to see how its columns (Adm, Disch, Dama, etc.) compare, for the selected period.</div>
      <select bind:value={breakdownWard}
        style="margin-top:10px;width:100%;padding:10px 8px;border-radius:8px;border:2px solid #e5e7eb;font-weight:bold;font-size:13px;color:#374151;">
        {#each WARDS as w (w.key)}<option value={w.key}>{w.label}</option>{/each}
      </select>
      <div class="range-label" style="margin-top:8px;font-weight:bold;color:#111827;">{breakdownLeaderText}</div>
      <div class="chart-wrap" id="wardBreakdownWrap"><canvas bind:this={wardBreakdownCanvas}></canvas></div>
    </div>
  {/if}

  {#if phase === "empty"}
    <div class="card-box">
      <div class="empty-note">No archived or live reports found for this period.</div>
    </div>
  {/if}
</div>
