'use strict';
/**
 * Bela Flor Links — encurtador com rotação de comerciais, UTMs e analytics.
 * Zero dependências: Node.js >= 22.13 (usa node:sqlite embutido).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  try { process.loadEnvFile(ENV_FILE); } catch (e) { console.warn('Falha ao ler .env:', e.message); }
}

const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (!APP_PASSWORD) {
  console.error('ERRO: defina APP_PASSWORD (no .env ou variável de ambiente).');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('bf-links:' + APP_PASSWORD).digest('hex');
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'links.db');
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES ?? -180); // Brasília = -180
const ROOT_REDIRECT = process.env.ROOT_REDIRECT || '';
const SESSION_DAYS = 30;
const STICKY_DAYS = Number(process.env.STICKY_DAYS || 90);
const PUBLIC_DIR = path.join(__dirname, 'public');

const RESERVED = new Set(['admin', 'api', 'assets', 'static', 'health', 'favicon.ico', 'robots.txt', 'login', 'logout']);
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck', 'coupon'];

function cleanUtm(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, 200);
  return s || null;
}

// ---------------------------------------------------------------- database
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL CHECK (type IN ('simple','rotator')),
  name TEXT NOT NULL DEFAULT '',
  target_url TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT, src TEXT, sck TEXT, coupon TEXT,
  sticky INTEGER NOT NULL DEFAULT 1,
  forward_params INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  rr_count INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  destination_id INTEGER,
  ts INTEGER NOT NULL,
  visitor_id TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  referer TEXT,
  device TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  sticky_hit INTEGER NOT NULL DEFAULT 0,
  query TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, is_bot, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_ts ON clicks(ts);
CREATE INDEX IF NOT EXISTS idx_dest_link ON destinations(link_id);
`);
// migrações: adiciona colunas novas em bancos já existentes
{
  const cols = new Set(db.prepare('PRAGMA table_info(links)').all().map((c) => c.name));
  if (!cols.has('coupon')) db.exec('ALTER TABLE links ADD COLUMN coupon TEXT');

  // UTMs recebidas em cada acesso (ex: /comercial?utm_source=facebook)
  const ccols = new Set(db.prepare('PRAGMA table_info(clicks)').all().map((c) => c.name));
  const missing = UTM_FIELDS.filter((f) => !ccols.has(f));
  if (missing.length) {
    for (const f of missing) db.exec(`ALTER TABLE clicks ADD COLUMN ${f} TEXT`);
    // preenche os cliques antigos a partir da query string já gravada
    const upd = db.prepare(`UPDATE clicks SET ${UTM_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`);
    db.exec('BEGIN');
    for (const r of db.prepare('SELECT id, query FROM clicks WHERE query IS NOT NULL').all()) {
      const sp = new URLSearchParams(r.query);
      upd.run(...UTM_FIELDS.map((f) => cleanUtm(sp.get(f))), r.id);
    }
    db.exec('COMMIT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_clicks_link_source ON clicks(link_id, utm_source)');

  // código do lead (vai na mensagem do WhatsApp) + modelo da mensagem
  if (!cols.has('wa_message')) db.exec('ALTER TABLE links ADD COLUMN wa_message TEXT');
  if (!ccols.has('lead_code')) db.exec('ALTER TABLE clicks ADD COLUMN lead_code TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_clicks_lead_code ON clicks(lead_code)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_clicks_visitor ON clicks(link_id, visitor_id)');
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const q = {
  linkBySlug: db.prepare('SELECT * FROM links WHERE slug = ?'),
  linkById: db.prepare('SELECT * FROM links WHERE id = ?'),
  slugTaken: db.prepare('SELECT id FROM links WHERE slug = ? AND id != ?'),
  activeDests: db.prepare('SELECT * FROM destinations WHERE link_id = ? AND deleted = 0 AND active = 1 AND weight > 0 ORDER BY position, id'),
  liveDests: db.prepare('SELECT * FROM destinations WHERE link_id = ? AND deleted = 0 ORDER BY position, id'),
  allDests: db.prepare('SELECT * FROM destinations WHERE link_id = ? ORDER BY deleted, position, id'),
  incRR: db.prepare('UPDATE destinations SET rr_count = rr_count + 1 WHERE id = ?'),
  insertClick: db.prepare(`INSERT INTO clicks (link_id, destination_id, ts, visitor_id, ip_hash, user_agent, referer, device, is_bot, sticky_hit, query, lead_code, ${UTM_FIELDS.join(', ')})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,${UTM_FIELDS.map(() => '?').join(',')})`),
  lastLeadCode: db.prepare(`SELECT lead_code FROM clicks WHERE link_id = ? AND visitor_id = ? AND destination_id IS ? AND lead_code IS NOT NULL
    ORDER BY id DESC LIMIT 1`),
  codeExists: db.prepare('SELECT 1 FROM clicks WHERE lead_code = ? LIMIT 1'),
};

// ---------------------------------------------------------------- helpers
// Robôs conhecidos (prévias de link, buscadores, ferramentas). Navegadores de apps
// (Instagram, Facebook, TikTok, Telegram, LinkedIn, Pinterest...) são pessoas.
const BOT_RE = /googlebot|bingbot|yandex(bot|images)|baiduspider|duckduckbot|applebot|slurp|facebookexternalhit|facebookcatalog|meta-external(agent|fetcher)|whatsapp\/|telegrambot|twitterbot|linkedinbot|discordbot|slackbot|pinterestbot|skypeuripreview|embedly|vkshare|redditbot|google-inspectiontool|adsbot|mediapartners|headlesschrome|lighthouse|petalbot|semrushbot|ahrefsbot|mj12bot|bytespider|gptbot|claudebot|ccbot|crawler|spider|\bbot\b|[a-z]bot\/\d/i;

function isBot(ua) {
  if (!ua) return true;
  if (!/^Mozilla\//.test(ua)) return true; // todo navegador real começa com Mozilla/
  return BOT_RE.test(ua);
}
/** Pré-carregamento (prefetch) do Facebook/Instagram/Chrome: não é um clique. */
function isPrefetch(req) {
  const h = req.headers;
  const v = [h['purpose'], h['sec-purpose'], h['x-purpose'], h['x-moz']].filter(Boolean).join(' ');
  return /prefetch|preview|prerender/i.test(v);
}
const PREFETCH_MARK = '_bfnav';
function deviceOf(ua = '') {
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/i.test(ua)) return 'mobile';
  return 'desktop';
}
function randomId(len = 16) { return crypto.randomBytes(len).toString('base64url').slice(0, len); }
function randomSlug(len = 6) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}
function hmac(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket.remoteAddress || '';
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}
function baseUrl(req) {
  if (BASE_URL) return BASE_URL;
  const proto = isHttps(req) ? 'https' : 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}
function cookie(name, value, { maxAge, httpOnly = true, secure = false } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
function readJson(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) return reject(Object.assign(new Error('Content-Type deve ser application/json'), { status: 415 }));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload muito grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }

/** Aceita URL completa, URL sem protocolo, ou número de WhatsApp (vira wa.me). */
function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  const digits = s.replace(/[\s()+\-.]/g, '');
  if (/^\d{10,15}$/.test(digits) && !/[a-z]/i.test(s)) return `https://wa.me/${digits}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  return u.toString();
}

// Datas no fuso configurado
const OFF_MS = TZ_OFFSET_MIN * 60_000;
const DAY_MS = 86_400_000;
function startOfLocalDay(daysAgo = 0) {
  const nowLocal = Date.now() + OFF_MS;
  return Math.floor(nowLocal / DAY_MS) * DAY_MS - daysAgo * DAY_MS - OFF_MS;
}
function rangeStart(days) { return days > 0 ? startOfLocalDay(days - 1) : 0; }
function localDayStr(ts) { return new Date(ts + OFF_MS).toISOString().slice(0, 10); }
function localDateTimeStr(ts) { return new Date(ts + OFF_MS).toISOString().replace('T', ' ').slice(0, 19); }

// ---------------------------------------------------------------- auth
const SESSION_COOKIE = 'bf_s';
function makeSession() {
  const exp = Date.now() + SESSION_DAYS * DAY_MS;
  return `${exp}.${hmac(String(exp))}`;
}
function isAuthed(req) {
  const tok = parseCookies(req)[SESSION_COOKIE];
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac(exp));
}
const loginAttempts = new Map();
function loginLimited(ip) {
  const now = Date.now();
  const a = loginAttempts.get(ip);
  if (!a || now - a.first > 15 * 60_000) { loginAttempts.set(ip, { first: now, n: 1 }); return false; }
  a.n++;
  return a.n > 10;
}

// ---------------------------------------------------------------- rotation
/**
 * Smooth weighted round-robin: escolhe o destino mais "atrasado" em relação
 * à sua cota. Garante a distribuição exata dos percentuais (não é sorteio).
 */
function pickDestination(dests) {
  const sumW = dests.reduce((s, d) => s + d.weight, 0);
  const total = dests.reduce((s, d) => s + d.rr_count, 0);
  let best = null, bestScore = -Infinity;
  for (const d of dests) {
    const score = (d.weight / sumW) * (total + 1) - d.rr_count;
    if (score > bestScore + 1e-9) { best = d; bestScore = score; }
  }
  return best;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newLeadCode() {
  for (let tries = 0; tries < 20; tries++) {
    const bytes = crypto.randomBytes(5);
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    if (!q.codeExists.get(c)) return c;
  }
  return randomSlug(8).toUpperCase();
}
const WA_HOSTS = new Set(['wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'whatsapp.com', 'www.whatsapp.com']);
function isWhatsappUrl(u) {
  try { return WA_HOSTS.has(new URL(u).hostname.toLowerCase()); } catch { return false; }
}
/** Troca {codigo}, {comercial}, {utm_source}... pelos valores do clique. */
function renderMessage(tpl, vars) {
  return tpl.replace(/\{\s*([a-z_]+)\s*\}/gi, (m, k) => {
    const key = k.toLowerCase();
    return key in vars ? (vars[key] || '') : m;
  }).replace(/[ \t]{2,}/g, ' ').trim();
}

function buildFinalUrl(target, link, incoming) {
  let u;
  try { u = new URL(target); } catch { return target; }
  for (const f of UTM_FIELDS) {
    if (link[f]) u.searchParams.set(f, link[f]);
  }
  if (link.forward_params && incoming) {
    for (const [k, v] of incoming) {
      if (!u.searchParams.has(k)) u.searchParams.append(k, v);
    }
  }
  return u.toString();
}

function handleRedirect(req, res, slug, searchParams) {
  const link = q.linkBySlug.get(slug);
  if (!link || !link.active) return notFound(res);

  const ua = String(req.headers['user-agent'] || '').slice(0, 400);
  const confirmedNav = searchParams.get(PREFETCH_MARK) === '1';
  searchParams.delete(PREFETCH_MARK);

  // Prefetch: responde uma página que só redireciona quando a pessoa realmente abrir.
  // Não conta clique, não consome a vez de nenhum comercial e não gera código.
  if (!confirmedNav && req.method === 'GET' && isPrefetch(req)) {
    try {
      q.insertClick.run(link.id, null, Date.now(), null, null, ua, '', deviceOf(ua), 2, 0, null, null, ...UTM_FIELDS.map((f) => cleanUtm(searchParams.get(f))));
    } catch (e) { console.error('Erro ao registrar prefetch:', e.message); }
    const sp = new URLSearchParams(searchParams);
    sp.set(PREFETCH_MARK, '1');
    const next = `/${encodeURIComponent(link.slug)}?${sp.toString()}`;
    const nextAttr = next.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${nextAttr}"><title>Redirecionando…</title></head>
<body><script>location.replace(${JSON.stringify(next)})</script><a href="${nextAttr}">Continuar</a></body></html>`,
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' });
  }

  const bot = req.method === 'HEAD' || isBot(ua);
  const cookies = parseCookies(req);
  const secure = isHttps(req);
  const setCookies = [];

  let vid = cookies.bf_vid;
  if (!vid || !/^[A-Za-z0-9_-]{8,32}$/.test(vid)) {
    vid = randomId(16);
    if (!bot) setCookies.push(cookie('bf_vid', vid, { maxAge: 400 * 86400, secure }));
  }

  let target, destId = null, stickyHit = 0;
  if (link.type === 'rotator') {
    const dests = q.activeDests.all(link.id);
    if (!dests.length) return notFound(res, 'Nenhum destino ativo para este link.');
    const stickyKey = `bf_r${link.id}`;
    let dest = null;
    if (bot) {
      dest = dests[0]; // prévias (WhatsApp, Facebook...) não consomem a rotação
    } else {
      if (link.sticky && cookies[stickyKey]) {
        dest = dests.find((d) => String(d.id) === cookies[stickyKey]) || null;
        if (dest) stickyHit = 1;
      }
      if (!dest) {
        dest = tx(() => {
          const fresh = q.activeDests.all(link.id);
          const d = pickDestination(fresh);
          q.incRR.run(d.id);
          return d;
        });
      }
      if (link.sticky) setCookies.push(cookie(stickyKey, String(dest.id), { maxAge: STICKY_DAYS * 86400, secure }));
    }
    destId = dest.id;
    target = dest.url;
  } else {
    target = link.target_url;
  }

  let finalUrl = buildFinalUrl(target, link, searchParams);
  const incomingUtm = Object.fromEntries(UTM_FIELDS.map((f) => [f, cleanUtm(searchParams && searchParams.get(f))]));

  // código do lead: o mesmo visitante no mesmo destino mantém o código
  let leadCode = null;
  if (!bot) {
    leadCode = q.lastLeadCode.get(link.id, vid, destId)?.lead_code || newLeadCode();
    if (link.wa_message && isWhatsappUrl(finalUrl)) {
      const destLabel = destId ? (q.activeDests.all(link.id).find((d) => d.id === destId)?.label || '') : '';
      const vars = { codigo: leadCode, comercial: destLabel, link: link.name };
      for (const f of UTM_FIELDS) vars[f] = incomingUtm[f] || link[f] || '';
      vars.cupom = vars.coupon;
      try {
        const u = new URL(finalUrl);
        u.searchParams.set('text', renderMessage(link.wa_message, vars));
        finalUrl = u.toString();
      } catch {}
    }
  }
  let refHost = '';
  try { if (req.headers.referer) refHost = new URL(req.headers.referer).hostname; } catch {}
  const ipHash = crypto.createHash('sha256').update(SESSION_SECRET + clientIp(req)).digest('hex').slice(0, 16);
  const query = searchParams && [...searchParams.keys()].length ? searchParams.toString().slice(0, 500) : null;

  try {
    q.insertClick.run(link.id, destId, Date.now(), vid, ipHash, ua, refHost, deviceOf(ua), bot ? 1 : 0, stickyHit, query, leadCode,
      ...UTM_FIELDS.map((f) => incomingUtm[f]));
  } catch (e) { console.error('Erro ao registrar clique:', e.message); }

  const headers = { Location: finalUrl, 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Referrer-Policy': 'no-referrer-when-downgrade' };
  if (setCookies.length) headers['Set-Cookie'] = setCookies;
  send(res, 302, '', headers);
}

function notFound(res, msg = 'Este link não existe ou foi desativado.') {
  send(res, 404, `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link não encontrado</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#faf7f8;color:#333}div{text-align:center;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#777;margin:0}</style></head>
<body><div><h1>Link não encontrado</h1><p>${msg}</p></div></body></html>`, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------- links CRUD
function validateLink(b, existingId = 0) {
  const type = b.type === 'rotator' ? 'rotator' : 'simple';
  const name = String(b.name || '').trim().slice(0, 120);
  let slug = String(b.slug || '').trim();
  if (!slug) {
    do { slug = randomSlug(6); } while (q.linkBySlug.get(slug));
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) throw badRequest('Slug inválido: use apenas letras, números, "-" e "_".');
  if (RESERVED.has(slug.toLowerCase())) throw badRequest(`O slug "${slug}" é reservado pelo sistema.`);
  if (q.slugTaken.get(slug, existingId)) throw badRequest(`O slug "${slug}" já está em uso.`);

  const out = {
    type, name: name || slug, slug,
    sticky: b.sticky === false ? 0 : 1,
    forward_params: b.forward_params === false ? 0 : 1,
    active: b.active === false ? 0 : 1,
    target_url: null,
    destinations: [],
  };
  for (const f of UTM_FIELDS) {
    const v = String((b.utm && b.utm[f]) ?? b[f] ?? '').trim().slice(0, 300);
    out[f] = v || null;
  }
  out.wa_message = String(b.wa_message || '').trim().slice(0, 1000) || null;

  if (type === 'simple') {
    const u = normalizeUrl(b.target_url);
    if (!u) throw badRequest('Informe uma URL de destino válida (http/https).');
    out.target_url = u;
  } else {
    const list = Array.isArray(b.destinations) ? b.destinations : [];
    if (!list.length) throw badRequest('Adicione pelo menos um destino na rotação.');
    if (list.length > 50) throw badRequest('Máximo de 50 destinos.');
    list.forEach((d, i) => {
      const label = String(d.label || '').trim().slice(0, 80) || `Comercial ${i + 1}`;
      const url = normalizeUrl(d.url);
      if (!url) throw badRequest(`URL inválida no destino "${label}".`);
      const weight = Number(d.weight);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1_000_000) throw badRequest(`Percentual inválido no destino "${label}".`);
      out.destinations.push({ id: Number(d.id) || null, label, url, weight, active: d.active === false ? 0 : 1, position: i });
    });
    if (!out.destinations.some((d) => d.active && d.weight > 0)) throw badRequest('Pelo menos um destino precisa estar ativo e com percentual maior que 0.');
  }
  return out;
}

function saveLink(data, id = null) {
  return tx(() => {
    const now = Date.now();
    const cols = ['slug', 'type', 'name', 'target_url', ...UTM_FIELDS, 'wa_message', 'sticky', 'forward_params', 'active'];
    const vals = cols.map((c) => data[c]);
    if (id) {
      db.prepare(`UPDATE links SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
    } else {
      const r = db.prepare(`INSERT INTO links (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`).run(...vals, now, now);
      id = Number(r.lastInsertRowid);
    }
    if (data.type === 'rotator') {
      const existing = new Map(q.liveDests.all(id).map((d) => [d.id, d]));
      const upd = db.prepare('UPDATE destinations SET label = ?, url = ?, weight = ?, active = ?, position = ?, rr_count = 0 WHERE id = ? AND link_id = ?');
      const ins = db.prepare('INSERT INTO destinations (link_id, label, url, weight, active, position) VALUES (?,?,?,?,?,?)');
      const kept = new Set();
      for (const d of data.destinations) {
        if (d.id && existing.has(d.id)) {
          upd.run(d.label, d.url, d.weight, d.active, d.position, d.id, id);
          kept.add(d.id);
        } else {
          ins.run(id, d.label, d.url, d.weight, d.active, d.position);
        }
      }
      // removidos: soft-delete para manter histórico dos cliques
      const del = db.prepare('UPDATE destinations SET deleted = 1, active = 0 WHERE id = ?');
      for (const dId of existing.keys()) if (!kept.has(dId)) del.run(dId);
      // zera contadores da rotação para que os novos percentuais valham a partir de agora
      db.prepare('UPDATE destinations SET rr_count = 0 WHERE link_id = ?').run(id);
    } else {
      db.prepare('UPDATE destinations SET deleted = 1, active = 0 WHERE link_id = ? AND deleted = 0').run(id);
    }
    return id;
  });
}

function linkPayload(link) {
  const out = { ...link, sticky: !!link.sticky, forward_params: !!link.forward_params, active: !!link.active, utm: {} };
  for (const f of UTM_FIELDS) out.utm[f] = link[f] || '';
  out.wa_message = link.wa_message || '';
  if (link.type === 'rotator') out.destinations = q.liveDests.all(link.id).map((d) => ({ ...d, active: !!d.active }));
  return out;
}

function listLinks() {
  const today = startOfLocalDay(0), d7 = rangeStart(7), d30 = rangeStart(30);
  const rows = db.prepare(`
    SELECT l.*,
      COALESCE(s.clicks,0) AS clicks, COALESCE(s.uniques,0) AS uniques,
      COALESCE(s.clicks_7d,0) AS clicks_7d, COALESCE(s.clicks_today,0) AS clicks_today,
      (SELECT COUNT(*) FROM destinations d WHERE d.link_id = l.id AND d.deleted = 0) AS dest_count
    FROM links l
    LEFT JOIN (
      SELECT link_id, COUNT(*) clicks, COUNT(DISTINCT visitor_id) uniques,
        SUM(ts >= ?) clicks_7d, SUM(ts >= ?) clicks_today
      FROM clicks WHERE is_bot = 0 GROUP BY link_id
    ) s ON s.link_id = l.id
    ORDER BY l.created_at DESC`).all(d7, today);
  const sum = db.prepare(`SELECT
      SUM(ts >= ?) today, SUM(ts >= ?) d7, SUM(ts >= ?) d30,
      COUNT(DISTINCT CASE WHEN ts >= ? THEN visitor_id END) uniques_30d
    FROM clicks WHERE is_bot = 0 AND ts >= ?`).get(today, d7, d30, d30, d30);
  return {
    summary: { today: sum.today || 0, d7: sum.d7 || 0, d30: sum.d30 || 0, uniques_30d: sum.uniques_30d || 0, links: rows.length },
    links: rows.map((r) => ({ ...linkPayload(r), clicks: r.clicks, uniques: r.uniques, clicks_7d: r.clicks_7d, clicks_today: r.clicks_today, dest_count: r.dest_count })),
  };
}

function linkStats(id, days) {
  const link = q.linkById.get(id);
  if (!link) return null;
  const since = rangeStart(days);
  const W = 'FROM clicks WHERE link_id = ? AND ts >= ? AND is_bot = 0';
  const totals = db.prepare(`SELECT COUNT(*) clicks, COUNT(DISTINCT visitor_id) uniques ${W}`).get(id, since);
  const bots = db.prepare('SELECT COUNT(*) n FROM clicks WHERE link_id = ? AND ts >= ? AND is_bot = 1').get(id, since).n;
  const prefetches = db.prepare('SELECT COUNT(*) n FROM clicks WHERE link_id = ? AND ts >= ? AND is_bot = 2').get(id, since).n;
  const ignoredUas = db.prepare(`SELECT is_bot kind, COALESCE(NULLIF(user_agent,''),'(sem user-agent)') ua, COUNT(*) n
    FROM clicks WHERE link_id = ? AND ts >= ? AND is_bot > 0 GROUP BY kind, ua ORDER BY n DESC LIMIT 12`).all(id, since);
  const stickyHits = db.prepare(`SELECT COUNT(*) n ${W} AND sticky_hit = 1`).get(id, since).n;
  const dayExpr = `strftime('%Y-%m-%d', (ts + ${OFF_MS}) / 1000, 'unixepoch')`;
  const daily = db.prepare(`SELECT ${dayExpr} day, COUNT(*) clicks, COUNT(DISTINCT visitor_id) uniques ${W} GROUP BY day ORDER BY day`).all(id, since);
  const referers = db.prepare(`SELECT COALESCE(NULLIF(referer,''),'(direto / app)') ref, COUNT(*) n ${W} GROUP BY ref ORDER BY n DESC LIMIT 10`).all(id, since);
  const devices = db.prepare(`SELECT device, COUNT(*) n ${W} GROUP BY device ORDER BY n DESC`).all(id, since);
  const hours = db.prepare(`SELECT CAST(strftime('%H', (ts + ${OFF_MS}) / 1000, 'unixepoch') AS INTEGER) h, COUNT(*) n ${W} GROUP BY h`).all(id, since);
  const recent = db.prepare(`SELECT ts, destination_id, device, referer, is_bot, sticky_hit, query, lead_code, ${UTM_FIELDS.join(', ')} FROM clicks WHERE link_id = ? ORDER BY id DESC LIMIT 40`).all(id);

  // UTMs recebidas no acesso: ranking por campo e por combinação source / medium / campaign
  const utmTagged = db.prepare(`SELECT COUNT(*) n ${W} AND (${UTM_FIELDS.map((f) => `${f} IS NOT NULL`).join(' OR ')})`).get(id, since).n;
  const utm = {};
  const isRot = link.type === 'rotator';
  for (const f of [...UTM_FIELDS, 'combo']) {
    const key = f === 'combo'
      ? "COALESCE(utm_source,'') || ' / ' || COALESCE(utm_medium,'') || ' / ' || COALESCE(utm_campaign,'')"
      : `COALESCE(${f},'')`;
    const rows = db.prepare(`SELECT ${key} v, COUNT(*) clicks, COUNT(DISTINCT visitor_id) uniques ${W} GROUP BY v ORDER BY clicks DESC LIMIT 30`).all(id, since);
    if (isRot && rows.length) {
      const idx = new Map(rows.map((r) => [r.v, Object.assign(r, { byDest: {} })]));
      for (const r of db.prepare(`SELECT ${key} v, destination_id d, COUNT(*) n ${W} GROUP BY v, d`).all(id, since)) {
        const row = idx.get(r.v);
        if (row) row.byDest[r.d] = r.n;
      }
    }
    utm[f] = f === 'combo' && rows.every((r) => r.v === ' /  / ') ? [] : rows;
  }

  // série diária completa (preenche dias sem clique)
  let firstDay;
  if (days > 0) firstDay = since;
  else {
    const f = db.prepare('SELECT MIN(ts) t FROM clicks WHERE link_id = ? AND is_bot = 0').get(id).t;
    firstDay = f ? Math.max(f, startOfLocalDay(364)) : startOfLocalDay(6);
  }
  const series = [];
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const firstDayStart = Math.floor((firstDay + OFF_MS) / DAY_MS) * DAY_MS - OFF_MS;
  for (let t = firstDayStart; t <= startOfLocalDay(0); t += DAY_MS) {
    const k = localDayStr(t);
    const d = byDay.get(k);
    series.push({ day: k, clicks: d ? d.clicks : 0, uniques: d ? d.uniques : 0, byDest: {} });
  }

  let destinations = [];
  if (link.type === 'rotator') {
    const all = q.allDests.all(id);
    const by = new Map(db.prepare(`SELECT destination_id, COUNT(*) clicks, COUNT(DISTINCT visitor_id) uniques, SUM(sticky_hit = 0) assigned ${W} GROUP BY destination_id`).all(id, since).map((r) => [r.destination_id, r]));
    const activeSum = all.filter((d) => !d.deleted && d.active).reduce((s, d) => s + d.weight, 0) || 1;
    destinations = all.map((d) => ({
      id: d.id, label: d.label, url: d.url, active: !!d.active, deleted: !!d.deleted, weight: d.weight,
      target_pct: !d.deleted && d.active ? (d.weight / activeSum) * 100 : 0,
      clicks: by.get(d.id)?.clicks || 0, uniques: by.get(d.id)?.uniques || 0, assigned: by.get(d.id)?.assigned || 0,
      since_edit: d.deleted ? null : d.rr_count,
    })).filter((d) => !d.deleted || d.clicks > 0);
    const seriesIdx = new Map(series.map((s) => [s.day, s]));
    for (const r of db.prepare(`SELECT ${dayExpr} day, destination_id, COUNT(*) n ${W} GROUP BY day, destination_id`).all(id, since)) {
      const s = seriesIdx.get(r.day);
      if (s) s.byDest[r.destination_id] = r.n;
    }
  }

  return {
    link: linkPayload(link), days,
    totals: { clicks: totals.clicks, uniques: totals.uniques, bots, prefetches, sticky_hits: stickyHits },
    ignored_uas: ignoredUas,
    series, destinations, referers, devices, utm, utm_tagged: utmTagged,
    hours: Array.from({ length: 24 }, (_, h) => hours.find((x) => x.h === h)?.n || 0),
    recent: recent.map((r) => ({ ...r, when: localDateTimeStr(r.ts) })),
  };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/**
 * Uma linha por lead (código): comercial que recebeu + UTMs do acesso.
 * linkId = null exporta todos os links.
 */
function leadRows(linkId, since = 0) {
  return db.prepare(`
    SELECT c.lead_code, c.ts first_ts, g.last_ts, g.n clicks, c.device, c.referer,
      l.name link_name, l.slug, l.type, l.target_url, d.label dest_label, d.url dest_url,
      ${UTM_FIELDS.map((f) => `c.${f}`).join(', ')}
    FROM (SELECT lead_code, MIN(id) first_id, MAX(ts) last_ts, COUNT(*) n FROM clicks
          WHERE is_bot = 0 AND lead_code IS NOT NULL AND ts >= ? ${linkId ? 'AND link_id = ?' : ''}
          GROUP BY lead_code) g
    JOIN clicks c ON c.id = g.first_id
    JOIN links l ON l.id = c.link_id
    LEFT JOIN destinations d ON d.id = c.destination_id
    ORDER BY c.id DESC`).all(...(linkId ? [since, linkId] : [since]));
}
function exportLeadsCsv(res, linkId, since) {
  const rows = leadRows(linkId, since);
  const head = ['codigo_lead', 'primeiro_acesso', 'ultimo_acesso', 'cliques', 'link', 'slug', 'comercial', 'destino_url', ...UTM_FIELDS, 'dispositivo', 'origem'];
  const lines = [head.join(';')];
  for (const r of rows) {
    lines.push([r.lead_code, localDateTimeStr(r.first_ts), localDateTimeStr(r.last_ts), r.clicks, r.link_name, r.slug,
      r.dest_label || '', r.dest_url || r.target_url || '', ...UTM_FIELDS.map((f) => r[f]), r.device, r.referer].map(csvCell).join(';'));
  }
  const name = linkId ? `leads-${q.linkById.get(linkId)?.slug || linkId}` : 'leads-todos';
  send(res, 200, '\uFEFF' + lines.join('\n'), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-${localDayStr(Date.now())}.csv"`,
    'Cache-Control': 'no-store',
  });
}

function exportCsv(res, id) {
  const link = q.linkById.get(id);
  if (!link) return json(res, 404, { error: 'Link não encontrado' });
  const dests = new Map(q.allDests.all(id).map((d) => [d.id, d.label]));
  const lines = [['data_hora', 'codigo_lead', 'destino', 'visitante', 'dispositivo', 'origem', 'bot', 'mesmo_comercial', ...UTM_FIELDS, 'parametros', 'user_agent'].join(';')];
  for (const r of db.prepare('SELECT * FROM clicks WHERE link_id = ? ORDER BY id').iterate(id)) {
    lines.push([localDateTimeStr(r.ts), r.lead_code, r.destination_id ? dests.get(r.destination_id) : link.target_url, r.visitor_id, r.device, r.referer, r.is_bot ? 'sim' : 'nao', r.sticky_hit ? 'sim' : 'nao', ...UTM_FIELDS.map((f) => r[f]), r.query, r.user_agent].map(csvCell).join(';'));
  }
  send(res, 200, '﻿' + lines.join('\n'), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="cliques-${link.slug}.csv"`,
    'Cache-Control': 'no-store',
  });
}

// ---------------------------------------------------------------- static
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ---------------------------------------------------------------- router
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (loginLimited(ip)) return json(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
    const body = await readJson(req);
    if (!safeEqual(String(body.password || ''), APP_PASSWORD)) return json(res, 401, { error: 'Senha incorreta.' });
    loginAttempts.delete(ip);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(SESSION_COOKIE, makeSession(), { maxAge: SESSION_DAYS * 86400, secure: isHttps(req) }) });
  }
  if (p === '/api/logout' && m === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
  }

  if (!isAuthed(req)) return json(res, 401, { error: 'Não autenticado' });

  if (p === '/api/me' && m === 'GET') return json(res, 200, { ok: true, base_url: baseUrl(req) });
  if (p === '/api/links' && m === 'GET') return json(res, 200, listLinks());
  if (p === '/api/leads.csv' && m === 'GET') {
    const days = parseInt(url.searchParams.get('days') ?? '0', 10) || 0;
    return exportLeadsCsv(res, null, rangeStart(days));
  }
  if (p === '/api/lookup' && m === 'GET') {
    const code = String(url.searchParams.get('code') || '').trim().replace(/^#/, '').toUpperCase();
    if (!code) return json(res, 400, { error: 'Informe o código' });
    const row = db.prepare(`
      SELECT c.lead_code, c.link_id, l.name link_name, l.slug, d.label dest_label, d.url dest_url, c.device, c.referer,
        ${UTM_FIELDS.map((f) => `c.${f}`).join(', ')},
        (SELECT MIN(ts) FROM clicks WHERE lead_code = c.lead_code) first_ts,
        (SELECT MAX(ts) FROM clicks WHERE lead_code = c.lead_code) last_ts,
        (SELECT COUNT(*) FROM clicks WHERE lead_code = c.lead_code) clicks
      FROM clicks c JOIN links l ON l.id = c.link_id LEFT JOIN destinations d ON d.id = c.destination_id
      WHERE c.lead_code = ? ORDER BY c.id LIMIT 1`).get(code);
    if (!row) return json(res, 404, { error: `Código ${code} não encontrado.` });
    return json(res, 200, { ...row, first: localDateTimeStr(row.first_ts), last: localDateTimeStr(row.last_ts) });
  }
  if (p === '/api/links' && m === 'POST') {
    const data = validateLink(await readJson(req));
    const id = saveLink(data);
    return json(res, 201, linkPayload(q.linkById.get(id)));
  }

  let mm;
  if ((mm = p.match(/^\/api\/links\/(\d+)(\/stats|\/clicks\.csv|\/leads\.csv|\/toggle)?$/))) {
    const id = Number(mm[1]);
    const sub = mm[2] || '';
    const link = q.linkById.get(id);
    if (!link) return json(res, 404, { error: 'Link não encontrado' });
    if (sub === '' && m === 'GET') return json(res, 200, linkPayload(link));
    if (sub === '' && m === 'PUT') {
      const data = validateLink(await readJson(req), id);
      saveLink(data, id);
      return json(res, 200, linkPayload(q.linkById.get(id)));
    }
    if (sub === '' && m === 'DELETE') {
      tx(() => {
        db.prepare('DELETE FROM clicks WHERE link_id = ?').run(id);
        db.prepare('DELETE FROM destinations WHERE link_id = ?').run(id);
        db.prepare('DELETE FROM links WHERE id = ?').run(id);
      });
      return json(res, 200, { ok: true });
    }
    if (sub === '/toggle' && m === 'POST') {
      db.prepare('UPDATE links SET active = 1 - active, updated_at = ? WHERE id = ?').run(Date.now(), id);
      return json(res, 200, linkPayload(q.linkById.get(id)));
    }
    if (sub === '/stats' && m === 'GET') {
      const days = Math.max(0, Math.min(3650, parseInt(url.searchParams.get('days') ?? '30', 10) || 0));
      return json(res, 200, linkStats(id, days));
    }
    if (sub === '/clicks.csv' && m === 'GET') return exportCsv(res, id);
    if (sub === '/leads.csv' && m === 'GET') {
      const days = parseInt(url.searchParams.get('days') ?? '0', 10) || 0;
      return exportLeadsCsv(res, id, rangeStart(days));
    }
  }
  return json(res, 404, { error: 'Rota não encontrada' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (p === '/admin' || p === '/admin/') return serveStatic(res, 'index.html');
    if (p.startsWith('/admin/')) return serveStatic(res, p.slice('/admin/'.length));
    if (p === '/health') return json(res, 200, { ok: true });
    if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain' });
    if (p === '/favicon.ico') return send(res, 204, '');
    if (p === '/') {
      if (ROOT_REDIRECT) return send(res, 302, '', { Location: ROOT_REDIRECT });
      return send(res, 302, '', { Location: '/admin' });
    }
    const slug = decodeURIComponent(p.slice(1).replace(/\/+$/, ''));
    if (/^[A-Za-z0-9_-]{1,64}$/.test(slug) && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleRedirect(req, res, slug, url.searchParams);
    }
    return notFound(res);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status >= 500 ? 'Erro interno' : e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bela Flor Links rodando em http://${HOST}:${PORT}  (painel: /admin)`);
});

function shutdown() { server.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
