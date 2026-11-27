/*
 * Page mode: open any app by its URL, click what you want to change, edit it in place
 * or in the form, and the app shows it as you type, like Universal Editor for
 * structured content. The app adds bridge.js (see its header for the markup); Studio
 * learns the app's DA site from the bridge and opens each clicked record in the live
 * form. Only apps listed in that site's "channels" sheet (or on localhost) can edit.
 */
import { startLiveForm } from './live.js';
import { imageCards, repositoryConfig } from './assets.js';
import wirePublish from './publish.js';

const $ = (id) => document.getElementById(id);
const V = 1;
const LAST_APP = 'sc-studio.app';
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;
const SITE = /^([a-z0-9-]+)\/([a-z0-9-]+)$/i;
const FIELD = /^[A-Za-z_][\w-]*$/;
const DRAFT_MS = 250;

/** Origins of a site's channel URLs, with the URL tokens filled in. */
function channelOrigins(config, org, site) {
  const rows = (config?.channels ?? config?.previews)?.data ?? [];
  return rows.flatMap((r) => ['page', 'live'].map((tld) => String(r.url ?? '')
    .replaceAll('{org}', org).replaceAll('{site}', site).replaceAll('{tld}', tld)
    .replace(/\{[a-z]+\}/g, 'x')))
    .map((url) => { try { return new URL(url).origin; } catch { return null; } })
    .filter(Boolean);
}

/**
 * An http(s) app URL, opened on the preview tier (drafts and previewed records). A bare
 * host gets a scheme, as in Universal Editor: http for localhost, https otherwise.
 */
function appUrl(input) {
  const text = input.trim();
  const local = LOCAL_HOST.test(text.split(/[:/]/)[0]);
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${local ? 'http' : 'https'}://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(LOCAL_HOST.test(url.hostname) && url.protocol === 'http:')) return null;
  if (!url.searchParams.has('tier')) url.searchParams.set('tier', 'preview');
  return url;
}

/** The location at rest: host and path, no scheme (as Universal Editor shows it). */
function restingAddress(href) {
  try {
    const url = new URL(href);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

function remember(value) {
  try {
    if (value === undefined) return window.localStorage.getItem(LAST_APP) ?? '';
    window.localStorage.setItem(LAST_APP, value);
  } catch {
    // storage blocked: the address bar just starts empty
  }
  return '';
}

export default function startPageMode({ sdk, daFetch, loadSiteConfig }) {
  const frame = $('preview-frame');
  const state = {
    origin: '', org: '', site: '', allowed: false, check: null, edit: true, live: null, path: '', opening: Promise.resolve(), records: [],
  };
  let draftTimer;

  const setStatus = (text, kind = '') => Object.assign($('status'), { textContent: text, className: `status ${kind}` });
  const post = (type, payload = {}) => state.origin
    && frame.contentWindow?.postMessage({ ...payload, v: V, type }, state.origin);
  const els = {
    form: $('live-form'), status: $('live-status'), preview: $('live-preview'), publish: $('live-publish'),
  };

  function open(input) {
    const url = appUrl(input);
    if (!url) {
      setStatus('Enter the app\'s address, e.g. my-app.vercel.app or localhost:3001', 'err');
      return;
    }
    Object.assign(state, {
      origin: url.origin, org: '', site: '', allowed: false, check: null,
    });
    $('open-app').href = url.href;
    frame.src = url.href;
    showLocation(url.href);
    remember(state.href);
    setStatus('Opening the app…');
  }

  /** The app told us which DA site it reads: only listed apps (or localhost) may edit. */
  async function onPage({
    site, records, labels, url,
  }) {
    showLocation(url);
    // the records on the page, named as the app shows them (for Publish)
    state.records = (Array.isArray(records) ? records : [])
      .filter((path) => typeof path === 'string' && path.startsWith('/'))
      .map((path) => ({ path, label: (typeof labels?.[path] === 'string' && labels[path]) || path.split('/').pop() }));
    const [, org, name] = SITE.exec(site ?? '') ?? [];
    if (!org) {
      setStatus('This app doesn\'t say which DA site it reads. Add <meta name="sc:site" content="org/site"> (see the README).', 'err');
      return;
    }
    if (org !== state.org || name !== state.site || !state.check) {
      Object.assign(state, { org, site: name, allowed: false });
      // one check per site, shared by the page reports that arrive while it runs
      state.check = Promise.all([
        loadSiteConfig({ org, site: name }, sdk.token),
        loadSiteConfig({ org, site: '' }, sdk.token), // the org config, where EW also looks for AEM Assets
      ]).then(([config, orgConfig]) => {
        state.repo = repositoryConfig(config, orgConfig);
        return LOCAL_HOST.test(new URL(state.origin).hostname) || channelOrigins(config, org, name).includes(state.origin);
      });
    }
    state.allowed = await state.check;
    if (!state.allowed) {
      setStatus(`This app isn't listed in ${org}/${name}'s channels, so it can't be edited here. Add it to the site's "channels" sheet.`, 'err');
      return;
    }
    const count = records?.length ?? 0;
    $('address').title = `${org}/${name} · ${count} ${count === 1 ? 'record' : 'records'} on this page`;
    setStatus(`${org}/${name} · ${count} ${count === 1 ? 'record' : 'records'} on this page · ${state.edit ? 'click anything to edit it' : 'previewing'}`, 'ok');
  }

  /** Like Universal Editor's location: the address follows the app as you navigate in it. */
  function showLocation(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (url.origin !== state.origin) return;
    $('open-app').href = url.href;
    url.searchParams.delete('tier'); // Studio adds it; the author never typed it
    state.href = url.href;
    if (document.activeElement !== $('app-url')) $('app-url').value = restingAddress(url.href);
  }

  function sendDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => state.live && post('sc:draft', { path: state.path, data: state.live.draft() }), DRAFT_MS);
  }

  function showHistory() {
    $('undo').disabled = !state.live?.canUndo();
    $('redo').disabled = !state.live?.canRedo();
  }

  /** Point at the field in the form; focus it when the app can't edit it in place. */
  function showField(field, inline) {
    document.querySelectorAll('.field.is-target').forEach((f) => f.classList.remove('is-target'));
    const input = field && els.form.querySelector(`[data-pointer="${CSS.escape(`/data/${field}`)}"]`);
    if (!input) return;
    input.closest('.field')?.classList.add('is-target');
    input.scrollIntoView({ block: 'nearest' });
    if (!inline) input.focus();
  }

  async function openRecord(path) {
    if (state.path === path && state.live) return;
    await state.live?.close();
    Object.assign(state, { live: null, path });
    // the previous record's form is no longer connected: never leave it on screen
    els.form.replaceChildren();
    showHistory(); // history is per record
    $('edit-schema').hidden = true;
    $('live').hidden = false;
    $('live').classList.remove('empty');
    Object.assign($('record-label'), { textContent: path.split('/').pop(), title: path, hidden: false });
    try {
      state.live = await startLiveForm({
        doc: { org: state.org, site: state.site, path },
        daFetch,
        token: sdk.token,
        els,
        onDraft: sendDraft,
        onPublished: () => {},
        onHistory: showHistory,
        decorate: (form, setField) => imageCards(form, {
          setField,
          repoConfig: state.repo,
          token: sdk.token,
          status: (text) => { els.status.textContent = text; },
          doc: { org: state.org, site: state.site, path },
          daFetch,
        }),
      });
      showHistory();
      if (state.live.title) $('record-label').textContent = state.live.title;
      const schemaPath = `/${state.org}/${state.site}/.da/forms/schemas/${encodeURIComponent(state.live.schemaName)}.html`;
      Object.assign($('edit-schema'), { href: `https://da.live/app/aemsites/sc-editor/schemas#${schemaPath}`, hidden: false });
    } catch (error) {
      els.status.textContent = error.message;
      state.path = '';
    }
  }

  /** The rail's second line, as in Universal Editor: the selected field with its type. */
  function showSelection(label, kind) {
    const icons = { text: 'T', richtext: '¶', media: '▣' };
    $('field-icon').textContent = icons[kind] ?? '▤';
    $('field-name').textContent = typeof label === 'string' && label ? label : 'Whole record';
    $('record-field').hidden = false;
  }

  function onSelect({
    path, field, label, inline, kind,
  }) {
    if (!state.allowed || typeof path !== 'string' || !path.startsWith('/')) return;
    const name = typeof field === 'string' && FIELD.test(field) ? field : null;
    showSelection(label, name ? kind : 'record');
    // one record at a time: a second click waits for the first record to open
    state.opening = state.opening.then(async () => {
      await openRecord(path);
      if (state.path !== path || !state.live) return;
      showField(name, inline === true);
      post('sc:record', { path, data: state.live.draft() });
    });
  }

  function onEdit({ path, field, value }) {
    if (!state.allowed || !state.live || path !== state.path) return;
    if (typeof field !== 'string' || !FIELD.test(field) || typeof value !== 'string') return;
    const pointer = `/data/${field}`;
    try {
      state.live.setField(pointer, value);
    } catch {
      els.status.textContent = `"${field}" isn't a field of this record's schema, so the change wasn't kept.`;
      return;
    }
    const input = els.form.querySelector(`[data-pointer="${CSS.escape(pointer)}"]`);
    if (input && document.activeElement !== input) input.value = value;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== state.origin || e.data?.v !== V) return;
    const { type, ...msg } = e.data;
    if (type === 'sc:ready') post('sc:connect', { edit: state.edit });
    else if (type === 'sc:page') onPage(msg).catch((error) => setStatus(`Couldn't check the app: ${error.message}`, 'err'));
    else if (type === 'sc:select') onSelect(msg);
    else if (type === 'sc:edit') onEdit(msg);
  });

  /** The header and rail menus, laid out like Universal Editor's. */
  function wireChrome() {
    document.body.classList.add('page-mode');
    ['channel', 'tier'].forEach((id) => { $(id).hidden = true; });
    $('address').hidden = false;
    $('address').after($('status'));
    // Publish works on every record on the page, as in Universal Editor (publish.js)
    wirePublish({
      page: () => ({ org: state.org, site: state.site, records: state.allowed ? state.records : [] }),
      daFetch,
      token: sdk.token,
      beforePublish: async () => {
        if (!state.live) return [];
        await state.live.saved();
        return state.live.errors() ? [state.path] : [];
      },
      afterPublish: () => state.live?.refresh(),
    });
    $('record-menu').append($('edit-schema'));
    $('edit-schema').className = '';
    document.querySelectorAll('.menu').forEach((menu) => menu.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) menu.hidePopover();
    }));

    const pickApp = () => {
      $('app-url').focus();
      $('app-url').select();
    };
    $('undo').addEventListener('click', () => state.live?.undo());
    $('redo').addEventListener('click', () => state.live?.redo());
    // Ctrl/⌘+Z outside text fields (inside one, the browser's own undo applies)
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) state.live?.undo();
      else if ((key === 'z' && e.shiftKey) || key === 'y') state.live?.redo();
      else return;
      e.preventDefault();
    });
    $('change-app').addEventListener('click', pickApp);
    $('reload-app').addEventListener('click', () => { if (state.origin) frame.src = $('open-app').href; });
    // two states, as in Universal Editor: at rest the host and path; on click a box with
    // the scheme as its own segment and the rest of the address selected
    $('app-url').addEventListener('focus', () => {
      if (!state.href) return;
      const url = new URL(state.href);
      $('app-scheme').textContent = url.protocol.slice(0, -1);
      $('app-url').value = `${url.host}${url.pathname}${url.search}`;
      $('app-url').select();
    });
    // the scheme segment follows what's typed: localhost is http, other hosts keep theirs
    $('app-url').addEventListener('input', () => {
      const typed = $('app-url').value.trim();
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) return;
      const current = state.href ? new URL(state.href).protocol.slice(0, -1) : 'https';
      $('app-scheme').textContent = LOCAL_HOST.test(typed.split(/[:/]/)[0]) ? 'http' : current.replace(/^http$/, 'https');
    });
    $('app-url').addEventListener('blur', () => {
      if (state.href) $('app-url').value = restingAddress(state.href);
    });
    $('address').addEventListener('submit', (e) => {
      e.preventDefault();
      const typed = $('app-url').value.trim();
      // the scheme segment counts unless the author typed one (localhost is always http)
      const own = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) || LOCAL_HOST.test(typed.split(/[:/]/)[0]);
      open(own || !state.href ? typed : `${$('app-scheme').textContent}://${typed}`);
      $('app-url').blur();
    });
    document.querySelectorAll('#device-menu [data-size]').forEach((b) => b.addEventListener('click', () => {
      $('device').dataset.size = b.dataset.size;
      document.querySelectorAll('#device-menu [data-size]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      state.edit = b.dataset.mode === 'edit';
      document.body.classList.toggle('previewing', !state.edit); // like UE: the rail hides, the app fills
      document.querySelectorAll('[data-mode]').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      post('sc:mode', { edit: state.edit });
      if (state.allowed) setStatus(state.edit ? 'Click anything in the app to edit it' : 'Previewing: links and buttons work', 'ok');
    }));
  }

  wireChrome();
  $('live').hidden = false;
  $('live').classList.add('empty'); // until something in the app is selected

  const start = new URLSearchParams(window.location.search).get('app') || remember();
  $('app-url').value = restingAddress(start);
  // reopen the last app (or ?app=): an address on screen with an empty canvas reads as broken
  if (start) open(start);
  else $('app-url').focus();
}
