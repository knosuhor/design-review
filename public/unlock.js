'use strict';

/* Ekran wpisywania hasła do udostępnionej (zabezpieczonej) strony. */

const $ = (sel) => document.querySelector(sel);

const nameEl = $('#project-name');
const form = $('#unlock-form');
const input = $('#password');
const errorEl = $('#unlock-error');
const submitBtn = $('#unlock-btn');
const showBtn = $('#show-password');
const loginLink = $('#login-link');

const projectId = location.pathname.split('/').filter(Boolean)[1] || '';
const apiPath = `/api/projects/${encodeURIComponent(projectId)}`;

/** Powrót wyłącznie na ścieżki wewnętrzne. */
function targetUrl() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return next.startsWith('/') && !next.startsWith('//') ? next : `/v/${projectId}`;
}

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

// Właściciel może zalogować się uid-em zamiast wpisywać hasło – po zalogowaniu
// wraca prosto do tej strony.
loginLink.href = '/login?next=' + encodeURIComponent(targetUrl());

(async () => {
  try {
    const res = await drFetch(apiPath + '/access');
    if (!res.ok) throw new Error(res.status === 404 ? 'Nie znaleziono projektu.' : 'Nie udało się wczytać projektu.');
    const data = await res.json();
    nameEl.textContent = data.name;
    document.title = data.name + ' – strona zabezpieczona';
    // Strona bez hasła albo już odblokowana – od razu przechodzimy dalej.
    if (!data.locked || data.unlocked) location.replace(targetUrl());
  } catch (err) {
    form.hidden = true;
    showError(err.message);
  }
})();

showBtn.addEventListener('click', () => {
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  showBtn.textContent = show ? 'Ukryj' : 'Pokaż';
  showBtn.setAttribute('aria-pressed', String(show));
  input.focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = input.value;
  if (!password) {
    showError('Podaj hasło.');
    input.focus();
    return;
  }

  submitBtn.disabled = true;
  errorEl.hidden = true;
  try {
    const res = await drFetch(apiPath + '/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, next: targetUrl() }),
    });
    let data = {};
    try { data = await res.json(); } catch { /* brak JSON */ }
    if (!res.ok) throw new Error(data.error || 'Nie udało się odblokować strony.');
    location.replace(data.next || targetUrl());
  } catch (err) {
    submitBtn.disabled = false;
    showError(err.message);
    input.select();
  }
});
