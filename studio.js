/**
 * SC Studio (AEMXSC/sc-studio) — a DA app that puts the structured content
 * form next to a live preview of every channel that consumes it (kiosk,
 * website, phone). Same idea as AEM Content Fragment preview URLs, driven by
 * each site's own config, so one copy serves every site:
 *
 *   DA site config, sheet "channels" (or "previews"), one row per channel:
 *     schema  | label            | url                                          | device
 *     roast   | Kiosk · roast    | https://my-app.example/?tier={tier}&p={path} | kiosk
 *
 *   A site with neither sheet gets the form only.
 *
 *   URL tokens: {tier} preview|live · {tld} page|live · {path} /folder/x
 *               {slug} x · {org} · {site}
 *   Devices: phone · tablet · desktop · kiosk · car (empty = phone)
 *
 * The stock form is embedded by default. The opt-in "live" form (?form=live, or
 * sc-studio.form = live in the site config) is drawn here on DA's structured content
 * SDK: it autosaves, has Preview and Publish, and sends the draft to the channel as
 * you type (see "Live drafts" below).
 * Either way, Studio watches the record and refreshes the channel (and reindexes the
 * path) when a preview or publish lands.
 */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { startLiveForm } from './live.js';
import startPageMode from './page.js';

const FORM_APP = 'https://da.live/app/aemsites/sc-editor/form#';
const DA_ADMIN = 'https://admin.da.live';
const DA_SC = 'https://da-sc.adobeaem.workers.dev';
const SC_API = 'https://sc-api.adobeaem.workers.dev';
const DEVICES = {
  phone: { w: 390, h: 844 },
  tablet: { w: 820, h: 1180 },
  desktop: { w: 1280, h: 800 },
  kiosk: { w: 1080, h: 1920 },
  car: { w: 1280, h: 480 },
};
// Studio served by `aem up` (?ref=local): http://localhost channels are allowed too.
const LOCAL = window.location.hostname === 'localhost';

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

/** The site's DA config (sheets "channels"/"previews" and "data"), or {} when it has none. */
async function loadSiteConfig(doc, token) {
  try {
    const resp = await daJson(`${DA_ADMIN}/config/${doc.org}/${doc.site}`, token);
    return (await resp.json()) ?? {};
  } catch {
    return {};
  }
}

/** https, or http://localhost while Studio itself runs locally. */
function allowedUrl(url) {
  return /^https:\/\//.test(url || '') || (LOCAL && /^http:\/\/localhost[:/]/.test(url || ''));
}

/** Channel rows: the "channels" sheet (as Frescopa Studio names it), else "previews". */
function channelsFor(config, schema) {
  const rows = (config?.channels ?? config?.previews)?.data ?? [];
  const all = rows
    .map((r) => ({ ...r, device: (r.device || 'phone').trim().toLowerCase() }))
    .filter((r) => r.label && allowedUrl(r.url) && DEVICES[r.device])
    // while developing, local apps first: they have your code changes
    .sort((a, b) => Number(/^http:/.test(b.url)) - Number(/^http:/.test(a.url)));
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
  const { device } = ch; // each channel row names its device
  const { w, h } = DEVICES[device];
  const wrap = $('device-wrap').getBoundingClientRect();
  const scale = Math.min((wrap.width - 32) / w, (wrap.height - 32) / h, 1);
  const el = $('device');
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.transform = `scale(${scale})`;
  el.dataset.device = device;
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

/* ---- Live drafts: the channel shows unsaved changes as you type ----
 * Same messages as Frescopa Studio, so an app built for either Studio works in both:
 *   app -> Studio  { type: 'structured-content-ready' }
 *   Studio -> app  { type: 'structured-content', org, site, path, data }
 * Sent only with the live form and on the Preview tier, and only to the channel's own
 * origin. An app that doesn't listen still updates after Preview. */
let draft = null; // () => the live form's current data, once it has started
let draftTimer;

function sendDraft() {
  const frame = $('preview-frame');
  if (!draft || tier !== 'preview' || !frame.src) return;
  const { org, site, path } = ctx.doc;
  frame.contentWindow?.postMessage({
    type: 'structured-content', org, site, path, data: draft(),
  }, new URL(frame.src).origin);
}

function queueDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(sendDraft, 250);
}

/* ---- Watch the record: when a preview or publish lands, refresh the channel ----
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
    setStatus(`${t === 'live' ? 'Live' : 'Draft'} change detected, updating channel…`);
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
  window.addEventListener('message', (e) => {
    if (e.source === $('preview-frame').contentWindow && e.data?.type === 'structured-content-ready') sendDraft();
  });
  new ResizeObserver(fitDevice).observe($('device-wrap'));
}

/* ---- Which structured content form to use ----
 * Pick with ?form=<key>, or per site with the key "sc-studio.form" in the site
 * config's "data" sheet:
 *   headless  stock sc-editor form, hosted here with no second DA header (default)
 *   live      drawn here on DA's SDK: autosave, Preview/Publish, live drafts
 *   shell     the same form as a full da.live page
 *   dalive    the da-live form at da.live/form (gets the asset picker when
 *             adobe/da-live#1520 ships)
 *   assets    da-live's scassets preview branch, to try the asset picker now
 * Only these fixed Adobe URLs can be embedded. */
const FORM_DIRECT = 'https://main--sc-editor--aemsites.aem.live/form.html#';
const FORM_ORIGIN = new URL(FORM_DIRECT).origin;
const FORM_SOURCES = {
  live: { live: true },
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

function embedForm(sdk, form, fullPath) {
  const frame = $('form-frame');
  frame.hidden = false;
  if (form.hosted) {
    const { actions, ...payload } = sdk;
    hostForm(frame, { ...payload, context: { ...sdk.context, path: fullPath } });
  }
  frame.src = `${form.url}${fullPath}`;
}

const daFetchFor = (sdk) => sdk.actions?.daFetch
  ?? ((url, opts = {}) => fetch(url, { ...opts, headers: { Authorization: `Bearer ${sdk.token}`, ...opts.headers } }));

async function liveForm(sdk, doc) {
  $('live').hidden = false;
  try {
    const live = await startLiveForm({
      doc,
      daFetch: daFetchFor(sdk),
      token: sdk.token,
      els: {
        form: $('live-form'), status: $('live-status'), preview: $('live-preview'), publish: $('live-publish'),
      },
      onDraft: queueDraft,
      onPublished: () => watch(), // picks up the new version now, not on the next tick
    });
    draft = live.draft;
    // same link as the stock form's Edit schema
    const schemaPath = `/${doc.org}/${doc.site}/.da/forms/schemas/${encodeURIComponent(live.schemaName)}.html`;
    Object.assign($('edit-schema'), { href: `https://da.live/app/aemsites/sc-editor/schemas#${schemaPath}`, hidden: false });
    return live.schemaName;
  } catch (error) {
    $('live-status').textContent = error.message;
    return '';
  }
}

(async function init() {
  const sdk = await DA_SDK;
  const { token } = sdk;
  const doc = resolveDoc(sdk.context);
  ctx = { doc, token };
  wire();
  // Page mode: an app URL (?app=, or typed into Studio), not one record
  if (new URLSearchParams(window.location.search).has('app') || !doc.org || !doc.site || doc.path === '/') {
    startPageMode({ sdk, daFetch: daFetchFor(sdk), loadSiteConfig });
    return;
  }
  const config = await loadSiteConfig(doc, token);
  const form = FORM_SOURCES[formSourceKey(config)];
  const schema = form.live
    ? await liveForm(sdk, doc)
    : (embedForm(sdk, form, `/${doc.org}/${doc.site}${doc.path}`), await detectSchema(doc, token));
  channels = channelsFor(config, schema);
  $('channel').replaceChildren(...channels.map((c) => new Option(c.label)));
  if (!channels.length) {
    setStatus('No channels configured: add a "channels" sheet to this site\'s DA config (see the sc-studio README).', 'err');
    return;
  }
  setStatus(schema ? `Schema: ${schema} · watching for changes` : 'Schema not detected: showing all channels');
  render();
  watch();
  setInterval(watch, WATCH_MS);
}());
