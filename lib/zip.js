'use strict';

const path = require('path');
const fsp = require('fs').promises;
const AdmZip = require('adm-zip');

const SKIP_RE = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\.git)(\/|$)/i;
const MAX_FILES = 5000;
const MAX_UNPACKED = 300 * 1024 * 1024; // 300 MB

/**
 * Bezpiecznie rozpakowuje archiwum ZIP do katalogu `destDir`.
 * Chroni przed "zip slip" (ścieżkami wychodzącymi poza katalog) i pomija śmieci.
 * Zwraca listę ścieżek relatywnych (z ukośnikami "/").
 */
async function extractZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const files = [];
  let total = 0;

  await fsp.mkdir(destDir, { recursive: true });

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    let name = String(entry.entryName).replace(/\\/g, '/');
    if (SKIP_RE.test(name)) continue;
    name = name.replace(/^\.?\//, '');
    if (!name || name.endsWith('/')) continue;

    const safe = path.posix.normalize(name);
    if (!safe || safe === '.' || safe.startsWith('..') || path.posix.isAbsolute(safe)) continue;

    const target = path.join(destDir, ...safe.split('/'));
    const rel = path.relative(destDir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

    const data = entry.getData();
    total += data.length;
    if (total > MAX_UNPACKED) throw new Error('Archiwum jest zbyt duże po rozpakowaniu.');
    if (files.length >= MAX_FILES) throw new Error('Archiwum zawiera zbyt wiele plików.');

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    files.push(safe);
  }

  if (!files.length) throw new Error('Archiwum nie zawiera żadnych plików.');
  return files;
}

/**
 * Pakuje katalog ze stroną do archiwum ZIP i zwraca je jako Buffer.
 * Komentarze trzymane są poza katalogiem strony, więc archiwum ich nie zawiera.
 */
async function packDir(dir) {
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) throw new Error('Brak katalogu projektu.');
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  if (!zip.getEntries().length) throw new Error('Projekt nie zawiera plików.');
  return zip.toBuffer();
}

/**
 * Wybiera plik startowy (HTML) sposród rozpakowanych plików.
 * Preferuje index.html, potem najpłycej położone pliki HTML.
 */
function detectEntry(files) {
  const html = files.filter((f) => /\.html?$/i.test(f));
  if (!html.length) return null;

  const scored = html.map((f) => {
    const parts = f.split('/');
    const base = parts[parts.length - 1].toLowerCase();
    return { f, depth: parts.length, isIndex: base === 'index.html' || base === 'index.htm' };
  });

  scored.sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.f.localeCompare(b.f);
  });

  return scored[0].f;
}

module.exports = { extractZip, detectEntry, packDir };
