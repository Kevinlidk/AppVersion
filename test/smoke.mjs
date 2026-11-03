/**
 * API 冒烟测试(离线运行,不依赖 wrangler 与网络):
 *   npm test   或   node test/smoke.mjs
 *
 * 通过 mock 全局 fetch(GitHub / Chocolatey / 通知 webhook)与 KV,
 * 对 Worker 的 API 逻辑、鉴权、定时检查与通知推送做验证。
 */
import worker from "../src/worker.js";

/* ── mock 外部 API ── */
let ghMode = "ok"; // ok | notfound | ratelimited
let chocoMode = "ok"; // ok | notfound | blocked | odataonly
let wingetMode = "ok"; // ok | notfound
const hookCalls = [];

const ghBody = {
  tag_name: "v2.0.0",
  html_url: "https://github.com/foo/bar/releases/tag/v2.0.0",
  published_at: "2026-01-01T00:00:00Z",
  assets: [],
};

/** 构造 GitHub Release 响应,附带指定资产名单 */
function ghReleaseWith(assetNames) {
  return {
    tag_name: "v2.0.0",
    html_url: "https://github.com/foo/bar/releases/tag/v2.0.0",
    published_at: "2026-01-01T00:00:00Z",
    assets: assetNames.map((n) => ({
      name: n,
      browser_download_url: "https://github.com/foo/bar/releases/download/v2.0.0/" + encodeURIComponent(n),
    })),
  };
}
let ghAssets = null; // 非 null 时返回带资产的响应
const chocoXml =
  '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
  "<entry><updated>2026-01-01T00:00:00Z</updated>" +
  '<m:properties xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">' +
  '<d:Version xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">9.9.9</d:Version>' +
  "</m:properties></entry></feed>";
const wingetEntries = [
  { name: "1.0.0", type: "dir" },
  { name: "9.9.9", type: "dir" },
  { name: "9.10.0", type: "dir" },
  { name: "readme.md", type: "file" },
];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input && input.url;
  const u = url || "";

  if (u.startsWith("https://api.github.com/repos/microsoft/winget-pkgs/contents/")) {
    if (wingetMode === "notfound") {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(wingetEntries), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.startsWith("https://community.chocolatey.org/api/v2/package/")) {
    if (chocoMode === "blocked") {
      return new Response("Forbidden", { status: 403 });
    }
    if (chocoMode === "notfound") {
      return new Response("Not Found", { status: 404 });
    }
    // 主路径:302 指向 nupkg,文件名即 包ID.版本.nupkg;odataonly 时不返回 Location
    if (chocoMode !== "odataonly") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://packages.chocolatey.org/vlc.9.9.9.nupkg" },
      });
    }
    return new Response("", { status: 200 });
  }
  if (u.startsWith("https://community.chocolatey.org/api/v2/Packages()")) {
    if (chocoMode === "blocked") return new Response("Forbidden", { status: 403 });
    if (chocoMode === "notfound") {
      return new Response('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200, headers: { "content-type": "application/atom+xml" } });
    }
    return new Response(chocoXml, { status: 200, headers: { "content-type": "application/atom+xml" } });
  }
  if (u.startsWith("https://api.github.com/")) {
    if (ghMode === "notfound") {
      if (u.includes("/releases?")) {
        return new Response(JSON.stringify([ghBody]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (ghMode === "ratelimited") {
      const reset = Math.floor(Date.now() / 1000) + 600;
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      });
    }
    return new Response(JSON.stringify(ghAssets ? ghReleaseWith(ghAssets) : ghBody), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u === "https://notify.example/hook") {
    hookCalls.push({ url: u, body: init && init.body });
    return new Response("{}", { status: 200 });
  }
  // 官方自查渠道的模拟响应
  if (u.startsWith("https://official.example/")) {
    if (u.includes("/notjson")) return new Response("<html>oops</html>", { status: 200 });
    if (u.includes("/missing")) return new Response(JSON.stringify({ releases: [] }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/chrome")) {
      return new Response(
        JSON.stringify({ releases: [{ version: "156.0.8078.80", fraction: 1 }, { version: "155.0.8059.85" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        "releases-index": [
          { "channel-version": "11.0", "latest-release": "11.0.0-rc.3" },
          { "channel-version": "10.0", "latest-release": "10.0.14" },
          { "channel-version": "9.0", "latest-release": "9.0.22" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return realFetch(input, init);
};

/* ── KV stub ── */
function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

const ADMIN_PASSWORD = "test-pass-123";
const env = { APP_KV: makeKV(), ADMIN_PASSWORD, CHECK_GAP_MS: "1" };
const ctx = { waitUntil() {}, passThroughOnException() {} };

/* 登录态 Cookie 注入 */
let adminCookie = "";
const call = (path, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (adminCookie) headers.cookie = "av_session=" + adminCookie;
  return worker.fetch(new Request("http://localhost" + path, { ...opts, headers }), env, ctx);
};
async function loginAs(envX, password) {
  const res = await worker.fetch(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    envX,
    ctx
  );
  const setc = res.headers.get("set-cookie") || "";
  return { res, cookie: (setc.match(/av_session=([^;]+)/) || [])[1] || "" };
}
const bodyOf = async (res) => {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
};
const post = (b) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(b),
});
const put = (b) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(b),
});

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + " — " + e.message);
  }
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "值不相等") + ": " + a + " ≠ " + b);
}

console.log("API 冒烟测试\n");

/* ── 鉴权 ── */

await test("未配置 ADMIN_PASSWORD 时,编辑接口一律拒绝并提示配置", async () => {
  const envX = { APP_KV: makeKV() };
  const res = await worker.fetch(new Request("http://localhost/api/apps", post({ name: "X" })), envX, ctx);
  assertEq(res.status, 500, "状态码");
  const b = await bodyOf(res);
  if (!/ADMIN_PASSWORD/.test(b.error)) throw new Error("提示缺少 ADMIN_PASSWORD: " + b.error);
});

await test("配置密码但未登录:编辑类接口 401,查看接口公开", async () => {
  assertEq((await call("/api/apps", post({ name: "X" }))).status, 401, "POST");
  assertEq((await call("/api/apps/abc", put({ name: "X" }))).status, 401, "PUT");
  assertEq((await call("/api/apps/abc", { method: "DELETE" })).status, 401, "DELETE");
  assertEq((await call("/api/apps/abc/refresh", { method: "POST" })).status, 401, "refresh");
  assertEq((await call("/api/apps")).status, 200, "GET 列表公开");
});

await test("GET /api/session 返回配置与登录状态", async () => {
  const s = await bodyOf(await call("/api/session"));
  assertEq(s, { admin: false, configured: true }, "会话状态");
});

await test("登录:错误密码 401;正确密码种下会话 Cookie", async () => {
  const bad = await call("/api/login", post({ password: "wrong" }));
  assertEq(bad.status, 401, "错误密码状态码");
  if (!/密码错误/.test((await bodyOf(bad)).error)) throw new Error("提示文案不符");
  const { res, cookie } = await loginAs(env, ADMIN_PASSWORD);
  assertEq(res.status, 200, "登录状态码");
  if (!cookie) throw new Error("未种下会话 Cookie");
  adminCookie = cookie;
  const s = await bodyOf(await call("/api/session"));
  assertEq(s.admin, true, "登录态");
});

await test("登录限流:同一 IP 连续失败 10 次后 429 锁定", async () => {
  const env3 = { APP_KV: makeKV(), ADMIN_PASSWORD: "p" };
  let last;
  for (let i = 0; i < 11; i++) {
    last = await worker.fetch(
      new Request("http://localhost/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }) }),
      env3, ctx
    );
  }
  assertEq(last.status, 429, "第 11 次应被锁定");
});

await test("退出登录后会话立即失效,需重新登录", async () => {
  const lo = await call("/api/logout", { method: "POST" });
  assertEq(lo.status, 200, "退出状态码");
  const res = await call("/api/apps", post({ name: "X" }));
  assertEq(res.status, 401, "旧会话应失效");
  const { cookie } = await loginAs(env, ADMIN_PASSWORD);
  if (!cookie) throw new Error("重新登录失败");
  adminCookie = cookie;
});

/* ── 应用 CRUD(管理员)── */

await test("首次 GET 自动注入 Google Chrome 示例应用", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const sample = list.find((a) => a.packageId === "googlechrome");
  if (!sample) throw new Error("示例应用缺失");
  assertEq(sample.channel, "chocolatey", "示例渠道");
  assertEq(sample.name, "Google Chrome", "示例名称");
  assertEq(sample.notify, false, "推送通知默认关闭");
});

await test("POST 新增 GitHub 应用成功,字段归一化", async () => {
  const res = await call("/api/apps", post({ name: "Foo Bar", channel: "github", repo: "https://github.com/foo/bar/", version: "v1.0.0", note: "测试" }));
  assertEq(res.status, 201, "状态码");
  const app = await bodyOf(res);
  assertEq(app.repo, "foo/bar", "repo 归一化");
  assertEq(app.notify, false, "notify 默认关闭");
  if (!app.id) throw new Error("缺少 id");
  assertEq((await bodyOf(await call("/api/apps"))).length, 2, "列表长度(示例+新增)");
});

await test("POST 校验:缺名称 / 仓库格式 / winget 缺发布者 / 非法渠道 均返回 400", async () => {
  assertEq((await call("/api/apps", post({ channel: "manual" }))).status, 400, "缺名称");
  assertEq((await call("/api/apps", post({ name: "X", channel: "github", repo: "justname" }))).status, 400, "仓库格式");
  assertEq((await call("/api/apps", post({ name: "X", channel: "winget", packageId: "nodot" }))).status, 400, "winget 缺发布者");
  assertEq((await call("/api/apps", post({ name: "X", channel: "npm" }))).status, 400, "非法渠道");
});

await test("POST 新增 Chocolatey 应用:粘贴包页面链接可归一化", async () => {
  const res = await call("/api/apps", post({ name: "VLC", channel: "chocolatey", packageId: "https://community.chocolatey.org/packages/vlc/" }));
  assertEq(res.status, 201, "状态码");
  assertEq((await bodyOf(res)).packageId, "vlc", "包 ID 归一化");
});

await test("POST refresh:GitHub 查询最新版本并更新记录", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  const app = await bodyOf(res);
  assertEq(app.latestVersion, "v2.0.0", "最新版本");
  if (!app.lastCheckedAt) throw new Error("缺少 lastCheckedAt");
  if (app.releaseUrl !== ghBody.html_url) throw new Error("缺少 releaseUrl");
  assertEq(app.notifiedVersion, "v2.0.0", "手动刷新后记录 notifiedVersion");
});

await test("iconUrl:可自定义图标地址,非 https 拒绝,留空则为空串", async () => {
  const ok = await bodyOf(await call("/api/apps", post({
    name: "带图标", channel: "manual", version: "1.0",
    iconUrl: "https://cdn.example.com/icon.png",
  })));
  assertEq(ok.iconUrl, "https://cdn.example.com/icon.png", "自定义图标保留");

  const noIcon = await bodyOf(await call("/api/apps", post({ name: "无图标", channel: "manual", version: "1.0" })));
  assertEq(noIcon.iconUrl, "", "默认空串");

  assertEq((await call("/api/apps", post({ name: "X", channel: "manual", iconUrl: "http://a/b.png" }))).status, 400, "http 拒绝");
  assertEq((await call("/api/apps", post({ name: "X", channel: "manual", iconUrl: "not-a-url" }))).status, 400, "非法 URL");

  const upd = await bodyOf(await call("/api/apps/" + ok.id, put({ iconUrl: "https://cdn.example.com/v2.png" })));
  assertEq(upd.iconUrl, "https://cdn.example.com/v2.png", "更新图标");

  await call("/api/apps/" + ok.id, { method: "DELETE" });
  await call("/api/apps/" + noIcon.id, { method: "DELETE" });
});

await test("POST refresh:GitHub 无 latest Release 时回退到最近一条", async () => {
  ghMode = "notfound";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(res)).latestVersion, "v2.0.0", "回退版本");
  ghMode = "ok";
});

await test("POST refresh:GitHub 速率受限时返回 429,含重置时间与 GITHUB_TOKEN 建议", async () => {
  ghMode = "ratelimited";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 429, "状态码");
  const err = (await bodyOf(res)).error;
  if (!/速率受限/.test(err)) throw new Error("缺少限流提示: " + err);
  if (!/GITHUB_TOKEN/.test(err)) throw new Error("缺少 GITHUB_TOKEN 建议: " + err);
  if (!/重置/.test(err)) throw new Error("缺少重置时间: " + err);
  ghMode = "ok";
});

await test("POST refresh:Chocolatey 主路径——从 302 Location 解析版本(不下载包)", async () => {
  chocoMode = "ok";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "chocolatey");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  const app = await bodyOf(res);
  assertEq(app.latestVersion, "9.9.9", "从 vlc.9.9.9.nupkg 解析版本");
  if (app.releaseUrl !== "https://community.chocolatey.org/packages/vlc") throw new Error("releaseUrl 不符: " + app.releaseUrl);
});

await test("POST refresh:Chocolatey 无 Location 时回退 OData", async () => {
  chocoMode = "odataonly";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "chocolatey");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  const app = await bodyOf(res);
  assertEq(app.latestVersion, "9.9.9", "OData 兜底版本");
  assertEq(app.publishedAt, "2026-01-01T00:00:00Z", "发布时间");
  chocoMode = "ok";
});

await test("POST refresh:Chocolatey 403 给出 WAF 拦截提示(非笼统报错)", async () => {
  chocoMode = "blocked";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "chocolatey");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 403, "状态码");
  const err = (await bodyOf(res)).error;
  if (!/WAF|拦截/.test(err)) throw new Error("未提示 WAF 拦截: " + err);
  if (!/winget/.test(err)) throw new Error("未给出替代渠道建议: " + err);
  chocoMode = "ok";
});

await test("POST refresh:Chocolatey 无此包返回 404", async () => {
  chocoMode = "notfound";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "chocolatey");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 404, "状态码");
  if (!/未找到/.test((await bodyOf(res)).error)) throw new Error("提示文案不符");
  chocoMode = "ok";
});

await test("POST 新增 winget 应用并查询:多段版本号正确排序取最新", async () => {
  const created = await bodyOf(await call("/api/apps", post({ name: "VLC (winget)", channel: "winget", packageId: "VideoLAN.VLC" })));
  const res = await call("/api/apps/" + created.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  const app = await bodyOf(res);
  assertEq(app.latestVersion, "9.10.0", "版本排序(9.10.0 > 9.9.9)");
  if (!/winget-pkgs\/tree\/master\/manifests\/v\/VideoLAN\/VLC$/.test(app.releaseUrl)) throw new Error("releaseUrl 不符: " + app.releaseUrl);
});

await test("官方自查:Chrome 风格响应按 releases.0.version 取值", async () => {
  const created = await bodyOf(await call("/api/apps", post({
    name: "Google Chrome", channel: "official",
    officialUrl: "https://official.example/chrome?pageSize=1", jsonPath: "releases.0.version",
  })));
  const res = await call("/api/apps/" + created.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(res)).latestVersion, "156.0.8078.80", "版本号");
});

await test("官方自查:.NET 风格响应按 [channel-version=10.0] 过滤取值", async () => {
  const created = await bodyOf(await call("/api/apps", post({
    name: ".NET 10", channel: "official",
    officialUrl: "https://official.example/dotnet/releases-index.json",
    jsonPath: "releases-index[channel-version=10.0].latest-release",
  })));
  const res = await call("/api/apps/" + created.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(res)).latestVersion, "10.0.14", "过滤后版本");
});

await test("官方自查:非法 URL / 内网地址 / 缺字段路径 均返回 400", async () => {
  assertEq((await call("/api/apps", post({ name: "X", channel: "official", officialUrl: "ftp://a/b", jsonPath: "a" }))).status, 400, "非 https");
  assertEq((await call("/api/apps", post({ name: "X", channel: "official", officialUrl: "http://official.example/a", jsonPath: "a" }))).status, 400, "http");
  const lan = await call("/api/apps", post({ name: "X", channel: "official", officialUrl: "https://127.0.0.1/a.json", jsonPath: "a" }));
  assertEq(lan.status, 400, "内网地址");
  if (!/内网|本机/.test((await bodyOf(lan)).error)) throw new Error("缺少内网提示");
  assertEq((await call("/api/apps", post({ name: "X", channel: "official", officialUrl: "https://official.example/a", jsonPath: "" }))).status, 400, "缺路径");
});

await test("官方自查:非 JSON / 路径取不到值 返回明确错误", async () => {
  const notJson = await bodyOf(await call("/api/apps", post({
    name: "非JSON", channel: "official", officialUrl: "https://official.example/notjson", jsonPath: "a",
  })));
  const r1 = await call("/api/apps/" + notJson.id + "/refresh", { method: "POST" });
  assertEq(r1.status, 502, "非 JSON 状态码");
  if (!/不是 JSON/.test((await bodyOf(r1)).error)) throw new Error("缺少 JSON 提示");

  const missing = await bodyOf(await call("/api/apps", post({
    name: "取值失败", channel: "official", officialUrl: "https://official.example/missing", jsonPath: "releases.0.version",
  })));
  const r2 = await call("/api/apps/" + missing.id + "/refresh", { method: "POST" });
  assertEq(r2.status, 404, "取不到值状态码");
  if (!/未找到版本字段/.test((await bodyOf(r2)).error)) throw new Error("缺少路径提示");

  // 清理这两个测试应用
  await call("/api/apps/" + notJson.id, { method: "DELETE" });
  await call("/api/apps/" + missing.id, { method: "DELETE" });
});

await test("官方自查:修改 API 地址或字段路径会清空旧查询结果", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "official" && a.jsonPath === "releases.0.version");
  const res = await call("/api/apps/" + target.id, put({ jsonPath: "releases.1.version" }));
  const updated = await bodyOf(res);
  if (updated.latestVersion !== undefined) throw new Error("latestVersion 未清空");
  if (updated.lastCheckedAt !== undefined) throw new Error("lastCheckedAt 未清空");
  assertEq(updated.jsonPath, "releases.1.version", "路径已更新");
});

await test("POST refresh:winget 源无此包返回 404", async () => {
  wingetMode = "notfound";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "winget");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 404, "状态码");
  if (!/未找到/.test((await bodyOf(res)).error)) throw new Error("提示文案不符");
  wingetMode = "ok";
});

await test("manual 渠道 refresh 返回 400 提示手动维护", async () => {
  const created = await bodyOf(await call("/api/apps", post({ name: "手动应用", channel: "manual", version: "3.1.4" })));
  const res = await call("/api/apps/" + created.id + "/refresh", { method: "POST" });
  assertEq(res.status, 400, "状态码");
  const b = await bodyOf(res);
  if (!/手动/.test(b.error)) throw new Error("提示文案不符: " + b.error);
});

await test("PUT 更新名称与版本号生效,notify 开关可关闭", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id, put({ name: "Foo Bar 改", version: "v2.0.0", notify: false }));
  assertEq(res.status, 200, "状态码");
  const updated = await bodyOf(res);
  assertEq(updated.name, "Foo Bar 改", "名称");
  assertEq(updated.version, "v2.0.0", "版本");
  assertEq(updated.notify, false, "notify 开关");
  assertEq(updated.repo, "foo/bar", "repo 保留");
  await call("/api/apps/" + target.id, put({ notify: true }));
});

await test("PUT 切换为 manual 渠道后清空查询缓存字段", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "chocolatey");
  const res = await call("/api/apps/" + target.id, put({ channel: "manual" }));
  const updated = await bodyOf(res);
  assertEq(updated.channel, "manual", "渠道");
  assertEq(updated.packageId, "", "包 ID 清空");
  if (updated.latestVersion !== undefined) throw new Error("latestVersion 未清空");
  if (updated.notifiedVersion !== undefined) throw new Error("notifiedVersion 未清空");
  await call("/api/apps/" + target.id, put({ channel: "chocolatey", packageId: "vlc" }));
});

await test("PUT 不存在的 id 返回 404", async () => {
  const res = await call("/api/apps/00000000-0000-0000-0000-000000000000", put({ name: "X" }));
  assertEq(res.status, 404, "状态码");
});

await test("appUrl/downloadUrl/linkName:可保存、校验 https、默认值正确", async () => {
  const ok = await bodyOf(await call("/api/apps", post({
    name: "带链接", channel: "manual", version: "1.0",
    appUrl: "https://example.com/app",
    downloadUrl: "https://example.com/app/setup.exe",
    linkName: true,
  })));
  assertEq(ok.appUrl, "https://example.com/app", "官网地址");
  assertEq(ok.downloadUrl, "https://example.com/app/setup.exe", "下载地址");
  assertEq(ok.linkName, true, "显示为链接");

  const plain = await bodyOf(await call("/api/apps", post({ name: "无链接", channel: "manual" })));
  assertEq(plain.appUrl, "", "默认空官网");
  assertEq(plain.downloadUrl, "", "默认空下载");
  assertEq(plain.linkName, false, "默认不启用链接");

  assertEq((await call("/api/apps", post({ name: "X", channel: "manual", appUrl: "http://a.com" }))).status, 400, "http 官网拒绝");
  assertEq((await call("/api/apps", post({ name: "X", channel: "manual", downloadUrl: "http://a.com/x.exe" }))).status, 400, "http 下载拒绝");

  await call("/api/apps/" + ok.id, { method: "DELETE" });
  await call("/api/apps/" + plain.id, { method: "DELETE" });
});

await test("detect-links:下载资产优先级 x64.exe > x64.msi > 其他", async () => {
  const detect = async (names) => {
    ghAssets = names;
    const d = await bodyOf(await call("/api/apps/detect-links", post({ name: "T", channel: "github", repo: "foo/bar" })));
    return decodeURIComponent((d.downloadUrl || "").split("/").pop());
  };

  // x64.exe 优先于 x64.msi
  assertEq(await detect(["app-x64.msi", "app-x64.exe"]), "app-x64.exe", "x64.exe 优先");
  // 只有 msi 时选 x64.msi,而不是 arm64.exe
  assertEq(await detect(["app-arm64.exe", "app-x64.msi"]), "app-x64.msi", "x64.msi 优于 arm exe");
  // 跳过校验/签名等非安装文件
  assertEq(await detect(["app-x64.exe.sha256", "checksums.txt", "app-x64.exe"]), "app-x64.exe", "跳过校验文件");
  // 其它平台安装包可作兜底
  assertEq(await detect(["app-arm64.dmg", "app-x64.deb"]), "app-x64.deb", "非 Windows 时按平台打分");
  // 没有任何资产时回退到 Release 页面
  ghAssets = [];
  const none = await bodyOf(await call("/api/apps/detect-links", post({ name: "T", channel: "github", repo: "foo/bar" })));
  if (!/\/releases\/tag\//.test(none.downloadUrl)) throw new Error("应回退到 Release 页面: " + none.downloadUrl);
  ghAssets = null;
});

await test("detect-links:返回按分数排序的候选下载列表", async () => {
  ghAssets = ["app-x64.msi", "app-x64.exe", "app-arm64.exe", "checksums.txt"];
  const d = await bodyOf(await call("/api/apps/detect-links", post({ name: "T", channel: "github", repo: "foo/bar" })));
  assertEq(d.downloads.length, 3, "候选数(跳过 checksums)");
  assertEq(d.downloads.map((x) => x.name), ["app-x64.exe", "app-x64.msi", "app-arm64.exe"], "按分数降序");
  assertEq(d.downloads[0].kind, "exe", "类型");
  assertEq(d.downloads[0].arch, "x64", "架构");
  assertEq(d.downloads[2].arch, "arm", "arm 架构");
  assertEq(d.downloadUrl, d.downloads[0].url, "首选应为列表第一个");
  ghAssets = null;
});

await test("downloads 字段:保存候选列表、校验 https、排序与去重", async () => {
  const app = await bodyOf(await call("/api/apps", post({
    name: "多候选", channel: "manual", version: "1.0",
    downloadUrl: "https://e.com/b.msi",
    downloads: [
      { name: "b.msi", url: "https://e.com/b.msi", score: 95, kind: "msi", arch: "x64" },
      { name: "a.exe", url: "https://e.com/a.exe", score: 100, kind: "exe", arch: "x64" },
      { name: "bad", url: "http://e.com/c.exe", score: 90 },        // 非 https 应丢弃
      { name: "dup", url: "https://e.com/a.exe", score: 50 },        // 重复应去重
    ],
  })));
  assertEq(app.downloads.length, 2, "只剩 2 个有效且去重后的候选");
  assertEq(app.downloads.map((x) => x.name), ["a.exe", "b.msi"], "按分数降序");
  assertEq(app.downloads[0].url, "https://e.com/a.exe", "地址");
  await call("/api/apps/" + app.id, { method: "DELETE" });
});

await test("detect-links:GitHub 渠道返回仓库主页与 Release 下载页", async () => {
  const res = await call("/api/apps/detect-links", post({ name: "Foo Bar", channel: "github", repo: "foo/bar" }));
  assertEq(res.status, 200, "状态码");
  const d = await bodyOf(res);
  assertEq(d.appUrl, "https://github.com/foo/bar", "仓库主页");
  if (!d.downloadUrl) throw new Error("缺少下载地址");
  assertEq(d.source, "github-release", "来源");
});

await test("detect-links:Chocolatey/winget 渠道可推导页面地址;未登录 401", async () => {
  const anon = await worker.fetch(new Request("http://localhost/api/apps/detect-links", post({ channel: "github", repo: "a/b" })), env, ctx);
  assertEq(anon.status, 401, "未登录");

  const c = await bodyOf(await call("/api/apps/detect-links", post({ channel: "chocolatey", packageId: "vlc" })));
  assertEq(c.appUrl, "https://community.chocolatey.org/packages/vlc", "choco 页面");

  const w = await bodyOf(await call("/api/apps/detect-links", post({ channel: "winget", packageId: "VideoLAN.VLC" })));
  assertEq(w.source, "winget", "winget 来源");
});

/* ── A1/A3/A4 修复与 A2 同步验证 ── */

await test("A1: 导入 v1 旧备份(无 groups 字段)不再清空现有分组", async () => {
  // 建一个分组 + 一个归组应用
  const g = await bodyOf(await call("/api/groups", post({ name: "保留组" })));
  const a = await bodyOf(await call("/api/apps", post({ name: "归组应用", channel: "manual", groupId: g.id })));

  // 模拟 v1 备份:只有 apps,没有 groups 字段
  const v1 = { format: "app-version-backup", version: 1, apps: [{ name: "旧备份应用", channel: "manual", version: "1.0" }] };
  const imp = await bodyOf(await call("/api/apps/import", post(v1)));
  assertEq(imp.groups, 0, "未导入分组");
  assertEq(imp.imported, 1, "导入应用数");

  // 关键断言:现有分组仍然存在
  const groups = await bodyOf(await call("/api/groups"));
  assertEq(groups.some((x) => x.id === g.id), true, "分组未被清空");
  // 归组应用的分组关联也被保留(应用列表整体被覆盖,但该应用重新导入后归组关系在 v1 里本就没有)
  assertEq(groups.length, 1, "分组数量不变");

  await call("/api/apps/" + a.id, { method: "DELETE" });
  await call("/api/groups/" + g.id, { method: "DELETE" });
});

await test("A3: POST /api/apps 服务端自动分配 order(追加到末尾)", async () => {
  const a1 = await bodyOf(await call("/api/apps", post({ name: "顺序1", channel: "manual" })));
  const a2 = await bodyOf(await call("/api/apps", post({ name: "顺序2", channel: "manual" })));
  if (!(a2.order > a1.order)) throw new Error(`order 未递增: ${a1.order} → ${a2.order}`);
  await call("/api/apps/" + a1.id, { method: "DELETE" });
  await call("/api/apps/" + a2.id, { method: "DELETE" });
});

await test("A4: 应用名称超过 100 字符时服务端拒绝", async () => {
  const res = await call("/api/apps", post({ name: "A".repeat(101), channel: "manual" }));
  assertEq(res.status, 400, "状态码");
  if (!/100/.test((await bodyOf(res)).error)) throw new Error("提示未包含上限");
  const ok = await call("/api/apps", post({ name: "A".repeat(100), channel: "manual" }));
  assertEq(ok.status, 201, "100 字恰好可通过");
  const list = await bodyOf(await call("/api/apps"));
  await call("/api/apps/" + list[0].id, { method: "DELETE" });
});

await test("A2: refresh 同步更新 downloads 候选列表", async () => {
  // 构造一个带资产的 Release,刷新后 downloads 应该被写入
  ghAssets = ["app-x64.exe", "app-x64.msi", "checksums.txt"];
  const a = await bodyOf(await call("/api/apps", post({ name: "同步候选", channel: "github", repo: "foo/bar" })));
  const r = await call("/api/apps/" + a.id + "/refresh", { method: "POST" });
  assertEq(r.status, 200, "刷新状态码");
  const app = await bodyOf(r);
  assertEq(Array.isArray(app.downloads), true, "downloads 已写入");
  assertEq(app.downloads.length, 2, "候选数量(跳过校验文件)");
  assertEq(app.downloads[0].name, "app-x64.exe", "首选资产");
  ghAssets = null;
  await call("/api/apps/" + a.id, { method: "DELETE" });
});

await test("diagnostics:仅管理员可访问,返回配置状态与 GitHub 额度", async () => {
  // 未登录 401
  const anon = await worker.fetch(new Request("http://localhost/api/diagnostics"), env, ctx);
  assertEq(anon.status, 401, "未登录状态码");

  // 用一个带 GITHUB_TOKEN 的环境,验证能识别出"已配置"
  const envD = {
    APP_KV: makeKV(), ADMIN_PASSWORD: "pd", CRON_SECRET: "cd",
    GITHUB_TOKEN: "ghp_faketoken123",
    FEISHU_WEBHOOK_URL: "https://x/hook",
  };
  const { cookie } = await loginAs(envD, "pd");
  const res = await worker.fetch(
    new Request("http://localhost/api/diagnostics", { headers: { cookie: "av_session=" + cookie } }),
    envD, ctx
  );
  assertEq(res.status, 200, "状态码");
  const d = await bodyOf(res);

  assertEq(d.config.kv, true, "KV");
  assertEq(d.config.githubToken, true, "token 已配置");
  if (!/长度 \d+/.test(d.config.githubTokenHint)) throw new Error("token 提示应含长度但不泄露内容");
  if (d.config.githubTokenHint.includes("ghp_faketoken123")) throw new Error("不应泄露 token 明文");
  assertEq(d.config.cronSecret, true, "cron secret");
  assertEq(d.config.notify.feishu, true, "飞书渠道");
  assertEq(d.config.notify.telegram, false, "telegram 未配置");
  if (!Array.isArray(d.hints)) throw new Error("缺少 hints");
});

await test("diagnostics:未配置 GITHUB_TOKEN 时给出告警", async () => {
  const envE = { APP_KV: makeKV(), ADMIN_PASSWORD: "pe" };
  const { cookie } = await loginAs(envE, "pe");
  const res = await worker.fetch(
    new Request("http://localhost/api/diagnostics", { headers: { cookie: "av_session=" + cookie } }),
    envE, ctx
  );
  const d = await bodyOf(res);
  assertEq(d.config.githubToken, false, "token 未配置");
  if (!d.hints.some((h) => h.level === "warn" && /GITHUB_TOKEN/.test(h.text))) {
    throw new Error("缺少 GITHUB_TOKEN 告警");
  }
});

/* ── 分组与布局 ── */

await test("分组:创建/重命名/删除,删除后组内应用回到未分组", async () => {
  const g1 = await bodyOf(await call("/api/groups", post({ name: "  浏览器  " })));
  assertEq(g1.name, "浏览器", "名称去空白");
  assertEq(g1.order, 0, "首个分组 order");
  assertEq(g1.collapsed, false, "默认展开");

  const g2 = await bodyOf(await call("/api/groups", post({ name: "开发工具" })));
  assertEq(g2.order, 1, "order 递增");

  assertEq(await bodyOf(await call("/api/groups")), [g1, g2].map(x => ({ ...x, order: x.order })), "列表");
  assertEq((await call("/api/groups", post({ name: "   " }))).status, 400, "空名称拒绝");
  assertEq((await call("/api/groups", post({ name: "x".repeat(41) }))).status, 400, "超长拒绝");

  const renamed = await bodyOf(await call("/api/groups/" + g1.id, put({ name: "网页浏览器" })));
  assertEq(renamed.name, "网页浏览器", "重命名");

  // 把应用放进 g2 后删除 g2
  const app = await bodyOf(await call("/api/apps", post({ name: "组内应用", channel: "manual", groupId: g2.id })));
  const del = await bodyOf(await call("/api/groups/" + g2.id, { method: "DELETE" }));
  assertEq(del.movedApps, 1, "移出应用数");
  const after = (await bodyOf(await call("/api/apps"))).find((a) => a.id === app.id);
  assertEq(after.groupId, null, "应用回到未分组");
  await call("/api/apps/" + app.id, { method: "DELETE" });
  await call("/api/groups/" + g1.id, { method: "DELETE" });
});

await test("布局:一次性保存分组顺序与卡片归属/顺序,非法分组引用被清洗", async () => {
  const ga = await bodyOf(await call("/api/groups", post({ name: "A 组" })));
  const gb = await bodyOf(await call("/api/groups", post({ name: "B 组" })));
  const a1 = await bodyOf(await call("/api/apps", post({ name: "卡片1", channel: "manual" })));
  const a2 = await bodyOf(await call("/api/apps", post({ name: "卡片2", channel: "manual" })));

  const res = await call("/api/layout", put({
    groups: [{ id: gb.id }, { id: ga.id }],            // 反转分组顺序
    apps: [
      { id: a1.id, groupId: ga.id, order: 0 },
      { id: a2.id, groupId: "not-exist-id", order: 5 }, // 非法分组应被清洗为 null
    ],
  }));
  assertEq(res.status, 200, "状态码");

  const groups = await bodyOf(await call("/api/groups"));
  // 接口按存储顺序返回,排序由前端按 order 处理;这里校验 order 值
  const gbNow = groups.find((x) => x.id === gb.id);
  const gaNow = groups.find((x) => x.id === ga.id);
  assertEq(gbNow.order, 0, "gb 排到第一");
  assertEq(gaNow.order, 1, "ga 排到第二");

  const apps = await bodyOf(await call("/api/apps"));
  const got1 = apps.find((x) => x.id === a1.id);
  const got2 = apps.find((x) => x.id === a2.id);
  assertEq(got1.groupId, ga.id, "a1 归组");
  assertEq(got1.order, 0, "a1 顺序");
  assertEq(got2.groupId, null, "非法分组被清洗");
  await call("/api/apps/" + a1.id, { method: "DELETE" });
  await call("/api/apps/" + a2.id, { method: "DELETE" });
  await call("/api/groups/" + ga.id, { method: "DELETE" });
  await call("/api/groups/" + gb.id, { method: "DELETE" });
});

await test("分组与布局接口未登录一律 401", async () => {
  const anon = (p, o) => worker.fetch(new Request("http://localhost" + p, o), env, ctx);
  assertEq((await anon("/api/groups", post({ name: "x" }))).status, 401, "创建组");
  assertEq((await anon("/api/groups/abc", put({ name: "x" }))).status, 401, "改组");
  assertEq((await anon("/api/groups/abc", { method: "DELETE" })).status, 401, "删组");
  assertEq((await anon("/api/layout", put({ groups: [], apps: [] }))).status, 401, "布局");
  assertEq((await anon("/api/groups")).status, 200, "查看组公开");
});

await test("导出/导入包含分组:备份可完整还原", async () => {
  // 清空既有分组,保证断言基数确定
  for (const x of await bodyOf(await call("/api/groups"))) {
    await call("/api/groups/" + x.id, { method: "DELETE" });
  }
  const g = await bodyOf(await call("/api/groups", post({ name: "备份组" })));
  const a = await bodyOf(await call("/api/apps", post({ name: "备份卡片", channel: "manual", groupId: g.id })));

  const backup = await bodyOf(await call("/api/apps/export"));
  assertEq(backup.version, 2, "备份版本");
  assertEq(backup.groupCount, 1, "分组数");
  assertEq(backup.groups[0].name, "备份组", "分组名");

  const imp = await bodyOf(await call("/api/apps/import", post(backup)));
  assertEq(imp.groups, 1, "导入分组数");
  assertEq(imp.imported, backup.count, "导入应用数应与备份一致");

  const apps = await bodyOf(await call("/api/apps"));
  const restored = apps.find((x) => x.id === a.id);
  assertEq(restored.groupId, g.id, "分组关联保留");
  assertEq(apps.length, backup.count, "导入后应用总数");
  await call("/api/apps/" + a.id, { method: "DELETE" });
  await call("/api/groups/" + g.id, { method: "DELETE" });
});

await test("DELETE 删除应用成功", async () => {
  // A1 的导入测试会整体覆盖列表,这里自建应用保证确定性
  const target = await bodyOf(await call("/api/apps", post({ name: "待删除", channel: "manual", version: "1.0" })));
  const res = await call("/api/apps/" + target.id, { method: "DELETE" });
  assertEq(res.status, 200, "状态码");
  const rest = await bodyOf(await call("/api/apps"));
  if (rest.some((a) => a.id === target.id)) throw new Error("未删除");
});

await test("清空全部应用后,示例不会重新注入(仅首次运行)", async () => {
  const list = await bodyOf(await call("/api/apps"));
  for (const a of list) {
    const res = await call("/api/apps/" + a.id, { method: "DELETE" });
    assertEq(res.status, 200, "删除 " + a.name);
  }
  assertEq(await bodyOf(await call("/api/apps")), [], "清空后保持为空");
});

/* ── 配置导出 / 导入 ── */

await test("GET /api/apps/export:未登录 401,管理员导出为附件 JSON", async () => {
  const anon = await worker.fetch(new Request("http://localhost/api/apps/export"), env, ctx);
  assertEq(anon.status, 401, "未登录状态码");
  const res = await call("/api/apps/export");
  assertEq(res.status, 200, "状态码");
  if (!/attachment/.test(res.headers.get("content-disposition") || "")) throw new Error("应为附件下载");
  const data = await bodyOf(res);
  assertEq(data.format, "app-version-backup", "格式标识");
  if (!Array.isArray(data.apps)) throw new Error("缺少 apps 数组");
  assertEq(data.apps.length, 0, "当前为空列表");
});

await test("POST /api/apps/import:未登录 401;格式错误与坏记录返回 400 并带序号", async () => {
  const anon = await worker.fetch(new Request("http://localhost/api/apps/import", post({ apps: [] })), env, ctx);
  assertEq(anon.status, 401, "未登录状态码");
  assertEq((await call("/api/apps/import", post({ foo: 1 }))).status, 400, "缺 apps 数组");
  const bad = await call("/api/apps/import", post({ apps: [{ channel: "manual" }] }));
  assertEq(bad.status, 400, "缺名称记录");
  if (!/第 1 条/.test((await bodyOf(bad)).error)) throw new Error("缺少序号提示");
});

await test("POST /api/apps/import:导入覆盖列表,保留合法 id 并归一化", async () => {
  const rec = { id: "custom-id-123", name: "导入应用", channel: "github", repo: "https://github.com/foo/bar/", version: "v1.0.0" };
  const res = await call("/api/apps/import", post({ apps: [rec] }));
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(res)).imported, 1, "导入数量");
  const list = await bodyOf(await call("/api/apps"));
  assertEq(list.length, 1, "覆盖后长度");
  assertEq(list[0].id, "custom-id-123", "id 保留");
  assertEq(list[0].repo, "foo/bar", "repo 归一化");
});

await test("POST /api/apps/import:也接受裸数组", async () => {
  const res = await call("/api/apps/import", post([{ name: "裸数组应用", channel: "manual", version: "1.0" }]));
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(await call("/api/apps"))).length, 1, "覆盖后长度");
});

await test("未知接口返回 404,响应为 JSON", async () => {
  const res = await call("/api/unknown");
  assertEq(res.status, 404, "状态码");
  assertEq(res.headers.get("content-type"), "application/json; charset=utf-8", "Content-Type");
  const b = await bodyOf(res);
  if (!b.error) throw new Error("缺少 error 字段");
});

await test("未绑定 KV 时返回 500 并提示 APP_KV", async () => {
  const res = await worker.fetch(new Request("http://localhost/api/apps"), {}, ctx);
  assertEq(res.status, 500, "状态码");
  const b = await bodyOf(res);
  if (!/APP_KV/.test(b.error)) throw new Error("提示缺少 APP_KV: " + b.error);
});

await test("非 /api 路径回退到 ASSETS 绑定", async () => {
  const env2 = { APP_KV: makeKV(), ADMIN_PASSWORD, ASSETS: { fetch: async () => new Response("STATIC_OK") } };
  const res = await worker.fetch(new Request("http://localhost/"), env2, ctx);
  assertEq(await bodyOf(res), "STATIC_OK", "静态回退");
});

await test("POST /api/check:无令牌且未登录 401;错误令牌 401", async () => {
  const anon = await worker.fetch(new Request("http://localhost/api/check", { method: "POST" }), env, ctx);
  assertEq(anon.status, 401, "无令牌状态码");
  const wrong = await worker.fetch(
    new Request("http://localhost/api/check", { method: "POST", headers: { authorization: "Bearer wrong-secret" } }),
    env, ctx
  );
  assertEq(wrong.status, 401, "错误令牌状态码");
});

await test("POST /api/check:CRON_SECRET 触发检查并返回摘要", async () => {
  const env5 = { APP_KV: makeKV(), ADMIN_PASSWORD: "p5", CRON_SECRET: "cron-abc", CHECK_GAP_MS: "1", NOTIFY_WEBHOOK_URL: "https://notify.example/hook" };
  hookCalls.length = 0;
  const { cookie } = await loginAs(env5, "p5");
  const auth = { cookie: "av_session=" + cookie };
  const jsonPost = (b, extra = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify(b),
  });
  await worker.fetch(new Request("http://localhost/api/apps", jsonPost({ name: "检查应用", channel: "github", repo: "foo/bar", version: "v1.0.0", notify: true }, auth)), env5, ctx);

  const res = await worker.fetch(
    new Request("http://localhost/api/check", { method: "POST", headers: { authorization: "Bearer cron-abc" } }),
    env5, ctx
  );
  assertEq(res.status, 200, "状态码");
  const s = await bodyOf(res);
  assertEq(s.ok, true, "ok 标记");
  assertEq(s.checked, 1, "检查数量");
  assertEq(s.updated, 1, "更新数量");
  assertEq(s.updates[0].name, "检查应用", "更新条目");
  assertEq(s.notified, true, "已推送");
  assertEq(hookCalls.length, 1, "推送次数");

  // 再次触发:已推送过,不应重复推送,但仍返回摘要
  const again = await bodyOf(await worker.fetch(
    new Request("http://localhost/api/check", { method: "POST", headers: { authorization: "Bearer cron-abc" } }),
    env5, ctx
  ));
  assertEq(again.updated, 0, "二次检查无新更新");
  assertEq(hookCalls.length, 1, "无重复推送");
});

await test("POST /api/check:已有任务执行中返回 409 并发锁", async () => {
  const kv5 = makeKV();
  const env6 = { APP_KV: kv5, ADMIN_PASSWORD: "p6", CRON_SECRET: "cron-abc", CHECK_GAP_MS: "0" };
  await kv5.put("check:lock", "busy", { expirationTtl: 300 });
  const res = await worker.fetch(
    new Request("http://localhost/api/check", { method: "POST", headers: { authorization: "Bearer cron-abc" } }),
    env6, ctx
  );
  assertEq(res.status, 409, "状态码");
  if (!/执行中/.test((await bodyOf(res)).error)) throw new Error("提示文案不符");
});

await test("POST /api/check:管理员会话也可触发(备用通道)", async () => {
  const env7 = { APP_KV: makeKV(), ADMIN_PASSWORD: "p7", CHECK_GAP_MS: "0" };
  const { cookie } = await loginAs(env7, "p7");
  const res = await worker.fetch(
    new Request("http://localhost/api/check", { method: "POST", headers: { cookie: "av_session=" + cookie } }),
    env7, ctx
  );
  assertEq(res.status, 200, "状态码");
});

/* ── 定时检查 + 通知推送(服务端内部,不受登录态限制)── */

await test("scheduled:发现新版本聚合推送,notifiedVersion 防重复,notify:false 跳过", async () => {
  const env2 = { APP_KV: makeKV(), CHECK_GAP_MS: "1", NOTIFY_WEBHOOK_URL: "https://notify.example/hook", ADMIN_PASSWORD: "p2" };
  hookCalls.length = 0;
  const { cookie: ck2 } = await loginAs(env2, "p2");
  const call2 = (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    headers.cookie = "av_session=" + ck2;
    return worker.fetch(new Request("http://localhost" + path, { ...opts, headers }), env2, ctx);
  };
  // A:GitHub 渠道,当前 v1.0.0 → 应推送
  const a = await bodyOf(await call2("/api/apps", post({ name: "应用A", channel: "github", repo: "foo/bar", version: "v1.0.0", notify: true })));
  // B:GitHub 渠道,关闭通知 → 不应推送
  await call2("/api/apps", post({ name: "应用B", channel: "github", repo: "foo/bar", version: "v1.0.0", notify: false }));
  // C:GitHub 渠道,当前版本已是最新 → 不推送但更新检查时间
  await call2("/api/apps", post({ name: "应用C", channel: "github", repo: "foo/bar", version: "v2.0.0", notify: true }));
  // D:手动渠道 → 完全跳过
  await call2("/api/apps", post({ name: "应用D", channel: "manual", version: "1.0.0", notify: true }));

  await runScheduled(env2);
  assertEq(hookCalls.length, 1, "推送次数");
  const payload = JSON.parse(hookCalls[0].body);
  assertEq(payload.apps.length, 1, "推送应用数");
  assertEq(payload.apps[0].name, "应用A", "推送对象");
  assertEq(payload.apps[0].latestVersion, "v2.0.0", "推送版本");

  const list = await bodyOf(await call2("/api/apps"));
  const a2 = list.find((x) => x.id === a.id);
  assertEq(a2.notifiedVersion, "v2.0.0", "A 记录 notifiedVersion");
  const c2 = list.find((x) => x.name === "应用C");
  if (!c2.lastCheckedAt) throw new Error("C 未更新检查时间");
  const b2 = list.find((x) => x.name === "应用B");
  if (b2.lastCheckedAt) throw new Error("B 不应被检查(notify:false)");
  const d2 = list.find((x) => x.name === "应用D");
  if (d2.latestVersion !== undefined) throw new Error("D 不应被查询");

  // 第二次定时检查:无新版本,不重复推送
  await runScheduled(env2);
  assertEq(hookCalls.length, 1, "去重后推送次数");
});

await test("scheduled:全部渠道发送失败时回滚标记,下次重试", async () => {
  const env3 = { APP_KV: makeKV(), CHECK_GAP_MS: "1", NOTIFY_WEBHOOK_URL: "https://notify.example/hook", ADMIN_PASSWORD: "p3" };
  hookCalls.length = 0;
  // 临时让 webhook 返回 500
  const realMock = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input && input.url;
    if (u === "https://notify.example/hook") return new Response("err", { status: 500 });
    return realMock(input, init);
  };
  try {
    const { cookie: ck3 } = await loginAs(env3, "p3");
    const call3 = (path, opts = {}) => {
      const headers = { ...(opts.headers || {}) };
      headers.cookie = "av_session=" + ck3;
      return worker.fetch(new Request("http://localhost" + path, { ...opts, headers }), env3, ctx);
    };
    await call3("/api/apps", post({ name: "应用E", channel: "github", repo: "foo/bar", version: "v1.0.0", notify: true }));
    await runScheduled(env3);
    assertEq(hookCalls.length, 0, "发送失败不应记录调用");
    const list = await bodyOf(await call3("/api/apps"));
    if (list[0].notifiedVersion !== undefined) throw new Error("发送失败不应记录 notifiedVersion");
    // 恢复后重试成功
    globalThis.fetch = realMock;
    await runScheduled(env3);
    assertEq(hookCalls.length, 1, "重试后推送");
    const list2 = await bodyOf(await call3("/api/apps"));
    assertEq(list2[0].notifiedVersion, "v2.0.0", "重试成功记录 notifiedVersion");
  } finally {
    globalThis.fetch = realMock;
  }
});

async function runScheduled(envX) {
  const waiters = [];
  const schedCtx = { waitUntil: (f) => waiters.push(f), passThroughOnException() {} };
  await worker.scheduled({}, envX, schedCtx);
  await Promise.all(waiters);
}

console.log("\n结果:" + passed + " 通过," + failed + " 失败");
process.exit(failed ? 1 : 0);
