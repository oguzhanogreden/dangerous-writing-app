// A fixed-to-viewport countdown bar: a label plus a shrinking fill, optionally
// staying hidden until some fraction of the budget is spent. Shared by the
// writing app's silence/grace meter (client.js) and the /debug page's
// auto-refresh indicator (main.ts) — same paradigm, different data feeding it.

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.container - gets a "visible" class toggled on it
 * @param {HTMLElement} opts.fill - width set to (time left / total) as a %
 * @param {HTMLElement} opts.label - textContent driven by formatLabel
 * @param {(leftMs: number, totalMs: number) => string} opts.formatLabel
 * @param {number} [opts.revealFraction] - only reveal once this fraction of
 *   the budget is spent (0 = visible for the whole countdown). Default 0.
 */
function createCountdownBar(opts) {
  const { container, fill, label, formatLabel, revealFraction = 0 } = opts;

  /**
   * @param {number | null} leftMs - null retires the bar (no countdown active)
   * @param {number} totalMs
   */
  function update(leftMs, totalMs) {
    if (leftMs === null || !totalMs) {
      container.classList.remove("visible");
      return;
    }
    const left = Math.max(0, leftMs);
    const frac = Math.min(1, left / totalMs);
    fill.style.width = (frac * 100).toFixed(1) + "%";
    label.textContent = formatLabel(left, totalMs);
    container.classList.toggle("visible", frac <= 1 - revealFraction);
  }

  function hide() {
    container.classList.remove("visible");
  }

  return { update, hide };
}
