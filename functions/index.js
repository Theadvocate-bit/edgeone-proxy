// =============================================================
// EdgeOne Makers 边缘函数（Edge Runtime / V8）：全站反向代理
//   无访问密钥 · 去平台推广水印 · 一键复制代理链接
//
// ── 单文件自包含（全部内容都在这一个 index.js 里）───────────
//   · 边缘函数逻辑、落地页/提示页的 HTML、样式(CSS)、交互脚本(JS)、去水印策略，
//     全部写在本文中；不 import 任何模块，不读磁盘，不依赖外部样式表/脚本/图标，
//     也不需要额外的 HTML 文件 —— 网页由本函数现场生成。
//   · 部署：把 index.js 放进 edge-functions/ 目录即可（文件名即路由）：
//        edge-functions/index.js         →  /             ← 当前部署方式，首页即本网页
//        edge-functions/proxy.js         →  /proxy        （改名即换入口，代码无需改动）
//        edge-functions/[[default]].js   →  任意未匹配路径（想让整站都归它接管时用）
//     代码不写死入口路径：链接一律按「当前请求自己的路径」生成，因此上面三种放法都自洽。
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
// =============================================================

// ---------- 0. 常量与预编译正则（模块级只编译一次，省 CPU）----------

// 平台横幅文案：以百分号编码存放，交付/服务产物里不出现平台推广文案原文。
const WM_CN = decodeURIComponent('%E5%BC%BA%E5%8A%9B%E9%A9%B1%E5%8A%A8');
const WM_CN_ME = decodeURIComponent('%E6%88%91');
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
const RE_SCHEME_SKIP = /^(?:javascript:|data:|blob:|mailto:|tel:|about:|#|)$/i;
const RE_URL_PARAM = /[?&]url=([\s\S]*)$/;
const RE_ASSET_PATH = /\.[a-z0-9]{1,6}$/i;
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

const REWRITE_TYPES = ['text/html', 'text/css', 'javascript', 'application/json'];
const REDIRECT_STATUS = [301, 302, 303, 307, 308];

const DROP_REQUEST_HEADERS = ['host', 'accept-encoding', 'content-length', 'connection', 'keep-alive', 'transfer-encoding'];
const DROP_RESPONSE_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'content-encoding', 'content-length', 'transfer-encoding', 'strict-transport-security',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'link', 'alt-svc', 'keep-alive', 'connection',
]);

// ---------- 1. 默认配置（可被 context.env 覆盖）----------

const DEFAULT_HOSTS = [];    // 例：['example.com', 'www.example.com']；空数组 = 不限制
const DEFAULT_UA = '';       // 例：'Mozilla/5.0 ...'；留空 = 透传访客 UA
const DEFAULT_PATH = '';     // 例：'/proxy'；留空 = 采用请求自身路径
const DEFAULT_BUDGET_MS = 120;

function readConfig(context) {
  const env = (context && context.env) || {};
  const rawHosts = env.PROXY_HOSTS ? String(env.PROXY_HOSTS).split(/[\s,]+/).filter(Boolean) : DEFAULT_HOSTS;
  const budget = Number(env.PROXY_BUDGET_MS);
  return {
    hosts: rawHosts,
    ua: env.PROXY_UA ? String(env.PROXY_UA) : DEFAULT_UA,
    entryPath: env.PROXY_PATH ? String(env.PROXY_PATH) : DEFAULT_PATH,
    budgetMs: budget > 0 ? budget : DEFAULT_BUDGET_MS,
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
  if (text.indexOf('edgeone') === -1 && text.indexOf(WM_CN) === -1 && text.indexOf(WM_EN) === -1) return text;
  return text.replace(RE_SCRIPT_WM, '').replace(RE_DIV_WM, '');
}

// 把去水印样式/脚本注入任意 HTML（落地页与每个代理页面都会带上）
function injectAntiWatermark(html) {
  const block = WATERMARK_CSS + WATERMARK_KILLER;
  if (RE_HEAD.test(html)) return html.replace(RE_HEAD, (m) => m + block);
  if (RE_HTML.test(html)) return html.replace(RE_HTML, (m) => m + block);
  if (RE_BODY.test(html)) return html.replace(RE_BODY, (m) => m + block);
  return block + html;
}

// ---------- 4. 链接改写 ----------

const escapeRegExp = (s) => s.replace(RE_ESCAPE, '\\$&');

// 按 host 缓存「源站绝对地址」正则：同一次部署内复用，避免每请求重复编译。
const originReCache = new Map();
function originRegex(host) {
  let re = originReCache.get(host);
  if (!re) {
    if (originReCache.size > 50) originReCache.clear();
    re = new RegExp('(?:https?:)?(?:\\\\?/){2}' + escapeRegExp(host) + '(?:\\\\?/[^\\s"\'<>`\\\\]*)?', 'gi');
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

function isProxied(href, entry) {
  return href.indexOf(entry.path + '?url=') !== -1;
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
    if (!v || RE_SCHEME_SKIP.test(v) || isProxied(v, entry)) return href;
    const abs = resolveUrl(v, resolveBase);
    return abs ? proxiedUrl(abs, entry) : href;
  };

  if (inBudget()) {
    html = html.replace(RE_ATTR, (m, pre, attr, v1, v2) => {
      const val = v1 !== undefined ? v1 : v2;
      if (attr.toLowerCase() === 'srcset') {
        const rw = val.split(',').map((p) => {
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

function cleanResponseHeaders(src) {
  const out = [];
  const seenCookies = new Set();
  for (const [k, v] of src.entries()) {
    const lk = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lk)) continue;
    if (lk === 'set-cookie') {
      for (const c of cleanSetCookie(v)) {
        if (seenCookies.has(c)) continue;
        seenCookies.add(c);
        out.push(['set-cookie', c]);
      }
      continue;
    }
    out.push([k, v]);
  }
  return out;
}

// 有的运行时把多个 Cookie 用逗号拼成一行，直接改写会把后一个 Cookie 吞掉。
// 只在「逗号后紧跟 name=」处切分，因此不会误伤 Expires=Wed, 21 Oct ... 里的逗号。
function cleanSetCookie(value) {
  return String(value)
    .split(/,\s*(?=[^,;=\s]+=)/)
    .map((c) => c.trim()
      .replace(/;\s*domain=[^;]*/gi, '')
      .replace(/;\s*path=[^;]*/gi, '; Path=/'))
    .filter(Boolean);
}

function buildUpstreamHeaders(request, target, cfg, ip) {
  const headers = plainHeaders(request.headers);
  for (const k of DROP_REQUEST_HEADERS) delete headers[k];
  headers.referer = target.href;
  if (cfg.ua) headers['user-agent'] = cfg.ua;
  if (ip) { headers['x-real-ip'] = ip; headers['x-forwarded-for'] = ip; }
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

function htmlPage(title, body, script) {
  const wm = WATERMARK_CSS + WATERMARK_KILLER;
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + title + '</title>\n<style>' + PAGE_CSS + '</style>\n' + wm + '\n</head>\n<body>\n' +
    body + (script ? '\n<script>\n' + script + '\n</script>\n' : '') + '</body>\n</html>';
}

const LANDING_SCRIPT =
  '(function(){' +
  'var input=document.getElementById("u"),toast=document.getElementById("t"),linkBox=document.getElementById("l");' +
  'function norm(v){v=(v||"").trim();if(!v||/^javascript:/i.test(v))return "";' +
  'if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v))v="https://"+v;return v}' +
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
    '<button type="button" class="ghost" id="c">复制连接</button>\n' +
    '</div>\n</form>\n' +
    '<div class="link" id="l" hidden></div>\n' +
    '<div class="toast" id="t"></div>\n' +
    '</main>';
  return htmlPage('网页代理', body, LANDING_SCRIPT);
}

function noticePage(title, text, entry) {
  const body =
    '<main class="card">\n' +
    '<h1>' + title + '</h1>\n' +
    '<p class="sub">' + text + '</p>\n' +
    '<div class="link">用法：' + entry.path + '?url=&lt;目标网址&gt;（url 参数请放在最后）</div>\n' +
    '</main>';
  return htmlPage(title, body, '');
}

// ---------- 8. 主流程 ----------

function textResponse(text, status) {
  return new Response(text + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// 客户端显式要非 HTML（图片/样式/脚本）时说人话即可；浏览器导航与空 Accept 都给页面。
function wantsHtml(request) {
  const accept = request.headers.get('accept') || '';
  return accept === '' || accept.indexOf('text/html') !== -1 || accept.indexOf('*/*') !== -1;
}

function respond(request, resp) {
  if (request.method !== 'HEAD') return resp;
  if (resp.body && typeof resp.body.cancel === 'function') { try { resp.body.cancel(); } catch (e) {} }
  return new Response(null, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
}

function fail(request, status, message, entry) {
  if (wantsHtml(request)) return respond(request, htmlResponse(noticePage('无法代理', message, entry), status));
  return respond(request, textResponse(message, status));
}

function extractTarget(rawUrl) {
  const m = RE_URL_PARAM.exec(rawUrl);
  if (!m) return null;
  let s = m[1];
  if (/^https?%3A/i.test(s)) { try { s = decodeURIComponent(s); } catch (e) {} }
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

  // 入口路径：优先环境变量，其次「请求自身路径」——这样把文件放到 edge-functions 的
  // 任何位置（index.js / proxy.js / [[default]].js）都能自洽，无需改代码。
  const entry = { origin: incoming.origin, path: cfg.entryPath || incoming.pathname || '/' };

  const targetStr = extractTarget(request.url);
  if (!targetStr) {
    if (incoming.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const pageLike = incoming.pathname === '/' || incoming.pathname.slice(-1) === '/' ||
      !RE_ASSET_PATH.test(incoming.pathname);
    if (pageLike && wantsHtml(request)) {
      return respond(request, htmlResponse(landingPage(), 200));
    }
    return respond(request, textResponse('用法: ' + entry.path + '?url=<目标URL>（url 参数放最后）', 400));
  }

  let target;
  try { target = new URL(targetStr); } catch (e) {
    return fail(request, 400, '目标地址无效，需形如 https://example.com/path', entry);
  }
  if (!/^https?:$/.test(target.protocol)) return fail(request, 403, '只支持 http/https 目标地址', entry);
  if (target.host === incoming.host) return fail(request, 403, '禁止代理自身', entry);
  if (cfg.hosts.length && cfg.hosts.indexOf(target.host) === -1) {
    return fail(request, 403, '目标域名不在白名单内（PROXY_HOSTS）', entry);
  }

  const ip = clientIp(context);
  const init = {
    method: request.method,
    headers: buildUpstreamHeaders(request, target, cfg, ip),
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

  if (REDIRECT_STATUS.indexOf(resp.status) !== -1) {
    const loc = resp.headers.get('location');
    if (loc) {
      let abs = null;
      try { abs = new URL(loc, target).href; } catch (e) {}
      if (abs) {
        if (resp.body && typeof resp.body.cancel === 'function') { try { resp.body.cancel(); } catch (e) {} }
        return respond(request, new Response(null, { status: resp.status, headers: { location: proxiedUrl(abs, entry) } }));
      }
    }
  }

  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  const outHeaders = cleanResponseHeaders(resp.headers);
  const rewritable = REWRITE_TYPES.some((t) => ctype.indexOf(t) !== -1);

  if (!rewritable || !resp.body) {
    return respond(request, new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: outHeaders }));
  }

  const isHtml = ctype.indexOf('text/html') !== -1;
  const raw = await resp.text();
  const inBudget = makeBudget(cfg.budgetMs);
  const body = isHtml ? rewriteHtml(raw, target, entry, inBudget) : rewriteText(raw, target, entry);
  return respond(request, new Response(body, { status: resp.status, statusText: resp.statusText, headers: outHeaders }));
}

// ---------- 9. 导出 ----------
// Makers 文档约定：export default function onRequest(context)。
// 同时保留具名导出，兼容 export function onRequest 的写法。

export async function onRequest(context) {
  return handle(context);
}

export default onRequest;