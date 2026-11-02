#!/usr/bin/env node
/**
 * 部署前生成最终 wrangler 配置(KV 命名空间 ID 由环境变量注入)
 *
 * 为什么要这一步:wrangler.toml 不支持 ${ENV} 插值,KV 绑定的 id
 * 必须是字面量。因此改为部署前读取环境变量,生成一份带 id 的配置。
 *
 * 读取顺序(前者优先):
 *   1. process.env.KV_NAMESPACE_ID   —— Cloudflare Workers Builds 的构建变量
 *   2. 项目根目录 .dev.vars 中的 KV_NAMESPACE_ID —— 本地开发方便
 *
 * 输出:wrangler.generated.toml(已 gitignore)
 *
 * 用法:
 *   node scripts/build-config.mjs                    # 缺 ID 时报错退出
 *   node scripts/build-config.mjs --allow-missing-kv # 只生成静态站点配置(页面无存储)
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "wrangler.toml");
const OUT = path.join(ROOT, "wrangler.generated.toml");
const ENV_NAME = "KV_NAMESPACE_ID";
const ID_RE = /^[0-9a-f]{32}$/i;

/** 从本地 .dev.vars 读取(本地开发免去每次导出环境变量) */
async function readDevVars() {
  try {
    const text = await readFile(path.join(ROOT, ".dev.vars"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === ENV_NAME) {
        return m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* 没有 .dev.vars 属正常情况 */ }
  return "";
}

let id = String(process.env[ENV_NAME] || "").trim();
let source = "Cloudflare 构建变量 " + ENV_NAME;
if (!id) {
  id = await readDevVars();
  source = ".dev.vars";
}

const base = await readFile(SRC, "utf8");
const allowMissing = process.argv.includes("--allow-missing-kv");

if (!ID_RE.test(id)) {
  const hint = [
    id ? `✗ ${ENV_NAME} 格式不正确:"${id}"` : `✗ 缺少 ${ENV_NAME}(KV 命名空间 ID)`,
    "  正确格式为 32 位十六进制,如 a1b2c3d4e5f67890a1b2c3d4e5f67890",
    "",
    "  获取方式:Cloudflare Dashboard →「存储和数据库」→「KV」→ 点开命名空间,复制页面顶部的 ID",
    "  配置位置:",
    "    · Cloudflare Workers Builds → 设置 → 构建 → 变量和密钥 → 添加 " + ENV_NAME,
    "    · 本地开发:项目根目录 .dev.vars 中写 " + ENV_NAME + "=你的ID",
  ].join("\n");

  if (!allowMissing) {
    console.error(hint);
    console.error("\n  仅生成无 KV 的配置(页面会提示未绑定存储):加 --allow-missing-kv");
    process.exit(1);
  }
  await writeFile(OUT, base, "utf8");
  console.log("⚠ 未注入 KV 绑定,已生成 " + path.basename(OUT) + "(仅静态页面可用)");
  console.error(hint);
  process.exit(0);
}

const generated =
  base.trimEnd() +
  `

# ── 以下由 scripts/build-config.mjs 在部署前自动注入,请勿手改 ──
# KV 命名空间 ID 来源:${source}
[[kv_namespaces]]
binding = "APP_KV"
id = "${id}"
`;

await writeFile(OUT, generated, "utf8");
console.log(
  `✓ 已生成 ${path.basename(OUT)}  KV=${id.slice(0, 4)}…${id.slice(-4)}(来源:${source})`
);
