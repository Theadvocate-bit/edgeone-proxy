// =============================================================
// EdgeOne Maker 边缘函数：全站反向代理（合并最终版）
// 入口：https://<你的域名>/proxy?url=<目标URL>
//       （url 必须放最后一个参数，目标自带的 ?query 不会被截断）
// 路由绑定：/proxy*
// =============================================================

const ACCESS_KEY = '';        // 访问密钥，强烈建议填写；留空则不校验
const HOST_WHITELIST = [];    // 目标域名白名单，如 ['example.com']；空数组 = 不限制
const PROXY_PATH = '/proxy';
const OVERRIDE_UA = '';       // 可选：固定 UA 反爬伪装，留空则沿用客户端真实 UA

// 只做文本改写的响应类型，其余类型（图片/字体/视频）流式透传
const REWRITE_TYPES = ['text/html', 'text/css', 'javascript', 'application/json'];

export async function onRequest(context) {
  return handle(context.request);
}

// ---------------- 工具函数 ----------------

// 不包装的地址：伪协议、锚点、已经是代理地址的
const SKIP = /^(javascript:|data:|blob:|mailto:|tel:|about:|#|\/\/proxy|\/proxy\?|$)/i;
const escapeRegExp = (s) => s.replace(/[.*+?^%%QQ_MATH_0%%&');

// 生成代理地址：/proxy?[key=xxx&]url=<编码后的绝对URL>
function proxiedUrl(absUrl, request) {
  const self = new URL(request.url);
  let prefix = `self.origin{PROXY_PATH}?`;
  if (ACCESS_KEY) prefix += `key=${ACCESS_KEY}&`;
  return prefix + 'url=' + encodeURIComponent(absUrl);
}

function resolveUrl(href, baseHref) {
  try {
    const abs = new URL(href.trim(), baseHref);
    return /^https?:$/.test(abs.protocol) ? abs.href : null;
  } catch (e) { return null; }
}

// 兜底：替换文本中出现的源站 URL（含 JS/JSON 里的转义形式 https:\/\/host\/x）
function replaceOriginStrings(text, target, request) {
  const re = new RegExp(
    '(?:https?:)?(?:\\\\?/){2}' + escapeRegExp(target.host) +
    '(?:\\\\?/[^\\s"\'<>`\\\\]*)?',
    'gi'
  );
  return text.replace(re, (m) => {
    let s = m, trail = '';
    const t = /,+$/.exec(s);                 // 去掉 JSON 数组里紧跟的逗号
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

  // 1. 提取并移除 <base>，相对路径按它解析
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

  // 2. URL 类属性改写（含懒加载属性与 srcset）
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
        return `pre{attr}="${rw}"`;
      }
      return `pre{attr}="${wrap(val)}"`;
    }
  );

  // 3. integrity 校验会让改写后的资源加载失败，移除
  html = html.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 4. <meta http-equiv="refresh"> 跳转改写
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,
    (tag) => tag.replace(/(url=)([^"'\s;>]+)/i, (m, p, u) => p + wrap(u)));

  // 5. CSS url(...)（style 标签与内联样式）
  html = html.replace(/url\s*(['"]?)([^'")]+)\1\s*/gi, (m, q, u) =>
    SKIP.test(u.trim()) ? m : `url(q{wrap(u)}${q})`);

  // 6. 兜底：内联 JS / JSON 数据中出现的源站绝对 URL
  return replaceOriginStrings(html, target, request);
}

// CSS / JS / JSON 文件改写
function rewriteText(text, target, request) {
  text = text.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const abs = resolveUrl(u, target.href);
    return abs ? `@import q{proxiedUrl(abs, request)}${q}` : m;
  });
  text = text.replace(/url\s*(['"]?)([^'")]+)\1\s*/gi, (m, q, u) => {
    const abs = SKIP.test(u.trim()) ? null : resolveUrl(u, target.href);
    return abs ? `url(q{proxiedUrl(abs, request)}${q})` : m;
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
  // Cookie 改写：去掉 Domain、Path 统一为 /，让登录态在代理域名下可用
  let cookies = [];
  if (typeof src.getSetCookie === 'function') cookies = src.getSetCookie();
  else { const c = src.get('set-cookie'); if (c) cookies = [c]; }
  for (const c of cookies) {
    h.append('set-cookie',
      c.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*path=[^;]*/gi, '; Path=/'));
  }
  return h;
}

// ---------------- 主流程 ----------------

async function handle(request) {
  const incoming = new URL(request.url);

  if (ACCESS_KEY && incoming.searchParams.get('key') !== ACCESS_KEY) {
    return new Response('Forbidden', { status: 403 });
  }

  // 解析目标地址：从原始 URL 字符串截取，目标自带的 query 不会丢
  const idx = request.url.indexOf('?url=');
  if (idx === -1) {
    return new Response('用法: /proxy?url=<目标URL>（url 参数放最后）', { status: 400 });
  }
  let targetStr = request.url.slice(idx + 5);
  if (/^https?%3A/i.test(targetStr)) {          // 兼容整体被编码的写法
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

  // 组装回源请求：保留客户端请求头，去掉 host，设置 referer
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('accept-encoding');            // 强制源站返回未压缩内容，避免解压兼容问题
  headers.set('referer', target.href);
  if (OVERRIDE_UA) headers.set('user-agent', OVERRIDE_UA);

  let resp;
  try {
    resp = await fetch(new Request(target.href, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',                       // 手动处理跳转，才能把 Location 改回代理地址
    }));
  } catch (e) {
    return new Response('回源失败: ' + e.message, { status: 502 });
  }

  // 30x 跳转：Location 改写为代理地址，对浏览器透明
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
    // 图片/字体/视频等二进制：流式透传
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
  }

  let text = await resp.text();
  text = isHtml ? rewriteHtml(text, target, request) : rewriteText(text, target, request);
  return new Response(text, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
}

// 若你的部署环境要求 Service Worker 风格，注释掉顶部的 export，改用：
// addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
