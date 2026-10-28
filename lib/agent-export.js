'use strict';

/**
 * Eksport komentarzy dla agenta AI – tekst Markdown z instrukcją na początku
 * i listą nierozwiązanych komentarzy pogrupowanych według stron.
 *
 * Każdy komentarz wskazuje miejsce na stronie tak, żeby agent znalazł je
 * w kodzie:
 *  - projekt ZIP: plik, numer linii i fragment HTML z pliku źródłowego
 *    (zapisany XPath odnajdujemy w drzewie parse5 – buduje je tak samo jak
 *    przeglądarka) oraz krótki selektor CSS z klasami,
 *  - strona na żywo: selektor i kontekst zapisane przez przeglądarkę przy
 *    dodawaniu komentarza, data-id Elementora i ID wpisu WordPressa.
 * Starsze komentarze bez zapisanego kontekstu dostają selektor wyliczony
 * z samej ścieżki (bez klas).
 */

const fsp = require('fs').promises;
const path = require('path');
const parse5 = require('parse5');

const SNIPPET_MAX = 300;
const TEXT_PREVIEW = 80;

/* ------------------------------ klasy CSS -------------------------------- */

// Klasy, które nic nie mówią o elemencie: techniczne klasy Elementora,
// generowane identyfikatory, stany zmieniane przez skrypty.
const NOISE_CLASS_RE = [
  /^elementor-(element|section|column|container|top-|inner|widget-wrap|widget-container|repeater-item|invisible|motion|kit|\d)/,
  /^e-(con|atomic|div-block|default|flex|grid|parent|child|lazyloaded|[0-9a-f]{4,})/,
  /^(css|sc|jsx|svelte|emotion|tw)-[A-Za-z0-9]+$/,
  /^(is|has)-/,
  /^(active|current|open|show|shown|hidden|visible|animated|lazyloaded|loaded|selected|focus|hover)$/,
  /-(active|current|visible|hidden|open|duplicate|cloned)$/,
];
const IDENT_RE = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

function meaningfulClasses(list) {
  return list
    .filter((c) => IDENT_RE.test(c) && c.length <= 40)
    .filter((c) => !NOISE_CLASS_RE.some((re) => re.test(c)))
    // Ciągi przypominające skrót (hash) – np. „x7f3a9c1”.
    .filter((c) => !(/\d/.test(c) && /[0-9a-f]{6,}/i.test(c)))
    .slice(0, 2);
}

/* --------------------------- drzewo parse5 -------------------------------- */

const isElement = (n) => n && typeof n.tagName === 'string';
const elementChildren = (n) => (n && n.childNodes ? n.childNodes.filter(isElement) : []);

function attr(el, name) {
  const found = (el.attrs || []).find((a) => a.name === name);
  return found ? found.value : null;
}

function classList(el) {
  return String(attr(el, 'class') || '').split(/\s+/).filter(Boolean);
}

function documentElement(doc) {
  return elementChildren(doc).find((n) => n.tagName === 'html') || null;
}

/** Kroki ścieżki "body[1]/div[2]/text()[1]" od elementu <html>. */
function resolveSteps(root, steps) {
  let node = root;
  for (const step of steps) {
    const m = /^([a-zA-Z0-9_:.-]+|text\(\))\[(\d+)\]$/.exec(step);
    if (!m || !node || !node.childNodes) return null;
    const name = m[1].toLowerCase();
    const want = Number(m[2]);
    let count = 0;
    let found = null;
    for (const kid of node.childNodes) {
      const kidName = isElement(kid) ? kid.tagName : kid.nodeName === '#text' ? 'text()' : '';
      if (kidName === name && ++count === want) { found = kid; break; }
    }
    if (!found) return null;
    node = found;
  }
  return node;
}

function resolveXPath(doc, xpath) {
  const root = documentElement(doc);
  if (!root || !xpath || xpath.charAt(0) !== '/') return null;
  // Annotator zapisuje kroki od elementu <html> ("/body[1]/…"); dopuszczamy też "/html[1]/…".
  const steps = xpath.slice(1).split('/');
  return resolveSteps(root, steps[0] === 'html[1]' ? steps.slice(1) : steps);
}

function textContent(node) {
  if (!node) return '';
  if (node.nodeName === '#text') return node.value;
  if (['script', 'style', 'template'].includes(node.tagName)) return '';
  return (node.childNodes || []).map(textContent).join('');
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function preview(text, max) {
  const t = squash(text);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Element z położeniem w pliku – implikowane elementy (np. <tbody>) go nie mają. */
function locatedElement(el) {
  let cur = el;
  while (cur && isElement(cur)) {
    if (cur.sourceCodeLocation) return { el: cur, exact: cur === el };
    cur = cur.parentNode;
  }
  return null;
}

/** Fragment kodu elementu: cały, gdy krótki, inaczej znacznik otwierający + początek tekstu. */
function sourceSnippet(html, el) {
  const loc = el.sourceCodeLocation;
  if (!loc) return '';
  const whole = html.slice(loc.startOffset, loc.endOffset);
  if (squash(whole).length <= SNIPPET_MAX) return squash(whole);
  const start = loc.startTag ? squash(html.slice(loc.startTag.startOffset, loc.startTag.endOffset)) : '';
  if (!start) return preview(whole, SNIPPET_MAX);
  const text = preview(textContent(el), TEXT_PREVIEW);
  return (start.length > SNIPPET_MAX ? start.slice(0, SNIPPET_MAX - 2) + '…>' : start)
    + (text ? text : '…') + `</${el.tagName}>`;
}

/** Linia w pliku, w której zaczyna się węzeł (dla tekstu – z uwzględnieniem przesunięcia). */
function lineOf(html, node, offset) {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  if (node.nodeName === '#text' && offset > 0) {
    const before = html.slice(loc.startOffset, Math.min(loc.endOffset, loc.startOffset + offset));
    return loc.startLine + (before.match(/\n/g) || []).length;
  }
  return loc.startLine;
}

/** Tekst najbliższego nagłówka (h1–h6) poprzedzającego element w dokumencie. */
function headingBefore(doc, target) {
  let last = '';
  let done = false;
  const walk = (node) => {
    if (done) return;
    if (node === target) { done = true; return; }
    if (isElement(node) && /^h[1-6]$/.test(node.tagName)) {
      const text = preview(textContent(node), 100);
      if (text) last = text;
      // Nagłówek zawierający cel – to on opisuje miejsce.
      if (containsNode(node, target)) { done = true; return; }
      return;
    }
    for (const kid of node.childNodes || []) walk(kid);
  };
  walk(doc);
  return last;
}

function containsNode(ancestor, node) {
  for (let cur = node; cur; cur = cur.parentNode) if (cur === ancestor) return true;
  return false;
}

/* ------------------------------ selektor CSS ------------------------------ */

function allElements(doc) {
  const out = [];
  const walk = (n) => {
    for (const kid of n.childNodes || []) {
      if (isElement(kid)) { out.push(kid); walk(kid); }
    }
  };
  walk(doc);
  return out;
}

function compoundMatches(el, seg) {
  if (seg.id) return attr(el, 'id') === seg.id;
  if (seg.tag && el.tagName !== seg.tag) return false;
  if (seg.classes.length) {
    const list = classList(el);
    if (!seg.classes.every((c) => list.includes(c))) return false;
  }
  if (seg.nth) {
    const same = elementChildren(el.parentNode).filter((s) => s.tagName === el.tagName);
    if (same.indexOf(el) + 1 !== seg.nth) return false;
  }
  return true;
}

/** Dopasowanie łańcucha segmentów (od prawej) z kombinatorami '>' i ' '. */
function chainMatches(el, chain, i) {
  if (!el || !isElement(el) || !compoundMatches(el, chain[i].seg)) return false;
  if (i === 0) return true;
  if (chain[i].comb === '>') return chainMatches(el.parentNode, chain, i - 1);
  for (let a = el.parentNode; a && isElement(a); a = a.parentNode) {
    if (chainMatches(a, chain, i - 1)) return true;
  }
  return false;
}

function segText(seg) {
  if (seg.id) return '#' + seg.id;
  return seg.tag + seg.classes.map((c) => '.' + c).join('') + (seg.nth ? `:nth-of-type(${seg.nth})` : '');
}

function chainText(chain) {
  return chain.map((c, i) => (i === 0 ? '' : c.comb === '>' ? ' > ' : ' ') + segText(c.seg)).join('');
}

/**
 * Najkrótszy jednoznaczny selektor: segmenty od elementu w górę (do elementu
 * z unikalnym id albo <body>), potem przycinany od góry, dopóki trafia
 * dokładnie w jeden element.
 */
function cssSelector(doc, target) {
  const all = allElements(doc);
  const idCount = new Map();
  for (const el of all) {
    const id = attr(el, 'id');
    if (id) idCount.set(id, (idCount.get(id) || 0) + 1);
  }
  const segs = [];
  for (let el = target; el && isElement(el); el = el.parentNode) {
    const id = attr(el, 'id');
    if (id && IDENT_RE.test(id) && idCount.get(id) === 1) { segs.unshift({ id }); break; }
    if (el.tagName === 'body' || el.tagName === 'html') { segs.unshift({ tag: el.tagName, classes: [] }); break; }
    const seg = { tag: el.tagName, classes: meaningfulClasses(classList(el)) };
    const siblings = elementChildren(el.parentNode).filter((s) => s !== el && compoundMatches(s, seg));
    if (siblings.length) {
      seg.nth = elementChildren(el.parentNode).filter((s) => s.tagName === el.tagName).indexOf(el) + 1;
    }
    segs.unshift(seg);
  }
  const unique = (chain) => all.filter((el) => chainMatches(el, chain, chain.length - 1)).length === 1;
  const asChain = (list, firstComb) => list.map((seg, i) => ({ seg, comb: i === 0 ? '' : i === 1 ? firstComb : '>' }));

  const candidates = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    candidates.push(asChain(segs.slice(i), '>'));
    // Zakotwiczenie w elemencie z id: „#oferta a.btn” zamiast całej ścieżki.
    if (i > 1 && segs[0].id) candidates.push(asChain([segs[0]].concat(segs.slice(i)), ' '));
  }
  candidates.sort((a, b) => chainText(a).length - chainText(b).length);
  const best = candidates.find(unique);
  return best ? chainText(best) : chainText(asChain(segs, '>'));
}

/* ------------------------- miejsce w pliku (ZIP) -------------------------- */

/** Ścieżka XPath zapisana w kotwicy (pinezka albo początek zaznaczenia). */
function anchorPath(comment) {
  const a = comment.anchor || {};
  if (comment.type === 'pin') return a.target ? { xpath: a.target.xpath, offset: 0 } : null;
  return a.startXPath ? { xpath: a.startXPath, offset: Number(a.startOffset) || 0 } : null;
}

function zipLocation(source, comment) {
  const ref = anchorPath(comment);
  if (!source || !ref) return null;
  const node = resolveXPath(source.doc, ref.xpath);
  if (!node) return missingLocation(source, ref.xpath);
  const el = isElement(node) ? node : node.parentNode;
  if (!isElement(el)) return null;
  const located = locatedElement(el);
  if (!located) return null;
  const lineNode = isElement(node) ? located.el : node;
  return {
    line: lineOf(source.html, lineNode, ref.offset) || located.el.sourceCodeLocation.startLine,
    exact: located.exact,
    selector: cssSelector(source.doc, el),
    snippet: sourceSnippet(source.html, located.el),
    heading: headingBefore(source.doc, el),
  };
}

/**
 * Elementu nie ma w pliku (dodał go skrypt) – wskazujemy najbliższy element
 * nadrzędny, który w pliku jest: tam skrypt zwykle wstawia treść.
 */
function missingLocation(source, xpath) {
  const steps = xpath.split('/');
  for (let n = steps.length - 1; n > 1; n--) {
    const node = resolveXPath(source.doc, steps.slice(0, n).join('/'));
    if (!node || !isElement(node) || !node.sourceCodeLocation) continue;
    if (['html', 'head', 'body'].includes(node.tagName)) return { missing: true };
    const loc = node.sourceCodeLocation;
    return {
      missing: true,
      parent: {
        line: loc.startLine,
        selector: cssSelector(source.doc, node),
        tag: loc.startTag ? squash(source.html.slice(loc.startTag.startOffset, loc.startTag.endOffset)) : '',
      },
    };
  }
  return { missing: true };
}

async function loadSource(siteDir, page, cache) {
  if (cache.has(page)) return cache.get(page);
  let source = null;
  try {
    const file = path.join(siteDir, ...page.split('/'));
    const rel = path.relative(siteDir, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const buffer = await fsp.readFile(file);
      const html = buffer.toString(isUtf8(buffer) ? 'utf8' : 'latin1');
      source = { html, doc: parse5.parse(html, { sourceCodeLocationInfo: true }) };
    }
  } catch {
    source = null;
  }
  cache.set(page, source);
  return source;
}

function isUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ starsze kotwice --------------------------- */

/** "div[2]/a[1]/text()[1]" → "div:nth-of-type(2) > a" (tekst pomijamy). */
function stepsToCss(steps) {
  return steps
    .filter((s) => !/^text\(\)/.test(s))
    .map((s) => {
      const m = /^([a-zA-Z0-9_-]+)\[(\d+)\]$/.exec(s);
      if (!m) return null;
      return m[2] === '1' ? m[1].toLowerCase() : `${m[1].toLowerCase()}:nth-of-type(${m[2]})`;
    })
    .filter(Boolean)
    .join(' > ');
}

function eidOf(comment) {
  const a = comment.anchor || {};
  return comment.type === 'pin' ? a.target && a.target.eid : a.startEid;
}

/** Selektor bez kontekstu: od elementu Elementora albo z pełnej ścieżki. */
function fallbackSelector(comment) {
  const eid = eidOf(comment);
  if (eid && eid.id) {
    const tail = eid.rel ? stepsToCss(eid.rel.split('/')) : '';
    return `[data-id="${eid.id}"]` + (tail ? ' > ' + tail : '');
  }
  const ref = anchorPath(comment);
  if (!ref) return '';
  const steps = ref.xpath.slice(1).split('/');
  const bodyAt = steps.indexOf('body[1]');
  return stepsToCss(bodyAt >= 0 ? ['body[1]'].concat(steps.slice(bodyAt + 1)) : steps);
}

/* -------------------------------- Markdown -------------------------------- */

function fence(code, lang) {
  const ticks = /```/.test(code) ? '~~~~' : '```';
  return `${ticks}${lang}\n${code}\n${ticks}`;
}

function inlineCode(text) {
  const t = String(text).replace(/\n/g, ' ');
  return t.includes('`') ? '`` ' + t + ' ``' : '`' + t + '`';
}

function quoteBlock(text) {
  return String(text).split('\n').map((l) => '> ' + l).join('\n');
}

function formatDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pageLabel(page) {
  try { return decodeURI(page); } catch { return page; }
}

function percent(v) {
  return Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100);
}

function describeLocation(project, comment, zip) {
  const lines = [];
  const a = comment.anchor || {};
  const ctx = a.context || {};
  const isZip = project.kind !== 'url';

  if (isZip) {
    if (zip && zip.missing) {
      lines.push(`- Plik: ${inlineCode(comment.page)} – elementu nie ma w pliku źródłowym `
        + '(prawdopodobnie tworzy go skrypt strony)');
      if (zip.parent) {
        lines.push(`- Najbliższy element nadrzędny w pliku: linia ${zip.parent.line}, `
          + `${inlineCode(zip.parent.selector)}` + (zip.parent.tag ? ` – ${inlineCode(preview(zip.parent.tag, 160))}` : ''));
      }
    } else if (zip) {
      lines.push(`- Plik: ${inlineCode(comment.page)}, linia ${zip.line}`
        + (zip.exact ? '' : ' (element dodany przez przeglądarkę – linia elementu nadrzędnego)'));
    } else {
      lines.push(`- Plik: ${inlineCode(comment.page)} – elementu nie ma w pliku źródłowym `
        + '(prawdopodobnie tworzy go skrypt strony)');
    }
  }
  const selector = (zip && !zip.missing && zip.selector) || ctx.selector || fallbackSelector(comment);
  if (selector) lines.push(`- Selektor CSS: ${inlineCode(selector)}`);

  const eid = eidOf(comment);
  if (eid && eid.id) {
    lines.push(`- Element Elementora: data-id ${inlineCode(eid.id)}`
      + (eid.n > 1 ? ` (${eid.n}. wystąpienie tego data-id na stronie)` : ''));
  }
  const heading = (zip && !zip.missing && zip.heading) || ctx.heading;
  if (heading) lines.push(`- Sekcja (najbliższy nagłówek): „${heading}”`);

  if (comment.type === 'text' && a.text) {
    lines.push(`- Zaznaczony tekst: „${squash(a.text)}”`);
  } else if (comment.type === 'pin' && a.target) {
    lines.push(`- Punkt kliknięcia w elemencie: ${percent(a.target.fx)}% od lewej, ${percent(a.target.fy)}% od góry`);
  }
  if (!selector && !a.text) lines.push('- Pinezka bez wskazanego elementu (tylko współrzędne na stronie).');

  const snippet = (zip && !zip.missing && zip.snippet) || ctx.snippet;
  if (snippet) lines.push('- Kod elementu:\n\n' + fence(snippet, 'html').replace(/^/gm, '  '));
  return lines.join('\n');
}

function pageHeading(project, page, comments) {
  if (project.kind !== 'url') return `## Plik ${inlineCode(page)}`;
  const url = project.origin ? project.origin + page : page;
  const postId = comments.map((c) => c.postId).find(Boolean);
  return `## Strona ${pageLabel(url)}` + (postId ? ` (ID wpisu WordPress: ${postId})` : '');
}

function intro(project, count, skippedResolved) {
  const isZip = project.kind !== 'url';
  const where = isZip
    ? 'Strona pochodzi z plików HTML (archiwum ZIP). Numery linii i fragmenty kodu odnoszą się do tych plików '
      + 'w wersji wgranej do recenzji.'
    : `Strona na żywo: ${project.url || project.origin}. To WordPress – „data-id” to identyfikator elementu `
      + 'w Elementorze, a „ID wpisu” to identyfikator strony (dokumentu Elementora).';
  return [
    `# Poprawki z recenzji: ${project.name}`,
    '',
    'Wprowadź zmiany opisane w poniższych komentarzach z recenzji designu.',
    '',
    '- Każdy komentarz wskazuje miejsce na stronie (plik lub adres, selektor CSS, fragment kodu) '
      + 'i opisuje, co poprawić.',
    '- Odpowiedzi pod komentarzem doprecyzowują prośbę – późniejsze mają pierwszeństwo.',
    '- Zmieniaj tylko wskazane miejsca. Jeśli prośba jest niejasna albo nie da się jej jednoznacznie '
      + 'odnieść do kodu, zapytaj zamiast zgadywać.',
    '- Na koniec wypisz numery komentarzy zrealizowanych i niezrealizowanych (z powodem).',
    '',
    where,
    '',
    `Komentarzy do zrobienia: ${count}` + (skippedResolved ? ` (pominięto rozwiązane: ${skippedResolved})` : '') + '.',
  ].join('\n');
}

/**
 * Tekst eksportu. `comments` – komentarze projektu (z polem `page`),
 * `siteDir` – katalog plików projektu ZIP.
 */
async function buildExport(project, comments, { siteDir, entry } = {}) {
  const open = comments.filter((c) => c && !c.resolved);
  const skipped = comments.length - open.length;
  const byPage = new Map();
  for (const c of open.slice().sort((a, b) => a.createdAt - b.createdAt)) {
    if (!byPage.has(c.page)) byPage.set(c.page, []);
    byPage.get(c.page).push(c);
  }
  const pages = Array.from(byPage.keys()).sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.localeCompare(b)));

  const out = [intro(project, open.length, skipped)];
  if (!open.length) {
    out.push('', 'Brak nierozwiązanych komentarzy – nie ma nic do zrobienia.');
    return out.join('\n') + '\n';
  }
  const cache = new Map();
  let num = 0;
  for (const page of pages) {
    const list = byPage.get(page);
    out.push('', pageHeading(project, page, list));
    const source = project.kind !== 'url' && siteDir ? await loadSource(siteDir, page, cache) : null;
    for (const c of list) {
      num++;
      const zip = source ? zipLocation(source, c) : null;
      const kind = c.type === 'pin' ? 'pinezka' : 'zaznaczony tekst';
      out.push('', `### ${num}. ${c.author} (${kind}, ${formatDate(c.createdAt)}, id ${c.id})`);
      out.push('', 'Miejsce:', describeLocation(project, c, zip));
      out.push('', 'Komentarz:', '', quoteBlock(c.text));
      const replies = Array.isArray(c.replies) ? c.replies : [];
      if (replies.length) {
        out.push('', 'Odpowiedzi (od najstarszej):', '');
        for (const r of replies) out.push(`- **${r.author}:** ${String(r.text).replace(/\n/g, '\n  ')}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

module.exports = { buildExport, cssSelector, meaningfulClasses, resolveXPath };
