'use strict';

/**
 * Prosty test "dymny" API. Uruchom przy działającym serwerze:
 *   npm start
 *   node scripts/smoke-test.js
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ZIP = path.join(__dirname, '..', 'sample', 'landing.zip');
const CONFIG = path.join(__dirname, '..', 'data', 'config.json');

let failures = 0;

/** Uid potrzebny do testów – z env albo z data/config.json. */
function readUid() {
  if (process.env.ADMIN_UID) return process.env.ADMIN_UID.trim();
  try {
    return String(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).uid || '').trim();
  } catch {
    return '';
  }
}

/* Ciasteczko sesji dokładamy do wszystkich żądań (poza samym logowaniem),
   dzięki czemu pozostałe testy wyglądają jak dotychczas. */
const COOKIE_NAME = 'design_review_session';
let cookie = '';
const realFetch = globalThis.fetch;

globalThis.fetch = (url, options) => {
  const opts = Object.assign({}, options);
  if (cookie && !String(url).endsWith('/api/login')) {
    opts.headers = Object.assign({}, options && options.headers, { Cookie: cookie });
  }
  return realFetch(url, opts);
};

async function login() {
  const res = await realFetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: readUid() }),
  });
  if (res.status === 200) {
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') || ''];
    for (const line of raw) {
      const m = new RegExp(`^${COOKIE_NAME}=[^;]*`).exec(String(line));
      if (m) cookie = m[0];
    }
  }
  return res;
}

function check(label, condition, extra) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra ? ' → ' + extra : ''}`);
  }
}

async function main() {
  if (!fs.existsSync(ZIP)) throw new Error('Brak pliku ' + ZIP);

  console.log('\n0. Dostęp i logowanie');
  const anonList = await realFetch(`${BASE}/api/projects`);
  check('bez logowania lista projektów jest zablokowana (401)', anonList.status === 401, String(anonList.status));

  const anonHome = await realFetch(`${BASE}/`, { redirect: 'manual' });
  check('bez logowania strona główna przekierowuje na /login',
    (anonHome.status === 302 || anonHome.status === 303) && anonHome.headers.get('location') === '/login',
    `${anonHome.status} → ${anonHome.headers.get('location')}`);

  const badLogin = await realFetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'nie-taki-uid' }),
  });
  check('błędny uid odrzucony (401)', badLogin.status === 401, String(badLogin.status));

  const loginRes = await login();
  check('logowanie poprawnym uid (200)', loginRes.status === 200, String(loginRes.status));
  check('otrzymano ciasteczko sesji', !!cookie, cookie);

  const homeRes = await fetch(`${BASE}/`);
  check('zalogowany widzi stronę główną (200)', homeRes.status === 200, String(homeRes.status));

  const sessionRes = await fetch(`${BASE}/api/session`);
  const session = await sessionRes.json();
  check('sesja zgłasza zalogowanie i zwraca uid', session.authed === true && session.uid === readUid());

  console.log('\n1. Upload archiwum ZIP');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(ZIP)], { type: 'application/zip' }), 'landing.zip');
  form.append('name', 'Smoke test');

  const uploadRes = await fetch(`${BASE}/api/projects`, { method: 'POST', body: form });
  const upload = await uploadRes.json();
  check('HTTP 201', uploadRes.status === 201, JSON.stringify(upload));
  if (!upload.project) throw new Error('Brak projektu w odpowiedzi: ' + JSON.stringify(upload));

  const project = upload.project;
  console.log(`    id: ${project.id}, entry: ${project.entry}`);
  check('wykryto index.html', project.entry === 'index.html', project.entry);
  check('policzono pliki (4)', project.files === 4, String(project.files));

  console.log('\n2. Wstrzyknięcie warstwy adnotacji do HTML');
  const pageRes = await fetch(BASE + project.entryUrl);
  const html = await pageRes.text();
  check('strona działa (200)', pageRes.status === 200);
  check('wstawiono <script src="/annotator.js">', html.includes('/annotator.js'));
  check('usunięto meta CSP', !/content-security-policy/i.test(html));

  console.log('\n3. Zasoby (CSS)');
  const cssRes = await fetch(`${BASE}/p/${project.id}/style.css`);
  check('style.css podany jako text/css', /text\/css/.test(cssRes.headers.get('content-type') || ''));
  check('CSS bez wstrzykiwania skryptu', !(await cssRes.text()).includes('annotator.js'));

  const dirRes = await fetch(`${BASE}/p/${project.id}/`, { redirect: 'follow' });
  const dirHtml = await dirRes.text();
  check('/p/<id>/ trafia na plik startowy', dirRes.status === 200 && dirRes.url.endsWith(project.entry), dirRes.url);
  check('/p/<id>/ ma wstrzyknięty skrypt', dirHtml.includes('/annotator.js'));

  console.log('\n3b. Archiwum ZIP z projektu');
  const zipRes = await fetch(`${BASE}/api/projects/${project.id}/archive`);
  check('archiwum: HTTP 200', zipRes.status === 200, String(zipRes.status));
  check('archiwum: typ application/zip', /application\/zip/.test(zipRes.headers.get('content-type') || ''));
  check('archiwum: nagłówek pobierania', /attachment/.test(zipRes.headers.get('content-disposition') || ''), zipRes.headers.get('content-disposition') || '');

  const AdmZip = require('adm-zip');
  const zipEntries = new AdmZip(Buffer.from(await zipRes.arrayBuffer()))
    .getEntries()
    .map((e) => String(e.entryName).replace(/^\/+/, ''));
  check('archiwum zawiera plik startowy', zipEntries.includes('index.html'), zipEntries.join(', '));
  check('archiwum zawiera zasoby', zipEntries.includes('style.css'), zipEntries.join(', '));
  check('archiwum nie zawiera komentarzy', !zipEntries.some((n) => /\.json$/i.test(n)), zipEntries.join(', '));

  console.log('\n4. Komentarze');
  const pinRes = await fetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Anna',
      text: 'Ten przycisk powinien być większy.',
      type: 'pin',
      anchor: {
        x: 120, y: 340, docWidth: 1200, docHeight: 2400,
        target: { xpath: '/body[1]/main[1]/button[1]', fx: 0.5, fy: 0.25 },
      },
    }),
  });
  check('pinezka: HTTP 201', pinRes.status === 201, String(pinRes.status));
  const pinComment = (await pinRes.json()).comment;
  check('pinezka zapisuje element docelowy',
    !!pinComment.anchor.target && pinComment.anchor.target.xpath === '/body[1]/main[1]/button[1]',
    JSON.stringify(pinComment.anchor));
  check('ułamki położenia są znormalizowane',
    pinComment.anchor.target.fx === 0.5 && pinComment.anchor.target.fy === 0.25);

  const badTargetRes = await fetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Anna', text: 'Pinezka bez elementu.', type: 'pin',
      anchor: { x: 10, y: 20, target: { fx: 0.5, fy: 0.5 } },
    }),
  });
  const badTarget = (await badTargetRes.json()).comment;
  check('nieprawidłowy element docelowy jest pomijany, pinezka nadal działa',
    badTargetRes.status === 201 && !badTarget.anchor.target, JSON.stringify(badTarget.anchor));

  const textRes = await fetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Bartek',
      text: 'Skróć to zdanie.',
      type: 'text',
      anchor: {
        startXPath: '/body[1]/main[1]/p[1]/text()[1]',
        startOffset: 0,
        endXPath: '/body[1]/main[1]/p[1]/text()[1]',
        endOffset: 30,
        text: 'Acme pomaga zespołom produktowym',
      },
    }),
  });
  check('zakres tekstu: HTTP 201', textRes.status === 201, String(textRes.status));

  const badRes = await fetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: '', text: '', type: 'pin', anchor: {} }),
  });
  check('walidacja odrzuca pusty komentarz (400)', badRes.status === 400, String(badRes.status));

  const listRes = await fetch(`${BASE}/api/projects/${project.id}/comments`);
  const list = await listRes.json();
  check('odczytano 3 komentarze', list.comments.length === 3, String(list.comments.length));
  check('kolejność zachowana',
    list.comments[0].author === 'Anna' && list.comments[2].author === 'Bartek' && list.comments[2].type === 'text',
    list.comments.map((c) => c.author + ':' + c.type).join(', '));

  const resolveRes = await fetch(`${BASE}/api/projects/${project.id}/comments/${list.comments[0].id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved: true }),
  });
  check('oznaczenie jako rozwiązany', resolveRes.status === 200 && (await resolveRes.json()).comment.resolved === true);

  console.log('\n5. Zabezpieczenia');
  const traversal = await fetch(`${BASE}/p/${project.id}/..%2f..%2fserver.js`);
  check('blokada path traversal', traversal.status === 404, String(traversal.status));

  // Widok recenzji i komentarze są publiczne – osoba z linku nie musi się logować.
  const anonView = await realFetch(`${BASE}/v/${project.id}`);
  check('widok recenzji dostępny bez logowania', anonView.status === 200, String(anonView.status));
  const anonComments = await realFetch(`${BASE}/api/projects/${project.id}/comments`);
  check('komentarze dostępne bez logowania', anonComments.status === 200, String(anonComments.status));
  const anonUpload = await realFetch(`${BASE}/api/projects`, { method: 'POST', body: new FormData() });
  check('upload bez logowania zablokowany (401)', anonUpload.status === 401, String(anonUpload.status));
  const anonDelete = await realFetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE' });
  check('usuwanie bez logowania zablokowane (401)', anonDelete.status === 401, String(anonDelete.status));

  const noZip = new FormData();
  noZip.append('file', new Blob(['to nie jest zip'], { type: 'text/plain' }), 'notazip.txt');
  const noZipRes = await fetch(`${BASE}/api/projects`, { method: 'POST', body: noZip });
  check('odrzuca plik inny niż ZIP', noZipRes.status === 400, String(noZipRes.status));

  console.log('\n5b. Hasło dostępu do strony');
  const setPwRes = await fetch(`${BASE}/api/projects/${project.id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'tajne-haslo' }),
  });
  const setPw = await setPwRes.json();
  check('ustawienie hasła (200)', setPwRes.status === 200, JSON.stringify(setPw));
  check('projekt zgłasza blokadę', !!(setPw.project && setPw.project.locked === true));
  check('hasło nie wycieka w odpowiedzi',
    !JSON.stringify(setPw).includes('tajne-haslo') && !/accessToken|passwordHash|"salt"/.test(JSON.stringify(setPw)),
    JSON.stringify(setPw));

  const anonLockedView = await realFetch(`${BASE}/v/${project.id}`, { redirect: 'manual' });
  check('zablokowany widok przekierowuje na /unlock',
    anonLockedView.status === 302 &&
      (anonLockedView.headers.get('location') || '').startsWith(`/unlock/${project.id}`),
    `${anonLockedView.status} → ${anonLockedView.headers.get('location')}`);

  const anonLockedPage = await realFetch(BASE + project.entryUrl);
  check('zablokowane pliki strony (403)', anonLockedPage.status === 403, String(anonLockedPage.status));

  const anonLockedApi = await realFetch(`${BASE}/api/projects/${project.id}`);
  check('zablokowane API projektu (401)', anonLockedApi.status === 401, String(anonLockedApi.status));

  const anonLockedPost = await realFetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Intruz', text: 'Nie powinno przejść.', type: 'pin',
      anchor: { x: 10, y: 10 },
    }),
  });
  check('zablokowane dodawanie komentarzy (401)', anonLockedPost.status === 401, String(anonLockedPost.status));

  const adminPage = await fetch(BASE + project.entryUrl);
  check('właściciel wchodzi bez hasła', adminPage.status === 200, String(adminPage.status));

  const badUnlock = await realFetch(`${BASE}/api/projects/${project.id}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'zle-haslo' }),
  });
  check('błędne hasło odrzucone (401)', badUnlock.status === 401, String(badUnlock.status));

  const goodUnlock = await realFetch(`${BASE}/api/projects/${project.id}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'tajne-haslo' }),
  });
  check('poprawne hasło odblokowuje (200)', goodUnlock.status === 200, String(goodUnlock.status));

  const unlockCookies = typeof goodUnlock.headers.getSetCookie === 'function'
    ? goodUnlock.headers.getSetCookie()
    : [goodUnlock.headers.get('set-cookie') || ''];
  let projectCookie = '';
  for (const line of unlockCookies) {
    const m = new RegExp(`^dr_p_${project.id}=[^;]*`).exec(String(line));
    if (m) projectCookie = m[0];
  }
  check('otrzymano ciasteczko odblokowujące', !!projectCookie, unlockCookies.join(' | '));

  const unlockedPage = await realFetch(BASE + project.entryUrl, { headers: { Cookie: projectCookie } });
  check('odblokowane pliki dostępne (200)', unlockedPage.status === 200, String(unlockedPage.status));
  const unlockedView = await realFetch(`${BASE}/v/${project.id}`, {
    headers: { Cookie: projectCookie }, redirect: 'manual',
  });
  check('odblokowany widok recenzji (200)', unlockedView.status === 200, String(unlockedView.status));

  const changePw = await fetch(`${BASE}/api/projects/${project.id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'inne-haslo' }),
  });
  check('zmiana hasła (200)', changePw.status === 200);

  const staleCookie = await realFetch(BASE + project.entryUrl, { headers: { Cookie: projectCookie } });
  check('zmiana hasła unieważnia wcześniejsze odblokowanie', staleCookie.status === 403, String(staleCookie.status));

  const clearPwRes = await fetch(`${BASE}/api/projects/${project.id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '' }),
  });
  const clearPw = await clearPwRes.json();
  check('usunięcie hasła (200)', clearPwRes.status === 200 && clearPw.project && clearPw.project.locked === false,
    JSON.stringify(clearPw));

  const publicAgain = await realFetch(`${BASE}/v/${project.id}`, { redirect: 'manual' });
  check('po usunięciu hasła widok znów publiczny', publicAgain.status === 200, String(publicAgain.status));

  console.log('\n6. Sprzątanie');
  const delRes = await fetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE' });
  check('usunięcie projektu', delRes.status === 200);
  const after = await fetch(`${BASE}/api/projects`);
  const afterJson = await after.json();
  check('projekt zniknął z listy', !afterJson.projects.some((p) => p.id === project.id));
  const gonePage = await fetch(BASE + project.entryUrl);
  check('strona nie jest już dostępna', gonePage.status === 404, String(gonePage.status));

  console.log(failures === 0 ? '\nWszystkie testy przeszły ✓\n' : `\nNiepowodzenia: ${failures}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest przerwany:', err.message, '\n');
  process.exit(1);
});
