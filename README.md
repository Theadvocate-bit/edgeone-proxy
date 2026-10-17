# EdgeOne 反向代理

基于腾讯云 EdgeOne 边缘函数的通用反向代理。单文件 `functions/proxy.js` 自包含部署，通过 `https://<你的域名>/proxy?url=<目标>` 代理任意 http/https 站点，无需访问密钥。

参考 [Cloudflare-Workers-Proxy](https://github.com/ymyuuu/Cloudflare-Workers-Proxy)。

## ✨ 特性

- **单文件自包含** — `functions/proxy.js` 一个文件搞定代理逻辑、提示页 HTML/CSS/JS；零外部依赖，不 `import`、不读盘、不拉 CDN。
- **无密钥** — 无需访问密码或 API Key，Fork 即可部署使用。
- **落地页 + 代理双职责** — `static/index.html` 是 Tailwind 现代化落地页（挂载到 `/`），`functions/proxy.js` 是代理函数（挂载到 `/proxy`）；输入目标网址后一键跳转，或直接复制代理后的完整链接分享。
- **完整 URL 改写** — 处理 `href`/`src`/`srcset`/`action`/`<base>`/`meta refresh`/CSS `url()`/`@import` 以及裸的源站字符串，避免代理页面出现混合内容或跳回源站。
- **Cookie 按站点隔离** — 默认开启；代理多个站点时给 Cookie 名加站点前缀，防止不同被代理站点共用 Cookie 命名空间导致 session 串味。
- **可配置** — 白名单、固定 UA、入口路径、CPU 预算、响应体改写上限均可通过 Makers 控制台的 `context.env` 配置，无需改代码。
- **响应头清洗** — 剥离 `CSP`/`X-Frame-Options`/`COOP`/`COEP`/`CORP`/`STRICT-TRANSPORT-SECURITY` 等干扰代理的响应头；`Set-Cookie` 的 `Domain` 剥离、`Path` 归一。
- **重定向跟进** — 30x 状态下的 `Location` 头会自动重写为代理后的地址，浏览器不会跳回源站。
- **边缘加速** — 全球节点就近回源，低延迟；CPU 预算与响应体预算内执行改写，任一超限即降级为流式透传。

## 🚀 部署（EdgeOne Makers）

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
5. **调整目录**（一次）：把 `functions/proxy.js` 移到 `edge-functions/proxy.js` 后提交，函数入口绑定到 `/proxy`。
6. **保存并部署**，1 分钟内生效，平台会分配 `.edgeonepage.com` 免费域名。

Makers 直接把 `edge-functions/*.js` 编译为边缘函数，`static/` 作为静态资源回退，无需构建步骤。

### 为什么函数挂 `/proxy` 而不是 `/`

EdgeOne Pages 的路由规则是「静态资源优先于 Edge Functions」。落地页 `static/index.html` 已占据 `/`，若函数也放 `/`，用户访问 `/?url=...` 会先命中静态页，代理永远不执行。因此本项目固定分工：

- `/` → `static/index.html`（Tailwind 落地页，构建跳转到 `/proxy?url=...` 的代理地址）
- `/proxy` → `edge-functions/proxy.js`（真正执行代理的边缘函数）

`static/index.html` 里 `PROXY_PATH = '/proxy'` 与函数入口一致；`functions/proxy.js` 内部不写死入口路径，链接一律按「当前请求自身的 `pathname`」生成，改名或迁移入口都无需改代码。

### EdgeOne Pages（备选）

保留仓库原样即可：`functions/proxy.js` 会作为函数绑定到 `/proxy` 路径，`static/index.html` 作为静态落地页。Pages 优先服务静态文件，`?url=` 参数不会与 `static/index.html` 冲突。

## ⚙️ 环境变量（Makers 控制台配置，全部可选）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PROXY_HOSTS` | 目标域名白名单，逗号或空格分隔 | 留空 = 不限制 |
| `PROXY_UA` | 出站请求固定 `User-Agent`（反爬伪装） | 留空 = 透传访客 UA |
| `PROXY_PATH` | 固定入口路径（如 `/proxy`） | 留空 = 使用当前请求自身路径 |
| `PROXY_BUDGET_MS` | 单次 HTML 改写的 CPU 预算（毫秒） | `120`（平台硬限 200） |
| `PROXY_MAX_BYTES` | 参与改写的响应体上限字节数；超出直接流式透传 | `3145728`（3 MB） |
| `PROXY_COOKIE_ISOLATE` | 按站点隔离 Cookie（回源方向给 Cookie 名加站点前缀） | 开启；显式设为 `0` / `false` / `off` / `no` 关闭 |

`PROXY_COOKIE_ISOLATE` 副作用：被代理页面的 JS 通过 `document.cookie` 读取「服务端下发」的 Cookie 时会看到带前缀的名字；JS 自己写的 Cookie 不带前缀、原样透传。遇到依赖 JS 读 Cookie 的站点（CSRF token 等），显式关闭即可。

## 🔧 使用

1. **落地页** — 访问你的域名，输入目标网址（`https://example.com` 或 `example.com`），点 **开始代理**（新标签页打开代理地址），或点 **复制代理链接** 把完整代理地址复制到剪贴板分享。
2. **URL 直链** — 直接把 `?url=<目标>` 拼在 `/proxy` 后面：
   - `https://<你的域名>/proxy?url=https://www.typescriptlang.org/`
3. `url` 参数必须放在最后，前面的路径会被视作入口。

## ⚙️ 工作原理

`functions/proxy.js` 按下面流程处理每个 `/proxy` 请求：

1. **解析入口** — 从请求自身的 `pathname` 或 `PROXY_PATH` 得到入口路径。
2. **提取目标** — 从 `?url=` 后取目标地址；缺失则返回用法提示。
3. **校验** — 拒绝非 `http(s)` 协议、拒绝代理自身、白名单不匹配。
4. **回源** — 用清洗后的请求头 fetch 目标地址，`redirect: manual` 保留 3xx 响应。
5. **改写**（预算内执行）：
   - HTML：`href`/`src`/`srcset`/`action`/`<base>`/`meta refresh`/CSS `url()`/裸源站字符串
   - CSS/JS/JSON：`url()`/`@import`/裸源站字符串
   - 剥离 `integrity` 属性（原站哈希对改写后的内容不匹配）
6. **响应头清洗** — 移除代理场景下有害的头，`Set-Cookie` 剥离 `Domain`、`Path` 归一、多个 Cookie 拆分，并按需加站点前缀。
7. **重定向处理** — 3xx 状态下重写 `Location` 为代理地址。

两级预算控制：`PROXY_BUDGET_MS` 限 CPU 时间、`PROXY_MAX_BYTES` 限响应体大小。任一项超限即降级为流式透传。

## 📁 项目结构

```
edgeone-proxy/
├── functions/
│   └── proxy.js       # 单文件自包含代理（Makers 部署时移到 edge-functions/proxy.js）
├── static/
│   └── index.html     # Tailwind 落地页（挂载到 /）
├── LICENSE
└── README.md
```

`functions/proxy.js` 对部署目录无感：入口路径取自「当前请求自身的 `pathname`」，因此 `functions/proxy.js`（Pages）或 `edge-functions/proxy.js`（Makers）都工作。若把函数改名为 `index.js` 挂到 `/`，需要同步移除 `static/index.html`，否则静态页会盖住函数。

## ⚠️ 免责声明

- 本项目仅供学习和研究使用，作者不对任何因使用本项目而导致的任何问题负责，包括但不限于数据丢失、服务中断、法律纠纷等。
- 使用者需了解，本项目可能被用于访问受限内容或进行未经授权的活动。作者强烈反对任何不当使用行为，并鼓励使用者在合法合规的前提下使用。
- 请确保你拥有对所代理目标地址的合法访问权限。
- 任何使用者在使用本项目时，需自行承担全部风险。作者和腾讯云不对任何滥用、不当使用或由此导致的任何损害承担责任。

## 📄 许可证

[MIT](./LICENSE)
