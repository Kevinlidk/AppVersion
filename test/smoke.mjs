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
};
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
    return new Response(JSON.stringify(ghBody), { status: 200, headers: { "content-type": "application/json" } });
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

await test("DELETE 删除应用成功", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.name === "VLC (winget)");
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
