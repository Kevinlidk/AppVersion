/**
 * 应用版本检测 — Cloudflare Worker
 *
 * 功能:
 *  - REST API:应用的增删改查、手动/自动渠道的最新版本查询
 *  - 自动渠道:GitHub Releases、Chocolatey 社区源、winget 官方清单仓库
 *  - 定时检查(Cron Trigger):发现新版本时通过飞书/Telegram/Bark/Server酱/
 *    通用 webhook 推送通知(按环境变量配置,可多选,未配置则仅页面展示)
 *  - 管理员鉴权:编辑类接口(增删改/刷新)需要登录;访客只读
 *
 * 存储:Cloudflare KV,绑定变量名 APP_KV(应用列表序列化为单个 JSON 文档)。
 * 必配环境变量:
 *  - ADMIN_PASSWORD       管理员密码(编辑监控应用须登录;未配置时编辑接口一律拒绝)
 * 强建议环境变量(不配则 GitHub / winget 渠道极易触发限流):
 *  - GITHUB_TOKEN         GitHub Personal Access Token(只需 public_repo 读权限即可)
 *                         Worker 出口 IP 是多租户共享的,未认证限额 60 次/小时会被别人耗尽
 * 可选环境变量:
 *  - FEISHU_WEBHOOK_URL   飞书群自定义机器人 webhook
 *  - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *  - BARK_URL             Bark 设备地址,如 https://api.day.app/yourkey
 *  - SERVERCHAN_SENDKEY   Server酱 SendKey
 *  - NOTIFY_WEBHOOK_URL   通用 webhook,POST {title, text, apps[]}
 */

const LIST_KEY = "apps:v1";
const GROUPS_KEY = "groups:v1";
const SETTINGS_KEY = "settings:v1";

/** 读取站点功能开关;未写入过/损坏时回退默认值(全部开启) */
async function readSettings(env) {
  const defaults = { hitokoto: true };
  try {
    const raw = await kv(env).get(SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return defaults;
  }
}
const SEED_KEY = "seeded:v1";
const UA = "app-version-worker/1.2 (+https://github.com/Kevinlidk/AppVersion)";
/* Chocolatey 的 WAF 对裸请求较敏感,补齐常规请求头以降低被 403 的概率 */
const CHOCO_HEADERS = {
  "user-agent": UA,
  accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
const CHOCO_HOST = "https://community.chocolatey.org";
/* 官方自查渠道的请求头:多数厂商 API 要求常规 UA/Accept */
const OFFICIAL_HEADERS = {
  "user-agent": UA,
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
};
const OFFICIAL_MAX_BYTES = 5 * 1024 * 1024; // 官方 API 响应上限 5 MB
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHOCO_ID_RE = /^[A-Za-z0-9_.+-]+$/;
const WINGET_ID_RE = /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/;
const SESSION_COOKIE = "av_session";
const SESSION_TTL = 604800; // 会话有效期:7 天
const LOGIN_MAX_FAILS = 10; // 登录失败锁定阈值
const LOGIN_LOCK_TTL = 900; // 锁定时长:15 分钟
const CHECK_LOCK_KEY = "check:lock"; // 定时检查并发锁

/** 业务类错误,携带 HTTP 状态码 */
class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

/**
 * 读取 JSON 请求体。
 * @param {boolean} allowEmpty 为 true 时,空请求体返回 null 而不是报错
 */
async function readJson(request, allowEmpty = false) {
  try {
    const text = await request.text();
    if (!text.trim()) {
      if (allowEmpty) return null;
      throw new Error("empty");
    }
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof ApiError) throw e;
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
  // 先归一化(去掉 v 前缀),否则 "v2.0.0" 的首段会与 "2" 类型不一致导致误判
  const pa = normVersion(a).split(/[.\-+]/);
  const pb = normVersion(b).split(/[.\-+]/);
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

/* ─────────────── 管理员鉴权 ─────────────── */

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > -1 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return "";
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 恒定时间比较(先哈希再逐字节异或),避免计时侧信道 */
async function safeEqual(a, b) {
  const ha = await sha256Hex(a);
  const hb = await sha256Hex(b);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function isAdminRequest(env, request) {
  if (!env || !env.ADMIN_PASSWORD) return false;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  return Boolean(await kv(env).get("session:" + token));
}

/** 编辑类接口守卫:未配置密码或未登录一律拒绝 */
async function requireAdmin(env, request) {
  if (!env || !env.ADMIN_PASSWORD) {
    throw new ApiError("未配置管理员密码:请设置环境变量/Secret ADMIN_PASSWORD(步骤见 README),当前为只读模式", 500);
  }
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !(await kv(env).get("session:" + token))) {
    throw new ApiError("需要管理员登录", 401);
  }
}

/** /api/check 授权:CRON_SECRET Bearer 令牌(供 GitHub Actions)或管理员会话 */
async function authorizedForCheck(env, request) {
  if (env && env.CRON_SECRET) {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (token && (await safeEqual(token, env.CRON_SECRET))) return true;
  }
  return isAdminRequest(env, request);
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
    if (!Array.isArray(list)) return [];
    // 兼容历史数据:已废弃的 cisco 渠道在读取时收敛为 official + 内置预设
    // (只在内存中迁移,写回发生在下一次保存/检查时)
    for (const it of list) {
      if (it && it.channel === "cisco") {
        it.channel = "official";
        if (!it.officialPreset) it.officialPreset = "cisco-secure-client";
      }
    }
    return list;
  } catch {
    return [];
  }
}

async function writeApps(env, list) {
  await kv(env).put(LIST_KEY, JSON.stringify(list));
}

async function readGroups(env) {
  const raw = await kv(env).get(GROUPS_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((g) => g && typeof g.id === "string") : [];
  } catch {
    return [];
  }
}

async function writeGroups(env, list) {
  await kv(env).put(GROUPS_KEY, JSON.stringify(list));
}

/** 分组名:去空白、限长、非空 */
function normalizeGroupName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) throw new ApiError("分组名称不能为空");
  if (name.length > 40) throw new ApiError("分组名称不能超过 40 个字符");
  return name;
}

/** 下一个排序值(追加到末尾) */
function nextOrder(items) {
  const max = items.reduce((m, it) => Math.max(m, Number(it.order) || 0), -1);
  return max + 1;
}

/**
 * 首次运行时注入示例应用(Google Chrome,Chocolatey 渠道)。
 * 写入标记后不再注入:即使之后删光全部应用,列表也会保持为空。
 * @returns {Array|null} 注入的新列表;未注入时返回 null
 */
async function seedSampleIfFirstRun(env, list) {
  const store = kv(env);
  if (await store.get(SEED_KEY)) return null;
  await store.put(SEED_KEY, "1");
  if (list.length) return null; // 已有数据,不注入
  const app = normalizeApp({
    name: "Google Chrome",
    channel: "chocolatey",
    packageId: "googlechrome",
    version: "",
    note: "示例应用:登录后可编辑或删除",
  });
  app.id = crypto.randomUUID();
  app.createdAt = nowIso();
  await writeApps(env, [app]);
  return [app];
}

/**
 * 校验「官方自查」的 API 地址:只允许公网 https,
 * 避免把 Worker 当成访问内网/元数据服务的跳板(SSRF)。
 */
function validateOfficialUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError("官方 API 地址格式不正确,应为完整 URL,如 https://example.com/api.json");
  }
  if (u.protocol !== "https:") throw new ApiError("官方 API 地址必须使用 https://");
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host === "[::1]" ||
    host === "::1" ||
    /^\[?f[cd][0-9a-f]{2}:/i.test(host);
  if (blocked) throw new ApiError("官方 API 地址不能指向内网或本机地址");
  return u.href;
}

/** 校验自定义图标地址:公网 https 图片地址 */
/**
 * 校验自定义图标地址。
 * 支持 Iconify 简写 `prefix:name`(如 thesvg-color:vlc-media-player),
 * 会自动转换成 https://api.iconify.design/{prefix}/{name}.svg,
 * 方便从 icon-sets.iconify.design / yesicon.app 复制图标名后直接粘贴。
 */
function validateIconUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";

  // Iconify 简写:prefix:name(两侧均为小写字母/数字/短横线)
  const shorthand = value.match(/^([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9.-]*)$/i);
  if (shorthand) {
    const [, prefix, name] = shorthand;
    return `https://api.iconify.design/${encodeURIComponent(prefix.toLowerCase())}/${encodeURIComponent(name.toLowerCase())}.svg`;
  }

  let u;
  try {
    u = new URL(value);
  } catch {
    throw new ApiError(
      "图标地址格式不正确:请填写完整 URL(https://…),或 Iconify 图标名(如 thesvg-color:vlc-media-player)"
    );
  }
  if (u.protocol !== "https:") throw new ApiError("图标地址必须使用 https://");
  return u.href;
}

/** 校验「应用官网地址」:必须是 https 公网链接 */
function validateAppUrl(raw) {
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError("应用官网地址格式不正确,应为完整 URL(以 https:// 开头)");
  }
  if (u.protocol !== "https:") throw new ApiError("应用官网地址必须使用 https://");
  return u.href;
}

/** 归一化候选下载列表:校验 https、限长、去重、按分数降序 */
function normalizeDownloadList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  for (const item of raw.slice(0, 30)) {
    if (!item || typeof item !== "object") continue;
    const url = String(item.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    let u;
    try { u = new URL(url); } catch { continue; }
    if (u.protocol !== "https:") continue;
    seen.add(u.href);
    const score = Number(item.score);
    const entry = {
      name: String(item.name ?? "").slice(0, 200) || decodeURIComponent(u.pathname.split("/").pop() || ""),
      url: u.href,
      score: Number.isFinite(score) ? score : 0,
      kind: String(item.kind ?? "").slice(0, 12),
      arch: String(item.arch ?? "").slice(0, 12),
      // 安装范围(user / machine):winget 清单里同一安装包常按范围区分
      scope: String(item.scope ?? "").slice(0, 16).toLowerCase(),
    };
    // winget 清单附带的校验值(可选):SHA-256 / ProductCode
    const sha = normalizeSha256(item.sha256);
    if (sha) entry.sha256 = sha;
    const pc = normalizeProductCode(item.productCode);
    if (pc) entry.productCode = pc;
    list.push(entry);
  }
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return list;
}

/** 校验「下载地址」:允许 https 链接(可能指向安装包/发布页) */
function validateDownloadUrl(raw) {
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError("下载地址格式不正确,应为完整 URL(以 https:// 开头)");
  }
  if (u.protocol !== "https:") throw new ApiError("下载地址必须使用 https://");
  return u.href;
}

/** 校验版本字段路径:只允许 键名、数字索引、[字段=值] 三种片段 */
function validateJsonPath(raw) {
  const path = String(raw || "").trim();
  if (!path) throw new ApiError("请填写版本字段路径,如 releases.0.version");
  if (/[\u0000-\u001f]/.test(path)) throw new ApiError("版本字段路径不能包含控制字符");
  if (!parsePathSegments(path).length) throw new ApiError("版本字段路径无有效片段");
  return path;
}

/**
 * 解析版本字段路径为片段序列。支持:
 *   releases.0.version                      对象键 / 数组索引
 *   releases-index[channel-version=10.0].latest-release
 *                                           数组过滤:先取该键,再按字段匹配首个元素
 */
function parsePathSegments(path) {
  const segs = [];
  let buf = "";
  let i = 0;
  const flushKey = () => {
    const s = buf.trim();
    buf = "";
    if (!s) return;
    if (/^\d+$/.test(s)) segs.push({ type: "index", index: Number(s) });
    else segs.push({ type: "key", name: s });
  };
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      flushKey();
      i++;
      continue;
    }
    if (ch === "[") {
      const namePart = buf.trim();
      buf = "";
      const end = path.indexOf("]", i);
      if (end === -1) throw new ApiError("版本字段路径语法错误:方括号未闭合");
      const inner = path.slice(i + 1, end);
      const eq = inner.indexOf("=");
      if (eq === -1) throw new ApiError("版本字段路径语法错误:方括号内应写成 字段=值");
      segs.push({
        type: "filter",
        name: namePart || undefined,
        field: inner.slice(0, eq).trim(),
        value: inner.slice(eq + 1).trim(),
      });
      i = end + 1;
      if (path[i] === ".") i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flushKey();
  return segs;
}

/** 按片段序列从 JSON 中取值;任一步缺失返回 undefined */
function pickByJsonPath(root, path) {
  let cur = root;
  for (const seg of parsePathSegments(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (seg.type === "index") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
    } else if (seg.type === "key") {
      cur = cur[seg.name];
    } else {
      if (seg.name !== undefined) cur = cur[seg.name];
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find((it) => it && String(it[seg.field]) === seg.value);
    }
  }
  return cur;
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
  // 服务端同样限长(表单 maxlength=50 仅前端约束)
  if (name.length > 100) throw new ApiError("应用名称不能超过 100 个字符");

  const channel = input.channel ?? out.channel ?? "manual";
  let channelOut = channel; // 可能因遗留渠道迁移而改变
  if (!["github", "chocolatey", "winget", "official", "cisco", "manual"].includes(channel)) {
    throw new ApiError("版本来源仅支持 github / chocolatey / winget / official / cisco / manual");
  }

  let repo = String(input.repo ?? out.repo ?? "").trim();
  let packageId = String(input.packageId ?? out.packageId ?? "").trim();
  let officialUrl = String(input.officialUrl ?? out.officialUrl ?? "").trim();
  let jsonPath = String(input.jsonPath ?? out.jsonPath ?? "").trim();

  if (channelOut !== "official") out.officialPreset = "";
  if (channel === "github") {
    // 允许直接粘贴仓库主页或 .git 链接
    repo = repo
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    if (!REPO_RE.test(repo)) throw new ApiError("GitHub 仓库格式应为 owner/repo");
    packageId = "";
    officialUrl = "";
    jsonPath = "";
  } else if (channel === "chocolatey") {
    // 允许直接粘贴包页面链接
    packageId = packageId
      .replace(/^https?:\/\/community\.chocolatey\.org\/packages\//i, "")
      .replace(/\/+$/, "");
    if (!CHOCO_ID_RE.test(packageId)) throw new ApiError("Chocolatey 包 ID 格式不正确,如 vlc");
    repo = "";
    officialUrl = "";
    jsonPath = "";
  } else if (channel === "winget") {
    if (!WINGET_ID_RE.test(packageId)) {
      throw new ApiError("winget 包 ID 应为 发布者.包名,如 VideoLAN.VLC");
    }
    repo = "";
    officialUrl = "";
    jsonPath = "";
  } else if (channel === "official") {
    // 内置预设:允许只给 officialPreset,由服务端补齐地址与字段路径
    const presetId = String(input.officialPreset ?? out.officialPreset ?? "").trim();
    const preset = presetId ? findOfficialPreset(presetId) : null;
    if (presetId && !preset) throw new ApiError(`未知的内置预设:${presetId}`);
    if (preset) {
      out.officialPreset = preset.id;
      if (preset.mode === "json") {
        officialUrl = validateOfficialUrl(officialUrl || preset.officialUrl);
        jsonPath = validateJsonPath(jsonPath || preset.jsonPath);
      } else {
        // 专用抓取型预设(如 Cisco)不依赖 API 地址
        officialUrl = "";
        jsonPath = "";
      }
    } else {
      out.officialPreset = "";
      officialUrl = validateOfficialUrl(officialUrl);
      jsonPath = validateJsonPath(jsonPath);
    }
    repo = "";
    packageId = "";
  } else if (channel === "cisco") {
    // 遗留渠道(已并入「官方自查」的内置应用):读取时自动迁移,
    // 保证历史数据继续可用,同时新数据统一为 official + officialPreset
    channelOut = "official";
    out.officialPreset = "cisco-secure-client";
    repo = "";
    packageId = "";
    officialUrl = "";
    jsonPath = "";
  } else {
    repo = "";
    packageId = "";
    officialUrl = "";
    jsonPath = "";
  }

  out.name = name;
  out.channel = channelOut;
  out.repo = repo;
  out.packageId = packageId;
  out.officialUrl = officialUrl;
  out.jsonPath = jsonPath;
  // 可选自定义图标:留空则前端按渠道自动推断
  if (input.iconUrl !== undefined) {
    const raw = String(input.iconUrl).trim();
    out.iconUrl = raw ? validateIconUrl(raw) : "";
  } else if (out.iconUrl === undefined) {
    out.iconUrl = "";
  }
  // 应用官网地址 + 是否在首页显示为可点击链接
  if (input.appUrl !== undefined) out.appUrl = validateAppUrl(String(input.appUrl).trim());
  else if (out.appUrl === undefined) out.appUrl = "";
  if (input.linkName !== undefined) out.linkName = Boolean(input.linkName);
  else if (out.linkName === undefined) out.linkName = false;
  // 最新版本下载地址
  if (input.downloadUrl !== undefined) out.downloadUrl = validateDownloadUrl(String(input.downloadUrl).trim());
  else if (out.downloadUrl === undefined) out.downloadUrl = "";
  // 可选的候选下载列表(自动检测/刷新时生成):[{name,url,score,kind,arch}]
  if (input.downloads !== undefined) {
    out.downloads = normalizeDownloadList(input.downloads);
  } else if (out.downloads === undefined) {
    out.downloads = [];
  }
  // 标记「下载地址是用户手动填的」:后续自动查询不会覆盖它。
  // 同时提交了非空 downloads 视为来自自动检测,不算手动。
  if (input.downloadUrl !== undefined) {
    const autoDetected = Array.isArray(input.downloads) && input.downloads.length > 0;
    out.manualDownloadUrl = Boolean(out.downloadUrl) && !autoDetected;
  } else if (out.manualDownloadUrl === undefined) {
    out.manualDownloadUrl = false;
  }
  if (input.version !== undefined) out.version = String(input.version).trim();
  if (input.note !== undefined) out.note = String(input.note).trim();
  // 推送通知默认关闭:需在表单中主动勾选才会纳入定时检查与推送
  if (input.notify !== undefined) out.notify = Boolean(input.notify);
  else if (out.notify === undefined) out.notify = false;
  // 所属分组(null 表示未分组)与组内排序
  if (input.groupId !== undefined) {
    const g = input.groupId;
    out.groupId = g === null || g === "" ? null : String(g);
  } else if (out.groupId === undefined) {
    out.groupId = null;
  }
  if (input.order !== undefined) {
    const n = Number(input.order);
    out.order = Number.isFinite(n) ? n : 0;
  } else if (out.order === undefined) {
    out.order = 0;
  }
  return out;
}

/** 归一化导入的单条记录:校验必填字段,保留查询缓存等已知字段,缺 id 则补齐 */
function normalizeImportedApp(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    throw new ApiError("记录不是对象");
  }
  const base = {};
  for (const k of ["latestVersion", "releaseUrl", "publishedAt", "lastCheckedAt", "notifiedVersion", "createdAt"]) {
    if (rec[k] !== undefined) base[k] = rec[k];
  }
  const app = normalizeApp(rec, base);
  app.id = typeof rec.id === "string" && /^[A-Za-z0-9-]+$/.test(rec.id) ? rec.id : crypto.randomUUID();
  return app;
}

/* ─────────────── Chocolatey → winget 转换 ─────────────── */

/** 从 manifest 文件路径解析包 ID,如 manifests/g/Google/Chrome/…/Google.Chrome.locale.en-US.yaml → Google.Chrome */
function idFromManifestPath(p) {
  if (!p || !p.startsWith("manifests/")) return "";
  let base = (p.split("/").pop() || "").replace(/\.(yaml|yml)$/i, "");
  const locIdx = base.indexOf(".locale.");
  if (locIdx > 0) base = base.slice(0, locIdx);
  base = base.replace(/\.installer$/i, "");
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(base) ? base : "";
}

/** 名称归一化用于相似度比较:小写、去空格与非字母数字 */
function nameKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 在 microsoft/winget-pkgs 中按名称搜索候选包 ID。
 * 用 GitHub 代码搜索(需 GITHUB_TOKEN,认证后 10 次/分钟)。
 */
async function searchWingetByText(text, env) {
  if (!text) return [];
  const headers = await ghHeaders(env);
  const q = `repo:microsoft/winget-pkgs path:manifests "${text.replace(/"/g, "")}"`;
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=30`;
  const res = await fetchWithRetry(url, { headers });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text();
    // 代码搜索需要 token 且令牌需有 Contents 读取权限
    if (/rate limit/i.test(body)) throw new ApiError("GitHub 代码搜索已被限流,请稍后再试", 429);
    throw new ApiError("GitHub 代码搜索不可用:请确认 GITHUB_TOKEN 具备只读 Contents 权限", 403);
  }
  if (!res.ok) throw new ApiError(`GitHub 代码搜索失败(HTTP ${res.status})`, 502);
  const data = await res.json();
  const ids = new Set();
  for (const item of Array.isArray(data.items) ? data.items : []) {
    const id = idFromManifestPath(item.path);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * 由应用信息推导可能的 winget 包 ID(启发式),并用清单目录存在性校验。
 * 来源:appUrl 域名取发布者 + 应用名取包名,如 videolan.org + VLC → VideoLAN.VLC
 */
function wingetIdGuesses(app) {
  const guesses = [];
  const nameCandidates = [];
  if (app.name) nameCandidates.push(app.name.replace(/\s+/g, ""));
  if (app.packageId) nameCandidates.push(app.packageId.replace(/\s+/g, ""));
  const publishers = [];
  if (app.appUrl) {
    try {
      const host = new URL(app.appUrl).hostname.replace(/^www\./i, "");
      const label = host.split(".")[0] || "";
      if (label) {
        publishers.push(label);
        // videolan → VideoLAN 这类大小写还原由目录校验兜住,这里同时给出原样
      }
    } catch { /* appUrl 非法则忽略 */ }
  }
  if (app.packageId) publishers.push(app.packageId);
  for (const pub of publishers) {
    for (const nm of nameCandidates) {
      if (pub && nm) guesses.push(`${pub}.${nm}`);
    }
  }
  return [...new Set(guesses)];
}

/** 校验 winget 包 ID 是否存在(顺带返回最新版本) */
async function verifyWingetId(packageId, env) {
  try {
    const latest = await fetchWingetLatest(packageId, env);
    return { id: packageId, version: latest.version, ok: true };
  } catch {
    return { id: packageId, version: null, ok: false };
  }
}

/**
 * 为一个 Chocolatey 应用搜索 winget 候选。
 * 顺序:代码搜索(应用名 / 包 ID)→ 启发式 ID 校验;结果按相似度排序。
 */
async function findWingetCandidates(app, env) {
  const found = new Map(); // id → {id, version, source}
  const errors = [];

  const queries = [...new Set([app.name, app.packageId].filter(Boolean))];
  for (const q of queries) {
    try {
      const ids = await searchWingetByText(q, env);
      for (const id of ids.slice(0, 20)) {
        if (!found.has(id)) found.set(id, { id, version: null, source: "search" });
      }
    } catch (e) {
      errors.push((e && e.message) || "搜索失败");
    }
  }

  // 启发式猜测:直接校验目录是否存在(比搜索便宜,且能命中代码搜索漏掉的)
  for (const guess of wingetIdGuesses(app).slice(0, 6)) {
    if (!found.has(guess)) {
      const v = await verifyWingetId(guess, env);
      if (v.ok) found.set(guess, { id: guess, version: v.version, source: "guess", verified: true });
    }
  }

  // 排序:已验证存在 > 名称相似度 > 包名与 Chocolatey ID 一致
  // (未验证的候选排在后面,避免误选不存在的猜测 ID)
  const targetKey = nameKey(app.name);
  const pkgKey = nameKey(app.packageId);
  const list = [...found.values()].map((c) => {
    const idParts = c.id.split(".");
    const pkgPart = idParts[idParts.length - 1] || "";
    const k = nameKey(pkgPart);
    let score = 0;
    if (c.verified) score += 1000; // 已确认存在于 winget 清单,优先级最高
    if (k && k === targetKey) score += 100;
    else if (k && targetKey && (k.includes(targetKey) || targetKey.includes(k))) score += 60;
    if (pkgKey && k === pkgKey) score += 40;
    if (c.version) score += 10;
    return { ...c, score };
  });
  list.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // 逐个补版本(只补前 6 个,避免过多请求)
  for (const c of list.slice(0, 6)) {
    if (!c.version) {
      const v = await verifyWingetId(c.id, env);
      c.version = v.version;
      c.verified = v.ok;
      if (v.ok) c.score += 1000;
    }
  }
  list.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // 优先只返回已验证存在的候选;若一个都没有,才把未验证的作为参考列出
  const verifiedOnly = list.filter((c) => c.version);
  const result = verifiedOnly.length ? verifiedOnly : list;

  return { candidates: result.slice(0, 12), errors };
}

/* ─────────────── 渠道查询 ─────────────── */

async function ghHeaders(env) {
  const headers = { "user-agent": UA, accept: "application/vnd.github+json" };
  if (env && env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

/** 把 GitHub 的限流响应翻译成可操作的提示(含重置时间与剩余额度) */
function githubThrottleError(res, env) {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
  let when = "";
  if (reset) {
    const mins = Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000));
    when = `约 ${mins} 分钟后(北京时间 ${new Date(reset * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}）重置`;
  }
  if (env && env.GITHUB_TOKEN) {
    return new ApiError(
      `GitHub API 速率受限${when ? "," + when : ""}。已配置 GITHUB_TOKEN,可能是该 Token 额度被其他程序共用`,
      429
    );
  }
  return new ApiError(
    "GitHub API 速率受限(匿名额度 60 次/小时,Worker 出口 IP 为多租户共享,极易被耗尽)" +
      (when ? "," + when : "") +
      "。请务必在 Worker 中配置 GITHUB_TOKEN(设置 → 变量和机密),配置后为 5000 次/小时",
    429
  );
}

async function fetchGitHubLatest(repo, env) {
  const headers = await ghHeaders(env);
  const pick = (r) => ({
    // 去掉 GitHub tag 常见的 v 前缀(v1.2.3 → 1.2.3),与手动填写的纯版本号保持一致
    version: String(r.tag_name || "").trim().replace(/^[vV](?=[\d.])/, ""),
    releaseUrl: r.html_url || null,
    publishedAt: r.published_at || null,
    // 附带按分数排序的安装包候选,刷新时同步更新下载菜单
    downloads: rankDownloadAssets(r.assets),
  });

  const base = `https://api.github.com/repos/${repo}`;
  let res = await fetchWithRetry(`${base}/releases/latest`, { headers });

  if (res.status === 404) {
    // 没有“最新正式版”(latest)时,回退取最近一条 Release
    res = await fetchWithRetry(`${base}/releases?per_page=1`, { headers });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length) return pick(arr[0]);
    }
    throw new ApiError("该仓库暂未发布任何 Release", 404);
  }
  if (res.status === 403 || res.status === 429) throw githubThrottleError(res, env);
  if (!res.ok) throw new ApiError(`GitHub API 请求失败(HTTP ${res.status})`, 502);

  const r = await res.json();
  if (!r.tag_name) throw new ApiError("未能解析最新版本号", 502);
  return pick(r);
}

/**
 * 网络级重试:仅对连接异常与 5xx 重试。
 * 429/403 明确不重试 —— 重试只会加重限流甚至触发更长的封禁。
 */
/* ── 子请求预算 ──────────────────────────────────────────────
   Cloudflare Workers 免费版限制单次调用最多 50 个 fetch 子请求。
   一次 /api/check 要查 20+ 个应用,必须省着用:核心请求(清单列表、
   installer.yaml)优先,可选增强(发布日期等)只在预算充裕时发出。
   计数器在每次检查/单应用刷新开始时清零。 */
const SUBREQUEST_SOFT_LIMIT = 42;
let subrequestsUsed = 0;
function subrequestTick() {
  subrequestsUsed += 1;
  return subrequestsUsed;
}
function subrequestBudgetOk(need = 1) {
  return subrequestsUsed + need <= SUBREQUEST_SOFT_LIMIT;
}

async function fetchWithRetry(url, opts, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    subrequestTick();
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && i < attempts - 1) {
        await sleep(300 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 平台子请求配额用尽:重试无意义,直接给出明确错误
      if (msg.includes("Too many subrequests")) {
        throw new ApiError("本次检查触达平台子请求上限(Cloudflare 单次调用 50 个),其余应用将在下个周期自动重试", 502);
      }
      lastErr = e;
      if (i < attempts - 1) await sleep(300 * (i + 1));
    }
  }
  throw new ApiError(`网络请求失败:${(lastErr && lastErr.message) || "连接异常"},请稍后重试`, 502);
}

const CHOCO_BLOCKED_MSG =
  "Chocolatey 拒绝访问(HTTP 403):Cloudflare Workers 的出口 IP 被其 WAF 拦截(Chocolatey 本身也托管在 Cloudflare 上)。" +
  "同一域名/同一 Worker 无法绕过;建议改用 winget 渠道,或在诊断面板查看 Worker 侧实测结果";

/** Chocolatey 候选端点(按请求体积从小到大) */
function chocoEndpointList(packageId) {
  const id = encodeURIComponent(packageId);
  const filter = `(Id eq '${packageId.replace(/'/g, "''")}') and IsLatestVersion`;
  return [
    {
      name: "package-redirect",
      label: "302 重定向读取版本(最轻量)",
      url: `${CHOCO_HOST}/api/v2/package/${id}`,
      opts: { headers: CHOCO_HEADERS, redirect: "manual" },
      parse: "redirect",
    },
    {
      name: "odata-latest",
      label: "OData 查询最新版",
      url: `${CHOCO_HOST}/api/v2/Packages()?$filter=${encodeURIComponent(filter)}`,
      opts: { headers: CHOCO_HEADERS },
      parse: "odata",
    },
    {
      name: "find-by-id",
      label: "FindPackagesById 查询全部版本",
      url: `${CHOCO_HOST}/api/v2/FindPackagesById()?id='${encodeURIComponent(packageId)}'`,
      opts: { headers: CHOCO_HEADERS },
      parse: "odata-all",
    },
  ];
}

/** 从 Atom XML 取第一个版本号 */
function firstVersionFromAtom(xml) {
  return (xml.match(/<d:Version[^>]*>([^<]*)<\/d:Version>/) || [])[1] || "";
}

/**
 * Chocolatey 最新版本:按候选端点依次尝试,任一成功即返回。
 * 部分网络环境下某些端点会被 WAF 拦,逐个降级可提高成功率。
 */
async function fetchChocolateyLatest(packageId) {
  const attempts = [];
  for (const ep of chocoEndpointList(packageId)) {
    let res;
    try {
      res = await fetchWithRetry(ep.url, ep.opts);
    } catch (e) {
      attempts.push(`${ep.name}:${(e && e.message) || "请求失败"}`);
      continue;
    }

    if (res.status === 404) {
      attempts.push(`${ep.name}:404`);
      continue;
    }
    if (res.status === 403) {
      attempts.push(`${ep.name}:403`);
      continue;
    }
    if (res.status === 429) {
      attempts.push(`${ep.name}:429`);
      continue;
    }

    // 302 端点:从 Location 的文件名取版本
    if (ep.parse === "redirect" && res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      const file = decodeURIComponent((loc.split("/").pop() || "").split("?")[0]);
      const idLower = packageId.toLowerCase();
      if (file.toLowerCase().startsWith(idLower + ".") && /\.nupkg$/i.test(file)) {
        const version = file.slice(packageId.length + 1, -".nupkg".length);
        if (version) {
          return {
            version,
            releaseUrl: `${CHOCO_HOST}/packages/${encodeURIComponent(packageId)}`,
            publishedAt: null,
          };
        }
      }
      attempts.push(`${ep.name}:无法解析 Location`);
      continue;
    }

    if (!res.ok) {
      attempts.push(`${ep.name}:${res.status}`);
      continue;
    }

    const xml = await res.text();
    if (ep.parse === "odata") {
      const v = firstVersionFromAtom(xml);
      if (v) {
        const published = (xml.match(/<updated[^>]*>([^<]*)<\/updated>/) || [])[1] || null;
        return {
          version: v.trim(),
          releaseUrl: `${CHOCO_HOST}/packages/${encodeURIComponent(packageId)}`,
          publishedAt: published,
        };
      }
      attempts.push(`${ep.name}:未找到版本`);
      continue;
    }

    // odata-all:返回所有版本,取最大
    const versions = [...xml.matchAll(/<d:Version[^>]*>([^<]*)<\/d:Version>/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    if (versions.length) {
      versions.sort(compareVersions);
      const published = (xml.match(/<updated[^>]*>([^<]*)<\/updated>/) || [])[1] || null;
      return {
        version: versions[versions.length - 1],
        releaseUrl: `${CHOCO_HOST}/packages/${encodeURIComponent(packageId)}`,
        publishedAt: published,
      };
    }
    attempts.push(`${ep.name}:未找到版本`);
  }

  if (attempts.every((a) => a.includes(":403"))) throw new ApiError(CHOCO_BLOCKED_MSG, 403);
  if (attempts.some((a) => a.endsWith(":404"))) {
    throw new ApiError("Chocolatey 源中未找到该包,请检查包 ID", 404);
  }
  throw new ApiError(
    `Chocolatey 查询失败(所有端点均不可用):${attempts.join(";")}`,
    502
  );
}

/**
 * winget 官方清单仓库(microsoft/winget-pkgs,winget.run 的上游数据源)。
 * 目录结构:manifests/<首字母>/<发布者>/<其余各段…>/<版本目录>。
 */
/**
 * 极简 YAML 解析:只处理 winget manifest 用到的结构
 * (顶层键值、`InstallerType: x` 默认值、`Installers:` 列表)。
 * 不引入依赖,仅提取 Architecture / InstallerUrl / InstallerType / Scope。
 */
/** SHA-256 规范化:64 位十六进制(转小写);不合法返回空串 */
function normalizeSha256(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

/**
 * ProductCode 规范化:仅接受 GUID 形态
 *   {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}(花括号可省略,大小写不限)
 * 否则返回空串。清单里还存在 "WeChat"/"TIM" 这类**卸载注册表键名**,
 * 它们不是 GUID,对用户毫无意义 —— 此时应改显 SHA-256。
 */
function normalizeProductCode(v) {
  const s = String(v ?? "").trim();
  return /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(s) ? s : "";
}

function parseWingetInstallerYaml(text) {
  const lines = String(text || "").split(/\r?\n/);
  const top = {};          // 顶层标量(作为子项默认值)
  const installers = [];
  let inInstallers = false;
  let current = null;

  const unquote = (v) => v.trim().replace(/^["']|["']$/g, "").trim();

  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^(\s*)/)[1].length;
    const line = raw.trim();

    // 进入 Installers 段
    if (/^Installers:\s*$/.test(line)) {
      inInstallers = true;
      current = null;
      continue;
    }

    if (!inInstallers) {
      // 键名可含数字(如 InstallerSha256)
      const m = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
      if (m && indent === 0) top[m[1]] = unquote(m[2]);
      continue;
    }

    // 列表项:可能有 0~2 空格缩进,以 "- " 开头
    const itemMatch = line.match(/^-\s+([A-Za-z]+):\s*(.*)$/);
    if (itemMatch) {
      current = { [itemMatch[1]]: unquote(itemMatch[2]) };
      installers.push(current);
      continue;
    }
    if (current) {
      const kv = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
      if (kv) current[kv[1]] = unquote(kv[2]);
    }
  }

  return installers
    .filter((it) => it.InstallerUrl)
    .map((it) => ({
      arch: (it.Architecture || top.Architecture || "").toLowerCase(),
      url: it.InstallerUrl,
      type: (it.InstallerType || it.NestedInstallerType || top.InstallerType || "").toLowerCase(),
      scope: (it.Scope || top.Scope || "").toLowerCase(),
      sha256: normalizeSha256(it.InstallerSha256 ?? top.InstallerSha256),
      productCode: normalizeProductCode(it.ProductCode ?? top.ProductCode),
    }));
}

/**
 * winget 安装包类型 → 展示用 kind。
 * 优先用 URL 扩展名(最可靠,同一个包可能混用 exe/msi),
 * 扩展名无法判断时才回退到 manifest 的 InstallerType。
 */
function wingetTypeToKind(type, url) {
  const ext = (String(url || "").match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1];
  const e = (ext || "").toLowerCase();
  if (e === "exe") return "EXE";
  if (e === "msi") return "MSI";
  if (e === "msix" || e === "appx") return "MSIX";
  if (e === "zip") return "ZIP";
  if (e === "dmg") return "DMG";
  if (e === "pkg") return "PKG";
  if (e === "msixbundle") return "MSIX";

  const t = (type || "").toLowerCase();
  if (t === "nullsoft" || t === "inno" || t === "burn" || t === "exe") return "EXE";
  if (t === "wix" || t === "msi") return "MSI";
  if (t === "msix" || t === "appx") return "MSIX";
  if (t === "portable" || t === "zip") return "ZIP";
  return e ? e.toUpperCase() : "文件";
}

/**
 * 取某个 winget 包在指定版本下的安装包列表(读 installer.yaml)。
 * 路径:manifests/<首字母>/<发布者>/<其余段…>/<版本>/<PackageId>.installer.yaml
 */
async function fetchWingetInstallers(packageId, versionPath, env) {
  if (!packageId || !versionPath) return [];
  const parts = packageId.split(".");
  const dir = `manifests/${packageId[0].toLowerCase()}/${parts[0]}/${parts.slice(1).join("/")}`;
  // versionPath 可能含子目录(如 2020/20.001.30002),不能只当版本名用
  const file = `${dir}/${versionPath}/${packageId}.installer.yaml`;
  const url = `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/${file}`;
  let res;
  try {
    res = await fetchWithRetry(url, { headers: { "user-agent": UA } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const yaml = await res.text();
  const items = parseWingetInstallerYaml(yaml);

  // 排序:x64 优先 → arm64 → x86 → 其它;同架构内 exe 优先于 msi
  const archScore = (a) => (a === "x64" ? 30 : a === "arm64" || a === "arm" ? 20 : a === "x86" ? 10 : 0);
  const kindScore = (k) => (k === "EXE" ? 8 : k === "MSI" ? 7 : k === "MSIX" ? 5 : k === "ZIP" ? 2 : 0);
  return items
    .map((it) => {
      const kind = wingetTypeToKind(it.type, it.url);
      const name = decodeURIComponent((it.url.split("/").pop() || "").split("?")[0]);
      return {
        name,
        url: it.url,
        score: archScore(it.arch) + kindScore(kind),
        kind,
        arch: it.arch === "arm64" ? "arm" : it.arch,
        scope: it.scope || "",
        sha256: it.sha256 || "",
        productCode: it.productCode || "",
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/* ── winget 版本目录发现 ──────────────────────────────────────
   清单仓库里并非所有一级目录都是版本号:有些包按年份分组,
   例如 Adobe.Acrobat.Pro 下是 2020/20.001.30002 这样的嵌套结构。
   旧实现直接拿一级目录名排序,会把「2020」当成版本号,因为
   2020 > 26 而误判成最新(实际最新是 26.002.22031)。
   现在:① 严格版本形态(含小数点)直接采用;② 其余目录尝试下钻一层,
   子目录才是版本;③ 下钻后仍无版本则保留自身(单版本包的兜底)。 */
const WINGET_VERSION_RE = /^\d+(?:\.\d+)+$/;

async function ghContents(path, env) {
  const res = await fetchWithRetry(
    `https://api.github.com/repos/microsoft/winget-pkgs/contents/${path}`,
    { headers: await ghHeaders(env) }
  );
  if (res.status === 403 || res.status === 429) throw githubThrottleError(res, env);
  if (!res.ok) return null;
  const body = await res.json();
  return Array.isArray(body) ? body : null;
}

/**
 * 列出包目录下的全部版本,返回 [{version, path}]。
 *
 * 只把「版本形态」的目录名当版本。子目录可能有两种完全不同的含义:
 *   1. 分组目录 —— 例如 Adobe/Acrobat/Pro/2020/20.001.30002,
 *      真实版本在下一层,「2020」本身不是版本;
 *   2. 子包目录 —— 例如 TeamViewer/TeamViewer/Host/15.83.5,
 *      这里的 Host 是另一个包(TeamViewer.TeamViewer.Host)的路径段,
 *      其下的 manifest 文件名与我们查询的包 ID 并不匹配。
 * 旧实现把两者都当成候选版本下钻,导致 TeamViewer 选中了
 * 「Host/15.83.5」,再按本包 ID 去找 installer.yaml 自然 404,
 * 下载候选就全空了。因此:优先只取版本形态目录;
 * 仅当一个都没有时(整包都按分组存放)才下钻,避免兼容性倒退。
 */
async function listWingetVersions(pkgDir, env) {
  const entries = await ghContents(pkgDir, env);
  if (!entries) throw new ApiError("winget 源中未找到该包,请检查包 ID", 404);

  const dirs = entries.filter((e) => e && e.type === "dir").map((e) => e.name);
  if (!dirs.length) throw new ApiError("winget 源中未找到该包的版本目录", 404);

  const strict = dirs.filter((n) => WINGET_VERSION_RE.test(n));
  if (strict.length) return strict.map((n) => ({ version: n, path: n }));

  // 没有直接版本目录:下钻一层(限 5 个,避免异常仓库产生大量请求)
  const out = [];
  for (const name of dirs.slice(0, 5)) {
    const children = await ghContents(`${pkgDir}/${name}`, env);
    const childDirs = (children || [])
      .filter((e) => e && e.type === "dir")
      .map((e) => e.name);
    const matched = childDirs.filter((c) => WINGET_VERSION_RE.test(c));
    if (matched.length) {
      for (const c of matched) out.push({ version: c, path: `${name}/${c}` });
    } else {
      out.push({ version: name, path: name });
    }
  }
  if (!out.length) throw new ApiError("winget 源中未找到该包的版本目录", 404);
  return out;
}

/** 取某个版本目录最后一次提交时间(winget-pkgs 每次发版都会提交) */
async function wingetVersionCommitDate(pkgDir, versionPath, env) {
  try {
    const res = await fetchWithRetry(
      `https://api.github.com/repos/microsoft/winget-pkgs/commits?path=${encodeURIComponent(
        `${pkgDir}/${versionPath}`
      )}&per_page=1`,
      { headers: await ghHeaders(env) }
    );
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const c = arr[0];
    return (c && c.commit && (c.commit.committer || c.commit.author) || {}).date || null;
  } catch {
    return null;
  }
}

/**
 * 选出版本目录中的最新一条,返回 {version, path, publishedAt}。
 *
 * 主判定是**版本号比较** —— 配合上面的分组展开与子包排除,它已经能
 * 正确处理 Adobe(2020 分组)和 TeamViewer(Host/QuickSupport 子包)。
 * last commit date 降级为两种受限用法(每个请求都要计入子请求预算):
 *   1. 单应用手动刷新时,给胜出版本取一次提交时间作为 publishedAt;
 *   2. 版本目录走了「下钻兜底」、命名不可信时,取前 2 名的提交时间
 *      重新排序(谁提交得新谁算最新)。
 * 定时批量检查默认关闭日期抓取 —— 20+ 应用 × N 个日期请求会击穿
 * Cloudflare 单次调用 50 个子请求的平台上限。
 */
async function pickWingetLatest(pkgDir, versions, env, { dateMode = "off" } = {}) {
  const byVersion = [...versions].sort((a, b) => compareVersions(a.version, b.version));
  const winner = byVersion[byVersion.length - 1];
  const allStrict = versions.every((v) => WINGET_VERSION_RE.test(v.version));

  // 兜底路径:命名不可信时,用前 2 名的提交时间重排(预算内才发)
  if (!allStrict && subrequestBudgetOk(2)) {
    const top2 = byVersion.slice(-2);
    const dated = [];
    for (const v of top2) {
      const date = await wingetVersionCommitDate(pkgDir, v.path, env);
      if (date) dated.push({ ...v, publishedAt: date });
    }
    if (dated.length) {
      dated.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      return dated[0];
    }
  }

  // 常规路径:版本号最大者胜;允许时补一条提交时间作为发布日期
  if (dateMode === "always" && subrequestBudgetOk(1)) {
    const publishedAt = await wingetVersionCommitDate(pkgDir, winner.path, env);
    return { ...winner, publishedAt: publishedAt || null };
  }
  return { ...winner, publishedAt: null };
}

async function fetchWingetLatest(packageId, env, opts = {}) {
  const parts = packageId.split(".");
  const dir = `manifests/${packageId[0].toLowerCase()}/${parts[0]}/${parts.slice(1).join("/")}`;

  const versions = await listWingetVersions(dir, env);
  const latest = await pickWingetLatest(dir, versions, env, { dateMode: opts.dateMode || "off" });

  // 读取该版本的 installer.yaml,取出各架构下载地址作为下载候选。
  // 若该路径下没有本包的 installer.yaml(目录结构与预期不符),依次回退到
  // 版本号次高的候选,避免「版本查到了但下载候选为空」。
  let downloads = await fetchWingetInstallers(packageId, latest.path, env);
  if (!downloads.length) {
    const fallbacks = [...versions]
      .filter((v) => v.path !== latest.path)
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, 2);
    for (const v of fallbacks) {
      downloads = await fetchWingetInstallers(packageId, v.path, env);
      if (downloads.length) break;
    }
  }

  return {
    version: latest.version,
    // 指向该包的版本目录页(所有版本详情)
    releaseUrl: `https://github.com/microsoft/winget-pkgs/tree/master/${dir}`,
    publishedAt: latest.publishedAt || null,
    downloads,
  };
}

/* ── Cisco Secure Client 专属渠道 ────────────────────────────
   官方没有版本 JSON API,只能从 Release Notes 页面里提取。
   版本号固定出现在「Cisco Secure Client <a.b.c.d>」这样的文本中
   (小节标题/正文都适用);同一页面还会出现模块版本(如
   「Zero Trust Access—5.1.20.7023」),因此必须依赖完整前缀,
   不能做通用版本号匹配。取所有命中里的最大值即为最新客户端版本。 */
const CISCO_RELEASE_NOTES_URL =
  "https://www.cisco.com/c/en/us/td/docs/security/vpn_client/anyconnect/Cisco-Secure-Client-5/release/notes/release-notes-cisco-secure-client-5-1.html";
const CISCO_MAX_BYTES = 8 * 1024 * 1024;

/* ── 「官方自查」内置预设 ──────────────────────────────────────
   每个预设描述一个应用官方版本源的抓取方式,前端在选中
   「官方自查」时列出、一键填入,用户不必手写 API 地址与字段路径。
   新增一个内置应用 = 在下面加一条配置即可(前端从 /api/official-presets 读取)。

   字段:
     id        唯一标识,存进应用的 officialPreset
     name/appUrl/iconUrl  展示与自动填充用
     mode      "json" → 走通用 JSON 字段路径;  "cisco-notes" → 专用抓取
     officialUrl/jsonPath  mode=json 时的 API 地址与取值路径
     releaseUrl 来源链接(留空则用 officialUrl)
     note      预设说明,前端展示 */
const OFFICIAL_PRESETS = [
  {
    id: "chrome-win64-stable",
    name: "Google Chrome (win64 stable)",
    appUrl: "https://www.google.com/chrome/",
    iconUrl: "https://api.iconify.design/logos/chrome.svg",
    mode: "json",
    officialUrl:
      "https://gcvh.kevinlidk.cn/v1/chrome/platforms/win64/channels/stable/versions/all/releases?filter=fraction=1&pageSize=1",
    jsonPath: "releases.0.version",
    releaseUrl: "https://chromereleases.googleblog.com/",
    note: { zh: "取 win64 stable 渠道最新正式版", en: "Latest stable build for win64" },
  },
  {
    id: "dotnet-10",
    name: "Microsoft .NET 10.0",
    appUrl: "https://dotnet.microsoft.com/download/dotnet/10.0",
    iconUrl: "https://api.iconify.design/logos/dotnet.svg",
    mode: "json",
    officialUrl: "https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json",
    jsonPath: "releases-index[channel-version=10.0].latest-release",
    releaseUrl: "https://dotnet.microsoft.com/download/dotnet/10.0",
    note: { zh: "取 .NET 10.0 通道的最新补丁版本", en: "Latest patch of the .NET 10.0 channel" },
  },
  {
    id: "cisco-secure-client",
    name: "Cisco Secure Client",
    appUrl: "https://www.cisco.com/c/en/us/support/security/secure-client/model.html",
    iconUrl: "https://api.iconify.design/logos/cisco.svg",
    mode: "cisco-notes",
    releaseUrl: CISCO_RELEASE_NOTES_URL,
    note: {
      zh: "解析官方 Release Notes,取最高客户端版本(自动排除模块版本)",
      en: "Parses the official release notes and takes the highest client build",
    },
  },
];

/** 供前端使用的预设列表(去掉内部实现细节) */
function publicOfficialPresets() {
  return OFFICIAL_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    appUrl: p.appUrl || "",
    iconUrl: p.iconUrl || "",
    mode: p.mode,
    officialUrl: p.officialUrl || "",
    jsonPath: p.jsonPath || "",
    releaseUrl: p.releaseUrl || p.officialUrl || "",
    note: p.note || { zh: "", en: "" },
  }));
}

function findOfficialPreset(id) {
  return OFFICIAL_PRESETS.find((p) => p.id === id) || null;
}
const CISCO_HEADERS = {
  // 官方文档站对非浏览器 UA 较敏感,带上常见 Accept 头更稳
  "user-agent": "Mozilla/5.0 (compatible; app-version-worker/1.2; +https://github.com/Kevinlidk/AppVersion)",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
};

async function fetchCiscoLatest() {
  let res;
  try {
    res = await fetchWithRetry(CISCO_RELEASE_NOTES_URL, { headers: CISCO_HEADERS });
  } catch (e) {
    throw new ApiError(`Cisco Release Notes 请求失败:${(e && e.message) || e}`, 502);
  }
  if (res.status === 403) {
    throw new ApiError("Cisco 文档站拒绝访问(HTTP 403),可能对云端 IP 限流,请稍后重试", 403);
  }
  if (!res.ok) throw new ApiError(`Cisco Release Notes 请求失败(HTTP ${res.status})`, 502);

  const len = Number(res.headers.get("content-length") || 0);
  if (len > CISCO_MAX_BYTES) throw new ApiError("Cisco Release Notes 响应过大,超出解析上限", 502);
  const html = await res.text();
  if (html.length > CISCO_MAX_BYTES) throw new ApiError("Cisco Release Notes 响应过大,超出解析上限", 502);

  const versions = [...new Set(
    [...html.matchAll(/Cisco Secure Client\s+(\d+\.\d+\.\d+\.\d+)/g)].map((m) => m[1])
  )];
  if (!versions.length) {
    throw new ApiError("未能从 Cisco Release Notes 中解析出版本号,页面结构可能已变化", 502);
  }
  versions.sort(compareVersions);
  return {
    version: versions[versions.length - 1],
    // 来源链接固定指向 Release Notes(所有版本详情)
    releaseUrl: CISCO_RELEASE_NOTES_URL,
    publishedAt: null,
  };
}

/**
 * 官方自查:直接请求厂商公开的版本 API/JSON,按字段路径取值。
 * 适用于 Chrome(Google 版本发布 API)、.NET(release-metadata)等
 * 提供结构化版本数据、但没有标准 Release 接口的应用。
 */
async function fetchOfficialLatest(app) {
  const url = app.officialUrl;
  if (!url || !app.jsonPath) throw new ApiError("官方自查配置不完整,请编辑应用填写 API 地址与字段路径");

  let res;
  try {
    res = await fetchWithRetry(url, { headers: OFFICIAL_HEADERS });
  } catch (e) {
    if (e instanceof ApiError) throw new ApiError(`官方 API 请求失败:${e.message}`, 502);
    throw e;
  }
  if (res.status === 404) throw new ApiError("官方 API 返回 404,请检查地址是否正确", 404);
  if (res.status === 403) throw new ApiError("官方 API 拒绝访问(HTTP 403),可能限流或需鉴权", 403);
  if (!res.ok) throw new ApiError(`官方 API 请求失败(HTTP ${res.status})`, 502);

  const len = Number(res.headers.get("content-length") || 0);
  if (len > OFFICIAL_MAX_BYTES) {
    throw new ApiError(
      `官方 API 响应过大(${(len / 1048576).toFixed(1)} MB),请改用支持分页/精简的地址(如追加 pageSize=1)`,
      502
    );
  }

  const text = await res.text();
  if (text.length > OFFICIAL_MAX_BYTES) {
    throw new ApiError(
      `官方 API 响应过大(${(text.length / 1048576).toFixed(1)} MB),请改用支持分页/精简的地址(如追加 pageSize=1)`,
      502
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError("官方 API 返回的不是 JSON,请检查地址", 502);
  }

  const raw = pickByJsonPath(data, app.jsonPath);
  if (raw === undefined || raw === null || raw === "") {
    throw new ApiError(`按路径「${app.jsonPath}」未找到版本字段,请检查字段路径`, 404);
  }
  const version = typeof raw === "object" ? "" : String(raw).trim();
  if (!version) throw new ApiError(`路径「${app.jsonPath}」取到的不是版本号`, 502);

  return { version, releaseUrl: url, publishedAt: null };
}

/**
 * 从 GitHub Release 资产中挑选最合适的下载包。
 * 优先级:x64.exe → x64.msi → 其他 exe → 其他 msi → 其它安装包(dmg/pkg/deb/rpm/AppImage/msix)
 * 会跳过签名/校验/调试等非安装文件,并降低 arm / 32 位资产的优先级。
 * @returns {string} 下载地址;没有合适资产时返回 ""
 */
/**
 * 给 GitHub Release 资产打分并降序排列。
 * 优先级:x64.exe → x64.msi → 其他 exe → 其他 msi → msix → dmg/pkg → deb/rpm/AppImage
 * 会跳过签名/校验/调试等非安装文件,并对 arm / 32 位资产降级。
 * GitHub 为资产提供的 digest(形如 "sha256:…")一并解析为 sha256 字段。
 * @returns {{name:string,url:string,score:number,kind:string,arch:string,sha256?:string}[]}
 */
function rankDownloadAssets(assets, limit = 30) {
  if (!Array.isArray(assets) || !assets.length) return [];

  const isX64 = (n) => /(?:^|[^a-z0-9])(x64|win64|amd64|x86[_-]64|64[_-]?bit)(?:[^a-z0-9]|$)/.test(n);
  const isArm = (n) => /(?:^|[^a-z0-9])(arm64|aarch64|arm)(?:[^a-z0-9]|$)/.test(n);
  const isX86 = (n) => /(?:^|[^a-z0-9])(x86|ia32|i386|win32|32[_-]?bit)(?:[^a-z0-9]|$)/.test(n);
  // 明显的非安装产物(签名、校验和、调试符号、源码包)
  const isJunk = (n) =>
    /\.(sha\d*|sig|asc|md5|txt|json|yml|yaml|pem)$/i.test(n) ||
    /(?:^|[^a-z0-9])(sources?|symbols?|debug|pdb|checksums?|sbom)(?:[^a-z0-9]|$)/.test(n);

  const extOf = (n) => {
    const m = n.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : "";
  };

  const scored = [];
  for (const asset of assets) {
    const url = asset && asset.browser_download_url;
    if (!url) continue;
    const name = String(asset.name || url.split("/").pop() || "");
    const lower = name.toLowerCase();
    if (isJunk(lower)) continue;

    const ext = extOf(lower);
    let score;
    if (ext === "exe") score = isX64(lower) ? 100 : 80;
    else if (ext === "msi") score = isX64(lower) ? 95 : 75;
    else if (ext === "msix") score = 60;
    else if (ext === "dmg" || ext === "pkg") score = 55;
    else if (ext === "deb" || ext === "rpm" || ext === "appimage") score = 50;
    else score = 10; // 其它文件仅作最后兜底
    // 架构微调:arm 与 32 位降级(而非排除,兼容只有单一架构的项目)
    if (isArm(lower)) score -= 60;
    else if (isX86(lower) && !isX64(lower)) score -= 20;

    const arch = isX64(lower) ? "x64" : isArm(lower) ? "arm" : isX86(lower) ? "x86" : "";
    const item = { name, url, score, kind: ext, arch };
    // GitHub 资产的官方 sha256 摘要(digest: "sha256:…"),与 winget 清单的校验值同构
    const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:")
      ? asset.digest.slice(7)
      : "";
    const sha = normalizeSha256(digest);
    if (sha) item.sha256 = sha;
    scored.push(item);
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit);
}

/** 只取排名第一的下载地址;没有合适资产时返回 "" */
function pickDownloadAsset(assets) {
  const ranked = rankDownloadAssets(assets, 1);
  return ranked.length ? ranked[0].url : "";
}

/** 按应用渠道分发查询;manual 渠道不支持自动查询 */
async function fetchLatest(app, env, opts = {}) {
  if (app.channel === "github" && app.repo) return fetchGitHubLatest(app.repo, env);
  if (app.channel === "chocolatey" && app.packageId) return fetchChocolateyLatest(app.packageId);
  if (app.channel === "winget" && app.packageId) return fetchWingetLatest(app.packageId, env, opts);
  if (app.channel === "official") {
    // 预设型官方源(如 Cisco)走各自的专用抓取器
    const preset = app.officialPreset ? findOfficialPreset(app.officialPreset) : null;
    if (preset && preset.mode === "cisco-notes") return fetchCiscoLatest();
    return fetchOfficialLatest(app);
  }
  if (app.channel === "cisco") return fetchCiscoLatest();
  throw new ApiError("手动维护的应用不支持自动查询,请在编辑中更新版本号");
}

function applyLatest(app, latest) {
  app.latestVersion = latest.version;
  app.releaseUrl = latest.releaseUrl;
  app.publishedAt = latest.publishedAt;
  app.lastCheckedAt = nowIso();
  // GitHub Releases / winget 清单的刷新都会附带安装包候选,同步更新下载菜单
  if (Array.isArray(latest.downloads)) {
    app.downloads = latest.downloads;
    // 用户没手动指定下载地址时,用候选里的首选(已按架构/类型排好序)
    if (!app.manualDownloadUrl && latest.downloads.length) {
      app.downloadUrl = latest.downloads[0].url;
    }
  }
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
 * @returns {{checked:number,updated:number,notified:boolean,updates:object[],errors:object[]}}
 */
async function runUpdateCheck(env) {
  // 批量检查从零计子请求预算,并禁用可选增强(发布日期),
  // 确保 20+ 应用也不会击穿 Cloudflare 单次调用 50 个子请求的上限
  subrequestsUsed = 0;
  const list = await readApps(env);
  // 定时检查覆盖全部自动渠道应用(让页面版本/检查时间始终保持新鲜);
  // notify 只决定「发现更新时是否推送」,不影响是否检查。
  const targets = list.filter((a) => a.channel !== "manual");
  const gap = env.CHECK_GAP_MS !== undefined ? Number(env.CHECK_GAP_MS) : 500;

  const found = [];
  const errors = [];
  for (const app of targets) {
    try {
      const latest = await fetchLatest(app, env, { dateMode: "off" });
      applyLatest(app, latest);
      if (
        latest.version &&
        latest.version !== app.notifiedVersion &&
        // 仅当最新版本严格高于当前版本才算有更新:当前版本更高时
        // (手动填了新版本 / 上游回退 release)不推送,避免误报
        (!app.version || compareVersions(latest.version, app.version) > 0)
      ) {
        found.push({ app, version: latest.version });
      }
    } catch (e) {
      const message = (e && e.message) || String(e);
      errors.push({ name: app.name, channel: app.channel, error: message });
      console.log(`[check] ${app.name}(${app.channel}): ${message}`);
    }
    if (gap > 0) await sleep(gap);
  }

  // 只有开启通知的应用才推送(以及记录 notifiedVersion 防重复)
  const toNotify = found.filter((f) => f.app.notify !== false);
  let notified = false;
  if (toNotify.length) {
    notified = await sendNotifications(env, toNotify);
    if (notified) for (const f of toNotify) f.app.notifiedVersion = f.version;
  }
  await writeApps(env, list);

  return {
    checked: targets.length,
    updated: found.length,
    notified,
    updates: found.map((f) => ({ name: f.app.name, version: f.version })),
    errors,
  };
}

/** 根据配置与额度生成可读的诊断建议 */
function buildDiagHints(config, github, choco) {
  const hints = [];
  if (!config.kv) hints.push({ level: "error", text: "APP_KV 未绑定,应用数据无法保存" });
  if (!config.adminPassword) hints.push({ level: "error", text: "ADMIN_PASSWORD 未配置,编辑接口会全部拒绝" });
  if (!config.cronSecret) hints.push({ level: "warn", text: "CRON_SECRET 未配置,GitHub Actions 将无法触发检查" });

  if (!config.githubToken) {
    hints.push({ level: "warn", text: "GITHUB_TOKEN 未配置:GitHub / winget 渠道与自动检测依赖匿名额度(60 次/小时/IP),共享出口 IP 极易耗尽" });
  } else if (!github.ok) {
    // 配置了但额度查验失败(常见于令牌无效/过期,GitHub 返回 401)
    const detail = github.error || "未知错误";
    hints.push({
      level: "error",
      text: `GITHUB_TOKEN 已设置但校验失败(${detail}):令牌可能已过期、被撤销或填写有误。请到 GitHub 重新生成并更新密钥`,
    });
  } else if (!github.authenticated) {
    hints.push({
      level: "error",
      text: `GITHUB_TOKEN 已设置但 GitHub 未识别(限额 ${github.limit}/小时):令牌可能已过期、被撤销,或填入了多余空格/引号。请重新生成并更新密钥`,
    });
  } else {
    hints.push({ level: "ok", text: `GITHUB_TOKEN 生效,剩余额度 ${github.remaining}/${github.limit}` });
  }

  if (github.ok && github.remaining !== null && github.remaining < 100) {
    hints.push({ level: "warn", text: "GitHub 剩余额度偏低,建议检查是否有其他程序共用该令牌" });
  }
  const notifyCount = Object.values(config.notify).filter(Boolean).length;
  if (!notifyCount) hints.push({ level: "info", text: "未配置任何通知渠道,发现新版本时只在页面展示,不会推送" });

  // Chocolatey 连通性
  if (choco) {
    if (choco.ok) {
      hints.push({
        level: "ok",
        text: `Chocolatey 渠道可用(可用端点:${choco.workingEndpoint})`,
      });
    } else {
      const detail = (choco.attempts || [])
        .map((a) => `${a.endpoint}=${a.error ? "错误" : a.status}`)
        .join(" / ");
      hints.push({
        level: "warn",
        text: `Chocolatey 渠道当前不可用(${detail}):Chocolatey 与 Cloudflare Workers 同在 Cloudflare 网络上,Worker 出口 IP 被其 WAF 拦截时通常无解。建议改用 winget 渠道`,
      });
    }
  }

  return hints;
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

  /** Cron Trigger 入口(可选,当前默认未启用):定时检查更新并推送通知 */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runUpdateCheck(env).then((s) =>
        console.log(`[cron] 检查 ${s.checked} 个,更新 ${s.updated} 个,推送 ${s.notified}`)
      )
    );
  },
};

async function handleApi(request, env, pathname) {
  const method = request.method;

  /* ── 鉴权(公开接口)── */

  if (pathname === "/api/session" && method === "GET") {
    return json({
      admin: await isAdminRequest(env, request),
      configured: Boolean(env && env.ADMIN_PASSWORD),
    });
  }

  /* ── 站点功能开关(管理员可改;访客可读) ── */

  if (pathname === "/api/official-presets" && method === "GET") {
    return json({ presets: publicOfficialPresets() });
  }

  if (pathname === "/api/settings" && method === "GET") {
    return json(await readSettings(env));
  }
  if (pathname === "/api/settings" && method === "PUT") {
    await requireAdmin(env, request);
    const body = await readJson(request, true);
    const cur = await readSettings(env);
    if (body && body.hitokoto !== undefined) {
      if (typeof body.hitokoto !== "boolean") {
        throw new ApiError("hitokoto 必须为布尔值(true/false)", 400);
      }
      cur.hitokoto = body.hitokoto;
    }
    await kv(env).put(SETTINGS_KEY, JSON.stringify(cur));
    return json(cur);
  }

  if (pathname === "/api/login" && method === "POST") {
    if (!env || !env.ADMIN_PASSWORD) {
      throw new ApiError("未配置管理员密码:请设置环境变量/Secret ADMIN_PASSWORD(步骤见 README)", 500);
    }
    const body = await readJson(request);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const failKey = "loginfail:" + ip;
    const fails = Number((await kv(env).get(failKey)) || 0);
    if (fails >= LOGIN_MAX_FAILS) {
      throw new ApiError("登录失败次数过多,请 15 分钟后再试", 429);
    }
    if (!(await safeEqual(String(body.password ?? ""), env.ADMIN_PASSWORD))) {
      await kv(env).put(failKey, String(fails + 1), { expirationTtl: LOGIN_LOCK_TTL });
      throw new ApiError("密码错误", 401);
    }
    const token = crypto.randomUUID() + "-" + crypto.randomUUID().slice(0, 8);
    await kv(env).put("session:" + token, "1", { expirationTtl: SESSION_TTL });
    return json({ ok: true }, 200, {
      "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; Secure; Path=/; Max-Age=${SESSION_TTL}; SameSite=Strict`,
    });
  }

  if (pathname === "/api/logout" && method === "POST") {
    const token = getCookie(request, SESSION_COOKIE);
    if (token && env && env.APP_KV) await env.APP_KV.delete("session:" + token);
    return json({ ok: true }, 200, {
      "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict`,
    });
  }

  /* ── 定时检查触发(GitHub Actions 调用;也允许管理员会话手动触发)── */

  if (pathname === "/api/check" && method === "POST") {
    if (!(await authorizedForCheck(env, request))) {
      throw new ApiError("需要有效的 CRON_SECRET 或管理员登录", 401);
    }
    const store = kv(env);
    if (await store.get(CHECK_LOCK_KEY)) {
      throw new ApiError("已有检查任务在执行中,请稍后重试", 409);
    }
    // 并发锁:防止 workflow 与手动触发重叠执行,异常时 5 分钟自动过期
    await store.put(CHECK_LOCK_KEY, nowIso(), { expirationTtl: 300 });
    try {
      return json({ ok: true, ...(await runUpdateCheck(env)) });
    } finally {
      try { await store.delete(CHECK_LOCK_KEY); } catch { /* 释放失败交给 TTL */ }
    }
  }

  /* ── 查看类接口(公开,访客只读)── */

  if (pathname === "/api/apps" && method === "GET") {
    const list = await readApps(env);
    try {
      const seeded = await seedSampleIfFirstRun(env, list);
      return json(seeded || list);
    } catch {
      return json(list); // 示例注入失败不影响查看
    }
  }

  /* ── 编辑类接口(需要管理员)── */

  if (pathname === "/api/apps" && method === "POST") {
    await requireAdmin(env, request);
    const body = await readJson(request);
    const app = normalizeApp(body);
    app.id = crypto.randomUUID();
    app.createdAt = nowIso();
    const list = await readApps(env);
    // 追加到其所属分组(或未分组)的末尾
    app.order = nextOrder(list);
    list.unshift(app);
    await writeApps(env, list);
    return json(app, 201);
  }

  let m = pathname.match(/^\/api\/apps\/([A-Za-z0-9-]+)$/);
  if (m && (method === "PUT" || method === "DELETE")) {
    await requireAdmin(env, request);
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
        (updated.packageId || "") !== (prev.packageId || "") ||
        (updated.officialUrl || "") !== (prev.officialUrl || "") ||
        (updated.jsonPath || "") !== (prev.jsonPath || "") ||
        (updated.officialPreset || "") !== (prev.officialPreset || "");
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

    list.splice(idx, 1);
    await writeApps(env, list);
    return json({ ok: true });
  }

  /* ── Chocolatey → winget 一键转换(需管理员)──
     不带 packageId 时只做搜索返回候选;带 packageId 时校验并写入应用 */
  m = pathname.match(/^\/api\/apps\/([A-Za-z0-9-]+)\/convert-to-winget$/);
  if (m && method === "POST") {
    await requireAdmin(env, request);
    const list = await readApps(env);
    const app = list.find((a) => a.id === m[1]);
    if (!app) throw new ApiError("应用不存在", 404);
    if (app.channel !== "chocolatey") {
      throw new ApiError("只有 Chocolatey 渠道的应用支持该转换", 400);
    }

    const body = await readJson(request, true);
    const picked = body && typeof body.packageId === "string" ? body.packageId.trim() : "";

    // 第一步:未指定目标时,搜索候选供用户选择
    if (!picked) {
      const { candidates, errors } = await findWingetCandidates(app, env);
      return json({
        app: { id: app.id, name: app.name, packageId: app.packageId },
        candidates,
        errors,
      });
    }

    // 第二步:校验选定的 ID 并转换
    if (!WINGET_ID_RE.test(picked)) {
      throw new ApiError("winget 包 ID 格式不正确,应形如 VideoLAN.VLC", 400);
    }
    const verified = await verifyWingetId(picked, env);
    if (!verified.ok) throw new ApiError(`winget 源中找不到包「${picked}」`, 404);

    app.channel = "winget";
    app.packageId = picked;
    delete app.repo;
    // 换了数据源,旧的查询结果与推送标记全部作废
    delete app.latestVersion;
    delete app.releaseUrl;
    delete app.publishedAt;
    delete app.lastCheckedAt;
    delete app.notifiedVersion;
    // 用新渠道立刻取一次版本
    subrequestsUsed = 0;
    try {
      const latest = await fetchLatest(app, env, { dateMode: "always" });
      applyLatest(app, latest);
      app.notifiedVersion = latest.version;
    } catch { /* 查询失败不影响转换本身,用户可稍后手动刷新 */ }
    await writeApps(env, list);
    return json({ ok: true, app });
  }

  m = pathname.match(/^\/api\/apps\/([A-Za-z0-9-]+)\/refresh$/);
  if (m && method === "POST") {
    await requireAdmin(env, request);
    const list = await readApps(env);
    const app = list.find((a) => a.id === m[1]);
    if (!app) throw new ApiError("应用不存在", 404);
    subrequestsUsed = 0;   // 单应用刷新预算充足,可以带上发布日期
    const latest = await fetchLatest(app, env, { dateMode: "always" });
    applyLatest(app, latest);
    // 手动刷新视为已知悉,定时任务不再重复推送该版本
    app.notifiedVersion = latest.version;
    await writeApps(env, list);
    return json(app);
  }

  /* ── 自动检测应用的官网与下载地址(需管理员)──
     来源优先级:GitHub Releases(主页/资产) → winget 清单 → Chocolatey 包页面 */
  /* ── 配置诊断(仅管理员):确认密钥/绑定是否真的生效,并实时查验 GitHub 额度 ── */
  if (pathname === "/api/diagnostics" && method === "GET") {
    await requireAdmin(env, request);

    const mask = (v) => (v ? `已配置(长度 ${String(v).length})` : "未配置");
    const config = {
      kv: Boolean(env && env.APP_KV),
      adminPassword: Boolean(env && env.ADMIN_PASSWORD),
      cronSecret: Boolean(env && env.CRON_SECRET),
      githubToken: Boolean(env && env.GITHUB_TOKEN),
      githubTokenHint: mask(env && env.GITHUB_TOKEN),
      notify: {
        feishu: Boolean(env && env.FEISHU_WEBHOOK_URL),
        telegram: Boolean(env && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        bark: Boolean(env && env.BARK_URL),
        serverchan: Boolean(env && env.SERVERCHAN_SENDKEY),
        webhook: Boolean(env && env.NOTIFY_WEBHOOK_URL),
      },
    };

    // 实时查验 GitHub 额度:这是判断 GITHUB_TOKEN 是否真生效的唯一可靠方式
    const github = { ok: false, authenticated: false, remaining: null, limit: null, resetAt: null, error: null };
    try {
      const res = await fetch("https://api.github.com/rate_limit", { headers: await ghHeaders(env) });
      if (res.ok) {
        const data = await res.json();
        const core = (data.resources && data.resources.core) || {};
        github.ok = true;
        github.remaining = core.remaining ?? null;
        github.limit = core.limit ?? null;
        // 认证请求限额 5000,匿名 60 —— 用限额反推 token 是否被 GitHub 认可
        github.authenticated = (core.limit ?? 0) > 60;
        github.resetAt = core.reset ? new Date(core.reset * 1000).toISOString() : null;
      } else {
        github.error = `HTTP ${res.status}`;
      }
    } catch (e) {
      github.error = (e && e.message) || "请求失败";
    }

    // 数据量概览,便于确认 KV 读写正常
    const [list, groups] = await Promise.all([readApps(env), readGroups(env)]);

    // Chocolatey 连通性实测:按候选端点逐个探测(用已知存在的包 vlc)
    const choco = { ok: false, workingEndpoint: null, attempts: [] };
    for (const ep of chocoEndpointList("vlc")) {
      try {
        const res = await fetch(ep.url, ep.opts);
        const status = res.status;
        let usable = false;
        if (ep.parse === "redirect") usable = status >= 300 && status < 400 && Boolean(res.headers.get("location"));
        else usable = res.ok;
        choco.attempts.push({ endpoint: ep.name, label: ep.label, status, usable });
        if (usable && !choco.workingEndpoint) {
          choco.ok = true;
          choco.workingEndpoint = ep.name;
        }
      } catch (e) {
        choco.attempts.push({
          endpoint: ep.name, label: ep.label, status: null,
          usable: false, error: (e && e.message) || "请求失败",
        });
      }
    }

    return json({
      checkedAt: nowIso(),
      config,
      github,
      choco,
      data: { apps: list.length, groups: groups.length },
      hints: buildDiagHints(config, github, choco),
    });
  }

  if (pathname === "/api/apps/detect-links" && method === "POST") {
    await requireAdmin(env, request);
    const body = await readJson(request);
    const draft = normalizeApp({
      name: body.name || "temp",
      channel: body.channel || "manual",
      repo: body.repo,
      packageId: body.packageId,
      officialUrl: body.officialUrl,
      jsonPath: body.jsonPath,
      version: body.version,
    });
    const out = { appUrl: "", downloadUrl: "", downloads: [], source: null };

    if (draft.channel === "github" && draft.repo) {
      const headers = await ghHeaders(env);
      out.appUrl = "https://github.com/" + draft.repo;
      let res = await fetchWithRetry(`https://api.github.com/repos/${draft.repo}/releases/latest`, { headers });
      if (res.status === 404) {
        res = await fetchWithRetry(`https://api.github.com/repos/${draft.repo}/releases?per_page=1`, { headers });
        if (res.ok) {
          const arr = await res.json();
          if (Array.isArray(arr) && arr.length) {
            // 同样按 x64.exe → x64.msi 的优先级挑选资产
            out.downloads = rankDownloadAssets(arr[0].assets);
            out.downloadUrl = out.downloads.length ? out.downloads[0].url : (arr[0].html_url || "");
            out.source = "github-release";
          }
        }
      } else if (res.ok) {
        const r = await res.json();
        // 优先选安装包: x64.exe → x64.msi → 其他 exe/msi → 其它平台安装包
        out.downloads = rankDownloadAssets(r.assets);
        out.downloadUrl = out.downloads.length ? out.downloads[0].url : (r.html_url || "");
        out.source = "github-release";
      }
    } else if (draft.channel === "winget" && draft.packageId) {
      out.appUrl = "https://winget.run/pkg/" + draft.packageId.replace(".", "/");
      out.source = "winget";
      // 读取清单里的 installer.yaml,拿到各架构的真实下载地址
      try {
        const latest = await fetchWingetLatest(draft.packageId, env);
        out.downloads = latest.downloads || [];
        out.downloadUrl = out.downloads.length ? out.downloads[0].url : out.appUrl;
        out.detectedVersion = latest.version;
        if (out.downloads.length) out.source = "winget-installer";
      } catch {
        // 查询失败时退回包页面
        out.downloadUrl = out.appUrl;
      }
    } else if (draft.channel === "chocolatey" && draft.packageId) {
      out.appUrl = `${CHOCO_HOST}/packages/${encodeURIComponent(draft.packageId)}`;
      out.downloadUrl = out.appUrl;
      out.source = "chocolatey";
    } else if (draft.channel === "cisco") {
      // 官网指向 Cisco Secure Client 产品支持页,下载地址即官方 Release Notes
      out.appUrl = "https://www.cisco.com/c/en/us/support/security/secure-client/model.html";
      out.downloadUrl = CISCO_RELEASE_NOTES_URL;
      out.source = "cisco";
    } else if (draft.channel === "official" && draft.officialPreset) {
      const preset = findOfficialPreset(draft.officialPreset);
      if (preset) {
        out.appUrl = preset.appUrl || "";
        out.downloadUrl = preset.releaseUrl || preset.officialUrl || "";
        out.iconUrl = preset.iconUrl || "";
        out.name = preset.name;
        try {
          const latest = preset.mode === "cisco-notes"
            ? await fetchCiscoLatest()
            : await fetchOfficialLatest({ officialUrl: preset.officialUrl, jsonPath: preset.jsonPath });
          out.detectedVersion = latest.version;
          out.downloadUrl = latest.releaseUrl || out.downloadUrl;
        } catch { /* 探测失败不阻断,用户仍可保存 */ }
        out.source = "official-preset";
      }
    } else if (draft.channel === "official" && draft.officialUrl) {
      // 官方自查:用 API 域名作官网,下载地址留空交给用户填写
      try { out.appUrl = "https://" + new URL(draft.officialUrl).hostname; } catch { /* 忽略 */ }
      out.source = "official";
    }

    return json(out);
  }

  if (pathname === "/api/apps/export" && method === "GET") {
    await requireAdmin(env, request);
    const list = await readApps(env);
    const groups = await readGroups(env);
    const payload = {
      format: "app-version-backup",
      version: 2, // v2 起包含 groups 与应用的 groupId/order
      exportedAt: nowIso(),
      count: list.length,
      groupCount: groups.length,
      groups,
      apps: list,
    };
    const stamp = nowIso().replace(/[:T]/g, "-").slice(0, 19);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="app-version-backup-${stamp}.json"`,
        "cache-control": "no-store",
      },
    });
  }

  if (pathname === "/api/apps/import" && method === "POST") {
    await requireAdmin(env, request);
    const body = await readJson(request);
    const records = Array.isArray(body) ? body : body.apps;
    if (!Array.isArray(records)) {
      throw new ApiError("导入文件格式不正确:应为 {\"apps\":[…]} 或应用数组");
    }
    if (records.length > 500) throw new ApiError("单次导入最多 500 条记录");

    // 分组:仅当导入文件里带 groups 数组时才覆盖分组。
    // 导入 v1 旧备份(无 groups 字段)不应清空现有分组。
    let importedGroups = null;
    if (Array.isArray(body.groups)) {
      if (body.groups.length > 200) throw new ApiError("单次导入最多 200 个分组");
      importedGroups = [];
      body.groups.forEach((grp, i) => {
        if (!grp || typeof grp !== "object") return;
        try {
          importedGroups.push({
            id: typeof grp.id === "string" && /^[A-Za-z0-9-]+$/.test(grp.id) ? grp.id : crypto.randomUUID(),
            name: normalizeGroupName(grp.name),
            order: Number.isFinite(Number(grp.order)) ? Number(grp.order) : i,
            collapsed: Boolean(grp.collapsed),
            createdAt: typeof grp.createdAt === "string" ? grp.createdAt : nowIso(),
          });
        } catch (e) {
          throw new ApiError(`第 ${i + 1} 个分组无效:${e.message}`, 400);
        }
      });
    }
    const validGroupIds = importedGroups ? new Set(importedGroups.map((x) => x.id)) : null;

    const list = [];
    records.forEach((rec, i) => {
      try {
        const app = normalizeImportedApp(rec);
        // 分组引用必须存在于本次导入的分组中,否则归为未分组
        if (app.groupId && (!validGroupIds || !validGroupIds.has(app.groupId))) app.groupId = null;
        list.push(app);
      } catch (e) {
        throw new ApiError(`第 ${i + 1} 条记录无效:${e.message}`, e instanceof ApiError ? e.status : 400);
      }
    });
    await writeApps(env, list);
    if (importedGroups) await writeGroups(env, importedGroups);
    return json({ ok: true, imported: list.length, groups: importedGroups ? importedGroups.length : 0 });
  }

  /* ── 分组(查看公开,编辑需管理员)── */

  if (pathname === "/api/groups" && method === "GET") {
    return json(await readGroups(env));
  }

  if (pathname === "/api/groups" && method === "POST") {
    await requireAdmin(env, request);
    const body = await readJson(request);
    const groups = await readGroups(env);
    const group = {
      id: crypto.randomUUID(),
      name: normalizeGroupName(body.name),
      order: nextOrder(groups),
      collapsed: false, // 兼容字段,实际折叠状态存于各客户端本地
      createdAt: nowIso(),
    };
    groups.push(group);
    await writeGroups(env, groups);
    return json(group, 201);
  }

  let g = pathname.match(/^\/api\/groups\/([A-Za-z0-9-]+)$/);
  if (g && (method === "PUT" || method === "DELETE")) {
    await requireAdmin(env, request);
    const groups = await readGroups(env);
    const idx = groups.findIndex((x) => x.id === g[1]);
    if (idx === -1) throw new ApiError("分组不存在", 404);

    if (method === "PUT") {
      const body = await readJson(request);
      if (body.name !== undefined) groups[idx].name = normalizeGroupName(body.name);
      // collapsed 仅作历史兼容保留:折叠状态已改为各客户端本地保存(localStorage),
      // 不再由服务端作为权威来源,前端也不会读取该值。
      if (body.collapsed !== undefined) groups[idx].collapsed = Boolean(body.collapsed);
      if (body.order !== undefined) {
        const n = Number(body.order);
        if (Number.isFinite(n)) groups[idx].order = n;
      }
      await writeGroups(env, groups);
      return json(groups[idx]);
    }

    // 删除分组:组内应用移回「未分组」,不连带删除应用
    const gid = g[1];
    groups.splice(idx, 1);
    await writeGroups(env, groups);
    const apps = await readApps(env);
    let moved = 0;
    for (const a of apps) {
      if (a.groupId === gid) { a.groupId = null; moved++; }
    }
    if (moved) await writeApps(env, apps);
    return json({ ok: true, movedApps: moved });
  }

  /* ── 布局保存(整表覆盖,需管理员)──
     一次请求提交分组顺序 + 每个应用所属组与组内顺序,保证并发下结果一致 */
  if (pathname === "/api/layout" && method === "PUT") {
    await requireAdmin(env, request);
    const body = await readJson(request);
    const groups = await readGroups(env);
    const apps = await readApps(env);
    const byGroupId = new Map(groups.map((x) => [x.id, x]));
    const byAppId = new Map(apps.map((x) => [x.id, x]));

    if (Array.isArray(body.groups)) {
      body.groups.forEach((item, i) => {
        if (!item || typeof item.id !== "string") return;
        const target = byGroupId.get(item.id);
        if (!target) return;
        target.order = i;
        if (item.name !== undefined) target.name = normalizeGroupName(item.name);
        if (item.collapsed !== undefined) target.collapsed = Boolean(item.collapsed);
      });
    }

    if (Array.isArray(body.apps)) {
      body.apps.forEach((item) => {
        if (!item || typeof item.id !== "string") return;
        const target = byAppId.get(item.id);
        if (!target) return;
        const gid = item.groupId === null || item.groupId === "" ? null : String(item.groupId);
        // 只接受已存在的分组,避免脏引用
        target.groupId = gid && byGroupId.has(gid) ? gid : null;
        const n = Number(item.order);
        target.order = Number.isFinite(n) ? n : 0;
      });
    }

    await writeGroups(env, groups);
    await writeApps(env, apps);
    return json({ ok: true, groups: groups.length, apps: apps.length });
  }

  throw new ApiError("接口不存在", 404);
}
