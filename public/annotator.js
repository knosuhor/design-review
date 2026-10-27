'use strict';

/**
 * Design Review – warstwa adnotacji wstrzykiwana do podglądanej strony.
 *
 * Działa wewnątrz <iframe> (strona designu) i komunikuje się z widokiem
 * recenzji wyłącznie przez window.postMessage. Komentarze są zakotwiczone
 * albo jako pinezka (współrzędne w dokumencie), albo jako zaznaczony zakres
 * tekstu (ścieżka XPath + offsety znaków, z awaryjnym wyszukiwaniem tekstu).
 *
 * Ten sam plik obsługuje strony na żywo (np. WordPress), na których wkleja
 * się go jednorazowo jako <script src=".../annotator.js" defer>. Poza ramką
 * widoku recenzji nic nie robi – zwykli odwiedzający strony go nie widzą.
 */

(function () {
  // Warstwa działa tylko wewnątrz ramki podglądu.
  if (window.parent === window) return;
  if (window.__designReviewAnnotator) return;
  window.__designReviewAnnotator = true;

  var NS = 'design-review';
  var win = window;
  var doc = document;
  var OWN_TAG = /^DRA-/;
  var SCRIPT = doc.currentScript;

  /**
   * Widok recenzji działa pod tym samym originem, z którego pobrano skrypt
   * (dla stron z ZIP-a to po prostu ta sama domena). Wiadomości wysyłamy
   * wyłącznie tam – gdy stronę osadzi w ramce ktoś inny, nic do niego nie
   * trafi, a warstwa pozostanie nieaktywna.
   */
  var PARENT_ORIGIN = (function () {
    try { return SCRIPT && SCRIPT.src ? new URL(SCRIPT.src, win.location.href).origin : ''; } catch (e) { return ''; }
  })();
  if (!PARENT_ORIGIN) return;

  // Strony z ZIP-a serwer oznacza atrybutem data-page; jego brak = strona na żywo.
  var LIVE = !(SCRIPT.hasAttribute && SCRIPT.hasAttribute('data-page'));
  var ZIP_PREFIX = LIVE ? '' : ((/^\/p\/[^/]+\//.exec(win.location.pathname) || [''])[0]);

  /**
   * Strona, w której działa warstwa. Dla ZIP-a to ścieżka pliku (np.
   * "about.html") z atrybutu data-page. Dla strony na żywo – ścieżka adresu,
   * a przy odnośnikach ?p=123 / ?page_id=123 także ten parametr (tak samo
   * liczy to serwer).
   */
  function currentPage() {
    if (LIVE) {
      var path = win.location.pathname || '/';
      var params = ['page_id', 'p'];
      for (var i = 0; i < params.length; i++) {
        var m = new RegExp('[?&]' + params[i] + '=(\\d+)(?:&|$)').exec(win.location.search);
        if (m) return path + '?' + params[i] + '=' + m[1];
      }
      return path;
    }
    var page = SCRIPT.getAttribute('data-page');
    if (page) return page;
    var z = /^\/p\/[^/]+\/(.*)$/.exec(win.location.pathname);
    if (!z) return '';
    try { return decodeURIComponent(z[1]); } catch (e) { return z[1]; }
  }

  /** ID wpisu WordPressa z klas <body> (page-id-12 / postid-34), jeśli jest. */
  function wpPostId() {
    if (!LIVE || !doc.body) return null;
    var m = /(?:^|\s)(?:page-id|postid)-(\d+)(?:\s|$)/.exec(String(doc.body.className || ''));
    return m ? parseInt(m[1], 10) : null;
  }

  var connected = false;

  var state = {
    comments: [],
    mode: 'select',
    selectedId: null,
    pending: null,
    missingKey: '',
    hiddenIds: {},
  };

  /* --------------------------------------------------------------------- */
  /*  Komunikacja z widokiem recenzji                                      */
  /* --------------------------------------------------------------------- */

  function post(type, payload) {
    var msg = { ns: NS, type: type };
    if (payload) {
      for (var k in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
      }
    }
    try { win.parent.postMessage(msg, PARENT_ORIGIN); } catch (e) { /* nic */ }
  }

  /* --------------------------------------------------------------------- */
  /*  Style nakładek                                                       */
  /* --------------------------------------------------------------------- */

  var CSS = [
    'dra-overlay{position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;',
    'width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;',
    'background:transparent!important;display:block!important;overflow:visible!important;z-index:2147483000!important;',
    'pointer-events:none!important;visibility:visible!important;opacity:1!important;transform:none!important;',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif!important;font-size:14px!important;',
    'line-height:1.4!important;color:#14161c!important;text-align:left!important;direction:ltr!important;',
    'box-sizing:border-box!important;}',
    'dra-overlay *{box-sizing:border-box!important;}',

    // Środek znacznika w punkcie (translate), a szerokość rośnie z liczbą – 999 też się mieści.
    'dra-pin{position:absolute!important;min-width:26px!important;height:26px!important;margin:0!important;',
    'transform:translate(-50%,-50%)!important;',
    'padding:0 6px!important;border-radius:13px!important;background:#4f46e5!important;border:2px solid #fff!important;',
    'box-shadow:0 2px 6px rgba(0,0,0,.35)!important;display:grid!important;place-items:center!important;',
    'pointer-events:auto!important;cursor:pointer!important;color:#fff!important;font-size:12px!important;',
    'font-weight:700!important;font-family:system-ui,sans-serif!important;line-height:1!important;',
    'transition:transform .12s ease!important;user-select:none!important;-webkit-user-select:none!important;}',
    'dra-pin:hover{transform:translate(-50%,-50%) scale(1.15)!important;}',
    'dra-pin.dra-resolved{background:#98a0b0!important;}',
    'dra-pin.dra-pending{background:#fff!important;border:2.5px dashed #4f46e5!important;color:#4f46e5!important;}',

    'dra-hl{position:absolute!important;margin:0!important;padding:0!important;border:0!important;',
    'background:rgba(79,70,229,.22)!important;border-radius:3px!important;pointer-events:auto!important;',
    'cursor:pointer!important;box-shadow:inset 0 -1.5px 0 rgba(79,70,229,.6)!important;',
    'transition:background .12s ease!important;}',
    'dra-hl:hover{background:rgba(79,70,229,.36)!important;}',
    'dra-hl.dra-resolved{background:rgba(120,130,150,.18)!important;box-shadow:inset 0 -1.5px 0 rgba(120,130,150,.5)!important;}',
    'dra-hl.dra-pending{background:rgba(79,70,229,.12)!important;border:1.5px dashed #4f46e5!important;box-shadow:none!important;}',

    'dra-hibadge{position:absolute!important;min-width:20px!important;height:20px!important;margin:0!important;',
    'transform:translate(-50%,-50%)!important;transition:transform .12s ease!important;',
    'padding:0 4px!important;border-radius:10px!important;background:#4f46e5!important;border:2px solid #fff!important;',
    'color:#fff!important;font-size:11px!important;font-weight:700!important;font-family:system-ui,sans-serif!important;',
    'display:grid!important;place-items:center!important;pointer-events:auto!important;cursor:pointer!important;',
    'box-shadow:0 2px 6px rgba(0,0,0,.3)!important;line-height:1!important;user-select:none!important;',
    '-webkit-user-select:none!important;}',
    'dra-hibadge.dra-resolved{background:#98a0b0!important;}',
    'dra-hibadge:hover{transform:translate(-50%,-50%) scale(1.15)!important;}',
    // Element jest teraz ukryty (zwinięty akordeon, zakładka, slajd) – znacznik
    // stoi w najbliższym widocznym miejscu, z przerywanym obrysem.
    'dra-pin.dra-concealed,dra-hibadge.dra-concealed{border-style:dashed!important;opacity:.8!important;}',

    'dra-tip{position:absolute!important;transform:translateX(-50%)!important;background:#14161c!important;',
    'color:#fff!important;border:0!important;border-radius:8px!important;padding:7px 12px!important;',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif!important;font-size:12.5px!important;',
    'font-weight:600!important;line-height:1!important;white-space:nowrap!important;align-items:center!important;',
    'gap:6px!important;margin:0!important;pointer-events:auto!important;cursor:pointer!important;',
    'box-shadow:0 6px 20px rgba(0,0,0,.35)!important;z-index:10!important;user-select:none!important;',
    '-webkit-user-select:none!important;}',
    'dra-tip:after{content:""!important;position:absolute!important;left:50%!important;bottom:-4px!important;',
    'width:9px!important;height:9px!important;background:#14161c!important;margin:0!important;',
    'transform:translateX(-50%) rotate(45deg)!important;border-radius:2px!important;}',
    'dra-tip.dra-below:after{bottom:auto!important;top:-4px!important;}',
    'dra-tip-icon{display:block!important;font-size:12px!important;line-height:1!important;color:#fff!important;margin:0!important;}',
    'dra-tiplabel{display:block!important;font-size:12.5px!important;line-height:1!important;color:#fff!important;margin:0!important;}',

    'html.dra-pin-mode,html.dra-pin-mode body,html.dra-pin-mode body *{cursor:crosshair!important;}',

    // Obwódka wokół elementu, którego dotyczy wybrany komentarz (tylko pinezki).
    'dra-outline{position:absolute!important;margin:0!important;padding:0!important;pointer-events:none!important;',
    'border:2px solid rgba(79,70,229,.9)!important;border-radius:4px!important;background:rgba(79,70,229,.10)!important;',
    'z-index:1!important;}',

    // Pinezki i plakietki zawsze ponad podświetleniami tekstu.
    'dra-pin{z-index:3!important;}',
    'dra-hibadge{z-index:3!important;}',

    // Zaznaczony komentarz: cały znacznik (razem z numerem) przeskalowany do
    // 120% i w kolorze pinezki z paska (#ee3a70). Obwódka pozostaje taka sama
    // jak w pozostałych.
    'dra-pin.dra-selected,dra-hibadge.dra-selected{background:#ee3a70!important;',
    'transform:translate(-50%,-50%) scale(1.2)!important;z-index:6!important;}',
    'dra-pin.dra-selected:hover,dra-hibadge.dra-selected:hover{transform:translate(-50%,-50%) scale(1.3)!important;}',
    'dra-pin.dra-resolved.dra-selected,dra-hibadge.dra-resolved.dra-selected{background:#d3a0ad!important;}',
    'dra-hl.dra-selected{background:rgba(99,102,241,.42)!important;box-shadow:inset 0 -2px 0 rgba(99,102,241,.85)!important;}',
  ].join('');

  function mount() {
    var styleEl = doc.createElement('style');
    styleEl.setAttribute('data-design-review', 'overlay');
    styleEl.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(styleEl);

    var overlay = doc.createElement('dra-overlay');
    overlay.setAttribute('data-design-review', 'overlay');

    var pinLayer = doc.createElement('dra-pinlayer');
    var hlLayer = doc.createElement('dra-hllayer');

    var tip = doc.createElement('dra-tip');
    var tipIcon = doc.createElement('dra-tip-icon');
    tipIcon.textContent = '💬';
    var tipLabel = doc.createElement('dra-tiplabel');
    tipLabel.textContent = 'Dodaj komentarz';
    tip.appendChild(tipIcon);
    tip.appendChild(tipLabel);

    overlay.appendChild(pinLayer);
    overlay.appendChild(hlLayer);
    overlay.appendChild(tip);
    (doc.body || doc.documentElement).appendChild(overlay);

    return { overlay: overlay, pinLayer: pinLayer, hlLayer: hlLayer, tip: tip };
  }

  // Nakładki powstają dopiero po połączeniu z widokiem recenzji (connect()).
  var overlay = null;
  var pinLayer = null;
  var hlLayer = null;
  var tip = null;

  // display ustawiamy z priorytetem, bo arkusz używa !important.
  function showTipEl() { tip.style.setProperty('display', 'flex', 'important'); }
  function hideTipEl() { if (tip) tip.style.setProperty('display', 'none', 'important'); }
  function tipVisible() { return !!tip && tip.style.display !== 'none'; }

  function isOurs(node) {
    while (node) {
      if (overlay && node === overlay) return true;
      if (node.nodeType === 1 && node.tagName && OWN_TAG.test(node.tagName)) return true;
      node = node.parentNode;
    }
    return false;
  }

  /* --------------------------------------------------------------------- */
  /*  Ścieżki do węzłów                                                    */
  /* --------------------------------------------------------------------- */

  /**
   * Kroki ścieżki od `root` do `node` w postaci "div[2]", "text()[1]".
   * Zwraca [] gdy node === root, null gdy node nie leży wewnątrz root.
   */
  function stepsFrom(root, node) {
    if (!node || node.nodeType === 9) return null;
    var parts = [];
    var cur = node;
    while (cur && cur !== root) {
      if (cur.nodeType === 3) {
        var ti = 1;
        var ts = cur.previousSibling;
        while (ts) { if (ts.nodeType === 3) ti++; ts = ts.previousSibling; }
        parts.unshift('text()[' + ti + ']');
      } else if (cur.nodeType === 1) {
        var name = cur.nodeName.toLowerCase();
        var ei = 1;
        var es = cur.previousSibling;
        while (es) {
          if (es.nodeType === 1 && es.nodeName.toLowerCase() === name) ei++;
          es = es.previousSibling;
        }
        parts.unshift(name + '[' + ei + ']');
      } else {
        return null;
      }
      cur = cur.parentNode;
    }
    return cur === root ? parts : null;
  }

  function xpathOf(node) {
    var steps = stepsFrom(doc.documentElement, node);
    return steps && steps.length ? '/' + steps.join('/') : null;
  }

  function resolveSteps(root, steps) {
    var node = root;
    for (var i = 0; i < steps.length; i++) {
      var m = /^([a-zA-Z0-9_:.-]+|text\(\))\[(\d+)\]$/.exec(steps[i]);
      if (!m) return null;
      var name = m[1];
      var want = parseInt(m[2], 10);
      var count = 0;
      var found = null;
      var kids = node.childNodes;
      for (var j = 0; j < kids.length; j++) {
        var kid = kids[j];
        var kidName = kid.nodeType === 1 ? kid.nodeName.toLowerCase()
          : kid.nodeType === 3 ? 'text()' : '';
        if (kidName === name) {
          count++;
          if (count === want) { found = kid; break; }
        }
      }
      if (!found) return null;
      node = found;
    }
    return node;
  }

  function resolveXPath(path) {
    if (!path || path.charAt(0) !== '/') return null;
    return resolveSteps(doc.documentElement, path.slice(1).split('/'));
  }

  function nodeLength(node) {
    if (!node) return 0;
    if (node.nodeType === 3) return node.nodeValue.length;
    if (node.nodeType === 1) return node.childNodes.length;
    return 0;
  }

  /* --------------------------------------------------------------------- */
  /*  Kotwice Elementora (data-id)                                         */
  /* --------------------------------------------------------------------- */

  /*
   * Elementor nadaje każdemu elementowi stały data-id, który przetrwa
   * dodanie sekcji wyżej czy przesunięcie bloku – w odróżnieniu od XPath.
   * Kotwica zapisuje: data-id najbliższego elementu, numer jego wystąpienia
   * (ten sam data-id może się powtórzyć: Loop Grid, globalne widżety,
   * wielokrotnie wstawiony szablon) oraz ścieżkę od niego do celu.
   * Kopie tworzone przez skrypty strony (slajdy karuzeli w pętli, wypełniacz
   * przyklejanego nagłówka) pomijamy. Pełny XPath zostaje jako zapas.
   */
  var CLONE_SELECTOR = '.swiper-slide-duplicate, .slick-cloned, .elementor-sticky__spacer';
  var EID_RE = /^[A-Za-z0-9]{1,32}$/;

  function isElementorElement(el) {
    if (!el || el.nodeType !== 1 || !el.hasAttribute('data-id')) return false;
    // Elementor (klasyczny i Atomic v4) – z data-id korzystają też inne skrypty.
    return el.hasAttribute('data-element_type') || el.hasAttribute('data-e-type')
      || (el.classList && el.classList.contains('elementor-element'));
  }

  function isClone(el) {
    return !!(el && el.closest && el.closest(CLONE_SELECTOR));
  }

  /** Elementy o danym data-id w kolejności dokumentu, bez kopii. */
  function elementorCandidates(id) {
    var out = [];
    var list = doc.querySelectorAll('[data-id="' + id + '"]');
    for (var i = 0; i < list.length; i++) {
      if (isElementorElement(list[i]) && !isClone(list[i])) out.push(list[i]);
    }
    return out;
  }

  function elementorAnchor(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentNode;
    while (el && el.nodeType === 1 && !isElementorElement(el)) el = el.parentNode;
    if (!el || el.nodeType !== 1 || isClone(el)) return null;
    var id = el.getAttribute('data-id');
    if (!EID_RE.test(id)) return null;
    var n = elementorCandidates(id).indexOf(el) + 1;
    var steps = stepsFrom(el, node);
    if (!n || !steps) return null;
    return { id: id, n: n, rel: steps.join('/') };
  }

  /**
   * Węzeł wskazywany przez kotwicę: najpierw data-id (gdy się powtarza –
   * ten egzemplarz, który zawiera węzeł z XPath, a w drugiej kolejności
   * zapisany numer wystąpienia), potem sam XPath.
   */
  function resolveNode(eid, xpath) {
    if (eid && typeof eid.id === 'string' && EID_RE.test(eid.id)) {
      var candidates = elementorCandidates(eid.id);
      var base = null;
      if (candidates.length === 1) {
        base = candidates[0];
      } else if (candidates.length > 1) {
        var byPath = xpath ? resolveXPath(xpath) : null;
        for (var i = 0; byPath && i < candidates.length; i++) {
          if (candidates[i] === byPath || candidates[i].contains(byPath)) { base = candidates[i]; break; }
        }
        if (!base && eid.n >= 1 && eid.n <= candidates.length) base = candidates[eid.n - 1];
      }
      if (base) {
        var node = eid.rel ? resolveSteps(base, String(eid.rel).split('/')) : base;
        if (node) return node;
      }
    }
    return xpath ? resolveXPath(xpath) : null;
  }

  // Cache odnalezionych elementów pinezek – kotwica jest przeliczana przy
  // każdym przerysowaniu warstwy (m.in. przy przewijaniu i zmianie rozmiaru).
  var elementCache = {};

  function elementForTarget(t) {
    var key = t.xpath + (t.eid ? '|' + t.eid.id + '|' + t.eid.n + '|' + t.eid.rel : '');
    var cached = elementCache[key];
    if (cached && cached.isConnected && !isClone(cached)) return cached;
    var el = resolveNode(t.eid, t.xpath);
    if (el && el.nodeType !== 1) el = null;
    if (el) elementCache[key] = el;
    return el;
  }

  /* --------------------------------------------------------------------- */
  /*  Widoczność (akordeony, zakładki, karuzele)                           */
  /* --------------------------------------------------------------------- */

  /*
   * Przeglądarka podaje położenie także tekstu, którego nie widać: w zwiniętym
   * <details> (akordeony Atomic v4), w treści ukrytej stylami (zakładki,
   * klasyczny akordeon) czy poza kadrem karuzeli. Nakładka leży nad stroną,
   * więc nic jej nie przycina – sprawdzamy to sami. Wyniki trzymamy tylko
   * w obrębie jednego przerysowania.
   */
  var visCache = null;

  function cached(key, el, compute) {
    if (!visCache) return compute();
    var map = visCache[key];
    if (map.has(el)) return map.get(el);
    var value = compute();
    map.set(el, value);
    return value;
  }

  /** Element, który ukrywa `el` (zwinięty <details> albo ukrycie stylami), lub null. */
  function concealer(el) {
    if (!el || el.nodeType !== 1) return null;
    return cached('concealer', el, function () {
      for (var cur = el; cur && cur !== doc.documentElement; cur = cur.parentElement) {
        var parent = cur.parentElement;
        if (parent && parent.tagName === 'DETAILS' && !parent.open && cur.tagName !== 'SUMMARY') return parent;
        var cs = win.getComputedStyle(cur);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.contentVisibility === 'hidden') return cur;
      }
      return null;
    });
  }

  /**
   * Obszar ekranu, do którego przycinają `el` przodkowie z ukrytym
   * przepełnieniem (np. kadr karuzeli). null – brak przycinania.
   */
  function clipRect(el) {
    if (!el || el.nodeType !== 1) return null;
    return cached('clip', el, function () {
      var clip = null;
      for (var cur = el.parentElement; cur && cur !== doc.body && cur !== doc.documentElement; cur = cur.parentElement) {
        var cs = win.getComputedStyle(cur);
        var cx = cs.overflowX !== 'visible';
        var cy = cs.overflowY !== 'visible';
        if (!cx && !cy) continue;
        var b = cur.getBoundingClientRect();
        if (!clip) clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
        if (cx) { clip.left = Math.max(clip.left, b.left); clip.right = Math.min(clip.right, b.right); }
        if (cy) { clip.top = Math.max(clip.top, b.top); clip.bottom = Math.min(clip.bottom, b.bottom); }
      }
      return clip;
    });
  }

  function intersect(r, clip) {
    if (!clip) return r;
    var left = Math.max(r.left, clip.left);
    var top = Math.max(r.top, clip.top);
    var right = Math.min(r.right, clip.right);
    var bottom = Math.min(r.bottom, clip.bottom);
    if (right - left < 0.5 || bottom - top < 0.5) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
  }

  function clamp(v, min, max) {
    return max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v));
  }

  function isShown(el) {
    if (!el || concealer(el)) return false;
    var b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1;
  }

  /**
   * Najbliższe widoczne miejsce zastępujące ukryty element: zwinięty
   * <details> (widać jego <summary>), widoczny sąsiad – tytuł akordeonu,
   * aktywna zakładka – a w ostateczności widoczny przodek.
   * `edge` mówi, przy której krawędzi postawić znacznik.
   */
  function visibleProxy(hider) {
    if (hider.tagName === 'DETAILS' && isShown(hider)) return { el: hider, edge: 'bottom' };
    var s;
    for (s = hider.previousElementSibling; s; s = s.previousElementSibling) {
      if (isShown(s)) return { el: s, edge: 'bottom' };
    }
    for (s = hider.nextElementSibling; s; s = s.nextElementSibling) {
      if (isShown(s)) return { el: s, edge: 'top' };
    }
    for (var cur = hider.parentElement; cur && cur !== doc.documentElement; cur = cur.parentElement) {
      if (isShown(cur)) return { el: cur, edge: 'inside' };
    }
    return null;
  }

  /**
   * Punkt znacznika dla elementu `el`: gdy element jest ukryty albo punkt
   * leży poza kadrem, przesuwamy go do najbliższego widocznego miejsca.
   */
  function placeVisible(el, pt) {
    var hider = concealer(el);
    if (hider) {
      var proxy = visibleProxy(hider);
      if (!proxy) return { x: pt.x, y: pt.y, concealed: true };
      var b = proxy.el.getBoundingClientRect();
      var cb = intersect(b, clipRect(proxy.el)) || b;
      // Ukryty element zwykle nie ma położenia (0, 0) – wtedy lewa krawędź.
      var x = pt.x || pt.y ? pt.x : cb.left;
      var y = proxy.edge === 'bottom' ? cb.bottom : proxy.edge === 'top' ? cb.top : clamp(pt.y, cb.top, cb.bottom);
      return { x: clamp(x, cb.left + 13, cb.right - 13), y: y, concealed: true };
    }
    var clip = clipRect(el);
    if (clip && (pt.x < clip.left || pt.x > clip.right || pt.y < clip.top || pt.y > clip.bottom)) {
      return { x: clamp(pt.x, clip.left + 13, clip.right - 13), y: clamp(pt.y, clip.top + 13, clip.bottom - 13), concealed: true };
    }
    return { x: pt.x, y: pt.y, concealed: false };
  }

  /** Węzły tekstowe (z treścią) leżące w zakresie. */
  function textNodesIn(range) {
    var root = range.commonAncestorContainer;
    if (root.nodeType === 3) return root.nodeValue.trim() ? [root] : [];
    var out = [];
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue.trim() && range.intersectsNode(n) && !isOurs(n)) out.push(n);
    }
    return out;
  }

  /** Część zakresu w jednym węźle tekstowym. */
  function nodeSlice(range, node) {
    var r = doc.createRange();
    r.setStart(node, node === range.startContainer ? range.startOffset : 0);
    r.setEnd(node, node === range.endContainer ? range.endOffset : node.nodeValue.length);
    return r;
  }

  /** Widoczne prostokąty fragmentu tekstu (bez ukrytych i przyciętych). */
  function visibleSliceRects(slice, node) {
    var out = [];
    var el = node.parentElement;
    if (!el || concealer(el)) return out;
    var clip = clipRect(el);
    var raw = null;
    try { raw = slice.getClientRects(); } catch (e) { raw = null; }
    for (var i = 0; raw && i < raw.length; i++) {
      if (raw[i].width < 0.5 || raw[i].height < 0.5) continue;
      var r = intersect(raw[i], clip);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Część zakresu, którą widać – zaznaczenie wychodzące np. do zwiniętej
   * treści akordeonu jest przycinane do widocznego tekstu. null – nic nie widać.
   */
  function visiblePart(range) {
    var nodes = textNodesIn(range);
    var first = null;
    var last = null;
    for (var i = 0; i < nodes.length; i++) {
      if (visibleSliceRects(nodeSlice(range, nodes[i]), nodes[i]).length) {
        if (!first) first = nodes[i];
        last = nodes[i];
      }
    }
    if (!first) return null;
    var r = range.cloneRange();
    if (first !== range.startContainer) r.setStart(first, 0);
    if (last !== range.endContainer) r.setEnd(last, last.nodeValue.length);
    return r;
  }

  /** Rozwija zwinięte <details>, w których leży węzeł. Zwraca true, gdy coś rozwinięto. */
  function revealDetails(node) {
    var opened = false;
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    for (var cur = el; cur && cur !== doc.documentElement; cur = cur.parentElement) {
      var parent = cur.parentElement;
      if (parent && parent.tagName === 'DETAILS' && !parent.open && cur.tagName !== 'SUMMARY') {
        parent.open = true;
        opened = true;
      }
    }
    return opened;
  }

  /* --------------------------------------------------------------------- */
  /*  Kotwiczenie tekstu                                                   */
  /* --------------------------------------------------------------------- */

  function normalizeWithMap(str) {
    var out = '';
    var map = [];
    var prevSpace = false;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (/\s/.test(ch)) {
        if (prevSpace) continue;
        out += ' ';
        map.push(i);
        prevSpace = true;
      } else {
        out += ch;
        map.push(i);
        prevSpace = false;
      }
    }
    return { text: out, map: map };
  }

  function findByText(needle) {
    if (!needle || !doc.body) return null;
    var target = needle.replace(/\s+/g, ' ').trim();
    if (target.length < 2) return null;
    var probe = target.slice(0, 60);

    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentNode;
        while (p && p !== doc.body) {
          if (p.nodeType === 1 && p.tagName
            && (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TITLE)$/.test(p.tagName) || OWN_TAG.test(p.tagName))) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    var n;
    while ((n = walker.nextNode())) {
      var norm = normalizeWithMap(n.nodeValue);
      var idx = norm.text.indexOf(probe);
      if (idx === -1) continue;
      var startOrig = norm.map[idx];
      var endNorm = Math.min(idx + probe.length - 1, norm.map.length - 1);
      var endOrig = norm.map[endNorm] + 1;
      try {
        var r = doc.createRange();
        r.setStart(n, startOrig);
        r.setEnd(n, Math.min(endOrig, n.nodeValue.length));
        return r;
      } catch (e) { /* próbuj dalej */ }
    }
    return null;
  }

  /** Zakres między węzłami – tylko jeśli nadal obejmuje zapisany tekst. */
  function rangeBetween(s, e, anchor) {
    if (!s || !e) return null;
    try {
      var range = doc.createRange();
      range.setStart(s, Math.min(anchor.startOffset, nodeLength(s)));
      range.setEnd(e, Math.min(anchor.endOffset, nodeLength(e)));
      var text = range.toString().replace(/\s+/g, ' ').trim();
      if (!text || (anchor.text && text.slice(0, 500) !== anchor.text)) return null;
      return range;
    } catch (err) {
      return null;
    }
  }

  function buildRange(anchor) {
    if (!anchor) return null;
    var range = null;
    if (anchor.startEid || anchor.endEid) {
      range = rangeBetween(resolveNode(anchor.startEid, anchor.startXPath),
        resolveNode(anchor.endEid, anchor.endXPath), anchor);
    }
    if (!range) range = rangeBetween(resolveXPath(anchor.startXPath), resolveXPath(anchor.endXPath), anchor);
    return range || findByText(anchor.text);
  }

  /**
   * Podświetlenie zakresu: widoczne prostokąty (fragmenty w ukrytych
   * i przyciętych miejscach są pomijane). Gdy nie widać nic, `point` wskazuje
   * najbliższe widoczne miejsce na numer komentarza. null – brak zakresu.
   */
  function marksForRange(range) {
    var rects = [];
    var nodes = textNodesIn(range);
    for (var i = 0; i < nodes.length; i++) {
      rects = rects.concat(visibleSliceRects(nodeSlice(range, nodes[i]), nodes[i]));
    }
    if (rects.length || !nodes.length) return { rects: rects, concealed: false, point: null };
    var first = nodes[0];
    var b = nodeSlice(range, first).getBoundingClientRect();
    var spot = placeVisible(first.parentElement, { x: b.left, y: b.top + b.height / 2 });
    return { rects: rects, concealed: true, point: { x: spot.x, y: spot.y } };
  }

  function marksFor(anchor) {
    var range = buildRange(anchor);
    return range ? marksForRange(range) : null;
  }

  function serializeRange(range) {
    var anchor = {
      startXPath: xpathOf(range.startContainer),
      startOffset: range.startOffset,
      endXPath: xpathOf(range.endContainer),
      endOffset: range.endOffset,
      text: range.toString().replace(/\s+/g, ' ').trim().slice(0, 500),
    };
    var startEid = elementorAnchor(range.startContainer);
    var endEid = elementorAnchor(range.endContainer);
    if (startEid) anchor.startEid = startEid;
    if (endEid) anchor.endEid = endEid;
    return anchor;
  }

  /* --------------------------------------------------------------------- */
  /*  Kotwiczenie pinezek                                                  */
  /* --------------------------------------------------------------------- */

  function round5(value) {
    return Math.round(value * 100000) / 100000;
  }

  /**
   * Znajduje element, do którego przypinamy pinezkę: najbliższy przodek
   * klikniętego punktu, który ma niezerowy prostokąt. Wraz z elementem
   * zapisujemy położenie kliknięcia jako ułamek jego szerokości i wysokości,
   * dzięki czemu pinezka podąża za elementem przy zmianie rozmiaru okna.
   */
  function targetForPoint(node, clientX, clientY) {
    var el = node;
    while (el && el.nodeType === 1 && el !== doc.documentElement) {
      if (!OWN_TAG.test(el.tagName) && el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) {
          var path = xpathOf(el);
          if (path) {
            var target = {
              xpath: path,
              fx: round5(Math.min(1, Math.max(0, (clientX - r.left) / r.width))),
              fy: round5(Math.min(1, Math.max(0, (clientY - r.top) / r.height))),
            };
            var eid = elementorAnchor(el);
            if (eid) target.eid = eid;
            return target;
          }
        }
      }
      el = el.parentNode;
    }
    return null;
  }

  /**
   * Pozycja pinezki we współrzędnych viewportu ramki. Jeśli element docelowy
   * da się odnaleźć, pozycja liczona jest z jego aktualnego położenia –
   * w przeciwnym razie używane są zapisane współrzędne dokumentu. Gdy element
   * jest teraz ukryty (akordeon, zakładka, slajd poza kadrem), pinezka stoi
   * w najbliższym widocznym miejscu i ma `concealed: true`.
   */
  function pinViewportPoint(anchor) {
    var t = anchor && anchor.target;
    if (t && t.xpath) {
      var el = elementForTarget(t);
      if (el && el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        var fx = typeof t.fx === 'number' ? t.fx : 0.5;
        var fy = typeof t.fy === 'number' ? t.fy : 0.5;
        var spot = placeVisible(el, { x: r.left + fx * r.width, y: r.top + fy * r.height });
        if (spot.concealed || r.width > 0 || r.height > 0) {
          return { x: spot.x, y: spot.y, anchored: true, concealed: spot.concealed };
        }
      }
    }
    var off = scrollOffsets();
    return {
      x: (typeof anchor.x === 'number' ? anchor.x : 0) - off.x,
      y: (typeof anchor.y === 'number' ? anchor.y : 0) - off.y,
      anchored: false,
      concealed: false,
    };
  }

  function selectedComment() {
    if (!state.selectedId) return null;
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id === state.selectedId) return state.comments[i];
    }
    return null;
  }

  /**
   * Obwódka wokół elementu, którego dotyczy wybrany komentarz-pinezka.
   * Dzięki niej po kliknięciu wpisu na liście od razu widać, do czego
   * odnosi się komentarz – nawet jeśli sama pinezka jest mała.
   */
  function drawSelectedOutline() {
    var c = selectedComment();
    if (!c || c.type !== 'pin' || !c.anchor || state.hiddenIds[c.id]) return;
    var t = c.anchor.target;
    if (!t || !t.xpath) return;
    var el = elementForTarget(t);
    if (!el || !el.getBoundingClientRect || concealer(el)) return;
    var r = intersect(el.getBoundingClientRect(), clipRect(el));
    if (!r || r.width < 1 || r.height < 1) return;
    var box = doc.createElement('dra-outline');
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    hlLayer.appendChild(box);
  }

  /* --------------------------------------------------------------------- */
  /*  Rysowanie nakładek                                                   */
  /* --------------------------------------------------------------------- */

  function scrollOffsets() {
    var de = doc.documentElement;
    var b = doc.body || { scrollLeft: 0, scrollTop: 0 };
    return {
      x: win.pageXOffset || de.scrollLeft || b.scrollLeft || 0,
      y: win.pageYOffset || de.scrollTop || b.scrollTop || 0,
    };
  }

  var CONCEALED_TITLE = 'Element jest teraz ukryty (np. zwinięty akordeon, zakładka lub slajd)';

  /*
   * Znaczniki (pinezki i numery zaznaczeń) zostają między przerysowaniami –
   * zmienia się tylko ich położenie i wygląd. Nowy element pod kursorem
   * zaczynałby animację powiększenia od zera, więc przy częstych
   * przerysowaniach (strony z animacjami) znacznik pulsował.
   */
  var markers = {};
  var usedMarkers = {};

  function marker(tag, key) {
    var el = markers[key];
    if (!el) {
      el = doc.createElement(tag);
      markers[key] = el;
      pinLayer.appendChild(el);
    }
    usedMarkers[key] = true;
    return el;
  }

  function sweepMarkers() {
    for (var key in markers) {
      if (Object.prototype.hasOwnProperty.call(markers, key) && !usedMarkers[key]) {
        if (markers[key].parentNode) markers[key].parentNode.removeChild(markers[key]);
        delete markers[key];
      }
    }
    usedMarkers = {};
  }

  /** Ustawia wygląd znacznika (bez zbędnych zmian w DOM). */
  function updateMarker(el, base, comment, label, x, y, opts) {
    var cls = base
      + (comment.resolved && !opts.pending ? ' dra-resolved' : '')
      + (opts.pending ? ' dra-pending' : '')
      + (opts.concealed ? ' dra-concealed' : '')
      + (!opts.pending && state.selectedId === comment.id ? ' dra-selected' : '');
    if (el.className !== cls) el.className = cls;
    if (opts.pending) el.removeAttribute('data-comment-id');
    else if (el.getAttribute('data-comment-id') !== comment.id) el.setAttribute('data-comment-id', comment.id);
    if (opts.concealed) el.setAttribute('title', CONCEALED_TITLE);
    else el.removeAttribute('title');
    var text = label == null ? '' : String(label);
    if (el.textContent !== text) el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    return el;
  }

  function makePin(comment, label, x, y, pending, concealed) {
    var el = marker('dra-pin', pending ? 'pending' : 'pin:' + comment.id);
    return updateMarker(el, 'dra-pin', comment, label, x, y, { pending: pending, concealed: concealed });
  }

  function makeBadge(comment, num, x, y, concealed) {
    var el = marker('dra-hibadge', 'badge:' + comment.id);
    return updateMarker(el, 'dra-hibadge', comment, num, x, y, { concealed: concealed });
  }

  /** Numer komentarza tekstowego, gdy cały zaznaczony tekst jest ukryty. */
  function appendConcealedBadge(comment, num, point) {
    makeBadge(comment, num, point.x, point.y, true);
  }

  function appendHighlight(comment, rects, num, pending) {
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var el = doc.createElement('dra-hl');
      el.className = 'dra-hl'
        + (comment.resolved && !pending ? ' dra-resolved' : '')
        + (pending ? ' dra-pending' : '')
        + (!pending && state.selectedId === comment.id ? ' dra-selected' : '');
      if (!pending) el.setAttribute('data-comment-id', comment.id);
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
      hlLayer.appendChild(el);
    }

    if (pending || !rects.length) return;
    var last = rects[rects.length - 1];
    makeBadge(comment, num, last.right + 2, last.top + last.height / 2, false);
  }

  // Podświetlenia rysujemy od nowa; znaczniki zostają (zob. marker()).
  function clearLayers() {
    while (hlLayer.firstChild) hlLayer.removeChild(hlLayer.firstChild);
  }

  function render() {
    if (!overlay || !overlay.parentNode) return;
    clearLayers();
    visCache = { concealer: new Map(), clip: new Map() };

    var missing = [];
    var concealed = [];

    for (var i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      if (!c || !c.anchor) continue;
      if (state.hiddenIds[c.id]) continue;
      if (c.type === 'pin') {
        var pt = pinViewportPoint(c.anchor);
        if (pt.concealed) concealed.push(c.id);
        makePin(c, i + 1, pt.x, pt.y, false, pt.concealed);
      } else {
        var marks = marksFor(c.anchor);
        if (!marks || (!marks.rects.length && !marks.point)) { missing.push(c.id); continue; }
        if (marks.rects.length) {
          appendHighlight(c, marks.rects, i + 1, false);
        } else {
          concealed.push(c.id);
          appendConcealedBadge(c, i + 1, marks.point);
        }
      }
    }

    var p = state.pending;
    if (p) {
      if (p.kind === 'pin' && p.anchor) {
        var ppt = pinViewportPoint(p.anchor);
        makePin({}, '✎', ppt.x, ppt.y, true);
      } else if (p.range) {
        var pm = marksForRange(p.range);
        if (pm.rects.length) appendHighlight({}, pm.rects, null, true);
      }
    }

    drawSelectedOutline();
    sweepMarkers();
    visCache = null;

    var key = missing.join(',') + '|' + concealed.join(',');
    if (key !== state.missingKey) {
      state.missingKey = key;
      post('missing', { ids: missing, concealed: concealed });
    }
  }

  /* --------------------------------------------------------------------- */
  /*  Zaznaczanie tekstu                                                   */
  /* --------------------------------------------------------------------- */

  var pendingSelection = null;

  function showTip(rect) {
    var above = rect.top > 46;
    showTipEl();
    tip.style.left = (rect.left + rect.width / 2) + 'px';
    if (above) {
      tip.classList.remove('dra-below');
      tip.style.top = Math.max(2, rect.top - 42) + 'px';
    } else {
      tip.classList.add('dra-below');
      tip.style.top = (rect.bottom + 12) + 'px';
    }
  }

  function clearSelectionTip() {
    hideTipEl();
    pendingSelection = null;
  }

  function captureSelection() {
    if (state.mode !== 'select') { clearSelectionTip(); return; }
    var sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { clearSelectionTip(); return; }
    var range;
    try { range = sel.getRangeAt(0); } catch (e) { clearSelectionTip(); return; }
    if (!range.commonAncestorContainer || !doc.body
      || !doc.body.contains(range.commonAncestorContainer)) { clearSelectionTip(); return; }
    if (isOurs(range.commonAncestorContainer)) { clearSelectionTip(); return; }

    // Zaznaczenie wychodzące poza widoczny tekst (np. do zwiniętej treści
    // akordeonu) zapisujemy tylko w widocznej części.
    range = visiblePart(range);
    if (!range) { clearSelectionTip(); return; }

    var text = range.toString().replace(/\s+/g, ' ').trim();
    if (!text) { clearSelectionTip(); return; }

    var rect;
    try { rect = range.getBoundingClientRect(); } catch (e) { clearSelectionTip(); return; }
    if (!rect || (!rect.width && !rect.height)) { clearSelectionTip(); return; }

    var anchor = serializeRange(range);
    if (!anchor.startXPath || !anchor.endXPath) { clearSelectionTip(); return; }

    pendingSelection = { anchor: anchor, range: range.cloneRange(), text: text };
    showTip(rect);
  }

  function commitSelection() {
    if (!pendingSelection) return;
    var anchor = pendingSelection.anchor;
    var text = pendingSelection.text;
    var range = pendingSelection.range;
    clearSelectionTip();
    state.pending = { kind: 'text', anchor: anchor, range: range };
    render();
    post('new-anchor', { page: currentPage(), postId: wpPostId(), kind: 'text', anchor: anchor, preview: text });
  }

  /* --------------------------------------------------------------------- */
  /*  Zdarzenia                                                            */
  /* --------------------------------------------------------------------- */

  doc.addEventListener('mouseup', function (e) {
    if (!connected || state.mode !== 'select') return;
    if (isOurs(e.target)) return;
    setTimeout(captureSelection, 0);
  }, true);

  doc.addEventListener('mousedown', function (e) {
    if (state.mode === 'pin' && !isOurs(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  doc.addEventListener('click', function (e) {
    if (state.mode !== 'pin') return;
    if (isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    var off = scrollOffsets();
    var anchor = {
      x: Math.round((e.clientX + off.x) * 100) / 100,
      y: Math.round((e.clientY + off.y) * 100) / 100,
      docWidth: doc.documentElement.scrollWidth,
      docHeight: doc.documentElement.scrollHeight,
    };
    var target = targetForPoint(e.target, e.clientX, e.clientY);
    if (target) anchor.target = target;
    try {
      var sel = win.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    } catch (err) { /* nic */ }
    state.pending = { kind: 'pin', anchor: anchor, range: null };
    render();
    post('new-anchor', { page: currentPage(), postId: wpPostId(), kind: 'pin', anchor: anchor, preview: '' });
  }, true);

  /**
   * Linki prowadzące poza recenzowaną stronę nie przełączają ramki – widok
   * recenzji pokazuje wtedy komunikat z możliwością otwarcia linku w nowej
   * karcie. Nasłuchujemy na końcu propagacji: jeśli strona sama obsłużyła
   * kliknięcie (np. lightbox, menu), nie przeszkadzamy jej.
   */
  function closestLink(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentNode;
    return el && el.closest ? el.closest('a[href], area[href]') : null;
  }

  function staysInReview(url) {
    if (url.origin !== win.location.origin) return false;
    return LIVE || (!!ZIP_PREFIX && url.pathname.indexOf(ZIP_PREFIX) === 0);
  }

  win.addEventListener('click', function (e) {
    if (!connected || state.mode !== 'select') return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = closestLink(e.target);
    if (!a || isOurs(a) || a.hasAttribute('download')) return;

    var raw = a.getAttribute('href') || '';
    if (!raw || raw.charAt(0) === '#') return;
    var url;
    try { url = new URL(raw, doc.baseURI || win.location.href); } catch (err) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return; // mailto:, tel:, javascript:

    // Nowa karta lub nazwane okno – ramka zostaje na miejscu.
    var target = (a.getAttribute('target') || '').toLowerCase();
    var replacesView = target === '_top' || target === '_parent';
    if (target && target !== '_self' && !replacesView) return;

    if (staysInReview(url)) {
      // _top/_parent podmieniłyby cały widok recenzji – otwieramy w ramce.
      if (replacesView) {
        e.preventDefault();
        win.location.href = url.href;
      }
      return;
    }
    e.preventDefault();
    post('blocked-link', { url: url.href });
  }, false);

  function markerIdFrom(node) {
    var el = node;
    while (el && el !== overlay) {
      if (el.nodeType === 1 && el.getAttribute && el.getAttribute('data-comment-id')) {
        return el.getAttribute('data-comment-id');
      }
      el = el.parentNode;
    }
    return null;
  }

  function bindOverlay() {
    overlay.addEventListener('click', function (e) {
      if (tip === e.target || tip.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        commitSelection();
        return;
      }
      var id = markerIdFrom(e.target);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      state.selectedId = id;
      render();
      post('select-comment', { id: id });
    }, true);

    tip.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
    tip.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
  }

  /* --------------------------------------------------------------------- */
  /*  Przerysowanie przy zmianach układu                                   */
  /* --------------------------------------------------------------------- */

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var done = false;
    function run() {
      if (done) return;
      done = true;
      scheduled = false;
      render();
    }
    // requestAnimationFrame bywa wstrzymywany (np. gdy karta nie jest rysowana),
    // dlatego dodatkowo ustawiamy bezpiecznik czasowy.
    try {
      if (win.requestAnimationFrame) win.requestAnimationFrame(run);
      else win.setTimeout(run, 16);
    } catch (e) { /* nic */ }
    win.setTimeout(run, 60);
  }

  function viewportChanged() {
    clearSelectionTip();
    schedule();
  }

  win.addEventListener('scroll', viewportChanged, true);
  doc.addEventListener('scroll', viewportChanged, true);
  win.addEventListener('resize', viewportChanged);
  doc.addEventListener('load', schedule, true);

  if (win.ResizeObserver) {
    try {
      new win.ResizeObserver(schedule).observe(doc.documentElement);
      if (doc.body) new win.ResizeObserver(schedule).observe(doc.body);
    } catch (e) { /* nic */ }
  }
  if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) doc.fonts.ready.then(schedule);
  setTimeout(schedule, 300);
  setTimeout(schedule, 1500);

  // Tanie wykrywanie zmian układu po dłuższym czasie (leniwe obrazy, animacje).
  var lastSignature = '';
  setInterval(function () {
    if (!state.comments.length && !state.pending) return;
    var de = doc.documentElement;
    var deep = doc.body ? Math.round(doc.body.getBoundingClientRect().height) : 0;
    var off = scrollOffsets();
    var sig = de.scrollHeight + 'x' + de.scrollWidth + 'x' + deep
      + 'x' + Math.round(off.x) + 'x' + Math.round(off.y);
    if (sig === lastSignature) return;
    lastSignature = sig;
    if (tipVisible()) return;
    render();
  }, 700);

  /**
   * Na stronie na żywo treść potrafi zmienić się bez zmiany rozmiaru
   * (slidery, doładowywane sekcje, animacje wejścia). Reagujemy na zmiany
   * DOM-u – z pominięciem własnych nakładek i z ograniczeniem częstotliwości.
   */
  var mutationTimer = null;
  function watchMutations() {
    if (!win.MutationObserver) return;
    new win.MutationObserver(function (records) {
      if (mutationTimer || (!state.comments.length && !state.pending)) return;
      for (var i = 0; i < records.length; i++) {
        if (!isOurs(records[i].target)) {
          mutationTimer = setTimeout(function () { mutationTimer = null; schedule(); }, 200);
          return;
        }
      }
    }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  /** Pierwsza poprawna wiadomość od widoku recenzji uruchamia warstwę. */
  function connect() {
    if (connected) return;
    connected = true;
    var ui = mount();
    overlay = ui.overlay;
    pinLayer = ui.pinLayer;
    hlLayer = ui.hlLayer;
    tip = ui.tip;
    hideTipEl();
    bindOverlay();
    watchMutations();
    schedule();
  }

  function readyInfo() {
    return {
      page: currentPage(),
      postId: wpPostId(),
      url: win.location.href,
      height: doc.documentElement.scrollHeight,
    };
  }

  /* --------------------------------------------------------------------- */
  /*  Odbieranie poleceń z widoku recenzji                                 */
  /* --------------------------------------------------------------------- */

  function scrollToY(top) {
    top = Math.max(0, top);
    try { win.scrollTo({ top: top, behavior: 'smooth' }); } catch (e) {
      try { win.scrollTo(0, top); } catch (e2) { /* nic */ }
    }
    if (doc.body && doc.body.scrollHeight - doc.body.clientHeight > 4) {
      try { doc.body.scrollTo({ top: top, behavior: 'smooth' }); } catch (e3) { doc.body.scrollTop = top; }
    }
  }

  function focusComment(id, scroll) {
    state.selectedId = id || null;
    render();
    if (!scroll || !id) return;

    var c = null;
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id === id) { c = state.comments[i]; break; }
    }
    if (!c || !c.anchor) return;

    // Komentarz w zwiniętym akordeonie (<details>): najpierw go rozwiń,
    // a przewiń dopiero po animacji rozwijania.
    var node = null;
    if (c.type === 'pin') {
      node = c.anchor.target && c.anchor.target.xpath ? elementForTarget(c.anchor.target) : null;
    } else {
      var range = buildRange(c.anchor);
      node = range && range.startContainer;
    }
    if (node && revealDetails(node)) {
      setTimeout(function () { render(); scrollToComment(c); }, 380);
      return;
    }
    scrollToComment(c);
  }

  function scrollToComment(c) {
    if (c.type === 'pin') {
      var pt = pinViewportPoint(c.anchor);
      scrollToY(scrollOffsets().y + pt.y - win.innerHeight / 2);
      return;
    }
    var marks = marksFor(c.anchor);
    if (!marks) return;
    var top = marks.rects.length ? marks.rects[0].top : marks.point && marks.point.y;
    if (typeof top !== 'number') return;
    scrollToY(scrollOffsets().y + top - win.innerHeight / 3);
  }

  win.addEventListener('message', function (e) {
    // Polecenia przyjmujemy wyłącznie od widoku recenzji, który osadził ramkę.
    if (e.source !== win.parent || e.origin !== PARENT_ORIGIN) return;
    var d = e.data;
    if (!d || d.ns !== NS) return;

    if (d.type === 'init') {
      connect();
      post('ready', readyInfo());
      return;
    }
    // Widok sprawdza po każdym wczytaniu ramki, czy warstwa nadal odpowiada.
    if (d.type === 'probe') {
      post(connected ? 'alive' : 'hello');
      return;
    }
    if (!connected) return;

    switch (d.type) {
      case 'set-comments':
        state.comments = Array.isArray(d.comments) ? d.comments : [];
        state.missingKey = '';
        render();
        break;
      case 'set-mode':
        state.mode = d.mode === 'pin' ? 'pin' : 'select';
        doc.documentElement.classList.toggle('dra-pin-mode', state.mode === 'pin');
        if (state.mode !== 'select') clearSelectionTip();
        break;
      case 'clear-pending':
        state.pending = null;
        render();
        break;
      case 'set-hidden':
        state.hiddenIds = {};
        if (Array.isArray(d.ids)) {
          for (var h = 0; h < d.ids.length; h++) state.hiddenIds[d.ids[h]] = true;
        }
        render();
        break;
      case 'focus':
        focusComment(d.id, true);
        break;
      case 'select':
        state.selectedId = d.id || null;
        render();
        break;
      default:
        break;
    }
  }, false);

  // Przywitanie: widok recenzji odpowie poleceniem 'init'. Skrypt wklejony
  // w <head> bez defer czeka, aż powstanie <body>.
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', function () { post('hello'); });
  } else {
    post('hello');
  }
})();
