<script>
  // Ported from src/components/NewPatientTransfersModal.jsx.
  import { acceptTransfer, rejectTransfer } from "$lib/helpers/wardTransfer.js";
  import { PED_BED_TYPES } from "$lib/helpers/drugChartHelpers.js";

  // `transfers` is the list of patient objects (each carrying its own
  // pendingTransfer field) whose pendingTransfer.toWard === this ward.
  // `onResolved(patientId)` is called after a successful accept/reject so
  // the caller can refresh its patient list.
  let { ward = "", transfers = [], onClose, onResolved } = $props();

  let busyId = $state("");
  let errMsg = $state("");
  // Only asked for PEDIATRIC/NICU WARD transfers — the sending ward has no
  // way to know which side the receiving nurse will actually place the
  // patient on, so it's picked here at accept time instead of guessed earlier.
  let pedBedTypeById = $state({});

  async function handleAccept(p) {
    errMsg = "";
    if (ward === "PEDIATRIC/NICU WARD" && !pedBedTypeById[p.id]) {
      errMsg = "Select Bed or Cot for " + (p.name || "this patient") + " before accepting.";
      return;
    }
    busyId = p.id;
    try {
      await acceptTransfer(p.id, p.pendingTransfer, ward === "PEDIATRIC/NICU WARD" ? pedBedTypeById[p.id] : undefined);
      onResolved(p.id);
    } catch (e) {
      errMsg = "Could not accept " + (p.name || "this patient") + ": " + (e.code || e.message);
    }
    busyId = "";
  }

  async function handleReject(p) {
    if (!confirm("Reject " + (p.name || "this patient") + "? They will stay listed on " + (p.pendingTransfer.fromWard || "their previous ward") + ".")) return;
    errMsg = "";
    busyId = p.id;
    try {
      await rejectTransfer(p.id);
      onResolved(p.id);
    } catch (e) {
      errMsg = "Could not reject " + (p.name || "this patient") + ": " + (e.code || e.message);
    }
    busyId = "";
  }
</script>

<div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="modal-box" style="max-width:420px;">
    <div class="modal-header">
      <h3>New Patients{ward ? " — " + ward : ""}</h3>
      <button class="modal-close" onclick={onClose}>&times;</button>
    </div>
    <div class="modal-body">
      {#if transfers.length === 0}
        <div style="font-size:13px;color:#888;text-align:center;padding:10px 0;">
          No incoming patient transfers right now.
        </div>
      {/if}
      {#each transfers as p (p.id)}
        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px;">
          <div style="font-weight:bold;">{p.name || "Unnamed"} — EMR: {p.emr || "N/A"}</div>
          <div style="font-size:12px;color:#555;margin-top:2px;">
            Trans in from: {p.pendingTransfer.fromWard || "Unknown ward"}
          </div>
          {#if p.diagnosis}<div style="font-size:12px;color:#555;margin-top:2px;">{p.diagnosis}</div>{/if}
          {#if ward === "PEDIATRIC/NICU WARD"}
            <div class="field" style="margin-top:6px;">
              <label style="font-size:12px;">Bed / Cot</label>
              <select value={pedBedTypeById[p.id] || ""} onchange={(e) => pedBedTypeById = { ...pedBedTypeById, [p.id]: e.target.value }}>
                <option value="">Select…</option>
                {#each PED_BED_TYPES as t}<option value={t}>{t}</option>{/each}
              </select>
            </div>
          {/if}
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-success" style="padding:6px 12px;font-size:13px;" disabled={busyId === p.id} onclick={() => handleAccept(p)}>
              {busyId === p.id ? "…" : "Accept"}
            </button>
            <button class="btn btn-secondary" style="padding:6px 12px;font-size:13px;" disabled={busyId === p.id} onclick={() => handleReject(p)}>
              {busyId === p.id ? "…" : "Reject"}
            </button>
          </div>
        </div>
      {/each}
      {#if errMsg}<div class="error-msg">{errMsg}</div>{/if}
    </div>
  </div>
</div>
