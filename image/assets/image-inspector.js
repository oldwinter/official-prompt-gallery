(function imageInspectorModule(global, document) {
  'use strict';

  var MIN_ZOOM = 0.5;
  var MAX_ZOOM = 3;
  var ZOOM_STEP = 0.1;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function asArray(value) {
    return Array.prototype.slice.call(value || []);
  }

  function routeLabel(card) {
    var heading = card.querySelector('h4');
    return heading ? heading.textContent.trim() : (card.dataset.routeId || 'Image route');
  }

  function cardRecord(card) {
    var image = card.querySelector('[data-image]');
    var link = card.querySelector('.asset-link');
    return {
      card: card,
      caseId: card.dataset.caseId || '',
      routeId: card.dataset.routeId || '',
      label: routeLabel(card),
      source: image ? image.getAttribute('src') || '' : '',
      href: link ? link.getAttribute('href') || '' : '',
      alt: image ? image.getAttribute('alt') || '' : '',
      state: card.dataset.state || 'planned'
    };
  }

  function makeNoopController() {
    return {
      open: function () {},
      close: function () {},
      setProvider: function () {},
      setView: function () {},
      setZoom: function () {},
      dispose: function () {}
    };
  }

  /**
   * Enhance ordinary image links with a native dialog and keyboard controls.
   * The links and case articles remain usable when this function cannot run.
   */
  function attachImageInspector(root, dialog) {
    if (!root || !dialog || typeof dialog.querySelector !== 'function') {
      return makeNoopController();
    }

    var cards = asArray(root.querySelectorAll('[data-inspect]')).map(function (button) {
      var card = button.closest('[data-route-id]');
      return card ? { button: button, record: cardRecord(card) } : null;
    }).filter(Boolean);

    var stage = dialog.querySelector('[data-inspector-stage]');
    var inspectorImage = dialog.querySelector('[data-inspector-image]');
    var inspectorLink = dialog.querySelector('[data-inspector-link]');
    var providerSwitch = dialog.querySelector('[data-provider-switch]');
    var context = dialog.querySelector('[data-inspector-context]');
    var status = dialog.querySelector('[data-inspector-status]');
    var zoomInput = dialog.querySelector('[data-zoom]');
    var zoomOutput = dialog.querySelector('[data-zoom-output]');
    var viewInputs = asArray(dialog.querySelectorAll('[data-view-mode]'));
    var closeButton = dialog.querySelector('[data-dialog-close]');

    if (!stage || !inspectorImage || !inspectorLink || !providerSwitch || !zoomInput) {
      return makeNoopController();
    }

    var activeRecord = null;
    var providers = [];
    var providerIndex = 0;
    var opener = null;
    var zoom = 1;
    var view = 'fit';
    var restoringFocus = false;
    var listeners = [];

    function listen(target, eventName, handler, options) {
      target.addEventListener(eventName, handler, options);
      listeners.push(function () { target.removeEventListener(eventName, handler, options); });
    }

    function announce(message) {
      if (status) status.textContent = message;
    }

    function updateZoomText() {
      var percentage = Math.round(zoom * 100);
      zoomInput.value = String(zoom);
      zoomInput.setAttribute('aria-valuenow', String(zoom));
      zoomInput.setAttribute('aria-valuetext', percentage + ' percent');
      if (zoomOutput) zoomOutput.textContent = percentage + '%';
      inspectorImage.style.transform = 'scale(' + zoom + ')';
    }

    function updateView() {
      stage.dataset.view = view;
      viewInputs.forEach(function (input) {
        input.checked = input.value === view;
      });
      updateZoomText();
    }

    function providerButton(index, record) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'provider-choice';
      button.dataset.providerIndex = String(index);
      button.setAttribute('aria-pressed', index === providerIndex ? 'true' : 'false');
      button.textContent = record.label;
      if (index === providerIndex) button.classList.add('is-active');
      return button;
    }

    function renderProviderButtons() {
      providerSwitch.textContent = '';
      providers.forEach(function (record, index) {
        var button = providerButton(index, record);
        button.addEventListener('click', function () {
          setProvider(index);
        });
        providerSwitch.appendChild(button);
      });
    }

    function renderProvider() {
      if (!providers.length) return;
      activeRecord = providers[providerIndex];
      inspectorImage.src = activeRecord.source;
      inspectorImage.alt = activeRecord.alt;
      inspectorLink.href = activeRecord.href || activeRecord.source || '#';
      inspectorLink.setAttribute('aria-label', 'Open full-size ' + activeRecord.label + ' image');
      if (context) context.textContent = activeRecord.label + ' / ' + (activeRecord.state === 'generated' ? 'admitted output' : 'planned cell');
      renderProviderButtons();
      updateView();
      if (activeRecord.state === 'planned') {
        announce(activeRecord.label + '. This cell is planned; no admitted public bytes are available yet.');
      } else {
        announce(activeRecord.label + '. ' + (view === 'fit' ? 'Fit view.' : 'Actual-pixel view.') + ' Zoom ' + Math.round(zoom * 100) + ' percent.');
      }
    }

    function setProvider(index) {
      if (!providers.length) return;
      providerIndex = (index + providers.length) % providers.length;
      renderProvider();
      var selected = providerSwitch.querySelector('[data-provider-index="' + providerIndex + '"]');
      if (selected && typeof selected.focus === 'function') selected.focus();
    }

    function setView(nextView) {
      view = nextView === 'actual' ? 'actual' : 'fit';
      updateView();
      if (activeRecord) announce(activeRecord.label + '. ' + (view === 'fit' ? 'Fit view.' : 'Actual-pixel view.') + ' Zoom ' + Math.round(zoom * 100) + ' percent.');
    }

    function setZoom(nextZoom) {
      var numeric = Number(nextZoom);
      if (!Number.isFinite(numeric)) return;
      zoom = Math.round(clamp(numeric, MIN_ZOOM, MAX_ZOOM) * 10) / 10;
      updateZoomText();
      if (activeRecord) announce(activeRecord.label + '. ' + (view === 'fit' ? 'Fit view.' : 'Actual-pixel view.') + ' Zoom ' + Math.round(zoom * 100) + ' percent.');
    }

    function open(record, trigger) {
      activeRecord = record;
      opener = trigger || null;
      providers = cards.map(function (entry) { return entry.record; }).filter(function (candidate) {
        return candidate.caseId === record.caseId;
      });
      providerIndex = Math.max(0, providers.findIndex(function (candidate) { return candidate.routeId === record.routeId; }));
      zoom = 1;
      view = 'fit';
      renderProvider();
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
        dialog.classList.add('dialog-fallback-open');
      }
      if (providerSwitch) {
        var selected = providerSwitch.querySelector('[data-provider-index="' + providerIndex + '"]');
        if (selected) selected.focus();
      }
    }

    function restoreFocus() {
      if (restoringFocus) return;
      restoringFocus = true;
      var target = opener;
      opener = null;
      if (target && typeof target.focus === 'function') target.focus();
      restoringFocus = false;
    }

    function close() {
      if (typeof dialog.close === 'function' && dialog.open) {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
        dialog.classList.remove('dialog-fallback-open');
        restoreFocus();
      }
    }

    function onDialogCancel(event) {
      event.preventDefault();
      close();
    }

    function onDialogClose() {
      dialog.classList.remove('dialog-fallback-open');
      restoreFocus();
    }

    function onDialogKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) {
        return;
      } else if (event.key === 'ArrowLeft' && providers.length > 1) {
        event.preventDefault();
        setProvider(providerIndex - 1);
      } else if (event.key === 'ArrowRight' && providers.length > 1) {
        event.preventDefault();
        setProvider(providerIndex + 1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom(zoom + ZOOM_STEP);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom(zoom - ZOOM_STEP);
      } else if (event.key === '0') {
        event.preventDefault();
        setZoom(1);
      }
    }

    cards.forEach(function (entry) {
      listen(entry.button, 'click', function (event) {
        event.preventDefault();
        open(entry.record, entry.button);
      });
    });
    viewInputs.forEach(function (input) {
      listen(input, 'change', function () { setView(input.value); });
    });
    listen(zoomInput, 'input', function () { setZoom(zoomInput.value); });
    listen(dialog, 'cancel', onDialogCancel);
    listen(dialog, 'close', onDialogClose);
    listen(dialog, 'keydown', onDialogKeydown);
    if (closeButton) listen(closeButton, 'click', function () { close(); });
    listen(inspectorImage, 'error', function () {
      if (activeRecord && activeRecord.state === 'planned') {
        announce(activeRecord.label + '. This cell is planned; no admitted public bytes are available yet.');
      } else {
        announce('The admitted image could not be loaded. Use the ordinary image link to retry.');
      }
    });
    listen(inspectorImage, 'load', function () {
      if (activeRecord && activeRecord.state === 'generated') {
        announce(activeRecord.label + '. ' + inspectorImage.naturalWidth + ' × ' + inspectorImage.naturalHeight + ' pixels. ' + (view === 'fit' ? 'Fit view.' : 'Actual-pixel view.') + ' Zoom ' + Math.round(zoom * 100) + ' percent.');
      }
    });

    // Activate tabs only after the controller is ready; without JavaScript both articles stay readable.
    var tabs = asArray(root.querySelectorAll('[data-case-tabs] [role="tab"]'));
    var panels = asArray(root.querySelectorAll('.prompt-case[data-case-id]'));
    var panelIds = panels.map(function (panel) { return panel.dataset.caseId; });

    function activateCase(caseId, moveFocus) {
      var selectedId = panelIds.indexOf(caseId) >= 0 ? caseId : panelIds[0];
      tabs.forEach(function (tab) {
        var selected = tab.getAttribute('aria-controls') === 'case-' + selectedId;
        tab.classList.toggle('is-active', selected);
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
        if (selected && moveFocus) tab.focus();
      });
      panels.forEach(function (panel) {
        var selected = panel.dataset.caseId === selectedId;
        panel.classList.toggle('is-active', selected);
        panel.hidden = !selected;
        panel.setAttribute('aria-hidden', selected ? 'false' : 'true');
      });
      if (global.history && typeof global.history.replaceState === 'function') {
        global.history.replaceState(null, '', '#case-' + selectedId);
      }
    }

    tabs.forEach(function (tab, index) {
      listen(tab, 'click', function (event) {
        event.preventDefault();
        activateCase(tab.getAttribute('aria-controls').replace(/^case-/, ''), false);
      });
      listen(tab, 'keydown', function (event) {
        var targetIndex = index;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') targetIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') targetIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') targetIndex = 0;
        if (event.key === 'End') targetIndex = tabs.length - 1;
        if (targetIndex !== index || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (targetIndex !== index) activateCase(tabs[targetIndex].getAttribute('aria-controls').replace(/^case-/, ''), true);
          else activateCase(tab.getAttribute('aria-controls').replace(/^case-/, ''), true);
        }
      });
    });

    var hashCase = (global.location.hash || '').replace(/^#case-/, '');
    activateCase(panelIds.indexOf(hashCase) >= 0 ? hashCase : panelIds[0], false);
    document.body.classList.add('has-image-inspector');

    return {
      open: open,
      close: close,
      setProvider: setProvider,
      setView: setView,
      setZoom: setZoom,
      dispose: function () {
        listeners.splice(0).forEach(function (remove) { remove(); });
        document.body.classList.remove('has-image-inspector');
      }
    };
  }

  global.attachImageInspector = attachImageInspector;

  function boot() {
    var dialog = document.getElementById('image-inspector');
    if (dialog) attachImageInspector(document, dialog);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}(window, document));
