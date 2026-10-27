'use strict';

/* Strona główna: lista przesłanych stron, upload ZIP, usuwanie, linki. */

const $ = (sel) => document.querySelector(sel);

const listEl = $('#list');
const emptyEl = $('#empty');
const countEl = $('#count');
const form = $('#upload-form');
const dropzone = $('#dropzone');
const fileInput = $('#file');
const fileLabel = $('#dz-file');
const nameInput = $('#name');
const uploadBtn = $('#upload-btn');
const progressEl = $('#progress');
const progressBar = $('#progress-bar');
const errorEl = $('#upload-error');
const toastEl = $('#toast');
const accountEl = $('#account');
const uidBtn = $('#uid-btn');
const logoutBtn = $('#logout-btn');
const mailTestBtn = $('#mail-test-btn');
const replaceInput = $('#replace-file');

const liveForm = $('#live-form');
const liveUrl = $('#live-url');
const liveName = $('#live-name');
const liveBtn = $('#live-btn');
const liveError = $('#live-error');
const snippetDialog = $('#snippet-dialog');
const snippetText = $('#snippet-text');
const snippetCopy = $('#snippet-copy');
const snippetClose = $('#snippet-close');
const snippetLead = $('#snippet-lead');

const urlDialog = $('#url-dialog');
const urlForm = $('#url-form');
const urlInput = $('#url-input');
const urlError = $('#url-error');
const urlCancel = $('#url-cancel');
const urlSave = $('#url-save');

const pwDialog = $('#pw-dialog');
const pwForm = $('#pw-form');
const pwInput = $('#pw-input');
const pwShow = $('#pw-show');
const pwError = $('#pw-error');
const pwRemove = $('#pw-remove');
const pwCancel = $('#pw-cancel');
const pwSave = $('#pw-save');
const pwTitle = $('#pw-title');
const pwDesc = $('#pw-desc');

let pwProject = null;
let urlProject = null;

let selectedFile = null;
let replaceTarget = null;
let replaceBtnEl = null;
let toastTimer = null;
let currentUid = '';
let snippet = ''; // skrypt do wklejenia na stronach na żywo (podaje serwer)

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

/** Gdy sesja wygasła – przenieś na ekran logowania i przerwij dalsze kroki. */
function requireLogin() {
  location.href = '/login';
  return new Promise(() => {}); // nawigacja i tak przerwie działanie strony
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data = {};
  try { data = await res.json(); } catch { /* brak JSON */ }
  if (res.status === 401) return requireLogin();
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

function shareUrl(project) {
  return location.origin + project.viewPath;
}

function formatBytes(bytes) {
  if (!bytes) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Zapasowe kopiowanie przez zaznaczenie ukrytego pola. Pole trafia do
 * otwartego okna dialogowego, bo reszta strony jest wtedy nieaktywna.
 */
function copyWithSelection(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  (document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy');
}

async function copyText(text, okMessage) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      // Clipboard API bywa zablokowane (np. w osadzonej przeglądarce).
      await navigator.clipboard.writeText(text).catch(() => copyWithSelection(text));
    } else {
      copyWithSelection(text);
    }
    toast(okMessage || 'Skopiowano do schowka');
  } catch {
    toast('Nie udało się skopiować. Skopiuj ręcznie: ' + text, true);
  }
}

/* ---------------------------------- lista --------------------------------- */

function renderProjects(projects) {
  listEl.textContent = '';
  countEl.textContent = projects.length
    ? `${projects.length} ${projects.length === 1 ? 'projekt' : 'projektów'}`
    : '';

  if (!projects.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const project of projects) {
    const item = document.createElement('div');
    item.className = 'project-item';

    const live = project.kind === 'url';

    const thumb = document.createElement('div');
    thumb.className = 'pi-thumb' + (live ? ' live' : '');
    thumb.textContent = live ? '🌐' : (project.name || '?').trim().charAt(0).toUpperCase() || '?';
    if (live) thumb.title = 'Strona na żywo';

    const main = document.createElement('div');
    main.className = 'pi-main';

    const name = document.createElement('div');
    name.className = 'pi-name';
    name.textContent = project.name;
    name.title = project.name;
    if (project.locked) {
      const lock = document.createElement('span');
      lock.className = 'pi-lock';
      lock.textContent = '🔒';
      lock.title = 'Strona zabezpieczona hasłem';
      name.append(' ', lock);
    }

    const meta = document.createElement('div');
    meta.className = 'pi-meta';
    const dateText = project.updatedAt
      ? `Podmieniono ${formatDate(project.updatedAt)}`
      : formatDate(project.createdAt);
    if (live) {
      const date = document.createElement('span');
      date.textContent = project.updatedAt
        ? `Zmieniono adres ${formatDate(project.updatedAt)}`
        : formatDate(project.createdAt);
      if (project.updatedAt) date.title = `Dodano: ${formatDate(project.createdAt)}`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '·';
      const site = document.createElement('code');
      site.textContent = project.url;
      meta.append(date, dot, site);
    } else {
      // Elementy budujemy w DOM (nie innerHTML) – nazwa pliku startowego
      // pochodzi z archiwum ZIP i nie może trafić na stronę jako HTML.
      const addMeta = (text, tag) => {
        const el = document.createElement(tag || 'span');
        el.textContent = text;
        meta.appendChild(el);
      };
      const addDot = () => {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '·';
        meta.appendChild(dot);
      };

      const date = document.createElement('span');
      date.textContent = dateText;
      if (project.updatedAt) date.title = `Wgrano: ${formatDate(project.createdAt)}`;
      meta.appendChild(date);
      addDot();
      addMeta(formatBytes(project.size));
      addDot();
      addMeta(`${project.files} plik(ów)`);
      addDot();
      addMeta(project.entry, 'code');
    }

    const linkRow = document.createElement('div');
    linkRow.className = 'pi-link';
    const linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.readOnly = true;
    linkInput.value = shareUrl(project);
    linkInput.title = 'Link do udostępniania';
    linkInput.addEventListener('focus', () => linkInput.select());
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Kopiuj link';
    copyBtn.addEventListener('click', () => copyText(linkInput.value));
    linkRow.append(linkInput, copyBtn);

    main.append(name, meta, linkRow);

    const actions = document.createElement('div');
    actions.className = 'pi-actions';

    const openBtn = document.createElement('a');
    openBtn.className = 'btn icon primary';
    openBtn.href = project.viewPath;
    openBtn.textContent = '👁';
    openBtn.title = 'Otwórz widok recenzji';
    openBtn.setAttribute('aria-label', 'Otwórz widok recenzji');

    const openTab = document.createElement('a');
    openTab.className = 'btn icon';
    openTab.href = project.entryUrl;
    openTab.target = '_blank';
    openTab.rel = 'noopener';
    openTab.textContent = '↗';
    openTab.title = live ? 'Otwórz stronę w nowej karcie' : 'Podgląd samej strony w nowej karcie';
    openTab.setAttribute('aria-label', openTab.title);

    const scriptBtn = document.createElement('button');
    scriptBtn.className = 'btn icon';
    scriptBtn.type = 'button';
    scriptBtn.textContent = '📋';
    scriptBtn.title = 'Kopiuj skrypt do wklejenia na stronie (jednorazowo)';
    scriptBtn.setAttribute('aria-label', scriptBtn.title);
    scriptBtn.addEventListener('click', () => copyScript());

    const urlBtn = document.createElement('button');
    urlBtn.className = 'btn icon';
    urlBtn.type = 'button';
    urlBtn.textContent = '🔄';
    urlBtn.title = 'Zmień adres strony (link do recenzji i komentarze bez zmian)';
    urlBtn.setAttribute('aria-label', urlBtn.title);
    urlBtn.addEventListener('click', () => openUrlDialog(project));

    const zipBtn = document.createElement('a');
    zipBtn.className = 'btn icon';
    zipBtn.href = `/api/projects/${project.id}/archive`;
    zipBtn.textContent = '⬇';
    zipBtn.title = 'Pobierz projekt jako ZIP (bez komentarzy)';
    zipBtn.setAttribute('aria-label', 'Pobierz projekt jako ZIP (bez komentarzy)');

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'btn icon';
    replaceBtn.type = 'button';
    replaceBtn.textContent = '🔄';
    replaceBtn.title = 'Podmień pliki – wgraj nowszą wersję ZIP (link i komentarze bez zmian)';
    replaceBtn.setAttribute('aria-label', replaceBtn.title);
    replaceBtn.addEventListener('click', () => {
      replaceTarget = project;
      replaceBtnEl = replaceBtn;
      replaceInput.value = '';
      replaceInput.click();
    });

    const pwBtn = document.createElement('button');
    pwBtn.className = 'btn icon' + (project.locked ? ' toggled' : '');
    pwBtn.type = 'button';
    pwBtn.textContent = project.locked ? '🔒' : '🔓';
    pwBtn.title = project.locked
      ? 'Hasło ustawione – kliknij, aby zmienić lub usunąć'
      : 'Ustaw hasło dostępu do strony';
    pwBtn.setAttribute('aria-label', pwBtn.title);
    pwBtn.addEventListener('click', () => openPasswordDialog(project));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn icon danger';
    delBtn.type = 'button';
    delBtn.textContent = '🗑';
    delBtn.title = 'Usuń stronę';
    delBtn.setAttribute('aria-label', 'Usuń stronę');
    delBtn.addEventListener('click', async () => {
      const ok = await drConfirm({
        title: 'Usunąć stronę?',
        message: `Strona „${project.name}” zostanie usunięta razem ze wszystkimi komentarzami. Tej operacji nie można cofnąć.`,
        confirmText: 'Usuń stronę',
        danger: true,
      });
      if (!ok) return;
      delBtn.disabled = true;
      try {
        await api(`/api/projects/${project.id}`, { method: 'DELETE' });
        toast('Projekt został usunięty');
        await loadProjects();
      } catch (err) {
        delBtn.disabled = false;
        toast(err.message, true);
      }
    });

    if (live) actions.append(openBtn, openTab, urlBtn, scriptBtn, pwBtn, delBtn);
    else actions.append(openBtn, openTab, replaceBtn, zipBtn, pwBtn, delBtn);
    item.append(thumb, main, actions);
    listEl.appendChild(item);
  }
}

async function loadProjects() {
  try {
    const data = await api('/api/projects');
    if (data.snippet) snippet = data.snippet;
    renderProjects(data.projects || []);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------ hasło do strony --------------------------- */

function openPasswordDialog(project) {
  pwProject = project;
  pwTitle.textContent = project.locked ? 'Zmień hasło dostępu' : 'Ustaw hasło dostępu';
  pwDesc.textContent = project.locked
    ? 'Strona jest zabezpieczona hasłem. Wpisz nowe hasło, aby je zmienić, albo usuń ochronę.'
    : 'Osoby z linkiem będą musiały podać to hasło. Ty, jako zalogowany administrator, wchodzisz bez niego.';
  pwInput.value = '';
  pwInput.type = 'password';
  pwShow.textContent = 'Pokaż';
  pwShow.setAttribute('aria-pressed', 'false');
  pwError.hidden = true;
  pwRemove.hidden = !project.locked;
  pwSave.disabled = false;
  pwDialog.showModal();
  setTimeout(() => pwInput.focus(), 30);
}

async function savePassword(password) {
  const data = await api(`/api/projects/${pwProject.id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return data;
}

pwCancel.addEventListener('click', () => pwDialog.close());

pwShow.addEventListener('click', () => {
  const show = pwInput.type === 'password';
  pwInput.type = show ? 'text' : 'password';
  pwShow.textContent = show ? 'Ukryj' : 'Pokaż';
  pwShow.setAttribute('aria-pressed', String(show));
  pwInput.focus();
});

pwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pwProject) return;
  const password = pwInput.value.trim();
  if (password.length < 4) {
    pwError.hidden = false;
    pwError.textContent = 'Hasło musi mieć co najmniej 4 znaki.';
    pwInput.focus();
    return;
  }

  pwSave.disabled = true;
  pwError.hidden = true;
  try {
    await savePassword(password);
    pwDialog.close();
    toast(pwProject.locked ? 'Hasło zostało zmienione' : 'Hasło zostało ustawione');
    await loadProjects();
  } catch (err) {
    pwError.hidden = false;
    pwError.textContent = err.message;
    pwSave.disabled = false;
  }
});

pwRemove.addEventListener('click', async () => {
  if (!pwProject) return;
  const ok = await drConfirm({
    title: 'Usunąć hasło?',
    message: 'Każdy, kto ma link do strony, będzie mógł ją zobaczyć i komentować bez hasła.',
    confirmText: 'Usuń hasło',
    danger: true,
  });
  if (!ok) return;
  pwRemove.disabled = true;
  pwError.hidden = true;
  try {
    await savePassword('');
    pwDialog.close();
    toast('Ochrona hasłem została usunięta');
    await loadProjects();
  } catch (err) {
    pwError.hidden = false;
    pwError.textContent = err.message;
  } finally {
    pwRemove.disabled = false;
  }
});

/* ---------------------------- strony na żywo ------------------------------ */

function copyScript() {
  if (!snippet) return;
  copyText(snippet, 'Skrypt skopiowany – wklej go na stronie WordPress');
}

/** Okno ze skryptem – po dodaniu strony albo zmianie jej domeny. */
function showSnippetDialog(reason, url) {
  const site = document.createElement('b');
  site.textContent = url;
  snippetLead.textContent = '';
  if (reason === 'moved') snippetLead.append('Strona ma teraz nowy adres: ', site, '. Sprawdź, czy jest na niej skrypt.');
  else snippetLead.append('Strona ', site, ' została dodana.');
  snippetText.value = snippet;
  snippetDialog.showModal();
}

liveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  liveError.hidden = true;
  liveBtn.disabled = true;
  try {
    const data = await api('/api/projects/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: liveUrl.value.trim(), name: liveName.value.trim() }),
    });
    if (data.snippet) snippet = data.snippet;
    liveUrl.value = '';
    liveName.value = '';
    await loadProjects();
    showSnippetDialog('added', data.project.url);
  } catch (err) {
    liveError.hidden = false;
    liveError.textContent = err.message;
  } finally {
    liveBtn.disabled = false;
  }
});

snippetText.addEventListener('focus', () => snippetText.select());
snippetCopy.addEventListener('click', copyScript);
snippetClose.addEventListener('click', () => snippetDialog.close());

/* ------------------------- zmiana adresu strony --------------------------- */

function openUrlDialog(project) {
  urlProject = project;
  urlInput.value = project.url || '';
  urlError.hidden = true;
  urlSave.disabled = false;
  urlDialog.showModal();
  setTimeout(() => urlInput.select(), 30);
}

urlCancel.addEventListener('click', () => urlDialog.close());

urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!urlProject) return;
  const value = urlInput.value.trim();
  if (!value) {
    urlError.hidden = false;
    urlError.textContent = 'Podaj adres strony.';
    urlInput.focus();
    return;
  }
  urlSave.disabled = true;
  urlError.hidden = true;
  try {
    const data = await api(`/api/projects/${urlProject.id}/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: value }),
    });
    if (data.snippet) snippet = data.snippet;
    urlDialog.close();
    await loadProjects();
    toast('Adres zmieniony – link do recenzji i komentarze bez zmian');
    // Nowa domena musi mieć wklejony skrypt – przypominamy i dajemy go od razu.
    if (data.originChanged) showSnippetDialog('moved', data.project.url);
  } catch (err) {
    urlError.hidden = false;
    urlError.textContent = err.message;
    urlSave.disabled = false;
  }
});

/* -------------------------------- konto ----------------------------------- */

async function loadSession() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    if (!data.authed) return requireLogin();
    currentUid = data.uid || '';
    accountEl.hidden = false;
    loadNotifications();
  } catch {
    /* brak informacji o sesji – pasek konta zostaje ukryty */
  }
}

/** Przycisk testowego maila pokazujemy tylko, gdy powiadomienia są skonfigurowane. */
async function loadNotifications() {
  try {
    const data = await api('/api/notifications');
    if (!data.enabled) return;
    mailTestBtn.hidden = false;
    mailTestBtn.title = `Powiadomienia o komentarzach trafiają na ${data.to} – wyślij testową wiadomość`;
  } catch {
    /* bez informacji o powiadomieniach przycisk zostaje ukryty */
  }
}

mailTestBtn.addEventListener('click', async () => {
  mailTestBtn.disabled = true;
  try {
    const data = await api('/api/notifications/test', { method: 'POST' });
    toast(`Testowy mail wysłany na ${data.to}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    mailTestBtn.disabled = false;
  }
});

uidBtn.addEventListener('click', () => {
  if (!currentUid) return;
  copyText(currentUid, 'Uid skopiowany – zachowaj go, aby się zalogować');
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    /* i tak wracamy na ekran logowania */
  }
  location.href = '/login';
});

/* --------------------------------- upload --------------------------------- */

function setFile(file) {
  if (file && !/\.zip$/i.test(file.name)) {
    selectedFile = null;
    fileInput.value = '';
    fileLabel.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = 'Wybierz plik z rozszerzeniem .zip';
    return;
  }
  selectedFile = file || null;
  errorEl.hidden = true;
  if (selectedFile) {
    fileLabel.hidden = false;
    fileLabel.textContent = `${selectedFile.name} · ${formatBytes(selectedFile.size)}`;
    if (!nameInput.value.trim()) {
      nameInput.value = selectedFile.name.replace(/\.zip$/i, '').slice(0, 120);
    }
  } else {
    fileLabel.hidden = true;
  }
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setFile(file);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!selectedFile) {
    errorEl.hidden = false;
    errorEl.textContent = 'Najpierw wybierz plik .zip ze stroną.';
    dropzone.focus();
    return;
  }

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('name', nameInput.value.trim());

  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Wgrywanie…';
  errorEl.hidden = true;
  progressEl.hidden = false;
  progressBar.style.width = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/projects');

  xhr.upload.addEventListener('progress', (ev) => {
    if (ev.lengthComputable) {
      progressBar.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
    }
  });

  xhr.addEventListener('load', async () => {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Wgraj i udostępnij';
    progressEl.hidden = true;

    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }

    if (xhr.status === 401) {
      location.href = '/login';
      return;
    }

    if (xhr.status >= 200 && xhr.status < 300 && data.project) {
      setFile(null);
      nameInput.value = '';
      fileInput.value = '';
      await loadProjects();
      toast('Strona została wgrana i udostępniona');
      copyText(shareUrl(data.project), 'Link do udostępniania skopiowany do schowka');
    } else {
      errorEl.hidden = false;
      errorEl.textContent = data.error || `Nie udało się wgrać pliku (błąd ${xhr.status}).`;
    }
  });

  xhr.addEventListener('error', () => {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Wgraj i udostępnij';
    progressEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = 'Błąd połączenia podczas wysyłania pliku.';
  });

  xhr.send(formData);
});

/* ----------------------------- podmiana plików ---------------------------- */

replaceInput.addEventListener('change', async () => {
  const file = replaceInput.files && replaceInput.files[0];
  const project = replaceTarget;
  const btn = replaceBtnEl;
  replaceTarget = null;
  replaceBtnEl = null;
  replaceInput.value = '';
  if (!file || !project) return;

  if (!/\.zip$/i.test(file.name)) {
    toast('Wybierz plik z rozszerzeniem .zip', true);
    return;
  }

  const ok = await drConfirm({
    title: 'Podmienić pliki strony?',
    message: `Nowa wersja zastąpi obecne pliki projektu „${project.name}”. `
      + 'Link do recenzji, hasło i komentarze pozostaną bez zmian.',
    confirmText: 'Podmień pliki',
  });
  if (!ok) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳';
  }

  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/projects/${project.id}/replace`);

  let nextToastAt = 0;
  xhr.upload.addEventListener('progress', (ev) => {
    if (!ev.lengthComputable) return;
    const pct = Math.round((ev.loaded / ev.total) * 100);
    if (pct >= nextToastAt) {
      nextToastAt = pct + 10;
      toast(`Wgrywanie nowej wersji… ${pct}%`);
    }
  });

  xhr.addEventListener('load', async () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄';
    }
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status === 401) { location.href = '/login'; return; }

    if (xhr.status >= 200 && xhr.status < 300 && data.project) {
      await loadProjects();
      toast('Pliki podmienione – link i komentarze pozostały bez zmian');
    } else {
      toast(data.error || `Nie udało się podmienić plików (błąd ${xhr.status}).`, true);
    }
  });

  xhr.addEventListener('error', () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄';
    }
    toast('Błąd połączenia podczas wysyłania pliku.', true);
  });

  xhr.send(formData);
});

loadProjects();
loadSession();
