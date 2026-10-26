'use strict';

/**
 * Prosty test "dymny" API. Uruchom przy działającym serwerze:
 *   npm start
 *   node scripts/smoke-test.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  check('warstwa adnotacji zna nazwę pliku', html.includes('data-page="index.html"'), 'brak data-page');
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
  check('komentarz bez pola page trafia na stronę startową',
    pinComment.page === 'index.html', String(pinComment.page));
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

  console.log('\n4b. Komentarze przypisane do podstron');
  const aboutHtml = await (await fetch(`${BASE}/p/${project.id}/about.html`)).text();
  check('warstwa adnotacji na podstronie zna jej nazwę',
    aboutHtml.includes('data-page="about.html"'), 'brak data-page="about.html"');

  const aboutRes = await fetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Celina',
      text: 'Ta podstrona potrzebuje innego nagłówka.',
      type: 'pin',
      page: 'about.html',
      anchor: { x: 44, y: 88, target: { xpath: '/body[1]/main[1]/h1[1]', fx: 0.5, fy: 0.5 } },
    }),
  });
  const aboutComment = (await aboutRes.json()).comment;
  check('komentarz zapisany z konkretnym plikiem',
    aboutRes.status === 201 && aboutComment.page === 'about.html', String(aboutComment.page));

  const badPage = await fetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Celina', text: 'Poza projektem.', type: 'pin', page: '../server.js',
      anchor: { x: 1, y: 2 },
    }),
  });
  check('odrzuca stronę spoza projektu (400)', badPage.status === 400, String(badPage.status));

  const missingPage = await fetch(`${BASE}/api/projects/${project.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: 'Celina', text: 'Nie ma takiej strony.', type: 'pin', page: 'nie-ma-takiej.html',
      anchor: { x: 1, y: 2 },
    }),
  });
  check('odrzuca nieistniejący plik (400)', missingPage.status === 400, String(missingPage.status));

  const pages = (await (await fetch(`${BASE}/api/projects/${project.id}/comments`)).json()).comments;
  check('lista zwraca stronę przy każdym komentarzu',
    pages.every((c) => typeof c.page === 'string' && c.page), pages.map((c) => c.page).join(', '));
  check('komentarze ze strony startowej i podstrony są rozróżnialne',
    pages.filter((c) => c.page === 'index.html').length === 3
      && pages.filter((c) => c.page === 'about.html').length === 1,
    pages.map((c) => c.page).join(', '));

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

  console.log('\n5c. Podmiana plików bez zmiany linku');
  const anonReplace = await realFetch(`${BASE}/api/projects/${project.id}/replace`, {
    method: 'POST', body: new FormData(),
  });
  check('podmiana bez logowania zablokowana (401)', anonReplace.status === 401, String(anonReplace.status));

  // Hasło ustawione przed podmianą – powinno przetrwać.
  await fetch(`${BASE}/api/projects/${project.id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'trwale-haslo' }),
  });

  const newZip = new AdmZip();
  newZip.addFile('index.html', Buffer.from(
    '<!doctype html><html><head><meta charset="utf-8"><title>Nowa</title></head>'
    + '<body><h1>NOWA WERSJA</h1></body></html>'
  ));
  newZip.addFile('style.css', Buffer.from('h1{color:red}'));
  const newZipBuf = newZip.toBuffer();

  const zipForm = (buffer, name) => {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: 'application/zip' }), name);
    return fd;
  };

  const replaceRes = await fetch(`${BASE}/api/projects/${project.id}/replace`, {
    method: 'POST', body: zipForm(newZipBuf, 'nowa-wersja.zip'),
  });
  const replaced = await replaceRes.json();
  check('podmiana plików (200)', replaceRes.status === 200, JSON.stringify(replaced).slice(0, 200));
  check('link bez zmian (to samo id)', replaced.project && replaced.project.id === project.id);
  check('wykryto nowy plik startowy', replaced.project.entry === 'index.html', String(replaced.project.entry));
  check('zaktualizowano liczbę plików', replaced.project.files === 2, String(replaced.project.files));
  check('zapisano czas podmiany', typeof replaced.project.updatedAt === 'number');

  const newHtml = await (await fetch(BASE + project.entryUrl)).text();
  check('serwowana jest nowa treść', newHtml.includes('NOWA WERSJA'));
  check('stara treść zniknęła', !newHtml.includes('Acme'));
  check('stare podstrony usunięte', (await fetch(`${BASE}/p/${project.id}/about.html`)).status === 404);
  check('stare zasoby usunięte', (await fetch(`${BASE}/p/${project.id}/img/placeholder.png`)).status === 404);

  const keptComments = (await (await fetch(`${BASE}/api/projects/${project.id}/comments`)).json()).comments;
  check('komentarze zachowane po podmianie', keptComments.length === 4, String(keptComments.length));

  const lockedAfter = await realFetch(`${BASE}/v/${project.id}`, { redirect: 'manual' });
  check('hasło przetrwało podmianę',
    lockedAfter.status === 302 && (lockedAfter.headers.get('location') || '').startsWith(`/unlock/${project.id}`),
    `${lockedAfter.status} → ${lockedAfter.headers.get('location')}`);

  const badZipRes = await fetch(`${BASE}/api/projects/${project.id}/replace`, {
    method: 'POST', body: zipForm(Buffer.from('to nie jest zip'), 'zly.zip'),
  });
  check('nieprawidłowy ZIP odrzucony (400)', badZipRes.status === 400, String(badZipRes.status));
  const afterBad = await (await fetch(BASE + project.entryUrl)).text();
  check('po błędzie pliki pozostały nietknięte', afterBad.includes('NOWA WERSJA'));

  const clearAfter = await fetch(`${BASE}/api/projects/${project.id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '' }),
  });
  check('hasło usunięte po teście podmiany', clearAfter.status === 200);

  console.log('\n5d. Strona na żywo (WordPress)');
  const postUrl = (body) => fetch(`${BASE}/api/projects/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const anonLive = await realFetch(`${BASE}/api/projects/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  check('bez logowania nie da się dodać strony (401)', anonLive.status === 401, String(anonLive.status));
  check('odrzucony adres ftp://', (await postUrl({ url: 'ftp://example.com/' })).status === 400);
  check('odrzucony pusty adres', (await postUrl({ url: '' })).status === 400);
  check('odrzucony adres z danymi logowania', (await postUrl({ url: 'https://a:b@example.com/' })).status === 400);

  const liveRes = await postUrl({ url: 'example.com/oferta/#sekcja', name: 'Smoke live' });
  const liveJson = await liveRes.json();
  check('dodanie strony na żywo (201)', liveRes.status === 201, JSON.stringify(liveJson));
  const live = liveJson.project;
  check('typ projektu: url', live.kind === 'url', live.kind);
  check('adres uzupełniony o https i bez kotwicy', live.url === 'https://example.com/oferta/', live.url);
  check('strona startowa to ścieżka adresu', live.entry === '/oferta/', live.entry);
  check('dozwolone originy obejmują wariant www',
    JSON.stringify(live.origins) === JSON.stringify(['https://example.com', 'https://www.example.com']),
    JSON.stringify(live.origins));
  // Skrypt wkleja się raz, więc nie może zawierać wersji – stary numer
  // zostałby w kodzie strony po aktualizacji aplikacji.
  check('odpowiedź zawiera skrypt do wklejenia (bez wersji w adresie)',
    /<script src="https?:\/\/[^"]+\/annotator\.js" defer><\/script>/.test(liveJson.snippet || ''),
    liveJson.snippet);

  const listLive = await (await fetch(`${BASE}/api/projects`)).json();
  check('lista projektów podaje skrypt', listLive.snippet === liveJson.snippet);
  check('strona na żywo jest na liście', listLive.projects.some((p) => p.id === live.id && p.kind === 'url'));

  const annRes = await realFetch(`${BASE}/annotator.js`);
  check('annotator.js dostępny publicznie jako JavaScript',
    annRes.status === 200 && /javascript/.test(annRes.headers.get('content-type') || ''),
    `${annRes.status} ${annRes.headers.get('content-type')}`);

  const annBody = await annRes.text();
  const annHash = crypto.createHash('sha1').update(annBody).digest('hex').slice(0, 12);

  const annVersioned = await realFetch(`${BASE}/annotator.js?v=${annHash}`);
  check('aktualna wersja (strony z ZIP-a) może być w cache „na zawsze”',
    /immutable/.test(annVersioned.headers.get('cache-control') || ''),
    annVersioned.headers.get('cache-control'));
  check('skrypt wklejany na strony na żywo jest sprawdzany przy każdym użyciu (no-cache)',
    /no-cache/.test(annRes.headers.get('cache-control') || '') && !/immutable/.test(annRes.headers.get('cache-control') || ''),
    annRes.headers.get('cache-control'));
  const annStale = await realFetch(`${BASE}/annotator.js?v=000000000000`);
  check('nieaktualna wersja nie jest cache\'owana „na zawsze”',
    /no-cache/.test(annStale.headers.get('cache-control') || ''), annStale.headers.get('cache-control'));

  // fetch() z Node przy If-None-Match sam dokłada "Cache-Control: no-cache",
  // co wymusza pełną odpowiedź – dlatego zwykłe żądanie przez moduł http.
  const etag = annRes.headers.get('etag');
  const revalidatedStatus = etag ? await new Promise((resolve) => {
    const lib = require(BASE.startsWith('https') ? 'https' : 'http');
    lib.get(`${BASE}/annotator.js`, { headers: { 'If-None-Match': etag } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', () => resolve(0));
  }) : 0;
  check('niezmieniony skrypt kończy się odpowiedzią 304 (ETag)',
    revalidatedStatus === 304, etag ? String(revalidatedStatus) : 'brak ETag');

  const zipHtmlForAnnotator = await (await fetch(`${BASE}/p/${project.id}/`)).text();
  check('strona z ZIP-a podaje aktualną wersję skryptu',
    zipHtmlForAnnotator.includes(`/annotator.js?v=${annHash}`));

  const liveComment = (page, extra) => fetch(`${BASE}/api/projects/${live.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({
      author: 'Test', text: 'Na żywo', type: 'pin', page, anchor: { x: 10, y: 20 },
    }, extra)),
  });

  const lc1 = await liveComment('/oferta/', { postId: 42 });
  const lc1Json = await lc1.json();
  check('komentarz do podstrony na żywo (201)', lc1.status === 201, JSON.stringify(lc1Json));
  check('zapisano ścieżkę i ID wpisu', lc1Json.comment && lc1Json.comment.page === '/oferta/' && lc1Json.comment.postId === 42,
    JSON.stringify(lc1Json.comment));

  const lc2 = await (await liveComment('/?p=123&utm_source=x')).json();
  check('klucz podstrony zachowuje ?p=, pomija inne parametry', lc2.comment && lc2.comment.page === '/?p=123',
    JSON.stringify(lc2));

  const lc3 = await (await liveComment('', {})).json();
  check('komentarz bez strony trafia na stronę startową', lc3.comment && lc3.comment.page === '/oferta/',
    JSON.stringify(lc3));

  check('odrzucona strona z innej domeny', (await liveComment('//evil.com/x')).status === 400);
  check('odrzucony pełny adres zamiast ścieżki', (await liveComment('https://evil.com/x')).status === 400);
  check('odrzucona ścieżka normalizująca się do obcego hosta', (await liveComment('/a/..//evil.com')).status === 400);
  check('odrzucona zakodowana ścieżka do obcego hosta', (await liveComment('/%2e%2e//evil.com')).status === 400);
  check('odrzucona ścieżka z ukośnikiem odwrotnym do obcego hosta',
    (await liveComment('/' + String.fromCharCode(92) + 'evil.com')).status === 400);
  const normalized = await (await liveComment('/oferta/../kontakt/')).json();
  check('poprawna ścieżka z ".." jest normalizowana w obrębie witryny',
    normalized.comment && normalized.comment.page === '/kontakt/', JSON.stringify(normalized));
  const badPost = await (await liveComment('/kontakt/', { postId: 'abc' })).json();
  check('nieprawidłowe ID wpisu jest pomijane', badPost.comment && !('postId' in badPost.comment),
    JSON.stringify(badPost));

  const proxied = await (await fetch(`${BASE}/api/projects`, {
    headers: { 'X-Forwarded-Proto': 'https' },
  })).json();
  check('protokół skryptu z X-Forwarded-Proto (proxy HTTPS)',
    String(proxied.snippet || '').startsWith('<script src="https://'), proxied.snippet);

  const eidPin = await (await liveComment('/oferta/', {
    anchor: { x: 1, y: 2, target: { xpath: '/body[1]/div[3]/img[1]', fx: 0.5, fy: 0.5,
      eid: { id: '10fb84d8', n: 2, rel: 'div[1]/img[1]' } } },
  })).json();
  check('pinezka zapisuje kotwicę Elementora (data-id, wystąpienie, ścieżka)',
    eidPin.comment && JSON.stringify(eidPin.comment.anchor.target.eid) === '{"id":"10fb84d8","n":2,"rel":"div[1]/img[1]"}',
    JSON.stringify(eidPin.comment && eidPin.comment.anchor));

  const badEids = [
    { id: 'a"]b', n: 1, rel: '' },
    { id: 'abc', n: 0, rel: '' },
    { id: 'abc', n: 1, rel: '../div[1]' },
  ];
  let badDropped = true;
  for (const eid of badEids) {
    const r = await (await liveComment('/oferta/', {
      anchor: { x: 1, y: 2, target: { xpath: '/body[1]', fx: 0, fy: 0, eid } },
    })).json();
    if (!r.comment || r.comment.anchor.target.eid || r.comment.anchor.target.xpath !== '/body[1]') badDropped = false;
  }
  check('nieprawidłowa kotwica Elementora jest pomijana (XPath zostaje)', badDropped);

  const eidText = await (await liveComment('/oferta/', {
    type: 'text',
    anchor: {
      startXPath: '/body[1]/p[1]/text()[1]', startOffset: 0,
      endXPath: '/body[1]/p[1]/text()[1]', endOffset: 4, text: 'Acme',
      startEid: { id: 'ab12cd', n: 1, rel: 'p[1]/text()[1]' },
      endEid: { id: 'ab12cd', n: 1, rel: 'p[1]/text()[1]' },
    },
  })).json();
  check('zaznaczenie tekstu zapisuje kotwice Elementora',
    eidText.comment && eidText.comment.anchor.startEid && eidText.comment.anchor.startEid.rel === 'p[1]/text()[1]'
      && eidText.comment.anchor.endEid && eidText.comment.anchor.endEid.id === 'ab12cd',
    JSON.stringify(eidText));

  const liveArchive = await fetch(`${BASE}/api/projects/${live.id}/archive`);
  check('strona na żywo nie ma archiwum ZIP (400)', liveArchive.status === 400, String(liveArchive.status));

  const liveReplaceForm = new FormData();
  liveReplaceForm.append('file', new Blob([fs.readFileSync(ZIP)], { type: 'application/zip' }), 'landing.zip');
  const liveReplace = await fetch(`${BASE}/api/projects/${live.id}/replace`, { method: 'POST', body: liveReplaceForm });
  check('strony na żywo nie podmienia się ZIP-em (400)', liveReplace.status === 400, String(liveReplace.status));

  const liveFiles = await fetch(`${BASE}/p/${live.id}/index.html`);
  check('strona na żywo nie jest serwowana spod /p/ (404)', liveFiles.status === 404, String(liveFiles.status));

  const liveView = await fetch(`${BASE}/v/${live.id}`);
  check('widok recenzji strony na żywo działa (200)', liveView.status === 200, String(liveView.status));

  const liveDel = await fetch(`${BASE}/api/projects/${live.id}`, { method: 'DELETE' });
  check('usunięcie strony na żywo', liveDel.status === 200, String(liveDel.status));

  await notificationTests();

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

/**
 * Powiadomienia mailowe. Sprawdzamy je tylko na serwerze uruchomionym
 * w trybie zapisu do pliku z krótkimi czasami, np.:
 *   MAIL_TRANSPORT=log NOTIFY_EMAIL=test@example.com NOTIFY_QUIET_MS=1500 \
 *   NOTIFY_MAX_MS=4000 NOTIFY_TICK_MS=250 npm start
 */
async function notificationTests() {
  console.log('\n5e. Powiadomienia mailowe');
  const status = await (await fetch(`${BASE}/api/notifications`)).json();
  const quiet = (status.quietMinutes || 0) * 60000;
  const max = (status.maxMinutes || 0) * 60000;
  if (!status.enabled || status.transport !== 'log' || quiet > 10000) {
    console.log('  – pominięte (serwer nie działa w trybie MAIL_TRANSPORT=log z krótkimi czasami)');
    return;
  }

  const OUTBOX = path.join(__dirname, '..', 'data', 'outbox');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mailsFor = (needle) => {
    let files = [];
    try { files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')); } catch { return []; }
    return files
      .map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')))
      .filter((m) => String(m.subject).includes(needle))
      .sort((a, b) => a.sentAt - b.sentAt);
  };
  const waitForMails = async (needle, count, timeout) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (mailsFor(needle).length >= count) break;
      await sleep(100);
    }
    return mailsFor(needle);
  };

  const name = 'Smoke powiadomienia ' + Date.now().toString(36);
  const created = await (await fetch(`${BASE}/api/projects/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/', name }),
  })).json();
  const pid = created.project.id;
  const addComment = (text, asOwner) => (asOwner ? fetch : realFetch)(`${BASE}/api/projects/${pid}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'Recenzent', text, type: 'pin', page: '/', anchor: { x: 1, y: 1 } }),
  }).then((r) => r.json());

  const c1 = await addComment('Pierwsza uwaga <b>pogrubiona?</b>');
  await addComment('Druga uwaga');
  await addComment('Komentarz właściciela', true);
  await sleep(quiet / 3);
  check('przed upływem ciszy nic nie wychodzi', mailsFor(name).length === 0, String(mailsFor(name).length));

  const first = await waitForMails(name, 1, quiet + 3000);
  check('po ciszy wychodzi jeden zbiorczy mail', first.length === 1, String(first.length));
  const mail = first[0] || {};
  check('temat podaje liczbę komentarzy i projekt', /2 nowe komentarze – /.test(mail.subject || ''), mail.subject);
  check('mail trafia na adres z konfiguracji', mail.to === status.to, mail.to);
  check('treść zawiera oba komentarze recenzenta',
    /Pierwsza uwaga/.test(mail.text || '') && /Druga uwaga/.test(mail.text || ''));
  check('komentarz właściciela nie wyzwala powiadomienia', !/Komentarz właściciela/.test(mail.text || ''));
  check('link prowadzi do konkretnego komentarza', (mail.text || '').includes(`/v/${pid}?c=${c1.comment.id}`),
    (mail.text || '').slice(0, 200));
  check('HTML komentarza jest zabezpieczony', /&lt;b&gt;pogrubiona\?&lt;\/b&gt;/.test(mail.html || ''));

  await addComment('Tylko właściciel', true);
  await sleep(quiet + 1000);
  check('same komentarze właściciela nie dają maila', mailsFor(name).length === 1, String(mailsFor(name).length));

  // Ciągłe komentowanie (krócej niż okno ciszy) – mail i tak wychodzi po czasie maksymalnym.
  const start = Date.now();
  let sentWhileActive = false;
  while (Date.now() - start < max + quiet) {
    await addComment('Seria ' + (Date.now() - start));
    await sleep(quiet / 2);
    if (mailsFor(name).length > 1) { sentWhileActive = true; break; }
  }
  check('przy ciągłym komentowaniu mail wychodzi po czasie maksymalnym', sentWhileActive);

  const testRes = await fetch(`${BASE}/api/notifications/test`, { method: 'POST' });
  check('mail testowy z panelu (200)', testRes.status === 200, String(testRes.status));
  check('mail testowy zapisany', (await waitForMails('Testowe powiadomienie', 1, 2000)).length >= 1);
  const anonTest = await realFetch(`${BASE}/api/notifications/test`, { method: 'POST' });
  check('mail testowy tylko dla zalogowanego (401)', anonTest.status === 401, String(anonTest.status));

  await fetch(`${BASE}/api/projects/${pid}`, { method: 'DELETE' });
}

main().catch((err) => {
  console.error('\nTest przerwany:', err.message, '\n');
  process.exit(1);
});
