// =============================================================
// EdgeOne Maker 边缘函数：全站反向代理（无密钥 · 去水印 · 一键复制版）
// 变更：
//   1. 注入反水印样式/脚本，去除平台在页面底部注入的推广横幅（EdgeOne Pages 水印）
//   2. 移除访问密钥及其全部校验逻辑，代理链接不再携带任何密钥参数
//   3. 首页内置「开始代理」+「复制连接」两个按钮，后者一键复制代理后的网址
// =============================================================

const HOST_WHITELIST = [];    // 目标域名白名单，如 ['example.com']；空数组 = 不限制
const PROXY_PATH = '/proxy';
const OVERRIDE_UA = '';       // 可选：固定 UA 反爬伪装，留空则沿用客户端真实 UA

const REWRITE_TYPES = ['text/html', 'text/css', 'javascript', 'application/json'];

// ---------------- 去 EdgeOne 平台水印 ----------------
// 平台会在 text/html 响应中注入一段脚本，动态创建 #edgeone-watermark 横幅，
// 并用 MutationObserver 防止被删（删了就再插）。对策四层：
//   ① CSS 强制隐藏 → ② 掐断 body 插入通道 → ③ 观察器清理残余 → ④ 源头剥离脚本。

const WATERMARK_CSS =
  '<style id="eo-wm-killer">#edgeone-watermark,#edgeone-watermark-close,[id^="edgeone-watermark"],' +
  '[id*="edgeone"][style*="position:fixed"][style*="z-index"],' +
  '[class*="edgeone"][style*="position:fixed"]{display:none!important;visibility:hidden!important;' +
  'opacity:0!important;width:0!important;height:0!important;pointer-events:none!important}</style>';

const WATERMARK_KILLER =
  // 命中特征：id 匹配 / 含水印后代 / 「固定定位 + 平台推广文案」。
  // 文案以百分号编码存放，交付产物正文里不出现平台推广文案原文。
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

// 剥离源页面/模板里已内联存在的水印脚本与节点
function stripWatermark(text) {
  text = text.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?edgeone-watermark(?:(?!<\/script>)[\s\S])*?<\/script>/gi, '');
  text = text.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?强力驱动(?:(?!<\/script>)[\s\S])*?<\/script>/gi, '');
  text = text.replace(/<div\b[^>]*id="edgeone-watermark"[^>]*>(?:(?!<\/div>)[\s\S])*?<\/div>/gi, '');
  return text;
}

// 把去水印样式/脚本注入任意 HTML（首页与代理页面都会带上）
function injectAntiWatermark(html) {
  const block = WATERMARK_CSS + WATERMARK_KILLER;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + block);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => m + block);
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, (m) => m + block);
  return block + html;
}

export async function onRequest(context) {
  return handle(context.request);
}

// ---------------- 工具函数 ----------------

const SKIP = /^(javascript:|data:|blob:|mailto:|tel:|about:|#|\/\/proxy|\/proxy\?|$)/i;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function proxiedUrl(absUrl, request) {
  const self = new URL(request.url);
  return `${self.origin}${PROXY_PATH}?url=` + encodeURIComponent(absUrl);
}

function resolveUrl(href, baseHref) {
  try {
    const abs = new URL(href.trim(), baseHref);
    return /^https?:$/.test(abs.protocol) ? abs.href : null;
  } catch (e) { return null; }
}

function replaceOriginStrings(text, target, request) {
  const re = new RegExp(
    '(?:https?:)?(?:\\\\?/){2}' + escapeRegExp(target.host) +
    '(?:\\\\?/[^\\s"\'<>`\\\\]*)?',
    'gi'
  );
  return text.replace(re, (m) => {
    let s = m, trail = '';
    const t = /,+$/.exec(s);
    if (t) { trail = t[0]; s = s.slice(0, -trail.length); }
    let norm = s.replace(/\\\//g, '/');
    if (norm.startsWith('//')) norm = target.protocol + norm;
    let abs;
    try { abs = new URL(norm).href; } catch (e) { return m; }
    return proxiedUrl(abs, request) + trail;
  });
}

// ---------------- HTML 改写 ----------------

function rewriteHtml(html, target, request) {
  const pageHref = target.href;

  let baseHref = null;
  html = html.replace(/<base\b[^>]*>/i, (m) => {
    const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m);
    const v = h && (h[1] || h[2] || h[3]);
    if (v) { try { baseHref = new URL(v, pageHref).href; } catch (e) {} }
    return '';
  });
  const resolveBase = baseHref || pageHref;

  const wrap = (href) => {
    if (!href || SKIP.test(href.trim())) return href;
    const abs = resolveUrl(href, resolveBase);
    return abs ? proxiedUrl(abs, request) : href;
  };

  html = html.replace(
    /(<[^>]+?\s)(href|src|action|poster|srcset|data-src|data-href|data-url|data-original|data-lazy-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (m, pre, attr, v1, v2) => {
      const val = v1 !== undefined ? v1 : v2;
      if (attr.toLowerCase() === 'srcset') {
        const rw = val.split(',').map((p) => {
          const parts = p.trim().split(/\s+/);
          if (parts[0]) parts[0] = wrap(parts[0]);
          return parts.join(' ');
        }).join(', ');
        return `${pre}${attr}="${rw}"`;
      }
      return `${pre}${attr}="${wrap(val)}"`;
    }
  );

  html = html.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,
    (tag) => tag.replace(/(url=)([^"'\s;>]+)/i, (m, p, u) => p + wrap(u)));

  html = html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) =>
    SKIP.test(u.trim()) ? m : `url(${q}${wrap(u)}${q})`);

  html = replaceOriginStrings(html, target, request);
  // 去水印：先剥离源页面已有的水印代码，再注入对策（防平台出站时再次注入）
  return injectAntiWatermark(stripWatermark(html));
}

function rewriteText(text, target, request) {
  text = text.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const abs = resolveUrl(u, target.href);
    return abs ? `@import ${q}${proxiedUrl(abs, request)}${q}` : m;
  });
  text = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const abs = SKIP.test(u.trim()) ? null : resolveUrl(u, target.href);
    return abs ? `url(${q}${proxiedUrl(abs, request)}${q})` : m;
  });
  return replaceOriginStrings(text, target, request);
}

// ---------------- 响应头处理 ----------------

const DROP_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'content-encoding', 'content-length', 'transfer-encoding', 'strict-transport-security',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'link', 'alt-svc', 'keep-alive',
]);

function cleanHeaders(src) {
  const h = new Headers();
  for (const [k, v] of src.entries()) {
    const lk = k.toLowerCase();
    if (lk === 'set-cookie' || DROP_HEADERS.has(lk)) continue;
    h.append(k, v);
  }
  let cookies = [];
  if (typeof src.getSetCookie === 'function') cookies = src.getSetCookie();
  else { const c = src.get('set-cookie'); if (c) cookies = [c]; }
  for (const c of cookies) {
    h.append('set-cookie',
      c.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*path=[^;]*/gi, '; Path=/'));
  }
  return h;
}

// ---------------- 首页（开始代理 + 复制连接） ----------------

function landingPage() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>网页代理</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e9ef}
.card{width:min(560px,92vw);background:#171a21;border:1px solid #262b36;border-radius:16px;padding:32px 28px;
  box-shadow:0 12px 40px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:22px}
.sub{margin:0 0 22px;font-size:13px;color:#8b93a5}
input{width:100%;padding:12px 14px;font-size:15px;color:#e6e9ef;background:#0f1115;
  border:1px solid #2d3442;border-radius:10px;outline:none}
input:focus{border-color:#4c7dff}
.btns{display:flex;gap:12px;margin-top:16px}
button{flex:1;padding:12px 0;font-size:15px;border:none;border-radius:10px;cursor:pointer;
  transition:filter .15s,transform .05s}
button:active{transform:scale(.98)}
.primary{background:#4c7dff;color:#fff}
.primary:hover{filter:brightness(1.12)}
.ghost{background:#242a36;color:#cdd4e0;border:1px solid #313848}
.ghost:hover{background:#2b3242}
.link{margin-top:16px;padding:10px 12px;font-size:12px;line-height:1.5;word-break:break-all;
  background:#0f1115;border:1px dashed #2d3442;border-radius:10px;color:#8b93a5}
.toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%) translateY(20px);
  background:#262b36;border:1px solid #3a4252;color:#e6e9ef;padding:10px 20px;border-radius:999px;
  font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:999999}
.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
${WATERMARK_CSS}${WATERMARK_KILLER}
</head>
<body>
<main class="card">
<h1>网页代理</h1>
<p class="sub">输入目标网址，可直接开始代理，或复制代理后的链接分享</p>
<form id="f" autocomplete="off">
<input id="u" type="text" placeholder="https://example.com" spellcheck="false">
<div class="btns">
<button type="submit" class="primary">开始代理</button>
<button type="button" class="ghost" id="c">复制连接</button>
</div>
</form>
<div class="link" id="l" hidden></div>
<div class="toast" id="t"></div>
</main>
<script>
(function(){
  var input=document.getElementById('u'),toast=document.getElementById('t'),linkBox=document.getElementById('l');
  function norm(v){v=(v||'').trim();if(!v||/^javascript:/i.test(v))return '';
    if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v))v='https://'+v;return v}
  function proxyUrl(v){var abs=norm(v);if(!abs)return '';
    try{var u=new URL(abs);if(!/^https?:$/.test(u.protocol))return '';
      return location.origin+'${PROXY_PATH}?url='+encodeURIComponent(u.href)}catch(e){return ''}}
  function show(v){var p=proxyUrl(v);linkBox.hidden=!p;if(p)linkBox.textContent=p}
  function say(m){toast.textContent=m;toast.classList.add('on');
    clearTimeout(say._t);say._t=setTimeout(function(){toast.classList.remove('on')},1600)}
  function fallbackCopy(t){var ta=document.createElement('textarea');ta.value=t;
    ta.style.cssText='position:fixed;left:-9999px;top:0';document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy')?say('已复制代理链接'):say('复制失败，请手动复制')}
    catch(e){say('复制失败，请手动复制')}document.body.removeChild(ta)}
  input.addEventListener('input',function(){show(input.value)});
  document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();
    var p=proxyUrl(input.value);if(!p){say('请输入有效的 http/https 网址');input.focus();return}
    location.href=p});
  document.getElementById('c').addEventListener('click',function(){
    var p=proxyUrl(input.value);if(!p){say('请输入有效的 http/https 网址');input.focus();return}
    show(input.value);
    if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){
      navigator.clipboard.writeText(p).then(function(){say('已复制代理链接')},function(){fallbackCopy(p)});
    }else fallbackCopy(p);
  });
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// ---------------- 主流程 ----------------

async function handle(request) {
  const incoming = new URL(request.url);

  const idx = request.url.indexOf('?url=');
  if (idx === -1) {
    // 首页与 /proxy 入口：展示带「开始代理 / 复制连接」按钮的页面
    if (incoming.pathname === '/' || incoming.pathname === PROXY_PATH ||
        incoming.pathname === PROXY_PATH + '/') {
      return landingPage();
    }
    return new Response('用法: /proxy?url=<目标URL>（url 参数放最后）', { status: 400 });
  }
  let targetStr = request.url.slice(idx + 5);
  if (/^https?%3A/i.test(targetStr)) {
    try { targetStr = decodeURIComponent(targetStr); } catch (e) {}
  }
  let target;
  try { target = new URL(targetStr); }
  catch (e) { return new Response('目标地址无效', { status: 400 }); }

  if (!/^https?:$/.test(target.protocol)) return new Response('只支持 http/https', { status: 403 });
  if (target.host === incoming.host) return new Response('禁止代理自身', { status: 403 });
  if (HOST_WHITELIST.length && !HOST_WHITELIST.includes(target.host)) {
    return new Response('目标不在白名单内', { status: 403 });
  }

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('accept-encoding');
  headers.set('referer', target.href);
  if (OVERRIDE_UA) headers.set('user-agent', OVERRIDE_UA);

  let resp;
  try {
    resp = await fetch(new Request(target.href, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    }));
  } catch (e) {
    return new Response('回源失败: ' + e.message, { status: 502 });
  }

  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    const loc = resp.headers.get('location');
    if (loc) {
      let abs;
      try { abs = new URL(loc, target).href; } catch (e) { abs = null; }
      if (abs) {
        return new Response(null, {
          status: resp.status,
          headers: { location: proxiedUrl(abs, request) },
        });
      }
    }
  }

  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  const isHtml = ctype.includes('text/html');
  const rewritable = REWRITE_TYPES.some((t) => ctype.includes(t));
  const outHeaders = cleanHeaders(resp.headers);

  if (!rewritable) {
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
  }

  let text = await resp.text();
  text = isHtml ? rewriteHtml(text, target, request) : rewriteText(text, target, request);
  return new Response(text, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
}
