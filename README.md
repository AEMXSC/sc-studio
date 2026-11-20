# SC Studio

A Document Authoring (DA) app for **AEM structured content**. It puts the structured content form side by side with a live preview of every channel that uses the record: an app, a kiosk, a website page, a phone view. Authors type on the left and the channel on the right shows the change **as they type**, if the app listens for drafts (see [Live drafts](#live-drafts)). Changes save to DA automatically. **Preview** and **Publish** are next to the form.

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
  | `{tier}` | `preview` or `live` (the toggle in the app) |
  | `{tld}` | `page` or `live`, for `aem.page` / `aem.live` |
  | `{path}` | record path, e.g. `/wknd-next/alerts/leave-no-trace` |
  | `{slug}` | last path segment, e.g. `leave-no-trace` |
  | `{org}`, `{site}` | from the record |

- **device:** `phone` (390×844, the default when empty), `tablet` (820×1180), `desktop` (1280×800), `kiosk` (1080×1920) or `car` (1280×480). The frame scales to fit, and the **device** menu switches it.

A site with neither sheet still opens the form, with a note saying no channels are configured.

## Choose the form

The default **live** form is drawn by SC Studio on DA's structured content SDK, the same engine as DA's own form, so both open the same record. It autosaves to DA, and has **Preview** and **Publish** next to it. It's the form that sends live drafts. If someone changes the record in DA while Studio is in the background, Studio reloads it instead of overwriting their change.

The stock form is still available. It moved from `aemsites/sc-editor` into da-live ([adobe/da-live#1477](https://github.com/adobe/da-live/pull/1477)), and its **asset picker** (image and file fields from AEM Assets, including Dynamic Media) ships there with [adobe/da-live#1520](https://github.com/adobe/da-live/pull/1520). Embedded forms don't send live drafts: the channel updates after the form's **Send**.

| key | form | live drafts | asset picker |
|---|---|---|---|
| `live` (default) | drawn by SC Studio | yes | no |
| `headless` | stock sc-editor form, hosted inside Studio without a second DA header | no | no |
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

With the live form, on the **Preview** tier, Studio sends the draft to the channel 250 ms after each change. Nothing is saved or published for this. The messages are the same as Frescopa Studio's, so an app built for either Studio works in both:

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
