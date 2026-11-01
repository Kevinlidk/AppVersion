/**
 * 应用版本检测 — Cloudflare Worker
 *
 * 功能:
 *  - REST API:应用的增删改查、手动/自动渠道的最新版本查询
 *  - 自动渠道:GitHub Releases、Chocolatey 社区源、winget 官方清单仓库
 *  - 定时检查(Cron Trigger):发现新版本时通过飞书/Telegram/Bark/Server酱/
 *    通用 webhook 推送通知(按环境变量配置,可多选,未配置则仅页面展示)
 *
 * 存储:Cloudflare KV,绑定变量名 APP_KV(应用列表序列化为单个 JSON 文档)。
 * 可选环境变量:
 *  - GITHUB_TOKEN         提升 GitHub API 速率限制(GitHub 渠道与 winget 渠道共用)
 *  - FEISHU_WEBHOOK_URL   飞书群自定义机器人 webhook
 *  - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *  - BARK_URL             Bark 设备地址,如 https://api.day.app/yourkey
 *  - SERVERCHAN_SENDKEY   Server酱 SendKey
 *  - NOTIFY_WEBHOOK_URL   通用 webhook,POST {title, text, apps[]}
 */

const LIST_KEY = "apps:v1";
const UA = "app-version-worker/1.1";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHOCO_ID_RE = /^[A-Za-z0-9_.+-]+$/;
const WINGET_ID_RE = /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 版本号归一化:去掉前导 v/V,便于比较 */
function normVersion(v) {
  return String(v || "").trim().replace(/^v/i, "");
}

/** 比较版本号:数字段按数值比较且高于字符串段(正式版优先于预发布后缀) */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const xs = pa[i], ys = pb[i];
    if (xs === undefined) return -1;
    if (ys === undefined) return 1;
    const x = /^\d+$/.test(xs) ? Number(xs) : xs;
    const y = /^\d+$/.test(ys) ? Number(ys) : ys;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return 1;
    if (typeof y === "number") return -1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
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
  if (channel !== "github" && channel !== "chocolatey" && channel !== "winget" && channel !== "manual") {
    throw new ApiError("版本来源仅支持 github / chocolatey / winget / manual");
  }

  let repo = String(input.repo ?? out.repo ?? "").trim();
  let packageId = String(input.packageId ?? out.packageId ?? "").trim();

  if (channel === "github") {
    // 允许直接粘贴仓库主页或 .git 链接
    repo = repo
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    if (!REPO_RE.test(repo)) throw new ApiError("GitHub 仓库格式应为 owner/repo");
    packageId = "";
  } else if (channel === "chocolatey") {
    // 允许直接粘贴包页面链接
    packageId = packageId
      .replace(/^https?:\/\/community\.chocolatey\.org\/packages\//i, "")
      .replace(/\/+$/, "");
    if (!CHOCO_ID_RE.test(packageId)) throw new ApiError("Chocolatey 包 ID 格式不正确,如 vlc");
    repo = "";
  } else if (channel === "winget") {
    if (!WINGET_ID_RE.test(packageId)) {
      throw new ApiError("winget 包 ID 应为 发布者.包名,如 VideoLAN.VLC");
    }
    repo = "";
  } else {
    repo = "";
    packageId = "";
  }

  out.name = name;
  out.channel = channel;
  out.repo = repo;
  out.packageId = packageId;
  if (input.version !== undefined) out.version = String(input.version).trim();
  if (input.note !== undefined) out.note = String(input.note).trim();
  if (input.notify !== undefined) out.notify = Boolean(input.notify);
  else if (out.notify === undefined) out.notify = true;
  return out;
}

/* ─────────────── 渠道查询 ─────────────── */

async function ghHeaders(env) {
  const headers = { "user-agent": UA, accept: "application/vnd.github+json" };
  if (env && env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchGitHubLatest(repo, env) {
  const headers = await ghHeaders(env);
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

/** Chocolatey 社区源官方 OData API(与 UniGetUI 聚合的同一数据源) */
async function fetchChocolateyLatest(packageId) {
  const filter = `(Id eq '${packageId}') and IsLatestVersion`;
  const res = await fetch(
    `https://community.chocolatey.org/api/v2/Packages()?$filter=${encodeURIComponent(filter)}`,
    { headers: { "user-agent": UA, accept: "application/atom+xml, application/xml" } }
  );
  if (!res.ok) throw new ApiError(`Chocolatey API 请求失败(HTTP ${res.status})`, 502);

  const xml = await res.text();
  const version = (xml.match(/<d:Version[^>]*>([^<]*)<\/d:Version>/) || [])[1];
  if (!version) throw new ApiError("Chocolatey 源中未找到该包,请检查包 ID", 404);
  const published = (xml.match(/<updated[^>]*>([^<]*)<\/updated>/) || [])[1] || null;
  return {
    version: version.trim(),
    releaseUrl: `https://community.chocolatey.org/packages/${encodeURIComponent(packageId)}`,
    publishedAt: published,
  };
}

/**
 * winget 官方清单仓库(microsoft/winget-pkgs,winget.run 的上游数据源)。
 * 目录结构:manifests/<首字母>/<发布者>/<其余各段…>/<版本目录>。
 */
async function fetchWingetLatest(packageId, env) {
  const parts = packageId.split(".");
  const dir = `manifests/${packageId[0].toLowerCase()}/${parts[0]}/${parts.slice(1).join("/")}`;
  const res = await fetch(
    `https://api.github.com/repos/microsoft/winget-pkgs/contents/${dir}`,
    { headers: await ghHeaders(env) }
  );
  if (res.status === 404) throw new ApiError("winget 源中未找到该包,请检查包 ID", 404);
  if (res.status === 403 || res.status === 429) {
    throw new ApiError("GitHub API 速率受限,请稍后重试,或在 Worker 中配置 GITHUB_TOKEN", 429);
  }
  if (!res.ok) throw new ApiError(`winget 源查询失败(HTTP ${res.status})`, 502);

  const entries = await res.json();
  const versions = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.type === "dir")
    .map((e) => e.name);
  if (!versions.length) throw new ApiError("winget 源中未找到该包的版本目录", 404);
  const latest = versions.sort(compareVersions)[versions.length - 1];
  return {
    version: latest,
    releaseUrl: `https://github.com/microsoft/winget-pkgs/tree/master/${dir}`,
    publishedAt: null,
  };
}

/** 按应用渠道分发查询;manual 渠道不支持自动查询 */
async function fetchLatest(app, env) {
  if (app.channel === "github" && app.repo) return fetchGitHubLatest(app.repo, env);
  if (app.channel === "chocolatey" && app.packageId) return fetchChocolateyLatest(app.packageId);
  if (app.channel === "winget" && app.packageId) return fetchWingetLatest(app.packageId, env);
  throw new ApiError("手动维护的应用不支持自动查询,请在编辑中更新版本号");
}

function applyLatest(app, latest) {
  app.latestVersion = latest.version;
  app.releaseUrl = latest.releaseUrl;
  app.publishedAt = latest.publishedAt;
  app.lastCheckedAt = nowIso();
}

/* ─────────────── 通知推送 ─────────────── */

async function requestOk(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function postJson(url, data) {
  return requestOk(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

/**
 * 把更新列表推送到所有已配置的渠道。
 * 返回 true 表示“无需发送(未配置渠道)”或“至少一个渠道发送成功”。
 */
async function sendNotifications(env, found) {
  const title = "📦 应用更新提醒";
  const lines = found.map((f) => {
    const a = f.app;
    return `• ${a.name}:${a.version || "—"} → ${f.version}` + (a.releaseUrl ? `\n　${a.releaseUrl}` : "");
  });
  const text = `${title}\n\n${lines.join("\n")}`;

  const jobs = [];
  if (env.FEISHU_WEBHOOK_URL) {
    jobs.push(postJson(env.FEISHU_WEBHOOK_URL, { msg_type: "text", content: { text } }));
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(postJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
    }));
  }
  if (env.BARK_URL) {
    const base = env.BARK_URL.replace(/\/+$/, "");
    jobs.push(requestOk(`${base}/${encodeURIComponent(title)}/${encodeURIComponent(lines.join("\n"))}`));
  }
  if (env.SERVERCHAN_SENDKEY) {
    jobs.push(requestOk(`https://sctapi.ftqq.com/${env.SERVERCHAN_SENDKEY}.send`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp: lines.join("\n\n") }).toString(),
    }));
  }
  if (env.NOTIFY_WEBHOOK_URL) {
    jobs.push(postJson(env.NOTIFY_WEBHOOK_URL, {
      title,
      text,
      apps: found.map((f) => ({
        id: f.app.id,
        name: f.app.name,
        version: f.app.version,
        latestVersion: f.version,
        releaseUrl: f.app.releaseUrl,
      })),
    }));
  }

  if (!jobs.length) return true;
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === "rejected") console.log("[notify] 发送失败:", (r.reason && r.reason.message) || r.reason);
  }
  return results.some((r) => r.status === "fulfilled");
}

/**
 * 定时检查全部自动渠道应用:
 * 逐个查询最新版本;与当前版本不同且尚未推送过(notifiedVersion)时,
 * 聚合成一条消息推送,成功后记录 notifiedVersion 防止重复推送。
 */
async function runUpdateCheck(env) {
  const list = await readApps(env);
  const targets = list.filter((a) => a.channel !== "manual" && a.notify !== false);
  const gap = env.CHECK_GAP_MS !== undefined ? Number(env.CHECK_GAP_MS) : 500;

  const found = [];
  for (const app of targets) {
    try {
      const latest = await fetchLatest(app, env);
      applyLatest(app, latest);
      if (
        latest.version &&
        latest.version !== app.notifiedVersion &&
        (!app.version || normVersion(latest.version) !== normVersion(app.version))
      ) {
        found.push({ app, version: latest.version });
      }
    } catch (e) {
      console.log(`[check] ${app.name}(${app.channel}): ${(e && e.message) || e}`);
    }
    if (gap > 0) await sleep(gap);
  }

  if (found.length) {
    const ok = await sendNotifications(env, found);
    if (ok) for (const f of found) f.app.notifiedVersion = f.version;
  }
  await writeApps(env, list);
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

  /** Cron Trigger 入口:定时检查更新并推送通知 */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runUpdateCheck(env));
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
      // 渠道或来源变更后,旧的查询结果不再有效
      const sourceChanged =
        updated.channel !== prev.channel ||
        (updated.repo || "") !== (prev.repo || "") ||
        (updated.packageId || "") !== (prev.packageId || "");
      if (sourceChanged || updated.channel === "manual") {
        delete updated.latestVersion;
        delete updated.releaseUrl;
        delete updated.publishedAt;
        delete updated.lastCheckedAt;
        delete updated.notifiedVersion;
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
    const latest = await fetchLatest(app, env);
    applyLatest(app, latest);
    // 手动刷新视为已知悉,定时任务不再重复推送该版本
    app.notifiedVersion = latest.version;
    await writeApps(env, list);
    return json(app);
  }

  throw new ApiError("接口不存在", 404);
}
