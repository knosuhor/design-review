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

let project = null;
let comments = [];
let pending = null;       // aktualnie tworzony komentarz: {kind, anchor, preview}
let mode = 'select';
let activeId = null;
let childReady = false;
let missingIds = new Set();
let hideResolved = localStorage.getItem(FILTER_KEY) === '1';
let toastTimer = null;

/* ------------------------------- pomocnicze ------------------------------- */

function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.classList.toggle('err', !!isError);
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => { toastEl.hidden = true; }, 220);
  }, 2600);
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

function postToChild(message) {
  if (!iframe.contentWindow) return;
  try {
    iframe.contentWindow.postMessage(Object.assign({ ns: NS }, message), location.origin);
  } catch { /* nic */ }
}

/** Identyfikatory komentarzy, które mają być niewidoczne w podglądzie. */
function hiddenCommentIds() {
  return hideResolved ? comments.filter((c) => c.resolved).map((c) => c.id) : [];
}

function pushCommentsToChild() {
  postToChild({ type: 'set-comments', comments });
  postToChild({ type: 'set-hidden', ids: hiddenCommentIds() });
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

  comments.forEach((comment, index) => {
    if (hideResolved && comment.resolved) return;
    const li = document.createElement('li');
    li.className = 'comment'
      + (comment.id === activeId ? ' active' : '')
      + (comment.resolved ? ' resolved' : '');
    li.dataset.id = comment.id;

    const head = document.createElement('div');
    head.className = 'comment-head';

    const num = document.createElement('span');
    num.className = 'num';
    const numText = document.createElement('span');
    numText.textContent = String(index + 1);
    num.appendChild(numText);

    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = comment.author;

    const time = document.createElement('time');
    time.className = 'time';
    time.textContent = relTime(comment.createdAt);
    time.title = new Date(comment.createdAt).toLocaleString('pl-PL');

    head.append(num, author, time);

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
  activeId = id;
  renderList();
  postToChild(scrollPage ? { type: 'focus', id } : { type: 'select', id });
  const el = listEl.querySelector(`[data-id="${id}"]`);
  if (el && scrollPage) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      body: JSON.stringify({ author, text, type: pending.kind, anchor: pending.anchor }),
    });

    localStorage.setItem(NAME_KEY, author);
    comments.push(data.comment);
    activeId = data.comment.id;
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

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.ns !== NS) return;

  switch (d.type) {
    case 'ready':
      childReady = true;
      loader.hidden = true;
      pinToggle.disabled = false;
      pushCommentsToChild();
      postToChild({ type: 'set-mode', mode });
      break;
    case 'new-anchor':
      openForm({ kind: d.kind, anchor: d.anchor }, d.preview || '');
      break;
    case 'select-comment':
      selectComment(d.id, false);
      break;
    case 'missing':
      missingIds = new Set(d.ids || []);
      renderList();
      break;
    default:
      break;
  }
});

iframe.addEventListener('load', () => {
  // Po nawigacji wewnątrz podglądu warstwa adnotacji wstrzykuje się od nowa.
  childReady = false;
  const src = iframe.contentWindow && iframe.contentWindow.location.href;
  if (src && src !== 'about:blank') loader.hidden = false;
  setTimeout(() => {
    if (!childReady) {
      loader.hidden = true;
      pinToggle.disabled = false;
    }
  }, 2500);
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

    nameEl.textContent = project.name;
    nameEl.title = project.name;
    metaEl.textContent = `${comments.length} komentarz(y) · ${project.files} plik(ów) · ${formatBytes(project.size)}`;
    document.title = project.name + ' – Design Review';
    openNew.href = project.entryUrl;
    downloadZip.href = `/api/projects/${project.id}/archive`;
    downloadZip.hidden = false;

    renderList();
    iframe.src = project.entryUrl;
  } catch (err) {
    loader.hidden = true;
    nameEl.textContent = 'Nie znaleziono projektu';
    metaEl.textContent = err.message;
    toast(err.message, true);
  }
}

init();
loadSession();
