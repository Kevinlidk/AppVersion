/**
 * 应用版本检测 — Cloudflare Worker
 *
 * 提供 REST API 与 GitHub Release 最新版本查询;前端静态页面由
 * Workers Static Assets(wrangler.toml 中 [assets] directory = "./public")
 * 承载,未命中静态文件的请求(即 /api/*)进入本 Worker 处理。
 *
 * 存储:Cloudflare KV,绑定变量名 APP_KV(应用列表序列化为单个 JSON 文档)。
 * 可选:配置 Secret GITHUB_TOKEN 以提升 GitHub API 速率限制。
 */

const LIST_KEY = "apps:v1";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 业务类错误,携带 HTTP 状态码 */
class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError("请求体不是合法 JSON");
  }
}

function nowIso() {
  return new Date().toISOString();
}

/* ─────────────── KV 存取 ─────────────── */

function kv(env) {
  if (!env || !env.APP_KV) {
    throw new ApiError(
      "未绑定 KV 存储:请在 Worker 设置中添加 KV 命名空间绑定,变量名为 APP_KV(步骤见 README)",
      500
    );
  }
  return env.APP_KV;
}

async function readApps(env) {
  const raw = await kv(env).get(LIST_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeApps(env, list) {
  await kv(env).put(LIST_KEY, JSON.stringify(list));
}

/* ─────────────── 字段校验与归一化 ─────────────── */

/**
 * 校验并归一化应用字段。
 * @param {object} input  请求体字段
 * @param {object} [base] 已有记录(编辑时保留未提供的字段与 id 等)
 */
function normalizeApp(input, base = {}) {
  const out = { ...base };

  const name = String(input.name ?? out.name ?? "").trim();
  if (!name) throw new ApiError("应用名称不能为空");

  const channel = input.channel ?? out.channel ?? "manual";
  if (channel !== "github" && channel !== "manual") {
    throw new ApiError("版本来源仅支持 github / manual");
  }

  let repo = String(input.repo ?? out.repo ?? "").trim();
  if (channel === "github") {
    // 允许直接粘贴仓库主页或 .git 链接
    repo = repo
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    if (!REPO_RE.test(repo)) throw new ApiError("GitHub 仓库格式应为 owner/repo");
  } else {
    repo = "";
  }

  out.name = name;
  out.channel = channel;
  out.repo = repo;
  if (input.version !== undefined) out.version = String(input.version).trim();
  if (input.note !== undefined) out.note = String(input.note).trim();
  return out;
}

/* ─────────────── GitHub 最新版本查询 ─────────────── */

async function fetchGitHubLatest(repo, env) {
  const headers = {
    "user-agent": "app-version-worker/1.0",
    accept: "application/vnd.github+json",
  };
  if (env && env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const pick = (r) => ({
    version: String(r.tag_name || "").trim(),
    releaseUrl: r.html_url || null,
    publishedAt: r.published_at || null,
  });

  const base = `https://api.github.com/repos/${repo}`;
  let res = await fetch(`${base}/releases/latest`, { headers });

  if (res.status === 404) {
    // 没有“最新正式版”(latest)时,回退取最近一条 Release
    res = await fetch(`${base}/releases?per_page=1`, { headers });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) return pick(arr[0]);
    }
    throw new ApiError("该仓库暂未发布任何 Release", 404);
  }
  if (res.status === 403 || res.status === 429) {
    throw new ApiError("GitHub API 速率受限,请稍后重试,或在 Worker 中配置 GITHUB_TOKEN", 429);
  }
  if (!res.ok) throw new ApiError(`GitHub API 请求失败(HTTP ${res.status})`, 502);

  const r = await res.json();
  if (!r.tag_name) throw new ApiError("未能解析最新版本号", 502);
  return pick(r);
}

/* ─────────────── 路由 ─────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("静态资源未配置:请检查 wrangler.toml 的 [assets] 配置", { status: 404 });
    }
    try {
      return await handleApi(request, env, url.pathname);
    } catch (e) {
      if (e instanceof ApiError) return fail(e.message, e.status);
      return fail((e && e.message) || "服务器内部错误", 500);
    }
  },
};

async function handleApi(request, env, pathname) {
  const method = request.method;

  if (pathname === "/api/apps") {
    if (method === "GET") return json(await readApps(env));

    if (method === "POST") {
      const body = await readJson(request);
      const app = normalizeApp(body);
      app.id = crypto.randomUUID();
      app.createdAt = nowIso();
      const list = await readApps(env);
      list.unshift(app);
      await writeApps(env, list);
      return json(app, 201);
    }
  }

  let m = pathname.match(/^\/api\/apps\/([A-Za-z0-9-]+)$/);
  if (m) {
    const list = await readApps(env);
    const idx = list.findIndex((a) => a.id === m[1]);
    if (idx === -1) throw new ApiError("应用不存在", 404);
    const prev = list[idx];

    if (method === "PUT") {
      const body = await readJson(request);
      const updated = normalizeApp({ ...prev, ...body }, prev);
      // 渠道或仓库变更后,旧的查询结果不再有效
      const repoChanged = (updated.repo || "") !== (prev.repo || "");
      if (updated.channel !== prev.channel || repoChanged || updated.channel === "manual") {
        delete updated.latestVersion;
        delete updated.releaseUrl;
        delete updated.publishedAt;
        delete updated.lastCheckedAt;
      }
      list[idx] = updated;
      await writeApps(env, list);
      return json(updated);
    }

    if (method === "DELETE") {
      list.splice(idx, 1);
      await writeApps(env, list);
      return json({ ok: true });
    }
  }

  m = pathname.match(/^\/api\/apps\/([A-Za-z0-9-]+)\/refresh$/);
  if (m && method === "POST") {
    const list = await readApps(env);
    const app = list.find((a) => a.id === m[1]);
    if (!app) throw new ApiError("应用不存在", 404);
    if (app.channel !== "github" || !app.repo) {
      throw new ApiError("仅 GitHub 渠道支持自动查询,其余渠道请手动编辑版本号");
    }
    const latest = await fetchGitHubLatest(app.repo, env);
    app.latestVersion = latest.version;
    app.releaseUrl = latest.releaseUrl;
    app.publishedAt = latest.publishedAt;
    app.lastCheckedAt = nowIso();
    await writeApps(env, list);
    return json(app);
  }

  throw new ApiError("接口不存在", 404);
}
