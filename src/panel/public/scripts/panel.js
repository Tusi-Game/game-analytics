/*
 * panel.js (T-11.10/29/31) — vanilla client glue for the SSR panel. No build
 * step; served as-is from /scripts/panel.js. Depends on the self-hosted vendored
 * Chart.js (window.Chart) + HTMX + Alpine (all loaded before this file). No CDN,
 * no network fetch (P4 / sanctions).
 *
 * Responsibilities:
 *   - initialise every <canvas data-chart-config='...'> as a Chart.js chart, on
 *     first page load AND after every HTMX swap (so lazily-loaded chart fragments
 *     and SPA-nav content both render);
 *   - apply the panel's chart-design-system defaults;
 *   - clipboard-copy helper (credential/key copy buttons).
 */
(function () {
  'use strict';

  // ---- Chart.js design-system defaults (design §2.3) ----------------------
  function applyChartDefaults() {
    if (!window.Chart) {
      return;
    }
    var C = window.Chart;
    C.defaults.font.family =
      'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    C.defaults.responsive = true;
    C.defaults.maintainAspectRatio = false;
    C.defaults.plugins.legend.labels.boxWidth = 12;
    C.defaults.plugins.legend.labels.usePointStyle = true;
  }

  // Track initialised canvases so a re-run (after an HTMX swap that did NOT
  // replace a given canvas) does not double-init and leak Chart instances.
  function initCharts(root) {
    if (!window.Chart) {
      return;
    }
    var scope = root || document;
    var canvases = scope.querySelectorAll('canvas[data-chart-config]');
    for (var i = 0; i < canvases.length; i++) {
      var canvas = canvases[i];
      if (canvas.__chartInited) {
        continue;
      }
      var raw = canvas.getAttribute('data-chart-config');
      if (!raw) {
        continue;
      }
      var config;
      try {
        config = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      try {
        // eslint-disable-next-line no-new
        new window.Chart(canvas, config);
        canvas.__chartInited = true;
      } catch (e) {
        /* leave the canvas uninitialised on a malformed config */
      }
    }
  }

  // ---- Clipboard copy (credential/key/manual-MFA-key copy buttons) --------
  function wireClipboard(root) {
    var scope = root || document;
    var buttons = scope.querySelectorAll('[data-copy]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.__copyWired) {
        continue;
      }
      btn.__copyWired = true;
      btn.addEventListener('click', function (ev) {
        var el = ev.currentTarget;
        var text = el.getAttribute('data-copy') || '';
        var done = function () {
          var prev = el.getAttribute('data-copy-label') || el.textContent;
          el.setAttribute('data-copied', '1');
          el.textContent = 'Copied';
          setTimeout(function () {
            el.removeAttribute('data-copied');
            el.textContent = prev;
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {});
        }
      });
    }
  }

  function onReady(root) {
    initCharts(root);
    wireClipboard(root);
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyChartDefaults();
    onReady(document);
  });

  // Re-init after every HTMX content swap (SPA nav + lazy chart fragments).
  document.body &&
    document.body.addEventListener('htmx:afterSwap', function (ev) {
      applyChartDefaults();
      onReady(ev.target || document);
    });
})();
