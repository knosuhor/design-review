'use strict';

/* Widok recenzji: iframe z designem + panel komentarzy. */

const $ = (sel) => document.querySelector(sel);
const NS = 'design-review';
const NAME_KEY = 'design-review:name';
const FILTER_KEY = 'design-review:hide-resolved';

const pathParts = location.pathname.split('/').filter(Boolean);
const projectId = decodeURIComponent(pathParts[pathParts.length - 1] || '');

const iframe = $('#preview');
const loader = $('#loader');
const nameEl = $('#project-name');
const metaEl = $('#project-meta');
const pinToggle = $('#pin-toggle');
const pinIco = $('#pin-ico');
const pinLabel = $('#pin-label');
const copyShare = $('#copy-share');
const downloadZip = $('#download-zip');
const openNew = $('#open-new');
const form = $('#comment-form');
const formKind = $('#form-kind');
const formQuote = $('#form-quote');
const formError = $('#form-error');
const authorInput = $('#author');
const textInput = $('#text');
const submitBtn = $('#submit-comment');
const cancelBtn = $('#cancel-comment');
const listEl = $('#comment-list');
const countEl = $('#comment-count');
const hintEl = $('#hint');
const hintFilteredEl = $('#hint-filtered');
const homeLink = $('#home-link');
const homeIco = $('#home-ico');
const homeLabel = $('#home-label');
const resolvedFilter = $('#resolved-filter');
const scrollEl = $('#sidebar-scroll');
const toastEl = $('#toast');
const lostEl = $('#lost');
const lostTitle = $('#lost-title');
const lostDesc = $('#lost-desc');
const lostBack = $('#lost-back');
const lostOpen = $('#lost-open');

// Czas na odpowiedź warstwy adnotacji po wczytaniu strony w ramce.
const CHILD_TIMEOUT = 3500;

let project = null;
let comments = [];
let pending = null;       // aktualnie tworzony komentarz: {kind, page, anchor, preview}
let mode = 'select';
let activeId = null;
let childReady = false;
let currentPage = '';     // strona aktualnie otwarta w podglądzie (plik albo ścieżka adresu)
let currentPostId = null; // ID wpisu WordPressa otwartej strony (strony na żywo)
let pendingFocusId = null; // komentarz, do którego wracamy po wczytaniu innej strony
let missingIds = new Set();
let concealedIds = new Set(); // miejsca, które są teraz ukryte (akordeon, zakładka, slajd)
let hideResolved = localStorage.getItem(FILTER_KEY) === '1';
let toastTimer = null;

// Połączenie z warstwą adnotacji w ramce.
let allowedOrigins = [location.origin]; // skąd przyjmujemy wiadomości ramki
let childOrigin = '';     // origin dokumentu, który ostatnio się zgłosił
let childAlive = false;   // czy obecny dokument w ramce odpowiada
let everConnected = false;
let lastGoodUrl = '';     // ostatnia strona, na której warstwa działała
let aliveTimer = null;

/* ------------------------------- pomocnicze ------------------------------- */

/**
 * Krótki komunikat u dołu ekranu. Opcjonalny `action` ({ label, href })
 * dodaje link otwierany w nowej karcie – wtedy komunikat wisi dłużej.
 */
function toast(message, isError, action) {
  toastEl.textContent = message;
  if (action) {
    const link = document.createElement('a');
    link.className = 'toast-action';
    link.href = action.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = action.label;
    toastEl.append(' ', link);
  }
  toastEl.classList.toggle('err', !!isError);
  toastEl.classList.toggle('has-action', !!action);
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => { toastEl.hidden = true; }, 220);
  }, action ? 6000 : 2600);
}

function isLive() {
  return !!project && project.kind === 'url';
}

/** Nazwa strony do wyświetlenia (ścieżki adresów bywają zakodowane). */
function pageLabel(page) {
  try { return decodeURI(page); } catch { return page; }
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data = {};
  try { data = await res.json(); } catch { /* brak JSON */ }
  if (res.status === 401 && data.unlock) {
    // Strona zabezpieczona hasłem – przejdź na ekran jego wpisywania.
    location.href = data.unlock + '?next=' + encodeURIComponent(location.pathname);
    return new Promise(() => {});
  }
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

/**
 * Wiadomość do warstwy adnotacji. Wysyłana wyłącznie pod origin dokumentu,
 * który się zgłosił – jeśli ramka przeszła na obcą stronę, nic do niej nie trafi.
 */
function postToChild(message, origin) {
  const target = origin || childOrigin;
  if (!iframe.contentWindow || !target) return;
  try {
    iframe.contentWindow.postMessage(Object.assign({ ns: NS }, message), target);
  } catch { /* nic */ }
}

/** Identyfikatory komentarzy, które mają być niewidoczne w podglądzie. */
function hiddenCommentIds() {
  return hideResolved ? comments.filter((c) => c.resolved).map((c) => c.id) : [];
}

/**
 * Czy komentarz dotyczy strony otwartej w podglądzie. Na stronie na żywo
 * liczy się też ID wpisu WordPressa – komentarz zostaje na swojej podstronie
 * po zmianie jej adresu.
 */
function onCurrentPage(c) {
  if (!currentPage) return false;
  if (c.page === currentPage) return true;
  return currentPostId != null && c.postId === currentPostId;
}

/** Komentarze dotyczące strony aktualnie otwartej w podglądzie. */
function commentsForPage() {
  return comments.filter(onCurrentPage);
}

/** Numer komentarza w obrębie jego własnej strony (zgodny z numerem pinezki). */
function commentNumber(comment) {
  const samePage = onCurrentPage(comment) ? onCurrentPage : (c) => c.page === comment.page;
  let n = 0;
  for (const c of comments) {
    if (samePage(c)) {
      n++;
      if (c.id === comment.id) return n;
    }
  }
  return 0;
}

function pageUrl(page) {
  if (isLive()) {
    // Zabezpieczenie przed kluczem wskazującym inny host (np. "//evil.com"):
    // ramka może wczytać wyłącznie recenzowaną witrynę.
    const allowed = project.origins || [project.origin];
    try {
      const url = new URL(page, project.origin);
      if (!allowed.includes(url.origin)) return project.entryUrl;
      return url.href;
    } catch {
      return project.entryUrl;
    }
  }
  return '/p/' + encodeURIComponent(projectId) + '/'
    + page.split('/').map(encodeURIComponent).join('/');
}

function pushCommentsToChild() {
  // Warstwa adnotacji dostaje wyłącznie komentarze swojego pliku – inaczej
  // XPath z jednej podstrony trafiałby w przypadkowe elementy innej.
  postToChild({ type: 'set-comments', comments: commentsForPage() });
  postToChild({ type: 'set-hidden', ids: hiddenCommentIds() });
}

/** Pasek pod nazwą projektu: otwarta strona, liczba komentarzy, rozmiar. */
function renderMeta() {
  if (!project) return;
  const parts = [];
  if (isLive()) parts.push(new URL(project.origin).host);
  if (currentPage) parts.push(pageLabel(currentPage));
  parts.push(`${comments.length} komentarz(y)`);
  if (!isLive()) {
    parts.push(`${project.files} plik(ów)`);
    parts.push(formatBytes(project.size));
  }
  metaEl.textContent = parts.join(' · ');
  metaEl.title = currentPage ? 'Otwarta strona: ' + pageLabel(currentPage) : '';
}

function formatBytes(bytes) {
  if (!bytes) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'przed chwilą';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 min temu' : `${m} min temu`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 godz. temu' : `${h} godz. temu`;
  const d = Math.round(h / 24);
  if (d === 1) return 'wczoraj';
  if (d < 7) return `${d} dni temu`;
  return new Date(ts).toLocaleDateString('pl-PL');
}

/* ----------------------------- panel komentarzy --------------------------- */

function renderList() {
  listEl.textContent = '';

  const visibleComments = hideResolved ? comments.filter((c) => !c.resolved) : comments;
  const resolvedCount = comments.filter((c) => c.resolved).length;

  countEl.textContent = String(visibleComments.length);

  hintEl.hidden = comments.length > 0;
  hintFilteredEl.hidden = !(comments.length > 0 && visibleComments.length === 0);
  if (!hintFilteredEl.hidden) {
    hintFilteredEl.textContent = hideResolved
      ? `Rozwiązane komentarze (${comments.length}) są ukryte. Użyj przycisku „Pokaż rozwiązane”, aby je wyświetlić.`
      : '';
  }

  resolvedFilter.classList.toggle('toggled', hideResolved);
  resolvedFilter.textContent = (hideResolved ? 'Pokaż rozwiązane' : 'Ukryj rozwiązane')
    + (resolvedCount ? ` (${resolvedCount})` : '');
  resolvedFilter.setAttribute('aria-pressed', hideResolved ? 'true' : 'false');

  comments.forEach((comment) => {
    if (hideResolved && comment.resolved) return;
    const onOtherPage = !onCurrentPage(comment);
    const li = document.createElement('li');
    li.className = 'comment'
      + (comment.id === activeId ? ' active' : '')
      + (comment.resolved ? ' resolved' : '')
      + (onOtherPage ? ' other-page' : '');
    li.dataset.id = comment.id;

    const head = document.createElement('div');
    head.className = 'comment-head';

    const num = document.createElement('span');
    num.className = 'num';
    const numText = document.createElement('span');
    numText.textContent = String(commentNumber(comment));
    num.appendChild(numText);

    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = comment.author;

    const time = document.createElement('time');
    time.className = 'time';
    time.textContent = relTime(comment.createdAt);
    time.title = new Date(comment.createdAt).toLocaleString('pl-PL');

    head.append(num, author, time);

    if (onOtherPage) {
      const chip = document.createElement('span');
      chip.className = 'page-chip';
      chip.textContent = pageLabel(comment.page);
      chip.title = 'Komentarz do strony: ' + pageLabel(comment.page) + ' – kliknij, aby ją otworzyć';
      head.insertBefore(chip, time);
    }

    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = comment.text;

    li.append(head, body);

    if (comment.type === 'text' && comment.anchor && comment.anchor.text) {
      const quote = document.createElement('div');
      quote.className = 'comment-quote';
      quote.textContent = '„' + comment.anchor.text + '”';
      li.appendChild(quote);
    }

    if (missingIds.has(comment.id)) {
      const broken = document.createElement('div');
      broken.className = 'broken';
      broken.textContent = '⚠ Nie można odnaleźć tego miejsca na stronie (strona mogła się zmienić).';
      li.appendChild(broken);
    } else if (concealedIds.has(comment.id)) {
      const note = document.createElement('div');
      note.className = 'concealed';
      note.textContent = 'Miejsce jest teraz ukryte na stronie (np. zwinięty akordeon, zakładka lub slajd).';
      li.appendChild(note);
    }

    const foot = document.createElement('div');
    foot.className = 'comment-foot';

    const resolveBtn = document.createElement('button');
    resolveBtn.type = 'button';
    resolveBtn.textContent = comment.resolved ? 'Oznacz jako nierozwiązany' : 'Oznacz jako rozwiązany';
    resolveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const data = await api(`/api/projects/${projectId}/comments/${comment.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolved: !comment.resolved }),
        });
        const idx = comments.findIndex((c) => c.id === comment.id);
        if (idx !== -1) comments[idx] = data.comment;
        pushCommentsToChild();
        renderList();
      } catch (err) {
        toast(err.message, true);
      }
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'del';
    delBtn.textContent = 'Usuń';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await drConfirm({
        title: 'Usunąć komentarz?',
        message: 'Komentarz zniknie także z podglądu strony. Tej operacji nie można cofnąć.',
        confirmText: 'Usuń komentarz',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/projects/${projectId}/comments/${comment.id}`, { method: 'DELETE' });
        comments = comments.filter((c) => c.id !== comment.id);
        if (activeId === comment.id) activeId = null;
        renderMeta();
        pushCommentsToChild();
        renderList();
      } catch (err) {
        toast(err.message, true);
      }
    });

    foot.append(resolveBtn, delBtn);
    li.appendChild(foot);

    li.addEventListener('click', () => selectComment(comment.id, true));

    listEl.appendChild(li);
  });
}

function selectComment(id, scrollPage) {
  const comment = comments.find((c) => c.id === id);
  if (!comment) return;

  activeId = id;
  renderList();

  // Komentarz z innej podstrony: najpierw wczytaj tę stronę, potem go pokaż.
  if (comment.page && !onCurrentPage(comment)) {
    openPage(comment.page, id);
    return;
  }

  postToChild(scrollPage ? { type: 'focus', id } : { type: 'select', id });
  const el = listEl.querySelector(`[data-id="${id}"]`);
  if (el && scrollPage) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Wczytuje w podglądzie wskazany plik i (opcjonalnie) podświetla komentarz. */
function openPage(page, focusId) {
  loadInFrame(pageUrl(page), focusId);
}

function loadInFrame(url, focusId) {
  pendingFocusId = focusId || null;
  missingIds = new Set();
  concealedIds = new Set();
  childReady = false;
  childAlive = false;
  hideLost();
  loader.hidden = false;
  pinToggle.disabled = true;
  iframe.src = url;
  // Bezpiecznik na wypadek, gdyby ramka w ogóle nie zgłosiła wczytania.
  armAliveCheck(CHILD_TIMEOUT * 4);
}

/* -------------------------------- formularz -------------------------------- */

function openForm(request, previewText) {
  pending = request;
  form.hidden = false;
  formError.hidden = true;

  if (request.kind === 'pin') {
    formKind.textContent = '📌 Nowy komentarz – pinezka';
    formQuote.hidden = true;
    formQuote.textContent = '';
  } else {
    formKind.textContent = '💬 Nowy komentarz – zaznaczony tekst';
    formQuote.hidden = !previewText;
    formQuote.textContent = previewText ? '„' + previewText + '”' : '';
  }

  const saved = localStorage.getItem(NAME_KEY) || '';
  if (saved && !authorInput.value) authorInput.value = saved;

  (authorInput.value.trim() ? textInput : authorInput).focus();
}

function closeForm(clearPendingInPreview) {
  pending = null;
  form.hidden = true;
  formError.hidden = true;
  textInput.value = '';
  if (clearPendingInPreview !== false) postToChild({ type: 'clear-pending' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pending) return;

  const author = authorInput.value.trim();
  const text = textInput.value.trim();
  if (!author) { formError.hidden = false; formError.textContent = 'Podaj nazwę.'; authorInput.focus(); return; }
  if (!text) { formError.hidden = false; formError.textContent = 'Wpisz treść komentarza.'; textInput.focus(); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Dodawanie…';

  try {
    const data = await api(`/api/projects/${projectId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author,
        text,
        type: pending.kind,
        page: pending.page || currentPage,
        postId: pending.postId || undefined,
        anchor: pending.anchor,
      }),
    });

    localStorage.setItem(NAME_KEY, author);
    comments.push(data.comment);
    activeId = data.comment.id;
    renderMeta();
    pushCommentsToChild();
    renderList();
    closeForm(true);
    authorInput.value = author;
    if (mode === 'pin') setMode('select'); // nie zostawiaj włączonego trybu pinezki
    toast('Komentarz dodany');

    const el = listEl.querySelector(`[data-id="${data.comment.id}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    formError.hidden = false;
    formError.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Dodaj komentarz';
  }
});

cancelBtn.addEventListener('click', () => closeForm(true));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !form.hidden) closeForm(true);
});

/* ------------------------------ tryb pinezki ------------------------------- */

function setMode(next) {
  mode = next === 'pin' ? 'pin' : 'select';
  const pinning = mode === 'pin';
  pinToggle.classList.toggle('on', pinning);
  pinIco.textContent = pinning ? '✖' : '📌';
  pinLabel.textContent = pinning ? 'Zakończ dodawanie pinezek' : 'Tryb pinezki';
  pinToggle.title = pinning
    ? 'Wyłącz tryb pinezki i wróć do zaznaczania tekstu'
    : 'Kliknij w dowolnym miejscu strony, aby dodać pinezkę';
  pinToggle.setAttribute('aria-label', pinLabel.textContent);
  postToChild({ type: 'set-mode', mode });
}

pinToggle.addEventListener('click', () => setMode(mode === 'pin' ? 'select' : 'pin'));

resolvedFilter.addEventListener('click', () => {
  hideResolved = !hideResolved;
  localStorage.setItem(FILTER_KEY, hideResolved ? '1' : '0');
  pushCommentsToChild();
  renderList();
  toast(hideResolved ? 'Rozwiązane komentarze zostały ukryte' : 'Rozwiązane komentarze są widoczne');
});

copyShare.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link do udostępniania skopiowany');
  } catch {
    toast('Nie udało się skopiować linku', true);
  }
});

/* ------------------------------- komunikacja ------------------------------- */

/** Ścieżka strony z jej adresu – do napisu na przycisku powrotu. */
function labelForUrl(url) {
  try {
    const u = new URL(url, location.href);
    if (!isLive()) {
      const m = /^\/p\/[^/]+\/(.*)$/.exec(u.pathname);
      if (m) return pageLabel(m[1]);
    }
    return pageLabel(u.pathname + u.search);
  } catch {
    return url;
  }
}

function hideLost() {
  lostEl.hidden = true;
}

/**
 * Ramka przestała odpowiadać: wstrzymujemy komentowanie i przykrywamy podgląd.
 * Przy pierwszym wczytaniu najpewniej brakuje skryptu na stronie albo strona
 * nie pozwala wyświetlić się w ramce. Później – podgląd opuścił recenzowaną
 * stronę (przekierowanie, formularz, plik, podstrona bez skryptu).
 */
function showLost() {
  childReady = false;
  loader.hidden = true;
  if (mode === 'pin') setMode('select');
  pinToggle.disabled = true;
  if (pending) closeForm(false);
  if (pendingFocusId) {
    pendingFocusId = null;
    toast('Nie udało się otworzyć strony z tym komentarzem', true);
  }

  if (currentPage) {
    currentPage = '';
    currentPostId = null;
    missingIds = new Set();
    concealedIds = new Set();
    renderMeta();
    renderList();
  }

  if (everConnected && lastGoodUrl) {
    lostTitle.textContent = 'Utracono połączenie z recenzowaną stroną';
    lostDesc.textContent = 'Podgląd przeszedł na stronę, która nie jest objęta recenzją '
      + '(np. inną domenę, plik albo podstronę bez skryptu Design Review). Komentowanie jest wstrzymane.';
    lostBack.textContent = 'Powrót';
    lostBack.title = 'Wróć do: ' + labelForUrl(lastGoodUrl);
    lostBack.dataset.url = lastGoodUrl;
    lostOpen.hidden = true;
  } else {
    const entry = project ? project.entryUrl : '';
    lostTitle.textContent = 'Strona nie odpowiada';
    lostDesc.textContent = isLive()
      ? 'Nie udało się połączyć z recenzowaną stroną. Sprawdź, czy jest na niej dodany skrypt Design Review '
        + '(i czy wtyczki optymalizujące nie łączą go z innymi skryptami ani nie opóźniają). Jeśli skrypt jest '
        + 'na miejscu, strona może blokować wyświetlanie w ramce (nagłówki X-Frame-Options lub CSP) – '
        + 'wtedy potrzebny będzie plugin.'
      : 'Nie udało się wczytać podglądu strony.';
    lostBack.textContent = 'Spróbuj ponownie';
    lostBack.title = entry ? 'Wróć do: ' + labelForUrl(entry) : '';
    lostBack.dataset.url = entry;
    lostOpen.href = entry;
    lostOpen.hidden = !entry;
  }
  lostEl.hidden = false;
}

/** Jeśli w podanym czasie warstwa adnotacji się nie zgłosi – połączenie zerwane. */
function armAliveCheck(ms) {
  clearTimeout(aliveTimer);
  aliveTimer = setTimeout(() => {
    if (!childAlive) showLost();
  }, ms);
}

function markAlive(origin) {
  childOrigin = origin;
  childAlive = true;
}

lostBack.addEventListener('click', () => {
  const url = lostBack.dataset.url;
  if (url) loadInFrame(url);
});

window.addEventListener('message', (e) => {
  // Przyjmujemy wyłącznie wiadomości z naszej ramki i z dozwolonych domen.
  if (e.source !== iframe.contentWindow || !allowedOrigins.includes(e.origin)) return;
  const d = e.data;
  if (!d || d.ns !== NS) return;

  switch (d.type) {
    case 'hello':
      // Nowy dokument w ramce – uruchom w nim warstwę adnotacji.
      markAlive(e.origin);
      postToChild({ type: 'init' });
      break;
    case 'alive':
      markAlive(e.origin);
      break;
    case 'ready': {
      markAlive(e.origin);
      childReady = true;
      everConnected = true;
      hideLost();
      loader.hidden = true;
      pinToggle.disabled = false;
      if (typeof d.url === 'string') lastGoodUrl = d.url;

      const page = typeof d.page === 'string' ? d.page : '';
      const postId = Number.isSafeInteger(d.postId) && d.postId > 0 ? d.postId : null;
      if (page !== currentPage || postId !== currentPostId) {
        currentPage = page;
        currentPostId = postId;
        missingIds = new Set();
        concealedIds = new Set();
        renderMeta();
        renderList();
      }

      pushCommentsToChild();
      postToChild({ type: 'set-mode', mode });

      // Jeśli komentarz z innej strony był powodem wczytania tego pliku,
      // teraz – gdy warstwa adnotacji już działa – pokaż go i przewiń.
      if (pendingFocusId) {
        const id = pendingFocusId;
        pendingFocusId = null;
        const c = comments.find((x) => x.id === id);
        if (c && onCurrentPage(c)) {
          activeId = id;
          renderList();
          postToChild({ type: 'focus', id });
        } else {
          // Komentarz zniknął albo strona przekierowała się na inny adres –
          // bez tego komunikatu kliknięcie kończyło się ciszą.
          toast('Nie znaleziono tego komentarza na wczytanej stronie', true);
        }
      }
      break;
    }
    case 'new-anchor':
      openForm({
        kind: d.kind,
        page: d.page || currentPage,
        postId: Number.isSafeInteger(d.postId) ? d.postId : null,
        anchor: d.anchor,
      }, d.preview || '');
      break;
    case 'blocked-link': {
      let href = '';
      try {
        const u = new URL(d.url);
        if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href;
      } catch { /* nieprawidłowy adres */ }
      toast('Ten link prowadzi poza recenzowaną stronę.', false,
        href ? { label: 'Otwórz w nowej karcie ↗', href } : null);
      break;
    }
    case 'select-comment':
      selectComment(d.id, false);
      break;
    case 'missing':
      missingIds = new Set(d.ids || []);
      concealedIds = new Set(d.concealed || []);
      renderList();
      break;
    default:
      break;
  }
});

/**
 * Po każdym wczytaniu dokumentu w ramce (także po kliknięciu linku) pytamy,
 * czy warstwa adnotacji nadal odpowiada. Zapytanie trafia tylko do dozwolonych
 * domen – obca strona go nie dostanie i nie odpowie.
 */
iframe.addEventListener('load', () => {
  if (!iframe.getAttribute('src')) return;
  childAlive = false;
  for (const origin of allowedOrigins) postToChild({ type: 'probe' }, origin);
  armAliveCheck(CHILD_TIMEOUT);
});

/* --------------------------------- start ---------------------------------- */

/**
 * Osoba wchodząca z linku do recenzji nie ma dostępu do strony głównej,
 * więc w miejscu „Wszystkie strony” pokazujemy zwykłe logowanie.
 */
async function loadSession() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    if (!data.authed) {
      homeLink.href = '/login?next=' + encodeURIComponent(location.pathname);
      homeIco.textContent = '🔑';
      homeLabel.textContent = 'Zaloguj';
      homeLink.title = 'Zaloguj się, aby zarządzać przesłanymi stronami';
      homeLink.setAttribute('aria-label', 'Zaloguj się');
    }
  } catch {
    /* brak informacji o sesji – zostaw domyślny link */
  }
}

async function init() {
  try {
    const data = await api(`/api/projects/${projectId}`);
    project = data.project;
    comments = data.comments || [];
    activeId = null;
    missingIds = new Set();
    concealedIds = new Set();

    nameEl.textContent = project.name;
    nameEl.title = project.name;
    currentPage = project.entry;
    if (isLive()) allowedOrigins = project.origins || [project.origin];
    renderMeta();
    document.title = project.name + ' – Design Review';
    openNew.href = project.entryUrl;
    // Strona na żywo nie ma plików do pobrania.
    downloadZip.href = `/api/projects/${project.id}/archive`;
    downloadZip.hidden = isLive();

    renderList();
    loadInFrame(project.entryUrl);
  } catch (err) {
    loader.hidden = true;
    nameEl.textContent = 'Nie znaleziono projektu';
    metaEl.textContent = err.message;
    toast(err.message, true);
  }
}

init();
loadSession();
