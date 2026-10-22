'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const store = require('./lib/store');
const auth = require('./lib/auth');
const { extractZip, detectEntry, packDir } = require('./lib/zip');
const mime = require('./lib/mime');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = 50 * 1024 * 1024; // 50 MB

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

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

function projectDto(project) {
  return {
    id: project.id,
    name: project.name,
    entry: project.entry,
    files: project.files,
    size: project.size,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt || null,
    entryUrl: entryUrl(project.id, project.entry),
    viewPath: '/v/' + project.id,
    locked: Boolean(project.password && project.password.hash),
  };
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
  res.json({ projects: store.listProjects().map(projectDto) });
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
function parsePinTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const xpath = clampStr(target.xpath, 2000);
  if (!xpath || xpath.charAt(0) !== '/') return null;
  const fx = Number(target.fx);
  const fy = Number(target.fy);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  const unit = (v) => Math.round(Math.min(1, Math.max(0, v)) * 100000) / 100000;
  return { xpath, fx: unit(fx), fy: unit(fy) };
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
  return {
    startXPath,
    endXPath,
    startOffset,
    endOffset,
    text: clampStr(a.text, 600),
  };
}

/**
 * Strona, której dotyczy komentarz, to ścieżka pliku HTML względem katalogu
 * projektu (np. "index.html" albo "podstrona/o-nas.html"). Starsze komentarze
 * nie mają tego pola – traktujemy je jak komentarze do strony startowej.
 */
async function resolveCommentPage(project, raw) {
  if (raw == null || raw === '') return project.entry;

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
  await store.addComment(project.id, comment);
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
  const tag = '<script src="/annotator.js" data-page="' + escapeAttr(page) + '"></script>';
  if (/<\/body\s*>/i.test(clean)) return clean.replace(/<\/body\s*>/i, tag + '\n</body>');
  if (/<\/html\s*>/i.test(clean)) return clean.replace(/<\/html\s*>/i, tag + '\n</html>');
  return clean + '\n' + tag;
}

app.get('/p/:id', (req, res, next) => {
  const project = store.getProject(req.params.id);
  if (!project) return next();
  // /p/:id/ obsługuje trasę z wildcardem – tutaj przekierowujemy tylko wersję bez ukośnika.
  if (req.originalUrl.replace(/\?.*$/, '').endsWith('/')) return next();
  res.redirect('/p/' + project.id + '/');
});

app.get('/p/:id/*', async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).type('html').send('<h1>404 – nie znaleziono strony</h1>');

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
      '/unlock/' + project.id + '?next=' + encodeURIComponent('/v/' + project.id)
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
    console.log('');
  });
})().catch((err) => {
  console.error('Nie udało się uruchomić serwera:', err);
  process.exit(1);
});
