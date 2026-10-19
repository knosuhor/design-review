'use strict';

/**
 * Wspólne okno potwierdzenia w stylu aplikacji (zamiast natywnego confirm()).
 *
 *   const ok = await drConfirm({
 *     title: 'Usunąć stronę?',
 *     message: 'Tej operacji nie można cofnąć.',
 *     confirmText: 'Usuń stronę',
 *     cancelText: 'Anuluj',      // opcjonalne
 *     danger: true,              // czerwony przycisk akcji
 *   });
 *
 * Okno tworzone jest przy pierwszym użyciu i współdzielone przez całą stronę.
 */
(function () {
  let dialogEl = null;
  let finish = null;
  let lastFocus = null;

  function build() {
    dialogEl = document.createElement('dialog');
    dialogEl.className = 'dialog confirm-dialog';
    dialogEl.innerHTML =
      '<h3 data-role="title"></h3>' +
      '<p class="muted" data-role="message"></p>' +
      '<div class="dialog-actions">' +
      '  <span class="spacer"></span>' +
      '  <button class="btn ghost" type="button" data-act="cancel">Anuluj</button>' +
      '  <button class="btn primary" type="button" data-act="ok">Potwierdź</button>' +
      '</div>';
    document.body.appendChild(dialogEl);

    dialogEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        close(btn.getAttribute('data-act') === 'ok');
        return;
      }
      if (e.target !== dialogEl) return;
      const r = dialogEl.getBoundingClientRect();
      const outside =
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (outside) close(false);
    });

    // Esc – anulowanie (domyślne zachowanie <dialog> też zamyka, ale bez wyniku).
    dialogEl.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });

    return dialogEl;
  }

  function close(result) {
    if (!finish) return;
    const resolve = finish;
    finish = null;
    if (dialogEl && dialogEl.open) dialogEl.close();
    resolve(result);
    if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
    lastFocus = null;
  }

  window.drConfirm = function (options) {
    const opts = options || {};
    const el = dialogEl || build();

    el.querySelector('[data-role="title"]').textContent = opts.title || 'Potwierdź';
    el.querySelector('[data-role="message"]').textContent = opts.message || '';
    el.querySelector('[data-act="cancel"]').textContent = opts.cancelText || 'Anuluj';

    const okBtn = el.querySelector('[data-act="ok"]');
    okBtn.textContent = opts.confirmText || 'Potwierdź';
    okBtn.className = 'btn ' + (opts.danger ? 'solid-danger' : 'primary');

    lastFocus = document.activeElement;

    return new Promise((resolve) => {
      finish = resolve;
      if (el.open) el.close();
      el.showModal();
      // Przy akcji niszczącej bezpieczniej zaczynać od „Anuluj”.
      (opts.danger ? el.querySelector('[data-act="cancel"]') : okBtn).focus();
    });
  };
})();
