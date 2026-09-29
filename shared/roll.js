// Piano-roll drawing shared by the website demo and the Ableton extension's
// preview, following the design system's roll.md: key bands (black-key rows on
// --band), notes shaded in the category accent by pitch (shade()), the sounding note
// at full accent with an --ink outline, articulation lines in --ink.
//
// A classic script (no exports): the website loads it with <script src>, the
// extension inlines it into its modal at build time. Everything hangs off
// window.TabridgeRoll.
(function () {
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const TINT_STEPS = 16;

  // Resolve a CSS colour expression as `el` sees it (theme, category apply).
  // Canvas can't read var(), light-dark() or color-mix(), so probe it.
  function resolve(expr, el) {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;color:" + expr;
    el.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }

  // Every colour a roll needs, resolved once per theme change.
  function palette(el) {
    el = el || document.documentElement;
    const tints = [];
    for (let i = 0; i <= TINT_STEPS; i++) {
      const v = i / TINT_STEPS, pct = Math.round(35 + 65 * v);
      tints.push(resolve("color-mix(in oklab, var(--acc) " + pct + "%, var(--ground))", el));
    }
    return {
      ground: resolve("var(--ground)", el), band: resolve("var(--band)", el),
      line: resolve("var(--line)", el), ink: resolve("var(--ink)", el),
      inkMut: resolve("var(--ink-mut)", el), acc: resolve("var(--acc)", el),
      // strength 0..1 -> accent tint, P = 35 + 65 * strength (shade() gives it for a pitch)
      tint(v) { return tints[Math.max(0, Math.min(TINT_STEPS, Math.round((v == null ? 0.8 : v) * TINT_STEPS)))]; },
    };
  }

  // Key bands for pitch rows pMax (top) .. pMin (bottom), each `row` px high,
  // starting at y0. Black-key rows are --band; white rows stay --ground. An
  // --ink-mut octave label at each C when `labels` is set and rows are tall
  // enough to read.
  function bands(ctx, pal, x, y0, w, pMin, pMax, row, labels) {
    ctx.fillStyle = pal.ground;
    ctx.fillRect(x, y0, w, (pMax - pMin + 1) * row);
    ctx.fillStyle = pal.band;
    for (let p = pMax; p >= pMin; p--) {
      if (BLACK.has(((p % 12) + 12) % 12)) ctx.fillRect(x, y0 + (pMax - p) * row, w, row);
    }
    if (labels && row >= 7) {
      ctx.fillStyle = pal.inkMut;
      ctx.font = Math.min(10, row + 2) + "px " + (getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace");
      ctx.textBaseline = "middle";
      for (let p = pMax; p >= pMin; p--) {
        if (((p % 12) + 12) % 12 === 0) ctx.fillText("C" + (Math.floor(p / 12) - 1), x + 4, y0 + (pMax - p) * row + row / 2);
      }
    }
  }

  // A pitch's tint strength for tint() and note(): roll.md shades notes from 40
  // percent accent at the lowest pitch in view (lo) to full at the highest (hi).
  function shade(pitch, lo, hi) {
    const u = hi > lo ? Math.max(0, Math.min(1, (pitch - lo) / (hi - lo))) : 1;
    return (5 + 60 * u) / 65;
  }

  // One note: a sharp rectangle one row high minus a 1px gap.
  function note(ctx, pal, x, y, w, row, strength, now) {
    const h = Math.max(1, row - 1);
    ctx.fillStyle = now ? pal.acc : pal.tint(strength);
    ctx.fillRect(x, y, Math.max(1, w), h);
    if (now && w > 2 && h > 2) {
      ctx.strokeStyle = pal.ink; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w) - 1, h - 1);
    }
  }

  // Re-run `fn` whenever the system colour scheme flips, so canvases never
  // keep the previous mode's colours. Theme/category changes call fn directly.
  function onSchemeChange(fn) {
    try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", fn); } catch (e) { /* old engine */ }
  }

  const reducedMotion = () => {
    try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  };

  window.TabridgeRoll = { palette, bands, note, shade, onSchemeChange, reducedMotion, BLACK };
})();
