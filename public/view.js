'use strict';

/* Widok recenzji: iframe z designem + panel komentarzy. */

const $ = (sel) => document.querySelector(sel);
const NS = 'design-review';
const NAME_KEY = 'design-review:name';
const EMAIL_KEY = 'design-review:email';
const UNSUBSCRIBE_KEY = 'design-review:unsubscribe:'; // + id projektu → token wypisania
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
const emailInput = $('#email');
const emailField = $('.email-field');
const unsubscribeBtn = $('#unsubscribe');
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
let replyOpenId = null;   // komentarz, na który właśnie odpowiadamy
let emailNotifications = false; // czy serwer wysyła powiadomienia uczestnikom (pole e-mail)
let replyDraft = { author: '', email: '', text: '' }; // formularz odpowiedzi (przetrwa przebudowę listy)
let replyFocusPending = false; // ustaw fokus w formularzu odpowiedzi po jego otwarciu

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

/**
 * Kopiowanie do schowka. Clipboard API bywa zablokowane (np. w osadzonej
 * przeglądarce) – wtedy zaznaczamy tekst w ukrytym polu.
 */
async function copyText(text, okMessage) {
  const viaSelection = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy');
  };
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text).catch(viaSelection);
    } else {
      viaSelection();
    }
    toast(okMessage || 'Skopiowano do schowka');
  } catch {
    toast('Nie udało się skopiować', true);
  }
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
    location.href = data.unlock + '?next=' + encodeURIComponent(location.pathname + location.search);
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
  // Lista bywa przebudowywana w trakcie pisania odpowiedzi (np. gdy podgląd
  // zgłosi zmianę) – zapamiętujemy, które pole formularza miało fokus.
  const focused = document.activeElement;
  const focusField = focused && listEl.contains(focused) && focused.dataset ? focused.dataset.replyField : null;
  const caret = focusField && typeof focused.selectionStart === 'number' ? focused.selectionStart : null;

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

    // Znacznik stanu: kropka (otwarty) albo ✓ (rozwiązany) – bez numeru,
    // który przy setkach komentarzy rozpychałby nagłówek.
    const num = document.createElement('span');
    num.className = 'num';
    num.setAttribute('aria-hidden', 'true');

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

    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    if (replies.length) li.appendChild(renderReplies(comment, replies));

    const foot = document.createElement('div');
    foot.className = 'comment-foot';

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.textContent = 'Odpowiedz';
    replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReply(comment.id);
    });

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

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy';
    copyBtn.textContent = '⧉';
    copyBtn.title = 'Kopiuj treść komentarza';
    copyBtn.setAttribute('aria-label', copyBtn.title);
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(comment.text, 'Treść komentarza skopiowana');
    });

    foot.append(replyBtn, resolveBtn, delBtn, copyBtn);
    li.appendChild(foot);

    if (replyOpenId === comment.id) li.appendChild(renderReplyForm(comment, focusField, caret));

    li.addEventListener('click', () => {
      // Kliknięcie kończące zaznaczanie tekstu komentarza nie wybiera wpisu –
      // inaczej przebudowa listy skasowałaby zaznaczenie.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && li.contains(sel.anchorNode)) return;
      selectComment(comment.id, true);
    });

    listEl.appendChild(li);
  });
}

/* -------------------------------- odpowiedzi ------------------------------- */

function renderReplies(comment, replies) {
  const list = document.createElement('ul');
  list.className = 'replies';
  for (const reply of replies) {
    const item = document.createElement('li');
    item.className = 'reply';

    const head = document.createElement('div');
    head.className = 'reply-head';
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = reply.author;
    const time = document.createElement('time');
    time.className = 'time';
    time.textContent = relTime(reply.createdAt);
    time.title = new Date(reply.createdAt).toLocaleString('pl-PL');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'reply-del';
    del.textContent = 'Usuń';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await drConfirm({
        title: 'Usunąć odpowiedź?',
        message: 'Tej operacji nie można cofnąć.',
        confirmText: 'Usuń odpowiedź',
        danger: true,
      });
      if (!ok) return;
      try {
        const data = await api(`/api/projects/${projectId}/comments/${comment.id}/replies/${reply.id}`, { method: 'DELETE' });
        replaceComment(data.comment);
        renderList();
      } catch (err) {
        toast(err.message, true);
      }
    });
    head.append(author, time, del);

    const body = document.createElement('div');
    body.className = 'reply-body';
    body.textContent = reply.text;

    item.append(head, body);
    list.appendChild(item);
  }
  return list;
}

function replaceComment(updated) {
  const idx = comments.findIndex((c) => c.id === updated.id);
  if (idx !== -1) comments[idx] = updated;
}

/* ------------------------ powiadomienia uczestników ------------------------ */

function savedEmail() {
  return localStorage.getItem(EMAIL_KEY) || '';
}

/** Przycisk „Wypisz się” – widoczny, gdy ta przeglądarka zapisała się do powiadomień. */
function updateUnsubscribe() {
  unsubscribeBtn.hidden = !(emailNotifications && localStorage.getItem(UNSUBSCRIBE_KEY + projectId));
}

/**
 * Po dodaniu komentarza lub odpowiedzi: zapamiętaj imię i e-mail, token do
 * wypisania się i powiedz piszącemu, kogo wzmianki powiadomiły, a kogo nie.
 */
function afterPost(data, author, email, message) {
  localStorage.setItem(NAME_KEY, author);
  if (emailNotifications) {
    if (email) localStorage.setItem(EMAIL_KEY, email);
    else localStorage.removeItem(EMAIL_KEY);
  }
  if (data.subscription && data.subscription.token) {
    localStorage.setItem(UNSUBSCRIBE_KEY + projectId, data.subscription.token);
    updateUnsubscribe();
  }
  const m = data.mentions || {};
  const parts = [message];
  if (m.notified && m.notified.length) parts.push(`Powiadomiono: ${m.notified.join(', ')}`);
  if (m.skipped && m.skipped.length) parts.push(`Nie powiadomiono: ${m.skipped.join(', ')} – adres spoza dozwolonych domen`);
  toast(parts.join('. ') + (parts.length > 1 ? '.' : ''), Boolean(m.skipped && m.skipped.length));
}

unsubscribeBtn.addEventListener('click', async () => {
  const token = localStorage.getItem(UNSUBSCRIBE_KEY + projectId);
  if (!token) return updateUnsubscribe();
  const ok = await drConfirm({
    title: 'Wypisać się z powiadomień?',
    message: 'Nie będziesz dostawać maili o odpowiedziach i wzmiankach z tego projektu. '
      + 'Podanie adresu przy kolejnym komentarzu zapisze Cię ponownie.',
    confirmText: 'Wypisz się',
  });
  if (!ok) return;
  try {
    const res = await fetch('/unsubscribe/' + encodeURIComponent(token), {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Błąd ${res.status}`);
    localStorage.removeItem(UNSUBSCRIBE_KEY + projectId);
    updateUnsubscribe();
    toast('Wypisano z powiadomień tego projektu');
  } catch {
    toast('Nie udało się wypisać – spróbuj ponownie', true);
  }
});

function openReply(id) {
  if (replyOpenId !== id) replyDraft = { author: '', email: '', text: '' };
  replyOpenId = id;
  replyFocusPending = true;
  renderList();
}

function closeReply() {
  replyOpenId = null;
  replyDraft = { author: '', email: '', text: '' };
  renderList();
}

/** Formularz odpowiedzi pod komentarzem. Imię zapamiętane w przeglądarce. */
function renderReplyForm(comment, focusField, caret) {
  const form = document.createElement('form');
  form.className = 'reply-form';
  form.autocomplete = 'off';
  // Kliknięcia w formularzu nie wybierają komentarza.
  form.addEventListener('click', (e) => e.stopPropagation());

  const savedName = localStorage.getItem(NAME_KEY) || '';
  const name = document.createElement('input');
  name.type = 'text';
  name.maxLength = 60;
  name.placeholder = 'Twoje imię';
  name.dataset.replyField = 'author';
  name.value = replyDraft.author || savedName;
  name.addEventListener('input', () => { replyDraft.author = name.value; });

  const email = document.createElement('input');
  email.type = 'email';
  email.maxLength = 200;
  email.placeholder = 'E-mail (opcjonalnie)';
  email.title = 'Podaj, jeśli chcesz dostawać powiadomienia o odpowiedziach w tym wątku';
  email.dataset.replyField = 'email';
  email.value = replyDraft.email || savedEmail();
  email.hidden = !emailNotifications;
  email.addEventListener('input', () => { replyDraft.email = email.value; });

  const row = document.createElement('div');
  row.className = 'field-row';
  row.append(name, email);

  const text = document.createElement('textarea');
  text.rows = 2;
  text.maxLength = 4000;
  text.placeholder = 'Napisz odpowiedź…';
  text.dataset.replyField = 'text';
  text.value = replyDraft.text;
  text.addEventListener('input', () => { replyDraft.text = text.value; });

  const error = document.createElement('p');
  error.className = 'error';
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost small';
  cancel.textContent = 'Anuluj';
  cancel.addEventListener('click', closeReply);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn primary small';
  submit.textContent = 'Odpowiedz';
  actions.append(cancel, submit);

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeReply(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const author = name.value.trim();
    const body = text.value.trim();
    const mail = emailNotifications ? email.value.trim() : '';
    if (!author) { error.hidden = false; error.textContent = 'Podaj nazwę.'; name.focus(); return; }
    if (!body) { error.hidden = false; error.textContent = 'Wpisz treść odpowiedzi.'; text.focus(); return; }
    submit.disabled = true;
    try {
      const data = await api(`/api/projects/${projectId}/comments/${comment.id}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, email: mail || undefined, text: body }),
      });
      replaceComment(data.comment);
      replyOpenId = null;
      replyDraft = { author: '', email: '', text: '' };
      renderList();
      afterPost(data, author, mail, 'Odpowiedź dodana');
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  form.append(row, text, error, actions);

  // Fokus tylko po otwarciu formularza albo gdy miał go przed przebudową
  // listy – inaczej przebudowa zabierałaby go z innych pól.
  if (focusField || replyFocusPending) {
    const target = focusField === 'author' || (!focusField && !name.value) ? name
      : focusField === 'email' ? email : text;
    replyFocusPending = false;
    setTimeout(() => {
      target.focus();
      if (caret != null && typeof target.setSelectionRange === 'function') target.setSelectionRange(caret, caret);
    }, 0);
  }
  return form;
}

function selectComment(id, scrollPage) {
  const comment = comments.find((c) => c.id === id);
  if (!comment) return;

  activeId = id;
  // Tylko przełączamy wyróżnienie – przebudowa listy przerywałaby podwójne
  // kliknięcie (zaznaczenie słowa) w treści komentarza.
  for (const el of listEl.children) el.classList.toggle('active', el.dataset.id === id);

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
  if (emailNotifications && !emailInput.value) emailInput.value = savedEmail();

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
  const email = emailNotifications ? emailInput.value.trim() : '';
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
        email: email || undefined,
        text,
        type: pending.kind,
        page: pending.page || currentPage,
        postId: pending.postId || undefined,
        anchor: pending.anchor,
      }),
    });

    comments.push(data.comment);
    activeId = data.comment.id;
    renderMeta();
    pushCommentsToChild();
    renderList();
    closeForm(true);
    authorInput.value = author;
    if (mode === 'pin') setMode('select'); // nie zostawiaj włączonego trybu pinezki
    afterPost(data, author, email, 'Komentarz dodany');

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

copyShare.addEventListener('click', () => copyText(location.href, 'Link do udostępniania skopiowany'));

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
      homeLink.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
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
    emailNotifications = Boolean(data.emailNotifications);
    emailField.hidden = !emailNotifications;
    updateUnsubscribe();
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

    // Link z powiadomienia (?c=<id>) otwiera podstronę komentarza i go wyróżnia.
    const linkedId = new URLSearchParams(location.search).get('c');
    const linked = linkedId ? comments.find((c) => c.id === linkedId) : null;
    if (linked) activeId = linked.id;
    renderList();
    if (linked) {
      const el = listEl.querySelector(`[data-id="${CSS.escape(linked.id)}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
      loadInFrame(pageUrl(linked.page || project.entry), linked.id);
    } else {
      if (linkedId) toast('Nie znaleziono komentarza z linku – mógł zostać usunięty', true);
      loadInFrame(project.entryUrl);
    }
  } catch (err) {
    loader.hidden = true;
    nameEl.textContent = 'Nie znaleziono projektu';
    metaEl.textContent = err.message;
    toast(err.message, true);
  }
}

init();
loadSession();
