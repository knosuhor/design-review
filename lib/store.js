'use strict';

/**
 * Prosty magazyn danych oparty na plikach JSON.
 *  - data/db.json           -> lista projektów
 *  - data/comments/<id>.json -> komentarze danego projektu
 *  - sites/<id>/...          -> rozpakowane pliki strony
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const COMMENTS_DIR = path.join(DATA_DIR, 'comments');
const SITES_DIR = path.join(ROOT, 'sites');
const TMP_DIR = path.join(ROOT, 'tmp');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = { projects: [] };
let dbQueue = Promise.resolve();
const commentQueues = new Map();

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function siteDir(id) {
  return path.join(SITES_DIR, id);
}

function commentsFile(id) {
  return path.join(COMMENTS_DIR, id + '.json');
}

async function init() {
  for (const dir of [DATA_DIR, COMMENTS_DIR, SITES_DIR, TMP_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  try {
    const raw = await fsp.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.projects)) db = parsed;
  } catch {
    db = { projects: [] };
  }
  // Usuń wpisy, których katalogów już nie ma na dysku. Projekty typu URL
  // (strona na żywo) nie mają plików, więc zostają zawsze.
  db.projects = db.projects.filter(
    (p) => p && p.id && (p.kind === 'url' || fs.existsSync(siteDir(p.id)))
  );
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  dbQueue = dbQueue
    .then(async () => {
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((err) => console.error('[store] nie udało się zapisać db.json:', err));
  return dbQueue;
}

function listProjects() {
  return db.projects.slice().sort((a, b) => b.createdAt - a.createdAt);
}

function getProject(id) {
  return db.projects.find((p) => p.id === id) || null;
}

async function addProject(project) {
  db.projects.push(project);
  await persist();
  return project;
}

async function removeProject(id) {
  const idx = db.projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const [removed] = db.projects.splice(idx, 1);
  await persist();
  await fsp.rm(siteDir(id), { recursive: true, force: true });
  await fsp.rm(commentsFile(id), { force: true });
  return removed;
}

/** Aktualizuje pola projektu i zapisuje bazę. Zwraca zaktualizowany obiekt. */
async function updateProject(id, patch) {
  const project = db.projects.find((p) => p.id === id);
  if (!project) return null;
  Object.assign(project, patch);
  await persist();
  return project;
}

/* ------------------------------ komentarze ------------------------------ */

async function readComments(id) {
  try {
    const raw = await fsp.readFile(commentsFile(id), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeComments(id, comments) {
  const prev = commentQueues.get(id) || Promise.resolve();
  const next = prev
    .then(async () => {
      const tmp = commentsFile(id) + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(comments, null, 2), 'utf8');
      await fsp.rename(tmp, commentsFile(id));
    })
    .catch((err) => console.error('[store] nie udało się zapisać komentarzy:', err));
  commentQueues.set(id, next);
  return next;
}

async function addComment(projectId, comment) {
  const comments = await readComments(projectId);
  comments.push(comment);
  await writeComments(projectId, comments);
  return comment;
}

async function updateComment(projectId, commentId, patch) {
  const comments = await readComments(projectId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return null;
  Object.assign(comment, patch, { updatedAt: Date.now() });
  await writeComments(projectId, comments);
  return comment;
}

async function deleteComment(projectId, commentId) {
  const comments = await readComments(projectId);
  const idx = comments.findIndex((c) => c.id === commentId);
  if (idx === -1) return false;
  comments.splice(idx, 1);
  await writeComments(projectId, comments);
  return true;
}

/* ------------------------------ odpowiedzi ------------------------------ */

/** Dopisuje odpowiedź do komentarza. Zwraca zaktualizowany komentarz albo null. */
async function addReply(projectId, commentId, reply) {
  const comments = await readComments(projectId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return null;
  comment.replies = (Array.isArray(comment.replies) ? comment.replies : []).concat(reply);
  await writeComments(projectId, comments);
  return comment;
}

/** Usuwa odpowiedź. Zwraca zaktualizowany komentarz, null (brak komentarza) albo false (brak odpowiedzi). */
async function deleteReply(projectId, commentId, replyId) {
  const comments = await readComments(projectId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return null;
  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  const next = replies.filter((r) => r.id !== replyId);
  if (next.length === replies.length) return false;
  comment.replies = next;
  await writeComments(projectId, comments);
  return comment;
}

module.exports = {
  ROOT,
  DATA_DIR,
  SITES_DIR,
  TMP_DIR,
  PUBLIC_DIR,
  newId,
  init,
  siteDir,
  listProjects,
  getProject,
  addProject,
  removeProject,
  updateProject,
  readComments,
  addComment,
  updateComment,
  deleteComment,
  addReply,
  deleteReply,
};
