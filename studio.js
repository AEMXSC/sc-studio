/**
 * SC Studio (AEMXSC/sc-studio) — a DA app that puts the structured content
 * form next to a live preview of every channel that consumes it (kiosk,
 * website, phone). Same idea as AEM Content Fragment preview URLs, driven by
 * each site's own config, so one copy serves every site:
 *
 *   DA site config, sheet "previews" (one row per channel):
 *     schema  | label            | url                                          | device
 *     roast   | Kiosk · roast    | https://my-app.example/?tier={tier}&p={path} | kiosk
 *
 *   A site with no "previews" sheet gets the form only.
 *
 *   URL tokens: {tier} preview|live · {tld} page|live · {path} /folder/x
 *               {slug} x · {org} · {site}
 *   Devices: kiosk 1080×1920 · desktop 1280×800 · phone 390×844
 *
 * Authors use the form's own Send. This app watches the record and refreshes
 * the channel (and reindexes the path) when a preview or publish lands.
 */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

const FORM_APP = 'https://da.live/app/aemsites/sc-editor/form#';
const DA_ADMIN = 'https://admin.da.live';
const DA_SC = 'https://da-sc.adobeaem.workers.dev';
const SC_API = 'https://sc-api.adobeaem.workers.dev';
const DEVICES = {
  kiosk: { w: 1080, h: 1920 },
  desktop: { w: 1280, h: 800 },
  phone: { w: 390, h: 844 },
};

const $ = (id) => document.getElementById(id);
let ctx;
let channels = [];
let tier = 'preview';

/** DA gives the doc path in context; fall back to the URL hash. */
function resolveDoc(context) {
  const fromHash = window.location.hash.replace(/^#/, '');
  const full = context?.path && context.path.split('/').length > 3
    ? context.path : fromHash || context?.path || '';
  const [, org, site, ...rest] = full.replace(/\.html$/, '').split('/');
  return {
    org: org || context?.org, site: site || context?.repo, path: `/${rest.join('/')}`,
  };
}

function fill(template, doc, t) {
  const slug = doc.path.split('/').pop();
  return template
    .replaceAll('{tier}', t)
    .replaceAll('{tld}', t === 'live' ? 'live' : 'page')
    .replaceAll('{path}', doc.path)
    .replaceAll('{slug}', slug)
    .replaceAll('{org}', doc.org)
    .replaceAll('{site}', doc.site);
}

async function daJson(url, token, opts = {}) {
  const resp = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
  if (!resp.ok) throw Object.assign(new Error(`${resp.status} ${url}`), { status: resp.status });
  return resp;
}

/** Schema name from the record's da-form block (x-schema-name row). */
async function detectSchema(doc, token) {
  try {
    const resp = await daJson(`${DA_ADMIN}/source/${doc.org}/${doc.site}${doc.path}.html`, token);
    const html = await resp.text();
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const row = [...dom.querySelectorAll('.da-form > div')]
      .find((r) => r.firstElementChild?.textContent.trim() === 'x-schema-name');
    return row?.lastElementChild?.textContent.trim() || '';
  } catch {
    return '';
  }
}

/** The site's DA config (sheets "previews" and "data"), or {} when it has none. */
async function loadSiteConfig(doc, token) {
  try {
    const resp = await daJson(`${DA_ADMIN}/config/${doc.org}/${doc.site}`, token);
    return (await resp.json()) ?? {};
  } catch {
    return {};
  }
}

function channelsFor(config, schema) {
  const rows = config?.previews?.data ?? [];
  const all = rows.filter((r) => r.label && /^https:\/\//.test(r.url || '') && DEVICES[r.device]);
  const mine = all.filter((r) => !r.schema || !schema || r.schema === schema);
  return mine.length ? mine : all;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function fitDevice() {
  const ch = channels[$('channel').selectedIndex];
  if (!ch) return;
  const { w, h } = DEVICES[ch.device];
  const wrap = $('device-wrap').getBoundingClientRect();
  const scale = Math.min((wrap.width - 32) / w, (wrap.height - 32) / h, 1);
  const device = $('device');
  device.style.width = `${w}px`;
  device.style.height = `${h}px`;
  device.style.transform = `scale(${scale})`;
  device.dataset.device = ch.device;
}

function render() {
  const ch = channels[$('channel').selectedIndex];
  if (!ch) return;
  const src = fill(ch.url, ctx.doc, tier);
  $('open').href = src;
  // Cache-bust so a refresh after Send never shows a stale page.
  const url = new URL(src);
  url.searchParams.set('studio', Date.now().toString(36));
  $('preview-frame').src = url.href;
  fitDevice();
}

/* ---- Watch the record: when the form's Send lands, refresh the channel ----
 * Reads the record from da-sc for the tier on screen. On a change it reindexes
 * that path in the Structured Content API (so brand-new records also appear in
 * channel queries) and reloads the preview. No manual reload needed. */
const WATCH_MS = 4000;
const seen = { preview: undefined, live: undefined };

async function reindex(t) {
  const { doc, token } = ctx;
  const resp = await fetch(`${SC_API}/${t}/${doc.org}/${doc.site}/query.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [doc.path] }),
  });
  if (!resp.ok) throw new Error(`index ${resp.status}`);
}

async function watch() {
  const { doc } = ctx;
  const t = tier;
  try {
    const resp = await fetch(`${DA_SC}/${t}/${doc.org}/${doc.site}${doc.path}`, { cache: 'no-store' });
    const body = resp.ok ? await resp.text() : `missing:${resp.status}`;
    const before = seen[t];
    seen[t] = body;
    if (before === undefined || before === body) return;
    setStatus(`${t === 'live' ? 'Published' : 'Preview'} change detected, updating channel…`);
    await reindex(t).catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('channel preview: reindex failed, channel may lag', error);
    });
    render();
    setStatus(`Updated ${new Date().toLocaleTimeString()} · watching for changes`, 'ok');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('channel preview: watch failed', error);
  }
}

function wire() {
  $('channel').addEventListener('change', render);
  $('reload').addEventListener('click', render);
  document.querySelectorAll('[data-tier]').forEach((b) => b.addEventListener('click', () => {
    tier = b.dataset.tier;
    document.querySelectorAll('[data-tier]').forEach((x) => x.classList.toggle('on', x === b));
    render();
  }));
  new ResizeObserver(fitDevice).observe($('device-wrap'));
}

/* ---- Which structured content form to embed ----
 * The form moved from aemsites/sc-editor into da-live (adobe/da-live#1477), and
 * its asset picker (image and file fields from AEM Assets) lands there with
 * adobe/da-live#1520. Pick the form with ?form=<key>, or per site with the key
 * "sc-studio.form" in the site config's "data" sheet:
 *   headless  stock sc-editor form, hosted here with no second DA header (default)
 *   shell     the same form as a full da.live page
 *   dalive    the da-live form at da.live/form (gets the picker when #1520 ships)
 *   assets    da-live's scassets preview branch, to try the picker now
 * Only these fixed Adobe URLs can be embedded. */
const FORM_DIRECT = 'https://main--sc-editor--aemsites.aem.live/form.html#';
const FORM_ORIGIN = new URL(FORM_DIRECT).origin;
const FORM_SOURCES = {
  headless: { hosted: true, url: FORM_DIRECT },
  shell: { hosted: false, url: FORM_APP },
  dalive: { hosted: false, url: 'https://da.live/form#' },
  assets: { hosted: false, url: 'https://scassets--da-live--adobe.aem.page/form#' },
};
const DEFAULT_FORM = 'headless';

function formSourceKey(config) {
  const fromUrl = new URLSearchParams(window.location.search).get('form');
  const fromConfig = (config?.data?.data ?? []).find((r) => r.key === 'sc-studio.form')?.value?.trim();
  return [fromUrl, fromConfig].find((k) => k && Object.hasOwn(FORM_SOURCES, k)) || DEFAULT_FORM;
}

/* ---- Host the headless form ourselves (no second DA shell / header) ----
 * DA apps receive { ready, token, context } plus a MessagePort from their host.
 * We play that host for the embedded form, relaying our own SDK payload with
 * the document path. Child messages (title, hash) are ignored. The child
 * ignores repeat inits, so we retry a few times to beat its listener setup.
 * Full-page forms (shell, dalive, assets) sign in on their own. */

function hostForm(frame, payload) {
  const init = () => {
    const { port1, port2 } = new MessageChannel();
    port1.start();
    frame.contentWindow?.postMessage({ ...payload, ready: true }, FORM_ORIGIN, [port2]);
  };
  frame.addEventListener('load', () => [0, 300, 1000, 2500].forEach((ms) => setTimeout(init, ms)));
  // Forward IMS token refreshes from DA to the form.
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.data?.token) {
      frame.contentWindow?.postMessage({ token: e.data.token }, FORM_ORIGIN);
    }
  });
}

(async function init() {
  const sdk = await DA_SDK;
  const { context, token } = sdk;
  const doc = resolveDoc(context);
  ctx = { doc, token };
  wire();
  if (!doc.org || !doc.site || doc.path === '/') {
    setStatus('Open this app from a structured content document.', 'err');
    return;
  }
  const fullPath = `/${doc.org}/${doc.site}${doc.path}`;
  const frame = $('form-frame');
  const config = await loadSiteConfig(doc, token);
  const form = FORM_SOURCES[formSourceKey(config)];
  if (form.hosted) {
    const { actions, ...payload } = sdk;
    hostForm(frame, { ...payload, context: { ...context, path: fullPath } });
  }
  frame.src = `${form.url}${fullPath}`;
  const schema = await detectSchema(doc, token);
  channels = channelsFor(config, schema);
  $('channel').replaceChildren(...channels.map((c) => Object.assign(document.createElement('option'), { textContent: c.label })));
  if (!channels.length) {
    setStatus('No previews configured: add a "previews" sheet to this site\'s DA config (see the sc-studio README).', 'err');
    return;
  }
  setStatus(schema ? `Schema: ${schema} · watching for changes` : 'Schema not detected: showing all channels');
  render();
  watch();
  setInterval(watch, WATCH_MS);
}());
