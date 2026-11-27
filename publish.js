/*
 * Page mode's Publish, like Universal Editor's: a panel with the destination (Preview or
 * Live) and the records on the page, each with its status against that destination.
 * Changed records are selected by default. Publishing previews each selected record
 * (and, for Live, publishes it) through the AEM admin API, then a toast reports it.
 *
 * Status: the record's last save in DA (DA's folder list) against its preview and live
 * times (AEM admin status), the same comparison the live form makes for one record.
 */
const DA_ADMIN = 'https://admin.da.live';
const AEM_ADMIN = 'https://admin.hlx.page';
const TOAST_MS = 5000;

const $ = (id) => document.getElementById(id);
const time = (date) => (date ? new Date(date).getTime() : 0);
const WORDS = {
  preview: { never: 'Not previewed', changed: 'Modified', done: 'Previewed' },
  live: { never: 'Not published', changed: 'Modified', done: 'Published' },
};

function toast(text, kind = 'info') {
  const el = $('toast');
  $('toast-text').textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, TOAST_MS);
}

/**
 * @param {object} options
 * @param {() => {org: string, site: string, records: {path: string, label: string}[]}} options.page
 * @param {(url: string, opts?: object) => Promise<Response>} options.daFetch
 * @param {string} options.token
 * @param {() => Promise<string[]>} options.beforePublish waits for pending saves; returns
 *   the paths that can't be published yet (validation errors)
 * @param {() => void} options.afterPublish
 */
export default function wirePublish({
  page, daFetch, token, beforePublish, afterPublish,
}) {
  let items = []; // { path, label, edited, preview, live, selected }
  let filter = 'all';
  const dest = () => document.querySelector('input[name="publish-dest"]:checked')?.value ?? 'live';
  const admin = (route, org, site, path, method = 'GET') => daFetch(`${AEM_ADMIN}/${route}/${org}/${site}/main${path}`, {
    method, headers: { 'x-content-source-authorization': `Bearer ${token}` },
  });

  const stateOf = (item) => {
    const at = time(item[dest()]);
    if (!at) return 'never';
    return item.edited > at ? 'changed' : 'done';
  };

  function drawMain() {
    const count = items.filter((i) => i.selected).length;
    $('publish-count').textContent = items.length
      ? `${count} ${count === 1 ? 'item' : 'items'}`
      : 'No records on this page';
    $('publish-go').disabled = count === 0;
    $('publish-view').disabled = items.length === 0;
  }

  function drawList() {
    const changed = items.filter((i) => stateOf(i) !== 'done');
    $('publish-filter-modified').textContent = `Modified (${changed.length})`;
    $('publish-filter-all').textContent = `All (${items.length})`;
    document.querySelectorAll('[data-publish-filter]').forEach((b) => b.classList.toggle('on', b.dataset.publishFilter === filter));
    const shown = filter === 'modified' ? changed : items;
    $('publish-list').replaceChildren(...shown.map((item) => {
      const state = stateOf(item);
      const li = document.createElement('li');
      const icon = Object.assign(document.createElement('span'), { className: 'item-icon', textContent: '▤' });
      icon.setAttribute('aria-hidden', 'true');
      const name = Object.assign(document.createElement('span'), { className: 'item-name', textContent: item.label, title: item.path });
      const status = Object.assign(document.createElement('span'), { className: `item-status ${state}`, textContent: WORDS[dest()][state] });
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: item.selected });
      box.setAttribute('aria-label', `Publish ${item.label}`);
      box.addEventListener('change', () => {
        item.selected = box.checked;
        drawMain();
        drawAll(); // eslint-disable-line no-use-before-define
      });
      li.append(icon, name, status, box);
      return li;
    }));
    drawAll(); // eslint-disable-line no-use-before-define
  }

  function drawAll() {
    const selected = items.filter((i) => i.selected).length;
    $('publish-all').checked = items.length > 0 && selected === items.length;
    $('publish-all').indeterminate = selected > 0 && selected < items.length;
  }

  const selectChanged = () => items.forEach((i) => { i.selected = stateOf(i) !== 'done'; });

  /** Each record's last DA save, preview and live times. */
  async function load() {
    const { org, site, records } = page();
    $('publish-count').textContent = 'Checking…';
    $('publish-go').disabled = true;
    const folders = [...new Set(records.map(({ path }) => path.slice(0, path.lastIndexOf('/'))))];
    const lists = await Promise.all(folders.map(async (folder) => {
      const resp = await daFetch(`${DA_ADMIN}/list/${org}/${site}${folder}`, { cache: 'no-store' }).catch(() => null);
      return [folder, resp?.ok ? await resp.json() : []];
    }));
    const listed = Object.fromEntries(lists);
    items = await Promise.all(records.map(async ({ path, label }) => {
      const folder = path.slice(0, path.lastIndexOf('/'));
      const name = path.slice(folder.length + 1);
      const edited = time(listed[folder]?.find((i) => i.name === name && i.ext === 'html')?.lastModified);
      const resp = await admin('status', org, site, path).catch(() => null);
      const status = resp?.ok ? await resp.json() : {};
      return {
        path, label, edited, preview: status.preview?.lastModified, live: status.live?.lastModified, selected: false,
      };
    }));
    selectChanged();
    drawMain();
  }

  async function publish() {
    const { org, site } = page();
    const target = dest();
    const chosen = items.filter((i) => i.selected);
    $('publish-panel').hidePopover();
    const blocked = new Set(await beforePublish());
    const ready = chosen.filter((i) => !blocked.has(i.path));
    const steps = target === 'live' ? ['preview', 'live'] : ['preview'];
    const results = await Promise.all(ready.map(async (item) => {
      try {
        // eslint-disable-next-line no-restricted-syntax
        for (const route of steps) {
          // eslint-disable-next-line no-await-in-loop
          const resp = await admin(route, org, site, item.path, 'POST');
          if (!resp.ok) return false;
        }
        return true;
      } catch {
        return false;
      }
    }));
    const failed = results.filter((ok) => !ok).length + blocked.size;
    const where = target === 'live' ? 'Live' : 'Preview';
    if (!failed) toast(`Published ${ready.length} ${ready.length === 1 ? 'item' : 'items'} to ${where}`);
    else if (blocked.size) toast(`Fix the highlighted fields first: ${failed} of ${chosen.length} items weren't published.`, 'error');
    else toast(`${failed} of ${chosen.length} items couldn't be published to ${where}. Try again.`, 'error');
    afterPublish();
  }

  $('publish-panel').addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    $('publish-main').hidden = false;
    $('publish-items').hidden = true;
    load().catch(() => { $('publish-count').textContent = 'Couldn\'t check the items.'; });
  });
  document.querySelectorAll('input[name="publish-dest"]').forEach((r) => r.addEventListener('change', () => {
    selectChanged();
    drawMain();
  }));
  $('publish-view').addEventListener('click', () => {
    $('publish-main').hidden = true;
    $('publish-items').hidden = false;
    drawList();
  });
  $('publish-back').addEventListener('click', () => {
    $('publish-items').hidden = true;
    $('publish-main').hidden = false;
    drawMain();
  });
  document.querySelectorAll('[data-publish-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.publishFilter;
    drawList();
  }));
  $('publish-all').addEventListener('change', () => {
    const on = $('publish-all').checked;
    items.forEach((i) => { i.selected = on; });
    drawList();
    drawMain();
  });
  $('publish-go').addEventListener('click', publish);
  $('toast-close').addEventListener('click', () => { $('toast').hidden = true; });
}
