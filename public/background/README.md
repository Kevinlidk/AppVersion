# Claude Code 动态背景 · 复用套件 (`background/`)

把本目录整体拷到任意静态 Web 项目，即可作为**装饰性全屏背景**使用。
零运行时依赖、无外部字体、无网络请求，仅用系统等宽字体 + 系统 WebGL2。

---

## 文件清单

| 文件 | 是否必须 | 作用 |
| --- | --- | --- |
| `renderer.js` | ✅ 必须 | GlyphWind WebGL2 引擎（背景代码本体）。经典脚本暴露全局 `GlyphWind`，同时 `module.exports = GlyphWind`（可在打包器 `import` / `require`）。 |
| `engine.css` | ✅ 必须 | `#bg-stage` 容器与画布定位所必需的最小样式。控制面板样式已剔除。 |
| `loader.js` | ⚪ 可选 | 零代码挂载脚本（声明式，默认 `interactive:false`，支持 `?seed=&look=`）。可替换为自己的初始化。 |
| `README.md` | — | 本文件。 |
| `example.html` | — | 可直接运行的接入示例（手动调用 `GlyphWind.create`）。 |

> **不需要**：`controls.js` / `adapter.js` / `build.py` / 模板 HTML —— 那些是带 38 滑块控制面板的"实验室" UI，与装饰性背景无关。

---

## 依赖与前提

- **运行时零依赖**：无 npm 包、无外部字体、无网络请求。仅用系统等宽字体 + 系统 WebGL2。
- **硬前提**：浏览器支持 **WebGL2**（现代 Chrome / Edge / Firefox / Safari 均可）。不支持时引擎走 `onError`，自动 `display:none` 回退为纯底色，不报错。
- **静态托管即可**：`python -m http.server`、任意静态服务器或 CDN 都行。

---

## 快速开始

### 方式 A：用 `loader.js`（零代码，推荐静态站）

1. 拷贝 `background/` 到项目静态目录（如 `/background/`）。
2. 页面里加三处（顺序不能反）：

```html
<head>
  <link href="background/engine.css" rel="stylesheet">
</head>
<body>
  <div id="bg-stage" aria-hidden="true"></div>   <!-- body 起始处 -->
  <!-- 你的内容 -->
  <script src="background/renderer.js"></script>  <!-- 先加载引擎 -->
  <script src="background/loader.js"></script>     <!-- 再挂载 -->
</body>
```

3. 访问 `?seed=123&look=lettered` 即可指定图案。

### 方式 B：手动调用（可控 / 框架内）

```html
<div id="bg-stage" aria-hidden="true"></div>
<script src="background/renderer.js"></script>
<script>
  const stage = document.getElementById('bg-stage');
  const settings = Object.assign(GlyphWind.defaults(), {
    seed: 123, look: 'mixed', interactive: false
  });
  const instance = GlyphWind.create({
    element: stage,
    settings: () => settings,
    timing:  () => ({ fadeIn: 3000, fadeOut: 500 }),
    onReady: () => instance.setRunning(true),   // ⚠️ 必须，否则只静态画面
    onError: (e) => { console.error(e); stage.style.display = 'none'; }
  });
</script>
```

也可直接打开 `example.html` 看效果。

---

## 配置项

### CSS（`engine.css` 的 `#bg-stage`，视觉相关）
- `color`：**字形墨色**。引擎读取 `#bg-stage` 的计算 `color` 作为字形颜色——想调亮/调暗改这里。
- `font-family`：字形字体，默认系统等宽。
- `z-index` / `pointer-events:none`：保证在内容之下且永不拦截点击。

### `settings`（传给 `create`，默认来自 `GlyphWind.defaults()`）
- `seed`（数字）：图案种子；缺省用引擎默认（每次一致）。
- `look`：`'mixed' | 'lettered' | 'figured'`，字符集。
- `interactive`：`false` 装饰不可交互；`true` 启用鼠标尾迹 / 点击涟漪（监听绑在父元素，忽略 `a/button/input`）。
- `strength`：整体亮度（默认约 0.78 不透明度）。
- `glow.color.light`：涟漪蓝光颜色（默认蓝 `[0,.25,1]`）。

### `timing`
- `{ fadeIn, fadeOut }`（毫秒）：窗口失焦淡出、获焦淡入。

### URL 参数（仅 `loader.js` 生效）
- `?seed=<数字>&look=<mixed|lettered|figured>`。

---

## 框架用法（React / Vue / SPA）

引擎纯 DOM、框架无关。挂载完成后用 ref 节点调用 `create()`，卸载时 `instance.destroy()` 释放 WebGL 上下文（浏览器约 16 个上下文上限，路由切换务必清理）：

```js
useEffect(() => {
  const instance = GlyphWind.create({
    element: ref.current, settings: () => s, timing: () => t,
    onReady: () => instance.setRunning(true)
  });
  return () => instance.destroy();   // 卸载时清理
}, []);
```

ESM 项目可用 `import GlyphWind from './renderer.js'`（CommonJS 互操作）。

---

## 注意事项

- **必须调 `setRunning(true)`**（在 `onReady` 内），否则只渲染一帧静态画面——这是"背景不出来"最常见原因。
- **别被不透明背景盖住**：`#bg-stage` 是 `z-index:-2` 固定层。若内容被带实色 `background` 的全屏容器包住（普通流），会遮掉画布。规则：背景容器透明，或把 `#bg-stage` 提到正值 `z-index` 且内容更高。
- **尊重 reduced-motion**：引擎未强制处理；可在调用前判断 `matchMedia('(prefers-reduced-motion: reduce)').matches` 为 `true` 时不 `setRunning(true)`。
- **只挂一个实例**，并记得 `destroy()`，避免 WebGL 上下文泄漏。
- **`interactive:true` 慎用**：鼠标尾迹绑在父元素（通常 body），装饰用途保持 `false`。

---

## 推荐目录结构（新项目）

```
your-project/
├─ index.html              # 你的页面
├─ styles.css              # 你的样式
└─ background/             # ← 整体拷入本目录
   ├─ renderer.js
   ├─ engine.css
   ├─ loader.js
   ├─ README.md
   └─ example.html
```
