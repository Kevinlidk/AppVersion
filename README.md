# AppVersion · 应用版本检测

> **线上地址:<https://app-version.kevinlidk.cn>**

一个部署在 **Cloudflare Workers** 上的轻量「应用版本检测」Web 解决方案:集中管理你关注的应用,一键查询它们的最新版本,有可用更新时自动推送通知,并对手机端访问做了专门的自适应优化。

## 功能特性

- ✅ **应用管理** —— 添加 / 编辑 / 删除关注的应用(名称、版本来源、当前版本、备注)
- ✅ **多渠道版本查询** ——
  - **GitHub Releases**:自动拉取最新正式版,无 latest 时回退最近一条 Release
  - **Chocolatey 社区源**:官方 OData API 自动查询(也是 [UniGetUI](https://github.com/Devolutions/UniGetUI) 聚合的同一数据源)
  - **winget 官方源**:查询 `microsoft/winget-pkgs` 清单仓库(即 winget 的官方数据源)
  - **手动维护**:官网无查询途径的应用直接手动记录版本号
- ✅ **更新推送通知** —— GitHub Actions 定时触发检查(不占用 Cloudflare Cron 名额),发现新版本时聚合一条消息推送(支持飞书 / Telegram / Bark / Server酱 / 通用 webhook,可同时配置多个);支持按应用关闭推送、去重防骚扰
- ✅ **更新提醒** —— 最新版本与当前版本不一致时,卡片高亮「有新版本」,支持一键「已更新」标记
- 🎁 **开箱示例** —— 首次访问自动内置「Google Chrome」示例应用(Chocolatey 渠道,可自动查询);登录后可编辑或删除,清空后不会重复注入
- 🔐 **管理员登录** —— 右上角登录后才能添加/编辑/删除/刷新监控应用;访客默认只读,仅可查看页面信息
- 📤 **配置导入 / 导出** —— 管理员可一键把全部关注应用导出为 JSON 配置文件备份,或导入配置文件恢复/迁移(导入覆盖当前列表,操作前有确认提示)
- ✅ **批量刷新** —— 一键刷新全部自动渠道应用,逐一显示进度
- ✅ **搜索筛选** —— 按名称 / 仓库 / 包 ID / 备注搜索,按渠道筛选
- 🎨 **动态背景** —— GlyphWind WebGL2 字形流背景(`public/background/` 套件,与参考项目接线一致),深色页面底 `#333` + 白色薄雾层,浅色 UI 卡片浮于其上;支持 `?seed=123&look=mixed|lettered|figured` 切换图案
- 📱 **移动端优先** —— 响应式布局(适配 360px~430px 常见手机屏宽)、大号点击区域、刘海屏安全区适配、深色模式自动跟随系统

> 💡 **关于 UniGetUI**:它本身只提供本机 IPC/CLI 接口,没有公开的 Web 版本查询 API;本项目的 Chocolatey / winget 渠道直接对接它背后聚合的官方数据源,效果等同且可在云端运行。

## 技术栈与项目结构

原生 HTML / CSS / JavaScript,无前端框架;后端为 Cloudflare Worker + KV,零依赖(除 wrangler 工具链)。

```
├── src/worker.js        # Worker:REST API、多渠道版本查询、检查与通知推送
├── public/index.html    # 前端单页(Workers Static Assets 承载)
├── public/background/   # GlyphWind 动态背景套件(WebGL2,装饰性)
├── .github/workflows/   # check-updates.yml:定时触发 /api/check
├── wrangler.toml        # Cloudflare Workers 配置(assets / KV)
├── package.json
└── test/
    ├── smoke.mjs        # API + 通知推送冒烟测试(离线)
    └── dev-server.mjs   # 轻量本地预览服务器(可选,无 wrangler 也能跑)
```

- **存储**:Cloudflare KV,绑定变量名 `APP_KV`(应用列表序列化为单个 JSON 文档)
- **静态资源**:Workers Static Assets,目录 `public/`;未命中的 `/api/*` 请求交给 Worker

## 部署到 Cloudflare Workers

### 方式一:Dashboard 关联 GitHub 仓库(推荐)

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers 和 Pages** → **创建** → 选择「**导入一个 Git 仓库**」,授权并选择本仓库(`Kevinlidk/AppVersion`)
2. 构建配置保持默认(会自动执行 `npx wrangler deploy`)并部署
3. 创建 KV 命名空间:左侧 **存储和数据库 → KV** → 创建命名空间(如 `app-version`),点进去复制命名空间 **ID**
4. **把 ID 填进 `wrangler.toml` 的 `[[kv_namespaces]]`**(替换 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`)后提交推送
   > ⚠️ 不要只在 Dashboard「设置 → 绑定」里加。本项目通过 Git 集成部署,每次部署会以 `wrangler.toml` 为准重建 Worker 配置,**只存在于 Dashboard 的绑定会在下次部署时被清掉**(页面报"未绑定 KV 存储"就是这个原因)。
5. **(必配)设置管理员密码** → 见下文「管理员与权限」
6. **(必配)设置定时检查令牌并在 GitHub 配置 Actions 密钥** → 见下文「定时检查(由 GitHub Actions 驱动)」
7. (可选)配置更新推送通知 → 见下文「通知推送配置」
8. (可选)绑定自定义域名:Worker **设置 → 域和路由** 添加 `app-version.kevinlidk.cn`

> 未绑定 KV 前访问页面会提示「未绑定 KV 存储」,按第 3~4 步补上即可。

### 方式二:本地 wrangler CLI

```bash
npm install
npx wrangler login
npx wrangler kv namespace create APP_KV
# 把命令输出的 id 填入 wrangler.toml,并取消 [[kv_namespaces]] 三行注释
npx wrangler deploy
```

## 管理员与权限

页面默认为**访客只读视图**:可以查看应用列表、版本与更新状态,不能做任何修改。

- 管理员通过**右上角「登录」**输入密码后,才能添加 / 编辑 / 删除应用及手动刷新版本
- 密码来自环境变量 **`ADMIN_PASSWORD`(必配)**:

```bash
npx wrangler secret put ADMIN_PASSWORD
# 或在 Dashboard → Worker「设置 → 变量和机密」中添加,类型选「机密」
```

- 未配置 `ADMIN_PASSWORD` 时,**所有编辑接口都会拒绝**(页面保持只读),不会放行
- 登录后会话保持 **7 天**(HttpOnly + Secure Cookie);「退出」立即失效
- 防爆破保护:同一 IP 连续输错 10 次密码,锁定 15 分钟
- 密码比较采用恒定时间比较(先 SHA-256 再逐字节异或),避免计时侧信道

## 定时检查(由 GitHub Actions 驱动)

定时检查由仓库内的 `.github/workflows/check-updates.yml` 驱动(**不使用 Cloudflare Cron Trigger**,以节省账号的 crons 名额)。workflow 每 6 小时(UTC 00:30 / 06:30 / 12:30 / 18:30)用 `curl` 调用 Worker 的 `POST /api/check`,也支持在 Actions 页面手动运行。

**配置步骤(两步)**

1. Worker 端设置令牌(与 `ADMIN_PASSWORD` 同级):

```bash
npx wrangler secret put CRON_SECRET
# 或 Dashboard → Worker「设置 → 变量和机密」添加 CRON_SECRET(选「机密」)
```

2. GitHub 仓库配置两个 Actions 密钥 →**Settings → Secrets and variables → Actions → New repository secret**:

| 名称 | 值 |
| --- | --- |
| `APP_VERSION_URL` | Worker 线上地址,如 `https://app-version.kevinlidk.cn` |
| `CRON_SECRET` | 与第 1 步相同的随机字符串 |

配好后可在 **Actions → Check app updates → Run workflow** 手动跑一次验证;成功时 job summary 会显示检查摘要(检查数 / 更新数 / 推送状态)。

**说明**
- 接口鉴权:`Authorization: Bearer <CRON_SECRET>`;未配置 `CRON_SECRET` 时该接口只接受管理员会话
- 并发保护:同名 workflow 有 `concurrency` 限制,服务端另有 5 分钟 KV 锁,重复触发会返回 `409`
- 手动触发(本地调试):

```bash
curl -X POST https://app-version.kevinlidk.cn/api/check -H "Authorization: Bearer $CRON_SECRET"
```

> 若日后 Cloudflare cron 名额空出、想改回平台定时任务:取消 `wrangler.toml` 中 `[triggers]` 的注释,并**停用本 workflow**,避免重复检查与重复推送。

## 通知推送配置

检查发现新版本后,把所有更新**聚合为一条消息**发送到已配置的渠道;每个应用可在编辑弹窗中单独关闭「推送通知」。

通过 Secret 或 Dashboard「设置 → 变量和机密」按需配置(可叠加多个渠道):

| 环境变量 | 必配 | 说明 |
| --- | --- | --- |
| `APP_KV`(KV 绑定) | ✅ | 应用列表存储。**必须写在 `wrangler.toml` 中**,否则每次部署会丢失 |
| `ADMIN_PASSWORD` | ✅ | 管理员密码,编辑类接口的登录凭据(见「管理员与权限」) |
| `CRON_SECRET` | ✅ | GitHub Actions 触发 `/api/check` 的令牌(见上一节) |
| `GITHUB_TOKEN` | 推荐 | 提升 GitHub API 速率限制(GitHub 渠道与 winget 渠道共用) |
| `FEISHU_WEBHOOK_URL` | 可选 | 飞书群自定义机器人 webhook 地址 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 可选 | Telegram Bot 发消息 |
| `BARK_URL` | 可选 | Bark(iOS)设备推送地址,如 `https://api.day.app/yourkey` |
| `SERVERCHAN_SENDKEY` | 可选 | Server酱 SendKey,微信端接收 |
| `NOTIFY_WEBHOOK_URL` | 可选 | 通用 webhook,POST `{title, text, apps[]}` JSON |

```bash
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put GITHUB_TOKEN   # 同时强烈建议配置,见下
```

> ⚠️ **建议配置 `GITHUB_TOKEN`**:GitHub 渠道与 winget 渠道都调用 GitHub API,未认证限额仅 60 次/小时/IP——Cloudflare Workers 出口 IP 为多租户共享,很容易触顶;配置后提升到 5000 次/小时。
>
> 推送语义:手动刷新过的版本视为已知悉,定时任务不会重复推送;全部渠道发送失败时保留标记,下个周期自动重试。

## 本地开发

```bash
npm install
npm run dev      # wrangler dev,地址 http://localhost:8787(需先配置 KV)
npm run serve    # 或用轻量预览服务器(KV 内存模拟,GitHub/Chocolatey 返回示例数据;
                 #   curl -X POST http://127.0.0.1:8799/__run-check 可手动触发一次定时检查)
npm test         # API + 定时推送冒烟测试(离线)
```

## API 一览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/session` | 公开 | 查询登录态与是否已配置密码 |
| POST | `/api/login` | 公开 | 管理员登录(种下会话 Cookie) |
| POST | `/api/logout` | 公开 | 退出登录并销毁会话 |
| GET | `/api/apps` | 公开 | 获取应用列表(访客只读) |
| POST | `/api/apps` | 管理员 | 新增应用 |
| PUT | `/api/apps/:id` | 管理员 | 更新应用 |
| DELETE | `/api/apps/:id` | 管理员 | 删除应用 |
| POST | `/api/apps/:id/refresh` | 管理员 | 查询最新版本(GitHub / Chocolatey / winget 渠道) |
| GET | `/api/apps/export` | 管理员 | 导出全部应用为 JSON 配置文件(附件下载) |
| POST | `/api/apps/import` | 管理员 | 导入配置文件,覆盖当前列表(接受 `{"apps":[…]}` 或裸数组,单次 ≤500 条) |
| POST | `/api/check` | `CRON_SECRET` 或管理员 | 立即执行一次更新检查并推送,返回 `{checked,updated,notified,updates[],errors[]}`(GitHub Actions 调用) |

应用记录示例:

```json
{
  "id": "7f3c…",
  "name": "VLC",
  "channel": "chocolatey",
  "packageId": "vlc",
  "version": "3.0.20",
  "notify": true,
  "latestVersion": "3.0.24",
  "releaseUrl": "https://community.chocolatey.org/packages/vlc",
  "publishedAt": "2026-09-23T03:15:35Z",
  "lastCheckedAt": "2026-11-02T00:00:00Z",
  "notifiedVersion": "3.0.24",
  "note": ""
}
```

## 许可

本项目仅供学习与交流使用。
