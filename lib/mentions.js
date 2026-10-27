'use strict';

/**
 * Wzmianki w komentarzach i odpowiedziach: `@adam.nowak@firma.pl`.
 *
 * Adres nigdy nie zostaje w zapisanym tekście – zamieniamy go na imię:
 *  - adres z dozwolonej domeny (MENTION_DOMAINS) → pierwszy człon adresu
 *    (do pierwszej kropki albo do @) z wielką literą: „@Adam”,
 *  - adres, który uczestnik projektu sam podał przy komentarzu → jego imię,
 *  - inny adres → też pierwszy człon, ale bez powiadomienia (piszący dostaje
 *    informację, że tej osoby nie powiadomiono).
 */

// Znak przed @ (początek albo odstęp/nawias/cudzysłów) – „a@b@c.pl” to nie wzmianka.
const MENTION_RE = /(^|[\s([{"'„«])@([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Dozwolone domeny wzmianek z konfiguracji (np. "learnetic.com, firma.pl"). */
const DOMAINS = String(process.env.MENTION_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);

/** Poprawny adres w postaci znormalizowanej (małe litery) albo ''. */
function normalizeEmail(value) {
  const email = String(value == null ? '' : value).trim().toLowerCase();
  return email.length <= 200 && EMAIL_RE.test(email) ? email : '';
}

function inAllowedDomain(email, domains) {
  const domain = email.split('@')[1] || '';
  return (domains || DOMAINS).some((d) => domain === d || domain.endsWith('.' + d));
}

/** „adam.adamowski@wp.pl” → „Adam”. */
function shortName(email) {
  const first = email.split('@')[0].split('.')[0] || email.split('@')[0];
  return first.charAt(0).toLocaleUpperCase('pl') + first.slice(1);
}

/**
 * Adresy, które uczestnicy projektu sami podali (komentarze i odpowiedzi),
 * z imieniem, pod którym występują (ostatnim użytym).
 */
function participantsOf(comments) {
  const map = new Map();
  for (const c of comments || []) {
    if (!c) continue;
    if (c.email) map.set(c.email, c.author);
    for (const r of Array.isArray(c.replies) ? c.replies : []) {
      if (r && r.email) map.set(r.email, r.author);
    }
  }
  return map;
}

/**
 * Zamienia wzmianki adresami na imiona.
 * Zwraca { text, notify: [adresy do powiadomienia], notified: [imiona], skipped: [imiona],
 * names: [wszystkie imiona ze wzmianek – do wyróżnienia w tekście] }.
 */
function processMentions(text, { participants, selfEmail, domains } = {}) {
  const notify = [];
  const notified = [];
  const skipped = [];
  const names = [];
  const out = String(text == null ? '' : text).replace(MENTION_RE, (match, before, raw) => {
    const email = normalizeEmail(raw);
    if (!email) return match;
    let display;
    let allowed = false;
    if (inAllowedDomain(email, domains)) {
      display = shortName(email);
      allowed = true;
    } else if (participants && participants.has(email)) {
      display = participants.get(email) || shortName(email);
      allowed = true;
    } else {
      display = shortName(email);
    }
    if (allowed && email !== selfEmail) {
      if (!notify.includes(email)) {
        notify.push(email);
        notified.push(display);
      }
    } else if (!allowed && !skipped.includes(display)) {
      skipped.push(display);
    }
    if (!names.includes(display)) names.push(display);
    return before + '@' + display;
  });
  return { text: out, notify, notified, skipped, names };
}

module.exports = { DOMAINS, normalizeEmail, inAllowedDomain, shortName, participantsOf, processMentions };
