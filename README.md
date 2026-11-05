# AppVersion · 应用版本检测

> **线上地址:<https://appversion.kevinlidk.cn>**

一个部署在 **Cloudflare Workers** 上的轻量「应用版本检测」Web 解决方案:集中管理你关注的应用,一键查询它们的最新版本,有可用更新时自动推送通知,并对手机端访问做了专门的自适应优化。

## 功能特性

- ✅ **应用管理** —— 添加 / 编辑 / 删除关注的应用(名称、版本来源、当前版本、备注)
- ✅ **多渠道版本查询** ——
  - **GitHub Releases**:自动拉取最新正式版,无 latest 时回退最近一条 Release;tag 常见的 `v` 前缀会被自动剥离(`v1.2.3` 存为 `1.2.3`),与手动填写的纯版本号保持一致
  - **Chocolatey 社区源**:优先读 `/api/v2/package/{id}` 的 302 重定向(约 165 字节,从 nupkg 文件名取版本),失败时回退 OData 查询
  - **winget 官方源**:查询 `microsoft/winget-pkgs` 清单仓库(即 winget 的官方数据源)
  - **官方自查(自定义 API)**:填入厂商公开的版本 API 地址 + 版本字段路径,直接读取最新版本号。适用于 Chrome、.NET 这类提供结构化版本数据但没有标准 Release 接口的应用
  - **手动维护**:官网无查询途径的应用直接手动记录版本号
  - **⇄ Chocolatey → winget 一键转换**:Chocolatey 应用卡片上提供转换按钮。若 Chocolatey 被 Cloudflare WAF 拦截(见下方说明),可一键改用它对应的 winget 包
    - 自动在 `microsoft/winget-pkgs` 中搜索候选(应用名 / 包 ID 代码搜索 + 由官网域名推导的启发式 ID)
    - 候选会**逐个校验是否真实存在于清单仓库**,只列出可用的包并显示其最新版本
    - 若没有候选(或想用别的包),**可直接在弹窗里手动输入 winget 包 ID**(如 `VideoLAN.VLC`),输入格式合法时「转换」按钮自动变为可用
    - 输入框下方提供 **「在 winget 仓库中查找包 ID ↗」** 链接,直达 `microsoft/winget-pkgs/manifests` 目录便于按发布者查找
    - 选中后立即切换渠道并拉取版本;旧渠道的查询缓存与推送标记会自动清空
    - 需要 `GITHUB_TOKEN` 具备只读 Contents 权限(代码搜索接口要求)

> ⚠️ **关于 Chocolatey 渠道的重要说明**
> `community.chocolatey.org` 本身托管在 **Cloudflare** 上(解析到 104.18.x.x)。Cloudflare Workers 的出口 IP 访问它时,容易被其 WAF 判定为异常并返回 **403** —— 这是**同网络内互相识别**导致,Worker 无法绕过(更换域名、换端点、改 UA 都无效)。
> 已在代码层做到:按「302 重定向 → OData → FindPackagesById」三个端点依次降级尝试(某些环境能命中其一);若全部失败,会在错误提示与诊断面板中明确指出,并建议改用 winget 渠道。
> **推荐做法**:新应用优先用 winget 渠道(数据源同为官方清单,且走 GitHub API,不受此限制);已有的 Chocolatey 应用可用「⇄ 转 winget」一键迁移。
- ✅ **更新推送通知** —— GitHub Actions 定时触发检查(不占用 Cloudflare Cron 名额),发现新版本时聚合一条消息推送(支持飞书 / Telegram / Bark / Server酱 / 通用 webhook,可同时配置多个);**推送需在应用表单中主动勾选(默认关闭)**,支持去重防骚扰
- ✅ **更新提醒** —— 最新版本号以绿色显示;与当前版本不一致时卡片高亮「有新版本」,支持一键「已更新」标记
- 🗂 **分组与自由排列** —— 参考 Uptime Kuma 的编辑逻辑(点「✎ 编辑布局」进入编辑模式):
  - **可新建 / 重命名 / 删除分组**(新建与重命名使用站内样式化弹窗);删除分组时组内应用自动移到「未分组」,不会丢失
  - **卡片可归入任意分组**,并可**在组内调整显示顺序**
  - **分组顺序可自由调整**
  - **分组支持折叠 / 展开**,点击组名左侧的大号箭头即可;**折叠状态保存在本地浏览器**(localStorage) —— 每个访问者各自独立,互不影响,访客也能自由折叠,无需登录
  - 操作方式:
    - **桌面端鼠标拖拽** —— 卡片可跨组拖动;拖动组标题左侧 ⠿ 调整组顺序;**拖到已折叠分组的标题上**会移入该组并自动展开
    - **手机端触屏拖拽** —— 从卡片/分组的手柄按住拖动即可,移动超过 8px 进入拖拽(不会误触发页面滚动)
    - **辅助操作** —— 卡片上的分组下拉 + ↑/↓ 按钮;分组标题上的 ↑/↓ 按钮
  - 布局保存在 Cloudflare KV,并随导出的配置文件一起备份
  - 未创建任何分组时不显示「未分组」标题,保持纯卡片观感
- 🔎 **一键筛选待更新** —— 顶部统计里的「N 个有更新」是**可点击按钮**,点击后只显示需要更新的应用(再次点击或按 ✕ 取消),可与搜索、渠道筛选叠加
- 🌐 **中英双语界面** —— 右上角 🌐 按钮在 深浅色 与 GitHub 图标之间,点击即切换 中文 / English 并存 `localStorage.av_lang`(默认中文)。覆盖顶栏、筛选、统计、卡片、分组、全部弹窗、提示与诊断面板;应用名/备注等**用户数据不翻译**,服务端返回的错误消息保持原样
- 🔴 **「有新版本」红色应用名** —— 卡片出现「有新版本」徽章时,应用名与徽章同色(红色,和呼吸红点一致);更新后恢复常规颜色
- 🔴 **标签页角标** —— 有可更新应用时,浏览器标签页图标左下角显示待更新数量(红底白字,超过 99 显示 `99+`);切到别的标签页也能一眼看到。数量归零后自动还原为原始图标
- ⏱ **检查时间自动走动 & 后台静默同步** —— 卡片上的「检查于」显示为相对时间(`刚刚` / `N 分钟前` / `N 小时前`,悬停可看精确时刻),页面每 30 秒自动重算;每 60 秒还会**静默拉取一次服务端数据**,把 GitHub Actions 定时检查的结果同步到界面,无需手动点刷新。拖拽中、弹窗打开、编辑布局或正在输入时会自动跳过,不打断操作;从其他标签页切回来时也会立即同步一次
- 🎁 **开箱示例** —— 首次访问自动内置「Google Chrome」示例应用(Chocolatey 渠道,可自动查询);登录后可编辑或删除,清空后不会重复注入
- 🖼 **应用图标** —— 按优先级自动匹配:
  1. 表单里手填的「图标地址」(自定义)
     - 支持完整 `https://` 图片地址
     - **也支持粘贴 Iconify 图标名简写**(如 `thesvg-color:vlc-media-player`),失焦时自动补全为 `https://api.iconify.design/{集}/{名}.svg`
     - 图标名下方提供 [icon-sets.iconify.design](https://icon-sets.iconify.design/) 与 [yesicon.app](https://yesicon.app/) 快捷搜索入口(新标签页打开)
  2. **按应用名称在多个 Iconify 图标集中级联匹配**(数据源与 [icon-sets.iconify.design](https://icon-sets.iconify.design/) / [yesicon.app](https://yesicon.app/) 同源,无需本地存储):
     - `selfhst` —— 自托管应用图标集,7000+ 全彩图标,覆盖最广
     - `logos` —— 品牌 logo 集,多色渐变
     - `thesvg-color` —— 彩色 SVG 集,补齐 selfhst 未收录的应用(如 VLC)
     - `cib` —— 单色品牌图标,自动着色兜底
  3. GitHub 渠道取仓库所有者头像;Chocolatey 渠道取包图标
  - 名称自动转 kebab-case 匹配(`Google Chrome` → `google-chrome`),并支持去掉通用后缀(`Telegram Desktop` → `telegram`);不会过度收缩(避免 `Microsoft .NET` 误匹配成 `microsoft`)
  - **并行探测**全部候选后只渲染命中的那个,不会出现长时间破图
  - 全部匹配不到时,回退为**名称英文缩写**的彩色字母图标(如 `GC`、`7Z`;中文取首字),底色按名称稳定生成
- 🔗 **官网链接与下载** —— 每个应用可填写「应用官网地址」与「最新版本下载地址」:
  - 勾选「把应用名显示为可点击链接」后,首页卡片上的应用名变为链接,点击在新标签页打开官网
  - 卡片右下角显示**下载图标**;有多个安装包时,**鼠标悬停(或点击)图标会展开候选列表**,按分数排序,点选即下载对应文件
    - **GitHub Releases 与 winget 两个渠道都支持**:winget 会读取清单里的 `installer.yaml`,解析出各架构的真实下载地址;GitHub 则解析 Release 资产(官方为其计算的 `digest` 摘要同样展示)
    - 列表项带类型徽标(`EXE`/`MSI`/`DMG`…)与架构标签(`x64`/`arm`/`x86`),排名第一的选项高亮
    - winget 候选项下方显示**校验值文本框**:`ProductCode` 优先(两者都有时只显示它),否则显示 `SHA-256`,右上角复制图标可一键复制完整值
    - winget 候选排序:`x64` > `arm64` > `x86`;同架构内 `EXE` > `MSI` > `MSIX` > `ZIP`
    - 自动写入的下载地址**不会覆盖你手动填写的地址**(手动填过则保持不变)
  - 表单内的「自动检测」按钮可按渠道自动推导地址(GitHub 取仓库主页 + Release 安装包资产;Chocolatey/winget 取包页面)
    - 安装包选取优先级:**`x64.exe` → `x64.msi` → 其他 `exe` → 其他 `msi` → 其他平台安装包**(`msix`/`dmg`/`pkg`/`deb`/`rpm`/`AppImage`)
    - 自动识别架构:`x64`/`win64`/`amd64`/`x86_64`/`64bit` 视为 64 位;`arm64`/`aarch64` 与 32 位构建降级选用
    - 签名、校验和、源码包、调试符号等非安装文件会被跳过;找不到合适资产时回退到 Release 页面链接
- 🔐 **管理员登录** —— 右上角登录后才能添加/编辑/删除/刷新监控应用;访客默认只读,仅可查看页面信息
- 📤 **配置导入 / 导出** —— 管理员可一键把全部关注应用与分组导出为 JSON 配置文件备份,或导入配置文件恢复/迁移(导入覆盖当前列表,操作前有确认提示)
  - 导出格式为 v2(含 `groups`);**导入 v1 旧备份(无 `groups` 字段)不会清空现有分组**
- 🩺 **配置检查面板** —— 编辑模式下点「配置检查」,一眼看清各项配置是否真的生效:
  - KV 绑定、管理员密码、定时检查令牌、GitHub 令牌、各通知渠道、应用/分组数量
  - **实时查验 GitHub 令牌**:用 `rate_limit` 返回的额度反推令牌是否被认可(认证 5000/小时 vs 匿名 60/小时),能识别「已设置但已过期/填错」这种**静默降级**情况
  - 按结果给出分级建议(正常 / 提醒 / 错误)与额度重置时间;令牌只显示长度,不泄露明文
- ✅ **批量刷新** —— 一键刷新全部自动渠道应用,逐一显示进度
- ✅ **搜索筛选** —— 按名称 / 仓库 / 包 ID / 备注搜索,按渠道筛选
- 🎨 **动态背景** —— GlyphWind WebGL2 字形流背景(`public/background/` 套件),画布位于内容之下且不拦截点击
- 🌗 **浅色 / 深色显示切换** —— 右上角图标一键切换(**默认浅色**),选择记入 localStorage,刷新后保持:
  - **两套完整 UI 配色**(不是只换底色):卡片、顶栏、搜索框、输入框、下拉、弹窗、下载菜单、滚动条、轻提示全部随主题切换
  - 浅色:页面底 `#f4f6fb`,卡片/顶栏 `#fff`
  - 深色:页面底 `#333` + 白色薄雾层,卡片/顶栏 `#3d4148`,输入框 `#2f3237`,文字 `#e8eaee`,滚动条深灰
  - 两种主题下**背景动画参数完全一致**,仅切换画布底色与字形墨色
  - 支持 `?seed=123&look=mixed|lettered|figured` 切换背景图案
- 📱 **移动端优先** —— 响应式布局(适配 360px~430px 常见手机屏宽)、大号点击区域、刘海屏安全区适配、窄屏自动收紧工具栏与筛选标签;**触屏可拖拽排序**
- ♿ **可访问性** —— 弹窗打开时自动聚焦首个控件、关闭后焦点返回触发元素、Tab 键在弹窗内循环;关键操作按钮均带 `aria-label`

> 💡 **关于 UniGetUI**:它本身只提供本机 IPC/CLI 接口,没有公开的 Web 版本查询 API;本项目的 Chocolatey / winget 渠道直接对接它背后聚合的官方数据源,效果等同且可在云端运行。

## 技术栈与项目结构

原生 HTML / CSS / JavaScript,无前端框架;后端为 Cloudflare Worker + KV,零依赖(除 wrangler 工具链)。

```
├── src/worker.js        # Worker:REST API、多渠道版本查询、检查与通知推送
├── scripts/
│   ├── build-config.mjs # 部署前注入 KV_NAMESPACE_ID,生成 wrangler.generated.toml
│   └── make-app-icon.py # 生成桌面版图标 desktop/app-icon.png(1024×1024)
├── desktop/
│   └── app-icon.png     # Pake/Tauri 打包用图标
├── public/index.html    # 前端单页(Workers Static Assets 承载)
├── public/background/   # GlyphWind 动态背景套件(WebGL2,装饰性)
├── public/favicon.svg   # 站点图标(另有 favicon.ico / apple-touch-icon.png / icon-192.png)
├── .github/workflows/   # check-updates.yml:定时触发 /api/check
│                        # build-pake.yml:三平台构建桌面版并发布 Releases
├── wrangler.toml        # Cloudflare Workers 基础配置(assets / 说明)
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
3. 创建 KV 命名空间:左侧 **存储和数据库 → KV** → 创建命名空间(如 `app-version`),点进去复制命名空间 **ID**(32 位十六进制)
4. **配置 KV 命名空间 ID(通过环境变量,不用改代码)**
   - Cloudflare 侧:**Worker → 设置 → 构建 → 变量和密钥**,添加 `KV_NAMESPACE_ID` = 你的命名空间 ID
   - 同时把 **部署命令(Deploy command)** 改为 `npm run deploy`
   - 原理:`wrangler.toml` 不支持 `${VAR}` 插值,所以部署前由 `scripts/build-config.mjs` 读取该环境变量,生成带绑定的 `wrangler.generated.toml` 再部署——**每次重新部署都会自动重建绑定**,不会像手工 Dashboard 绑定那样被覆盖丢失
5. **(必配)设置管理员密码** → 见下文「管理员与权限」
6. **(必配)设置定时检查令牌并在 GitHub 配置 Actions 密钥** → 见下文「定时检查(由 GitHub Actions 驱动)」
7. (可选)配置更新推送通知 → 见下文「通知推送配置」
8. (可选)绑定自定义域名:Worker **设置 → 域和路由** 添加 `appversion.kevinlidk.cn`

> 未绑定 KV 前访问页面会提示「未绑定 KV 存储」,按第 3~4 步补上即可。

### 方式二:本地 wrangler CLI

```bash
npm install
npx wrangler login
```

在项目根目录创建 `.dev.vars`(已 gitignore),写入命名空间 ID:

```ini
KV_NAMESPACE_ID=你的32位命名空间ID
```

然后:

```bash
npm run deploy   # 自动注入 KV 绑定并部署
npm run dev      # 本地开发(同样先注入)
```

> 首次需要创建命名空间:`npx wrangler kv namespace create APP_KV`,命令会输出 ID。

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
| `APP_VERSION_URL` | Worker 线上地址,如 `https://appversion.kevinlidk.cn` |
| `CRON_SECRET` | 与第 1 步相同的随机字符串 |

配好后可在 **Actions → Check app updates → Run workflow** 手动跑一次验证;成功时 job summary 会显示检查摘要(检查数 / 更新数 / 推送状态)。

**说明**
- 接口鉴权:`Authorization: Bearer <CRON_SECRET>`;未配置 `CRON_SECRET` 时该接口只接受管理员会话
- 并发保护:同名 workflow 有 `concurrency` 限制,服务端另有 5 分钟 KV 锁,重复触发会返回 `409`
- 手动触发(本地调试):

```bash
curl -X POST https://appversion.kevinlidk.cn/api/check -H "Authorization: Bearer $CRON_SECRET"
```

> 若日后 Cloudflare cron 名额空出、想改回平台定时任务:取消 `wrangler.toml` 中 `[triggers]` 的注释,并**停用本 workflow**,避免重复检查与重复推送。

## 通知推送配置

检查发现新版本后,把所有更新**聚合为一条消息**发送到已配置的渠道;每个应用可在编辑弹窗中单独关闭「推送通知」。

通过 Secret 或 Dashboard「设置 → 变量和机密」按需配置(可叠加多个渠道):

| 环境变量 | 必配 | 说明 |
| --- | --- | --- |
| `APP_KV`(KV 绑定) | ✅ | 应用列表存储。由环境变量 `KV_NAMESPACE_ID` 在部署前注入,无需手改配置 |
| `ADMIN_PASSWORD` | ✅ | 管理员密码,编辑类接口的登录凭据(见「管理员与权限」) |
| `CRON_SECRET` | ✅ | GitHub Actions 触发 `/api/check` 的令牌(见上一节) |
| `GITHUB_TOKEN` | **强烈建议** | GitHub Personal Access Token,**只需 `public_repo`(Classic)或 Contents: Read-only(Fine-grained)只读权限**,创建步骤见下文。GitHub 与 winget 渠道共用;Worker 出口 IP 是多租户共享的,匿名额度(60 次/小时)**极易被其他租户耗尽**而导致刷新失败,配置后为 5000 次/小时 |
| `FEISHU_WEBHOOK_URL` | 可选 | 飞书群自定义机器人 webhook 地址 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 可选 | Telegram Bot 发消息 |
| `BARK_URL` | 可选 | Bark(iOS)设备推送地址,如 `https://api.day.app/yourkey` |
| `SERVERCHAN_SENDKEY` | 可选 | Server酱 SendKey,微信端接收 |
| `NOTIFY_WEBHOOK_URL` | 可选 | 通用 webhook,POST `{title, text, apps[]}` JSON |

```bash
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put GITHUB_TOKEN   # 同时强烈建议配置,见下
```

> ⚠️ **必须配置 `GITHUB_TOKEN`**:GitHub 渠道与 winget 渠道都调用 GitHub API,未认证限额仅 60 次/小时/IP——Cloudflare Workers 出口 IP 为多租户共享,实测会被其他租户直接耗尽(额度 0/60),表现为"GitHub API 速率受限"。配置后提升到 5000 次/小时。

### 如何创建 `GITHUB_TOKEN`(含所需权限)

本项目只**读取公开仓库**的 Release 与清单文件,因此采用 **Fine-grained token(推荐)或 Classic token** 均可,权限要求都极低。

**方式 A:Fine-grained personal access token(推荐,权限更小)**

1. GitHub → 右上角头像 → **Settings** → 左栏最底 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. 填写:
   - **Token name**:如 `app-version-worker`
   - **Expiration**:按需选择(建议 90 天,到期前更换)
   - **Repository access**:选 **Public Repositories (read-only)**
     > 这样即可覆盖任意公开仓库的 GitHub 渠道;若只关注自己的私有仓库,则选 **Only select repositories** 并勾上对应仓库
3. **Permissions** —— ⚠️ 注意页面有**两个不同的分组**,本项目只需要改 **Repository permissions**:
   - 找到 **Repository permissions**(仓库权限,在下半部分,列表含 Actions / Administration / Checks / Contents …)
   - 只改一项:**`Contents` → `Read-only`**
     > 读取 Releases 与仓库目录(winget 渠道)都属于这一项,没有单独的 "Releases" 权限。
   - `Metadata` 会自动被设为 `Read-only`,这是 GitHub 的强制要求,正常现象
   - 其余全部保持 `No access`
   - **`Account permissions`(账号权限)分组保持 0 项,不要添加任何权限** —— 那类权限与本项目无关
4. 点击 **Generate token**
5. 复制以 `github_pat_` 开头的令牌(只显示一次)

**方式 B:Classic personal access token(兼容性最好)**

1. 同上路径进入 **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**
2. **Scopes** 勾选:
   - ✅ **`public_repo`** —— 读取公开仓库信息(本项目所需的最小范围)
   - 仅关注私有仓库时,改为勾选 **`repo`**(范围更大,注意风险)
3. **不要**勾选 `admin:*` / `delete_repo` / `workflow` 等任何其他权限
4. 复制以 `ghp_` 开头的令牌

> 🔐 说明与建议
> - 本项目只做**只读**查询,不会写入、提交或修改任何 GitHub 内容;不配置也能跑,但会被匿名限额(60 次/小时)卡住。
> - 令牌请只存到 **Worker 的 Secret**(`npx wrangler secret put GITHUB_TOKEN` 或 Dashboard「变量和机密」),**不要**写进代码、`wrangler.toml` 或提交到仓库。
> - GitHub Actions 的定时任务用的是仓库内置 `GITHUB_TOKEN`(由 workflow 自动提供),**与此处无关、无需额外配置**。
> - 令牌会过期:到期后刷新会重新出现"GitHub API 速率受限",届时重新生成并更新 Secret 即可。

> 推送语义:定时检查会覆盖**全部自动渠道应用**(让页面版本与检查时间始终新鲜),而「发现新版本时推送通知」只决定**是否推送**——未勾选(默认)的应用照常更新版本、但不会发消息;手动刷新过的版本视为已知悉,不会重复推送;全部渠道发送失败时保留标记,下个周期自动重试。

## 官方自查渠道(自定义版本 API)

适用于厂商提供公开版本接口、但没有标准 Release 的应用。添加应用时选择「官方自查(自定义 API)」,填两个字段:

| 字段 | 说明 |
| --- | --- |
| 官方 API 地址 | 必须是 **https** 公网地址(内网/本机地址会被拒绝) |
| 版本字段路径 | 从该 JSON 中取版本号的路径 |

**字段路径语法**

- `releases.0.version` —— 逐层取键;纯数字片段表示数组下标
- `releases-index[channel-version=10.0].latest-release` —— 方括号内为过滤条件:`字段=值`,在该数组中找到首个匹配元素后继续取值

**现成示例**

| 应用 | API 地址 | 字段路径 |
| --- | --- | --- |
| Google Chrome(win64 stable) | `https://gcvh.kevinlidk.cn/v1/chrome/platforms/win64/channels/stable/versions/all/releases?filter=fraction=1&pageSize=1` | `releases.0.version` |
| Microsoft .NET 10.0 | `https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json` | `releases-index[channel-version=10.0].latest-release` |

> 💡 Chrome 那个接口默认返回 1300+ 条记录(约 470 KB)。追加 **`&pageSize=1`** 后只返回 1 条(约 380 字节),是推荐写法。
>
> 响应上限 5 MB;超过会提示改用分页/精简地址。非 JSON 响应或路径取不到值都会给出明确错误提示。

## 本地开发

```bash
npm install
npm run dev      # 注入 KV 后启动 wrangler dev,地址 http://localhost:8787(需 .dev.vars 中有 KV_NAMESPACE_ID)
npm run serve    # 或用轻量预览服务器(KV 内存模拟,GitHub/Chocolatey 返回示例数据;
                 #   curl -X POST http://127.0.0.1:8799/__run-check 可手动触发一次定时检查)
npm test         # API + 定时推送冒烟测试(离线,69 项)
```

> 本地预览也可传入真实环境变量以验证完整链路,例如:
> `GITHUB_TOKEN=xxx FEISHU_WEBHOOK_URL=https://… npm run serve`
> (支持 `GITHUB_TOKEN` / `FEISHU_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_URL` / `SERVERCHAN_SENDKEY`)

## 桌面版(GitHub Actions 在线构建)

用 [Pake](https://github.com/tw93/Pake)(基于 Tauri)把网页封装成原生桌面应用,**全程在 GitHub Actions 上构建,本地不需要安装 Rust、Visual Studio 或 macOS 设备**。

**下载安装包**:[Releases](https://github.com/Kevinlidk/AppVersion/releases) 页面

| 平台 | 文件 | 安装方式 |
| --- | --- | --- |
| Windows 10/11 (x64) | `AppVersion-<版本>-windows-x64.msi` | 双击安装 |
| macOS (Apple Silicon) | `AppVersion-<版本>-macos-arm64.dmg` | 拖入「应用程序」;首次打开需右键 → 打开 |
| Linux (Debian/Ubuntu x64) | `AppVersion-<版本>-linux-x64.deb` | `sudo apt install ./AppVersion-*.deb` |

**重新构建**([.github/workflows/build-pake.yml](.github/workflows/build-pake.yml)):

1. **手动**:仓库 Actions → `Build Desktop App (Pake)` → Run workflow,可填版本号(如 `1.0.1`)
2. **打标签**:`git tag v1.0.1 && git push origin v1.0.1` —— 自动用 tag 号作为版本
3. **定时**:workflow 里已附 weekly cron,取消注释即可每周自动构建

三个平台并行构建(约 10–15 分钟,有缓存后约 5 分钟),全部成功后由 `release` job 聚合成一个 Release。

**自定义**:修改 workflow 顶部的 `APP_URL` / `APP_NAME` / `APP_IDENTIFIER` 即可换目标站点;图标为 `desktop/app-icon.png`(1024×1024,由 `scripts/make-app-icon.py` 从 `public/favicon.svg` 的几何结构生成,改了图标重跑该脚本即可)。

> 打包应用访问的仍是线上地址,内容与服务端更新即时生效,无需重新打包;只有**图标、窗口尺寸、应用名**这类外壳变化才需要重新构建。
> 构建产物不受本项目的 MIT 式许可约束的部分(Pake/Tauri 运行时)遵循其各自许可。

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
| GET | `/api/apps/export` | 管理员 | 导出全部应用 + 分组为 JSON 配置文件(附件下载) |
| POST | `/api/apps/import` | 管理员 | 导入配置文件,覆盖当前列表与分组(单次 ≤500 条应用 / ≤200 个分组;v1 备份不清空分组) |
| POST | `/api/apps/detect-links` | 管理员 | 按渠道自动推导官网与下载地址,返回 `{appUrl,downloadUrl,downloads,source}` |
| POST | `/api/apps/:id/convert-to-winget` | 管理员 | Chocolatey → winget 转换:不带 `packageId` 返回候选列表,带上则校验并切换渠道 |
| GET | `/api/diagnostics` | 管理员 | 配置诊断:各项密钥/绑定状态 + GitHub 实时额度 + 分级建议 |
| GET | `/api/groups` | 公开 | 获取分组列表 |
| POST | `/api/groups` | 管理员 | 新建分组 |
| PUT | `/api/groups/:id` | 管理员 | 重命名 / 折叠状态 / 顺序 |
| DELETE | `/api/groups/:id` | 管理员 | 删除分组(组内应用回到未分组) |
| PUT | `/api/layout` | 管理员 | 一次性保存分组顺序 + 各应用的归属与组内顺序 |
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
  "groupId": "a1b2…",
  "order": 0,
  "appUrl": "https://www.videolan.org/vlc/",
  "linkName": true,
  "downloadUrl": "https://github.com/videolan/vlc/releases/download/3.0.24/vlc-3.0.24-win64.exe",
  "downloads": [
    { "name": "vlc-3.0.24-win64.exe", "url": "https://…/vlc-3.0.24-win64.exe", "score": 100, "kind": "exe", "arch": "x64", "sha256": "…", "productCode": "{…}" },
    { "name": "vlc-3.0.24-win64.msi", "url": "https://…/vlc-3.0.24-win64.msi", "score": 95, "kind": "msi", "arch": "x64" }
  ],
  "iconUrl": "",
  "latestVersion": "3.0.24",
  "releaseUrl": "https://community.chocolatey.org/packages/vlc",
  "publishedAt": "2026-09-23T03:15:35Z",
  "lastCheckedAt": "2026-11-02T00:00:00Z",
  "notifiedVersion": "3.0.24",
  "note": ""
}
```

> 字段说明:`groupId` 为 `null` 表示未分组;`order` 是同组内显示顺序;`downloads` 为自动检测生成的候选安装包列表(按 `score` 降序),仅用于渲染下载菜单;校验值:winget 渠道的候选附带 `sha256` / `productCode`(来自该版本 `installer.yaml` 的 `InstallerSha256` / `ProductCode`),GitHub 渠道的候选附带 `sha256`(来自 GitHub 为资产计算的 `digest` 摘要),均仅保留合法值。下载菜单中每个候选会在文件名下方显示校验值——`ProductCode` 优先于 `SHA-256`,文本框右上角有复制按钮可一键复制完整值;`linkName` 开启后卡片应用名可点击跳转 `appUrl`;`iconUrl` 留空则自动匹配图标。

分组记录示例:

```json
{ "id": "a1b2…", "name": "浏览器", "order": 0, "collapsed": false, "createdAt": "2026-11-02T00:00:00Z" }
```

> `collapsed` 字段仅为向后兼容保留;**实际折叠状态存在各访客的 localStorage 中**(`av_collapsed`),不随服务端同步。

## 许可

本项目仅供学习与交流使用。
