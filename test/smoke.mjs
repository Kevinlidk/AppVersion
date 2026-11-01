/**
 * API 冒烟测试(离线运行,不依赖 wrangler 与网络):
 *   npm test   或   node test/smoke.mjs
 *
 * 通过 mock 全局 fetch(GitHub API)与 KV,对 Worker 的 API 逻辑做验证。
 */
import worker from "../src/worker.js";

/* ── mock GitHub API ── */
let ghMode = "ok"; // ok | notfound | ratelimited
const ghBody = {
  tag_name: "v2.0.0",
  html_url: "https://github.com/foo/bar/releases/tag/v2.0.0",
  published_at: "2026-01-01T00:00:00Z",
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input && input.url;
  if (url && url.startsWith("https://api.github.com/")) {
    if (ghMode === "notfound") {
      // latest 返回 404;/releases?per_page=1 返回最近一条
      if (url.includes("/releases?")) {
        return new Response(JSON.stringify([ghBody]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (ghMode === "ratelimited") {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(ghBody), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input);
};

/* ── KV stub ── */
function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
  };
}

const env = { APP_KV: makeKV() };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, opts) => worker.fetch(new Request("http://localhost" + path, opts), env, ctx);
const bodyOf = async (res) => {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
};

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

await test("GET /api/apps 初始返回空列表", async () => {
  const res = await call("/api/apps");
  assertEq(res.status, 200, "状态码");
  assertEq(await bodyOf(res), [], "列表");
});

await test("POST 新增 GitHub 应用成功,字段归一化", async () => {
  const res = await call("/api/apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Foo Bar", channel: "github", repo: "https://github.com/foo/bar/", version: "v1.0.0", note: "测试" }),
  });
  assertEq(res.status, 201, "状态码");
  const app = await bodyOf(res);
  assertEq(app.repo, "foo/bar", "repo 归一化");
  if (!app.id) throw new Error("缺少 id");
  assertEq((await bodyOf(await call("/api/apps"))).length, 1, "列表长度");
});

await test("POST 校验:缺少名称 / 仓库格式错误 / 非法渠道均返回 400", async () => {
  const post = (b) => call("/api/apps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assertEq((await post({ channel: "manual" })).status, 400, "缺名称");
  assertEq((await post({ name: "X", channel: "github", repo: "justname" })).status, 400, "仓库格式");
  assertEq((await post({ name: "X", channel: "npm" })).status, 400, "非法渠道");
});

await test("POST refresh 查询 GitHub 最新版本并更新记录", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const res = await call("/api/apps/" + list[0].id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  const app = await bodyOf(res);
  assertEq(app.latestVersion, "v2.0.0", "最新版本");
  if (!app.lastCheckedAt) throw new Error("缺少 lastCheckedAt");
  if (app.releaseUrl !== ghBody.html_url) throw new Error("缺少 releaseUrl");
});

await test("POST refresh:无 latest Release 时回退到最近一条", async () => {
  ghMode = "notfound";
  const list = await bodyOf(await call("/api/apps"));
  const res = await call("/api/apps/" + list[0].id + "/refresh", { method: "POST" });
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(res)).latestVersion, "v2.0.0", "回退版本");
  ghMode = "ok";
});

await test("POST refresh:GitHub 速率受限时返回 429 与提示", async () => {
  ghMode = "ratelimited";
  const list = await bodyOf(await call("/api/apps"));
  const res = await call("/api/apps/" + list[0].id + "/refresh", { method: "POST" });
  assertEq(res.status, 429, "状态码");
  const b = await bodyOf(res);
  if (!/速率受限/.test(b.error)) throw new Error("缺少提示文案: " + b.error);
  ghMode = "ok";
});

await test("manual 渠道 refresh 返回 400 提示手动维护", async () => {
  const created = await bodyOf(await call("/api/apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "手动应用", channel: "manual", version: "3.1.4" }),
  }));
  const res = await call("/api/apps/" + created.id + "/refresh", { method: "POST" });
  assertEq(res.status, 400, "状态码");
  const b = await bodyOf(res);
  if (!/手动/.test(b.error)) throw new Error("提示文案不符: " + b.error);
});

await test("PUT 更新名称与版本号生效", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Foo Bar 改", version: "v2.0.0" }),
  });
  assertEq(res.status, 200, "状态码");
  const updated = await bodyOf(res);
  assertEq(updated.name, "Foo Bar 改", "名称");
  assertEq(updated.version, "v2.0.0", "版本");
  assertEq(updated.repo, "foo/bar", "repo 保留");
});

await test("PUT 切换为 manual 渠道后清空查询缓存字段", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const target = list.find((a) => a.channel === "github");
  const res = await call("/api/apps/" + target.id, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "manual" }),
  });
  const updated = await bodyOf(res);
  assertEq(updated.channel, "manual", "渠道");
  assertEq(updated.repo, "", "repo 清空");
  if (updated.latestVersion !== undefined) throw new Error("latestVersion 未清空");
});

await test("PUT 不存在的 id 返回 404", async () => {
  const res = await call("/api/apps/00000000-0000-0000-0000-000000000000", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X" }),
  });
  assertEq(res.status, 404, "状态码");
});

await test("DELETE 删除应用成功", async () => {
  const list = await bodyOf(await call("/api/apps"));
  const res = await call("/api/apps/" + list[0].id, { method: "DELETE" });
  assertEq(res.status, 200, "状态码");
  assertEq((await bodyOf(await call("/api/apps"))).length, 1, "删除后长度");
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
  const env2 = { APP_KV: makeKV(), ASSETS: { fetch: async () => new Response("STATIC_OK") } };
  const res = await worker.fetch(new Request("http://localhost/"), env2, ctx);
  assertEq(await bodyOf(res), "STATIC_OK", "静态回退");
});

console.log("\n结果:" + passed + " 通过," + failed + " 失败");
process.exit(failed ? 1 : 0);
