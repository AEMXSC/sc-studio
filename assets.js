/*
 * Image fields in page mode, like Universal Editor's: a card with the image's thumbnail
 * and name, ✕ to remove it, and "+ Add" to pick one with Adobe's AEM Assets Selector,
 * the same selector Experience Workspace and Universal Editor open (Content Advisor
 * included). The site's AEM Assets repository comes from its DA config
 * (aem.repositoryId), as in Experience Workspace. A pick stores the image's delivery
 * URL, resolved by da.live's own helpers, so it matches what EW stores.
 */
// eslint-disable-next-line import/no-unresolved
import { resolveAssetSelection } from 'https://da.live/nx2/utils/aem-assets/selection.js';
// eslint-disable-next-line import/no-unresolved
import { buildAssetSelectorProps } from 'https://da.live/nx2/utils/aem-assets/selector-props.js';
// eslint-disable-next-line import/no-unresolved
import { createImagesOnlyFilterSchema } from 'https://da.live/nx2/utils/aem-assets/filter-schema.js';
// eslint-disable-next-line import/no-unresolved
import { isDynamicMediaEnabled, shouldFilterApprovedAssets } from 'https://da.live/nx2/utils/aem-assets/config.js';

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

/** Opens the selector in a dialog. Resolves with { href, alt }, { error }, or null when closed. */
async function chooseImage(repoConfig, token) {
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
    selectors.renderAssetSelector(container, buildAssetSelectorProps({
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
    }));
  });
}

const fileName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? url);
  } catch {
    return url;
  }
};

/**
 * Turns each image field of a freshly drawn form into a card. `setField(pointer, value)`
 * changes the record; `status(text)` reports a problem in the rail.
 */
export function imageCards(form, { setField, repoConfig, token, status }) {
  form.querySelectorAll('input[data-pointer]').forEach((input) => {
    const key = input.dataset.pointer.split('/').pop();
    if (!isImageField(key) || input.type === 'checkbox' || input.closest('.field')?.querySelector('.asset-card')) return;
    const card = Object.assign(document.createElement('div'), { className: 'asset-card' });
    const set = (value) => {
      input.value = value;
      setField(input.dataset.pointer, value);
      draw(); // eslint-disable-line no-use-before-define
    };
    const add = async () => {
      if (!repoConfig) {
        status('No AEM Assets repository is set for this site (aem.repositoryId in its DA config). Paste an image URL instead.');
        input.hidden = false;
        input.focus();
        return;
      }
      try {
        const pick = await chooseImage(repoConfig, token);
        if (pick?.error) status(pick.error);
        if (!pick?.href) return;
        set(pick.href);
        const alt = form.querySelector(`[data-pointer="${CSS.escape(`${input.dataset.pointer}Alt`)}"]`);
        if (alt && !alt.value && pick.alt) {
          alt.value = pick.alt;
          setField(alt.dataset.pointer, pick.alt);
        }
      } catch (error) {
        status(error.message);
      }
    };
    function draw() {
      const url = input.value.trim();
      card.replaceChildren();
      if (url) {
        const thumb = Object.assign(document.createElement('img'), { className: 'asset-thumb', alt: '', src: url });
        const name = Object.assign(document.createElement('span'), { className: 'asset-name', textContent: fileName(url), title: url });
        const remove = Object.assign(document.createElement('button'), {
          type: 'button', className: 'icon', textContent: '✕', title: 'Remove the image',
        });
        remove.setAttribute('aria-label', `Remove ${name.textContent}`);
        remove.addEventListener('click', () => set(''));
        card.append(thumb, name, remove);
      } else {
        const plus = Object.assign(document.createElement('button'), { type: 'button', className: 'asset-add', textContent: '+ Add' });
        plus.addEventListener('click', add);
        card.append(plus);
      }
    }
    input.hidden = Boolean(repoConfig); // the URL stays editable when there's no repository
    input.addEventListener('input', draw);
    input.before(card);
    draw();
  });
}
