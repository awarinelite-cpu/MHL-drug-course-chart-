// Auto-grows a <textarea> to fit whatever is typed in it, instead of
// relying on the browser's native corner-drag resize handle. That handle
// is inconsistent across platforms — iOS Safari doesn't render one on
// textareas at all, and Android's is a tiny target that's hard to grab
// with a thumb — so on a phone, older/long text (e.g. a full diagnosis
// note) can end up scrolled out of view inside a fixed-height box with
// no reliable way to expand it. Growing automatically as content is
// entered sidesteps all of that: the box just gets taller so everything
// typed stays visible, on iPhone, Android, and desktop alike.
//
// Usage: <textarea use:autogrow={{ min: 60, max: 480 }} ...></textarea>
export function autogrow(node, opts = {}) {
  let { min = 60, max = 480 } = opts;

  function resize() {
    // Collapse first so scrollHeight reflects content, not the box's
    // current (possibly larger) height — otherwise it can only grow,
    // never shrink back down after text is deleted.
    node.style.height = "auto";
    const target = Math.min(Math.max(node.scrollHeight, min), max);
    node.style.height = target + "px";
    // Only scroll internally once content exceeds the cap, so the box
    // doesn't grow forever on a very long note.
    node.style.overflowY = node.scrollHeight > max ? "auto" : "hidden";
  }

  node.addEventListener("input", resize);
  // Existing content (e.g. opening a patient that already has a long
  // diagnosis saved) needs sizing on mount too, not just on the next
  // keystroke. Run once now, and once more after Svelte finishes
  // binding `value`, since that can land a tick after mount.
  resize();
  requestAnimationFrame(resize);

  return {
    update(newOpts = {}) {
      if (newOpts.min != null) min = newOpts.min;
      if (newOpts.max != null) max = newOpts.max;
      resize();
    },
    destroy() {
      node.removeEventListener("input", resize);
    }
  };
}
