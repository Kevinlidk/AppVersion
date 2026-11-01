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
let chocoMode = "ok"; // ok | notfound
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
  if (u.startsWith("https://community.chocolatey.org/")) {
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
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(ghBody), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u === "https://notify.example/hook") {
    hookCalls.push({ url: u, body: init && init.body });
    return new Response("{}", { status: 200 });
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
  assertEq(sample.notify, true, "通知默认开启");
});

await test("POST 新增 GitHub 应用成功,字段归一化", async () => {
  const res = await call("/api/apps", post({ name: "Foo Bar", channel: "github", repo: "https://github.com/foo/bar/", version: "v1.0.0", note: "测试" }));
  assertEq(res.status, 201, "状态码");
  const app = await bodyOf(res);
  assertEq(app.repo, "foo/bar", "repo 归一化");
  assertEq(app.notify, true, "notify 默认开启");
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

await test("POST refresh:GitHub 无 latest Release 时回退到最近一条", async () => {
  ghMode = "notfound";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(res)).latestVersion, "v2.0.0", "回退版本");
  ghMode = "ok";
});

await test("POST refresh:GitHub 速率受限时返回 429 与提示", async () => {
  ghMode = "ratelimited";
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 429, "状态码");
  const b = await bodyOf(res);
  if (!/速率受限/.test(b.error)) throw new Error("缺少提示文案: " + b.error);
  ghMode = "ok";
});

await test("POST refresh:Chocolatey 查询成功并解析 XML", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "chocolatey");
  const res = await call("/api/apps/" + target.id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  const app = await bodyOf(res);
  assertEq(app.latestVersion, "9.9.9", "最新版本");
  if (app.releaseUrl !== "https://community.chocolatey.org/packages/vlc") throw new Error("releaseUrl 不符: " + app.releaseUrl);
  assertEq(app.publishedAt, "2026-01-01T00:00:00Z", "发布时间");
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
  const a = await bodyOf(await call2("/api/apps", post({ name: "应用A", channel: "github", repo: "foo/bar", version: "v1.0.0" })));
  // B:GitHub 渠道,关闭通知 → 不应推送
  await call2("/api/apps", post({ name: "应用B", channel: "github", repo: "foo/bar", version: "v1.0.0", notify: false }));
  // C:GitHub 渠道,当前版本已是最新 → 不推送但更新检查时间
  await call2("/api/apps", post({ name: "应用C", channel: "github", repo: "foo/bar", version: "v2.0.0" }));
  // D:手动渠道 → 完全跳过
  await call2("/api/apps", post({ name: "应用D", channel: "manual", version: "1.0.0" }));

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
    await call3("/api/apps", post({ name: "应用E", channel: "github", repo: "foo/bar", version: "v1.0.0" }));
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
