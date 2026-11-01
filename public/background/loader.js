/* Loader: mounts the Claude Code animated background (GlyphWind engine from
 * renderer.js) as a decorative, non-interactive layer behind the page.
 *
 * It uses ONLY the public GlyphWind API (defaults / pattern / create), so it
 * stays compatible with the engine. The control panel (controls.js) and the
 * panel glue (adapter.js) are intentionally not used: this is a background,
 * not an interactive lab.
 */
(function () {
  'use strict';

  if (typeof GlyphWind === 'undefined') {
    console.error('[background] GlyphWind engine not loaded; skipping background.');
    return;
  }
  var stage = document.getElementById('bg-stage');
  if (!stage) {
    console.error('[background] #bg-stage element not found.');
    return;
  }

  var params = new URLSearchParams(window.location.search);
  function numParam(name, fallback) {
    var raw = params.get(name);
    if (raw === null) return fallback;
    var n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  var lookParam = params.get('look');
  var validLooks = { mixed: 1, lettered: 1, figured: 1 };
  var look = (lookParam && validLooks[lookParam]) ? lookParam : 'mixed';

  // Build on top of the engine defaults so we remain compatible with engine
  // changes. interactive:false disables pointer/keydown listeners (patched in
  // the local renderer.js; default true preserves the original app behavior).
  var settings = Object.assign(GlyphWind.defaults(), {
    seed: numParam('seed', 0x19a4c637),
    look: look,
    interactive: false
  });

  var timing = function () { return { fadeIn: 3000, fadeOut: 500 }; };

  var instance = GlyphWind.create({
    element: stage,
    settings: function () { return settings; },
    timing: timing,
    onReady: function () {
      // The engine only animates after setRunning(true). Start it once ready.
      instance.setRunning(true);
    },
    onError: function (error) {
      console.error('[background] engine error:', error);
      stage.style.display = 'none'; // graceful fallback to solid body bg
    }
  });
})();
