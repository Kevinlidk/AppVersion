/* Docker 自托管入口:把 Cloudflare Worker 代码原样跑在 Node 上。
 *
 * 零依赖(Node ≥ 18),只做四件事:
 *   1. FileKV —— 用本地 JSON 文件实现 Worker 的 KV 接口(get/put/delete + expirationTtl),
 *      数据持久化在 DATA_DIR(默认 <项目根>/data,容器内 /opt/appversion/data);
 *   2. ASSETS —— 把 public/ 目录适配成 Worker 期望的 env.ASSETS.fetch(request);
 *   3. HTTP 桥 —— Node 原生 req/res ⇄ 标准 Request/Response,直接调 worker.fetch;
 *   4. 内置定时器 —— 默认每小时调一次 worker.scheduled 做全量检查
 *      (自托管没有 Cloudflare 50 子请求限制,配合 SUBREQUEST_LIMIT + CHECK_BATCH_SIZE
 *       一批即可检查全部应用;worker 内部的 check:lock 防重入依旧生效)。
 *
 * 运行:node docker/server.mjs(环境变量见根目录 docker-compose.yml)
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/worker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const KV_FILE = path.join(DATA_DIR, "kv.json");
const PORT = Number(process.env.PORT) || 80;
const HOST = process.env.HOST || "0.0.0.0";
const CHECK_INTERVAL_MS = Math.max(60000, Number(process.env.CHECK_INTERVAL_MS) || 3600000); // 默认 1 小时
const CHECK_START_DELAY_MS = Math.max(5000, Number(process.env.CHECK_START_DELAY_MS) || 20000);

/* ── 1. 文件版 KV:接口对齐 Cloudflare KV(get/put/delete + expirationTtl)── */

export class FileKV {
  constructor(file) {
    this.file = file;
    this.store = new Map(); // key -> { v: string, exp: number|null(毫秒时间戳) }
    this.loaded = false;
    this._timer = null;
    this._queue = null; // 落盘串行队列
    this._seq = 0;
  }

  async _ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data || {})) this.store.set(k, v);
    } catch {
      /* 首次启动或文件损坏:从空库开始 */
    }
    this.loaded = true;
    // 定期清理过期键并落盘
    this._timer = setInterval(() => this._prune(), 10 * 60 * 1000);
    this._timer.unref?.();
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [k, rec] of this.store) {
      if (rec.exp && rec.exp <= now) {
        this.store.delete(k);
        changed = true;
      }
    }
    if (changed) this._flush();
  }

  /** 串行化落盘:并发写不会竞争同一个临时文件(Windows rename 对此尤其敏感) */
  _flush() {
    this._queue = (this._queue || Promise.resolve())
      .then(() => this._doFlush())
      .catch((e) => console.error("[FileKV] 落盘失败:", e && e.message));
    return this._queue;
  }

  async _doFlush() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${++this._seq}`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.store)), "utf8");
    await fs.rename(tmp, this.file); // 原子替换,避免写一半损坏
  }

  async get(k) {
    await this._ensureLoaded();
    const rec = this.store.get(k);
    if (!rec) return null;
    if (rec.exp && rec.exp <= Date.now()) {
      this.store.delete(k);
      this._flush();
      return null;
    }
    return rec.v;
  }

  async put(k, v, opts = {}) {
    await this._ensureLoaded();
    const ttl = Number(opts && opts.expirationTtl);
    this.store.set(k, {
      v: String(v),
      exp: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null,
    });
    await this._flush();
  }

  async delete(k) {
    await this._ensureLoaded();
    if (this.store.delete(k)) await this._flush();
  }

  /** 立即落盘并停表(测试/优雅关闭用) */
  async close() {
    await this._ensureLoaded();
    if (this._timer) clearInterval(this._timer);
    await this._flush();
  }
}

/* ── 2. 静态资源:适配 Worker 的 env.ASSETS.fetch(request)── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function createAssets(publicDir = PUBLIC_DIR) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.normalize(path.join(publicDir, rel));
      // 防目录穿越:解析后必须仍在 public/ 内
      if (!file.startsWith(publicDir + path.sep) && file !== publicDir) {
        return new Response("Not Found", { status: 404 });
      }
      try {
        const body = await fs.readFile(file);
        return new Response(body, {
          headers: {
            "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
            "cache-control": "no-cache", // 静态资源小,禁缓存保证升级即生效
          },
        });
      } catch {
        // SPA 兜底:未命中文件回退到 index.html
        try {
          const body = await fs.readFile(path.join(publicDir, "index.html"));
          return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      }
    },
  };
}

/* ── 3. 环境装配 ── */

export function buildEnv(kv, assets) {
  return {
    APP_KV: kv,
    ASSETS: assets,
    // 基础配置
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    CRON_SECRET: process.env.CRON_SECRET,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    CHECK_BATCH_SIZE: process.env.CHECK_BATCH_SIZE,
    CHECK_GAP_MS: process.env.CHECK_GAP_MS,
    // 自托管无 Cloudflare 子请求限制,默认放开(仍可被环境变量覆盖)
    SUBREQUEST_LIMIT: process.env.SUBREQUEST_LIMIT || "100000",
    // 通知渠道(全部可选)
    FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    BARK_URL: process.env.BARK_URL,
    SERVERCHAN_SENDKEY: process.env.SERVERCHAN_SENDKEY,
    WECOM_WEBHOOK_KEY: process.env.WECOM_WEBHOOK_KEY,
    NOTIFY_WEBHOOK_URL: process.env.NOTIFY_WEBHOOK_URL,
  };
}

const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((e) => console.error("[server] waitUntil 异常:", e && e.message));
  },
  passThroughOnException() {},
};

/* ── 4. HTTP 服务 ── */

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function handleNodeRequest(req, res, env) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let response;
  try {
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const body = hasBody ? await readBody(req) : undefined;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body && body.length ? body : undefined,
    });
    response = await worker.fetch(request, env, ctx);
  } catch (e) {
    console.error("[server] 请求处理异常:", e && e.stack);
    response = new Response(JSON.stringify({ error: (e && e.message) || "服务器内部错误" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const buf = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, { "content-length": buf.length, ...Object.fromEntries(response.headers) });
  res.end(req.method === "HEAD" ? undefined : buf);
}

/** 启动完整服务(供测试复用):返回 { server, env, kv, stop } */
export async function startServer(opts = {}) {
  const kv = opts.kv || new FileKV(opts.kvFile || KV_FILE);
  const assets = opts.assets || createAssets();
  const env = opts.env || buildEnv(kv, assets);
  const server = http.createServer((req, res) => {
    handleNodeRequest(req, res, env).catch((e) => {
      console.error("[server] 响应写回失败:", e && e.message);
      try { res.destroy(); } catch { /* 已销毁 */ }
    });
  });
  await new Promise((resolve) => server.listen(opts.port || PORT, opts.host || HOST, resolve));
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await kv.close();
  };
  return { server, env, kv, stop };
}

/* ── 直接运行:起服务 + 内置每小时检查 ── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const started = await startServer();
  console.log(`AppVersion 自托管服务已启动: http://${HOST}:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`定时检查: 每 ${Math.round(CHECK_INTERVAL_MS / 60000)} 分钟一次(自托管无平台额度限制)`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("⚠️ 未设置 ADMIN_PASSWORD:编辑类接口不可用,请配置后重启");
  }
  if (!process.env.GITHUB_TOKEN) {
    console.warn("⚠️ 未设置 GITHUB_TOKEN:GitHub/winget 渠道走匿名额度(60 次/小时/IP),建议配置只读令牌(5000 次/小时)");
  }

  // 首轮延迟启动,给 NAS/服务器一点初始化时间;此后固定周期全量检查
  // (worker 内部有 check:lock 防重入,长时间运行也不会并发叠加)
  const runCheck = async (label) => {
    try {
      await worker.scheduled({}, started.env, ctx);
    } catch (e) {
      console.error(`[server] ${label}检查失败:`, e && e.message);
    }
  };
  const firstTimer = setTimeout(() => runCheck("首轮"), CHECK_START_DELAY_MS);
  firstTimer.unref?.();
  const intervalTimer = setInterval(() => runCheck("定时"), CHECK_INTERVAL_MS);
  intervalTimer.unref?.();

  const shutdown = async (signal) => {
    console.log(`\n[server] 收到 ${signal},正在关闭…`);
    clearInterval(intervalTimer);
    clearTimeout(firstTimer);
    await started.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
