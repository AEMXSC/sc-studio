# SC Studio

A Document Authoring (DA) app for **AEM structured content**. It puts the structured content form side by side with a live preview of every channel that uses the record: an app, a kiosk, a website page, a phone view. Authors edit on the left, press **Send**, and the preview on the right refreshes by itself. With the opt-in [live form](#choose-the-form), the channel shows the change **as they type**.

It works like a Content Fragment preview URL, but each site configures it, so one copy of this app serves every site. Originally built as Kiosk Studio for the Fréscopa demo. The live form, live drafts and fragment picker are adapted from Kunwar Saluja's [Frescopa Studio](https://github.com/scdemos/demo/tree/main/tools/frescopa-studio) (Apache-2.0), and the two Studios use the same config sheet and messages.

**App URL:** `https://da.live/app/aemxsc/sc-studio/studio#/<org>/<site>/<path-to-record>`

**New to SC Studio?** Start with the **[team guide](docs/guide.md)**. It has screenshots, a demo talk track, step-by-step setup and troubleshooting.

![SC Studio with a WKND trail alert](docs/images/01-studio-app.png)

---

## Use it on a site (two steps)

### 1. Point a records folder at the app (org config)

In `https://da.live/config#/<org>/`, add an `editor.path` row for each folder of records:

| key | value |
|---|---|
| `editor.path` | `/<org>/<site>/<folder>=https://da.live/app/aemxsc/sc-studio/studio#` |

Keep the trailing `#`. The path is case-sensitive. Opening a record in that folder now opens SC Studio instead of the plain form.

### 2. Tell it what to preview (site config)

In the **site** config (`https://da.live/config#/<org>/<site>/`), add a sheet named `channels` with one row per channel. A sheet named `previews` works too (the earlier name). `channels` is what Frescopa Studio reads, so one sheet serves both Studios:

| schema | label | url | device |
|---|---|---|---|
| `wknd-trail-alert` | App · trail alert | `https://my-app.vercel.app/?tier={tier}&cf={path}` | `desktop` |
| `wknd-trail-alert` | Website · trip companion | `https://main--{site}--{org}.aem.{tld}/trip-companion` | `desktop` |
| `roast` | Kiosk · roast | `https://my-kiosk.vercel.app/?tier={tier}&product={path}` | `kiosk` |

- **schema:** the record's schema name. Rows for the open record's schema are shown. Leave it empty to show the row for every schema.
- **url:** must be `https://`. `http://localhost` rows are also shown while Studio runs locally (`?ref=local`), so you can preview an app you're still building. Tokens:

  | token | value |
  |---|---|
  | `{tier}` | `preview` or `live` (the **Draft** / **Live** toggle in the app) |
  | `{tld}` | `page` or `live`, for `aem.page` / `aem.live` |
  | `{path}` | record path, e.g. `/wknd-next/alerts/leave-no-trace` |
  | `{slug}` | last path segment, e.g. `leave-no-trace` |
  | `{org}`, `{site}` | from the record |

- **device:** `phone` (390×844, the default when empty), `tablet` (820×1180), `desktop` (1280×800), `kiosk` (1080×1920) or `car` (1280×480). The frame scales to fit.

A site with neither sheet still opens the form, with a note saying no channels are configured.

## Page mode: open any app and edit it in place

Open `https://da.live/app/aemxsc/sc-studio/studio` and paste your app's address (a Next.js, React or Astro app, or any web page) into the location in the middle of the header. Studio is laid out like Universal Editor: the app is the canvas, the record you click opens in the properties rail on the right, and the header has the same controls.
- **✎ Edit** (the default): hovering outlines what you can change. Clicking selects it, shows its name in a label above it, and opens its record in the rail with the field outlined.
- **Text and long text** can be typed straight into the app. Esc undoes the edit, Enter finishes a one-line field.
- **Images and other fields** are edited in the rail. An image field is a card with its thumbnail.
  - **+ Add** offers **Upload from computer**, into the record's DA media folder (`<folder>/.<record>/`, as in EW), and **AEM Assets**: Adobe's Assets Selector with Content Advisor, on the site's `aem.repositoryId`.
  - Clicking the card reopens AEM Assets in that image's folder.
  - Being checked: an uploaded file's `content.da.live` address needs a DA sign-in, so confirm the published record's image is public before relying on uploads.
- **As you type,** every place on the page that shows the same record updates, and the record autosaves to DA.
- **▶ Preview** turns editing off, so links and buttons work.
- **Other header controls:** the device button sizes the app (desktop, tablet, phone), and ↗ opens it in a new tab.
- **Publish** works as in Universal Editor:
  - Choose the destination, **Preview** (the AEM preview tier) or **Live**.
  - **View** lists the records on the page with their status (Modified, Published, Not published). Changed ones are selected.
  - Publish previews each selected record (and, for Live, publishes it). A toast reports the result.
- **Studio reopens the last app** you opened.
- **The address follows the app** as you navigate inside it.
- **Edit schema** is in the rail's "…" menu.

Studio opens the app with `tier=preview` added to its address, so the app shows previewed records along with the drafts. `?app=<url-encoded address>` on Studio's URL opens an app straight away.

### Make your app editable (three additions)

```html
<!-- 1. which DA site the records come from -->
<meta name="sc:site" content="<org>/<site>">
<!-- 2. the bridge (a classic script; inert unless SC Studio frames the page) -->
<script src="https://main--sc-studio--aemxsc.aem.live/bridge.js" defer></script>
<!-- 3. Universal Editor's markup: the record on an element, a field on its children -->
<article data-content-path="/wknd-next/alerts/leave-no-trace">
  <h3 data-aue-prop="title" data-aue-type="text" data-aue-label="Title">…</h3>
  <div data-aue-prop="details" data-aue-type="richtext" data-aue-label="Details">…</div>
  <img data-aue-prop="image" data-aue-type="media" data-aue-label="Image" src="…">
</article>
```

- **Where to put them.** Next.js: in `app/layout.tsx`. Astro: in your layout's `<head>`. React/Vite: in `index.html`.
- **Field names.** `data-aue-prop` is the record's field name. If your markup uses other names (an app built for Content Fragments), map them with `<script type="application/json" id="sc-bridge-config">{"props":{"heroImage":"image"}}</script>`.
- **Types.** `text` is one line. `richtext` is long text: a blank line starts a paragraph. `media` is an image URL.
- **Computed content.** To re-render something computed from a field, listen for `window.addEventListener('sc:draft', (e) => …)`. `e.detail` is `{ path, data }`.

**Who can edit.** The app's origin must match a `url` in the site's `channels` sheet. Apps on `localhost` can always edit. Other apps open read-only, with a message.

**Messages** (all carry `v: 1`; Studio only accepts them from the framed app's origin, and the bridge only from SC Studio's):

| From | Type | Payload |
|---|---|---|
| app | `sc:ready` | none (sent to `*`) |
| Studio | `sc:connect`, `sc:mode` | `{ edit }` |
| app | `sc:page` | `{ site, url, records }` |
| app | `sc:select` | `{ path, field, label, kind, inline }` |
| Studio | `sc:record` | `{ path, data }`: the stored record, so inline editing starts from its real value (e.g. with `{{tokens}}`) |
| app | `sc:edit` | `{ path, field, value }` |
| Studio | `sc:draft` | `{ path, data }` |

**Where an edit goes:**

| Step | What happens | Who sees it |
|---|---|---|
| You type | The draft shows in the app, and the record is saved to DA | Only you, in Studio |
| **Preview** | The record goes to the preview tier | Apps reading `tier=preview` |
| **Publish** | The record goes live | Everyone, on their next load |

The app's own code only changes when you deploy it. Studio edits content, never code. A local app edits the same records as production, so for rehearsals point it at a separate DA site.

## Choose the form

By default SC Studio embeds the stock form, with its **Send** and **Edit schema**. The opt-in **live** form is drawn by SC Studio on DA's structured content SDK, the same engine as DA's own form, so both open the same record. It autosaves to DA, and has **Preview**, **Publish** and **Edit schema** next to it. It's the form that sends live drafts. If someone changes the record in DA while Studio is in the background, Studio reloads it instead of overwriting their change.

The stock form is still available. It moved from `aemsites/sc-editor` into da-live ([adobe/da-live#1477](https://github.com/adobe/da-live/pull/1477)), and its **asset picker** (image and file fields from AEM Assets, including Dynamic Media) ships there with [adobe/da-live#1520](https://github.com/adobe/da-live/pull/1520). Embedded forms don't send live drafts: the channel updates after the form's **Send**.

| key | form | live drafts | asset picker |
|---|---|---|---|
| `headless` (default) | stock sc-editor form, hosted inside Studio without a second DA header | no | no |
| `live` | drawn by SC Studio | yes | no |
| `shell` | the same form as a full da.live page | no | no |
| `dalive` | the da-live form at `da.live/form` | no | when #1520 ships |
| `assets` | da-live's `scassets` preview branch | no | yes, to try it now |

Pick one for a site with a row in the site config's **data** sheet, `sc-studio.form` = `assets`, or for one visit with `?form=assets` on the app URL. Unknown values fall back to the default. Full-page forms sign in by themselves.

**Fragment picker (live form):** a string field with `"format": "fragment"` gets a **Choose** button that opens the [AEM Apps fragment picker](https://github.com/adobe-rnd/aem-apps/tree/main/tools/plugins/fragments). The picker is served from `adobe-rnd/aem-apps` and receives the author's DA token, the way a DA library plugin does.

For the picker, a field references the SDK's image or file type instead of being a URL string. The stored value becomes an object, `{ src, altText }` for images and `{ src }` for files, so channel apps must read `image.src` as well as a plain string:

```json
"image": {
  "$ref": "https://raw.githubusercontent.com/adobe/da-sc-sdk/main/schemas/image/v1.0.0.json",
  "title": "Image",
  "required": ["altText"]
}
```

AEM Assets appears in the picker when the site config has `aem.repositoryId`. Images are copied into the media bus on preview or publish, like Canvas does, so a later change in AEM shows on the next preview or publish. Files are saved as links and stay in sync.

## Live drafts

With the live form, on the **Draft** view, Studio sends the draft to the channel 250 ms after each change. Nothing is saved or published for this. The messages are the same as Frescopa Studio's, so an app built for either Studio works in both:

1. The app tells Studio it's ready: `window.parent.postMessage({ type: 'structured-content-ready' }, '*')` (no data in it).
2. Studio sends `{ type: 'structured-content', org, site, path, data }`, only to the channel's own origin. The app checks that the message comes from Studio's origin (`https://<branch>--sc-studio--aemxsc.preview.da.live`) and that `org`, `site` and `path` are a record it shows. Then it renders `data`, the record's fields.

An app that doesn't listen still works in Studio. It shows the change after **Preview**. For an example, see `src/components/StudioDrafts.tsx` and `src/lib/studio-drafts.ts` in [wknd-next](https://github.com/AEMXSC/wknd-next). It patches the elements rendered from the record and leaves the rest of the page alone.

## How it works

- **Live form:** `live.js` loads the record and its schema from DA, runs the SDK engine, autosaves, and previews and publishes with the AEM admin API. `form.js` draws the inputs, and `picker.js` adds fragment pickers.
- **Embedded forms:** Studio hosts the stock form in an iframe and passes DA's token and the record path to it.
- **Watching:** every 4 seconds Studio reads the record from `da-sc` for the selected tier. When the record changes (a Preview, a Send or a publish), it reindexes that path in the Structured Content API and reloads the channel.
- **Cache-busting:** the channel URL gets a `studio=<timestamp>` value on each reload.

Your channel pages must allow being framed by `da.live`. Next.js and EDS pages do by default.

## Sites using it

| Site | Folder | Channels |
|---|---|---|
| `aemxsc/frescopa26` | `/roasts` | Fréscopa kiosk, roast pages |
| `aemxsc/wknd-adventures` | `/wknd-next` | wknd-next-sc app, `/trip-companion` |

## Develop

There's no build step. `studio.html`, `studio.js`, `live.js`, `form.js`, `picker.js` and `studio.css` are served as-is by AEM Code Sync from `main`. To try a change before it reaches every site, push a branch. Then open `https://da.live/app/aemxsc/sc-studio/studio?ref=<branch>#/<org>/<site>/<record>`.

The Structured Content API (`sc-api` / `da-sc` workers) is experimental, not a supported product API.
