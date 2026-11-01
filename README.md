# AppVersion · 应用版本检测

> **线上地址:<https://app-version.kevinlidk.cn>**

一个部署在 **Cloudflare Workers** 上的轻量「应用版本检测」Web 解决方案:集中管理你关注的应用,一键查询它们的最新版本,并对手机端访问做了专门的自适应优化。

## 功能特性

- ✅ **应用管理** —— 添加 / 编辑 / 删除关注的应用(名称、版本来源、当前版本、备注)
- ✅ **版本查询** —— GitHub 渠道应用自动拉取最新 Release;其他渠道可手动维护版本号
- ✅ **更新提醒** —— 最新版本与当前版本不一致时,卡片高亮「有新版本」,支持一键「已更新」标记
- ✅ **批量刷新** —— 一键刷新全部 GitHub 渠道应用,逐一显示进度
- ✅ **搜索筛选** —— 按名称 / 仓库 / 备注搜索,按渠道筛选
- 📱 **移动端优先** —— 响应式布局(适配 360px~430px 常见手机屏宽)、大号点击区域、刘海屏安全区适配、深色模式自动跟随系统

## 技术栈与项目结构

原生 HTML / CSS / JavaScript,无前端框架;后端为 Cloudflare Worker + KV,零依赖(除 wrangler 工具链)。

```
├── src/worker.js        # Worker:REST API、GitHub Release 查询
├── public/index.html    # 前端单页(Workers Static Assets 承载)
├── wrangler.toml        # Cloudflare Workers 配置
├── package.json
└── test/
    ├── smoke.mjs        # API 冒烟测试(离线)
    └── dev-server.mjs   # 轻量本地预览服务器(可选,无 wrangler 也能跑)
```

- **存储**:Cloudflare KV,绑定变量名 `APP_KV`(应用列表序列化为单个 JSON 文档)
- **静态资源**:Workers Static Assets,目录 `public/`;未命中的 `/api/*` 请求交给 Worker

## 部署到 Cloudflare Workers

### 方式一:Dashboard 关联 GitHub 仓库(推荐)

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers 和 Pages** → **创建** → 选择「**导入一个 Git 仓库**」,授权并选择本仓库(`Kevinlidk/AppVersion`)
2. 构建配置保持默认(会自动执行 `npx wrangler deploy`)并部署
3. 创建 KV 命名空间:左侧 **存储和数据库 → KV** → 创建命名空间(如 `app-version`)
4. 回到该 Worker → **设置 → 绑定** → 添加 **KV 命名空间**:变量名称填 `APP_KV`,选择刚创建的命名空间
5. (可选)绑定自定义域名:Worker **设置 → 域和路由** 添加 `app-version.kevinlidk.cn`

> 未绑定 KV 前访问页面会提示「未绑定 KV 存储」,按第 3~4 步补上即可。

### 方式二:本地 wrangler CLI

```bash
npm install
npx wrangler login
npx wrangler kv namespace create APP_KV
# 把命令输出的 id 填入 wrangler.toml,并取消 [[kv_namespaces]] 三行注释
npx wrangler deploy
```

### 可选配置

| 配置 | 说明 |
| --- | --- |
| `GITHUB_TOKEN`(Secret) | 提升 GitHub API 速率限制(匿名 60 次/小时/IP)。设置:`npx wrangler secret put GITHUB_TOKEN` |

## 本地开发

```bash
npm install
npm run dev      # wrangler dev,地址 http://localhost:8787(需先配置 KV)
npm run serve    # 或用轻量预览服务器(KV 内存模拟,GitHub API 返回示例数据)
npm test         # API 冒烟测试(离线)
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/apps` | 获取应用列表 |
| POST | `/api/apps` | 新增应用 |
| PUT | `/api/apps/:id` | 更新应用 |
| DELETE | `/api/apps/:id` | 删除应用 |
| POST | `/api/apps/:id/refresh` | 查询 GitHub 渠道最新版本 |

应用记录示例:

```json
{
  "id": "7f3c…",
  "name": "Telegram Desktop",
  "channel": "github",
  "repo": "telegramdesktop/tdesktop",
  "version": "v5.12.3",
  "latestVersion": "v5.13",
  "releaseUrl": "https://github.com/telegramdesktop/tdesktop/releases/tag/v5.13",
  "publishedAt": "2026-01-01T00:00:00Z",
  "lastCheckedAt": "2026-11-02T00:00:00Z",
  "note": ""
}
```

## 许可

仅供个人使用。
