'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const store = require('./lib/store');
const auth = require('./lib/auth');
const notify = require('./lib/notify');
const { extractZip, detectEntry, packDir } = require('./lib/zip');
const mime = require('./lib/mime');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = 50 * 1024 * 1024; // 50 MB
// Publiczny adres aplikacji (np. za odwrotnym proxy z HTTPS). Trafia do
// skryptu, który wkleja się na recenzowanej stronie WordPress.
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

/**
 * Warstwa adnotacji (`public/annotator.js`) i jej wersja – skrót treści.
 * Wersja trafia do adresu skryptu na stronach z ZIP-a (`/annotator.js?v=…`),
 * bo serwer wstawia go przy każdym wczytaniu strony. Skrypt wklejany na strony
 * na żywo wersji NIE ma: wkleja się go raz, więc stary numer zostałby w kodzie
 * strony po aktualizacji. Plik czytamy ponownie, gdy zmieni się na dysku
 * (np. przy `npm run dev`, który nie śledzi plików z public/).
 */
const ANNOTATOR_FILE = path.join(store.PUBLIC_DIR, 'annotator.js');
const annotatorCache = { mtimeMs: -1, body: null, version: 'dev' };

function annotator() {
  let stat = null;
  try { stat = fs.statSync(ANNOTATOR_FILE); } catch { /* brak pliku */ }
  if (!stat) return { body: null, version: 'dev' };
  if (stat.mtimeMs !== annotatorCache.mtimeMs) {
    try {
      const body = fs.readFileSync(ANNOTATOR_FILE);
      annotatorCache.body = body;
      annotatorCache.version = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
      annotatorCache.mtimeMs = stat.mtimeMs;
    } catch {
      return { body: null, version: 'dev' };
    }
  }
  return annotatorCache;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Adres do linków w mailach: PUBLIC_URL, a bez niego adres, pod którym
// właściciel otworzył aplikację (tylko z jego żądań – nagłówka Host od obcych
// nie bierzemy, bo mógłby podmienić linki w powiadomieniach).
app.use((req, res, next) => {
  if (PUBLIC_URL || auth.isAuthed(req)) notify.setBaseUrl(publicOrigin(req));
  next();
});

/* ---------------------------------- utils --------------------------------- */

function fixFilename(name) {
  if (!name) return 'projekt';
  const latin = Buffer.from(name, 'latin1').toString('utf8');
  // Jeśli dekodowanie latin1 -> utf8 daje sensowny wynik, użyj go.
  return latin.includes('\uFFFD') ? name : latin;
}

function safeBase(name) {
  return (
    String(name)
      .replace(/\.zip$/i, '')
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 120) || 'Projekt'
  );
}

function entryUrl(id, entry) {
  return '/p/' + id + '/' + String(entry).split('/').map(encodeURIComponent).join('/');
}

/**
 * Windows potrafi chwilowo zablokować katalog (np. gdy trwa odczyt pliku),
 * dlatego przenoszenie ponawiamy kilka razy.
 */
async function renameWithRetry(from, to) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  throw lastErr;
}

function isUrlProject(project) {
  return Boolean(project && project.kind === 'url');
}

function projectDto(project) {
  const dto = {
    id: project.id,
    kind: isUrlProject(project) ? 'url' : 'zip',
    name: project.name,
    entry: project.entry,
    files: project.files,
    size: project.size,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt || null,
    entryUrl: isUrlProject(project) ? project.url : entryUrl(project.id, project.entry),
    viewPath: '/v/' + project.id,
    locked: Boolean(project.password && project.password.hash),
  };
  if (isUrlProject(project)) {
    dto.url = project.url;
    dto.origin = project.origin;
    dto.origins = siteOrigins(project.origin);
  }
  return dto;
}

/* ------------------------ strony na żywo (WordPress) ---------------------- */

/** Adres, pod którym recenzowana strona pobiera skrypt warstwy adnotacji. */
function publicOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  // Za odwrotnym proxy (Cloudflare, tunel, Render) Express widzi `http`, więc
  // bierzemy protokół przekazany w nagłówku – tak samo jak przy ciasteczkach
  // (lib/auth.js). Bez tego strona na HTTPS nie wczytałaby skryptu (mixed content).
  const forwarded = String((req.headers && req.headers['x-forwarded-proto']) || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : req.protocol;
  return proto + '://' + req.get('host');
}

function annotatorSnippet(req) {
  // Bez wersji w adresie – zob. komentarz przy annotator().
  return '<script src="' + publicOrigin(req) + '/annotator.js" defer></script>';
}

/** Adres strony do recenzji: tylko http(s), bez danych logowania i kotwicy. */
function parseSiteUrl(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = 'https://' + value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !url.hostname) return null;
  url.hash = '';
  return url;
}

/**
 * Dozwolone originy podglądu: adres projektu i jego bliźniak z „www.” albo
 * bez niego – WordPress często przekierowuje między tymi wariantami.
 */
function siteOrigins(origin) {
  const list = [origin];
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host.includes('.') && !/^[\d.]+$/.test(host) && !host.startsWith('[')) {
      url.hostname = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
      list.push(url.origin);
    }
  } catch {
    /* zostaje sam origin */
  }
  return list;
}

/**
 * Klucz podstrony strony na żywo: ścieżka adresu, a przy bezpośrednich
 * odnośnikach WordPressa (?p=123, ?page_id=123) także ten parametr.
 * Ta sama reguła działa w annotator.js.
 */
function pageKey(url) {
  const path = url.pathname || '/';
  for (const param of ['page_id', 'p']) {
    const value = url.searchParams.get(param);
    if (value && /^\d+$/.test(value)) return path + '?' + param + '=' + value;
  }
  return path;
}

/* ------------------------- dostęp do strony (hasło) ----------------------- */

const UNLOCK_MAX_AGE = 30 * 24 * 60 * 60; // sekundy

/**
 * Ustala, czy strona jest zabezpieczona hasłem i czy żądający ma do niej
 * dostęp. Właściciel (zalogowany uid-em) nigdy nie musi podawać hasła.
 */
function projectAccess(req, project) {
  const locked = Boolean(project.password && project.password.hash);
  if (!locked) return { locked: false, unlocked: true };
  if (auth.isAuthed(req)) return { locked: true, unlocked: true, admin: true };
  const token = auth.readCookie(req, auth.projectCookie(project.id));
  const unlocked = Boolean(project.accessToken) && auth.safeEqual(token, project.accessToken);
  return { locked: true, unlocked };
}

/** Przepuszcza żądanie do API tylko, gdy strona nie jest zablokowana hasłem. */
function requireProjectAccessApi(req, res, next) {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nie istnieje.' });
  const access = projectAccess(req, project);
  if (!access.unlocked) {
    return res.status(401).json({
      error: 'Ta strona jest zabezpieczona hasłem.',
      unlock: '/unlock/' + project.id,
    });
  }
  req.project = project;
  next();
}

function clampStr(value, max) {
  return String(value == null ? '' : value).replace(/\s+$/g, '').slice(0, max);
}

/** Tylko ścieżki wewnętrzne – chroni przed otwartym przekierowaniem. */
function safeNext(value) {
  const next = String(value == null ? '' : value);
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  return next;
}

/** Bezpieczna, ASCII-owa nazwa pliku do nagłówka Content-Disposition. */
function asciiFilename(name) {
  const base = String(name || 'projekt')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return (base || 'projekt') + '.zip';
}

/* -------------------------------- logowanie ------------------------------- */

// Ekran logowania (jedno pole: uid).
app.get('/login', (req, res) => {
  if (auth.isAuthed(req)) return res.redirect(302, safeNext(req.query.next) || '/');
  res.sendFile(path.join(store.PUBLIC_DIR, 'login.html'));
});

app.post('/api/login', (req, res) => {
  const uid = clampStr((req.body || {}).uid, 200);
  if (!uid) return res.status(400).json({ error: 'Podaj uid.' });
  if (!auth.checkUid(uid)) {
    // Drobne opóźnienie utrudnia zgadywanie uid.
    return setTimeout(() => res.status(401).json({ error: 'Nieprawidłowy uid.' }), 500);
  }
  auth.setSession(req, res);
  res.json({ ok: true, next: safeNext((req.body || {}).next) || '/' });
});

app.post('/api/logout', (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});

// Informacja dla interfejsu, czy użytkownik jest zalogowany.
app.get('/api/session', (req, res) => {
  const authed = auth.isAuthed(req);
  res.json({ authed, uid: authed ? auth.uid() : null, loginUrl: '/login' });
});

/* --------------------------- powiadomienia mailowe ------------------------ */

app.get('/api/notifications', auth.requireAuthApi, (req, res) => {
  res.json(notify.status());
});

/** Mail testowy – sprawdzenie konfiguracji SMTP z panelu. */
app.post('/api/notifications/test', auth.requireAuthApi, async (req, res) => {
  try {
    await notify.sendTest();
    res.json({ ok: true, to: notify.status().to });
  } catch (err) {
    res.status(400).json({ error: 'Nie udało się wysłać maila: ' + (err && err.message ? err.message : 'nieznany błąd') });
  }
});

/* --------------------------------- upload -------------------------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.TMP_DIR),
    filename: (req, file, cb) => cb(null, store.newId() + '.zip'),
  }),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (req, file, cb) => {
    const looksZip =
      /\.zip$/i.test(file.originalname || '') ||
      ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'].includes(file.mimetype);
    if (!looksZip) return cb(new Error('Dozwolone są wyłącznie pliki .zip'));
    cb(null, true);
  },
});

/* ------------------------------- API: projekty ---------------------------- */

// Lista i modyfikacje projektów są dostępne wyłącznie dla zalogowanego
// właściciela. Widok recenzji (/v/<id>) i komentarze pozostają publiczne.
app.get('/api/projects', auth.requireAuthApi, (req, res) => {
  res.json({ projects: store.listProjects().map(projectDto), snippet: annotatorSnippet(req) });
});

/** Strona na żywo (np. WordPress) – recenzowana pod własnym adresem, bez ZIP-a. */
app.post('/api/projects/url', auth.requireAuthApi, async (req, res) => {
  const url = parseSiteUrl((req.body || {}).url);
  if (!url) return res.status(400).json({ error: 'Podaj poprawny adres strony (http:// lub https://).' });

  const name = clampStr((req.body || {}).name, 120).trim() || url.hostname;
  const project = {
    id: store.newId(),
    kind: 'url',
    name,
    url: url.href,
    origin: url.origin,
    entry: pageKey(url),
    createdAt: Date.now(),
    notifiedUpTo: Date.now(),
  };
  await store.addProject(project);
  res.status(201).json({ project: projectDto(project), snippet: annotatorSnippet(req) });
});

/**
 * Zmiana adresu strony na żywo (np. przeniesienie ze stagingu na produkcję) –
 * odpowiednik podmiany ZIP-a. Link do recenzji, hasło i komentarze zostają;
 * komentarze są przypisane do ścieżek podstron, więc przy tej samej
 * strukturze adresów trafiają na swoje miejsca także w nowej domenie.
 */
app.post('/api/projects/:id/url', auth.requireAuthApi, async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nie istnieje.' });
  if (!isUrlProject(project)) {
    return res.status(400).json({ error: 'Adres można zmienić tylko dla strony na żywo.' });
  }
  const url = parseSiteUrl((req.body || {}).url);
  if (!url) return res.status(400).json({ error: 'Podaj poprawny adres strony (http:// lub https://).' });

  const originChanged = url.origin !== project.origin;
  const patch = { url: url.href, origin: url.origin, entry: pageKey(url), updatedAt: Date.now() };
  // Nazwa nadana automatycznie (sama domena) idzie za nowym adresem.
  if (project.name === new URL(project.origin).hostname) patch.name = url.hostname;

  const updated = await store.updateProject(project.id, patch);
  res.json({ project: projectDto(updated), originChanged, snippet: annotatorSnippet(req) });
});

app.post('/api/projects', auth.requireAuthApi, upload.single('file'), async (req, res) => {
  const tmpFile = req.file && req.file.path;
  let dir = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Nie przesłano pliku .zip' });

    const provided = clampStr(req.body && req.body.name, 120);
    const name = provided || safeBase(fixFilename(req.file.originalname));

    const id = store.newId();
    dir = store.siteDir(id);
    await fsp.mkdir(dir, { recursive: true });

    let files;
    try {
      files = await extractZip(tmpFile, dir);
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true });
      return res.status(400).json({ error: err.message || 'Nie udało się rozpakować archiwum.' });
    }

    const entry = detectEntry(files);
    if (!entry) {
      await fsp.rm(dir, { recursive: true, force: true });
      return res.status(400).json({ error: 'W archiwum nie znaleziono żadnego pliku HTML.' });
    }

    const project = {
      id,
      name,
      entry,
      files: files.length,
      size: req.file.size,
      createdAt: Date.now(),
      notifiedUpTo: Date.now(),
    };
    await store.addProject(project);
    res.status(201).json({ project: projectDto(project) });
  } catch (err) {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    console.error('[upload]', err);
    res.status(500).json({ error: 'Wystąpił błąd podczas przetwarzania archiwum.' });
  } finally {
    if (tmpFile) fsp.rm(tmpFile, { force: true }).catch(() => {});
  }
});

app.get('/api/projects/:id', requireProjectAccessApi, async (req, res) => {
  const comments = await store.readComments(req.project.id);
  res.json({ project: projectDto(req.project), comments: commentsWithPage(comments, req.project) });
});

/**
 * Publiczna informacja o dostępie do strony – potrzebna ekranowi wpisywania
 * hasła. Nie zawiera niczego wrażliwego (ani skrótu hasła, ani tokenu).
 */
app.get('/api/projects/:id/access', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nie istnieje.' });
  const access = projectAccess(req, project);
  res.json({
    id: project.id,
    name: project.name,
    locked: access.locked,
    unlocked: access.unlocked,
    viewPath: '/v/' + project.id,
  });
});

/** Ekran wpisywania hasła do udostępnionej strony. */
app.get('/unlock/:id', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).type('html').send('<h1>404 – nie znaleziono strony</h1>');
  const access = projectAccess(req, project);
  const next = safeNext(req.query.next) || '/v/' + project.id;
  if (!access.locked || access.unlocked) return res.redirect(302, next);
  res.sendFile(path.join(store.PUBLIC_DIR, 'unlock.html'));
});

/** Odblokowanie strony hasłem (dla recenzentów). */
app.post('/api/projects/:id/unlock', async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nie istnieje.' });

  const access = projectAccess(req, project);
  if (!access.locked || access.unlocked) return res.json({ ok: true, next: '/v/' + project.id });

  const password = String((req.body || {}).password == null ? '' : (req.body || {}).password);
  const ok = await auth.verifyPassword(password, project.password);
  if (!ok) {
    // Opóźnienie utrudnia zgadywanie hasła.
    return setTimeout(() => res.status(401).json({ error: 'Nieprawidłowe hasło.' }), 400);
  }

  auth.setCookie(req, res, auth.projectCookie(project.id), project.accessToken, UNLOCK_MAX_AGE);
  res.json({ ok: true, next: safeNext((req.body || {}).next) || '/v/' + project.id });
});

/** Ustawienie lub usunięcie hasła do strony (tylko właściciel). */
app.post('/api/projects/:id/password', auth.requireAuthApi, async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nie istnieje.' });

  const raw = (req.body || {}).password;
  const password = typeof raw === 'string' ? raw.trim() : '';

  if (!password) {
    const updated = await store.updateProject(project.id, { password: null, accessToken: null });
    return res.json({ project: projectDto(updated) });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Hasło musi mieć co najmniej 4 znaki.' });
  if (password.length > 200) return res.status(400).json({ error: 'Hasło może mieć maksymalnie 200 znaków.' });

  // Nowy token unieważnia wszystkie wcześniejsze odblokowania strony.
  const updated = await store.updateProject(project.id, {
    password: await auth.hashPassword(password),
    accessToken: auth.randomSecret(),
  });
  res.json({ project: projectDto(updated) });
});

/**
 * Archiwum ZIP z samymi plikami strony. Komentarze trzymane są poza katalogiem
 * projektu, więc archiwum ich nie zawiera (podobnie jak wstrzykiwanej warstwy
 * adnotacji, która dodawana jest tylko przy serwowaniu).
 */
app.get('/api/projects/:id/archive', requireProjectAccessApi, async (req, res) => {
  const project = req.project;
  if (isUrlProject(project)) {
    return res.status(400).json({ error: 'Strona na żywo nie ma plików do pobrania.' });
  }

  try {
    const buffer = await packDir(store.siteDir(project.id));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename(project.name)}"; filename*=UTF-8''${encodeURIComponent(project.name + '.zip')}`
    );
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
  } catch (err) {
    console.error('[zip]', err);
    res.status(500).json({ error: 'Nie udało się przygotować archiwum.' });
  }
});

app.post('/api/projects/:id/replace', auth.requireAuthApi, upload.single('file'), async (req, res) => {
  const tmpFile = req.file && req.file.path;
  const project = store.getProject(req.params.id);
  const dir = project ? store.siteDir(project.id) : null;
  const staging = dir ? dir + '.new-' + store.newId() : null;
  const backup = dir ? dir + '.old-' + store.newId() : null;

  try {
    if (!project) return res.status(404).json({ error: 'Projekt nie istnieje.' });
    if (isUrlProject(project)) {
      return res.status(400).json({ error: 'Strony na żywo nie podmienia się archiwum ZIP.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Nie przesłano pliku .zip' });

    let files;
    try {
      files = await extractZip(tmpFile, staging);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Nie udało się rozpakować archiwum.' });
    }

    const entry = detectEntry(files);
    if (!entry) {
      return res.status(400).json({ error: 'W archiwum nie znaleziono żadnego pliku HTML.' });
    }

    // Podmiana katalogu: najpierw odsuń starą wersję, potem wstaw nową.
    // Przy błędzie drugiego kroku przywracamy poprzednie pliki.
    await renameWithRetry(dir, backup);
    try {
      await renameWithRetry(staging, dir);
    } catch (err) {
      await renameWithRetry(backup, dir).catch(() => {});
      throw err;
    }
    await fsp.rm(backup, { recursive: true, force: true }).catch((err) => {
      console.error('[replace] nie udało się usunąć starej wersji:', err);
    });

    const updated = await store.updateProject(project.id, {
      entry,
      files: files.length,
      size: req.file.size,
      updatedAt: Date.now(),
    });

    res.json({ project: projectDto(updated || project) });
  } catch (err) {
    console.error('[replace]', err);
    res.status(500).json({ error: 'Nie udało się podmienić plików projektu.' });
  } finally {
    if (staging) fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (tmpFile) fsp.rm(tmpFile, { force: true }).catch(() => {});
  }
});

/** Zmiana nazwy projektu (tylko właściciel). */
app.patch('/api/projects/:id', auth.requireAuthApi, async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projekt nie istnieje.' });
  const name = clampStr((req.body || {}).name, 120).replace(/[\u0000-\u001f]/g, '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa nie może być pusta.' });
  const updated = await store.updateProject(project.id, { name });
  res.json({ project: projectDto(updated) });
});

app.delete('/api/projects/:id', auth.requireAuthApi, async (req, res) => {
  const removed = await store.removeProject(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Projekt nie istnieje.' });
  res.json({ ok: true });
});

/* ------------------------------ API: komentarze --------------------------- */

/**
 * Pinezka jest zakotwiczona do klikniętego elementu (ścieżka XPath + położenie
 * kliknięcia jako ułamek jego szerokości i wysokości), a dodatkowo zapisujemy
 * bezwzględne współrzędne dokumentu jako rozwiązanie zapasowe.
 */
const PATH_STEPS_RE = /^(?:[a-z0-9_:.-]+|text\(\))\[\d+\](?:\/(?:[a-z0-9_:.-]+|text\(\))\[\d+\])*$/i;

/**
 * Kotwica Elementora: data-id elementu, numer jego wystąpienia na stronie
 * (ten sam data-id może się powtórzyć) i ścieżka od niego do celu.
 * Nieprawidłowa kotwica jest po prostu pomijana – zostaje XPath.
 */
function parseElementorAnchor(eid) {
  if (!eid || typeof eid !== 'object') return null;
  const id = String(eid.id == null ? '' : eid.id);
  const n = Number(eid.n);
  const rel = String(eid.rel == null ? '' : eid.rel);
  if (!/^[A-Za-z0-9]{1,32}$/.test(id)) return null;
  if (!Number.isInteger(n) || n < 1 || n > 10000) return null;
  if (rel.length > 1000 || (rel && !PATH_STEPS_RE.test(rel))) return null;
  return { id, n, rel };
}

function parsePinTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const xpath = clampStr(target.xpath, 2000);
  if (!xpath || xpath.charAt(0) !== '/') return null;
  const fx = Number(target.fx);
  const fy = Number(target.fy);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  const unit = (v) => Math.round(Math.min(1, Math.max(0, v)) * 100000) / 100000;
  const parsed = { xpath, fx: unit(fx), fy: unit(fy) };
  const eid = parseElementorAnchor(target.eid);
  if (eid) parsed.eid = eid;
  return parsed;
}

function parsePinAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const x = Number(a.x);
  const y = Number(a.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const anchor = {
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    docWidth: Number.isFinite(Number(a.docWidth)) ? Math.round(Number(a.docWidth)) : null,
    docHeight: Number.isFinite(Number(a.docHeight)) ? Math.round(Number(a.docHeight)) : null,
  };
  const target = parsePinTarget(a.target);
  if (target) anchor.target = target;
  return anchor;
}

function parseTextAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const startXPath = clampStr(a.startXPath, 2000);
  const endXPath = clampStr(a.endXPath, 2000);
  const startOffset = Number(a.startOffset);
  const endOffset = Number(a.endOffset);
  if (!startXPath || !endXPath) return null;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return null;
  if (startOffset < 0 || endOffset < 0) return null;
  const anchor = {
    startXPath,
    endXPath,
    startOffset,
    endOffset,
    text: clampStr(a.text, 600),
  };
  const startEid = parseElementorAnchor(a.startEid);
  const endEid = parseElementorAnchor(a.endEid);
  if (startEid) anchor.startEid = startEid;
  if (endEid) anchor.endEid = endEid;
  return anchor;
}

/**
 * Strona, której dotyczy komentarz, to ścieżka pliku HTML względem katalogu
 * projektu (np. "index.html" albo "podstrona/o-nas.html"). Starsze komentarze
 * nie mają tego pola – traktujemy je jak komentarze do strony startowej.
 */
async function resolveCommentPage(project, raw) {
  if (raw == null || raw === '') return project.entry;

  // Strona na żywo: klucz podstrony (ścieżka adresu) musi wskazywać ten sam serwis.
  if (isUrlProject(project)) {
    const key = String(raw);
    if (key.length > 2000 || key.charAt(0) !== '/' || key.startsWith('//')) return null;
    let url;
    try {
      url = new URL(key, project.origin);
    } catch {
      return null;
    }
    if (!siteOrigins(project.origin).includes(url.origin)) return null;
    const page = pageKey(url);
    // Adres mógł się znormalizować do postaci zaczynającej się od "//" (np.
    // "/a/..//evil.com" → "//evil.com"). Taki klucz wskazywałby inny host,
    // więc widok recenzji wyprowadziłby w ramce poza recenzowaną witrynę.
    if (page.charAt(0) !== '/' || page.startsWith('//')) return null;
    return page;
  }

  const rel = String(raw).split('#')[0].split('?')[0].replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || !/\.html?$/i.test(rel)) return null;

  const root = store.siteDir(project.id);
  const target = path.join(root, ...rel.split('/'));
  const norm = path.relative(root, target);
  if (!norm || norm.startsWith('..') || path.isAbsolute(norm)) return null;

  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  return norm.split(path.sep).join('/');
}

/** Uzupełnia brakujące pole `page` w komentarzach zapisanych przed tą zmianą. */
function commentsWithPage(comments, project) {
  return comments.map((c) => (c.page ? c : Object.assign({}, c, { page: project.entry })));
}

app.get('/api/projects/:id/comments', requireProjectAccessApi, async (req, res) => {
  const comments = await store.readComments(req.project.id);
  res.json({ comments: commentsWithPage(comments, req.project) });
});

app.post('/api/projects/:id/comments', requireProjectAccessApi, async (req, res) => {
  const project = req.project;

  const body = req.body || {};
  const author = clampStr(body.author, 60);
  const text = clampStr(body.text, 4000);
  const type = body.type === 'pin' ? 'pin' : body.type === 'text' ? 'text' : null;

  if (!author) return res.status(400).json({ error: 'Podaj nazwę.' });
  if (!text) return res.status(400).json({ error: 'Treść komentarza nie może być pusta.' });
  if (!type) return res.status(400).json({ error: 'Nieznany typ komentarza.' });

  const anchor = type === 'pin' ? parsePinAnchor(body.anchor) : parseTextAnchor(body.anchor);
  if (!anchor) return res.status(400).json({ error: 'Nieprawidłowe zakotwiczenie komentarza.' });

  const page = await resolveCommentPage(project, body.page);
  if (!page) return res.status(400).json({ error: 'Nieprawidłowa strona komentarza.' });

  const comment = {
    id: store.newId(),
    author,
    text,
    type,
    page,
    anchor,
    resolved: false,
    createdAt: Date.now(),
  };
  // ID wpisu WordPressa – komentarz trafia na swoją podstronę także po zmianie jej adresu.
  const postId = Number(body.postId);
  if (isUrlProject(project) && Number.isSafeInteger(postId) && postId > 0) comment.postId = postId;
  // Komentarze właściciela (zalogowanego uid-em) nie wyzwalają powiadomień.
  if (auth.isAuthed(req)) comment.byOwner = true;
  await store.addComment(project.id, comment);
  notify.commentAdded(project.id);
  res.status(201).json({ comment });
});

app.patch('/api/projects/:id/comments/:commentId', requireProjectAccessApi, async (req, res) => {
  const project = req.project;
  const patch = {};
  if (typeof (req.body || {}).resolved === 'boolean') patch.resolved = req.body.resolved;
  if (typeof (req.body || {}).text === 'string') {
    const text = clampStr(req.body.text, 4000);
    if (!text) return res.status(400).json({ error: 'Treść komentarza nie może być pusta.' });
    patch.text = text;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Brak zmian.' });
  const updated = await store.updateComment(project.id, req.params.commentId, patch);
  if (!updated) return res.status(404).json({ error: 'Komentarz nie istnieje.' });
  res.json({ comment: commentsWithPage([updated], project)[0] });
});

app.delete('/api/projects/:id/comments/:commentId', requireProjectAccessApi, async (req, res) => {
  const ok = await store.deleteComment(req.project.id, req.params.commentId);
  if (!ok) return res.status(404).json({ error: 'Komentarz nie istnieje.' });
  res.json({ ok: true });
});

/* ------------------------- serwowanie plików strony ----------------------- */

async function resolveSitePath(root, rel) {
  const parts = String(rel || '').split('/').filter(Boolean).map(decodeURIComponent);
  const target = path.join(root, ...parts);
  const norm = path.relative(root, target);
  if (norm.startsWith('..') || path.isAbsolute(norm)) return null;

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    for (const idx of ['index.html', 'index.htm']) {
      const candidate = path.join(target, idx);
      try {
        await fsp.access(candidate);
        return candidate;
      } catch {
        /* próbuj dalej */
      }
    }
    return null;
  }
  return stat.isFile() ? target : null;
}

const CSP_META_RE = /<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function isUtf8(buffer) {
  try {
    UTF8_DECODER.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Do każdego serwowanego dokumentu HTML wstrzykujemy skrypt warstwy adnotacji,
 * przekazując mu ścieżkę pliku, w którym się znajduje. Dzięki temu komentarz
 * wie, do której podstrony należy (także gdy plik jest indeksem katalogu).
 * Przy okazji usuwamy meta CSP, które mogłoby zablokować ten skrypt.
 */
function injectAnnotator(html, page) {
  const clean = html.replace(CSP_META_RE, '');
  const tag = '<script src="/annotator.js?v=' + annotator().version + '" data-page="' + escapeAttr(page) + '"></script>';
  if (/<\/body\s*>/i.test(clean)) return clean.replace(/<\/body\s*>/i, tag + '\n</body>');
  if (/<\/html\s*>/i.test(clean)) return clean.replace(/<\/html\s*>/i, tag + '\n</html>');
  return clean + '\n' + tag;
}

app.get('/p/:id', (req, res, next) => {
  const project = store.getProject(req.params.id);
  if (!project || isUrlProject(project)) return next();
  // /p/:id/ obsługuje trasę z wildcardem – tutaj przekierowujemy tylko wersję bez ukośnika.
  if (req.originalUrl.replace(/\?.*$/, '').endsWith('/')) return next();
  res.redirect('/p/' + project.id + '/');
});

app.get('/p/:id/*', async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project || isUrlProject(project)) return res.status(404).type('html').send('<h1>404 – nie znaleziono strony</h1>');

  const access = projectAccess(req, project);
  if (!access.unlocked) {
    res.setHeader('Cache-Control', 'no-store');
    return res
      .status(403)
      .type('html')
      .send(
        '<h1>403 – strona zabezpieczona hasłem</h1>' +
          '<p>Otwórz widok recenzji tej strony, aby wpisać hasło.</p>' +
          `<p><a href="/v/${project.id}">Przejdź do widoku recenzji</a></p>`
      );
  }

  const root = store.siteDir(project.id);
  const rel = req.params[0] || '';
  // Żądanie katalogu głównego strony -> przekierowanie na wykryty plik startowy.
  if (!rel) return res.redirect(entryUrl(project.id, project.entry));

  const file = await resolveSitePath(root, rel);
  if (!file) return res.status(404).type('html').send('<h1>404 – nie znaleziono pliku</h1>');

  res.setHeader('Cache-Control', 'no-cache');

  if (/^text\/html/.test(mime.lookup(file))) {
    let buffer;
    try {
      buffer = await fsp.readFile(file);
    } catch {
      return res.status(500).type('html').send('<h1>500 – nie można odczytać pliku</h1>');
    }
    const utf8 = isUtf8(buffer);
    const source = buffer.toString(utf8 ? 'utf8' : 'latin1');
    const page = path.relative(root, file).split(path.sep).join('/');
    const out = injectAnnotator(source, page);
    res.setHeader('Content-Type', utf8 ? 'text/html; charset=utf-8' : 'text/html');
    return res.end(Buffer.from(out, utf8 ? 'utf8' : 'latin1'));
  }

  res.setHeader('Content-Type', mime.lookup(file));
  fs.createReadStream(file)
    .on('error', () => res.status(500).end())
    .pipe(res);
});

/* -------------------------------- widoki UI ------------------------------- */

app.get('/v/:id', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).type('html').send('<h1>404 – nie znaleziono strony</h1>');

  const access = projectAccess(req, project);
  if (!access.unlocked) {
    return res.redirect(
      302,
      // Zachowujemy parametry (np. ?c=<komentarz> z linku w mailu).
      '/unlock/' + project.id + '?next=' + encodeURIComponent(safeNext(req.originalUrl) || '/v/' + project.id)
    );
  }
  res.sendFile(path.join(store.PUBLIC_DIR, 'view.html'));
});

/**
 * Strona główna (lista stron) wymaga zalogowania. Ścieżkę normalizujemy
 * (wielkość liter, ukośniki, kodowanie), żeby nie dało się jej pobrać
 * obejściem w rodzaju /INDEX.HTML czy /./index.html.
 */
const HOME_PATHS = new Set(['/', '/index', '/index.html']);

function homePath(req) {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch { /* zostaw oryginał */ }
  p = path.posix.normalize(p.replace(/\/+$/, '') || '/');
  return HOME_PATHS.has(p.toLowerCase()) ? p : null;
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (homePath(req)) return auth.requireAuthPage(req, res, next);
  next();
});

/**
 * Warstwa adnotacji. Adres z aktualną wersją (`?v=<hash>`, tylko strony
 * z ZIP-a) można trzymać w cache „na zawsze”. Każdy inny – w tym skrypt
 * wklejony na strony na żywo – wymaga sprawdzenia przy każdym użyciu
 * (`no-cache`); dzięki ETag niezmieniony plik kończy się odpowiedzią 304.
 */
app.get('/annotator.js', (req, res) => {
  const { body, version } = annotator();
  if (!body) return res.status(404).type('js').send('// brak pliku annotator.js');
  const versioned = version !== 'dev' && String(req.query.v || '') === version;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.send(body);
});

app.use(express.static(store.PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Nie znaleziono.' });
  res.status(404).type('html').send('<h1>404</h1>');
});

// Obsługa błędów (m.in. multer: za duży plik, zły typ).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const msg =
    err && err.code === 'LIMIT_FILE_SIZE'
      ? 'Plik jest zbyt duży (limit 50 MB).'
      : (err && err.message) || 'Nieoczekiwany błąd.';
  const status = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  console.error('[error]', msg);
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
  res.status(status).type('text').send(msg);
});

/* --------------------------------- start ---------------------------------- */

(async () => {
  await store.init();
  const { uid, fresh } = await auth.init();
  const mail = await notify.init();
  app.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('  Design Review – aplikacja do komentowania designu stron');
    console.log('  ------------------------------------------------------');
    console.log(`  Aplikacja działa: ${url}`);
    console.log('');
    console.log(`  Logowanie: ${url}/login`);
    console.log(`  Twój uid:  ${uid}`);
    if (fresh) console.log('  (uid wygenerowano i zapisano w data/config.json)');
    console.log(mail.enabled
      ? `  Powiadomienia: ${mail.to} (${mail.transport === 'log' ? 'zapis do data/outbox' : 'SMTP'})`
      : '  Powiadomienia: wyłączone (ustaw NOTIFY_EMAIL i dane SMTP)');
    console.log('');
  });
})().catch((err) => {
  console.error('Nie udało się uruchomić serwera:', err);
  process.exit(1);
});
