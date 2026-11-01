/**
 * 轻量本地预览服务器(无需安装 wrangler):
 *   npm run serve   或   node test/dev-server.mjs
 *   默认地址 http://127.0.0.1:8799(可用环境变量 PORT 修改)
 *
 * - /api/* 由 src/worker.js 处理(KV 为内存模拟,重启后清空)
 * - 其余路径读取 public/ 下的静态文件
 * - 对 api.github.com 的请求返回固定示例数据,便于离线演示刷新流程
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
const env = {
  APP_KV: {
    async get(k) { return kvStore.has(k) ? kvStore.get(k) : null; },
    async put(k, v) { kvStore.set(k, String(v)); },
  },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

/* 拦截 GitHub API,离线演示刷新流程 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input && input.url;
  if (url && url.startsWith("https://api.github.com/") && url.includes("/releases")) {
    return new Response(
      JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/example/repo/releases/tag/v9.9.9",
        published_at: "2026-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
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
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      const resp = await worker.fetch(new Request(url.href, { method: req.method, headers: req.headers, body }), env, ctx);
      res.statusCode = resp.status;
      resp.headers.forEach((v, k) => res.setHeader(k, v));
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
  console.log("本地预览: http://127.0.0.1:" + PORT + "  (KV 为内存模拟,GitHub API 返回示例数据)");
});
