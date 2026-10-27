'use strict';

/**
 * Powiadomienia mailowe:
 *  - administrator (NOTIFY_EMAIL) – o nowych komentarzach i odpowiedziach,
 *  - uczestnicy wątków, którzy podali e-mail albo zostali wspomniani –
 *    o nowych odpowiedziach w ich wątkach i o wzmiankach (z linkiem do
 *    wypisania się; adresy w lib/subscribers.js).
 *
 * Komentarze zbieramy per projekt i wysyłamy jednym mailem, gdy przez
 * NOTIFY_QUIET_MS nie przybył żaden nowy (domyślnie 4 min), ale nie później
 * niż NOTIFY_MAX_MS od pierwszego niewysłanego (domyślnie 15 min).
 * Stan to pole `notifiedUpTo` projektu (czas ostatniego komentarza, o którym
 * już powiadomiono) – po restarcie nic nie ginie i nic nie idzie dwa razy,
 * a nieudana wysyłka jest ponawiana później.
 *
 * Konfiguracja (zmienne środowiskowe):
 *   NOTIFY_EMAIL    adres administratora – bez niego jego powiadomienia są wyłączone
 *                   (powiadomienia uczestników działają, gdy jest skonfigurowany SMTP)
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
const subscribers = require('./subscribers');
const mentions = require('./mentions');

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
// Komentowanie jest publiczne – limity chronią skrzynki przed zasypaniem.
const MAX_PER_HOUR = 20;               // administrator
const PARTICIPANT_MAX_PER_HOUR = 60;   // wszyscy uczestnicy razem
const PER_ADDRESS_PER_DAY = 10;        // jeden adres uczestnika

const OUTBOX_DIR = path.join(store.DATA_DIR, 'outbox');
const STATE_FILE = path.join(store.DATA_DIR, 'notify.json');

// Wysyłka możliwa (SMTP albo tryb log) – wtedy działają powiadomienia uczestników.
const transportReady = MODE === 'log' || Boolean(SMTP_USER && SMTP_PASS);
// Powiadomienia administratora – dodatkowo potrzebny jego adres.
const enabled = Boolean(TO) && transportReady;

let transport = null;
let baseUrl = '';
const pendingProjects = new Set(); // projekty, które mogą mieć niewysłane komentarze
const retryAt = new Map();          // projekt -> najwcześniejsza kolejna próba po błędzie
let sentTimes = [];                 // czasy wysyłek z ostatniej godziny
let participantSent = [];           // czasy wysyłek do uczestników z ostatniej godziny
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
      // Krótkie limity: bez nich zablokowane połączenie trwałoby minuty,
      // a przycisk „Testowy mail” kończył się zerwanym żądaniem.
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
    });
  return transport;
}

function status() {
  return {
    enabled,
    participants: transportReady,
    mentionDomains: mentions.DOMAINS,
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
  if (transportReady) {
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
function buildDigest(project, items, undelivered = []) {
  const viewUrl = baseUrl ? `${baseUrl}/v/${project.id}` : '';
  const linkFor = (c) => (viewUrl ? `${viewUrl}?c=${encodeURIComponent(c.id)}` : '');
  const what = items.length ? summary(items) : 'nie dostarczono powiadomienia';
  const subject = `[Design Review] ${what} – ${project.name}`;
  const undeliveredLabel = (u) => `${u.name ? u.name + ' ' : ''}<${u.email}>`;
  const undeliveredNote = 'Nie udało się powiadomić (serwer poczty odrzucił adres – pewnie literówka w adresie):';

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
    `Projekt „${project.name}” – ${what}${items.length ? ':' : '.'}`,
    '',
    textItems.join('\n\n'),
    '',
    undelivered.length ? [undeliveredNote, ...undelivered.map((u) => `• ${undeliveredLabel(u)}`), ''].join('\n') : '',
    viewUrl ? `Widok recenzji: ${viewUrl}` : '',
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

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
    + `<p>Projekt <b>${escapeHtml(project.name)}</b> – ${escapeHtml(what)}${items.length ? ':' : '.'}</p>`
    + (items.length ? `<ul style="padding-left:18px">${htmlItems.join('')}</ul>` : '')
    + (undelivered.length
      ? `<p style="margin:0;color:#b42318">${escapeHtml(undeliveredNote)}</p>`
        + `<ul style="padding-left:18px;color:#b42318">${undelivered.map((u) => `<li>${escapeHtml(undeliveredLabel(u))}</li>`).join('')}</ul>`
      : '')
    + (viewUrl ? `<p><a href="${escapeHtml(viewUrl)}" style="color:#4f46e5">Otwórz widok recenzji</a></p>` : '')
    + '</div>';

  return { subject, text, html };
}

/* ----------------------------- zbieranie i wysyłka ------------------------ */

/** Wywoływane po dodaniu komentarza lub odpowiedzi – projekt trafia do sprawdzenia. */
function commentAdded(projectId) {
  if (transportReady) pendingProjects.add(projectId);
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

/** Adresy uczestników odrzucone przez serwer poczty, o których administrator jeszcze nie wie. */
async function undeliveredFor(projectId) {
  const entries = await subscribers.read(projectId);
  return Object.keys(entries)
    .filter((email) => entries[email].undeliverable && !entries[email].undeliverableReported)
    .map((email) => ({ email, name: entries[email].name }));
}

async function checkAdmin(project, now) {
  const projectId = project.id;
  const since = Number(project.notifiedUpTo) || 0;
  const items = newItems(await store.readComments(projectId), since);
  const undelivered = await undeliveredFor(projectId);
  if (!items.length && !undelivered.length) return false;

  // Sama informacja o niedostarczeniu idzie od razu, komentarze czekają na ciszę.
  const first = items.length ? items[0].at : now;
  const last = items.length ? items[items.length - 1].at : since;
  if (items.length && now - last < QUIET_MS && now - first < MAX_MS) return true; // jeszcze czekamy
  if ((retryAt.get(projectId) || 0) > now) return true;
  if (!underRateLimit(now)) return true;

  try {
    await send(buildDigest(project, items, undelivered));
    sentTimes.push(now);
    retryAt.delete(projectId);
    if (items.length) await store.updateProject(projectId, { notifiedUpTo: last });
    for (const u of undelivered) await subscribers.update(projectId, u.email, { undeliverableReported: true });
    // Wpisy dodane w trakcie wysyłki zostaną na następną turę.
    return newItems(await store.readComments(projectId), last).length > 0;
  } catch (err) {
    console.error(`[notify] nie udało się wysłać powiadomienia (${project.name}):`, err.message);
    retryAt.set(projectId, now + RETRY_MS);
    return true;
  }
}

/* -------------------------- uczestnicy wątków ---------------------------- */

/** Adresy uczestników wątku: autor, odpowiadający z e-mailem i wspomniani. */
function threadEmails(comment) {
  const set = new Set();
  if (comment.email) set.add(comment.email);
  for (const e of comment.mentions || []) set.add(e);
  for (const r of Array.isArray(comment.replies) ? comment.replies : []) {
    if (r.email) set.add(r.email);
    for (const e of r.mentions || []) set.add(e);
  }
  return set;
}

/**
 * Nowe wpisy dla uczestnika: odpowiedzi w jego wątkach i wzmianki o nim,
 * bez wpisów, które napisał sam.
 */
function itemsFor(email, comments, since) {
  const items = [];
  for (const c of comments) {
    if (!c || !threadEmails(c).has(email)) continue;
    const mentionedInComment = (c.mentions || []).includes(email);
    if (mentionedInComment && c.createdAt > since && c.email !== email) {
      items.push({ comment: c, mention: true, at: c.createdAt });
    }
    for (const r of Array.isArray(c.replies) ? c.replies : []) {
      if (!r || r.createdAt <= since || r.email === email) continue;
      items.push({ comment: c, reply: r, mention: (r.mentions || []).includes(email), at: r.createdAt });
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

const MENTION_FORMS = ['wzmianka o Tobie', 'wzmianki o Tobie', 'wzmianek o Tobie'];

function buildParticipantDigest(project, entry, items) {
  const viewUrl = `${baseUrl}/v/${project.id}`;
  const linkFor = (c) => `${viewUrl}?c=${encodeURIComponent(c.id)}`;
  const unsubscribeUrl = `${baseUrl}/unsubscribe/${encodeURIComponent(entry.token)}`;
  const mentionCount = items.filter((i) => i.mention).length;
  const replyCount = items.length - mentionCount;
  const parts = [];
  if (mentionCount) parts.push(countLabel(mentionCount, MENTION_FORMS));
  if (replyCount) parts.push(countLabel(replyCount, REPLY_FORMS));
  const what = parts.join(' i ');
  const subject = `[Design Review] ${what} – ${project.name}`;

  const describe = ({ comment: c, reply: r, mention }) => {
    const who = r ? r.author : c.author;
    if (mention) return `${who} wspomina Cię ${r ? 'w odpowiedzi' : 'w komentarzu'}`;
    return `${who} odpowiada w wątku (komentarz: ${c.author})`;
  };

  const textItems = items.map((item) => {
    const { comment: c, reply: r } = item;
    const lines = [`• ${describe(item)} (${pageLabel(c.page)}):`, `  ${String((r || c).text).replace(/\n/g, '\n  ')}`];
    if (r) lines.push(`  Komentarz: ${String(c.text).replace(/\s+/g, ' ').slice(0, 200)}`);
    lines.push(`  ${linkFor(c)}`);
    return lines.join('\n');
  });
  const greeting = entry.name ? `Cześć ${entry.name},` : 'Cześć,';
  const footer = 'Dostajesz tę wiadomość, bo uczestniczysz w wątku albo ktoś Cię wspomniał.';
  const text = [
    greeting,
    '',
    `w projekcie „${project.name}”: ${what}.`,
    '',
    textItems.join('\n\n'),
    '',
    `${footer}`,
    `Wypisz się: ${unsubscribeUrl}`,
  ].join('\n') + '\n';

  const htmlItems = items.map((item) => {
    const { comment: c, reply: r } = item;
    const context = r
      ? `<div style="margin:6px 0 0;padding-left:8px;border-left:2px solid #c7cbd6;color:#6b7280">${escapeHtml(String(c.text).slice(0, 300))}</div>`
      : '';
    return '<li style="margin:0 0 14px">'
      + `<div><b>${escapeHtml(describe(item))}</b> <span style="color:#6b7280">· ${escapeHtml(pageLabel(c.page))}</span></div>`
      + `<div style="margin-top:4px;white-space:pre-wrap">${escapeHtml((r || c).text)}</div>`
      + context
      + `<div style="margin-top:6px"><a href="${escapeHtml(linkFor(c))}" style="color:#4f46e5">Pokaż komentarz</a></div>`
      + '</li>';
  });
  const html = '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#14161c">'
    + `<p>${escapeHtml(greeting)}</p>`
    + `<p>w projekcie <b>${escapeHtml(project.name)}</b>: ${escapeHtml(what)}.</p>`
    + `<ul style="padding-left:18px">${htmlItems.join('')}</ul>`
    + `<p style="color:#6b7280;font-size:12px">${escapeHtml(footer)} `
    + `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">Wypisz się</a></p>`
    + '</div>';

  return {
    to: entry.email,
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** Serwer poczty na stałe (kod 5xx) odrzucił odbiorcę – np. adres nie istnieje. */
function rejectedPermanently(err) {
  if (!err || err.code !== 'EENVELOPE' || err.command !== 'RCPT TO') return false;
  const errors = Array.isArray(err.rejectedErrors) && err.rejectedErrors.length ? err.rejectedErrors : [err];
  return errors.every((e) => Number(e.responseCode) >= 500);
}

function participantUnderRateLimit(now) {
  participantSent = participantSent.filter((t) => now - t < 60 * 60 * 1000);
  return participantSent.length < PARTICIPANT_MAX_PER_HOUR;
}

async function checkParticipants(project, now) {
  const entries = await subscribers.read(project.id);
  const emails = Object.keys(entries);
  if (!emails.length) return false;
  const comments = await store.readComments(project.id);
  const adminEmail = TO.toLowerCase();
  let pending = false;

  for (const email of emails) {
    const entry = Object.assign({ email }, entries[email]);
    // Administrator i tak dostaje swoje zbiorcze powiadomienia.
    if (entry.unsubscribed || entry.undeliverable || email === adminEmail) continue;
    const items = itemsFor(email, comments, Number(entry.notifiedUpTo) || 0);
    if (!items.length) continue;

    const first = items[0].at;
    const last = items[items.length - 1].at;
    const recent = (entry.sentTimes || []).filter((t) => now - t < 24 * 60 * 60 * 1000);
    const retryKey = project.id + ' ' + email;
    if (now - last < QUIET_MS && now - first < MAX_MS) { pending = true; continue; }
    // Bez adresu aplikacji nie ma linku do wypisania się – czekamy na niego.
    if (!baseUrl || (retryAt.get(retryKey) || 0) > now) { pending = true; continue; }
    if (recent.length >= PER_ADDRESS_PER_DAY || !participantUnderRateLimit(now)) { pending = true; continue; }

    try {
      await send(buildParticipantDigest(project, entry, items));
      participantSent.push(now);
      retryAt.delete(retryKey);
      await subscribers.update(project.id, email, { notifiedUpTo: last, sentTimes: recent.concat(now) });
    } catch (err) {
      if (rejectedPermanently(err)) {
        // Nieistniejący adres – ponawianie nic nie da. Dalej go pomijamy,
        // a administrator dostaje o tym informację w swoim powiadomieniu.
        console.error(`[notify] serwer poczty odrzucił adres uczestnika (${project.name}):`, err.message);
        await subscribers.update(project.id, email, { undeliverable: now, undeliverableReported: false, notifiedUpTo: last });
        continue;
      }
      console.error(`[notify] nie udało się wysłać powiadomienia do uczestnika (${project.name}):`, err.message);
      retryAt.set(retryKey, now + RETRY_MS);
      pending = true;
    }
  }
  return pending;
}

async function checkProject(projectId, now) {
  const project = store.getProject(projectId);
  if (!project) return false;
  // Najpierw uczestnicy – odrzucone adresy trafią do tego samego maila administratora.
  const participantsPending = await checkParticipants(project, now);
  const adminPending = enabled ? await checkAdmin(project, now) : false;
  return adminPending || participantsPending;
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
  if (!transportReady) return status();
  try {
    const saved = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    if (!baseUrl && saved && typeof saved.baseUrl === 'string') baseUrl = saved.baseUrl;
  } catch {
    /* brak zapisanego adresu */
  }
  const now = Date.now();
  for (const project of store.listProjects()) {
    if (enabled && project.notifiedUpTo == null) await store.updateProject(project.id, { notifiedUpTo: now });
    pendingProjects.add(project.id);
  }
  setInterval(tick, TICK_MS).unref();
  return status();
}

/** Błąd wysyłki po polsku – z podpowiedzią, co sprawdzić w konfiguracji. */
function describeMailError(err) {
  const code = err && err.code;
  if (code === 'EAUTH') {
    return 'serwer poczty odrzucił logowanie – sprawdź SMTP_USER i SMTP_PASS (dla Gmaila: hasło aplikacji).';
  }
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(code)) {
    return `nie udało się połączyć z serwerem poczty ${SMTP_HOST}:${SMTP_PORT} – sprawdź adres i port `
      + 'oraz czy serwer aplikacji może łączyć się na zewnątrz.';
  }
  if (code === 'EENVELOPE') return 'serwer poczty nie przyjął adresu nadawcy lub odbiorcy – sprawdź MAIL_FROM i NOTIFY_EMAIL.';
  return 'nieznany błąd serwera poczty' + (code ? ` (${code})` : '') + '.';
}

/** Mail testowy – do sprawdzenia konfiguracji z panelu. */
async function sendTest() {
  if (!enabled) throw new Error('powiadomienia są wyłączone (brak NOTIFY_EMAIL albo danych SMTP).');
  try {
    await send({
      subject: '[Design Review] Testowe powiadomienie',
      text: 'To jest testowa wiadomość z Design Review – powiadomienia mailowe działają.\n',
      html: '<p>To jest testowa wiadomość z <b>Design Review</b> – powiadomienia mailowe działają.</p>',
    });
  } catch (err) {
    console.error('[notify] mail testowy:', err && err.message);
    throw new Error(describeMailError(err));
  }
}

/** Adres administratora (małymi literami) – uczestnicy go pomijają. */
function adminEmail() {
  return TO.toLowerCase();
}

module.exports = { init, status, adminEmail, setBaseUrl, commentAdded, sendTest };
