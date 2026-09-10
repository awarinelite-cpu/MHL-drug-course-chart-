<script module>
  // Normalizes a Nigerian-style local number ("080...", "070...") or an
  // already-international one ("+234...", "234...") down to bare digits
  // with the country code, suitable for tel:/wa.me links. Falls back to
  // just stripping non-digits if it doesn't look like a Nigerian number.
  export function normalizePhone(raw) {
    if (!raw) return "";
    const digits = String(raw).replace(/[^\d]/g, "");
    if (!digits) return "";
    if (digits.startsWith("234")) return digits;
    if (digits.startsWith("0")) return "234" + digits.slice(1);
    return digits;
  }
</script>

<script>
  // Ported from src/components/ReportContactModal.jsx. Shows a submitting
  // nurse's full name and phone number, with a call-or-WhatsApp chooser
  // once the phone number itself is tapped. `nurse` is
  // { name, phone, wardLabel } — phone may be missing if the nurse hasn't
  // filled it in on her Profile page yet.
  let { nurse, onClose } = $props();

  let showChooser = $state(false);
  const digits = $derived(normalizePhone(nurse?.phone));
</script>

{#if nurse}
  <div class="modal-overlay no-print" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal-box" style="max-width:340px;">
      <div class="modal-header">
        <h3>{nurse.wardLabel ? nurse.wardLabel + " \u2014 Nurse on Duty" : "Nurse on Duty"}</h3>
        <button class="modal-close" onclick={onClose}>&times;</button>
      </div>
      <div class="modal-body">
        <div class="patient-line"><h3>Full Name: </h3>{nurse.name || "Unknown"}</div>

        {#if !digits}
          <div class="patient-line"><h3>Phone Number: </h3>Not on file</div>
        {/if}

        {#if digits && !showChooser}
          <div class="patient-line">
            <h3>Phone Number: </h3>
            <button type="button" class="contact-phone-btn" onclick={() => showChooser = true}>
              {nurse.phone}
            </button>
          </div>
        {/if}

        {#if digits && showChooser}
          <div class="contact-choice">
            <div style="font-size:13px;color:#555;margin-bottom:2px;">Reach {nurse.name || "this nurse"} via:</div>
            <a class="btn btn-primary contact-choice-btn" href={"tel:+" + digits}>
              {"\uD83D\uDCDE Call"}
            </a>
            <a class="btn btn-secondary contact-choice-btn" href={"https://wa.me/" + digits} target="_blank" rel="noreferrer">
              {"\uD83D\uDCAC WhatsApp"}
            </a>
            <button type="button" class="btn btn-secondary contact-choice-btn" onclick={() => showChooser = false}>
              Back
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
