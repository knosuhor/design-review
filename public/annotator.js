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

    'dra-pin{position:absolute!important;width:26px!important;height:26px!important;margin:-13px 0 0 -13px!important;',
    'padding:0!important;border-radius:50%!important;background:#4f46e5!important;border:2px solid #fff!important;',
    'box-shadow:0 2px 6px rgba(0,0,0,.35)!important;display:grid!important;place-items:center!important;',
    'pointer-events:auto!important;cursor:pointer!important;color:#fff!important;font-size:12px!important;',
    'font-weight:700!important;font-family:system-ui,sans-serif!important;line-height:1!important;',
    'transition:transform .12s ease!important;user-select:none!important;-webkit-user-select:none!important;}',
    'dra-pin:hover{transform:scale(1.15)!important;}',
    'dra-pin.dra-resolved{background:#98a0b0!important;}',
    'dra-pin.dra-pending{background:#fff!important;border:2.5px dashed #4f46e5!important;color:#4f46e5!important;}',

    'dra-hl{position:absolute!important;margin:0!important;padding:0!important;border:0!important;',
    'background:rgba(79,70,229,.22)!important;border-radius:3px!important;pointer-events:auto!important;',
    'cursor:pointer!important;box-shadow:inset 0 -1.5px 0 rgba(79,70,229,.6)!important;',
    'transition:background .12s ease!important;}',
    'dra-hl:hover{background:rgba(79,70,229,.36)!important;}',
    'dra-hl.dra-resolved{background:rgba(120,130,150,.18)!important;box-shadow:inset 0 -1.5px 0 rgba(120,130,150,.5)!important;}',
    'dra-hl.dra-pending{background:rgba(79,70,229,.12)!important;border:1.5px dashed #4f46e5!important;box-shadow:none!important;}',

    'dra-hibadge{position:absolute!important;width:20px!important;height:20px!important;margin:-10px 0 0 -10px!important;',
    'padding:0!important;border-radius:50%!important;background:#4f46e5!important;border:2px solid #fff!important;',
    'color:#fff!important;font-size:11px!important;font-weight:700!important;font-family:system-ui,sans-serif!important;',
    'display:grid!important;place-items:center!important;pointer-events:auto!important;cursor:pointer!important;',
    'box-shadow:0 2px 6px rgba(0,0,0,.3)!important;line-height:1!important;user-select:none!important;',
    '-webkit-user-select:none!important;}',
    'dra-hibadge.dra-resolved{background:#98a0b0!important;}',

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
    'dra-pin.dra-selected{background:#ee3a70!important;transform:scale(1.2)!important;z-index:6!important;}',
    'dra-pin.dra-resolved.dra-selected{background:#d3a0ad!important;}',
    'dra-hibadge.dra-selected{background:#ee3a70!important;transform:scale(1.2)!important;z-index:6!important;}',
    'dra-hibadge.dra-resolved.dra-selected{background:#d3a0ad!important;}',

    // Fala jest osobnym elementem umieszczonym w środku znacznika, dzięki czemu
    // rozchodzi się równo z jego środka i nie jest zniekształcana przez
    // powiększenie samego znacznika.
    '@keyframes dra-wave{0%{transform:scale(.92);opacity:.7;}70%{transform:scale(2.1);opacity:.16;}100%{transform:scale(2.6);opacity:0;}}',
    'dra-halo{position:absolute!important;width:26px!important;height:26px!important;margin:-13px 0 0 -13px!important;',
    'border-radius:50%!important;border:2px solid #ee3a70!important;pointer-events:none!important;z-index:2!important;',
    'animation:dra-wave 1.6s ease-out infinite!important;}',
    'dra-halo.dra-resolved{border-color:#d3a0ad!important;}',
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
  /*  Kotwiczenie tekstu                                                   */
  /* --------------------------------------------------------------------- */

  function xpathOf(node) {
    var root = doc.documentElement;
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
    if (cur !== root) return null;
    return parts.length ? '/' + parts.join('/') : null;
  }

  // Cache odnalezionych elementów – XPath jest przeliczany przy każdym
  // przerysowaniu warstwy (m.in. przy przewijaniu i zmianie rozmiaru okna).
  var elementCache = {};

  function elementForXPath(path) {
    var cached = elementCache[path];
    if (cached && cached.isConnected) return cached;
    var el = resolveXPath(path);
    if (el) elementCache[path] = el;
    return el;
  }

  function nodeLength(node) {
    if (!node) return 0;
    if (node.nodeType === 3) return node.nodeValue.length;
    if (node.nodeType === 1) return node.childNodes.length;
    return 0;
  }

  function resolveXPath(path) {
    if (!path || path.charAt(0) !== '/') return null;
    var steps = path.slice(1).split('/');
    var node = doc.documentElement;
    for (var i = 0; i < steps.length; i++) {
      var m = /^([a-zA-Z0-9_:.-]+)\[(\d+)\]$/.exec(steps[i]);
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

  function buildRange(anchor) {
    if (!anchor) return null;
    try {
      var s = resolveXPath(anchor.startXPath);
      var e = anchor.endXPath === anchor.startXPath ? s : resolveXPath(anchor.endXPath);
      if (s && e) {
        var range = doc.createRange();
        range.setStart(s, Math.min(anchor.startOffset, nodeLength(s)));
        range.setEnd(e, Math.min(anchor.endOffset, nodeLength(e)));
        if (range.toString().trim()) return range;
      }
    } catch (err) { /* fallback poniżej */ }
    return findByText(anchor.text);
  }

  function rectsFor(anchor) {
    var range = buildRange(anchor);
    if (!range) return [];
    var raw = null;
    try { raw = range.getClientRects(); } catch (e) { raw = null; }
    var out = [];
    if (raw && raw.length) {
      for (var i = 0; i < raw.length; i++) {
        if (raw[i].width >= 0.5 && raw[i].height >= 0.5) out.push(raw[i]);
      }
    }
    if (!out.length) {
      var b = range.getBoundingClientRect();
      if (b && b.width >= 0.5 && b.height >= 0.5) out.push(b);
    }
    return out;
  }

  function serializeRange(range) {
    return {
      startXPath: xpathOf(range.startContainer),
      startOffset: range.startOffset,
      endXPath: xpathOf(range.endContainer),
      endOffset: range.endOffset,
      text: range.toString().replace(/\s+/g, ' ').trim().slice(0, 500),
    };
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
            return {
              xpath: path,
              fx: round5(Math.min(1, Math.max(0, (clientX - r.left) / r.width))),
              fy: round5(Math.min(1, Math.max(0, (clientY - r.top) / r.height))),
            };
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
   * w przeciwnym razie używane są zapisane współrzędne dokumentu.
   */
  function pinViewportPoint(anchor) {
    var t = anchor && anchor.target;
    if (t && t.xpath) {
      var el = elementForXPath(t.xpath);
      if (el && el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          var fx = typeof t.fx === 'number' ? t.fx : 0.5;
          var fy = typeof t.fy === 'number' ? t.fy : 0.5;
          return { x: r.left + fx * r.width, y: r.top + fy * r.height, anchored: true };
        }
      }
    }
    var off = scrollOffsets();
    return {
      x: (typeof anchor.x === 'number' ? anchor.x : 0) - off.x,
      y: (typeof anchor.y === 'number' ? anchor.y : 0) - off.y,
      anchored: false,
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
    var el = elementForXPath(t.xpath);
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
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

  function makePin(comment, label, x, y, pending) {
    var el = doc.createElement('dra-pin');
    el.className = 'dra-pin'
      + (comment.resolved ? ' dra-resolved' : '')
      + (pending ? ' dra-pending' : '')
      + (!pending && state.selectedId === comment.id ? ' dra-selected' : '');
    if (!pending) el.setAttribute('data-comment-id', comment.id);
    el.textContent = label == null ? '' : String(label);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    return el;
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

    if (pending || !rects.length) return null;
    var last = rects[rects.length - 1];
    var badge = doc.createElement('dra-hibadge');
    badge.className = 'dra-hibadge'
      + (comment.resolved ? ' dra-resolved' : '')
      + (state.selectedId === comment.id ? ' dra-selected' : '');
    badge.setAttribute('data-comment-id', comment.id);
    badge.textContent = String(num);
    badge.style.left = (last.right + 2) + 'px';
    badge.style.top = (last.top + last.height / 2) + 'px';
    hlLayer.appendChild(badge);
    return { x: last.right + 2, y: last.top + last.height / 2 };
  }

  /**
   * Fala wokół zaznaczonego znacznika. Rysowana jako osobny element w środku
   * znacznika – powiększenie znacznika (scale) nie wpływa na jej kształt.
   */
  function addHalo(x, y, resolved) {
    var halo = doc.createElement('dra-halo');
    halo.className = 'dra-halo' + (resolved ? ' dra-resolved' : '');
    halo.style.left = x + 'px';
    halo.style.top = y + 'px';
    hlLayer.appendChild(halo);
  }

  function clearLayers() {
    while (pinLayer.firstChild) pinLayer.removeChild(pinLayer.firstChild);
    while (hlLayer.firstChild) hlLayer.removeChild(hlLayer.firstChild);
  }

  function render() {
    if (!overlay || !overlay.parentNode) return;
    clearLayers();

    var missing = [];
    var haloPoint = null;

    for (var i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      if (!c || !c.anchor) continue;
      if (state.hiddenIds[c.id]) continue;
      if (c.type === 'pin') {
        var pt = pinViewportPoint(c.anchor);
        pinLayer.appendChild(makePin(c, i + 1, pt.x, pt.y, false));
        if (c.id === state.selectedId) haloPoint = { x: pt.x, y: pt.y, resolved: !!c.resolved };
      } else {
        var rects = rectsFor(c.anchor);
        if (!rects.length) { missing.push(c.id); continue; }
        var badgePoint = appendHighlight(c, rects, i + 1, false);
        if (c.id === state.selectedId && badgePoint) {
          haloPoint = { x: badgePoint.x, y: badgePoint.y, resolved: !!c.resolved };
        }
      }
    }

    if (haloPoint) addHalo(haloPoint.x, haloPoint.y, haloPoint.resolved);

    var p = state.pending;
    if (p) {
      if (p.kind === 'pin' && p.anchor) {
        var ppt = pinViewportPoint(p.anchor);
        pinLayer.appendChild(makePin({}, '✎', ppt.x, ppt.y, true));
      } else if (p.range) {
        var pr = null;
        try { pr = p.range.getClientRects(); } catch (e) { pr = null; }
        if (pr && pr.length) {
          var list = [];
          for (var k = 0; k < pr.length; k++) {
            if (pr[k].width >= 0.5 && pr[k].height >= 0.5) list.push(pr[k]);
          }
          appendHighlight({}, list, null, true);
        }
      }
    }

    drawSelectedOutline();

    var key = missing.join(',');
    if (key !== state.missingKey) {
      state.missingKey = key;
      post('missing', { ids: missing });
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

    if (c.type === 'pin') {
      var pt = pinViewportPoint(c.anchor);
      scrollToY(scrollOffsets().y + pt.y - win.innerHeight / 2);
      return;
    }
    var rects = rectsFor(c.anchor);
    if (!rects.length) return;
    scrollToY(scrollOffsets().y + rects[0].top - win.innerHeight / 3);
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
