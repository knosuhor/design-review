'use strict';

/**
 * Uczestnicy wątków z adresem e-mail – powiadomienia o odpowiedziach
 * i wzmiankach. Plik data/subscribers/<id projektu>.json:
 *   { "<e-mail>": { name, token, unsubscribed, notifiedUpTo, sentTimes,
 *                   undeliverable, undeliverableReported } }
 *
 * Adresy nie trafiają do API komentarzy. Token służy do wypisania się
 * (link w mailu albo przycisk w widoku recenzji) – zawiera id projektu,
 * więc wystarczy, by znaleźć właściwy plik.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const store = require('./store');

const DIR = path.join(store.DATA_DIR, 'subscribers');
const queues = new Map();

function fileOf(projectId) {
  return path.join(DIR, projectId + '.json');
}

async function read(projectId) {
  try {
    const parsed = JSON.parse(await fsp.readFile(fileOf(projectId), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Odczyt–zmiana–zapis jednego pliku po kolei (bez wyścigów między żądaniami). */
function withData(projectId, fn) {
  const prev = queues.get(projectId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const data = await read(projectId);
    const result = await fn(data);
    await fsp.mkdir(DIR, { recursive: true });
    const tmp = fileOf(projectId) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, fileOf(projectId));
    return result;
  });
  queues.set(projectId, next);
  return next;
}

function newToken(projectId) {
  return projectId + '.' + crypto.randomBytes(18).toString('base64url');
}

/**
 * Piszący sam podał adres – zgoda na powiadomienia. Wznawia też wcześniejsze
 * wypisanie. Zwraca token do wypisania się.
 */
function subscribe(projectId, email, name, at) {
  return withData(projectId, (data) => {
    const entry = data[email] || { token: newToken(projectId), notifiedUpTo: at, sentTimes: [] };
    entry.name = name;
    delete entry.undeliverable; // adres wpisany ponownie – spróbujemy jeszcze raz
    delete entry.undeliverableReported;
    if (entry.unsubscribed) {
      entry.unsubscribed = false;
      entry.notifiedUpTo = at; // bez zaległości z czasu wypisania
    }
    data[email] = entry;
    return entry.token;
  });
}

/**
 * Osoba wspomniana we wpisie z chwili `at`. Nowa dostaje powiadomienie o tej
 * wzmiance i dalszych odpowiedziach; wypisanej nie zapisujemy ponownie.
 */
function addMentioned(projectId, email, name, at) {
  return withData(projectId, (data) => {
    if (!data[email]) {
      data[email] = { name, token: newToken(projectId), notifiedUpTo: at - 1, sentTimes: [] };
    }
  });
}

function update(projectId, email, patch) {
  return withData(projectId, (data) => {
    if (data[email]) Object.assign(data[email], patch);
  });
}

/** Wypisanie tokenem. Zwraca { projectId } albo null, gdy token nieznany. */
async function unsubscribe(token) {
  const value = String(token || '');
  const projectId = value.split('.')[0];
  if (!/^[a-f0-9]{6,32}$/.test(projectId)) return null;
  const found = await withData(projectId, (data) => {
    for (const email of Object.keys(data)) {
      if (data[email].token === value) {
        data[email].unsubscribed = true;
        return true;
      }
    }
    return false;
  });
  return found ? { projectId } : null;
}

/** Czy token istnieje (do strony potwierdzenia – bez zmian w danych). */
async function findToken(token) {
  const value = String(token || '');
  const projectId = value.split('.')[0];
  if (!/^[a-f0-9]{6,32}$/.test(projectId)) return null;
  const data = await read(projectId);
  for (const email of Object.keys(data)) {
    if (data[email].token === value) return { projectId, unsubscribed: Boolean(data[email].unsubscribed) };
  }
  return null;
}

async function remove(projectId) {
  await fsp.rm(fileOf(projectId), { force: true });
}

module.exports = { read, subscribe, addMentioned, update, unsubscribe, findToken, remove };
