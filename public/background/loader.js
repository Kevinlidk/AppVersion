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
  //
  // 种子在挂载时生成一次,并被下方 settings 闭包整个会话引用:
  // - 未指定 ?seed= 时取随机值,每次进入页面图案各不相同;
  // - 同一次会话内 settings() 始终返回同一对象,风场由固定种子确定性推导,
  //   因此不跳变、平滑流动(实测:多次采样 dataset.look 中种子一致,state=moving)。
  var mountSeed = numParam('seed', (Math.random() * 0x100000000) >>> 0);

  var settings = Object.assign(GlyphWind.defaults(), {
    seed: mountSeed,
    look: look,
    interactive: false
  });
  // 图案参数同样只在挂载时推导一次(pattern 由种子确定性生成),后续每帧直接复用
  settings.field = GlyphWind.pattern(mountSeed, look);

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
