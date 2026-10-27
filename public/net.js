'use strict';

/**
 * fetch() z czytelnym błędem po polsku. Przeglądarka przy braku połączenia
 * (serwer nie działa, restartuje się, zerwało połączenie, brak internetu)
 * zgłasza tylko „Failed to fetch” – zamieniamy to na zrozumiały komunikat.
 */
const NETWORK_ERROR_MESSAGE = 'Brak połączenia z serwerem Design Review. Sprawdź internet '
  + 'i spróbuj ponownie za chwilę – serwer mógł się właśnie restartować.';

async function drFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
}
