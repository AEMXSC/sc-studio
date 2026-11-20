/*
 * Adapted from Frescopa Studio (scdemos/demo tools/frescopa-studio, Apache-2.0),
 * by Kunwar Saluja: the fragment picker, parameterized by org and site.
 *
 * Fields the schema marks "format": "fragment" (a string holding a path such as
 * /fragments/x) get a Choose button that opens the AEM Apps fragment picker:
 * https://github.com/adobe-rnd/aem-apps/tree/main/tools/plugins/fragments
 * It is hosted the way DA's library hosts plugins, so it receives the author's DA
 * token. That is a trust decision: the picker's code is served from adobe-rnd/aem-apps.
 */
const FRAGMENT_PICKER = new URL('https://main--aem-apps--adobe-rnd.aem.live/tools/plugins/fragments/fragments.html');

/** The path of the fragment link the picker sends, if it's a page on this site. */
function fragmentPath(html, { org, site }) {
  const href = new DOMParser().parseFromString(String(html), 'text/html').querySelector('a[href]')?.getAttribute('href');
  try {
    const url = new URL(href);
    return url.origin === `https://main--${site}--${org}.aem.page` && /^\/[^/]/.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

/** Opens the picker in a dialog. Resolves with the chosen fragment's path, or null. */
function chooseFragment(title, doc, token) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    // no allow-top-navigation: the picker can't move the DA tab elsewhere
    frame.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms';
    frame.referrerPolicy = 'no-referrer';
    frame.src = FRAGMENT_PICKER.href;
    frame.title = title;
    const close = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: 'Close' });
    const dialog = document.createElement('dialog');
    dialog.className = 'picker';
    dialog.setAttribute('aria-label', title);
    dialog.append(close, frame);

    let path = null;
    const finish = () => {
      dialog.close();
      dialog.remove();
      resolve(path);
    };
    close.addEventListener('click', finish);
    dialog.addEventListener('cancel', finish);
    frame.addEventListener('load', () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => {
        if (data?.action === 'sendHTML') path = fragmentPath(data.details, doc);
        if (data?.action === 'closeLibrary') finish();
      };
      frame.contentWindow.postMessage({
        ready: true, context: { org: doc.org, repo: doc.site, path: doc.path }, token,
      }, FRAGMENT_PICKER.origin, [channel.port2]);
    }, { once: true });

    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * The fields the schema marks "format": "fragment", as patterns for the form's field
 * pointers (/data/announcement, /data/tabs/0/opens…). Read from the schema itself:
 * the structured content SDK drops formats it doesn't know.
 */
export function fragmentFields(schema) {
  const escape = (key) => key.replaceAll('~', '~0').replaceAll('/', '~1')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lookup = (ref) => ref.replace(/^#\//, '').split('/')
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((n, key) => n?.[key], schema);
  // Follows a chain of local $refs; a ref already followed on this branch isn't followed again.
  const resolve = (node, refs) => {
    if (!node || typeof node !== 'object') return null;
    const own = { ...node };
    delete own.$ref;
    let field = node;
    const seen = new Set(refs);
    while (field.$ref) {
      const { $ref, ...rest } = field;
      const target = seen.has($ref) ? null : lookup($ref);
      seen.add($ref);
      if (!target || typeof target !== 'object') {
        field = rest;
        break;
      }
      field = { ...target, ...rest, properties: { ...target.properties, ...rest.properties } };
    }
    return { field, seen, own };
  };
  const patterns = [];
  const walk = (node, pointer, refs) => {
    const resolved = resolve(node, refs);
    if (!resolved) return;
    const { field, seen, own } = resolved;
    const refsFor = (isOwn) => (isOwn ? refs : seen);
    if (field.format === 'fragment') patterns.push(new RegExp(`^${pointer}$`));
    Object.entries(field.properties ?? {})
      .forEach(([key, child]) => walk(child, `${pointer}/${escape(key)}`, refsFor(own.properties?.[key])));
    if (field.items) walk(field.items, `${pointer}/\\d+`, refsFor(own.items));
    ['oneOf', 'anyOf', 'allOf'].forEach((keyword) => (field[keyword] ?? [])
      .forEach((option) => walk(option, pointer, refsFor(own[keyword]))));
  };
  walk(schema, '/data', new Set());
  return patterns;
}

/** A form decorator that adds a Choose button next to each fragment field. */
export function addPickers(engine, patterns, doc, token) {
  return (form) => form.querySelectorAll('input[data-pointer]').forEach((input) => {
    const { pointer, label } = input.dataset;
    if (!patterns.some((pattern) => pattern.test(pointer))) return;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: 'Choose' });
    button.setAttribute('aria-label', `Choose: ${label}`);
    button.addEventListener('click', async () => {
      const path = await chooseFragment(`Choose a fragment: ${label}`, doc, token);
      if (!path) return;
      input.value = path;
      engine.setField(pointer, path);
      input.focus();
    });
    const row = Object.assign(document.createElement('div'), { className: 'field-row' });
    input.replaceWith(row);
    row.append(input, button);
  });
}
