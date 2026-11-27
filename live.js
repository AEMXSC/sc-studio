/*
 * The live form (form source "live"): SC Studio draws the record's form itself, on
 * DA's structured content SDK, so it has the draft on every keystroke and can send it
 * to the channel as you type. Adapted from Frescopa Studio (scdemos/demo
 * tools/frescopa-studio, Apache-2.0) by Kunwar Saluja.
 *
 * - The SDK engine owns state, validation and the storage format; form.js draws inputs.
 * - Changes autosave to DA source, one request at a time, so a slow save never
 *   overwrites newer typing.
 * - If someone else changed the record in DA while Studio was in the background,
 *   Studio reloads it rather than overwrite their change.
 * - Preview and Publish go through the AEM admin API, after a successful save, and
 *   only for a valid record.
 */
// eslint-disable-next-line import/no-unresolved
import { createEngine, convertHtmlToJson, convertJsonToHtml } from 'https://da.live/nx/deps/da-sc-sdk/dist/index.js';
import { renderForm, showErrors } from './form.js';
import { addPickers, fragmentFields } from './picker.js';

const DA_ADMIN = 'https://admin.da.live';
const AEM_ADMIN = 'https://admin.hlx.page';

const when = (date) => new Date(date).toLocaleString([], {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const time = (date) => (date ? new Date(date).getTime() : 0);

export async function startLiveForm({
  doc, daFetch, token, els, onDraft, onPublished, decorate, onHistory = () => {},
}) {
  const { org, site, path } = doc;
  const setStatus = (text) => { els.status.textContent = text; };
  const read = (route) => daFetch(`${DA_ADMIN}${route}`, { cache: 'no-store' });
  // admin.hlx.page for DA sites needs the content source token as well
  const admin = (route, method = 'POST') => daFetch(`${AEM_ADMIN}/${route}/${org}/${site}/main${path}`, {
    method, headers: { 'x-content-source-authorization': `Bearer ${token}` },
  });

  async function loadDocument() {
    const resp = await read(`/source/${org}/${site}${path}.html`);
    if (resp.status === 404) throw new Error(`${path} isn't in DA yet. Create it in the form editor first.`);
    if (!resp.ok) throw new Error(`Couldn't load the record (${resp.status}).`);
    const { json, error } = convertHtmlToJson({ html: await resp.text() });
    if (error) throw new Error(error);
    return json;
  }

  async function loadSchema(name) {
    const resp = await read(`/source/${org}/${site}/.da/forms/schemas/${name}.html`);
    if (!resp.ok) throw new Error(`Couldn't read the "${name}" schema (${resp.status}).`);
    const code = new DOMParser().parseFromString(await resp.text(), 'text/html').querySelector('code');
    if (!code) throw new Error(`The "${name}" schema is empty.`);
    return JSON.parse(code.textContent);
  }

  /** When DA last saved the record, from DA's list of its folder. */
  async function lastEdited() {
    const folder = path.slice(0, path.lastIndexOf('/'));
    const resp = await read(`/list/${org}/${site}${folder}`);
    if (!resp.ok) return 0;
    const name = path.slice(folder.length + 1);
    return (await resp.json()).find((i) => i.name === name && i.ext === 'html')?.lastModified ?? 0;
  }

  async function showPublishState() {
    const [resp, edited] = await Promise.all([admin('status', 'GET'), lastEdited()]);
    if (!resp.ok) return setStatus(`Couldn't check the publish status (${resp.status}).`);
    const { preview, live } = await resp.json();
    const [previewed, published] = [preview, live].map((s) => time(s?.lastModified));
    if (!previewed || edited > previewed) return setStatus('Saved, not previewed yet');
    if (!published || previewed > published) return setStatus(`Previewed ${when(preview.lastModified)}, not published`);
    return setStatus(`Published ${when(live.lastModified)}`);
  }

  const loadedRevision = await lastEdited();
  const json = await loadDocument();
  const { schemaName } = json.metadata ?? {};
  if (!/^[a-z0-9][a-z0-9-]*$/.test(schemaName ?? '')) throw new Error('This record names no schema. Open it in the form editor and pick one.');
  const schema = await loadSchema(schemaName);

  let engine;
  let lastDocument;
  let busy = false; // a Preview, Publish or freshness check is running
  const errorCount = () => Object.keys(engine.getState().validation.errors).length
    + Number((engine.getState().schemaIssues?.length ?? 0) > 0);
  const checkErrors = () => {
    const errors = errorCount();
    els.preview.disabled = busy || errors > 0;
    els.publish.disabled = busy || errors > 0;
    if (errors) setStatus(`Fix ${errors} ${errors === 1 ? 'field' : 'fields'} before you preview or publish.`);
    return errors;
  };

  async function saveDocument() {
    const { document: record, model } = engine.getState();
    const body = new FormData();
    body.append('data', new Blob([convertJsonToHtml({ json: record, model }).html], { type: 'text/html' }));
    return daFetch(`${DA_ADMIN}/source/${org}/${site}${path}.html`, { method: 'POST', body });
  }

  let known = loadedRevision;
  let saving = null;
  let again = false;
  let lastOk = true;
  const runSave = async () => {
    setStatus('Saving…');
    let ok = false;
    try {
      do {
        again = false;
        ok = (await saveDocument()).ok;
        // eslint-disable-next-line no-await-in-loop
        if (ok && !again) known = await lastEdited().catch(() => known);
      } while (again && ok);
    } catch {
      ok = false; // offline or blocked: the next change tries again
    } finally {
      saving = null;
    }
    lastOk = ok;
    if (!ok) setStatus("Couldn't save. Your changes are kept here; edit any field to try again.");
    else if (!checkErrors()) setStatus('Saved, not previewed yet');
    return ok;
  };
  const save = {
    changed() { if (saving) again = true; else saving = runSave(); },
    done: () => saving ?? Promise.resolve(lastOk),
  };

  // Undo and redo: snapshots of the record's data. A burst of typing is one step.
  const UNDO_GAP_MS = 800;
  const history = {
    past: [], future: [], at: 0, restoring: false,
  };
  const remember = (before) => {
    if (history.restoring) return;
    const now = Date.now();
    if (now - history.at > UNDO_GAP_MS) history.past.push(before.data);
    history.at = now;
    history.future = [];
    onHistory();
  };

  engine = createEngine({
    schema,
    document: json,
    onChange: () => {
      const { document: next } = engine.getState();
      if (next === lastDocument) return;
      remember(lastDocument);
      lastDocument = next;
      showErrors(els.form, engine);
      checkErrors();
      save.changed();
      onDraft(next.data);
    },
  });
  lastDocument = engine.getState().document;

  // close() removes these, so page mode can switch records without stacking listeners
  const listeners = new AbortController();
  const { signal } = listeners;

  // Changed elsewhere (e.g. DA's form editor) while Studio was in the background: reload.
  // On the tab becoming visible, not on window focus: focus also returns from the channel
  // frame on every click there, and the check's inert form would swallow the next click.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || busy) return;
    busy = true;
    els.form.inert = true;
    (async () => {
      if (!await save.done()) return;
      if (await lastEdited() > known) window.location.reload();
    })().catch(() => {}).finally(() => {
      busy = false;
      els.form.inert = false;
      checkErrors();
    });
  }, { signal });

  const publish = async (steps) => {
    if (busy) return;
    busy = true;
    els.form.inert = true;
    checkErrors();
    try {
      if (!await save.done()) {
        setStatus("Couldn't save. Your changes are kept here; edit any field to try again.");
        return;
      }
      if (checkErrors()) return;
      // eslint-disable-next-line no-restricted-syntax
      for (const [route, label] of steps) {
        setStatus(`${label}…`);
        // eslint-disable-next-line no-await-in-loop
        const resp = await admin(route);
        if (!resp.ok) {
          setStatus(`${label} failed (${resp.status}).`);
          return;
        }
      }
      onPublished(steps.map(([route]) => route));
      await showPublishState();
    } catch {
      setStatus(`${steps.at(-1)[1]} failed (network error).`);
    } finally {
      busy = false;
      els.form.inert = false;
      checkErrors();
    }
  };
  els.form.addEventListener('submit', (e) => e.preventDefault(), { signal }); // fields save as you type
  els.preview.addEventListener('click', () => publish([['preview', 'Previewing']]), { signal });
  els.publish.addEventListener('click', () => publish([['preview', 'Previewing'], ['live', 'Publishing']]), { signal });

  const pickers = addPickers(engine, fragmentFields(schema), doc, token);
  const draw = () => renderForm(els.form, engine, {
    decorate: (form) => {
      pickers(form);
      decorate?.(form, (pointer, value) => engine.setField(pointer, value));
    },
  });

  /** Puts the record back to an earlier snapshot, field by field, then redraws the form. */
  const restore = (data) => {
    const now = engine.getState().document.data;
    history.restoring = true;
    try {
      new Set([...Object.keys(now), ...Object.keys(data)]).forEach((key) => {
        if (JSON.stringify(now[key]) !== JSON.stringify(data[key])) engine.setField(`/data/${key}`, data[key] ?? '');
      });
    } finally {
      history.restoring = false;
      history.at = 0;
    }
    draw();
    onHistory();
  };
  const step = (from, to) => {
    if (!from.length) return;
    to.push(engine.getState().document.data);
    restore(from.pop());
  };

  draw();
  if (!checkErrors()) await showPublishState();
  return {
    undo: () => step(history.past, history.future),
    redo: () => step(history.future, history.past),
    canUndo: () => history.past.length > 0,
    canRedo: () => history.future.length > 0,
    schemaName,
    title: json.metadata?.title ?? '',
    draft: () => engine.getState().document.data,
    /** A value typed outside the form (page mode's inline editing); the SDK validates it. */
    setField: (pointer, value) => engine.setField(pointer, value),
    /** Stop listening, then wait for the last save, before another record opens. */
    close: () => {
      listeners.abort();
      return save.done();
    },
  };
}
