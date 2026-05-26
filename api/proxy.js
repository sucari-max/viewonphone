const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const { URL } = require('url');

const MAX_REDIRECTS = 6;
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

function fetchUrl(targetUrl, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(targetUrl); } catch(e) { return reject(new Error('Invalid URL')); }

    const isHttps   = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     (parsed.pathname || '/') + (parsed.search || ''),
      method:   'GET',
      timeout:  20000,
      headers: {
        'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control':   'no-cache',
      },
    };

    const req = transport.request(opts, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('//'))        loc = parsed.protocol + loc;
        else if (loc.startsWith('/'))    loc = `${parsed.protocol}//${parsed.host}${loc}`;
        else if (!loc.startsWith('http')) loc = `${parsed.protocol}//${parsed.host}/${loc}`;
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

function decompress(buf, encoding) {
  return new Promise((resolve, reject) => {
    const enc = (encoding || '').toLowerCase();
    if (enc === 'gzip')    return zlib.gunzip(buf, (e,d) => e ? reject(e) : resolve(d));
    if (enc === 'deflate') return zlib.inflate(buf, (e,d) => e ? reject(e) : resolve(d));
    if (enc === 'br')      return zlib.brotliDecompress(buf, (e,d) => e ? reject(e) : resolve(d));
    resolve(buf);
  });
}

function rewriteHtml(html, finalUrl) {
  const parsed = new URL(finalUrl);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const base   = finalUrl.includes('?')
    ? finalUrl.substring(0, finalUrl.lastIndexOf('/', finalUrl.indexOf('?')) + 1)
    : finalUrl.endsWith('/') ? finalUrl : finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

  html = html.replace(/<meta[^>]+http-equiv=["']?\s*content-security-policy\s*["']?[^>]*\/?>/gi, '');

  const baseTag = `<base href="${base}">`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(\s[^>]*)?>/i, m => m + `\n  ${baseTag}`);
  } else {
    html = baseTag + '\n' + html;
  }

  html = html.replace(/(\s(?:src|href|action|data-src|data-href|poster)=["'])\/(?!\/)/gi, `$1${origin}/`);
  html = html.replace(/(url\(["']?)\/(?!\/)/gi, `$1${origin}/`);
  return html;
}

function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const reqUrl   = new URL(req.url, 'http://localhost');
  const targetUrl = reqUrl.searchParams.get('url');

  if (!targetUrl) {
    res.status(400).json({ error: 'Missing ?url= parameter' });
    return;
  }

  try {
    const { res: upstream, finalUrl } = await fetchUrl(targetUrl);

    const outHeaders = { 'Access-Control-Allow-Origin': '*' };
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (!STRIP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
    }

    const contentType = (upstream.headers['content-type'] || '').toLowerCase();
    const isHtml      = contentType.includes('text/html');
    const encoding    = upstream.headers['content-encoding'] || '';

    if (!isHtml) {
      res.writeHead(upstream.statusCode, outHeaders);
      upstream.pipe(res);
      return;
    }

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
    res.status(502).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:32px;text-align:center">
      <h2>⚠️ Could not load page</h2><p>${err.message}</p><code>${targetUrl}</code>
    </body></html>`);
  }
};
