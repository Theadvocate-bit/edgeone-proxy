// =============================================================
// EdgeOne Makers 边缘函数（Edge Runtime / V8）：网页反向代理
//   无访问密钥 · 去平台推广水印 · 一键复制代理链接
//
// ── 单文件自包含（全部内容都在这一个 proxy.js 里）───────────
//   · 边缘函数逻辑、落地页/提示页的 HTML、样式(CSS)、交互脚本(JS)、去水印策略，
//     全部写在本文中；不 import 任何模块，不读磁盘，不依赖外部样式表/脚本/图标。
//   · 部署（文件名即路由，本项目用第二种）：
//        项目根/index.html               →  /       静态首页（Tailwind 那版）
//        edge-functions/proxy.js         →  /proxy  ← 当前部署方式，代理入口
//        edge-functions/[[default]].js   →  任意未匹配路径（想让整站都归它接管时用）
//     关键：EdgeOne Pages 是「静态资源优先于 Edge Functions」，同一路径撞车时静态资源先回。
//     所以首页交给 index.html，函数必须待在 /proxy —— 若函数放到 /，/?url=… 会被静态首页
//     截走，代理永远不执行。
//     代码不写死入口路径：链接一律按「当前请求自己的路径」生成，因此上面几种放法都自洽。
//
// ── 平台适配（EdgeOne Makers · Edge Functions）──────────────
// 1) 入口：export default function onRequest(context)（同时保留具名导出，两种约定都能挂上）。
// 2) 运行时是 V8（不是 Node）：只用 Web 标准 API，不 import 任何包，不读 Node 的进程环境变量，
//    配置全部走 context.env（Makers 控制台 → 环境变量）。
// 3) 该运行时要求用普通对象 / [键,值] 数组作为 HeadersInit，因此本文件不构造 Headers 实例。
// 4) 资源限制：CPU 200ms / 请求体 1MB / 代码包 5MB。为此：正则模块级预编译、大文本先做
//    indexOf 快速判定、HTML 改写超预算即降级——但「去水印」始终执行，绝不打折。
// 5) 免费版会在 HTML 响应末尾注入推广横幅，且自带「删了就再插」的观察器。
//    对策四层：CSS 强制隐藏 → 掐断 body 插入通道 → 观察器清理残余 → 源头剥离。
//
// ── 环境变量（全部可选，均在 Makers 控制台配置）─────────────
//   PROXY_HOSTS      目标域名白名单，逗号或空格分隔；留空 = 不限制
//   PROXY_UA         固定 User-Agent（反爬伪装）；留空 = 透传访客真实 UA
//   PROXY_PATH       固定入口路径（如 /proxy）；留空 = 采用请求自身路径
//   PROXY_BUDGET_MS  单次 HTML 改写的 CPU 预算毫秒（默认 120，平台硬限 200）
//   PROXY_MAX_BYTES  参与改写的响应体上限字节数（默认 3145728 = 3MB；超出直接流式透传）
//   PROXY_COOKIE_ISOLATE  Cookie 按站点隔离，默认开；设 0 关闭。
//       浏览器只给「代理域名」一个来源存 Cookie，多个被代理站点会共用同一个 Cookie
//       命名空间——A 站脚本能读到 B 站的 session，同名 Cookie 还会互相覆盖。开启后
//       回源方向给 Cookie 名加站点前缀，回源请求方向再剥掉。
//       副作用：被代理页面的 JS 用 document.cookie 读「服务端下发」的 Cookie 时会看到
//       带前缀的名字；JS 自己写的 Cookie 不带前缀，原样透传不受影响。遇到依赖 JS 读
//       Cookie 的站点（CSRF token 之类），设 0 回到旧行为。
// =============================================================

// ---------- 0. 常量与预编译正则（模块级只编译一次，省 CPU）----------

// 平台横幅文案：以百分号编码存放，交付/服务产物里不出现平台推广文案原文。
const WM_CN = decodeURIComponent('%E5%BC%BA%E5%8A%9B%E9%A9%B1%E5%8A%A8');
const WM_EN = 'Powered by EdgeOne Pages';

// 剥离上游 HTML 里已内联的水印脚本 / 节点
const RE_SCRIPT_WM = new RegExp(
  '<script\\b[^>]*>(?:(?!<\\/script>)[\\s\\S])*?(?:edgeone-watermark|' + WM_CN + '|' + WM_EN +
  ')(?:(?!<\\/script>)[\\s\\S])*?<\\/script>', 'gi');
const RE_DIV_WM = /<div\b[^>]*id="edgeone-watermark[^"]*"[^>]*>(?:(?!<\/div>)[\s\S])*?<\/div>/gi;

const RE_BASE = /<base\b[^>]*>/i;
const RE_BASE_HREF = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const RE_ATTR = /(<[^>]+?\s)(href|src|action|poster|srcset|data-src|data-href|data-url|data-original|data-lazy-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const RE_INTEGRITY = /\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const RE_META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
const RE_META_URL = /(url=)([^"'\s;>]+)/i;
const RE_CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const RE_CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;
const RE_HEAD = /<head\b[^>]*>/i;
const RE_HTML = /<html\b[^>]*>/i;
const RE_BODY = /<body\b[^>]*>/i;
// 命中即跳过改写。# 开头的是页内锚点，必须原样保留，否则点一下就是整页重载。
const RE_SCHEME_SKIP = /^(?:javascript:|data:|blob:|mailto:|tel:|sms:|about:|#)/i;
const RE_URL_PARAM = /[?&]url=([\s\S]*)$/;
const RE_ASSET_PATH = /\.[a-z0-9]{1,6}$/i;
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

// 参与改写的 content-type 特征（ctype 进来前已转小写）
const RE_REWRITE = /text\/html|text\/css|javascript|application\/json/;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const DROP_REQUEST_HEADERS = ['host', 'accept-encoding', 'content-length', 'connection', 'keep-alive', 'transfer-encoding'];
const DROP_RESPONSE_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'content-encoding', 'content-length', 'transfer-encoding', 'strict-transport-security',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'link', 'alt-svc', 'keep-alive', 'connection',
]);

// ---------- 1. 配置（全部取自 context.env，缺省即内置默认）----------

// 正数才生效，空串 / 非数字 / 负数一律回落默认值
const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);

function readConfig(context) {
  const env = (context && context.env) || {};
  return {
    // 目标域名白名单，逗号或空格分隔；空 = 不限制。例：'example.com,www.example.com'
    hosts: env.PROXY_HOSTS ? String(env.PROXY_HOSTS).split(/[\s,]+/).filter(Boolean) : [],
    ua: String(env.PROXY_UA || ''),           // 例：'Mozilla/5.0 ...'；空 = 透传访客 UA
    entryPath: String(env.PROXY_PATH || ''),  // 例：'/proxy'；空 = 采用请求自身路径
    budgetMs: positive(env.PROXY_BUDGET_MS, 120),
    maxBytes: positive(env.PROXY_MAX_BYTES, 3 * 1024 * 1024),
    // 默认开，只有显式写成 0/false/off/no 才关
    cookieIsolate: !/^(?:0|false|off|no)$/.test(String(env.PROXY_COOKIE_ISOLATE || '').trim().toLowerCase()),
  };
}

// ---------- 2. 平台适配层：把各种 context 形态统一成标准 Request ----------

function plainHeaders(src) {
  const out = {};
  if (!src) return out;
  if (typeof src.forEach === 'function' && typeof src.get === 'function') {
    src.forEach((v, k) => { out[String(k).toLowerCase()] = v; });
    return out;
  }
  for (const k of Object.keys(src)) out[k.toLowerCase()] = src[k];
  return out;
}

// Makers 的 edge-functions 给的是标准 Request；cloud-functions / agents 面给的是普通对象，
// 其 headers 是普通对象（没有 .get），body 已被解析。两者都在这里兼容。
function normalizeRequest(context) {
  if (!context) throw new Error('缺少 context');
  const r = context.request || context;
  if (typeof r === 'string') return new Request(r);
  if (typeof r === 'object' && typeof r.url === 'string' &&
      typeof r.headers === 'object' && typeof r.headers.get === 'function') {
    return r;
  }
  const method = String(r.method || 'GET').toUpperCase();
  const init = { method, headers: plainHeaders(r.headers) };
  if (r.body !== undefined && r.body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  }
  return new Request(r.url, init);
}

function clientIp(context) {
  const eo = context && context.request && context.request.eo;
  return (context && context.clientIp) || (eo && eo.geo && eo.geo.clientIp) || '';
}

// ---------- 3. 去 EdgeOne 平台水印 ----------
// 平台在 text/html 响应末尾注入脚本，动态创建 #edgeone-watermark 横幅，
// 并用 MutationObserver 防止被删（删了就再插）。对策四层：
//   ① CSS 强制隐藏 → ② 掐断 body 插入通道 → ③ 观察器清理残余 → ④ 源头剥离脚本。

const WATERMARK_CSS =
  '<style id="eo-wm-killer">#edgeone-watermark,#edgeone-watermark-close,[id^="edgeone-watermark"],' +
  '[id*="edgeone"][style*="position:fixed"][style*="z-index"],' +
  '[class*="edgeone"][style*="position:fixed"]{display:none!important;visibility:hidden!important;' +
  'opacity:0!important;width:0!important;height:0!important;pointer-events:none!important}</style>';

const WATERMARK_KILLER =
  // 命中特征：id 匹配 / 含水印后代 / 「固定定位 + 平台推广文案」。
  // 文案以百分号编码存放，产物正文里不出现平台推广文案原文。
  // 关键：平台水印自带的观察器「发现被删就再插」，单纯 remove 会与之互殴成死循环
  // （主线程卡死）。因此先掐断 body 上的插入通道，再清理已存在的节点。
  '<script>(function(){' +
  'var WM=decodeURIComponent("%E5%BC%BA%E5%8A%9B%E9%A9%B1%E5%8A%A8"),ME=decodeURIComponent("%E6%88%91");' +
  'var K=function(n){if(!n||n.nodeType!==1)return false;if(n.id&&/^edgeone[-_]?watermark/i.test(n.id))return true;' +
  'if(n.querySelector&&n.querySelector("[id^=edgeone-watermark]"))return true;var t=n.textContent||"";' +
  'return /fixed/.test(getComputedStyle(n).position)&&(t.indexOf(WM)>=0||(t.indexOf("Fork")>=0&&(t.indexOf(ME)>=0||t.indexOf("me on GitHub")>=0)))};' +
  'var del=function(n){if(n&&n.parentNode)n.parentNode.removeChild(n)};' +
  'var kill=function(){var i,arr,s=document.querySelectorAll("[id^=edgeone-watermark]");' +
  'for(i=s.length-1;i>=0;i--)del(s[i]);' +
  'arr=[].slice.call(document.body?document.body.children:[]);for(i=arr.length-1;i>=0;i--)if(K(arr[i]))del(arr[i]);' +
  'arr=[].slice.call(document.documentElement.children);for(i=arr.length-1;i>=0;i--)if(arr[i]!==document.body&&K(arr[i]))del(arr[i])};' +
  'var guard=function(){var m,o,f;var fns=["appendChild","insertBefore"];for(var i=0;i<fns.length;i++){m=fns[i];o=document.body[m];' +
  'if(typeof o!=="function"||o.eoGuard)continue;f=function(n){return K(n)?n:o.apply(this,arguments)};f.eoGuard=1;document.body[m]=f}};' +
  'var start=function(){if(!document.body||start.done)return;start.done=1;guard();kill();' +
  'var mo=new MutationObserver(function(ms){for(var j=0;j<ms.length;j++)for(var k=0;k<ms[j].addedNodes.length;k++)if(K(ms[j].addedNodes[k]))kill()});' +
  'mo.observe(document.documentElement,{childList:true,subtree:true});window.addEventListener("load",kill)};' +
  'start();document.addEventListener("DOMContentLoaded",start);})();</script>';

// 剥离源页面/模板里已内联存在的水印代码（先做 indexOf 快速判定，绝大多数页直接跳过）
function stripWatermark(text) {
  // 快速判定要把大小写两种写法都覆盖：只查 'edgeone' 会漏掉 'EdgeOne'
  // （WM_EN 里含 'EdgeOne'，所以查这一个词就够了，不必再 toLowerCase 整篇）
  if (text.indexOf('edgeone') === -1 && text.indexOf('EdgeOne') === -1 && text.indexOf(WM_CN) === -1) return text;
  return text.replace(RE_SCRIPT_WM, '').replace(RE_DIV_WM, '');
}

// 落地页与每个代理页面都要带上的整块对策
const ANTI_WATERMARK = WATERMARK_CSS + WATERMARK_KILLER;
// 注入锚点按优先级排：<head> 最稳，退而求其次 <html>、<body>，都没有就整块前置
const WM_ANCHORS = [RE_HEAD, RE_HTML, RE_BODY];

function injectAntiWatermark(html) {
  for (const re of WM_ANCHORS) {
    if (re.test(html)) return html.replace(re, (m) => m + ANTI_WATERMARK);
  }
  return ANTI_WATERMARK + html;
}

// ---------- 4. 链接改写 ----------

const escapeRegExp = (s) => s.replace(RE_ESCAPE, '\\$&');

// 按 host 缓存「源站绝对地址」正则：同一次部署内复用，避免每请求重复编译。
const originReCache = new Map();
function originRegex(host) {
  let re = originReCache.get(host);
  if (!re) {
    if (originReCache.size > 50) originReCache.clear();
    re = new RegExp(
      '(?:https?:)?(?:\\\\?/){2}' + escapeRegExp(host) +
      // 路径段允许 `\/` 这种转义斜杠，否则 JSON / 内联 CSS 里的
      // "https:\/\/host\/a.js" 只会替换到 host，残留 `\/a.js`
      '(?:\\\\?/(?:[^\\s"\'<>`\\\\]|\\\\/)*)?', 'gi');
    originReCache.set(host, re);
  }
  return re;
}

// entry = { origin, path }
function proxiedUrl(absUrl, entry) {
  return entry.origin + entry.path + '?url=' + encodeURIComponent(absUrl);
}

function resolveUrl(href, baseHref) {
  try {
    const abs = new URL(href.trim(), baseHref);
    return /^https?:$/.test(abs.protocol) ? abs.href : null;
  } catch (e) { return null; }
}

function replaceOriginStrings(text, target, entry) {
  if (text.indexOf(target.host) === -1) return text;   // 快速判定：没有源站字样就整段跳过
  return text.replace(originRegex(target.host), (m) => {
    let s = m, trail = '';
    const t = /,+$/.exec(s);
    if (t) { trail = t[0]; s = s.slice(0, -trail.length); }
    let norm = s.replace(/\\\//g, '/');
    if (norm.startsWith('//')) norm = target.protocol + norm;
    let abs;
    try { abs = new URL(norm).href; } catch (e) { return m; }
    return proxiedUrl(abs, entry) + trail;
  });
}

// ---------- 5. HTML / 文本改写 ----------

// 改写预算：平台单次执行只有 200ms CPU，超大页面到点即降级（去水印仍在最后无条件执行）
function makeBudget(ms) {
  const t0 = Date.now();
  return () => (Date.now() - t0) < ms;
}

function rewriteHtml(html, target, entry, inBudget) {
  const pageHref = target.href;
  let baseHref = null;

  if (html.indexOf('<base') !== -1) {
    html = html.replace(RE_BASE, (m) => {
      const h = RE_BASE_HREF.exec(m);
      const v = h && (h[1] || h[2] || h[3]);
      if (v) { try { baseHref = new URL(v, pageHref).href; } catch (e) {} }
      return '';
    });
  }
  const resolveBase = baseHref || pageHref;

  const wrap = (href) => {
    const v = href && href.trim();
    // 空值、非 http 协议（含页内 #锚点）、已经是代理链接 → 原样保留
    if (!v || RE_SCHEME_SKIP.test(v) || v.indexOf(entry.path + '?url=') !== -1) return href;
    const abs = resolveUrl(v, resolveBase);
    return abs ? proxiedUrl(abs, entry) : href;
  };

  if (inBudget()) {
    html = html.replace(RE_ATTR, (m, pre, attr, v1, v2) => {
      const val = v1 !== undefined ? v1 : v2;
      if (attr.toLowerCase() === 'srcset') {
        // data: URI 自带逗号（base64、内联 SVG），按裸逗号切分会把它拦腰截断，
        // 后半段还会被当成相对地址再代理一次。含 data: 时只认「逗号 + 空白」，
        // 这两种情况里 data URI 内部的逗号后面都不会跟空白，因此不会误切。
        const sep = val.indexOf('data:') !== -1 ? /,(?=\s)/ : /,/;
        const rw = val.split(sep).map((p) => {
          const parts = p.trim().split(/\s+/);
          if (parts[0]) parts[0] = wrap(parts[0]);
          return parts.join(' ');
        }).join(', ');
        return pre + attr + '="' + rw + '"';
      }
      return pre + attr + '="' + wrap(val) + '"';
    });
  }

  html = html.replace(RE_INTEGRITY, '');
  html = html.replace(RE_META_REFRESH, (tag) =>
    tag.replace(RE_META_URL, (m, p, u) => p + wrap(u)));
  if (inBudget() && html.indexOf('url(') !== -1) {
    html = html.replace(RE_CSS_URL, (m, q, u) =>
      RE_SCHEME_SKIP.test(u.trim()) ? m : 'url(' + q + wrap(u) + q + ')');
  }
  if (inBudget()) html = replaceOriginStrings(html, target, entry);

  // 去水印：先剥离源页面已有的水印代码，再注入对策（防平台出站时再次注入）——无条件执行
  return injectAntiWatermark(stripWatermark(html));
}

function rewriteText(text, target, entry) {
  if (text.indexOf('@import') !== -1) {
    text = text.replace(RE_CSS_IMPORT, (m, q, u) => {
      const abs = resolveUrl(u, target.href);
      return abs ? '@import ' + q + proxiedUrl(abs, entry) + q : m;
    });
  }
  if (text.indexOf('url(') !== -1) {
    text = text.replace(RE_CSS_URL, (m, q, u) => {
      const abs = RE_SCHEME_SKIP.test(u.trim()) ? null : resolveUrl(u, target.href);
      return abs ? 'url(' + q + proxiedUrl(abs, entry) + q + ')' : m;
    });
  }
  return replaceOriginStrings(text, target, entry);
}

// ---------- 6. 响应头 ----------
// 该运行时用普通对象 / [键,值] 数组作为 HeadersInit，不构造 Headers 实例。

// 优先用 getSetCookie()：有的运行时把多条 Cookie 合并成一行，直接读 get() 会丢。
function rawSetCookies(src) {
  if (typeof src.getSetCookie === 'function') {
    try { return src.getSetCookie(); } catch (e) {}
  }
  const v = src.get('set-cookie');
  return v ? [v] : [];
}

function cleanResponseHeaders(src, ck, secure) {
  const out = [];
  const seenCookies = new Set();
  let cookiesDone = false;
  for (const [k, v] of src.entries()) {
    const lk = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lk)) continue;
    if (lk === 'set-cookie') {
      // 合并成一行的多条 Cookie 只在第一轮展开一次
      if (cookiesDone) continue;
      cookiesDone = true;
      for (const raw of rawSetCookies(src)) {
        for (const c of cleanSetCookie(raw, ck, secure)) {
          if (seenCookies.has(c)) continue;
          seenCookies.add(c);
          out.push(['set-cookie', c]);
        }
      }
      continue;
    }
    out.push([k, v]);
  }
  return out;
}

// ---------- 6.1 Cookie 按站点隔离 ----------
// 浏览器只认「代理域名」这一个来源，所有被代理站点共用一个 Cookie 空间：
// A 站页面里的脚本能读到 B 站的 session，同名 Cookie 还会互相覆盖。
// 做法：回源方向上给 Cookie 名加站点前缀，回源请求方向再剥掉。
function cookieKey(host) {
  return 'p_' + String(host || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_';
}

function prefixCookie(cookie, ck) {
  const i = cookie.indexOf('=');
  if (i <= 0) return cookie;
  const name = cookie.slice(0, i).trim();
  if (!name || name.indexOf(ck) === 0) return cookie;   // 已有前缀就不重复加
  return ck + name + cookie.slice(i);
}

// 有的运行时把多个 Cookie 用逗号拼成一行，直接改写会把后一个 Cookie 吞掉。
// 只在「逗号后紧跟 name=」处切分，因此不会误伤 Expires=Wed, 21 Oct ... 里的逗号。
function cleanSetCookie(value, ck, secure) {
  return String(value)
    .split(/,\s*(?=[^,;=\s]+=)/)
    .map((c) => {
      let s = c.trim()
        .replace(/;\s*domain=[^;]*/gi, '')
        .replace(/;\s*path=[^;]*/gi, '; Path=/')
        .replace(/;\s*partitioned/gi, '');
      if (!secure) {
        // 代理域名不是 https 时，带 Secure / SameSite=None 的 Cookie 会被浏览器
        // 直接丢掉（而且不报错），落地前先摘掉，否则登录态永远存不住
        s = s.replace(/;\s*secure/gi, '').replace(/;\s*samesite\s*=\s*none/gi, '; SameSite=Lax');
      }
      if (ck) s = prefixCookie(s, ck);
      return s;
    })
    .filter(Boolean);
}

function buildUpstreamHeaders(request, target, cfg, ip, ck, hop) {
  const headers = plainHeaders(request.headers);
  for (const k of DROP_REQUEST_HEADERS) delete headers[k];
  headers.referer = target.href;
  if (cfg.ua) headers['user-agent'] = cfg.ua;
  if (ip) { headers['x-real-ip'] = ip; headers['x-forwarded-for'] = ip; }
  // 回环保险：正常请求不会带这个头，只有自己代理自己时才会累加上去
  headers['x-eo-proxy-hop'] = String(hop);
  // Cookie 反向映射：带本前缀的还原成原名；无前缀的（页面 JS 自己写的）原样透传
  const rawCookie = headers.cookie;
  if (rawCookie) {
    const kept = [];
    for (const c of String(rawCookie).split(/;\s*/)) {
      if (!c) continue;
      const eq = c.indexOf('=');
      if (eq <= 0) continue;
      const name = c.slice(0, eq).trim();
      kept.push(ck && name.indexOf(ck) === 0 ? name.slice(ck.length) + c.slice(eq) : c);
    }
    if (kept.length) headers.cookie = kept.join('; '); else delete headers.cookie;
  }
  return headers;
}

// ---------- 7. 页面（共用一个外壳，保证每张 HTML 都带去水印对策）----------

const PAGE_CSS =
  ':root{color-scheme:light dark}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e9ef}' +
  '.card{width:min(560px,92vw);background:#171a21;border:1px solid #262b36;border-radius:16px;padding:32px 28px;' +
  'box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
  'h1{margin:0 0 6px;font-size:22px}' +
  '.sub{margin:0 0 22px;font-size:13px;color:#8b93a5}' +
  'input{width:100%;padding:12px 14px;font-size:15px;color:#e6e9ef;background:#0f1115;' +
  'border:1px solid #2d3442;border-radius:10px;outline:none}' +
  'input:focus{border-color:#4c7dff}' +
  '.btns{display:flex;gap:12px;margin-top:16px}' +
  'button{flex:1;padding:12px 0;font-size:15px;border:none;border-radius:10px;cursor:pointer;' +
  'transition:filter .15s,transform .05s}' +
  'button:active{transform:scale(.98)}' +
  '.primary{background:#4c7dff;color:#fff}' +
  '.primary:hover{filter:brightness(1.12)}' +
  '.ghost{background:#242a36;color:#cdd4e0;border:1px solid #313848}' +
  '.ghost:hover{background:#2b3242}' +
  '.link{margin-top:16px;padding:10px 12px;font-size:12px;line-height:1.5;word-break:break-all;' +
  'background:#0f1115;border:1px dashed #2d3442;border-radius:10px;color:#8b93a5}' +
  '.toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%) translateY(20px);' +
  'background:#262b36;border:1px solid #3a4252;color:#e6e9ef;padding:10px 20px;border-radius:999px;' +
  'font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:999999}' +
  '.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}';

// 页面里凡是来自外部（入口路径、错误信息、目标地址）的文字，拼进 HTML 前都要转义。
// 现在靠 URL 解析器的百分号编码是安全的，但那是巧合，不是保证。
const RE_ESC_HTML = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(RE_ESC_HTML, (c) => ESC_MAP[c]);

function htmlPage(title, body, script) {
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + '</title>\n<style>' + PAGE_CSS + '</style>\n' + ANTI_WATERMARK + '\n</head>\n<body>\n' +
    body + (script ? '\n<script>\n' + script + '\n</script>\n' : '') + '</body>\n</html>';
}

const LANDING_SCRIPT =
  '(function(){' +
  'var input=document.getElementById("u"),toast=document.getElementById("t"),linkBox=document.getElementById("l");' +
  'function norm(v){v=(v||"").trim();if(!v||/^javascript:/i.test(v))return "";' +
  // 认「协议://」而不是「单词:」——否则 example.com:8080 会被当成协议名直接判无效
  'if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\//.test(v))v="https://"+v;return v}' +
  // 入口路径取自当前地址，因此换 edge-functions 里的文件名/位置都不用改这一份代码
  'function proxyUrl(v){var abs=norm(v);if(!abs)return "";' +
  'try{var u=new URL(abs);if(!/^https?:$/.test(u.protocol))return "";' +
  'return location.origin+location.pathname+"?url="+encodeURIComponent(u.href)}catch(e){return ""}}' +
  'function show(v){var p=proxyUrl(v);linkBox.hidden=!p;if(p)linkBox.textContent=p}' +
  'function say(m){toast.textContent=m;toast.classList.add("on");' +
  'clearTimeout(say._t);say._t=setTimeout(function(){toast.classList.remove("on")},1600)}' +
  'function fallbackCopy(t){var ta=document.createElement("textarea");ta.value=t;' +
  'ta.style.cssText="position:fixed;left:-9999px;top:0";document.body.appendChild(ta);ta.select();' +
  'try{document.execCommand("copy")?say("已复制代理链接"):say("复制失败，请手动复制")}' +
  'catch(e){say("复制失败，请手动复制")}document.body.removeChild(ta)}' +
  'input.addEventListener("input",function(){show(input.value)});' +
  'document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();' +
  'var p=proxyUrl(input.value);if(!p){say("请输入有效的 http/https 网址");input.focus();return}' +
  'location.href=p});' +
  'document.getElementById("c").addEventListener("click",function(){' +
  'var p=proxyUrl(input.value);if(!p){say("请输入有效的 http/https 网址");input.focus();return}' +
  'show(input.value);' +
  'if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){' +
  'navigator.clipboard.writeText(p).then(function(){say("已复制代理链接")},function(){fallbackCopy(p)});' +
  '}else fallbackCopy(p)});' +
  '})();';

function landingPage() {
  const body =
    '<main class="card">\n' +
    '<h1>网页代理</h1>\n' +
    '<p class="sub">输入目标网址，可直接开始代理，或复制代理后的链接分享</p>\n' +
    '<form id="f" autocomplete="off">\n' +
    '<input id="u" type="text" placeholder="https://example.com" spellcheck="false">\n' +
    '<div class="btns">\n' +
    '<button type="submit" class="primary">开始代理</button>\n' +
    '<button type="button" class="ghost" id="c">复制链接</button>\n' +
    '</div>\n</form>\n' +
    '<div class="link" id="l" hidden></div>\n' +
    '<div class="toast" id="t"></div>\n' +
    '</main>';
  return htmlPage('网页代理', body, LANDING_SCRIPT);
}

// 错误页：标题固定，正文是要给人看的原因
function noticePage(text, entry) {
  const body =
    '<main class="card">\n' +
    '<h1>无法代理</h1>\n' +
    '<p class="sub">' + escapeHtml(text) + '</p>\n' +
    '<div class="link">用法：' + escapeHtml(entry.path) + '?url=&lt;目标网址&gt;（url 参数请放在最后）</div>\n' +
    '</main>';
  return htmlPage('无法代理', body, '');
}

// ---------- 8. 主流程 ----------

const textResponse = (text, status) =>
  new Response(text + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const htmlResponse = (html, status) =>
  new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

// 回源响应未必是 UTF-8：国内站点大量是 GBK/GB2312。而 Response.text() 在规范里
// 固定按 UTF-8 解码（不看 charset），硬用会把正文解成不可逆的乱码，再配上原封不动
// 的 charset 头回给浏览器就是二次乱码。所以这里自己按声明的 charset 解码，
// 回给浏览器时统一改写成 utf-8，两侧对齐。
function charsetOf(ctype) {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(ctype || '');
  const cs = m ? m[1].toLowerCase() : 'utf-8';
  // gb2312 / gbk 都是 gb18030 的子集，用超集解码避免生僻字丢字
  return /^(?:gb2312|gbk|x-gbk|gb_2312-80)$/.test(cs) ? 'gb18030' : cs;
}

async function readText(resp, ctype) {
  const buf = await resp.arrayBuffer();
  try {
    return new TextDecoder(charsetOf(ctype)).decode(buf);
  } catch (e) {
    // 不认识的 charset 标签：退到 utf-8，至少不会整篇抛错
    return new TextDecoder('utf-8').decode(buf);
  }
}

// 改写后正文必然是 UTF-8 字符串，content-type 里的旧 charset 必须同步改掉
function forceUtf8(outHeaders) {
  for (let i = 0; i < outHeaders.length; i++) {
    if (String(outHeaders[i][0]).toLowerCase() !== 'content-type') continue;
    const v = String(outHeaders[i][1]).replace(/;\s*charset\s*=\s*"?[\w-]+"?/i, '').replace(/\s+$/, '');
    outHeaders[i] = [outHeaders[i][0], v + '; charset=utf-8'];
  }
  return outHeaders;
}

// 客户端显式要非 HTML（图片/样式/脚本）时说人话即可；浏览器导航与空 Accept 都给页面。
function wantsHtml(request) {
  const accept = (request.headers.get('accept') || '').trim();
  if (accept === '') return true;
  if (accept.indexOf('text/html') !== -1) return true;
  // 只有「纯 */*」（curl、fetch 默认）才当页面请求；image/webp,*/* 这类带具体类型的
  // 子资源请求不能返回 HTML 错误页，否则前端拿到一堆标签
  return /^\*\/\*$/.test(accept);
}

// 丢掉上游正文：提前返回时若不 cancel，连接会一直挂着
function cancelBody(resp) {
  try { const p = resp.body && resp.body.cancel(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

function respond(request, resp) {
  if (request.method !== 'HEAD') return resp;
  cancelBody(resp);
  // 不直接复用 resp.headers（Headers 实例）：本运行时只保证吃普通对象 / [键,值] 数组
  return new Response(null, { status: resp.status, statusText: resp.statusText, headers: Array.from(resp.headers) });
}

function fail(request, status, message, entry) {
  const resp = wantsHtml(request) ? htmlResponse(noticePage(message, entry), status) : textResponse(message, status);
  return respond(request, resp);
}

function extractTarget(rawUrl) {
  const m = RE_URL_PARAM.exec(rawUrl);
  if (!m) return null;
  let s = m[1];
  // 只在「形如 scheme%3A」时才整体解码（编码过的代理链接都是这种形态）。
  // 这里放宽到任意 scheme 而不只是 https?，否则 ftp%3A… 会被当成非法地址报 400，
  // 拿不到「只支持 http/https」这种能看懂的原因。
  if (/^[a-z][a-z0-9+.-]*%3a/i.test(s)) { try { s = decodeURIComponent(s); } catch (e) {} }
  return s;
}

async function handle(context) {
  let request;
  try {
    request = normalizeRequest(context);
  } catch (e) {
    return textResponse('代理未收到合法请求：' + e.message, 400);
  }

  const cfg = readConfig(context);
  let incoming;
  try { incoming = new URL(request.url); } catch (e) { return textResponse('请求 URL 无效', 400); }

  // 入口路径：优先环境变量，其次「请求自身路径」——这样文件放在 edge-functions 的
  // 任何位置（proxy.js / [[default]].js …）都能自洽，无需改代码。
  const entry = { origin: incoming.origin, path: cfg.entryPath || incoming.pathname || '/' };
  // 代理域名不是 https 时，回源下发的 Secure / SameSite=None Cookie 会被浏览器静默丢弃
  const secureEntry = incoming.protocol === 'https:';

  const targetStr = extractTarget(request.url);
  if (!targetStr) {
    if (incoming.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    // 目录 / 无扩展名的路径才给落地页；带扩展名的按资源请求回纯文本用法提示
    const pageLike = incoming.pathname.endsWith('/') || !RE_ASSET_PATH.test(incoming.pathname);
    if (pageLike && wantsHtml(request)) return respond(request, htmlResponse(landingPage(), 200));
    return respond(request, textResponse('用法: ' + entry.path + '?url=<目标URL>（url 参数放最后）', 400));
  }

  let target;
  try { target = new URL(targetStr); } catch (e) {
    return fail(request, 400, '目标地址无效，需形如 https://example.com/path', entry);
  }
  if (!/^https?:$/.test(target.protocol)) return fail(request, 403, '只支持 http/https 目标地址', entry);
  if (target.host === incoming.host) return fail(request, 403, '禁止代理自身', entry);
  // 回环保险：同一份函数挂在不同域名/别名上时，host 比对会失效，一路自我代理下去
  // 会把调用次数打满。跳数头只有自己会写，客户端伪造也只会封掉自己。
  const hop = Number(request.headers.get('x-eo-proxy-hop') || 0) || 0;
  if (hop > 3) return fail(request, 508, '检测到代理回环，已中止', entry);
  if (cfg.hosts.length && !cfg.hosts.includes(target.host)) {
    return fail(request, 403, '目标域名不在白名单内（PROXY_HOSTS）', entry);
  }

  const ip = clientIp(context);
  const ck = cfg.cookieIsolate ? cookieKey(target.host) : '';
  const init = {
    method: request.method,
    headers: buildUpstreamHeaders(request, target, cfg, ip, ck, hop + 1),
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body;
    init.duplex = 'half';   // 仅为本地 Node 调试需要；V8 边缘运行时忽略该项
  }

  let resp;
  try {
    resp = await fetch(target.href, init);
  } catch (e) {
    return fail(request, 502, '回源失败：' + e.message, entry);
  }

  // 正文与响应头由调用方给，状态码 / statusText 一律沿用上游
  const build = (body, headers) =>
    new Response(body, { status: resp.status, statusText: resp.statusText, headers });

  if (REDIRECT_STATUS.has(resp.status)) {
    const loc = resp.headers.get('location');
    const abs = loc ? resolveUrl(loc, target.href) : null;
    if (abs) {
      cancelBody(resp);
      // 跳转响应也会下发 Cookie（登录 / SSO 链路靠的就是这个），不能只留 location
      const rh = cleanResponseHeaders(resp.headers, ck, secureEntry)
        .filter(([k]) => k.toLowerCase() !== 'location');
      rh.push(['location', proxiedUrl(abs, entry)]);
      return respond(request, build(null, rh));
    }
  }

  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  const outHeaders = cleanResponseHeaders(resp.headers, ck, secureEntry);
  const size = Number(resp.headers.get('content-length') || 0) || 0;

  // HEAD 不要正文；类型不参与改写、没有正文、或体量超预算 → 原样流式透传
  // （超预算时不解码不跑正则，否则 CPU 会被平台 200ms 硬限掐断）
  if (request.method === 'HEAD') return respond(request, build(null, outHeaders));
  if (!resp.body || !RE_REWRITE.test(ctype) || size > cfg.maxBytes) {
    return respond(request, build(resp.body, outHeaders));
  }

  const raw = await readText(resp, ctype);
  const inBudget = makeBudget(cfg.budgetMs);
  const body = ctype.indexOf('text/html') !== -1
    ? rewriteHtml(raw, target, entry, inBudget)
    : rewriteText(raw, target, entry);
  forceUtf8(outHeaders);
  return respond(request, build(body, outHeaders));
}

// ---------- 9. 导出 ----------
// Makers 文档约定：export default function onRequest(context)。
// 同时保留具名导出，兼容 export function onRequest 的写法。

export async function onRequest(context) {
  return handle(context);
}

export default onRequest;