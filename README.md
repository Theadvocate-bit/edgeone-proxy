# EdgeOne 反向代理

基于腾讯云 EdgeOne 边缘函数的通用反向代理。零密钥、零构建，通过 `https://<你的域名>/proxy?url=<目标>` 代理任意 http/https 站点。

改造自 [Cloudflare-Workers-Proxy](https://github.com/ymyuuu/Cloudflare-Workers-Proxy)，重写以适配 EdgeOne Makers 的 Edge Runtime（V8），内置针对免费版「Powered by EdgeOne Pages」横幅的四层去水印策略。

## ✨ 特性

- **单文件自包含** — `functions/proxy.js` 一个文件搞定代理逻辑、提示页 HTML/CSS/JS、去水印策略，零外部依赖，不 `import`、不读盘、不拉 CDN。
- **无密钥** — 无需访问密码或 API Key，Fork 即可部署使用。
- **落地页 + 代理双职责** — `static/index.html` 是 Tailwind 现代化落地页（`/`），`functions/proxy.js` 是代理函数（`/proxy`）；输入目标网址后一键跳转，或直接复制代理后的完整链接分享。
- **完整 URL 改写** — 处理 `href`/`src`/`srcset`/`action`/`<base>`/`meta refresh`/CSS `url()`/`@import` 以及裸的源站字符串，避免代理页面出现混合内容或跳到源站。
- **去水印（4 层）** — CSS 强制隐藏 → 掐断 `body.appendChild/insertBefore` 通道 → `MutationObserver` 清理 → 源头剥离脚本；即使免费版末尾注入推广横幅，代理页面也能保持干净。
- **Cookie 按站点隔离** — 默认开启；代理多个站点时给 Cookie 名加站点前缀，防止不同被代理站点共用 Cookie 命名空间导致 session 串味（详见 `PROXY_COOKIE_ISOLATE`）。
- **可配置** — 白名单、固定 UA、入口路径、CPU 预算、响应体改写上限均可通过 Makers 控制台的 `context.env` 配置，无需改代码。
- **响应头清洗** — 剥离 `CSP`/`X-Frame-Options`/`COOP`/`COEP`/`CORP`/`STRICT-TRANSPORT-SECURITY` 等干扰代理的响应头；`Set-Cookie` 的 `Domain` 剥离、`Path` 归一。
- **重定向跟进** — 30x 状态下的 `Location` 头会自动重写为代理后的地址，浏览器不会跳回源站。
- **边缘加速** — 全球节点就近回源，低延迟；CPU 预算与响应体预算内做改写，超限即降级为流式透传（去水印无条件保留）。

## 🚀 部署（EdgeOne Makers 控制台）

1. **Fork 本仓库** 到你自己的 GitHub。
2. 打开 [EdgeOne 控制台](https://console.cloud.tencent.com/edgeone) → **Makers** → **新建应用**。
3. **关联 Git 仓库** — 授权腾讯云访问你的 GitHub，选择刚 Fork 的仓库。
4. **构建配置**：
   - 项目名称：自定义
   - 生产分支：`main`
   - 构建框架预设：`其他`
   - 构建命令：留空
   - 根目录：`./`
   - 输出目录：`static`
5. **调整目录**（只需做一次）：在 Fork 的仓库里把 `functions/proxy.js` 移到 `edge-functions/proxy.js` 后提交，入口路径 `/proxy`。
6. **保存并部署**，1 分钟内生效，平台会分配 `.edgeonepage.com` 免费域名。

Makers 直接把 `edge-functions/*.js` 编译为边缘函数，`static/` 作为静态资源回退，无需构建步骤。

### 为什么函数放 `/proxy` 而不是 `/`

EdgeOne Pages 的路由规则是「静态资源优先于 Edge Functions」。如果把代理函数放到 `/`，用户访问 `/?url=...` 时会先命中 `static/index.html` 落地页，代理永远不执行。所以本项目固定：

- `/` → `static/index.html`（Tailwind 落地页，输入目标网址后跳转到 `/proxy?url=...`）
- `/proxy` → `functions/proxy.js`（真正执行代理的边缘函数）

`functions/proxy.js` 内部不写死入口路径，链接一律按「当前请求自身的 `pathname`」生成，改名或迁移入口都无需改代码。

### EdgeOne Pages（备选）

如果只想用 Pages（`functions/` 目录约定），保留仓库原样即可：`functions/proxy.js` 会作为函数绑定到 `/proxy` 路径，`static/index.html` 作为静态落地页。Pages 优先服务静态文件，`?url=` 参数不会与 `static/index.html` 冲突。

## ⚙️ 环境变量（Makers 控制台配置，全部可选）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PROXY_HOSTS` | 目标域名白名单，逗号或空格分隔 | 留空 = 不限制 |
| `PROXY_UA` | 出站请求固定 `User-Agent`（反爬伪装） | 留空 = 透传访客 UA |
| `PROXY_PATH` | 固定入口路径（如 `/proxy`） | 留空 = 使用当前请求自身路径 |
| `PROXY_BUDGET_MS` | 单次 HTML 改写的 CPU 预算（毫秒） | `120`（平台硬限 200） |
| `PROXY_MAX_BYTES` | 参与改写的响应体上限字节数；超出直接流式透传 | `3145728`（3 MB） |
| `PROXY_COOKIE_ISOLATE` | 按站点隔离 Cookie（回源方向给 Cookie 名加站点前缀）；`0` 关闭 | `1`（开启） |

`PROXY_COOKIE_ISOLATE` 副作用：被代理页面的 JS 通过 `document.cookie` 读取「服务端下发」的 Cookie 时会看到带前缀的名字；JS 自己写的 Cookie 不带前缀、原样透传。遇到依赖 JS 读 Cookie 的站点（CSRF token 等），设 `0` 回到旧行为。

## 🔧 使用

1. **首页代理** — 访问你的域名，输入目标网址，点 **开始代理**（自动打开新标签页代理后的地址），或点 **复制连接** 把代理后的完整链接复制到剪贴板分享。
2. **URL 直链** — 直接把 `?url=<目标>` 拼在 `/proxy` 后面：
   - `https://<你的域名>/proxy?url=https://www.typescriptlang.org/`
3. `url` 参数必须放在最后，前面的路径会被视作入口。

## ⚙️ 工作原理

单文件 `functions/proxy.js` 按下面流程处理每个 `/proxy` 请求：

1. **解析入口** — 从请求自身的 `pathname` 或 `PROXY_PATH` 得到入口路径。
2. **提取目标** — 从 `?url=` 后取目标地址；缺失则返回用法提示。
3. **校验** — 拒绝非 `http(s)` 协议、拒绝代理自身、白名单不匹配。
4. **回源** — 用清洗后的请求头 fetch 目标地址，`redirect: manual` 保留 3xx 响应。
5. **改写**（预算内执行）：
   - HTML：`href`/`src`/`srcset`/`action`/`<base>`/`meta refresh`/CSS `url()`/裸源站字符串
   - CSS/JS/JSON：`url()`/`@import`/裸源站字符串
   - 剥离 `integrity` 属性（原站哈希对改写后的内容不匹配）
   - 剥离上游已内联的水印脚本和节点
6. **去水印** — 注入对策脚本（掐断 `appendChild`、`MutationObserver` 清理、CSS 隐藏），无条件执行。
7. **响应头清洗** — 移除代理场景下有害的头，`Set-Cookie` 剥离 `Domain`、`Path` 归一、多个 Cookie 拆分。
8. **重定向处理** — 3xx 状态下重写 `Location` 为代理地址。

两级预算控制：`PROXY_BUDGET_MS` 限 CPU 时间、`PROXY_MAX_BYTES` 限响应体大小。任一项超限即降级为流式透传，但去水印步骤永远保留。

## 📁 项目结构

```
edgeone-proxy/
├── functions/
│   └── proxy.js       # 单文件自包含代理（Makers 部署时移到 edge-functions/proxy.js）
├── static/
│   └── index.html     # Tailwind 现代化落地页（作为 / 的静态回退）
├── LICENSE
└── README.md
```

代码本身对部署目录无感：入口路径取自「当前请求自身的 `pathname`」，因此 `functions/proxy.js` 或 `edge-functions/proxy.js` 都工作。若改名 `index.js` 放到 `edge-functions/index.js`（入口 `/`），需要同时把 `static/index.html` 挪走，否则落地页会盖住函数。

## ⚠️ 免责声明

- 本项目仅供学习和研究使用，作者不对任何因使用本项目而导致的任何问题负责，包括但不限于数据丢失、服务中断、法律纠纷等。
- 使用者需了解，本项目可能被用于访问受限内容或进行未经授权的活动。作者强烈反对任何不当使用行为，并鼓励使用者在合法合规的前提下使用。
- 请确保你拥有对所代理目标地址的合法访问权限。
- 任何使用者在使用本项目时，需自行承担全部风险。作者和腾讯云不对任何滥用、不当使用或由此导致的任何损害承担责任。
- 去水印功能仅针对 EdgeOne 平台自身的免费版推广横幅，不应用于规避任何第三方网站的合理使用限制。

## 📄 许可证

[MIT](./LICENSE)
