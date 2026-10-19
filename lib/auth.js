'use strict';

/**
 * Uwierzytelnianie właściciela aplikacji.
 *
 * Logowanie jest jednopolowe: podaje się `uid` – długi, losowy ciąg znaków
 * (64 znaki hex). Po zalogowaniu przeglądarka dostaje ciasteczko z osobnym
 * tokenem sesji, dzięki czemu sam uid nie jest odsyłany przy każdym żądaniu.
 *
 * Konfiguracja trafia do `data/config.json` (powstaje przy pierwszym starcie):
 *   { "uid": "…", "session": "…", "createdAt": 1690000000000 }
 * Uid można też ustawić zmienną środowiskową `ADMIN_UID`.
 *
 * Osoby komentujące wchodzące z linku udostępniania nie logują się – mają
 * dostęp wyłącznie do widoku recenzji (`/v/<id>`) i dodawania komentarzy.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const COOKIE = 'design_review_session';
const MAX_AGE = 365 * 24 * 60 * 60; // sekundy

let config = null;
let generated = false;

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** Porównanie odporne na atak czasowy. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bufB = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function save() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, CONFIG_FILE);
}

/**
 * Wczytuje (lub tworzy) konfigurację. Zwraca { uid, fresh } – `fresh` mówi,
 * czy uid został właśnie wygenerowany, żeby można go było wypisać w konsoli.
 */
async function init() {
  if (config) return { uid: config.uid, fresh: generated };

  let parsed = null;
  try {
    parsed = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    parsed = null;
  }

  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const envUid = String(process.env.ADMIN_UID || '').trim();
  const next = {
    uid: envUid || String(source.uid || '').trim(),
    session: String(source.session || '').trim(),
    createdAt: Number(source.createdAt) || Date.now(),
  };

  generated = !next.uid;
  if (!next.uid) next.uid = randomSecret();
  if (!next.session) next.session = randomSecret();

  const previous = JSON.stringify({
    uid: String(source.uid || '').trim(),
    session: String(source.session || '').trim(),
    createdAt: Number(source.createdAt) || null,
  });

  config = next;
  if (JSON.stringify(next) !== previous) {
    await save().catch((err) => console.error('[auth] nie udało się zapisać config.json:', err));
  }

  return { uid: config.uid, fresh: generated };
}

function uid() {
  return config ? config.uid : '';
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readCookie(req, name) {
  try {
    return parseCookies(req.headers && req.headers.cookie)[name] || '';
  } catch {
    return '';
  }
}

function isAuthed(req) {
  if (!config) return false;
  return safeEqual(readCookie(req, COOKIE), config.session);
}

/** Sprawdza, czy podany uid jest poprawny. */
function checkUid(value) {
  if (!config) return false;
  return safeEqual(String(value == null ? '' : value).trim(), config.uid);
}

function cookieAttrs(req) {
  const secure = (req && req.secure) || (req && req.headers && req.headers['x-forwarded-proto'] === 'https');
  return 'Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '');
}

/** Ustawia ciasteczko (dopisuje do nagłówka, nie nadpisuje innych). */
function setCookie(req, res, name, value, maxAge) {
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; ${cookieAttrs(req)}; Max-Age=${maxAge}`
  );
}

/** Kasuje ciasteczko. */
function clearCookie(req, res, name) {
  setCookie(req, res, name, '', 0);
}

function setSession(req, res) {
  setCookie(req, res, COOKIE, config.session, MAX_AGE);
}

function clearSession(req, res) {
  clearCookie(req, res, COOKIE);
}

/* --- Hasła do pojedynczych stron --------------------------------------- */

/** Nazwa ciasteczka odblokowującego konkretną stronę. */
function projectCookie(id) {
  return `dr_p_${id}`;
}

/**
 * Tworzy skrót hasła (scrypt + losowa sól). Zwraca { salt, hash } w hex.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve({ salt, hash: key.toString('hex') });
    });
  });
}

/** Sprawdza hasło wobec zapisanego { salt, hash } – porównanie odporne na czas. */
function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return Promise.resolve(false);
  return new Promise((resolve) => {
    crypto.scrypt(String(password), String(stored.salt), 64, (err, key) => {
      if (err) resolve(false);
      else resolve(safeEqual(key.toString('hex'), String(stored.hash)));
    });
  });
}

/** Chroni strony HTML – niezalogowanych odsyła na ekran logowania. */
function requireAuthPage(req, res, next) {
  if (isAuthed(req)) return next();
  res.redirect(302, '/login');
}

/** Chroni endpointy API – zwraca 401 zamiast przekierowania. */
function requireAuthApi(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Brak dostępu. Zaloguj się.', login: '/login' });
}

module.exports = {
  CONFIG_FILE,
  COOKIE,
  MAX_AGE,
  init,
  uid,
  isAuthed,
  checkUid,
  readCookie,
  setCookie,
  clearCookie,
  setSession,
  clearSession,
  projectCookie,
  hashPassword,
  verifyPassword,
  randomSecret,
  safeEqual,
  requireAuthPage,
  requireAuthApi,
};
