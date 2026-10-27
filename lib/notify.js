'use strict';

/**
 * Powiadomienia mailowe o nowych komentarzach i odpowiedziach (wersja minimum: jeden adres
 * administratora z konfiguracji).
 *
 * Komentarze zbieramy per projekt i wysyłamy jednym mailem, gdy przez
 * NOTIFY_QUIET_MS nie przybył żaden nowy (domyślnie 4 min), ale nie później
 * niż NOTIFY_MAX_MS od pierwszego niewysłanego (domyślnie 15 min).
 * Stan to pole `notifiedUpTo` projektu (czas ostatniego komentarza, o którym
 * już powiadomiono) – po restarcie nic nie ginie i nic nie idzie dwa razy,
 * a nieudana wysyłka jest ponawiana później.
 *
 * Konfiguracja (zmienne środowiskowe):
 *   NOTIFY_EMAIL    adres odbiorcy – bez niego powiadomienia są wyłączone
 *   SMTP_HOST       domyślnie smtp.gmail.com
 *   SMTP_PORT       domyślnie 465 (SSL); 587 = STARTTLS
 *   SMTP_USER       login (np. adres Gmail)
 *   SMTP_PASS       hasło (dla Gmaila: hasło aplikacji)
 *   MAIL_FROM       nadawca, domyślnie SMTP_USER
 *   MAIL_TRANSPORT  "log" – zamiast wysyłki zapis do data/outbox/ (testy)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const nodemailer = require('nodemailer');

const store = require('./store');

const env = process.env;
const TO = String(env.NOTIFY_EMAIL || '').trim();
const MODE = String(env.MAIL_TRANSPORT || '').trim().toLowerCase() === 'log' ? 'log' : 'smtp';
const SMTP_HOST = String(env.SMTP_HOST || 'smtp.gmail.com').trim();
const SMTP_PORT = Number(env.SMTP_PORT || 465);
const SMTP_USER = String(env.SMTP_USER || '').trim();
const SMTP_PASS = String(env.SMTP_PASS || '');
const FROM = String(env.MAIL_FROM || SMTP_USER || 'design-review@localhost').trim();

const QUIET_MS = Number(env.NOTIFY_QUIET_MS) || 4 * 60 * 1000;
const MAX_MS = Number(env.NOTIFY_MAX_MS) || 15 * 60 * 1000;
const TICK_MS = Number(env.NOTIFY_TICK_MS) || 30 * 1000;
const RETRY_MS = 5 * 60 * 1000;
// Komentowanie jest publiczne – limit chroni skrzynkę przed zasypaniem.
const MAX_PER_HOUR = 20;

const OUTBOX_DIR = path.join(store.DATA_DIR, 'outbox');
const STATE_FILE = path.join(store.DATA_DIR, 'notify.json');

const enabled = Boolean(TO) && (MODE === 'log' || Boolean(SMTP_USER && SMTP_PASS));

let transport = null;
let baseUrl = '';
const pendingProjects = new Set(); // projekty, które mogą mieć niewysłane komentarze
const retryAt = new Map();          // projekt -> najwcześniejsza kolejna próba po błędzie
let sentTimes = [];                 // czasy wysyłek z ostatniej godziny
let ticking = false;

function getTransport() {
  if (transport) return transport;
  transport = MODE === 'log'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  return transport;
}

function status() {
  return {
    enabled,
    transport: MODE,
    to: enabled ? TO : null,
    quietMinutes: QUIET_MS / 60000,
    maxMinutes: MAX_MS / 60000,
  };
}

/**
 * Publiczny adres aplikacji do linków w mailach (PUBLIC_URL albo adres
 * z ostatniego żądania właściciela). Zapamiętujemy go na dysku, żeby maile
 * wysłane zaraz po restarcie też miały linki.
 */
function setBaseUrl(url) {
  const next = String(url || '').replace(/\/+$/, '');
  if (!next || next === baseUrl) return;
  baseUrl = next;
  if (enabled) {
    fsp.writeFile(STATE_FILE, JSON.stringify({ baseUrl }, null, 2), 'utf8')
      .catch((err) => console.error('[notify] nie udało się zapisać adresu aplikacji:', err.message));
  }
}

async function send(message) {
  const mail = Object.assign({ from: FROM, to: TO }, message);
  const info = await getTransport().sendMail(mail);
  if (MODE === 'log') {
    await fsp.mkdir(OUTBOX_DIR, { recursive: true });
    const file = path.join(OUTBOX_DIR, Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.json');
    await fsp.writeFile(file, JSON.stringify(Object.assign({ sentAt: Date.now() }, mail), null, 2), 'utf8');
    console.log(`[notify] (log) ${mail.subject} → ${path.relative(store.ROOT, file)}`);
  }
  return info;
}

/* ------------------------------ treść maila ------------------------------ */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageLabel(page) {
  try { return decodeURI(page); } catch { return page; }
}

/** Odmiana: „1 nowy komentarz”, „2 nowe komentarze”, „5 nowych komentarzy”. */
function countLabel(n, forms) {
  if (n === 1) return `1 ${forms[0]}`;
  const last = n % 10;
  const lastTwo = n % 100;
  return `${n} ${last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? forms[1] : forms[2]}`;
}

const COMMENT_FORMS = ['nowy komentarz', 'nowe komentarze', 'nowych komentarzy'];
const REPLY_FORMS = ['nowa odpowiedź', 'nowe odpowiedzi', 'nowych odpowiedzi'];

/** „2 nowe komentarze i 1 nowa odpowiedź” – tylko te części, które występują. */
function summary(items) {
  const comments = items.filter((i) => !i.reply).length;
  const replies = items.length - comments;
  const parts = [];
  if (comments) parts.push(countLabel(comments, COMMENT_FORMS));
  if (replies) parts.push(countLabel(replies, REPLY_FORMS));
  return parts.join(' i ');
}

/**
 * Mail zbiorczy. `items` to nowe wpisy: { comment } albo { comment, reply }.
 * Link prowadzi zawsze do komentarza (odpowiedzi są pod nim na liście).
 */
function buildDigest(project, items) {
  const viewUrl = baseUrl ? `${baseUrl}/v/${project.id}` : '';
  const linkFor = (c) => (viewUrl ? `${viewUrl}?c=${encodeURIComponent(c.id)}` : '');
  const what = summary(items);
  const subject = `[Design Review] ${what} – ${project.name}`;

  const textItems = items.map(({ comment: c, reply: r }) => {
    const lines = r
      ? [`• ${r.author} odpowiada na komentarz ${c.author} (${pageLabel(c.page)}):`,
        `  ${String(r.text).replace(/\n/g, '\n  ')}`,
        `  Komentarz: ${String(c.text).replace(/\s+/g, ' ').slice(0, 200)}`]
      : [`• ${c.author} (${pageLabel(c.page)}):`, `  ${String(c.text).replace(/\n/g, '\n  ')}`];
    if (!r && c.type === 'text' && c.anchor && c.anchor.text) lines.push(`  Fragment: „${c.anchor.text}”`);
    if (linkFor(c)) lines.push(`  ${linkFor(c)}`);
    return lines.join('\n');
  });
  const text = [
    `Projekt „${project.name}” – ${what}:`,
    '',
    textItems.join('\n\n'),
    '',
    viewUrl ? `Widok recenzji: ${viewUrl}` : '',
  ].join('\n').trim() + '\n';

  const htmlItems = items.map(({ comment: c, reply: r }) => {
    const link = linkFor(c)
      ? `<div style="margin-top:6px"><a href="${escapeHtml(linkFor(c))}" style="color:#4f46e5">Pokaż komentarz</a></div>`
      : '';
    if (r) {
      return '<li style="margin:0 0 14px">'
        + `<div><b>${escapeHtml(r.author)}</b> <span style="color:#6b7280">odpowiada na komentarz `
        + `${escapeHtml(c.author)} · ${escapeHtml(pageLabel(c.page))}</span></div>`
        + `<div style="margin-top:4px;white-space:pre-wrap">${escapeHtml(r.text)}</div>`
        + `<div style="margin:6px 0 0;padding-left:8px;border-left:2px solid #c7cbd6;color:#6b7280">${escapeHtml(String(c.text).slice(0, 300))}</div>`
        + link + '</li>';
    }
    const quote = c.type === 'text' && c.anchor && c.anchor.text
      ? `<div style="margin:6px 0 0;padding-left:8px;border-left:2px solid #c7cbd6;color:#6b7280">„${escapeHtml(c.anchor.text)}”</div>`
      : '';
    return '<li style="margin:0 0 14px">'
      + `<div><b>${escapeHtml(c.author)}</b> <span style="color:#6b7280">· ${escapeHtml(pageLabel(c.page))}</span></div>`
      + `<div style="margin-top:4px;white-space:pre-wrap">${escapeHtml(c.text)}</div>`
      + quote + link + '</li>';
  });
  const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#14161c">'
    + `<p>Projekt <b>${escapeHtml(project.name)}</b> – ${escapeHtml(what)}:</p>`
    + `<ul style="padding-left:18px">${htmlItems.join('')}</ul>`
    + (viewUrl ? `<p><a href="${escapeHtml(viewUrl)}" style="color:#4f46e5">Otwórz widok recenzji</a></p>` : '')
    + '</div>';

  return { subject, text, html };
}

/* ----------------------------- zbieranie i wysyłka ------------------------ */

/** Wywoływane po dodaniu komentarza lub odpowiedzi – projekt trafia do sprawdzenia. */
function commentAdded(projectId) {
  if (enabled) pendingProjects.add(projectId);
}

function underRateLimit(now) {
  sentTimes = sentTimes.filter((t) => now - t < 60 * 60 * 1000);
  return sentTimes.length < MAX_PER_HOUR;
}

/** Nowe komentarze i odpowiedzi (bez wpisów właściciela) po czasie `since`, od najstarszych. */
function newItems(comments, since) {
  const items = [];
  for (const c of comments) {
    if (!c) continue;
    if (c.createdAt > since && !c.byOwner) items.push({ comment: c, at: c.createdAt });
    for (const r of Array.isArray(c.replies) ? c.replies : []) {
      if (r && r.createdAt > since && !r.byOwner) items.push({ comment: c, reply: r, at: r.createdAt });
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

async function checkProject(projectId, now) {
  const project = store.getProject(projectId);
  if (!project) return false;
  const since = Number(project.notifiedUpTo) || 0;
  const items = newItems(await store.readComments(projectId), since);
  if (!items.length) return false;

  const first = items[0].at;
  const last = items[items.length - 1].at;
  if (now - last < QUIET_MS && now - first < MAX_MS) return true; // jeszcze czekamy
  if ((retryAt.get(projectId) || 0) > now) return true;
  if (!underRateLimit(now)) return true;

  try {
    await send(buildDigest(project, items));
    sentTimes.push(now);
    retryAt.delete(projectId);
    await store.updateProject(projectId, { notifiedUpTo: last });
    // Wpisy dodane w trakcie wysyłki zostaną na następną turę.
    return newItems(await store.readComments(projectId), last).length > 0;
  } catch (err) {
    console.error(`[notify] nie udało się wysłać powiadomienia (${project.name}):`, err.message);
    retryAt.set(projectId, now + RETRY_MS);
    return true;
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const id of Array.from(pendingProjects)) {
      const stillPending = await checkProject(id, now);
      if (!stillPending) pendingProjects.delete(id);
    }
  } catch (err) {
    console.error('[notify]', err);
  } finally {
    ticking = false;
  }
}

/**
 * Start: projekty bez `notifiedUpTo` (sprzed włączenia powiadomień) dostają
 * bieżący czas – stare komentarze nie wyjdą mailem. Pozostałe projekty trafiają
 * do sprawdzenia, bo mogły mieć niewysłane komentarze przed restartem.
 */
async function init() {
  if (!enabled) return status();
  try {
    const saved = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    if (!baseUrl && saved && typeof saved.baseUrl === 'string') baseUrl = saved.baseUrl;
  } catch {
    /* brak zapisanego adresu */
  }
  const now = Date.now();
  for (const project of store.listProjects()) {
    if (project.notifiedUpTo == null) await store.updateProject(project.id, { notifiedUpTo: now });
    else pendingProjects.add(project.id);
  }
  setInterval(tick, TICK_MS).unref();
  return status();
}

/** Mail testowy – do sprawdzenia konfiguracji z panelu. */
async function sendTest() {
  if (!enabled) throw new Error('Powiadomienia są wyłączone (brak NOTIFY_EMAIL albo danych SMTP).');
  await send({
    subject: '[Design Review] Testowe powiadomienie',
    text: 'To jest testowa wiadomość z Design Review – powiadomienia mailowe działają.\n',
    html: '<p>To jest testowa wiadomość z <b>Design Review</b> – powiadomienia mailowe działają.</p>',
  });
}

module.exports = { init, status, setBaseUrl, commentAdded, sendTest };
