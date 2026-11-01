/**
 * 轻量本地预览服务器(无需安装 wrangler):
 *   npm run serve   或   node test/dev-server.mjs
 *   默认地址 http://127.0.0.1:8799(可用环境变量 PORT 修改)
 *
 * - /api/* 由 src/worker.js 处理(KV 为内存模拟,重启后清空)
 * - 其余路径读取 public/ 下的静态文件
 * - 对 GitHub / Chocolatey 的请求返回固定示例数据,便于离线演示
 * - POST /__run-check 手动触发一次定时检查流程(演示通知推送)
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/worker.js";

const PORT = Number(process.env.PORT || 8799);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(ROOT, "../public");

const kvStore = new Map();
const NOTIFY_URL = "http://127.0.0.1:" + PORT + "/__notify";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const env = {
  NOTIFY_WEBHOOK_URL: NOTIFY_URL,
  CHECK_GAP_MS: "10",
  ADMIN_PASSWORD,
  APP_KV: {
    async get(k) { return kvStore.has(k) ? kvStore.get(k) : null; },
    async put(k, v) { kvStore.set(k, String(v)); },
    async delete(k) { kvStore.delete(k); },
  },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

/* 拦截外部 API,离线演示 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input && input.url;
  const u = url || "";
  if (u.startsWith("https://api.github.com/repos/microsoft/winget-pkgs/contents/")) {
    return new Response(
      JSON.stringify([
        { name: "1.0.0", type: "dir" },
        { name: "9.9.9", type: "dir" },
        { name: "readme.md", type: "file" },
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (u.startsWith("https://api.github.com/") && u.includes("/releases")) {
    return new Response(
      JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/example/repo/releases/tag/v9.9.9",
        published_at: "2026-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (u.startsWith("https://community.chocolatey.org/")) {
    return new Response(
      '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<entry><updated>2026-01-01T00:00:00Z</updated>' +
      '<m:properties xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">' +
      '<d:Version xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">9.9.9</d:Version>' +
      "</m:properties></entry></feed>",
      { status: 200, headers: { "content-type": "application/atom+xml" } }
    );
  }
  if (u === NOTIFY_URL) {
    console.log("[notify] 推送内容:", init && init.body);
    return new Response("{}", { status: 200 });
  }
  return realFetch(input, init);
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  try {
    if (url.pathname === "/__notify") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      console.log("[notify] webhook 收到:", Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    if (url.pathname === "/__run-check" && req.method === "POST") {
      const waiters = [];
      const checkCtx = { waitUntil: (f) => waiters.push(f), passThroughOnException() {} };
      await worker.scheduled({}, env, checkCtx);
      await Promise.all(waiters);
      const raw = kvStore.get("apps:v1");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, apps: raw ? JSON.parse(raw) : [] }));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      const resp = await worker.fetch(new Request(url.href, { method: req.method, headers: req.headers, body }), env, ctx);
      res.statusCode = resp.status;
      const cookies = [];
      for (const [k, v] of resp.headers.entries()) {
        if (k.toLowerCase() === "set-cookie") continue;
        res.setHeader(k, v);
      }
      // 本地 http 预览:去掉 Secure 标记,否则浏览器不接受会话 Cookie
      const setCookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
      for (const c of setCookies) cookies.push(c.replace(/;\s*Secure/gi, ""));
      if (cookies.length) res.setHeader("set-cookie", cookies);
      res.end(Buffer.from(await resp.arrayBuffer()));
      return;
    }

    let p = path.join(PUBLIC, decodeURIComponent(url.pathname));
    if (!p.startsWith(PUBLIC)) { res.statusCode = 403; res.end("Forbidden"); return; }
    let s = await stat(p).catch(() => null);
    if (s && s.isDirectory()) {
      p = path.join(p, "index.html");
      s = await stat(p).catch(() => null);
    }
    if (!s) { res.statusCode = 404; res.end("Not Found"); return; }
    res.setHeader("content-type", MIME[path.extname(p).toLowerCase()] || "application/octet-stream");
    res.end(await readFile(p));
  } catch (e) {
    res.statusCode = (e && e.status) || 500;
    res.end(String((e && e.message) || "Internal Error"));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("本地预览: http://127.0.0.1:" + PORT + "  (KV 为内存模拟,GitHub/Chocolatey 返回示例数据)");
  console.log("演示管理员密码: " + ADMIN_PASSWORD + "  (可用环境变量 ADMIN_PASSWORD 覆盖)");
  console.log("手动触发定时检查: curl -X POST http://127.0.0.1:" + PORT + "/__run-check");
});
