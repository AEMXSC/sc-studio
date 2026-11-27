/*
 * SC Studio bridge: makes any web app (Next.js, React, Astro, plain HTML) editable in
 * SC Studio's page mode, the way Universal Editor's cors.js does for UE. A classic
 * script, not a module: Edge Delivery serves code without CORS headers.
 *
 * In the app:
 *   <meta name="sc:site" content="<org>/<site>">        the DA site the records live in
 *   <script src="https://main--sc-studio--aemxsc.aem.live/bridge.js" defer></script>
 * and the same markup as Universal Editor:
 *   data-content-path="/folder/record"                  an element rendered from one record
 *   data-aue-prop="<field>" data-aue-type="text|richtext|media" data-aue-label="…"
 * Optional, when the app's prop names differ from the record's fields:
 *   <script type="application/json" id="sc-bridge-config">{"props":{"appName":"field"}}</script>
 *
 * Inert unless SC Studio frames the page. Messages (all carry v: 1):
 *   app -> Studio  sc:ready (no data) · sc:page { site, url, records }
 *                  sc:select { path, field, label, kind, inline } · sc:edit { path, field, value }
 *   Studio -> app  sc:connect { edit } · sc:mode { edit } · sc:record { path, data }
 *                  sc:draft { path, data }  (also re-dispatched as a window "sc:draft" event)
 */
(() => {
  if (window.self === window.top || window.scBridge) return;
  window.scBridge = { v: 1 };

  const V = 1;
  const STUDIO = /^https:\/\/[a-z0-9-]+--sc-studio--aemxsc\.(preview\.da\.live|aem\.(page|live))$/;
  const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  // Studio served by `aem up` frames local apps only
  const allowed = (origin) => STUDIO.test(origin) || (LOCAL.test(window.location.origin) && LOCAL.test(origin));
  const INLINE = new Set(['text', 'richtext']);
  const EDIT_MS = 250;

  function readProps() {
    try {
      const props = JSON.parse(document.getElementById('sc-bridge-config')?.textContent || '{}').props ?? {};
      return Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === 'string'));
    } catch {
      return {};
    }
  }
  const props = readProps();

  let studio = null; // Studio's origin, once it has connected
  let edit = false;
  let selected = null; // { root, el, path, field }
  let editing = null; // { el, path, field, type, start, timer }
  let lastPage = '';
  // Edit-mode outlines, switched on and off with `media`: the bridge never sets attributes
  // on elements the app's framework owns (React would report a hydration mismatch).
  const style = document.createElement('style');
  // the selected element's name, above its top-left corner like Universal Editor's chip
  const chip = document.createElement('div');
  chip.className = 'sc-chip';
  let chipFor = null;
  const placeChip = () => {
    if (!chipFor?.isConnected) return chip.remove();
    const box = chipFor.getBoundingClientRect();
    chip.style.left = `${box.left + window.scrollX}px`;
    chip.style.top = `${Math.max(0, box.top + window.scrollY - 24)}px`;
    if (!chip.isConnected) document.body.append(chip);
    return undefined;
  };
  const chipSize = new ResizeObserver(placeChip);
  window.addEventListener('resize', placeChip);
  function showChip(target) {
    chipSize.disconnect();
    chipFor = target;
    if (!target) {
      chip.remove();
      return;
    }
    chip.textContent = target.dataset.aueLabel || target.dataset.aueProp || 'record';
    chipSize.observe(target);
    placeChip();
  }

  const recordOf = (el) => el?.closest('[data-content-path]') ?? null;
  const fieldOf = (el) => props[el.dataset.aueProp] ?? el.dataset.aueProp;
  const typeOf = (el) => el.dataset.aueType || 'text';
  const send = (type, payload = {}) => studio && window.parent.postMessage({ ...payload, v: V, type }, studio);

  function sendPage() {
    const roots = [...document.querySelectorAll('[data-content-path]')];
    const records = [...new Set(roots.map((el) => el.dataset.contentPath))];
    // a name per record for Studio's Publish list: its label, else its first heading, else
    // its first field with text (an image field has none), else all its text
    const labels = {};
    roots.forEach((el) => {
      const text = el.dataset.aueLabel
        || el.querySelector('h1, h2, h3, h4')?.textContent
        || [...el.querySelectorAll('[data-aue-prop]')].map((f) => f.textContent.trim()).find(Boolean)
        || el.textContent;
      labels[el.dataset.contentPath] ??= text.trim().replace(/\s+/g, ' ').slice(0, 80);
    });
    const site = document.querySelector('meta[name="sc:site"]')?.content ?? '';
    const page = JSON.stringify({
      site, url: window.location.href, records, labels,
    });
    if (page === lastPage) return;
    lastPage = page;
    send('sc:page', JSON.parse(page));
  }

  /** Long text as the app shows it: a paragraph per blank-line block, built as DOM (no HTML). */
  function paragraphs(el, text) {
    el.replaceChildren(...text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
      const node = document.createElement('p');
      p.split('\n').forEach((line, i) => node.append(...(i ? [document.createElement('br'), line] : [line])));
      return node;
    }));
  }

  function show(el, value) {
    const type = typeOf(el);
    if (type === 'media') {
      const src = typeof value === 'string' ? value : value?.src;
      if (typeof src === 'string' && src.startsWith('https://')) el.setAttribute('src', src);
    } else if (typeof value === 'string') {
      if (type === 'richtext') paragraphs(el, value);
      else el.textContent = value;
    }
  }

  const valueOf = (el, type) => (type === 'richtext' ? el.innerText : el.innerText.replace(/\s*\n\s*/g, ' '));

  function flushEdit() {
    if (!editing) return;
    clearTimeout(editing.timer);
    send('sc:edit', { path: editing.path, field: editing.field, value: valueOf(editing.el, editing.type) });
  }

  function stopEditing(revert = false) {
    if (!editing) return;
    const { el, start } = editing;
    if (revert) el.innerText = start;
    flushEdit();
    const value = valueOf(el, editing.type);
    editing = null;
    el.removeAttribute('contenteditable');
    el.classList.remove('sc-editing');
    show(el, value);
  }

  function onKey(e) {
    if (!editing || e.target !== editing.el) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopEditing(true);
    } else if (e.key === 'Enter' && editing.type === 'text') {
      e.preventDefault();
      stopEditing();
    }
  }

  function startEditing(el, path, field, raw) {
    const type = typeOf(el);
    const start = typeof raw === 'string' ? raw : el.innerText; // the stored value, e.g. with {{tokens}}
    el.innerText = start;
    el.setAttribute('contenteditable', 'plaintext-only');
    el.classList.add('sc-editing');
    editing = { el, path, field, type, start, timer: 0 };
    el.focus();
    window.getSelection()?.selectAllChildren(el);
    window.getSelection()?.collapseToEnd();
  }

  function select(root, el) {
    stopEditing();
    document.querySelectorAll('.sc-selected').forEach((n) => n.classList.remove('sc-selected'));
    const target = el ?? root;
    target.classList.add('sc-selected');
    showChip(target);
    selected = { root, el, path: root.dataset.contentPath, field: el ? fieldOf(el) : null };
    send('sc:select', {
      path: selected.path,
      field: selected.field,
      label: target.dataset.aueLabel ?? '',
      kind: el ? typeOf(el) : 'record', // not "type": that names the message
      inline: Boolean(el && INLINE.has(typeOf(el))),
    });
  }

  function onClick(e) {
    if (!edit) return;
    if (editing?.el.contains(e.target)) {
      e.preventDefault(); // place the caret, never follow a link
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const prop = e.target.closest?.('[data-aue-prop]');
    const root = recordOf(prop ?? e.target);
    if (!root) return;
    select(root, prop && recordOf(prop) === root ? prop : null);
  }

  function setMode(on) {
    edit = on;
    style.media = on ? 'all' : 'not all';
    if (on) return;
    stopEditing();
    document.querySelectorAll('.sc-selected').forEach((n) => n.classList.remove('sc-selected'));
    showChip(null);
    selected = null;
  }

  /** Studio loaded the selected record: edit the field in place with its stored value. */
  function onRecord({ path, data }) {
    const el = selected?.el;
    if (!el || selected.path !== path || !INLINE.has(typeOf(el)) || editing?.el === el || !data) return;
    startEditing(el, path, selected.field, data[selected.field]);
  }

  function onDraft({ path, data }) {
    if (typeof path !== 'string' || !data || typeof data !== 'object') return;
    document.querySelectorAll(`[data-content-path="${CSS.escape(path)}"]`).forEach((root) => {
      root.querySelectorAll('[data-aue-prop]').forEach((el) => {
        // this record's own fields only (not a nested record's), and not the one being typed in
        if (recordOf(el) !== root || el === editing?.el) return;
        const field = fieldOf(el);
        if (Object.hasOwn(data, field)) show(el, data[field]);
      });
    });
    window.dispatchEvent(new CustomEvent('sc:draft', { detail: { path, data } }));
  }

  function addStyles() {
    style.media = 'not all';
    style.textContent = `
      [data-content-path]:hover { outline: 1px dashed #3b63fb; outline-offset: 2px; }
      [data-content-path] [data-aue-prop]:hover { outline: 2px solid #3b63fb; outline-offset: 2px; cursor: pointer; }
      .sc-selected { outline: 2px solid #3b63fb; outline-offset: 2px; }
      .sc-editing { outline: 2px solid #3b63fb !important; outline-offset: 2px; background: rgb(59 99 251 / 8%); cursor: text !important; white-space: pre-wrap; }
      .sc-chip { position: absolute; z-index: 2147483647; padding: 0 8px; border-radius: 4px 4px 0 0;
        background: #3b63fb; color: #fff; font: 600 12px/22px system-ui, sans-serif; pointer-events: none; }`;
    document.head.append(style);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !allowed(e.origin) || e.data?.v !== V) return;
    const { type, ...msg } = e.data;
    if (type === 'sc:connect') {
      studio = e.origin;
      lastPage = '';
      setMode(msg.edit === true);
      sendPage();
      return;
    }
    if (e.origin !== studio) return;
    if (type === 'sc:mode') setMode(msg.edit === true);
    else if (type === 'sc:record') onRecord(msg);
    else if (type === 'sc:draft') onDraft(msg);
  });

  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('input', (e) => {
    if (!editing || e.target !== editing.el) return;
    clearTimeout(editing.timer);
    editing.timer = setTimeout(flushEdit, EDIT_MS);
  }, true);
  document.addEventListener('focusout', (e) => { if (editing && e.target === editing.el) stopEditing(); }, true);
  // a click in Studio (Undo, the form) leaves the app's frame: finish the inline edit
  window.addEventListener('blur', () => stopEditing());

  let pageTimer;
  new MutationObserver(() => {
    clearTimeout(pageTimer);
    pageTimer = setTimeout(sendPage, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  addStyles();
  window.parent.postMessage({ v: V, type: 'sc:ready' }, '*'); // carries no data
})();
