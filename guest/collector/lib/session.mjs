import { LIMITS, cut } from './limits.mjs';
import { validateCommand } from './commands.mjs';
import { reportPage, reportSnapshot, saveScreenshot, navErrorCode } from './scan.mjs';
import { analyzeFile } from './file.mjs';

const OP_TIMEOUT_MS = 10_000;
const DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024;

class CommandError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isWeb = (u) => /^https?:$/i.test(new URL(u).protocol);

/**
 * The interactive part (spec 005, 3.3): one command per stdin line, one `cmd_result` per command. The model never
 * supplies selectors, addresses or code, only element references from the last snapshot. Returns why the session ended.
 */
export async function runSession({ job, context, page, lines, emitter, scan, artifactDir }) {
  const { emit } = emitter;
  const state = scan.state;
  let known = new Map(scan.links.map((l) => [l.ref, l]));

  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve('max_time'), job.session.maxS * 1000);
  });

  const expiredError = expired.then(() => {
    throw new CommandError('session_expired');
  });
  expiredError.catch(() => {}); // only the command race below observes it

  emit('session_ready');

  const pageUrl = () => page.url();
  const frameId = () => scan.tracker.mainFrameId();

  /** After anything that may have changed the page: new text, forms and snapshot; old refs are dead. */
  async function refresh() {
    const url = pageUrl();
    if (!/^https?:/i.test(url)) {
      known = new Map();
      return state.snap;
    }
    await reportPage(scan.cdp, emitter, frameId(), url);
    const s = await reportSnapshot(page, emitter, state, url);
    known = new Map(s.links.map((l) => [l.ref, l]));
    return s.snap;
  }

  async function settle() {
    await page.waitForLoadState('load', { timeout: OP_TIMEOUT_MS }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: LIMITS.settleMs }).catch(() => {});
    await scan.tracker.waitForScheduled();
  }

  function needFresh(c) {
    if (c.snap !== state.snap) throw new CommandError('stale_snapshot');
  }

  async function uniqueLocator(ref) {
    const loc = page.locator(`aria-ref=${ref}`);
    if ((await loc.count()) !== 1) throw new CommandError('ref_not_found');
    return loc;
  }

  /** The link behind a ref of the last snapshot. A ref that matches nothing is ref_not_found, one that is not a link is not_a_link. */
  async function linkOf(ref) {
    await uniqueLocator(ref);
    const link = known.get(ref);
    if (!link) throw new CommandError('not_a_link');
    return link;
  }

  const handlers = {
    async snapshot() {
      return { snap: await refresh() };
    },
    async scroll(c) {
      await page.mouse.wheel(0, c.dy);
      await page.waitForTimeout(200);
      return {};
    },
    async wait(c) {
      await page.waitForTimeout(c.ms);
      return {};
    },
    async screenshot(c) {
      const a = await saveScreenshot(page, emitter, artifactDir, state, { full: c.full === true });
      if (!a.saved) throw new CommandError(a.error ?? 'artifact_failed');
      return {};
    },
    async open_link(c) {
      needFresh(c);
      const link = await linkOf(c.ref);
      let target;
      try {
        target = new URL(link.href, pageUrl());
      } catch {
        throw new CommandError('bad_target');
      }
      if (!isWeb(target.href)) throw new CommandError('bad_target');
      const loc = await uniqueLocator(c.ref);
      await loc.click({ timeout: OP_TIMEOUT_MS });
      await settle();
      return { snap: await refresh() };
    },
    async back() {
      const h = await scan.cdp.send('Page.getNavigationHistory');
      const prev = h.entries[h.currentIndex - 1];
      if (!prev || !/^https?:/i.test(prev.url)) throw new CommandError('no_history'); // the entry before the first page is about:blank
      await page.goBack({ timeout: OP_TIMEOUT_MS, waitUntil: 'load' });
      await settle();
      return { snap: await refresh() };
    },
    async download(c) {
      needFresh(c);
      const link = await linkOf(c.ref);
      let target;
      try {
        target = new URL(link.href, pageUrl());
      } catch {
        throw new CommandError('bad_target');
      }
      if (!isWeb(target.href)) throw new CommandError('bad_target');
      await uniqueLocator(c.ref);
      const res = await context.request.get(target.href, { timeout: OP_TIMEOUT_MS * 2, maxRedirects: 5 });
      const declared = Number(res.headers()['content-length'] ?? 0);
      if (declared > DOWNLOAD_MAX_BYTES) throw new CommandError('too_large');
      const body = await res.body();
      if (body.length > DOWNLOAD_MAX_BYTES) throw new CommandError('too_large');
      const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers()['content-disposition'] ?? '');
      const name = cut(decodeName(disposition?.[1]) || target.pathname.split('/').pop() || 'download', 255);
      const mime = cut((res.headers()['content-type'] ?? 'application/octet-stream').split(';')[0], 100);
      // The bytes never leave the guest (no artifact): only what the analysis found does.
      emit('download', { url: cut(target.href, LIMITS.urlChars), filename: name, mime, saved: true, status: res.status() });
      emit('file', analyzeFile({ name, mime, data: body }));
      return {};
    },
    async submit_form(c) {
      needFresh(c);
      const formLoc = await uniqueLocator(c.form);
      const refs = Object.keys(c.values);
      // The form is whatever <form> encloses the referenced element; every field must be inside that same form.
      const formHandle = await formLoc.evaluateHandle((el) => el.closest('form'));
      if (!formHandle.asElement()) throw new CommandError('form_not_found');
      for (const r of refs) {
        const field = await uniqueLocator(r);
        const inside = await field.evaluate((el, f) => f.contains(el), formHandle);
        if (!inside) throw new CommandError('field_not_in_form');
      }
      for (const r of refs) {
        const field = await uniqueLocator(r);
        const tag = await field.evaluate((el) => el.tagName.toLowerCase());
        if (tag === 'select') await field.selectOption(c.values[r], { timeout: OP_TIMEOUT_MS });
        else await field.fill(c.values[r], { timeout: OP_TIMEOUT_MS });
      }
      const form = formHandle.asElement();
      const submit = await form.$('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]');
      if (submit) await submit.click({ timeout: OP_TIMEOUT_MS });
      else if (refs.length > 0) await (await uniqueLocator(refs[refs.length - 1])).press('Enter', { timeout: OP_TIMEOUT_MS });
      else throw new CommandError('no_submit');
      await settle();
      return { snap: await refresh() };
    },
  };

  let ended = null;
  while (!ended) {
    const next = await Promise.race([lines.next(), expired.then((r) => ({ expired: r }))]);
    if (next.expired) {
      ended = next.expired;
      break;
    }
    if (next.done) {
      ended = 'eof';
      break;
    }
    const v = validateCommand(next.value);
    if (!v.ok) {
      if (v.id) emit('cmd_result', { id: v.id, ok: false, error: v.error });
      else emit('error', { code: v.error, message: 'rejected a malformed command line' });
      continue;
    }
    const c = v.command;
    if (c.cmd === 'close') {
      emit('cmd_result', { id: c.id, ok: true });
      ended = 'close';
      break;
    }
    try {
      const extra = await Promise.race([
        handlers[c.cmd](c),
        expiredError,
      ]);
      emit('cmd_result', { id: c.id, ok: true, ...extra });
    } catch (err) {
      if (process.env.ZS_DEBUG) console.error(`command ${c.cmd} failed:`, err);
      emit('cmd_result', { id: c.id, ok: false, error: errorToken(err) });
      if (err instanceof CommandError && err.code === 'session_expired') ended = 'max_time';
    }
  }
  clearTimeout(timer);
  return ended;
}

function decodeName(raw) {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw).replace(/[/\\\u0000-\u001f]/g, '_');
  } catch {
    return raw.replace(/[/\\\u0000-\u001f]/g, '_');
  }
}

/** A short lowercase token: the supervisor passes the code on only in this form. */
function errorToken(err) {
  if (err instanceof CommandError) return err.code;
  if (err?.name === 'TimeoutError') return 'timeout';
  const code = navErrorCode(err);
  return code === 'navigation_failed' ? 'command_failed' : code.toLowerCase();
}
