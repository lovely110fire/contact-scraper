/**
 * Contact Scraper — local HTTP server for n8n integration
 * Run: node scraper-server.js
 * POST http://localhost:3001/scrape  { url, row_number }
 */

'use strict';

const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const PORT  = Number(process.env.PORT) || 3002;

// Patterns that identify bot-protection challenge pages requiring JavaScript execution
const BOT_CHALLENGE_RE = /robot.challenge.screen|sgcaptcha|cf-challenge|cf_chl_prog|checking.your.browser|just a moment\.\.\.|security.check|ddos[\-\s]guard|please.enable.javascript.to.continue|enable javascript and cookies to continue|ray id\s*[0-9a-f]{16}/i;

// ── Fetch with redirect + meta-refresh following, cookies, and decompression ─
function fetchHtml(initialUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const cookies = {};  // simple cookie jar shared across this fetch chain

    function addCookies(headers) {
      const raw = headers['set-cookie'];
      if (!raw) return;
      (Array.isArray(raw) ? raw : [raw]).forEach(c => {
        const part = c.split(';')[0];
        const eq = part.indexOf('=');
        if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      });
    }
    function cookieHeader() {
      const s = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      return s || null;
    }

    function go(url, referer) {
      if (hops++ > 12) return reject(new Error('Too many redirects'));
      let p;
      try { p = new URL(url); } catch (e) { return reject(e); }
      const lib = p.protocol === 'https:' ? https : http;
      const hdrs = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': referer ? 'same-origin' : 'none',
        'sec-fetch-user': '?1',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      };
      if (referer) hdrs['Referer'] = referer;
      const ck = cookieHeader();
      if (ck) hdrs['Cookie'] = ck;

      const req = lib.request({
        hostname: p.hostname,
        port: p.port || (p.protocol === 'https:' ? 443 : 80),
        path: (p.pathname || '/') + p.search,
        method: 'GET',
        headers: hdrs,
        timeout: timeoutMs,
        rejectUnauthorized: false,
      }, (res) => {
        addCookies(res.headers);

        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          try { go(new URL(res.headers.location, url).toString(), url); } catch (e) { reject(e); }
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }

        // Decompress
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip')          stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate')  stream = res.pipe(zlib.createInflate());
        else if (enc === 'br' && zlib.createBrotliDecompress) stream = res.pipe(zlib.createBrotliDecompress());

        const bufs = []; let total = 0;
        stream.on('data', b => { total += b.length; if (total < 4e6) bufs.push(b); });
        stream.on('end', () => {
          const html = Buffer.concat(bufs).toString('utf8');

          // Follow <meta http-equiv="refresh"> (bot-detection handshake pages)
          if (html.length < 3000) {
            const m = html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*?;\s*([^"']+)["']/i)
                   || html.match(/content\s*=\s*["'][0-9]+;\s*url\s*=\s*([^"']+)["']/i);
            if (m) {
              const refreshUrl = m[1].trim();
              try { go(new URL(refreshUrl, url).toString(), url); return; } catch {}
            }
          }

          // Detect JavaScript bot-protection challenge pages (sgcaptcha, Cloudflare, DDoS-Guard)
          if (html.length < 80000 && BOT_CHALLENGE_RE.test(html)) {
            return reject(new Error('Bot-protected'));
          }

          resolve({ html, finalUrl: url });
        });
        stream.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', reject);
      req.end();
    }
    go(initialUrl);
  });
}

// ── URL helpers ─────────────────────────────────────────────────────────────
function normalizeInput(raw) {
  let u = String(raw || '').trim().replace(/^[<"']+|[>"',]+$/g, '');
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  try {
    const p = new URL(u);
    if (!/^[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/i.test(p.hostname) &&
        !/^\d{1,3}(\.\d{1,3}){3}$/.test(p.hostname)) return null;
    p.hostname = p.hostname.toLowerCase().replace(/^www\./, '');
    p.hash = '';
    return p.toString();
  } catch { return null; }
}

function fetchCandidates(url) {
  const list = [url];
  if (/^https:/i.test(url)) list.push(url.replace(/^https:/i, 'http:'));
  try {
    const p = new URL(url);
    if (!/^www\./i.test(p.hostname)) { p.hostname = 'www.' + p.hostname; list.push(p.toString()); }
  } catch {}
  return list;
}

// ── Decode helpers ───────────────────────────────────────────────────────────
function decodeNum(s) {
  return s
    .replace(/&#(\d{2,7});/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return m; } })
    .replace(/&#x([0-9a-fA-F]{2,6});/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
    .replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ');
}
function decodeJS(s) {
  if (!s.includes('\\')) return s;
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => { const c = parseInt(h, 16); return c >= 0x20 && c < 0xd800 ? String.fromCharCode(c) : ' '; })
    .replace(/\\\//g, '/');
}
function prepare(h) { return decodeJS(decodeNum(h)); }
function decodeEnt(s) {
  return decodeNum(s)
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function htmlToText(h) {
  return decodeEnt(h
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');
}

// ── Email extraction ─────────────────────────────────────────────────────────
const EMAIL_RE  = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?\.[A-Za-z]{2,24}/g;
const BAD_EXT   = /\.(png|jpe?g|gif|webp|svg|ico|bmp|css|js|json|xml|html?|php|pdf|mp4|mp3|woff2?|ttf|zip)$/i;
const BAD_DOM   = /(^|\.)(sentry\.io|wixpress\.com|wix\.com|example\.(com|org|net)|domain\.com|yourdomain\.com|test\.com|localhost|w3\.org|schema\.org|googleapis\.com|cloudflare\.com|adobe\.com|squarespace\.com)$/i;
const BAD_LOC   = /^(user|username|name|your|youremail|email|e?mail|abc|xyz|test|example|sample|someone|firstname|lastname|sentry)$/i;
// Domains that look legitimate but are common placeholder/template email domains
const SUSPECT_DOM = /^(info|email|mail|placeholder|yoursite|mysite|website|company|business|noreply)\.(com|net|org)$/i;

function isPlausibleEmail(raw) {
  const e = raw.toLowerCase();
  if (e.length > 100 || e.length < 6 || BAD_EXT.test(e)) return false;
  const [local, domain] = e.split('@');
  if (!local || !domain || BAD_DOM.test(domain) || BAD_LOC.test(local)) return false;
  if (/^\d+$/.test(local) || /\.\./.test(e)) return false;
  if (local.length >= 24 && /^[0-9a-f]+$/.test(local)) return false;
  return true;
}
function decodeCf(hex) {
  try {
    const k = parseInt(hex.substr(0, 2), 16); let o = '';
    for (let i = 2; i < hex.length; i += 2) o += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ k);
    return o;
  } catch { return ''; }
}
function deobfuscate(t) {
  return t
    .replace(/\s*[\(\[\{]\s*(at|@)\s*[\)\]\}]\s*/gi, '@')
    .replace(/\s*[\(\[\{]\s*(dot)\s*[\)\]\}]\s*/gi, '.')
    .replace(/\s+(at)\s+/gi, '@').replace(/\s+(dot)\s+/gi, '.');
}
function extractEmails(h) {
  const found = new Set();
  const push = v => {
    const e = String(v || '').trim().replace(/^[.,;:<>()\[\]'"\\\/]+|[.,;:<>()\[\]'"\\\/]+$/g, '');
    if (isPlausibleEmail(e)) found.add(e.toLowerCase());
  };
  const dec = prepare(h); let m;
  const mRe = /mailto:\s*([^"'>\s?&]+)/gi;
  while ((m = mRe.exec(dec))) { try { push(decodeURIComponent(m[1])); } catch { push(m[1]); } }
  const cRe = /data-cfemail\s*=\s*["']([0-9a-fA-F]+)["']/g;
  while ((m = cRe.exec(h))) push(decodeCf(m[1]));
  const cHRe = /\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g;
  while ((m = cHRe.exec(h))) push(decodeCf(m[1]));
  (dec.match(EMAIL_RE) || []).forEach(push);
  (deobfuscate(htmlToText(dec)).match(EMAIL_RE) || []).forEach(push);
  return [...found];
}

// ── Phone extraction ─────────────────────────────────────────────────────────
const PHONE_KW = /(phone|tel(?:efon|ephone)?|call|mobile|mob\.|cell|fax|whatsapp|hotline|contact|support)[^0-9+]{0,30}$/i;
function digitsOf(s) { return (s.match(/\d/g) || []).join(''); }
function normalizePhone(raw) {
  const t = String(raw).trim().replace(/[\s.\-]+$/, '');
  const plus = /^\+/.test(t.replace(/^[\s(]+/, ''));
  const d = digitsOf(t);
  if (d.length < 7 || d.length > 16) return null;
  if (/^(19|20)\d{6}$/.test(d) || /^(\d)\1{6,}$/.test(d)) return null;
  if (/^01234567/.test(d) || /^12345678/.test(d)) return null;
  return (plus ? '+' : '') + t.replace(/^\+/, '').replace(/\s{2,}/g, ' ').trim();
}
function extractPhones(h) {
  const out = new Map(); let m;
  const add = (raw, conf) => {
    const n = normalizePhone(raw); if (!n) return;
    const d = digitsOf(n); if (!conf && d.length < 9) return;
    const k = d.slice(-9);
    if (!out.has(k) || (conf && out.get(k).length > n.length)) out.set(k, n);
  };
  const dec = prepare(h);
  const tRe = /(?:tel|callto|whatsapp):(?:\/\/)?(?:send\?phone=)?(\+?)([0-9()\-.\s]{6,25})/gi;
  while ((m = tRe.exec(dec))) add(m[1] + m[2], true);
  const jRe = /"telephone"\s*:\s*"([^"]{6,30})"/gi;
  while ((m = jRe.exec(dec))) add(m[1], true);
  const text = htmlToText(dec);
  const phoneRe = /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{1,5}\)[\s.\-]?)?\d[\d\s().\-]{7,20}\d/g;
  while ((m = phoneRe.exec(text))) {
    const raw = m[0]; const bef = text.slice(Math.max(0, m.index - 40), m.index);
    const intl = /^\s*\+/.test(raw) || /\+\s*$/.test(bef);
    if (intl) add((intl && !/^\s*\+/.test(raw) ? '+' : '') + raw.trim(), false);
    else if (PHONE_KW.test(bef)) add(raw, false);
  }
  return [...out.values()];
}

// ── Social extraction ────────────────────────────────────────────────────────
const SOC_RULES = [
  { k: 'facebook',  h: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i,  b: /\/(sharer|share\.php|dialog|plugins|tr|help|policies)/i },
  { k: 'instagram', h: /(^|\.)instagram\.com$/i,                   b: /\/(p|reel|explore|accounts|share)\//i },
  { k: 'linkedin',  h: /(^|\.)linkedin\.com$/i,                    b: /\/(share|shareArticle|sharing|cws|pub\/dir|feed)/i },
  { k: 'twitter',   h: /(^|\.)((twitter|x)\.com)$/i,              b: /\/(intent|share|home|hashtag|search|i\/)/i },
  { k: 'youtube',   h: /(^|\.)youtube\.com$/i,                     b: /\/(watch|embed|results|shorts|playlist)/i },
  { k: 'tiktok',   h: /(^|\.)tiktok\.com$/i,                       b: /\/(video|discover|tag|share)/i },
];
const URL_IN_HTML = /(?:https?:)?\/\/[A-Za-z0-9._~%\-]+\.[A-Za-z]{2,24}(?:\/[^\s"'<>\\)]*)?/g;
function cleanSoc(u) {
  try {
    const p = new URL(u.startsWith('//') ? 'https:' + u : u);
    p.hash = ''; p.search = ''; p.protocol = 'https:';
    p.hostname = p.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
    let s = p.toString(); if (s.endsWith('/')) s = s.slice(0, -1); return s;
  } catch { return null; }
}
function extractSocials(h) {
  const b = {}; const dec = prepare(h); const seen = new Set();
  for (const raw of (dec.match(URL_IN_HTML) || [])) {
    const c = cleanSoc(raw); if (!c || seen.has(c)) continue; seen.add(c);
    let host; try { host = new URL(c).hostname.replace(/^www\./i, ''); } catch { continue; }
    const path = c.slice(c.indexOf(host) + host.length) || '/';
    for (const r of SOC_RULES) {
      if (!r.h.test(host) || path === '/' || r.b.test(path) || /\.(png|jpe?g|gif|svg|css|js)$/i.test(path)) continue;
      (b[r.k] || (b[r.k] = [])).push(c);
    }
  }
  const res = {}; for (const k of Object.keys(b)) res[k] = [...new Set(b[k])][0] || '';
  return res;
}

// ── Contact page finder ──────────────────────────────────────────────────────
const PAGE_HINTS = [
  { re: /contact|kontakt|contacto|contatti|get-in-touch|reach-us/i, score: 100 },
  { re: /impressum|imprint/i, score: 90 },
  { re: /about|about-us|who-we-are|our-story|company|team/i, score: 70 },
  { re: /support|helpdesk|customer-service/i, score: 60 },
  { re: /privacy|policy|terms|legal/i, score: 40 },
];
// (paths moved to ALWAYS_CHECK / DEEP_SCAN in processSite)

function registrableish(h) { const p = h.toLowerCase().replace(/^www\./, '').split('.'); return p.length <= 2 ? p.join('.') : p.slice(-3).join('.'); }
function sameSite(a, b) {
  try { const ha = new URL(a).hostname, hb = new URL(b).hostname; return registrableish(ha) === registrableish(hb) || ha.replace(/^www\./, '') === hb.replace(/^www\./, ''); } catch { return false; }
}
function findContactPages(html, baseUrl, limit) {
  const dec = prepare(html); const scored = new Map();
  const consider = (rawHref, label) => {
    const href = decodeEnt(rawHref).trim();
    if (!href || /^(mailto:|tel:|javascript:|data:|#)/i.test(href)) return;
    let abs; try { abs = new URL(href, baseUrl); } catch { return; }
    if (!/^https?:$/.test(abs.protocol) || !sameSite(abs.toString(), baseUrl)) return;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|css|js|xml|webp)$/i.test(abs.pathname)) return;
    abs.hash = ''; const key = abs.toString().replace(/\/$/, '');
    if (key === baseUrl.replace(/\/$/, '')) return;
    const hay = abs.pathname + ' ' + (label || ''); let score = 0;
    for (const hint of PAGE_HINTS) if (hint.re.test(hay)) score = Math.max(score, hint.score);
    if (!score) return;
    score -= Math.min(20, (abs.pathname.split('/').filter(Boolean).length - 1) * 5);
    if (!scored.has(key) || scored.get(key) < score) scored.set(key, score);
  };
  let m;
  const aRe = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
  while ((m = aRe.exec(dec))) consider(m[1], htmlToText(m[2]).trim().slice(0, 80));
  const hRe = /href\s*=\s*["']([^"'#][^"']*)["']/gi;
  while ((m = hRe.exec(dec))) consider(m[1], '');
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([u]) => u);
}

// ── Nav-section link extractor ───────────────────────────────────────────────
// Keywords that suggest a page might contain contact / legal information
const NAV_KEYWORD_RE = /\b(contact|email|reach|get.in.touch|kontakt|privacy|terms|legal|impressum|gdpr|cookies|about|company|who.we.are|team|info|information|support|help|faq|customer.service|enqui|enquir)\b/i;

function extractNavLinks(html, baseUrl) {
  // Collect raw HTML from semantic header/footer/nav tags
  const chunks = [];
  for (const tag of ['header', 'footer', 'nav']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]{0,20000}?)<\\/${tag}>`, 'gi');
    let m; while ((m = re.exec(html))) chunks.push(m[1]);
  }
  // Also grab divs/sections/uls whose id or class names suggest navigation
  const attrRe = /<(?:div|section|ul|aside)\b[^>]+(?:id|class)=['"][^'"]*\b(?:header|footer|nav|menu|navigation|site-top|site-bottom|main-menu|primary-menu|top-bar|bottom-bar|footer-links|header-links)\b[^'"]*['"]/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    chunks.push(html.slice(m.index, Math.min(html.length, m.index + 8000)));
  }
  if (!chunks.length) return [];   // no nav sections found

  const combined = prepare(chunks.join(' '));
  const links = [];
  const seen = new Set();
  const aRe = /<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  while ((m = aRe.exec(combined))) {
    const href = decodeEnt(m[1]).trim();
    const text = htmlToText(m[2]).trim().slice(0, 80);
    if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let abs; try { abs = new URL(href, baseUrl); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol) || !sameSite(abs.toString(), baseUrl)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|css|js|xml|webp|woff)$/i.test(abs.pathname)) continue;
    abs.hash = ''; abs.search = '';
    const key = abs.toString().replace(/\/$/, '');
    if (key === baseUrl.replace(/\/$/, '') || seen.has(key)) continue;
    seen.add(key);
    links.push({ url: key, text });
  }
  return links;
}

// URL paths that indicate a privacy / legal / policy page
// Emails found here are GDPR data-controller contacts — best candidates for Primary Email
const POLICY_PAGE_RE = /\/(privacy|polic(?:y|ies)|legal|terms|gdpr|impressum|imprint|disclaimer|datenschutz|cookie|notice|reglement)\b/i;

// ── Merge & scan ─────────────────────────────────────────────────────────────
function mergeFindings(acc, page, isPolicy) {
  for (const e of page.emails) {
    if (!acc.emails.includes(e)) acc.emails.push(e);
    if (isPolicy && !acc.policyEmails.includes(e)) acc.policyEmails.push(e);
  }
  for (const p of page.phones) { const d = digitsOf(p).slice(-9); if (!acc._phoneKeys.has(d)) { acc._phoneKeys.add(d); acc.phones.push(p); } }
  for (const k of Object.keys(page.socials)) { if (!acc.socials[k]) acc.socials[k] = page.socials[k]; }
}
function scanPage(html, url) {
  return { url, emails: extractEmails(html), phones: extractPhones(html), socials: extractSocials(html) };
}

// ── Primary email ─────────────────────────────────────────────────────────────
const ROLE_RANK = ['info', 'contact', 'hello', 'hi', 'sales', 'enquiries', 'inquiries', 'support', 'office', 'admin', 'team', 'mail', 'help', 'business'];
function pickPrimaryEmail(emails, policyEmails, siteUrl) {
  if (!emails.length) return '';
  let siteDomain = ''; try { siteDomain = new URL(siteUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
  const score = e => {
    const [local, domain] = e.split('@'); let s = 0;
    const onSiteDomain = siteDomain && (domain === siteDomain || siteDomain.endsWith('.' + domain) || domain.endsWith('.' + siteDomain));

    if (onSiteDomain) s += 100;

    // Role-address bonus only when on the site's own domain
    const roleIdx = ROLE_RANK.indexOf(local);
    if (roleIdx >= 0) {
      if (onSiteDomain) s += 60 - roleIdx;
      else              s -= 30;
    }

    if (/^(noreply|no-reply|donotreply|postmaster|webmaster|privacy|security)/.test(local)) s -= 70;
    if (/(newsletter|subscribe|unsubscribe|bounce|list)/.test(local)) s -= 30;
    if (/(gmail|yahoo|hotmail|outlook|live|icloud)\./.test(domain)) s += 10;
    if (SUSPECT_DOM.test(domain)) s -= 90;

    return s;
  };

  // Policy pages (privacy/terms/legal/impressum) contain GDPR data-controller emails —
  // prefer those as Primary Email; fall back to the full pool if none found.
  const pool = policyEmails.length ? policyEmails : emails;
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

// Pages always worth checking for a legal/GDPR contact email
const ALWAYS_CHECK = ['/policies/privacy-policy', '/privacy-policy', '/privacy', '/impressum', '/legal', '/terms'];
// Deep scan fallbacks when nothing found yet
const DEEP_SCAN    = ['/contact', '/contact-us', '/contactus', '/about', '/about-us', '/support'];

// ── Full multi-page crawl ────────────────────────────────────────────────────
async function processSite(inputUrl) {
  const start = normalizeInput(inputUrl);
  if (!start) return { emails: [], primaryEmail: '', phones: [], socials: {}, pagesVisited: 0, error: 'Invalid URL' };
  const acc = { emails: [], policyEmails: [], phones: [], socials: {}, _phoneKeys: new Set() };

  let home = null, homeError = '', botBlocked = false;
  for (const candidate of fetchCandidates(start)) {
    try { home = await fetchHtml(candidate, 22000); break; }
    catch (e) {
      const msg = String(e && e.message || e);
      if (msg === 'Bot-protected') botBlocked = true;
      else homeError = msg;
    }
  }
  if (!home) {
    const errMsg = botBlocked ? 'Bot-protected (needs manual check)' : ('Unreachable: ' + homeError);
    return { emails: [], primaryEmail: '', phones: [], socials: {}, pagesVisited: 0, error: errMsg };
  }

  // Detect Shopify password-protected stores
  // Final URL lands on /password, or the page has a password-gate form
  const homePathname = (() => { try { return new URL(home.finalUrl).pathname; } catch { return ''; } })();
  if (homePathname === '/password' ||
      /<form[^>]+action=["']\/password["']/i.test(home.html) ||
      /enter.*store.*using.*password|password.protected.store|storefront.password.required/i.test(home.html)) {
    return { emails: [], primaryEmail: '', phones: [], socials: {}, pagesVisited: 0, error: 'Password Protected' };
  }

  mergeFindings(acc, scanPage(home.html, home.finalUrl));
  let pagesVisited = 1;
  const visited = new Set([home.finalUrl.replace(/\/$/, '')]);

  // Helper: fetch one page and merge if same site, ignoring errors.
  // isPolicy auto-detected from final URL path; can be forced true by caller.
  const visitPage = async (url, timeoutMs) => {
    try {
      const r = await fetchHtml(url, timeoutMs);
      const key = r.finalUrl.replace(/\/$/, '');
      if (sameSite(r.finalUrl, home.finalUrl) && !visited.has(key)) {
        visited.add(key);
        let finalPath = '';
        try { finalPath = new URL(r.finalUrl).pathname; } catch {}
        const isPolicy = POLICY_PAGE_RE.test(finalPath);
        mergeFindings(acc, scanPage(r.html, r.finalUrl), isPolicy);
        pagesVisited++;
      }
    } catch {}
  };

  // Build nav-link pool from header/footer/nav sections once and reuse across steps
  const navLinks = extractNavLinks(home.html, home.finalUrl);

  // Step 1: top contact/about pages discovered from scored link scan (up to 5)
  const targets = findContactPages(home.html, home.finalUrl, 5);
  for (const page of targets) await visitPage(page, 18000);

  // Step 2: always try hardcoded privacy/impressum/legal paths
  for (const path of ALWAYS_CHECK) {
    let url; try { url = new URL(path, home.finalUrl).toString(); } catch { continue; }
    const key = url.replace(/\/$/, '');
    if (visited.has(key)) continue;
    visited.add(key);
    await visitPage(url, 15000);
  }

  // Step 2.5: nav-link keyword scan — visit header/footer links whose URL or text
  // contains any single contact/legal keyword (catches custom paths like /privacy-at-petro)
  {
    let tries = 0;
    for (const { url, text } of navLinks) {
      if (tries >= 6) break;
      if (visited.has(url)) continue;
      // Match keyword in URL path or link text
      const hay = url + ' ' + text;
      if (!NAV_KEYWORD_RE.test(hay)) continue;
      visited.add(url); tries++;
      await visitPage(url, 15000);
    }
  }

  // Step 3: if still no emails, try hardcoded contact/about/support paths
  if (!acc.emails.length) {
    let tries = 0;
    for (const path of DEEP_SCAN) {
      if (tries >= 3) break;
      let url; try { url = new URL(path, home.finalUrl).toString(); } catch { continue; }
      const key = url.replace(/\/$/, '');
      if (visited.has(key)) continue;
      visited.add(key); tries++;
      await visitPage(url, 15000);
    }
  }

  // Step 4: last resort — if still nothing, visit ALL remaining nav links (cap 8)
  if (!acc.emails.length && navLinks.length) {
    let tries = 0;
    for (const { url } of navLinks) {
      if (tries >= 8) break;
      if (visited.has(url)) continue;
      visited.add(url); tries++;
      await visitPage(url, 15000);
    }
  }

  return { emails: acc.emails, primaryEmail: pickPrimaryEmail(acc.emails, acc.policyEmails, home.finalUrl), phones: acc.phones, socials: acc.socials, pagesVisited, error: '' };
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const send = (data) => {
    const body = JSON.stringify(data);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    send({ status: 'ok', port: PORT }); return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // Debug: fetch one URL and report what the server actually receives
  if (req.method === 'GET' && parsedUrl.pathname === '/debug') {
    const targetUrl = parsedUrl.searchParams.get('url') || '';
    if (!targetUrl) { res.writeHead(400); res.end('?url= required'); return; }
    (async () => {
      try {
        const r = await fetchHtml(targetUrl, 20000);
        const html = r.html;
        const mailtoIdx = html.indexOf('mailto:');
        const emailRegex = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
        const rawEmails = (html.match(emailRegex) || []).slice(0, 20);
        const snippet = mailtoIdx >= 0 ? html.slice(Math.max(0, mailtoIdx - 30), mailtoIdx + 80) : 'NOT FOUND';
        send({
          finalUrl: r.finalUrl,
          htmlLength: html.length,
          first500: html.slice(0, 500),
          mailtoFound: mailtoIdx >= 0,
          mailtoSnippet: snippet,
          rawEmailMatches: rawEmails,
          extractedEmails: extractEmails(html),
        });
      } catch (e) { send({ error: String(e && e.message || e) }); }
    })();
    return;
  }

  // Accept both GET /scrape?url=...&row_number=... and POST /scrape {url, row_number}
  if (parsedUrl.pathname === '/scrape') {
    const handle = async (url, row_number) => {
      if (!url || !url.trim()) {
        send({ row_number, 'Primary Email': '', Emails: '', 'Website Phone': '', Facebook: '', Instagram: '', LinkedIn: '', Twitter: '', YouTube: '', TikTok: '', _Status: 'No URL' });
        return;
      }
      console.log(`[${new Date().toLocaleTimeString()}] Scraping: ${url}`);
      let data;
      try { data = await processSite(url); } catch (e) { data = { emails: [], primaryEmail: '', phones: [], socials: {}, pagesVisited: 0, error: String(e && e.message || e) }; }
      const status = data.error || ('OK - ' + data.pagesVisited + ' page(s), ' + data.emails.length + ' email(s)');
      console.log(`[${new Date().toLocaleTimeString()}]   → ${status}`);
      send({
        row_number,
        'Primary Email': data.primaryEmail,
        Emails:          data.emails.join(', '),
        'Website Phone': data.phones.join(', '),
        Facebook:        data.socials.facebook  || '',
        Instagram:       data.socials.instagram || '',
        LinkedIn:        data.socials.linkedin  || '',
        Twitter:         data.socials.twitter   || '',
        YouTube:         data.socials.youtube   || '',
        TikTok:          data.socials.tiktok    || '',
        _Status:         status,
      });
    };

    if (req.method === 'GET') {
      const url = parsedUrl.searchParams.get('url') || '';
      const row_number = parsedUrl.searchParams.get('row_number') || '';
      handle(url, row_number);
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        let url = '', row_number = '';
        try { const p = JSON.parse(body); url = p.url || ''; row_number = p.row_number || ''; } catch {}
        handle(url, row_number);
      });
    } else {
      res.writeHead(405); res.end('Method not allowed');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ERROR: Port ${PORT} is already in use.`);
    console.error('  Another instance of this server is still running.');
    console.error('  Close it first (find the other Command Prompt window and press Ctrl+C),');
    console.error('  or run this command to free the port:');
    console.error(`    PowerShell -Command "Stop-Process -Id (netstat -ano | Select-String ':${PORT}.*LISTENING' | ForEach-Object { ($_ -split '\\s+')[-1] } | Select-Object -First 1) -Force"`);
    console.error('');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Contact Scraper Server');
  console.log(`  Running on http://localhost:${PORT}`);
  console.log('  GET  /scrape?url=https://example.com&row_number=2');
  console.log('  POST /scrape  { "url": "...", "row_number": 2 }');
  console.log('  GET  /health');
  console.log('');
});
