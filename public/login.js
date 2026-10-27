'use strict';

/* Ekran logowania: jedno pole – uid. */

const $ = (sel) => document.querySelector(sel);

const form = $('#login-form');
const uidInput = $('#uid');
const errorEl = $('#login-error');
const submitBtn = $('#login-btn');
const showBtn = $('#show-uid');
const backLink = $('#back-link');

/** Adres powrotu po zalogowaniu – wyłącznie ścieżki wewnętrzne. */
function nextUrl() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function isViewPath(path) {
  return /^\/v\/[^/?#]+/.test(path);
}

/**
 * Jeśli na logowanie trafił recenzent (przycisk „Zaloguj” w widoku recenzji),
 * pokazujemy strzałkę powrotu do tej strony. Przy wejściu prosto na stronę
 * główną powrót nie ma sensu, więc go ukrywamy.
 */
function setupBackLink() {
  const target = new URLSearchParams(location.search).get('next') || '';
  if (!isViewPath(target)) return;
  backLink.href = target;
  backLink.hidden = false;
}

setupBackLink();

showBtn.addEventListener('click', () => {
  const shown = uidInput.type === 'text';
  uidInput.type = shown ? 'password' : 'text';
  showBtn.textContent = shown ? 'Pokaż' : 'Ukryj';
  showBtn.setAttribute('aria-pressed', shown ? 'false' : 'true');
  uidInput.focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const uid = uidInput.value.trim();
  errorEl.hidden = true;

  if (!uid) {
    errorEl.hidden = false;
    errorEl.textContent = 'Wpisz uid.';
    uidInput.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sprawdzam…';

  try {
    const res = await drFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, next: nextUrl() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Nie udało się zalogować.');
    location.href = data.next || nextUrl();
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = err.message;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Zaloguj';
    uidInput.select();
  }
});
