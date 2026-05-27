/**
 * ViewOnPhone — Proxy Server
 * Serves index.html on / and proxies any URL via /proxy?url=...
 * Strips X-Frame-Options / CSP headers so every site loads in the iframe.
 */

const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const PORT       = 3041;
const STATIC_DIR = __dirname;
const MAX_REDIRECTS = 6;

// ─── static mime types ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

// ─── headers to strip from proxied responses ─────────────────────────────────
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

// ─── fetch with redirect following ───────────────────────────────────────────
function fetchUrl(targetUrl, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > MAX_REDIRECTS) return reject(new Error('Too many redirects'));

    let parsed;
    try { parsed = new URL(targetUrl); }
    catch(e) { return reject(new Error('Invalid URL: ' + targetUrl)); }

    const isHttps  = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || defaultPort,
      path:     (parsed.pathname || '/') + (parsed.search || ''),
      method:   'GET',
      timeout:  18000,
      headers: {
        'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control':   'no-cache',
        'Pragma':          'no-cache',
      },
    };

    const req = transport.request(reqOpts, res => {
      // follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('//'))          loc = parsed.protocol + loc;
        else if (loc.startsWith('/'))       loc = `${parsed.protocol}//${parsed.host}${loc}`;
        else if (!loc.startsWith('http'))   loc = `${parsed.protocol}//${parsed.host}/${loc}`;
        res.resume();
        return resolve(fetchUrl(loc, hops + 1));
      }
      resolve({ res, finalUrl: targetUrl });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── decompress response body ─────────────────────────────────────────────────
function decompress(buf, encoding) {
  return new Promise((resolve, reject) => {
    const enc = (encoding || '').toLowerCase();
    if (enc === 'gzip')    return zlib.gunzip(buf, (e,d) => e ? reject(e) : resolve(d));
    if (enc === 'deflate') return zlib.inflate(buf, (e,d) => e ? reject(e) : resolve(d));
    if (enc === 'br')      return zlib.brotliDecompress(buf, (e,d) => e ? reject(e) : resolve(d));
    resolve(buf);
  });
}

// ─── rewrite HTML so resources load from the original origin ─────────────────
function rewriteHtml(html, finalUrl) {
  const parsed  = new URL(finalUrl);
  const origin  = `${parsed.protocol}//${parsed.host}`;
  // base = directory of the page
  const base    = finalUrl.includes('?')
    ? finalUrl.substring(0, finalUrl.lastIndexOf('/', finalUrl.indexOf('?')) + 1)
    : finalUrl.endsWith('/')
      ? finalUrl
      : finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

  // 1. Remove inline CSP meta tags
  html = html.replace(/<meta[^>]+http-equiv=["']?\s*content-security-policy\s*["']?[^>]*\/?>/gi, '');

  // 2. Inject <base> tag right after <head> (or <HEAD>)
  const baseTag = `<base href="${base}">`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(\s[^>]*)?>/i, m => m + `\n  ${baseTag}`);
  } else if (/<!doctype/i.test(html)) {
    html = html.replace(/<html(\s[^>]*)?>/i, m => m + `\n<head>${baseTag}</head>`);
  } else {
    html = baseTag + '\n' + html;
  }

  // 3. Rewrite absolute-path attributes (src="/..." href="/..." etc.)
  //    so they point to the original server instead of localhost
  const attrsRe = /(\s(?:src|href|action|data-src|data-href|poster|srcset)=["'])\/(?!\/)/gi;
  html = html.replace(attrsRe, `$1${origin}/`);

  // 4. Rewrite CSS url('/...') absolute paths
  html = html.replace(/(url\(["']?)\/(?!\/)/gi, `$1${origin}/`);

  // 5. Inject comprehensive navigation interceptor
  const navScript = `\n<script data-vop="nav">
(function(){
  var _base=${JSON.stringify(finalUrl)};
  var _pp='/proxy?url=';
  // ── Save originals BEFORE any override ──
  var _oReplace=Location.prototype.replace;
  var _oAssign=Location.prototype.assign;
  var _hDesc=Object.getOwnPropertyDescriptor(Location.prototype,'href');

  function skip(u){
    if(!u||typeof u!=='string')return true;
    var t=u.trim();
    return /^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(t);
  }
  function isAlreadyProxy(u){ return typeof u==='string'&&u.indexOf(_pp)===0; }

  function go(u){
    if(skip(u)||isAlreadyProxy(u))return;
    try{
      var abs=new URL(u,_base).href;
      if(!abs.startsWith('http'))return;
      _oReplace.call(location,_pp+encodeURIComponent(abs));
    }catch(e){}
  }

  // 1. <a href> clicks — capture phase runs before page handlers
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(!a)return;
    var h=a.getAttribute('href')||'';
    if(skip(h))return;
    e.preventDefault();e.stopPropagation();go(h);
  },true);

  // 2. GET form submissions
  document.addEventListener('submit',function(e){
    var f=e.target;
    if((f.getAttribute('method')||'get').toLowerCase()==='post')return;
    e.preventDefault();e.stopPropagation();
    var q=new URLSearchParams(new FormData(f)).toString();
    var a=f.getAttribute('action')||_base;
    go(a+(q?(a.indexOf('?')>=0?'&':'?')+q:''));
  },true);

  // 3. window.location.href = '...'
  try{
    Object.defineProperty(Location.prototype,'href',{
      get:_hDesc.get,
      set:function(u){ isAlreadyProxy(u)?_hDesc.set.call(this,u):go(u); },
      configurable:true,enumerable:_hDesc.enumerable
    });
  }catch(e){}

  // 4. location.assign() and location.replace()
  try{
    Location.prototype.assign=function(u){ isAlreadyProxy(u)?_oAssign.call(this,u):go(u); };
    Location.prototype.replace=function(u){ isAlreadyProxy(u)?_oReplace.call(this,u):go(u); };
  }catch(e){}

  // 5. window.open() — open in same iframe via proxy
  try{
    var _oOpen=window.open;
    window.open=function(u,t,f){
      if(u&&!skip(u)){go(u);return null;}
      return _oOpen?_oOpen.call(window,u,t,f):null;
    };
  }catch(e){}
})();
<\/script>`;

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, navScript + '\n</head>');
  } else {
    html = navScript + html;
  }

  return html;
}

// ─── collect stream into buffer ───────────────────────────────────────────────
function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ─── serve a static file ──────────────────────────────────────────────────────
function serveStatic(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ─── main server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let reqUrl;
  try { reqUrl = new URL(req.url, `http://localhost:${PORT}`); }
  catch(e) { res.writeHead(400); res.end('Bad request'); return; }

  // ── static files ──
  if (reqUrl.pathname !== '/proxy') {
    const reqPath  = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
    const filePath = path.join(STATIC_DIR, reqPath.replace(/\.\./g, ''));
    serveStatic(filePath, res);
    return;
  }

  // ── proxy ──
  const targetUrl = reqUrl.searchParams.get('url');
  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
    return;
  }

  try {
    const { res: upstream, finalUrl } = await fetchUrl(targetUrl);

    // build outgoing headers
    const outHeaders = { 'Access-Control-Allow-Origin': '*' };
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (!STRIP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
    }

    const contentType = (upstream.headers['content-type'] || '').toLowerCase();
    const isHtml      = contentType.includes('text/html');
    const encoding    = upstream.headers['content-encoding'] || '';

    if (!isHtml) {
      // binary/css/js: pipe straight through
      res.writeHead(upstream.statusCode, outHeaders);
      upstream.pipe(res);
      return;
    }

    // HTML: collect → decompress → rewrite → send
    const rawBuf = await collectBody(upstream);
    let bodyBuf;
    try   { bodyBuf = await decompress(rawBuf, encoding); }
    catch { bodyBuf = rawBuf; }

    let html = bodyBuf.toString('utf-8');
    html = rewriteHtml(html, finalUrl);

    delete outHeaders['content-encoding'];
    delete outHeaders['content-length'];
    outHeaders['content-type'] = 'text/html; charset=utf-8';

    res.writeHead(upstream.statusCode, outHeaders);
    res.end(html);

  } catch(err) {
    const errHtml = `<!DOCTYPE html>
<html><head><style>
body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#f9fafb;}
.box{text-align:center;padding:32px;max-width:360px;}
.icon{font-size:48px;margin-bottom:16px;}
h2{color:#1f2937;margin:0 0 8px;}
p{color:#6b7280;font-size:14px;margin:0 0 20px;line-height:1.5;}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all;}
</style></head><body>
<div class="box">
  <div class="icon">⚠️</div>
  <h2>Could not load page</h2>
  <p>${err.message}</p>
  <code>${targetUrl}</code>
</div></body></html>`;
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(errHtml);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the existing process and try again.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅ ViewOnPhone proxy running → http://localhost:${PORT}\n`);
});
