/*
 * Image fields in page mode, like Universal Editor's: a card with the image's thumbnail
 * and name, and ✕ to remove it. "+ Add" offers the same two sources as EW's form:
 * - Upload from computer, into the record's own DA media folder;
 * - AEM Assets: Adobe's Assets Selector, the one EW and Universal Editor open (Content
 *   Advisor included), on the site's repository (aem.repositoryId in its DA config).
 *   A pick stores the delivery URL resolved by da.live's own helpers, as EW does.
 * Clicking the card reopens AEM Assets in the image's folder, as Universal Editor does.
 */
// eslint-disable-next-line import/no-unresolved
import { resolveAssetSelection } from 'https://da.live/nx2/utils/aem-assets/selection.js';
// eslint-disable-next-line import/no-unresolved
import { buildAssetSelectorProps } from 'https://da.live/nx2/utils/aem-assets/selector-props.js';
// eslint-disable-next-line import/no-unresolved
import { createImagesOnlyFilterSchema } from 'https://da.live/nx2/utils/aem-assets/filter-schema.js';
// eslint-disable-next-line import/no-unresolved
import { isDynamicMediaEnabled, shouldFilterApprovedAssets } from 'https://da.live/nx2/utils/aem-assets/config.js';

const DA_ADMIN = 'https://admin.da.live';
const SELECTOR_URL = 'https://experience.adobe.com/solutions/CQ-assets-selectors/static-assets/resources/assets-selectors.js';
const IMAGE_FIELD = /image|photo|picture|banner|thumbnail/i;

/** An image field: "image", "heroImage", "bannerImage"… but not "imageAlt". */
export const isImageField = (key) => key === 'src' || (IMAGE_FIELD.test(key) && !/alt/i.test(key));

/** The AEM Assets repository from the site's (then the org's) DA config, as EW reads it. */
export function repositoryConfig(...configs) {
  const rows = configs.flatMap((c) => (c?.[':names'] ?? ['data']).flatMap((name) => c?.[name]?.data ?? []));
  const get = (key) => rows.find((r) => r.key === key)?.value || null;
  const repositoryId = get('aem.repositoryId');
  if (!repositoryId) return null;
  const tierType = repositoryId.startsWith('delivery') ? 'delivery' : 'author';
  const customOrigin = get('aem.assets.prod.origin');
  const isDmEnabled = isDynamicMediaEnabled({
    repositoryId, customOrigin, dmDelivery: get('aem.asset.dm.delivery'), smartCrop: get('aem.asset.smartcrop.select'),
  });
  let assetOrigin = customOrigin || repositoryId;
  if (!customOrigin && tierType === 'author') assetOrigin = repositoryId.replace('author', isDmEnabled ? 'delivery' : 'publish');
  return {
    repositoryId,
    tierType,
    assetOrigin,
    assetBasePath: get('aem.assets.prod.basepath') || '/adobe/assets',
    isDmEnabled,
    approvedOnly: shouldFilterApprovedAssets({ tierType, isDmEnabled, configuredValue: get('aem.asset.dm.approvedonly') }),
  };
}

let selectorLoad;
function loadSelector() {
  selectorLoad ??= new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: SELECTOR_URL });
    script.onload = () => resolve(window.PureJSSelectors);
    script.onerror = () => {
      selectorLoad = null;
      script.remove();
      reject(new Error('The AEM Assets selector could not be loaded.'));
    };
    document.head.append(script);
  });
  return selectorLoad;
}

/**
 * The AEM folder an image URL points into (…/content/dam/<folder>/<file>.jpg…), so the
 * selector can open there with the current image in view, as Universal Editor does.
 */
export function damFolder(url) {
  try {
    const { pathname } = new URL(url);
    return /^(\/content\/dam\/.*?)\/[^/]+\.(?:jpe?g|png|gif|webp|avif|svg|tiff?)(?:\/|$)/i.exec(pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Uploads an image into the record's own DA media folder (<folder>/.<record>/<file>), the
 * place EW's form and Canvas put uploads. Preview and publish copy it to the media bus.
 */
async function uploadImage({ file, doc, daFetch }) {
  if (!file?.type?.startsWith('image/')) return { error: 'Choose an image file.' };
  if (/[/\\?#]|^\.{1,2}$/.test(file.name)) return { error: 'That file name can\'t be used. Rename the file and try again.' };
  const parent = doc.path.slice(0, doc.path.lastIndexOf('/'));
  const record = doc.path.slice(parent.length + 1);
  const body = new FormData();
  body.append('data', file);
  const resp = await daFetch(`${DA_ADMIN}/source/${doc.org}/${doc.site}${parent}/.${record}/${encodeURIComponent(file.name)}`, {
    method: 'POST', body,
  });
  if (!resp.ok) return { error: `The upload failed (${resp.status}). Try again.` };
  const href = (await resp.json().catch(() => null))?.source?.contentUrl;
  return href ? { href } : { error: 'The upload didn\'t return the file\'s address.' };
}

/** Opens the selector in a dialog. Resolves with { href, alt }, { error }, or null when closed. */
async function chooseImage(repoConfig, token, folder) {
  const selectors = await loadSelector();
  if (typeof selectors?.renderAssetSelector !== 'function') return { error: 'The AEM Assets selector could not be loaded.' };
  const dialog = Object.assign(document.createElement('dialog'), { className: 'picker' });
  dialog.setAttribute('aria-label', 'Choose an image from AEM Assets');
  const close = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: 'Close' });
  const container = Object.assign(document.createElement('div'), { className: 'picker-body' });
  dialog.append(close, container);
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (result) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    close.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', () => finish(null));
    const props = buildAssetSelectorProps({
      imsToken: token,
      repoConfig,
      filterSchema: createImagesOnlyFilterSchema(),
      onClose: () => finish(null),
      handleSelection: ([asset] = []) => {
        if (!asset) return finish(null);
        const { href, alt, isImage, error } = resolveAssetSelection({ asset, repoConfig });
        if (error) return finish({ error });
        if (!isImage) return finish({ error: 'Only images can be chosen here.' });
        return finish({ href, alt });
      },
    });
    // open where the current image lives (the selector takes a path on author tiers)
    if (folder && repoConfig.tierType === 'author') props.path = folder;
    selectors.renderAssetSelector(container, props);
  });
}

const fileName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? url);
  } catch {
    return url;
  }
};

const button = (className, text, label) => {
  const b = Object.assign(document.createElement('button'), { type: 'button', className, textContent: text });
  if (label) b.setAttribute('aria-label', label);
  return b;
};

let cardCount = 0;

/**
 * Turns each image field of a freshly drawn form into a card, as in Universal Editor and
 * EW's form: "+ Add" offers Upload (into the record's DA media) and AEM Assets (Content
 * Advisor); clicking the card reopens AEM Assets where the image lives.
 * `setField(pointer, value)` changes the record; `status(text)` reports a problem.
 */
export function imageCards(form, {
  setField, repoConfig, token, status, doc, daFetch,
}) {
  form.querySelectorAll('input[data-pointer]').forEach((input) => {
    const key = input.dataset.pointer.split('/').pop();
    if (!isImageField(key) || input.type === 'checkbox' || input.closest('.field')?.querySelector('.asset-card')) return;
    cardCount += 1;
    const card = Object.assign(document.createElement('div'), { className: 'asset-card' });
    const file = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
    const menu = Object.assign(document.createElement('div'), { className: 'menu' });
    menu.popover = 'auto';
    menu.style.setProperty('position-anchor', `--asset-${cardCount}`);
    card.style.setProperty('anchor-name', `--asset-${cardCount}`);

    const set = (pick) => {
      input.value = pick.href;
      setField(input.dataset.pointer, pick.href);
      const alt = form.querySelector(`[data-pointer="${CSS.escape(`${input.dataset.pointer}Alt`)}"]`);
      if (alt && !alt.value && pick.alt) {
        alt.value = pick.alt;
        setField(alt.dataset.pointer, pick.alt);
      }
      draw(); // eslint-disable-line no-use-before-define
    };
    const take = async (choose) => {
      try {
        const pick = await choose();
        if (pick?.error) status(pick.error);
        if (pick?.href) set(pick);
      } catch (error) {
        status(error.message);
      }
    };
    const fromAem = () => take(() => chooseImage(repoConfig, token, damFolder(input.value)));
    file.addEventListener('change', () => {
      const [chosen] = file.files;
      file.value = '';
      if (chosen) take(() => uploadImage({ file: chosen, doc, daFetch }));
    });

    const upload = button('', 'Upload from computer');
    upload.addEventListener('click', () => { menu.hidePopover(); file.click(); });
    const aem = button('', 'AEM Assets');
    aem.addEventListener('click', () => { menu.hidePopover(); fromAem(); });
    menu.append(upload, ...(repoConfig ? [aem] : []));

    function draw() {
      const url = input.value.trim();
      card.replaceChildren(file, menu);
      if (!url) {
        const plus = button('asset-add', '+ Add');
        plus.addEventListener('click', () => menu.showPopover());
        card.append(plus);
        return;
      }
      // clicking the image, like Universal Editor: AEM Assets where it lives, else replace it
      const open = button('asset-open', '', `Change the image ${fileName(url)}`);
      open.append(
        Object.assign(document.createElement('img'), { className: 'asset-thumb', alt: '', src: url }),
        Object.assign(document.createElement('span'), { className: 'asset-name', textContent: fileName(url), title: url }),
      );
      open.addEventListener('click', () => (repoConfig ? fromAem() : menu.showPopover()));
      const remove = button('icon', '✕', `Remove ${fileName(url)}`);
      remove.title = 'Remove the image';
      remove.addEventListener('click', () => set({ href: '' }));
      card.append(open, remove);
    }
    input.hidden = true; // the card shows the value; the URL input stays the form's source of truth
    input.addEventListener('input', draw);
    input.before(card);
    draw();
  });
}
